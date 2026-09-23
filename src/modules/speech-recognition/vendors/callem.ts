import { AbstractSpeechRecognition } from "../base";
import { createWebSocketRecognitionDriver } from "../websocket-driver";
import { SpeechRecognitionProvider } from "../types";
import type { RecognitionDriver, SpeechRecognitionOptions } from "../types";

/** Callem ASR provider implementation. It switches to Soniox after two turns. */
export class CallemSpeechRecognition extends AbstractSpeechRecognition {
  readonly provider = SpeechRecognitionProvider.Callem;

  constructor(options: SpeechRecognitionOptions) {
    super(options);
  }

  protected createDriver(): RecognitionDriver {
    if (this.turns >= 2) {
      return createWebSocketRecognitionDriver(
        SpeechRecognitionProvider.Soniox,
        {
          ...this.options,
          apiKey: this.options.sonioxApiKey,
          endpoint: this.options.sonioxEndpoint,
          modelId: undefined,
          provider: SpeechRecognitionProvider.Soniox
        }
      );
    }

    return createWebSocketRecognitionDriver(
      SpeechRecognitionProvider.Callem,
      this.options
    );
  }
}
