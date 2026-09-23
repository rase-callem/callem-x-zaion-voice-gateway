import { AbstractSpeechRecognition } from "../base";
import { SpeechClient } from "@google-cloud/speech";
import type { Duplex } from "stream";
import { aborted } from "../../speech/common";
import { SpeechRecognitionProvider } from "../types";
import type { RecognitionDriver, SpeechRecognitionOptions } from "../types";

const timeToAcceptFinalResult = 2000;

interface GoogleRecognitionResult {
  isFinal?: boolean;
  alternatives?: { transcript?: string }[];
}

interface GoogleRecognitionResponse {
  results?: GoogleRecognitionResult[];
}

/** Google Cloud Speech-to-Text provider implementation. */
export class GoogleSpeechRecognition extends AbstractSpeechRecognition {
  readonly provider = SpeechRecognitionProvider.Google;

  constructor(options: SpeechRecognitionOptions) {
    super(options);
  }

  protected createDriver(): RecognitionDriver {
    let client: SpeechClient | undefined;
    let stream: Duplex | undefined;
    let signal: AbortSignal;
    let startedAt = 0;
    let finalTranscription = "";
    const onAbort = () => stream?.destroy();

    return {
      start: async (abortSignal, emit, fail) => {
        signal = abortSignal;

        if (signal.aborted) {
          throw aborted();
        }

        startedAt = Date.now();
        finalTranscription = "";
        client = new SpeechClient({
          apiEndpoint: this.options.endpoint ?? "eu-speech.googleapis.com"
        });
        stream = client.streamingRecognize({
          config: {
            encoding: "LINEAR16",
            sampleRateHertz: 8000,
            languageCode: this.options.languageCode ?? "fr-FR",
            alternativeLanguageCodes:
              this.options.alternativeLanguageCodes ?? [],
            enableWordTimeOffsets: true,
            model: this.options.modelId ?? "telephony"
          },
          interimResults: true
        });
        signal.addEventListener("abort", onAbort, { once: true });
        stream.on(
          "data",
          (data: GoogleRecognitionResponse) => {
            let transcription = finalTranscription;
            let acceptedFinal = false;
            let hasPartial = false;

            for (const result of data.results ?? []) {
              const text = result.alternatives?.[0]?.transcript;

              if (!text) {
                continue;
              }

              transcription += `${text} `;

              if (result.isFinal) {
                if (Date.now() - startedAt > timeToAcceptFinalResult) {
                  finalTranscription += `${text} `;
                  acceptedFinal = true;
                }
              } else {
                hasPartial = true;
              }
            }

            const normalized = transcription
              .trim()
              .toLowerCase()
              .replaceAll("  ", " ");

            if (normalized) {
              emit(normalized, acceptedFinal && !hasPartial, true);
            }
          }
        );
        stream.on("error", (error) => {
          if (!signal.aborted) {
            fail(error);
          }
        });
        stream.on("end", () => {
          if (!signal.aborted) {
            fail(new Error("Google recognition stream ended"));
          }
        });
        stream.on("close", () => {
          if (!signal.aborted) {
            fail(new Error("Google recognition stream closed"));
          }
        });
      },
      send: (data) =>
        new Promise<void>((resolve, reject) => {
          if (!stream || stream.destroyed || signal.aborted) {
            reject(aborted());
            return;
          }

          const abort = () => finish(aborted());
          const timer = setTimeout(
            () => finish(new Error("Google audio write timed out")),
            this.options.timeoutMs ?? 15000
          );
          const finish = (error?: Error | null) => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            error ? reject(error) : resolve();
          };
          signal.addEventListener("abort", abort, { once: true });
          stream.write(data, finish);
        }),
      close: async () => {
        signal?.removeEventListener("abort", onAbort);
        stream?.destroy();
        stream = undefined;
        const closing = client;
        client = undefined;
        await closing?.close();
      }
    };
  }
}
