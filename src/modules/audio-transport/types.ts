import type { Readable, Writable } from "stream";

export type AudioTransportProtocol = "audiosocket" | "chan_websocket";

export type ControlPayload = Record<string, unknown>;

export interface AudioFormat {
  encoding: string;
  sampleRateHz?: number;
  channels?: number;
  frameSizeBytes?: number;
  ptimeMs?: number;
  raw?: string;
  passthrough?: boolean;
}

export interface AudioStreamStats {
  framesReceived: number;
  bytesReceived: number;
  framesSent: number;
  bytesSent: number;
}

export type MediaDirection = "in" | "out" | "both";

export interface TransportCommand {
  type: string;
  payload?: ControlPayload;
  correlationId?: string;
  direction?: MediaDirection;
}

export interface TransportCommandResult {
  ok: boolean;
  protocol: AudioTransportProtocol;
  commandType: string;
  unsupported?: boolean;
  error?: Error;
}

export interface TransportNotification {
  type: string;
  callId: string;
  protocol: AudioTransportProtocol;
  receivedAt: Date;
  name?: string;
  payload?: ControlPayload;
  raw?: unknown;
}

export interface AudioCallContext {
  id: string;
  readonly protocol: AudioTransportProtocol;
  readonly remoteAddress?: string;
  readonly connectedAt: Date;
  format: AudioFormat;
  readonly metadata: Record<string, unknown>;
  readonly stats: AudioStreamStats;
  readonly incomingAudio: Readable;
  readonly outgoingAudio: Writable;
  readonly notifications: AsyncIterable<TransportNotification>;
  supportsCommand(type: string): boolean;
  sendCommand(command: TransportCommand): Promise<TransportCommandResult>;
  close(reason?: string): Promise<void>;
}

export interface AudioTransportServer {
  readonly protocol: AudioTransportProtocol;
  readonly activeCalls: AudioCallContext[];
  readonly port: number | undefined;
  start(): Promise<void>;
  stop(): Promise<void>;
}
