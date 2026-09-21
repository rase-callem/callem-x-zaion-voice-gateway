import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import { IncomingMessage } from "http";
import WebSocket, { RawData, WebSocketServer } from "ws";

export type ControlPayload = Record<string, string | number | boolean | null | undefined>;

export interface GatewayOptions {
  host?: string;
  port: number;
  path?: string;
  echoMedia?: boolean;
  logger?: Pick<Console, "info" | "warn" | "error" | "debug">;
}

export interface CallSession {
  id: string;
  path: string;
  remoteAddress?: string;
  connectedAt: Date;
  mediaStarted: boolean;
  optimalFrameSize?: number;
  framesReceived: number;
  bytesReceived: number;
  lastControl?: ParsedControlMessage;
  attributes: Record<string, unknown>;
}

export interface ParsedControlMessage {
  type: string;
  payload: ControlPayload;
  raw: string;
}

type GatewayEvents = {
  callStarted: (session: CallSession) => void;
  callEnded: (session: CallSession) => void;
  media: (session: CallSession, frame: Buffer) => void;
  control: (session: CallSession, message: ParsedControlMessage) => void;
};

export declare interface AsteriskWebSocketGateway {
  on<EventName extends keyof GatewayEvents>(event: EventName, listener: GatewayEvents[EventName]): this;
  emit<EventName extends keyof GatewayEvents>(
    event: EventName,
    ...args: Parameters<GatewayEvents[EventName]>
  ): boolean;
}

export class AsteriskWebSocketGateway extends EventEmitter {
  private readonly sessionsBySocket = new WeakMap<WebSocket, CallSession>();
  private readonly socketsByCallId = new Map<string, WebSocket>();
  private server?: WebSocketServer;

  constructor(private readonly options: GatewayOptions) {
    super();
  }

  get activeCalls(): CallSession[] {
    return [...this.socketsByCallId.values()]
      .map((socket) => this.sessionsBySocket.get(socket))
      .filter((session): session is CallSession => Boolean(session));
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
    this.server.on("error", (error) => this.options.logger?.error("websocket server error", error));

    await new Promise<void>((resolve) => this.server?.once("listening", resolve));
    const address = this.server.address();
    this.options.logger?.info(`Asterisk WebSocket gateway listening on ${formatAddress(address)}`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }

    for (const socket of this.socketsByCallId.values()) {
      socket.close(1001, "server shutdown");
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });

    this.server = undefined;
    this.socketsByCallId.clear();
  }

  sendMedia(callId: string, frame: Buffer): boolean {
    const socket = this.socketsByCallId.get(callId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    socket.send(frame, { binary: true });
    return true;
  }

  sendCommand(callId: string, command: string, payload: ControlPayload = {}): boolean {
    const socket = this.socketsByCallId.get(callId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    socket.send(JSON.stringify({ type: command, ...payload }));
    return true;
  }

  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const session = this.createSession(socket, request);

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.handleMedia(socket, data);
        return;
      }

      this.handleControl(socket, data.toString());
    });

    socket.on("close", () => this.removeSession(socket));
    socket.on("error", (error) => this.options.logger?.warn(`call ${session.id} websocket error`, error));
  }

  private createSession(socket: WebSocket, request: IncomingMessage): CallSession {
    const id = findQueryParam(request.url, "connection_id") ?? randomUUID();
    const session: CallSession = {
      id,
      path: request.url ?? "/",
      remoteAddress: request.socket.remoteAddress,
      connectedAt: new Date(),
      mediaStarted: false,
      framesReceived: 0,
      bytesReceived: 0,
      attributes: {}
    };

    this.sessionsBySocket.set(socket, session);
    this.socketsByCallId.set(session.id, socket);
    this.emit("callStarted", session);
    this.options.logger?.info(`call ${session.id} connected`);

    return session;
  }

  private handleControl(socket: WebSocket, raw: string): void {
    const session = this.sessionsBySocket.get(socket);
    if (!session) {
      return;
    }

    const message = parseControlMessage(raw);
    session.lastControl = message;

    if (message.payload.connection_id && typeof message.payload.connection_id === "string") {
      this.rekeySession(session, message.payload.connection_id, socket);
    }

    if (message.type === "MEDIA_START") {
      session.mediaStarted = true;
      session.optimalFrameSize = toNumber(message.payload.optimal_frame_size);
    }

    if (message.type === "MEDIA_STOP" || message.type === "HANGUP") {
      session.mediaStarted = false;
    }

    this.emit("control", session, message);
  }

  private handleMedia(socket: WebSocket, data: RawData): void {
    const session = this.sessionsBySocket.get(socket);
    if (!session) {
      return;
    }

    const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    session.framesReceived += 1;
    session.bytesReceived += frame.byteLength;

    this.emit("media", session, frame);

    if (this.options.echoMedia && socket.readyState === WebSocket.OPEN) {
      socket.send(frame, { binary: true });
    }
  }

  private rekeySession(session: CallSession, connectionId: string, socket: WebSocket): void {
    if (session.id === connectionId) {
      return;
    }

    this.socketsByCallId.delete(session.id);
    session.id = connectionId;
    this.socketsByCallId.set(session.id, socket);
  }

  private removeSession(socket: WebSocket): void {
    const session = this.sessionsBySocket.get(socket);
    if (!session) {
      return;
    }

    this.socketsByCallId.delete(session.id);
    this.emit("callEnded", session);
    this.options.logger?.info(`call ${session.id} disconnected`);
  }
}

export function parseControlMessage(raw: string): ParsedControlMessage {
  const trimmed = raw.trim();

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const type = String(parsed.type ?? parsed.event ?? parsed.command ?? "CONTROL").toUpperCase();
    return { type, payload: normalizePayload(parsed), raw };
  } catch {
    const [firstToken = "CONTROL"] = trimmed.split(/\s+/, 1);
    return {
      type: firstToken.toUpperCase(),
      payload: parseKeyValuePayload(trimmed.slice(firstToken.length)),
      raw
    };
  }
}

function parseKeyValuePayload(text: string): ControlPayload {
  const payload: ControlPayload = {};
  const pairs = text.matchAll(/([A-Za-z0-9_:-]+)\s*[:=]\s*("[^"]*"|'[^']*'|[^,\s]+)/g);

  for (const pair of pairs) {
    payload[pair[1].replace(/-/g, "_")] = pair[2].replace(/^["']|["']$/g, "");
  }

  return payload;
}

function normalizePayload(input: Record<string, unknown>): ControlPayload {
  return Object.entries(input).reduce<ControlPayload>((payload, [key, value]) => {
    if (["string", "number", "boolean"].includes(typeof value) || value == null) {
      payload[key] = value as string | number | boolean | null | undefined;
    }

    return payload;
  }, {});
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

function formatAddress(address: ReturnType<WebSocketServer["address"]>): string {
  if (typeof address === "string") {
    return address;
  }

  if (!address) {
    return "unknown address";
  }

  return `${address.address}:${address.port}`;
}
