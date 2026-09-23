import { aborted, required, validateOptions } from "../speech/common";
import type {
  SpeechSynthesis,
  SpeechSynthesisOptions,
  SpeechSynthesisProvider
} from "./types";

export abstract class AbstractSpeechSynthesis implements SpeechSynthesis {
  abstract readonly provider: SpeechSynthesisProvider;
  private active?: AbortController;
  private closed = false;

  constructor(protected readonly options: SpeechSynthesisOptions) {
    validateOptions(options);
    required(options.voice, "voice");

    if (
      options.settings?.speed !== undefined &&
      (!Number.isFinite(options.settings.speed) || options.settings.speed <= 0)
    ) {
      throw new Error("Voice speed must be positive");
    }
  }

  protected abstract generate(
    text: string,
    signal: AbortSignal
  ): AsyncIterable<Buffer>;

  async *synthesize(
    text: string,
    options: { signal?: AbortSignal } = {}
  ): AsyncGenerator<Buffer> {
    if (this.closed) {
      throw new Error("Speech synthesis is closed");
    }

    if (this.active) {
      throw new Error("Consume speech synthesis segments sequentially");
    }

    if (options.signal?.aborted) {
      throw aborted();
    }

    if (!text.trim()) {
      return;
    }

    const controller = (this.active = new AbortController());
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.options.timeoutMs ?? 60000);
    let pending: Buffer = Buffer.alloc(0);

    try {
      for await (const chunk of this.generate(text, controller.signal)) {
        if (controller.signal.aborted) {
          throw aborted();
        }

        if (!chunk.length) {
          continue;
        }

        pending = Buffer.concat([pending, chunk]);

        while (pending.length >= 320) {
          if (controller.signal.aborted) {
            throw aborted();
          }

          const frame = pending.subarray(0, 320);
          pending = pending.subarray(320);
          yield frame;
        }
      }

      if (controller.signal.aborted) {
        throw aborted();
      }

      if (pending.length % 2) {
        throw new Error("Provider returned truncated PCM16 sample");
      }

      if (pending.length) {
        yield pending;
      }
    } finally {
      controller.abort();
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      this.active = undefined;
    }
  }

  cancel(): void {
    this.active?.abort();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancel();
  }
}
