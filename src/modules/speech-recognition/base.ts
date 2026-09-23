import { aborted, asError, validateOptions } from "../speech/common";
import type {
  RecognitionDriver,
  SpeechRecognition,
  SpeechRecognitionOptions,
  SpeechRecognitionProvider
} from "./types";

export abstract class AbstractSpeechRecognition implements SpeechRecognition {
  abstract readonly provider: SpeechRecognitionProvider;
  state: SpeechRecognition["state"] = "idle";
  private controller?: AbortController;
  private driver?: RecognitionDriver;
  private starting?: Promise<void>;
  private writing = false;
  private finals = "";
  private last = "";
  protected turns = 0;

  constructor(protected readonly options: SpeechRecognitionOptions) {
    validateOptions(options);
  }

  protected abstract createDriver(): RecognitionDriver;

  startRecognition(): Promise<void> {
    if (this.state === "starting") {
      return this.starting!;
    }

    if (this.state === "listening") {
      return Promise.resolve();
    }

    if (this.state !== "idle") {
      return Promise.reject(
        new Error(`Cannot start recognition in ${this.state}`)
      );
    }

    this.state = "starting";
    this.finals = "";
    this.last = "";
    const controller = (this.controller = new AbortController());
    this.starting = this.start(controller);

    return this.starting;
  }

  private async start(controller: AbortController): Promise<void> {
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 15000
    );

    try {
      const driver = (this.driver = this.createDriver());
      await driver.start(
        controller.signal,
        (text, final, cumulative = false) => {
          if (controller.signal.aborted) {
            return;
          }

          const full = cumulative
            ? text
            : [this.finals, text].filter(Boolean).join(" ").trim();

          if (final) {
            this.finals = full;
          }

          const key = `${final}:${full}`;

          if (full && key !== this.last) {
            this.last = key;
            this.options.onTranscription({
              transcription: full,
              isFinal: final,
              provider: this.provider,
              callId: this.options.callId
            });
          }
        },
        (error) => this.fail(error, controller)
      );

      if (controller.signal.aborted) {
        throw aborted();
      }

      this.state = "listening";
    } catch (error) {
      this.fail(asError(error), controller);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private fail(error: Error, controller: AbortController): void {
    if (
      controller !== this.controller ||
      this.state === "closed" ||
      this.state === "failed"
    ) {
      return;
    }

    this.state = "failed";
    controller.abort();
    void this.driver?.close().catch(() => {});
    this.options.onError(error);
  }

  async sendData(audio: Buffer): Promise<void> {
    if (this.state !== "listening" || !this.driver) {
      throw new Error("Recognition is not listening");
    }

    if (!Buffer.isBuffer(audio) || audio.length % 2) {
      throw new Error("Expected sample-aligned PCM16 audio");
    }

    if (audio.length > (this.options.maxBufferBytes ?? 1024 * 1024)) {
      throw new Error("Speech input buffer limit exceeded");
    }

    if (!audio.length) {
      return;
    }

    if (this.writing) {
      throw new Error("Await each speech audio write before sending another");
    }

    this.writing = true;
    const controller = this.controller!;

    try {
      await this.driver.send(audio);
    } catch (error) {
      this.fail(asError(error), controller);
      throw error;
    } finally {
      this.writing = false;
    }
  }

  async restartRecognition(): Promise<void> {
    if (this.state !== "listening") {
      throw new Error("Recognition must be listening before restart");
    }

    this.state = "idle";
    this.controller?.abort();
    await this.driver?.close();
    this.turns++;

    return this.startRecognition();
  }

  async endRecognition(): Promise<void> {
    this.state = "closed";
    this.controller?.abort();
    await this.driver?.close();
  }
}
