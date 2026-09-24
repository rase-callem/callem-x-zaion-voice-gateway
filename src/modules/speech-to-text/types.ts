export interface TranscriptionResult {
  transcription: string;
  isFinal?: boolean;
}

export type TranscriptionHandler = (result: TranscriptionResult) => void;

export interface BaseSpeechToTextOptions {
  uuid: string;
  startTime?: number;
  languageCode?: string;
}

export interface AzureSpeechToTextOptions extends BaseSpeechToTextOptions {
  provider: string;
  apiKey?: string;
  region?: string;
}

export interface SonioxSpeechToTextOptions extends BaseSpeechToTextOptions {
  provider: string;
  webSocketUrl: string;
  apiKey: string;
  silenceThreshold: number;
}

export type SpeechToTextOptions = AzureSpeechToTextOptions | SonioxSpeechToTextOptions;
