import { AzureSpeechToText } from "./vendors/azure";
import { SonioxSpeechToText } from "./vendors/soniox";
import type { SpeechToTextOptions } from "./types";
import type { SpeechToTextProvider } from "./base";

export function createSpeechToText(options: SpeechToTextOptions): SpeechToTextProvider {
  switch (options.provider.toLowerCase()) {
    case "azure":
      if ("webSocketUrl" in options) {
        throw new Error("Azure STT options cannot contain Soniox configuration");
      }
      return new AzureSpeechToText(options);
    case "soniox":
      if (!("webSocketUrl" in options)) {
        throw new Error("Soniox STT requires webSocketUrl and apiKey");
      }
      return new SonioxSpeechToText(options);
    default:
      throw new Error(`Unsupported STT provider "${options.provider}". Expected azure or soniox`);
  }
}
