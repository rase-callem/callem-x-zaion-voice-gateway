import { AbstractSpeechSynthesis } from "../base";
import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { aborted, asError, required, SpeechQueue } from "../../speech/common";
import { SpeechSynthesisProvider } from "../types";
import type { SpeechSynthesisOptions } from "../types";

function escapeXml(value: string): string {
  return value.replace(
    /[<>&"']/g,
    (character) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;"
      })[character]!
  );
}

/** Azure Speech Synthesis provider implementation. */
export class AzureSpeechSynthesis extends AbstractSpeechSynthesis {
  readonly provider = SpeechSynthesisProvider.Azure;

  constructor(options: SpeechSynthesisOptions) {
    super(options);
  }

  protected generate(text: string, signal: AbortSignal): AsyncIterable<Buffer> {
    return this.generateAzureSpeech(text, signal);
  }

  private async *generateAzureSpeech(
    text: string,
    signal: AbortSignal
  ): AsyncGenerator<Buffer> {
    if (signal.aborted) {
      throw aborted();
    }

    const config = sdk.SpeechConfig.fromSubscription(
      required(this.options.apiKey, "AZURE_SPEECH_KEY"),
      required(this.options.region, "AZURE_SPEECH_REGION")
    );
    config.speechSynthesisVoiceName = this.options.voice;
    config.speechSynthesisOutputFormat =
      sdk.SpeechSynthesisOutputFormat.Raw8Khz16BitMonoPcm;

    const synthesizer = new sdk.SpeechSynthesizer(config, null);
    const queue = new SpeechQueue<Buffer>(this.options.maxBufferBytes);
    let disposed = false;
    const dispose = () => {
      if (!disposed) {
        disposed = true;
        synthesizer.close();
      }
    };
    const abort = () => {
      queue.end(aborted());
      dispose();
    };
    signal.addEventListener("abort", abort, { once: true });
    synthesizer.synthesizing = (_sender, event) => {
      try {
        const chunk = Buffer.from(event.result.audioData);
        queue.push(chunk, chunk.length);
      } catch (error) {
        queue.end(asError(error));
        dispose();
      }
    };

    try {
      synthesizer.speakSsmlAsync(
        `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escapeXml(this.options.languageCode ?? "fr-FR")}"><voice name="${escapeXml(this.options.voice)}"><prosody rate="${Math.round(((this.options.settings?.speed ?? 1) - 1) * 100)}%">${escapeXml(text)}</prosody></voice></speak>`,
        (result) =>
          queue.end(
            result.reason === sdk.ResultReason.SynthesizingAudioCompleted
              ? undefined
              : new Error("Azure synthesis canceled")
          ),
        (error) => queue.end(asError(error))
      );
      yield* queue;
    } finally {
      signal.removeEventListener("abort", abort);
      dispose();
    }
  }
}
