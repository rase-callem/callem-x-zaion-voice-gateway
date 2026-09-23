import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { SpeechToTextProvider } from "../base";
import type { AzureSpeechToTextOptions } from "../types";

/** Azure continuous recognition with the legacy per-turn restart semantics. */
export class AzureSpeechToText extends SpeechToTextProvider {
  readonly apiKey: string;
  readonly region: string;
  readonly languageCode: string;

  startTime: number | undefined;
  lastStartTime: number | undefined;
  lastTranscription = "";
  finalText = "";
  isRestarting = false;
  isRecognizing = false;

  private pushStream: sdk.PushAudioInputStream | null = null;
  private recognizer: sdk.SpeechRecognizer | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private ended = false;

  constructor(options: AzureSpeechToTextOptions) {
    super(options.uuid);

    this.apiKey = options.apiKey || process.env.AZURE_SPEECH_KEY || "";
    this.region = options.region || process.env.AZURE_SPEECH_REGION || "";
    this.languageCode = options.languageCode || "fr-FR";
    this.startTime = options.startTime || 0;
    this.lastStartTime = this.startTime;

    if (!this.apiKey || !this.region) {
      throw new Error("Azure STT requires AZURE_SPEECH_KEY and AZURE_SPEECH_REGION");
    }

    this.startRecognition();
  }

  /** Configure 8 kHz input and relay Azure partial/final events for the current turn. */
  startRecognition(): void {
    if (this.ended) {
      return;
    }

    try {
      const speechConfig = sdk.SpeechConfig.fromSubscription(this.apiKey, this.region);
      speechConfig.speechRecognitionLanguage = this.languageCode;
      speechConfig.setProfanity(sdk.ProfanityOption.Raw);
      speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, "15000");
      speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs, "5000");

      const format = sdk.AudioStreamFormat.getWaveFormatPCM(8000, 16, 1);
      this.pushStream = sdk.AudioInputStream.createPushStream(format);
      const audioConfig = sdk.AudioConfig.fromStreamInput(this.pushStream);
      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
      this.recognizer = recognizer;

      recognizer.recognizing = (_sender, event) => {
        if (this.isRestarting || event.result.reason !== sdk.ResultReason.RecognizingSpeech) {
          return;
        }

        const partial = event.result.text;

        if (!partial?.trim()) {
          return;
        }

        const transcription = this.finalText ? `${this.finalText} ${partial}` : partial;

        if (transcription === this.lastTranscription) {
          return;
        }

        this.lastTranscription = transcription;
        this.emitTranscription({ transcription, isFinal: false });
      };

      recognizer.recognized = (_sender, event) => {
        if (this.isRestarting || event.result.reason !== sdk.ResultReason.RecognizedSpeech) {
          return;
        }

        const text = event.result.text;

        if (!text?.trim()) {
          return;
        }

        this.finalText = this.finalText ? `${this.finalText} ${text}` : text;

        if (this.finalText === this.lastTranscription) {
          return;
        }

        this.lastTranscription = this.finalText;
        this.emitTranscription({ transcription: this.finalText, isFinal: true });
      };

      recognizer.sessionStarted = () => {
        this.isRecognizing = true;
      };

      recognizer.sessionStopped = () => {
        this.isRecognizing = false;
      };

      recognizer.canceled = (_sender, event) => {
        if (event.reason === sdk.CancellationReason.Error) {
          console.error(this.uuid, "Azure STT canceled", event.errorCode, event.errorDetails);
        }

        this.isRecognizing = false;
      };

      recognizer.startContinuousRecognitionAsync(
        () => {
          this.isRestarting = false;
        },
        (error) => {
          console.error(this.uuid, "Azure STT start failed", error);
          this.isRestarting = false;
        }
      );
    } catch (error) {
      console.error(this.uuid, "Azure STT startRecognition failed", error);
    }
  }

  /** Stop and replace both the recognizer and its push stream for a new turn. */
  restartRecognition(startTime?: number): void {
    if (this.ended) {
      return;
    }

    this.isRestarting = true;
    this.lastStartTime = this.startTime;
    this.startTime = startTime;
    this.finalText = "";
    this.lastTranscription = "";

    const recognizer = this.recognizer;
    if (!recognizer) {
      this.startRecognition();
      return;
    }

    const restart = (): void => {
      this.pushStream?.close();
      recognizer.close();

      if (this.recognizer === recognizer) {
        this.recognizer = null;
      }

      this.pushStream = null;

      if (!this.ended) {
        this.startRecognition();
      }
    };

    try {
      recognizer.stopContinuousRecognitionAsync(restart, (error) => {
        console.error(this.uuid, "Azure STT restart stop failed", error);
        restart();
      });
    } catch (error) {
      console.error(this.uuid, "Azure STT restart failed", error);
      restart();
    }
  }

  private forceCleanup(): void {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
    }

    this.stopTimer = null;

    try {
      this.pushStream?.close();
    } catch {
      // SDK cleanup is best effort.
    }

    try {
      this.recognizer?.close();
    } catch {
      // SDK cleanup is best effort.
    }

    this.pushStream = null;
    this.recognizer = null;
    this.isRecognizing = false;
  }

  endRecognition(): void {
    this.ended = true;

    const recognizer = this.recognizer;

    if (!recognizer) {
      this.forceCleanup();
      return;
    }

    this.stopTimer = setTimeout(() => {
      console.warn(this.uuid, "Azure STT stop timed out after 3s");
      this.forceCleanup();
    }, 3000);

    try {
      recognizer.stopContinuousRecognitionAsync(
        () => this.forceCleanup(),
        (error) => {
          console.error(this.uuid, "Azure STT stop failed", error);
          this.forceCleanup();
        }
      );
    } catch (error) {
      console.error(this.uuid, "Azure STT endRecognition failed", error);
      this.forceCleanup();
    }
  }

  sendData(data: Buffer): void {
    try {
      if (this.pushStream && this.isRecognizing) {
        this.pushStream.write(Uint8Array.from(data).buffer);
      }
    } catch (error) {
      console.error(this.uuid, "Azure STT sendData failed", error);
    }
  }
}
