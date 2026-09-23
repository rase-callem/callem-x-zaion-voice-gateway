import {
  CallemSpeechRecognition,
  KrokoSpeechRecognition,
  SonioxSpeechRecognition,
  GladiaSpeechRecognition,
  ElevenLabsSpeechRecognition,
  AssemblyAISpeechRecognition
} from "./vendors";
import { AzureSpeechRecognition, GoogleSpeechRecognition } from "./vendors";
import type {
  SpeechRecognition,
  SpeechRecognitionFactoryOptions,
  SpeechRecognitionOptions
} from "./types";
import { SpeechRecognitionProvider } from "./types";

const keys: Record<SpeechRecognitionProvider, string> = {
  [SpeechRecognitionProvider.Azure]: "AZURE_SPEECH_KEY",
  [SpeechRecognitionProvider.Google]: "",
  [SpeechRecognitionProvider.Callem]: "",
  [SpeechRecognitionProvider.Kroko]: "KROKO_CLOUD_API_KEY",
  [SpeechRecognitionProvider.Soniox]: "SONIOX_API_KEY",
  [SpeechRecognitionProvider.Gladia]: "GLADIA_API_KEY",
  [SpeechRecognitionProvider.ElevenLabs]: "ELEVENLABS_API_KEY",
  [SpeechRecognitionProvider.AssemblyAI]: "ASSEMBLYAI_API_KEY"
};

export function createSpeechRecognition(
  options: SpeechRecognitionFactoryOptions
): SpeechRecognition {
  const provider = options.provider
    ?.trim()
    .toLowerCase() as SpeechRecognitionProvider;

  if (!Object.prototype.hasOwnProperty.call(keys, provider)) {
    throw new Error(
      `Unsupported speech recognition provider: ${options.provider}`
    );
  }

  const language = options.languageCode ?? options.language?.code;
  const config: SpeechRecognitionOptions = {
    ...options,
    provider,
    languageCode:
      !language || language === "null" || language === "undefined"
        ? "fr-FR"
        : language,
    apiKey: options.apiKey ?? process.env[keys[provider]],
    region: options.region ?? process.env.AZURE_SPEECH_REGION,
    endpoint:
      options.endpoint ??
      (provider === "callem"
        ? process.env.CALLEM_ASR_WEBSOCKET_URL
        : provider === SpeechRecognitionProvider.Soniox
          ? process.env.SONIOX_WEBSOCKET_URL
          : provider === SpeechRecognitionProvider.AssemblyAI
            ? process.env.ASSEMBLYAI_WEBSOCKET_URL
            : undefined),
    sonioxApiKey: options.sonioxApiKey ?? process.env.SONIOX_API_KEY,
    sonioxEndpoint: options.sonioxEndpoint ?? process.env.SONIOX_WEBSOCKET_URL
  };

  if (provider === SpeechRecognitionProvider.Azure) {
    return new AzureSpeechRecognition(config);
  }

  if (provider === SpeechRecognitionProvider.Google) {
    return new GoogleSpeechRecognition(config);
  }

  const implementations = {
    [SpeechRecognitionProvider.Callem]: CallemSpeechRecognition,
    [SpeechRecognitionProvider.Kroko]: KrokoSpeechRecognition,
    [SpeechRecognitionProvider.Soniox]: SonioxSpeechRecognition,
    [SpeechRecognitionProvider.Gladia]: GladiaSpeechRecognition,
    [SpeechRecognitionProvider.ElevenLabs]: ElevenLabsSpeechRecognition,
    [SpeechRecognitionProvider.AssemblyAI]: AssemblyAISpeechRecognition
  };

  return new implementations[provider](config);
}
