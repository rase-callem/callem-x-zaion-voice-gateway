import { createServer } from "net";
import type { AddressInfo, Server, Socket } from "net";
import { createCallId } from "../../common";
import type { Logger } from "../../common";
import { BaseAudioCallContext } from "./internal/baseAudioCallContext";
import type { CallHandler } from "../call-handler";
import type {
  AudioCallContext,
  AudioFormat,
  AudioTransportServer,
  TransportCommand,
  TransportCommandResult
} from "./types";

export interface AudioSocketTransportServerOptions {
  host?: string;
  port: number;
  logger?: Logger;
  callHandler: CallHandler;
}

export interface AudioSocketPacket {
  type: number;
  payload: Buffer;
}

export const AUDIO_SOCKET_PACKET_TYPES = {
  TERMINATE: 0x00,
  UUID: 0x01,
  DTMF: 0x03,
  SLIN_8KHZ: 0x10,
  SLIN_12KHZ: 0x11,
  SLIN_16KHZ: 0x12,
  SLIN_24KHZ: 0x13,
  SLIN_32KHZ: 0x14,
  SLIN_44_1KHZ: 0x15,
  SLIN_48KHZ: 0x16,
  SLIN_96KHZ: 0x17,
  SLIN_192KHZ: 0x18,
  ERROR: 0xff
} as const;

const SAMPLE_RATE_TO_AUDIO_TYPE = new Map<number, number>([
  [8000, AUDIO_SOCKET_PACKET_TYPES.SLIN_8KHZ],
  [12000, AUDIO_SOCKET_PACKET_TYPES.SLIN_12KHZ],
  [16000, AUDIO_SOCKET_PACKET_TYPES.SLIN_16KHZ],
  [24000, AUDIO_SOCKET_PACKET_TYPES.SLIN_24KHZ],
  [32000, AUDIO_SOCKET_PACKET_TYPES.SLIN_32KHZ],
  [44100, AUDIO_SOCKET_PACKET_TYPES.SLIN_44_1KHZ],
  [48000, AUDIO_SOCKET_PACKET_TYPES.SLIN_48KHZ],
  [96000, AUDIO_SOCKET_PACKET_TYPES.SLIN_96KHZ],
  [192000, AUDIO_SOCKET_PACKET_TYPES.SLIN_192KHZ]
]);

const AUDIO_TYPE_TO_SAMPLE_RATE = new Map<number, number>(
  [...SAMPLE_RATE_TO_AUDIO_TYPE.entries()].map(([sampleRate, packetType]) => [packetType, sampleRate])
);

export class AudioSocketTransportServer implements AudioTransportServer {
  readonly protocol = "audiosocket" as const;

  private readonly contextsBySocket = new Map<Socket, BaseAudioCallContext>();
  private readonly socketsByCallId = new Map<string, Socket>();
  private readonly buffersBySocket = new Map<Socket, Buffer>();
  private server?: Server;

  constructor(private readonly options: AudioSocketTransportServerOptions) {}

  get activeCalls(): AudioCallContext[] {
    return [...this.socketsByCallId.values()]
      .map((socket) => this.contextsBySocket.get(socket))
      .filter((context): context is BaseAudioCallContext => Boolean(context));
  }

  get port(): number | undefined {
    const address = this.server?.address();
    return typeof address === "object" && address ? address.port : undefined;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = createServer((socket) => this.handleConnection(socket));
    this.server.on("error", (error) => this.options.logger?.error?.("audiosocket server error", error));

    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) {
        reject(new Error("audiosocket server was not created"));
        return;
      }

      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: this.options.host, port: this.options.port });
    });

    this.options.logger?.info?.(`audiosocket listening on ${formatAddress(this.server.address())}`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }

    for (const socket of new Set(this.socketsByCallId.values())) {
      if (!socket.destroyed) {
        socket.end(encodeAudioSocketPacket(AUDIO_SOCKET_PACKET_TYPES.TERMINATE));
      }
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });

    this.server = undefined;
    this.socketsByCallId.clear();
    this.contextsBySocket.clear();
    this.buffersBySocket.clear();
  }

  private handleConnection(socket: Socket): void {
    const context = this.createContext(socket);

    socket.on("data", (chunk) => this.handleData(socket, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on("close", () => this.removeSession(socket, "socket closed"));
    socket.on("error", (error) => {
      context.pushNotification({
        type: "error",
        name: "AUDIOSOCKET_ERROR",
        payload: { message: error.message }
      });
      this.options.logger?.warn?.(`call ${context.id} audiosocket error`, error);
    });

    this.startHandler(context);
  }

  private createContext(socket: Socket): BaseAudioCallContext {
    let context: BaseAudioCallContext;

    context = new BaseAudioCallContext({
      id: createCallId(),
      protocol: this.protocol,
      remoteAddress: socket.remoteAddress,
      format: audioSocketFormatForPacketType(AUDIO_SOCKET_PACKET_TYPES.SLIN_8KHZ),
      sink: {
        writeAudio: (frame: Buffer): Promise<void> =>
          writeSocket(socket, encodeAudioSocketPacket(audioSocketPacketTypeForFormat(context.format), frame)),
        close: async () => {
          if (!socket.destroyed) {
            socket.end(encodeAudioSocketPacket(AUDIO_SOCKET_PACKET_TYPES.TERMINATE));
          }
        },
        sendCommand: (command) => this.sendCommand(socket, command),
        supportsCommand: (type) => isAudioSocketCommandSupported(type)
      }
    });

    this.contextsBySocket.set(socket, context);
    this.socketsByCallId.set(context.id, socket);
    this.buffersBySocket.set(socket, Buffer.alloc(0));
    context.pushNotification({
      type: "call_started",
      name: "CALL_STARTED"
    });
    this.options.logger?.info?.(`call ${context.id} connected over audiosocket`);
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

  private handleData(socket: Socket, chunk: Buffer): void {
    const buffered = Buffer.concat([this.buffersBySocket.get(socket) ?? Buffer.alloc(0), chunk]);
    const decoded = decodeAudioSocketPackets(buffered);
    this.buffersBySocket.set(socket, decoded.remaining);

    for (const packet of decoded.packets) {
      this.handlePacket(socket, packet);
    }
  }

  private handlePacket(socket: Socket, packet: AudioSocketPacket): void {
    const context = this.contextsBySocket.get(socket);
    if (!context) {
      return;
    }

    if (packet.type === AUDIO_SOCKET_PACKET_TYPES.TERMINATE) {
      context.pushNotification({
        type: "hangup",
        name: "HANGUP"
      });
      socket.end();
      return;
    }

    if (packet.type === AUDIO_SOCKET_PACKET_TYPES.UUID) {
      const uuid = uuidPayloadToString(packet.payload);
      this.rekeySession(context, uuid, socket);
      context.pushNotification({
        type: "control",
        name: "UUID",
        payload: { uuid }
      });
      return;
    }

    if (packet.type === AUDIO_SOCKET_PACKET_TYPES.DTMF) {
      context.pushNotification({
        type: "dtmf",
        name: "DTMF",
        payload: { digit: packet.payload.toString("ascii", 0, 1) }
      });
      return;
    }

    if (packet.type === AUDIO_SOCKET_PACKET_TYPES.ERROR) {
      context.pushNotification({
        type: "error",
        name: "ERROR",
        payload: {
          code: packet.payload.length > 0 ? packet.payload[0] : undefined,
          payload: packet.payload
        }
      });
      return;
    }

    if (isAudioSocketAudioPacketType(packet.type)) {
      context.format = audioSocketFormatForPacketType(packet.type);
      context.receiveAudio(packet.payload);
      return;
    }

    context.pushNotification({
      type: "error",
      name: "UNKNOWN_PACKET",
      payload: { packetType: packet.type }
    });
  }

  private async sendCommand(socket: Socket, command: TransportCommand): Promise<TransportCommandResult> {
    const normalized = normalizeCommandType(command.type);

    if (normalized === "hangup" || normalized === "terminate") {
      try {
        await writeSocket(socket, encodeAudioSocketPacket(AUDIO_SOCKET_PACKET_TYPES.TERMINATE));
        socket.end();
        return {
          ok: true,
          protocol: this.protocol,
          commandType: command.type
        };
      } catch (error) {
        return failedCommandResult(this.protocol, command.type, error);
      }
    }

    if (normalized === "dtmf" || normalized === "send_dtmf") {
      const digit = command.payload?.digit;
      if (typeof digit !== "string" || digit.length === 0) {
        return failedCommandResult(this.protocol, command.type, new Error("dtmf command requires payload.digit"));
      }

      try {
        await writeSocket(socket, encodeAudioSocketPacket(AUDIO_SOCKET_PACKET_TYPES.DTMF, Buffer.from(digit[0], "ascii")));
        return {
          ok: true,
          protocol: this.protocol,
          commandType: command.type
        };
      } catch (error) {
        return failedCommandResult(this.protocol, command.type, error);
      }
    }

    return {
      ok: false,
      unsupported: true,
      protocol: this.protocol,
      commandType: command.type
    };
  }

  private rekeySession(context: BaseAudioCallContext, id: string, socket: Socket): void {
    if (context.id === id) {
      return;
    }

    this.socketsByCallId.delete(context.id);
    context.setId(id);
    this.socketsByCallId.set(context.id, socket);
  }

  private removeSession(socket: Socket, reason: string): void {
    const context = this.contextsBySocket.get(socket);
    if (!context) {
      return;
    }

    this.socketsByCallId.delete(context.id);
    this.contextsBySocket.delete(socket);
    this.buffersBySocket.delete(socket);
    context.finish(reason);
    this.options.logger?.info?.(`call ${context.id} disconnected from audiosocket`);
  }
}

export function encodeAudioSocketPacket(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (payload.byteLength > 0xffff) {
    throw new Error("AudioSocket payload exceeds 16-bit length");
  }

  const header = Buffer.alloc(3);
  header[0] = type;
  header.writeUInt16BE(payload.byteLength, 1);
  return Buffer.concat([header, payload]);
}

export function decodeAudioSocketPackets(buffer: Buffer): { packets: AudioSocketPacket[]; remaining: Buffer } {
  const packets: AudioSocketPacket[] = [];
  let offset = 0;

  while (buffer.byteLength - offset >= 3) {
    const type = buffer[offset];
    const payloadLength = buffer.readUInt16BE(offset + 1);
    const packetLength = 3 + payloadLength;

    if (buffer.byteLength - offset < packetLength) {
      break;
    }

    packets.push({
      type,
      payload: buffer.subarray(offset + 3, offset + packetLength)
    });
    offset += packetLength;
  }

  return {
    packets,
    remaining: buffer.subarray(offset)
  };
}

export function audioSocketFormatForPacketType(type: number): AudioFormat {
  const sampleRateHz = AUDIO_TYPE_TO_SAMPLE_RATE.get(type) ?? 8000;
  return {
    encoding: "signed-linear-16",
    sampleRateHz,
    channels: 1,
    raw: sampleRateHz === 8000 ? "slin" : `slin${sampleRateHz / 1000}`
  };
}

export function audioSocketPacketTypeForFormat(format: AudioFormat): number {
  return SAMPLE_RATE_TO_AUDIO_TYPE.get(format.sampleRateHz ?? 8000) ?? AUDIO_SOCKET_PACKET_TYPES.SLIN_8KHZ;
}

export function uuidPayloadToString(payload: Buffer): string {
  if (payload.byteLength !== 16) {
    return payload.toString("utf8");
  }

  const hex = payload.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuidStringToAudioSocketPayload(uuid: string): Buffer {
  const normalized = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(normalized)) {
    throw new Error("AudioSocket UUID must be a 16-byte UUID string");
  }

  return Buffer.from(normalized, "hex");
}

export function isAudioSocketCommandSupported(type: string): boolean {
  const normalized = normalizeCommandType(type);
  return normalized === "hangup" || normalized === "terminate" || normalized === "dtmf" || normalized === "send_dtmf";
}

function isAudioSocketAudioPacketType(type: number): boolean {
  return AUDIO_TYPE_TO_SAMPLE_RATE.has(type);
}

function writeSocket(socket: Socket, frame: Buffer): Promise<void> {
  if (socket.destroyed) {
    return Promise.reject(new Error("socket is destroyed"));
  }

  return new Promise<void>((resolve, reject) => {
    socket.write(frame, (error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function failedCommandResult(protocol: "audiosocket", commandType: string, error: unknown): TransportCommandResult {
  return {
    ok: false,
    protocol,
    commandType,
    error: error instanceof Error ? error : new Error(String(error))
  };
}

function normalizeCommandType(type: string): string {
  return type.trim().toLowerCase().replace(/-/g, "_");
}

function formatAddress(address: string | AddressInfo | null): string {
  if (typeof address === "string") {
    return address;
  }

  if (!address) {
    return "unknown address";
  }

  return `${address.address}:${address.port}`;
}
