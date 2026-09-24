import { AzureTextToSpeech } from "./vendors/azure";
import { ElevenLabsTextToSpeech } from "./vendors/elevenlabs";
import type { TextToSpeechProvider } from "./base";
import type { TextToSpeechOptions } from "./types";

export function createTextToSpeech(options: TextToSpeechOptions): TextToSpeechProvider {
  switch (options.provider.toLowerCase()) {
    case "azure":
      if (!("speechSynthesisVoiceName" in options)) {
        throw new Error("Azure TTS requires speechSynthesisVoiceName");
      }
      return new AzureTextToSpeech(options);
    case "elevenlabs":
      if (!("voiceId" in options)) {
        throw new Error("ElevenLabs TTS requires voiceId");
      }
      return new ElevenLabsTextToSpeech(options);
    default:
      throw new Error(`Unsupported TTS provider "${options.provider}". Expected azure or elevenlabs`);
  }
}
