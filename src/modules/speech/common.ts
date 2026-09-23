/** Raw signed PCM16 little-endian; transport framing belongs to audio-transport. */
export const SPEECH_AUDIO_FORMAT = {
  encoding: "pcm_s16le",
  sampleRateHz: 8000,
  channels: 1
} as const;

export interface SpeechOptions {
  callId: string;
  apiKey?: string;
  endpoint?: string;
  languageCode?: string;
  modelId?: string;
  region?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export function required(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new Error(`${name} is required`);
  }

  return value;
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function aborted(): Error {
  return new Error("Speech operation aborted");
}

export function validateOptions(options: SpeechOptions): void {
  required(options.callId, "callId");

  for (const [name, value] of Object.entries({
    timeoutMs: options.timeoutMs,
    maxBufferBytes: options.maxBufferBytes
  })) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
}

/** A bounded single-consumer queue for providers that expose callback-based output. */
export class SpeechQueue<T> implements AsyncIterable<T> {
  private items: { value: T; size: number }[] = [];
  private bytes = 0;
  private ended = false;
  private error?: Error;
  private wake?: () => void;

  constructor(private readonly limit = 1024 * 1024) {}

  push(value: T, size: number): void {
    if (this.ended) {
      return;
    }

    if (this.bytes + size > this.limit) {
      const error = new Error("Speech output buffer limit exceeded");
      this.end(error);
      throw error;
    }

    this.items.push({
      value,
      size
    });
    this.bytes += size;
    this.wake?.();
  }

  end(error?: Error, discard = true): void {
    if (this.ended) {
      return;
    }

    this.ended = true;
    this.error = error;

    if (error && discard) {
      this.items = [];
      this.bytes = 0;
    }

    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      const item = this.items.shift();

      if (item) {
        this.bytes -= item.size;
        yield item.value;
        continue;
      }

      if (this.error) {
        throw this.error;
      }

      if (this.ended) {
        return;
      }

      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}
