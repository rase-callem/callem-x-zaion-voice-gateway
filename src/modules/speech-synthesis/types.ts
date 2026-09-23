import type { SpeechOptions } from "../speech/common";

export enum SpeechSynthesisProvider {
  Azure = "azure",
  Voxygen = "voxygen",
  ElevenLabs = "elevenlabs",
  Gradium = "gradium",
  Cartesia = "cartesia"
}

export interface SpeechSynthesisOptions extends SpeechOptions {
  provider: SpeechSynthesisProvider;
  voice: string;
  inactivityTimeoutSeconds?: number;
  settings?: {
    speed?: number;
    stability?: number;
    similarity_boost?: number;
    use_speaker_boost?: boolean;
    style?: number;
    volume?: number;
  };
}

export interface SpeechSynthesisFactoryOptions extends Omit<
  SpeechSynthesisOptions,
  "provider"
> {
  provider: string;
}

export interface SpeechSynthesis {
  readonly provider: SpeechSynthesisProvider;
  /** One text segment per stream. Consume sequentially to preserve LLM response ordering. */
  synthesize(
    text: string,
    options?: { signal?: AbortSignal }
  ): AsyncIterable<Buffer>;
  /** Interrupt the active segment. The instance remains reusable. */
  cancel(): void;
  /** Terminal call cleanup. */
  close(): Promise<void>;
}
