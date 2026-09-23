import { AbstractSpeechRecognition } from "../base";
import * as azure from "microsoft-cognitiveservices-speech-sdk";
import { aborted, asError, required } from "../../speech/common";
import { SpeechRecognitionProvider } from "../types";
import type { RecognitionDriver, SpeechRecognitionOptions } from "../types";

/** Azure Speech-to-Text provider implementation. */
export class AzureSpeechRecognition extends AbstractSpeechRecognition {
  readonly provider = SpeechRecognitionProvider.Azure;

  constructor(options: SpeechRecognitionOptions) {
    super(options);
  }

  protected createDriver(): RecognitionDriver {
    let recognizer: azure.SpeechRecognizer | undefined;
    let input: azure.PushAudioInputStream | undefined;
    let audio: azure.AudioConfig | undefined;
    let cleanup = () => {};

    const close = async () => {
      cleanup();
      recognizer?.close();
      input?.close();
      audio?.close();
      recognizer = undefined;
      input = undefined;
      audio = undefined;
    };

    return {
      start: async (signal, emit, fail) => {
        const config = azure.SpeechConfig.fromSubscription(
          required(this.options.apiKey, "AZURE_SPEECH_KEY"),
          required(this.options.region, "AZURE_SPEECH_REGION")
        );
        config.speechRecognitionLanguage = this.options.languageCode ?? "fr-FR";
        config.setProfanity(azure.ProfanityOption.Raw);
        config.setProperty(
          azure.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs,
          "15000"
        );
        config.setProperty(
          azure.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs,
          "5000"
        );
        input = azure.AudioInputStream.createPushStream(
          azure.AudioStreamFormat.getWaveFormatPCM(8000, 16, 1)
        );
        audio = azure.AudioConfig.fromStreamInput(input);
        recognizer = new azure.SpeechRecognizer(config, audio);
        recognizer.recognizing = (_sender, event) => {
          const text = event.result.text;
          if (
            event.result.reason === azure.ResultReason.RecognizingSpeech &&
            typeof text === "string" &&
            text.trim()
          ) {
            emit(text, false);
          }
        };
        recognizer.recognized = (_sender, event) => {
          const text = event.result.text;
          if (
            event.result.reason === azure.ResultReason.RecognizedSpeech &&
            typeof text === "string" &&
            text.trim()
          ) {
            emit(text, true);
          }
        };
        recognizer.canceled = () => {
          if (!signal.aborted) {
            fail(new Error("Azure recognition canceled"));
          }
        };
        recognizer.sessionStopped = () => {
          if (!signal.aborted) {
            fail(new Error("Azure recognition session stopped"));
          }
        };

        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            reject(aborted());
            void close();
          };
          cleanup = () => signal.removeEventListener("abort", abort);
          signal.addEventListener("abort", abort, { once: true });

          if (signal.aborted) {
            abort();
            return;
          }

          recognizer!.startContinuousRecognitionAsync(resolve, (error) =>
            reject(asError(error))
          );
        });
      },
      send: async (data) => {
        if (!input) {
          throw new Error("Azure input closed");
        }

        input.write(Uint8Array.from(data).buffer);
      },
      close
    };
  }
}
