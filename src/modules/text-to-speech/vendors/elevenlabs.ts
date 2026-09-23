import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import WebSocket, { type RawData } from "ws";
import { TextToSpeechProvider } from "../base";
import type {
  ElevenLabsTextToSpeechOptions,
  ElevenLabsVoiceSettings,
  TextToSpeechInput
} from "../types";

interface QueueItem extends TextToSpeechInput {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface Generation {
  text: string;
  fullAudioBuffer: Buffer;
  isFinal: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface ElevenLabsMessage {
  audio?: string;
  isFinal?: boolean;
  error?: string;
  message?: string;
}

/** Per-call ElevenLabs streaming TTS with the legacy queue, disk cache and static audio codes. */
export class ElevenLabsTextToSpeech extends TextToSpeechProvider {
  private static readonly FRAME_SIZE = 320;
  private static readonly SILENCE_THRESHOLD_MS = 500;
  private static readonly INACTIVITY_TIMEOUT_SEC = 6;
  private static readonly IDLE_TIMEOUT_MS = 5000;

  readonly apiKey: string;
  readonly voiceId: string;
  readonly modelId: string;
  readonly projectID?: string;
  readonly voiceSettings: ElevenLabsVoiceSettings;

  private queue: QueueItem[] = [];
  private activeItem: QueueItem | null = null;
  private isProcessing = false;
  private ws: WebSocket | null = null;
  private isConnected = false;
  private connectionPromise: Promise<void> | null = null;
  private currentGeneration: Generation | null = null;
  private silenceTimeout: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnected = false;

  constructor(options: ElevenLabsTextToSpeechOptions) {
    super(options.uuid);

    this.apiKey = options.apiKey || process.env.ELEVENLABS_API_KEY || "";

    if (!this.apiKey || !options.voiceId) {
      throw new Error("ElevenLabs TTS requires apiKey and voiceId");
    }

    this.voiceId = options.voiceId;
    this.modelId = options.modelId || "eleven_turbo_v2_5";
    this.projectID = options.projectID;

    const defaults: Required<ElevenLabsVoiceSettings> = {
      stability: 0.5,
      similarity_boost: 0.5,
      style: 0,
      use_speaker_boost: false,
      speed: 1.0
    };

    const settings = options.voiceSettings;

    this.voiceSettings = settings ? {
      stability: this.clampValue(settings.stability, 0, 1, defaults.stability),
      similarity_boost: this.clampValue(settings.similarity_boost, 0, 1, defaults.similarity_boost),
      style: this.clampValue(settings.style, 0, 1, defaults.style),
      use_speaker_boost: typeof settings.use_speaker_boost === "boolean" ? settings.use_speaker_boost : defaults.use_speaker_boost,
      ...(settings.speed !== undefined ? { speed: this.clampValue(settings.speed, 0.25, 4, defaults.speed) } : {})
    } : { ...defaults };
  }

  private clampValue(value: number | undefined, min: number, max: number, fallback: number): number {
    if (value === undefined || value === null || Number.isNaN(Number(value))) {
      return fallback;
    }

    return Math.min(max, Math.max(min, Number.parseFloat(String(value))));
  }

  private isStaticCode(text: string): boolean {
    return /^\[[^\[\]]+\]$/.test(text.trim());
  }

  private getStaticAudioPath(code: string): string | null {
    const match = code.trim().match(/^\[([^\[\]]+)\]$/);

    return match ? path.join("/mnt/tts-cache", "elevenlabs", String(this.projectID), `${match[1]}.pcm`) : null;
  }

  private getCachePath(text: string): { dir: string; file: string } {
    const hash = createHash("sha256").update(JSON.stringify({
      provider: "elevenlabs", voiceId: this.voiceId, modelId: this.modelId, voiceSettings: this.voiceSettings, text
    })).digest("hex");

    const dir = path.join("/mnt/tts-cache", "elevenlabs");

    return { dir, file: path.join(dir, `${hash}.pcm`) };
  }

  /** Share an in-flight connection attempt and reconnect after idle closure. */
  async connect(): Promise<void> {
    if (this.disconnected) {
      throw new Error("ElevenLabs TTS is disconnected");
    }

    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream-input` +
      `?model_id=${this.modelId}&output_format=pcm_8000&auto_mode=true` +
      `&apply_text_normalization=auto&inactivity_timeout=${ElevenLabsTextToSpeech.INACTIVITY_TIMEOUT_SEC}`;

    this.connectionPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { "xi-api-key": this.apiKey } });
      this.ws = ws;

      let settled = false;

      const fail = (error: Error): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(connectionTimeout);

        if (!this.ws || this.ws === ws) {
          this.connectionPromise = null;
        }

        reject(error);
      };

      const connectionTimeout = setTimeout(() => {
        if (!this.isConnected) {
          fail(new Error("Connection timeout"));
          ws.close();
        }
      }, 5000);

      ws.on("open", () => {
        if (settled || this.disconnected) {
          ws.close();
          return;
        }

        settled = true;
        clearTimeout(connectionTimeout);
        this.isConnected = true;
        this.connectionPromise = null;
        this.resetIdleTimer();

        const socket = (ws as WebSocket & { _socket?: { on(event: string, listener: (error: Error) => void): void } })._socket;
        socket?.on("error", (error) => console.error(this.uuid, "ElevenLabs socket error", error));

        resolve();
      });

      ws.on("message", (data: RawData) => {
        if (this.ws === ws) {
          this.handleMessage(data);
        }
      });

      ws.on("unexpected-response", (_request, response) => {
        if (this.ws === ws) {
          this.isConnected = false;
        }

        fail(new Error(`ElevenLabs ${response.statusCode} ${response.statusMessage}`));
        ws.close();
      });

      ws.on("error", (error) => {
        if (this.ws === ws) {
          this.isConnected = false;
        }

        console.error(this.uuid, "ElevenLabs connection error", error);
        fail(error);
      });

      ws.on("close", () => {
        fail(new Error("CONNECTION_CLOSED"));

        if (this.ws !== ws) {
          return;
        }

        this.isConnected = false;
        this.ws = null;

        if (this.currentGeneration) {
          const generation = this.currentGeneration;
          this.currentGeneration = null;
          generation.reject(new Error("CONNECTION_CLOSED"));
        }

        this.clearSilenceTimer();
        this.clearIdleTimer();
        this.isProcessing = false;

        if (this.queue.length && !this.disconnected) {
          setImmediate(() => void this.processNext());
        }
      });
    });

    return this.connectionPromise;
  }

  private handleMessage(data: RawData): void {
    let response: ElevenLabsMessage;
    try {
      response = JSON.parse(data.toString()) as ElevenLabsMessage;
    } catch {
      console.error(this.uuid, "ElevenLabs invalid message");
      return;
    }
    if (!response || typeof response !== "object") {
      return;
    }

    if (response.audio && this.currentGeneration) {
      const audio = Buffer.from(response.audio, "base64");
      const generation = this.currentGeneration;

      generation.fullAudioBuffer = Buffer.concat([generation.fullAudioBuffer, audio]);
      this.emitAudio(audio);

      if (!generation.isFinal) {
        this.resetSilenceTimer();
      }
    }

    if (response.isFinal) {
      this.clearSilenceTimer();

      if (this.currentGeneration) {
        this.onPhraseComplete();
      }

      const ws = this.ws;

      setTimeout(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.close();
        }
      }, 100);
    }

    if (response.error) {
      console.error(this.uuid, "ElevenLabs stream error", response.error, response.message);

      if (response.error === "input_timeout_exceeded") {
        this.isConnected = false;
        this.ws?.close();
      }
    }
  }

  /** Preserve the legacy per-chunk 320-byte split, including a short tail. */
  private emitAudio(audio: Buffer): void {
    if (this.disconnected) {
      return;
    }

    for (let offset = 0; offset < audio.length; offset += ElevenLabsTextToSpeech.FRAME_SIZE) {
      const frame = audio.subarray(offset, offset + ElevenLabsTextToSpeech.FRAME_SIZE);

      this.emitAudioFrame(frame);
    }
  }

  private resetSilenceTimer(): void {
    this.clearSilenceTimer();

    if (this.currentGeneration && !this.currentGeneration.isFinal) {
      this.silenceTimeout = setTimeout(() => this.onPhraseComplete(), ElevenLabsTextToSpeech.SILENCE_THRESHOLD_MS);
    }
  }
  private clearSilenceTimer(): void {
    if (this.silenceTimeout) {
      clearTimeout(this.silenceTimeout);
    }

    this.silenceTimeout = null;
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();

    this.idleTimer = setTimeout(() => {
      if (this.currentGeneration || this.queue.length) {
        return;
      }

      if (this.ws?.readyState === WebSocket.OPEN) {
        this.isConnected = false;
        this.ws.close();
      }
    }, ElevenLabsTextToSpeech.IDLE_TIMEOUT_MS);
  }
  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = null;
  }

  private onPhraseComplete(): void {
    const generation = this.currentGeneration;
    if (!generation) {
      return;
    }

    this.clearSilenceTimer();
    void this.saveToCache(generation);
    generation.resolve();

    this.currentGeneration = null;
    this.isProcessing = false;

    setImmediate(() => void this.processNext());
  }

  private async saveToCache(generation: Generation): Promise<void> {
    if (!generation.fullAudioBuffer.length) {
      return;
    }

    try {
      const { dir, file } = this.getCachePath(generation.text);

      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(file, generation.fullAudioBuffer);
    } catch (error) {
      console.error(this.uuid, "ElevenLabs cache write failed", error);
    }
  }

  private async streamFromCache(file: string): Promise<void> {
    const pcm = await fsp.readFile(file);

    if (this.disconnected) {
      throw new Error("ElevenLabs TTS disconnected");
    }

    if (!pcm.length) {
      throw new Error("Empty cache file");
    }

    for (let offset = 0; offset < pcm.length; offset += ElevenLabsTextToSpeech.FRAME_SIZE) {
      this.emitAudioFrame(pcm.subarray(offset, offset + ElevenLabsTextToSpeech.FRAME_SIZE));
    }
  }

  private async streamStaticAudio(code: string): Promise<void> {
    const file = this.getStaticAudioPath(code);
    if (!file) {
      throw new Error(`Invalid static code: ${code}`);
    }

    await fsp.access(file, fs.constants.R_OK);

    const pcm = await fsp.readFile(file);

    if (this.disconnected) {
      throw new Error("ElevenLabs TTS disconnected");
    }

    if (!pcm.length) {
      throw new Error("Empty static file");
    }

    for (let offset = 0; offset < pcm.length; offset += ElevenLabsTextToSpeech.FRAME_SIZE) {
      this.emitAudioFrame(pcm.subarray(offset, offset + ElevenLabsTextToSpeech.FRAME_SIZE));
    }
  }

  private closeConnection(): void {
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      ws.send(JSON.stringify({ text: "", try_trigger_generation: true }));
    } catch {
      // The socket is closing already.
    }

    setTimeout(() => ws.close(), 100);
  }

  private async generateViaAPI(text: string, isFinal: boolean): Promise<void> {
    await this.connect();

    return new Promise<void>((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        reject(new Error("CONNECTION_CLOSED"));
        return;
      }

      this.currentGeneration = {
        text,
        fullAudioBuffer: Buffer.alloc(0),
        isFinal,
        resolve,
        reject
      };

      const ws = this.ws;

      ws.send(JSON.stringify({ text, voice_settings: this.voiceSettings, flush: true }));
      this.resetIdleTimer();

      if (isFinal) {
        setTimeout(() => {
          if (!this.disconnected && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ text: "", try_trigger_generation: true }));
            this.resetIdleTimer();
          }
        }, 100);
      }
    });
  }

  /** Split text and bracketed static codes while retaining their original order. */
  private splitMixedContent(text: string): string[] {
    if (!text?.trim()) {
      return [text];
    }

    const parts: string[] = [];
    const regex = /\[[^\[\]]+\]/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        const before = text.slice(lastIndex, match.index).trim();
        if (before) {
          parts.push(before);
        }
      }

      parts.push(match[0]);
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      const remaining = text.slice(lastIndex).trim();
      if (remaining) {
        parts.push(remaining);
      }
    }

    return parts.length ? parts : [text];
  }

  /** Process one queued phrase; a closed stream requeues it before reconnecting. */
  private async processNext(): Promise<void> {
    if (this.disconnected || this.isProcessing || !this.queue.length) {
      return;
    }

    this.isProcessing = true;

    const item = this.queue.shift()!;

    this.activeItem = item;

    if (item.text && !this.isStaticCode(item.text)) {
      const parts = this.splitMixedContent(item.text);

      if (parts.length > 1) {
        for (let index = parts.length - 1; index >= 1; index--) {
          this.queue.unshift({
            text: parts[index],
            isFinal: index === parts.length - 1 ? item.isFinal : false,
            resolve: index === parts.length - 1 ? item.resolve : () => {},
            reject: item.reject
          });
        }

        item.text = parts[0];
        item.isFinal = false;
        item.resolve = () => {};
      }
    }

    if (item.isFinal && !item.text?.trim()) {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ text: "", try_trigger_generation: true }));
        this.resetIdleTimer();
      }

      item.resolve();
      this.activeItem = null;
      this.isProcessing = false;
      return;
    }

    if (!item.text?.trim()) {
      item.resolve();
      this.activeItem = null;
      this.isProcessing = false;
      setImmediate(() => void this.processNext());
      return;
    }

    if (this.isStaticCode(item.text)) {
      try {
        await this.streamStaticAudio(item.text.trim());
      } catch (error) {
        console.error(this.uuid, "ElevenLabs static audio failed", error);
      }

      item.resolve();
      this.activeItem = null;
      this.isProcessing = false;
      if (!this.queue.length) {
        this.closeConnection();
      }

      setImmediate(() => void this.processNext());
      return;
    }

    try {
      const { file } = this.getCachePath(item.text);

      let needsGeneration = false;

      try {
        await fsp.access(file, fs.constants.R_OK);

        if ((await fsp.stat(file)).size === 0) {
          try {
            await fsp.unlink(file);
          } catch {
            // The empty cache file may already have been removed by another call.
          }

          needsGeneration = true;
        }
      } catch {
        needsGeneration = true;
      }

      if (needsGeneration) {
        await this.generateViaAPI(item.text, Boolean(item.isFinal));

        if (this.disconnected) {
          throw new Error("ElevenLabs TTS disconnected");
        }

        item.resolve();
        this.activeItem = null;
      } else {
        await this.streamFromCache(file);

        item.resolve();
        this.activeItem = null;
        this.isProcessing = false;

        if (item.isFinal) {
          setTimeout(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ text: "", try_trigger_generation: true }));
              this.resetIdleTimer();
            }
          }, 100);
        }

        setImmediate(() => void this.processNext());
      }
    } catch (error) {
      if (this.disconnected) {
        item.reject(error instanceof Error ? error : new Error(String(error)));
      } else if (error instanceof Error && error.message === "CONNECTION_CLOSED") {
        this.queue.unshift(item);
      } else {
        console.error(this.uuid, "ElevenLabs generation failed", error);
        item.resolve();
      }

      this.activeItem = null;
      this.isProcessing = false;

      setImmediate(() => void this.processNext());
    }
  }

  sendText(input: TextToSpeechInput): Promise<void> {
    if (this.disconnected) {
      return Promise.reject(new Error("ElevenLabs TTS is disconnected"));
    }

    return new Promise<void>((resolve, reject) => {
      this.queue.push({ text: input.text || "", isFinal: input.isFinal || false, resolve, reject });
      void this.processNext();
    });
  }

  async disconnect(): Promise<void> {
    if (this.disconnected) {
      return;
    }

    this.disconnected = true;

    const error = new Error("ElevenLabs TTS disconnected");

    for (const item of this.queue.splice(0)) {
      item.reject(error);
    }

    this.activeItem?.reject(error);
    this.activeItem = null;

    this.currentGeneration?.reject(error);
    this.currentGeneration = null;

    this.clearSilenceTimer();
    this.clearIdleTimer();
    this.closeConnection();

    if (this.ws?.readyState === WebSocket.CONNECTING) {
      this.ws.terminate();
    }

    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.ws = null;
    }

    this.isConnected = false;
  }
}
