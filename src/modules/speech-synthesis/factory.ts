import {
  AzureSpeechSynthesis,
  VoxygenSpeechSynthesis,
  ElevenLabsSpeechSynthesis,
  GradiumSpeechSynthesis,
  CartesiaSpeechSynthesis
} from "./vendors";
import type { SpeechSynthesis, SpeechSynthesisFactoryOptions } from "./types";
import { SpeechSynthesisProvider } from "./types";

const keys: Record<SpeechSynthesisProvider, string> = {
  [SpeechSynthesisProvider.Azure]: "AZURE_SPEECH_KEY",
  [SpeechSynthesisProvider.Voxygen]: "VOXYGEN_TOKEN",
  [SpeechSynthesisProvider.ElevenLabs]: "ELEVENLABS_API_KEY",
  [SpeechSynthesisProvider.Gradium]: "GRADIUM_API_KEY",
  [SpeechSynthesisProvider.Cartesia]: "CARTESIA_API_KEY"
};

export function createSpeechSynthesis(
  options: SpeechSynthesisFactoryOptions
): SpeechSynthesis {
  const provider = options.provider
    ?.trim()
    .toLowerCase() as SpeechSynthesisProvider;

  if (!Object.prototype.hasOwnProperty.call(keys, provider)) {
    throw new Error(
      `Unsupported speech synthesis provider: ${options.provider}`
    );
  }

  const config = {
    ...options,
    provider,
    apiKey: options.apiKey ?? process.env[keys[provider]],
    region: options.region ?? process.env.AZURE_SPEECH_REGION
  };

  if (provider === SpeechSynthesisProvider.Azure) {
    return new AzureSpeechSynthesis(config);
  }

  if (provider === SpeechSynthesisProvider.Voxygen) {
    return new VoxygenSpeechSynthesis(config);
  }

  const implementations = {
    [SpeechSynthesisProvider.ElevenLabs]: ElevenLabsSpeechSynthesis,
    [SpeechSynthesisProvider.Gradium]: GradiumSpeechSynthesis,
    [SpeechSynthesisProvider.Cartesia]: CartesiaSpeechSynthesis
  };

  return new implementations[provider](config);
}
