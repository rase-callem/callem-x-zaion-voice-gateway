import { AbstractSpeechRecognition } from "../base";
import { createWebSocketRecognitionDriver } from "../websocket-driver";
import { SpeechRecognitionProvider } from "../types";
import type { RecognitionDriver, SpeechRecognitionOptions } from "../types";

/** Gladia Speech-to-Text provider implementation. */
export class GladiaSpeechRecognition extends AbstractSpeechRecognition {
  readonly provider = SpeechRecognitionProvider.Gladia;

  constructor(options: SpeechRecognitionOptions) {
    super(options);
  }

  protected createDriver(): RecognitionDriver {
    return createWebSocketRecognitionDriver(
      SpeechRecognitionProvider.Gladia,
      this.options
    );
  }
}
