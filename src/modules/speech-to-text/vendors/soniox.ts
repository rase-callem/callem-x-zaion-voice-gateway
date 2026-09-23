import WebSocket, { type RawData } from "ws";
import { SpeechToTextProvider } from "../base";
import type { SonioxSpeechToTextOptions } from "../types";

interface SonioxToken {
  text?: string;
  is_final?: boolean;
  end_ms?: number;
}

interface SonioxResponse {
  tokens?: SonioxToken[];
  error_code?: string;
  error_message?: string;
}

/** Soniox real-time recognition uses one WebSocket for the life of a call. */
export class SonioxSpeechToText extends SpeechToTextProvider {
  readonly webSocketUrl: string;
  readonly apiKey: string;
  readonly languageCode: string;
  readonly silenceThreshold: number;

  startTime: number | undefined;
  lastStartTime: number | undefined;
  lastTranscription = "";
  finalText = "";
  end_msFinal = 0;
  end_msNonFinal = 0;
  end_ms = 0;

  private ws: WebSocket | null;

  constructor(options: SonioxSpeechToTextOptions) {
    super(options.uuid);

    this.webSocketUrl = options.webSocketUrl;
    this.apiKey = options.apiKey;
    this.languageCode = options.languageCode || "fr-FR";
    this.silenceThreshold = options.silenceThreshold;
    this.startTime = options.startTime || 0;
    this.lastStartTime = this.startTime;

    if (!this.webSocketUrl || !this.apiKey) {
      throw new Error("Soniox STT requires webSocketUrl and apiKey");
    }

    this.ws = new WebSocket(this.webSocketUrl);
    this.startRecognition();
  }

  startRecognition(): void {
    const ws = this.ws;
    if (!ws) {
      return;
    }

    ws.on("open", () => {
      if (this.ws !== ws) {
        return;
      }

      const socket = (ws as WebSocket & { _socket?: { on(event: string, listener: (error: Error) => void): void } })._socket;
      socket?.on("error", (error) => console.error(this.uuid, "Soniox socket error", error));

      ws.send(JSON.stringify({
        api_key: this.apiKey,
        audio_format: "pcm_s16le",
        sample_rate: 8000,
        num_channels: 1,
        model: "stt-rt-v4",
        language_hints: [this.languageCode.slice(0, 2)],
        enable_language_identification: true,
        context: "",
        enable_non_final_tokens: true,
        enable_endpoint_detection: false,
        max_non_final_tokens_duration_ms: Math.min(Math.max(this.silenceThreshold - 50, 360), 6000)
      }));

      ws.on("close", () => console.info(this.uuid, "Soniox connection closed"));
    });

    ws.on("error", (error) => console.error(this.uuid, "Soniox connection error", error));

    ws.on("unexpected-response", (_request, response) => {
      console.error(this.uuid, "Soniox unexpected response", response.statusCode, response.statusMessage);
    });

    ws.on("message", (data: RawData) => this.handleMessage(data));
  }

  /** Retain Soniox's final-token accumulation and per-turn timestamp filtering. */
  private handleMessage(data: RawData): void {
    let response: SonioxResponse;
    try {
      response = JSON.parse(data.toString()) as SonioxResponse;
    } catch (error) {
      console.error(this.uuid, "Soniox invalid response", error);
      return;
    }
    if (!response || typeof response !== "object") {
      return;
    }

    if (response.error_code) {
      console.error(this.uuid, "Soniox stream error", response.error_code, response.error_message);
    }

    let nonFinalText = "";

    for (const token of Array.isArray(response.tokens) ? response.tokens : []) {
      if (!token || !token.text || typeof token.end_ms !== "number") {
        continue;
      }

      if (token.is_final && token.end_ms > this.end_ms) {
        this.finalText += token.text;
        this.end_msFinal = token.end_ms;
      } else if (token.end_ms > this.end_ms) {
        nonFinalText += token.text;
        this.end_msNonFinal = token.end_ms;
      }
    }

    const transcription = this.finalText + nonFinalText;

    if (transcription !== this.lastTranscription && transcription.trim() !== ".") {
      this.lastTranscription = transcription;
      this.emitTranscription({ transcription });
    }
  }

  restartRecognition(startTime?: number): void {
    this.lastStartTime = this.startTime;
    this.startTime = startTime;
    this.finalText = "";
    this.lastTranscription = "";
    this.end_ms = this.end_msNonFinal + 1000;
  }

  endRecognition(): void {
    const ws = this.ws;

    if (ws?.readyState === WebSocket.OPEN) {
      ws.send("");
      ws.close();
    } else if (ws?.readyState === WebSocket.CONNECTING) {
      ws.terminate();
    }

    this.ws = null;
  }

  sendData(data: Buffer): void {
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(data);
      }
    } catch (error) {
      console.error(this.uuid, "Soniox sendData failed", error);
    }
  }
}
