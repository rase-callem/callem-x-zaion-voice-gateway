import type { SpeechOptions } from "../speech/common";

export enum SpeechRecognitionProvider {
  Azure = "azure",
  Google = "google",
  Callem = "callem",
  Kroko = "kroko",
  Soniox = "soniox",
  Gladia = "gladia",
  ElevenLabs = "elevenlabs",
  AssemblyAI = "assemblyai"
}

export interface Transcription {
  /** Full current turn, including finalized segments and the latest partial. */
  transcription: string;
  isFinal: boolean;
  provider: SpeechRecognitionProvider;
  callId: string;
}

export interface SpeechRecognitionOptions extends SpeechOptions {
  provider: SpeechRecognitionProvider;
  language?: { code?: string | null };
  audioFormat?: string;
  sampleRate?: number;
  commitStrategy?: "manual" | "vad";
  includeTimestamps?: boolean;
  lastAgentMessage?: string;
  silenceThreshold?: number;
  alternativeLanguageCodes?: string[];
  sonioxApiKey?: string;
  sonioxEndpoint?: string;
  onTranscription: (result: Transcription) => void;
  onError: (error: Error) => void;
}

export interface SpeechRecognitionFactoryOptions extends Omit<
  SpeechRecognitionOptions,
  "provider"
> {
  provider: string;
}

export interface SpeechRecognition {
  readonly provider: SpeechRecognitionProvider;
  readonly state: "idle" | "starting" | "listening" | "closed" | "failed";
  startRecognition(): Promise<void>;
  /** Await each write. Input must be sample-aligned PCM16LE, 8 kHz, mono. */
  sendData(audio: Buffer): Promise<void>;
  /** Cancels the previous turn and starts a fresh provider session. */
  restartRecognition(): Promise<void>;
  /** Terminal hangup/cancellation; outstanding partials are discarded. */
  endRecognition(): Promise<void>;
}

export interface RecognitionDriver {
  start(
    signal: AbortSignal,
    emit: (text: string, final: boolean, cumulative?: boolean) => void,
    fail: (error: Error) => void
  ): Promise<void>;
  send(audio: Buffer): Promise<void>;
  close(): Promise<void>;
}
