import { AbstractSpeechRecognition } from "../base";
import { createWebSocketRecognitionDriver } from "../websocket-driver";
import { SpeechRecognitionProvider } from "../types";
import type { RecognitionDriver, SpeechRecognitionOptions } from "../types";

/** Soniox Speech-to-Text provider implementation. */
export class SonioxSpeechRecognition extends AbstractSpeechRecognition {
  readonly provider = SpeechRecognitionProvider.Soniox;

  constructor(options: SpeechRecognitionOptions) {
    super(options);
  }

  protected createDriver(): RecognitionDriver {
    return createWebSocketRecognitionDriver(
      SpeechRecognitionProvider.Soniox,
      this.options
    );
  }
}
