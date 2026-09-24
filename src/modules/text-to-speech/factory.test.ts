jest.mock("./vendors/azure", () => ({ AzureTextToSpeech: jest.fn() }));
jest.mock("./vendors/elevenlabs", () => ({ ElevenLabsTextToSpeech: jest.fn() }));

import { AzureTextToSpeech } from "./vendors/azure";
import { ElevenLabsTextToSpeech } from "./vendors/elevenlabs";
import { createTextToSpeech } from "./factory";

describe("TTS factory", () => {
  it("selects provider names case insensitively", () => {
    createTextToSpeech({ provider: "AZURE", uuid: "call", speechSynthesisVoiceName: "voice" });
    createTextToSpeech({ provider: "ElevenLabs", uuid: "call", apiKey: "key", voiceId: "voice" });
    expect(AzureTextToSpeech).toHaveBeenCalledTimes(1);
    expect(ElevenLabsTextToSpeech).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown providers", () => {
    expect(() => createTextToSpeech({ provider: "other", uuid: "call", speechSynthesisVoiceName: "voice" }))
      .toThrow('Unsupported TTS provider "other"');
  });
});
