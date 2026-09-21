import type { IncomingMessage } from "http";
import WebSocket, { type RawData, WebSocketServer } from "ws";
import { createCallId } from "../../common";
import type { Logger } from "../../common";
import { BaseAudioCallContext } from "./internal/baseAudioCallContext";
import type { CallHandler } from "../call-handler";
import type {
  AudioCallContext,
  AudioFormat,
  AudioTransportServer,
  ControlPayload,
  TransportCommand,
  TransportCommandResult
} from "./types";

export type ChanWebSocketControlMessageFormat = "plain-text" | "json";

export interface ChanWebSocketAudioTransportServerOptions {
  host?: string;
  port: number;
  path?: string;
  controlMessageFormat?: ChanWebSocketControlMessageFormat;
  logger?: Logger;
  callHandler: CallHandler;
}

export interface ParsedControlMessage {
  type: string;
  payload: ControlPayload;
  raw: string;
  format: ChanWebSocketControlMessageFormat;
}

const SUPPORTED_COMMANDS: Record<string, string> = {
  answer: "ANSWER",
  hangup: "HANGUP",
  start_media_buffering: "START_MEDIA_BUFFERING",
  stop_media_buffering: "STOP_MEDIA_BUFFERING",
  flush_media: "FLUSH_MEDIA",
  pause_media: "PAUSE_MEDIA",
  continue_media: "CONTINUE_MEDIA",
  mark_media: "MARK_MEDIA",
  get_status: "GET_STATUS",
  report_queue_drained: "REPORT_QUEUE_DRAINED",
  set_media_direction: "SET_MEDIA_DIRECTION"
};

export class ChanWebSocketAudioTransportServer implements AudioTransportServer {
  readonly protocol = "chan_websocket" as const;

  private readonly sessionsBySocket = new WeakMap<WebSocket, BaseAudioCallContext>();
  private readonly socketsByCallId = new Map<string, WebSocket>();
  private server?: WebSocketServer;

  constructor(private readonly options: ChanWebSocketAudioTransportServerOptions) {}

  get activeCalls(): AudioCallContext[] {
    return [...this.socketsByCallId.values()]
      .map((socket) => this.sessionsBySocket.get(socket))
      .filter((session): session is BaseAudioCallContext => Boolean(session));
  }

  get port(): number | undefined {
    const address = this.server?.address();
    return typeof address === "object" && address ? address.port : undefined;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = new WebSocketServer({
      host: this.options.host,
      port: this.options.port,
      path: this.options.path
    });

    this.server.on("connection", (socket, request) => this.handleConnection(socket, request));
    this.server.on("error", (error) => this.options.logger?.error?.("chan_websocket server error", error));

    await new Promise<void>((resolve) => this.server?.once("listening", resolve));
    this.options.logger?.info?.(`chan_websocket listening on ${formatAddress(this.server.address())}`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }

    for (const socket of new Set(this.socketsByCallId.values())) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1001, "server shutdown");
      }
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });

    this.server = undefined;
    this.socketsByCallId.clear();
  }

  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const context = this.createContext(socket, request);

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        context.receiveAudio(rawDataToBuffer(data));
        return;
      }

      this.handleControl(socket, rawDataToBuffer(data).toString("utf8"));
    });

    socket.on("close", () => this.removeSession(socket, "websocket closed"));
    socket.on("error", (error) => {
      context.pushNotification({
        type: "error",
        name: "WEBSOCKET_ERROR",
        payload: { message: error.message }
      });
      this.options.logger?.warn?.(`call ${context.id} chan_websocket error`, error);
    });

    this.startHandler(context);
  }

  private createContext(socket: WebSocket, request: IncomingMessage): BaseAudioCallContext {
    const id = findQueryParam(request.url, "connection_id") ?? createCallId();
    const context = new BaseAudioCallContext({
      id,
      protocol: this.protocol,
      remoteAddress: request.socket.remoteAddress,
      format: {
        encoding: "unknown",
        channels: 1
      },
      metadata: {
        path: request.url ?? "/"
      },
      sink: {
        writeAudio: (frame) => sendWebSocketFrame(socket, frame, true),
        close: async (reason?: string) => {
          if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
            socket.close(1000, reason);
          }
        },
        sendCommand: (command) => this.sendCommand(socket, command),
        supportsCommand: (type) => isChanWebSocketCommandSupported(type)
      }
    });

    this.sessionsBySocket.set(socket, context);
    this.socketsByCallId.set(context.id, socket);
    context.pushNotification({
      type: "call_started",
      name: "CALL_STARTED",
      payload: {
        path: request.url ?? "/"
      }
    });
    this.options.logger?.info?.(`call ${context.id} connected over chan_websocket`);
    return context;
  }

  private startHandler(context: BaseAudioCallContext): void {
    void this.options.callHandler.handle(context).catch((error: Error) => {
      context.pushNotification({
        type: "error",
        name: "CALL_HANDLER_ERROR",
        payload: { message: error.message }
      });
      this.options.logger?.error?.(`call ${context.id} handler failed`, error);
      void context.close("handler error");
    });
  }

  private handleControl(socket: WebSocket, raw: string): void {
    const context = this.sessionsBySocket.get(socket);
    if (!context) {
      return;
    }

    const message = parseControlMessage(raw);

    if (typeof message.payload.connection_id === "string") {
      this.rekeySession(context, message.payload.connection_id, socket);
    }

    this.applyControlMessage(context, message);
  }

  private applyControlMessage(context: BaseAudioCallContext, message: ParsedControlMessage): void {
    const type = message.type;

    if (type === "MEDIA_START") {
      context.metadata.mediaStarted = true;
      context.format = chanAudioFormatFromPayload(message.payload, context.format);
      context.pushNotification({
        type: "media_started",
        name: type,
        payload: message.payload,
        raw: message.raw
      });
      return;
    }

    if (type === "MEDIA_STOP") {
      context.metadata.mediaStarted = false;
      context.pushNotification({
        type: "media_stopped",
        name: type,
        payload: message.payload,
        raw: message.raw
      });
      return;
    }

    if (type === "HANGUP") {
      context.metadata.mediaStarted = false;
      context.pushNotification({
        type: "hangup",
        name: type,
        payload: message.payload,
        raw: message.raw
      });
      return;
    }

    if (type === "DTMF_END") {
      context.pushNotification({
        type: "dtmf",
        name: type,
        payload: message.payload,
        raw: message.raw
      });
      return;
    }

    if (type === "MEDIA_XOFF" || type === "MEDIA_XON") {
      context.pushNotification({
        type: "flow_control",
        name: type,
        payload: {
          ...message.payload,
          state: type === "MEDIA_XOFF" ? "xoff" : "xon"
        },
        raw: message.raw
      });
      return;
    }

    if (type === "STATUS") {
      context.pushNotification({
        type: "status",
        name: type,
        payload: message.payload,
        raw: message.raw
      });
      return;
    }

    if (type === "MEDIA_BUFFERING_COMPLETED") {
      context.pushNotification({
        type: "media_buffering_completed",
        name: type,
        payload: message.payload,
        raw: message.raw
      });
      return;
    }

    if (type === "MEDIA_MARK_PROCESSED") {
      context.pushNotification({
        type: "media_mark_processed",
        name: type,
        payload: message.payload,
        raw: message.raw
      });
      return;
    }

    if (type === "QUEUE_DRAINED") {
      context.pushNotification({
        type: "queue_drained",
        name: type,
        payload: message.payload,
        raw: message.raw
      });
      return;
    }

    context.pushNotification({
      type: "control",
      name: type,
      payload: message.payload,
      raw: message.raw
    });
  }

  private async sendCommand(socket: WebSocket, command: TransportCommand): Promise<TransportCommandResult> {
    const serialized = serializeChanWebSocketCommand(command, this.options.controlMessageFormat ?? "plain-text");
    if (!serialized) {
      return {
        ok: false,
        unsupported: true,
        protocol: this.protocol,
        commandType: command.type
      };
    }

    try {
      await sendWebSocketFrame(socket, serialized, false);
      return {
        ok: true,
        protocol: this.protocol,
        commandType: command.type
      };
    } catch (error) {
      return {
        ok: false,
        protocol: this.protocol,
        commandType: command.type,
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
  }

  private rekeySession(context: BaseAudioCallContext, connectionId: string, socket: WebSocket): void {
    if (context.id === connectionId) {
      return;
    }

    this.socketsByCallId.delete(context.id);
    context.setId(connectionId);
    this.socketsByCallId.set(context.id, socket);
  }

  private removeSession(socket: WebSocket, reason: string): void {
    const context = this.sessionsBySocket.get(socket);
    if (!context) {
      return;
    }

    this.socketsByCallId.delete(context.id);
    context.finish(reason);
    this.options.logger?.info?.(`call ${context.id} disconnected from chan_websocket`);
  }
}

export function parseControlMessage(raw: string): ParsedControlMessage {
  const trimmed = raw.trim();

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const type = String(parsed.type ?? parsed.event ?? parsed.command ?? "CONTROL").toUpperCase();
    return { type, payload: normalizePayload(parsed), raw, format: "json" };
  } catch {
    const [firstToken = "CONTROL"] = trimmed.split(/\s+/, 1);
    const rest = trimmed.slice(firstToken.length).trim();
    return {
      type: firstToken.toUpperCase(),
      payload: parseKeyValuePayload(rest),
      raw,
      format: "plain-text"
    };
  }
}

export function isChanWebSocketCommandSupported(type: string): boolean {
  return Boolean(wireCommandFor(type));
}

export function serializeChanWebSocketCommand(
  command: TransportCommand,
  format: ChanWebSocketControlMessageFormat = "plain-text"
): string | undefined {
  const wireCommand = wireCommandFor(command.type);
  if (!wireCommand) {
    return undefined;
  }

  const payload: ControlPayload = { ...(command.payload ?? {}) };
  if (command.correlationId) {
    payload.correlation_id = command.correlationId;
  }

  if (command.direction) {
    payload.direction = command.direction;
  }

  if (format === "json") {
    return JSON.stringify({ type: wireCommand, ...payload });
  }

  const serializedPayload = Object.entries(payload)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}:${String(value)}`);

  return [wireCommand, ...serializedPayload].join(" ");
}

function sendWebSocketFrame(socket: WebSocket, data: Buffer | string, binary: boolean): Promise<void> {
  if (socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("websocket is not open"));
  }

  return new Promise<void>((resolve, reject) => {
    socket.send(data, { binary }, (error) => (error ? reject(error) : resolve()));
  });
}

function parseKeyValuePayload(text: string): ControlPayload {
  const payload: ControlPayload = {};
  const pairs = text.matchAll(/([A-Za-z0-9_:-]+)\s*[:=]\s*("[^"]*"|'[^']*'|[^,\s]+)/g);

  for (const pair of pairs) {
    payload[pair[1].replace(/-/g, "_")] = pair[2].replace(/^["']|["']$/g, "");
  }

  if (Object.keys(payload).length === 0 && text.length > 0) {
    payload.correlation_id = text;
  }

  return payload;
}

function normalizePayload(input: Record<string, unknown>): ControlPayload {
  return Object.entries(input).reduce<ControlPayload>((payload, [key, value]) => {
    payload[key] = value;
    return payload;
  }, {});
}

function wireCommandFor(type: string): string | undefined {
  const normalized = type.trim().toLowerCase().replace(/-/g, "_");
  return SUPPORTED_COMMANDS[normalized] ?? (Object.values(SUPPORTED_COMMANDS).includes(type) ? type : undefined);
}

function chanAudioFormatFromPayload(payload: ControlPayload, current: AudioFormat): AudioFormat {
  const rawFormat = typeof payload.format === "string" ? payload.format : current.raw;
  const optimalFrameSize = toNumber(payload.optimal_frame_size) ?? current.frameSizeBytes;
  const ptimeMs = toNumber(payload.ptime) ?? current.ptimeMs;

  return {
    ...current,
    encoding: rawFormat ?? current.encoding,
    raw: rawFormat,
    sampleRateHz: sampleRateFromAsteriskFormat(rawFormat) ?? current.sampleRateHz,
    frameSizeBytes: optimalFrameSize,
    ptimeMs
  };
}

function sampleRateFromAsteriskFormat(format: string | undefined): number | undefined {
  if (!format) {
    return undefined;
  }

  if (format === "ulaw" || format === "alaw" || format === "slin") {
    return 8000;
  }

  const signedLinearMatch = /^slin(\d+)$/.exec(format);
  if (signedLinearMatch) {
    return Number(signedLinearMatch[1]) * 1000;
  }

  return undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function findQueryParam(url: string | undefined, key: string): string | undefined {
  if (!url) {
    return undefined;
  }

  const parsed = new URL(url, "ws://localhost");
  return parsed.searchParams.get(key) ?? undefined;
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }

  return Buffer.from(data as ArrayBuffer);
}

function formatAddress(address: ReturnType<WebSocketServer["address"]>): string {
  if (typeof address === "string") {
    return address;
  }

  if (!address) {
    return "unknown address";
  }

  return `${address.address}:${address.port}`;
}
