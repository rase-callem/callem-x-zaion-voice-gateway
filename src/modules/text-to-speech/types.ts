export interface TextToSpeechInput {
  text: string;
  isFinal?: boolean;
}

export type AudioFrameHandler = (frame: Buffer) => void;

export interface AzureTextToSpeechOptions {
  provider: string;
  uuid: string;
  speechSynthesisVoiceName: string;
  speed?: number;
  apiKey?: string;
  region?: string;
}

export interface ElevenLabsVoiceSettings {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  use_speaker_boost?: boolean;
  speed?: number;
}

export interface ElevenLabsTextToSpeechOptions {
  provider: string;
  uuid: string;
  apiKey?: string;
  voiceId: string;
  modelId?: string;
  voiceSettings?: ElevenLabsVoiceSettings;
  projectID?: string;
}

export type TextToSpeechOptions = AzureTextToSpeechOptions | ElevenLabsTextToSpeechOptions;
