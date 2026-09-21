import { PassThrough, Writable } from "stream";
import { AsyncNotificationQueue } from "./asyncNotificationQueue";
import type {
  AudioCallContext,
  AudioFormat,
  AudioStreamStats,
  AudioTransportProtocol,
  ControlPayload,
  TransportCommand,
  TransportCommandResult,
  TransportNotification
} from "../types";

export interface AudioCallContextSink {
  writeAudio(frame: Buffer): Promise<void>;
  sendCommand(command: TransportCommand): Promise<TransportCommandResult>;
  supportsCommand(type: string): boolean;
  close(reason?: string): Promise<void>;
}

export interface BaseAudioCallContextOptions {
  id: string;
  protocol: AudioTransportProtocol;
  remoteAddress?: string;
  connectedAt?: Date;
  format: AudioFormat;
  metadata?: Record<string, unknown>;
  sink: AudioCallContextSink;
}

export class BaseAudioCallContext implements AudioCallContext {
  id: string;
  readonly protocol: AudioTransportProtocol;
  readonly remoteAddress?: string;
  readonly connectedAt: Date;
  readonly metadata: Record<string, unknown>;
  readonly stats: AudioStreamStats = {
    framesReceived: 0,
    bytesReceived: 0,
    framesSent: 0,
    bytesSent: 0
  };
  readonly incomingAudio = new PassThrough();
  readonly outgoingAudio: Writable;
  readonly notifications: AsyncIterable<TransportNotification>;
  format: AudioFormat;

  private readonly notificationQueue = new AsyncNotificationQueue();
  private finished = false;
  private closeRequested = false;

  constructor(private readonly options: BaseAudioCallContextOptions) {
    this.id = options.id;
    this.protocol = options.protocol;
    this.remoteAddress = options.remoteAddress;
    this.connectedAt = options.connectedAt ?? new Date();
    this.format = options.format;
    this.metadata = options.metadata ?? {};
    this.notifications = this.notificationQueue;
    this.outgoingAudio = new Writable({
      write: (chunk, encoding, callback) => {
        const frame = toBuffer(chunk, encoding);
        this.options.sink
          .writeAudio(frame)
          .then(() => {
            this.stats.framesSent += 1;
            this.stats.bytesSent += frame.byteLength;
            callback();
          })
          .catch((error: Error) => callback(error));
      }
    });
  }

  setId(id: string): void {
    this.id = id;
  }

  receiveAudio(frame: Buffer): boolean {
    if (this.finished) {
      return false;
    }

    this.stats.framesReceived += 1;
    this.stats.bytesReceived += frame.byteLength;
    return this.incomingAudio.write(frame);
  }

  pushNotification(notification: {
    type: string;
    name?: string;
    payload?: ControlPayload;
    raw?: unknown;
    receivedAt?: Date;
  }): void {
    this.notificationQueue.push({
      callId: this.id,
      protocol: this.protocol,
      receivedAt: notification.receivedAt ?? new Date(),
      type: notification.type,
      name: notification.name,
      payload: notification.payload,
      raw: notification.raw
    });
  }

  supportsCommand(type: string): boolean {
    return this.options.sink.supportsCommand(type);
  }

  async sendCommand(command: TransportCommand): Promise<TransportCommandResult> {
    return this.options.sink.sendCommand(command);
  }

  async close(reason?: string): Promise<void> {
    if (this.closeRequested) {
      return;
    }

    this.closeRequested = true;
    await this.options.sink.close(reason);
  }

  finish(reason?: string): void {
    if (this.finished) {
      return;
    }

    this.finished = true;
    this.incomingAudio.end();
    this.outgoingAudio.end();
    this.pushNotification({
      type: "call_ended",
      name: "CALL_ENDED",
      payload: reason ? { reason } : undefined
    });
    this.notificationQueue.close();
  }

  fail(error: Error): void {
    this.notificationQueue.fail(error);
    this.incomingAudio.destroy(error);
    this.outgoingAudio.destroy(error);
  }
}

function toBuffer(chunk: unknown, encoding: BufferEncoding | string): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }

  if (typeof chunk === "string") {
    return Buffer.from(chunk, encoding as BufferEncoding);
  }

  return Buffer.from(chunk as ArrayBufferLike);
}
