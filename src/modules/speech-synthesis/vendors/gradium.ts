import { AbstractSpeechSynthesis } from "../base";
import { generateWebSocketSpeech } from "../websocket-driver";
import { SpeechSynthesisProvider } from "../types";
import type { SpeechSynthesisOptions } from "../types";

/** Gradium Speech Synthesis provider implementation. */
export class GradiumSpeechSynthesis extends AbstractSpeechSynthesis {
  readonly provider = SpeechSynthesisProvider.Gradium;

  constructor(options: SpeechSynthesisOptions) {
    super(options);
  }

  protected generate(text: string, signal: AbortSignal): AsyncIterable<Buffer> {
    return generateWebSocketSpeech(
      SpeechSynthesisProvider.Gradium,
      text,
      signal,
      this.options
    );
  }
}
