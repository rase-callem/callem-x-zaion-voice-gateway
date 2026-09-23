jest.mock("./vendors/azure", () => ({ AzureSpeechToText: jest.fn() }));
jest.mock("./vendors/soniox", () => ({ SonioxSpeechToText: jest.fn() }));

import { AzureSpeechToText } from "./vendors/azure";
import { SonioxSpeechToText } from "./vendors/soniox";
import { createSpeechToText } from "./factory";

describe("STT factory", () => {
  it("selects provider names case insensitively", () => {
    createSpeechToText({ provider: "AZURE", uuid: "call" });
    createSpeechToText({ provider: "SoNiOx", uuid: "call", webSocketUrl: "wss://example.test", apiKey: "key", silenceThreshold: 500 });
    expect(AzureSpeechToText).toHaveBeenCalledTimes(1);
    expect(SonioxSpeechToText).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown providers", () => {
    expect(() => createSpeechToText({ provider: "other", uuid: "call" })).toThrow('Unsupported STT provider "other"');
  });
});
