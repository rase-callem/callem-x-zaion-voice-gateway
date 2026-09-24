interface SynthesisEvent { result: { audioData: ArrayBuffer } }
const mockSynthesizers: MockSynthesizer[] = [];
class MockSynthesizer {
  synthesizing?: (_sender: unknown, event: SynthesisEvent) => void;
  speakSsmlAsync = jest.fn((_ssml: string, _success: (result: { reason: number; errorDetails?: string }) => void, _failure: (error: Error) => void) => {});
  close = jest.fn();
  constructor() { mockSynthesizers.push(this); }
}
jest.mock("microsoft-cognitiveservices-speech-sdk", () => ({
  SpeechConfig: { fromSubscription: jest.fn(() => ({})) },
  SpeechSynthesisOutputFormat: { Raw8Khz16BitMonoPcm: 1 },
  AudioConfig: { fromAudioFileOutput: jest.fn(() => ({})) },
  SpeechSynthesizer: jest.fn().mockImplementation(() => new MockSynthesizer()),
  ResultReason: { SynthesizingAudioCompleted: 4 }
}));

import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { AzureTextToSpeech } from "./azure";
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("Azure TTS", () => {
  beforeEach(() => { mockSynthesizers.length = 0; });

  it("serializes synthesis and emits raw 320-byte PCM frames", async () => {
    const provider = new AzureTextToSpeech({ provider: "azure", uuid: "call", apiKey: "key", region: "region", speechSynthesisVoiceName: "fr-voice", speed: 1.2 });
    const frames: Buffer[] = [];
    provider.setHandler((frame) => frames.push(frame));
    const first = provider.sendText({ text: "Bonjour", isFinal: false });
    const second = provider.sendText({ text: "Encore", isFinal: true });
    await tick();
    expect(mockSynthesizers).toHaveLength(1);
    const pcm = Buffer.alloc(650, 7);
    mockSynthesizers[0].synthesizing?.(null, { result: { audioData: Uint8Array.from(pcm).buffer } });
    expect(frames.map((frame) => frame.length)).toEqual([320, 320]);
    expect(frames[0]).toEqual(Buffer.alloc(320, 7));
    expect(mockSynthesizers[0].speakSsmlAsync.mock.calls[0][0]).toContain('<prosody rate="1.2">');
    mockSynthesizers[0].speakSsmlAsync.mock.calls[0][1]({ reason: 4 });
    await first;
    await tick();
    expect(mockSynthesizers).toHaveLength(2);
    mockSynthesizers[1].speakSsmlAsync.mock.calls[0][1]({ reason: 4 });
    await second;
    expect(mockSynthesizers[0].close).toHaveBeenCalled();
    expect(sdk.AudioConfig.fromAudioFileOutput).toHaveBeenCalledWith(expect.stringMatching(/^\/var\/spool\/asterisk\/monitor\/[a-f0-9]{32}\.wav$/));
  });

  it("continues the queue after a canceled synthesis", async () => {
    const provider = new AzureTextToSpeech({ provider: "azure", uuid: "call", apiKey: "key", region: "region", speechSynthesisVoiceName: "voice" });
    const first = provider.sendText({ text: "first" });
    const failure = expect(first).rejects.toThrow("Speech synthesis canceled: canceled");
    const second = provider.sendText({ text: "second" });
    await tick();
    mockSynthesizers[0].speakSsmlAsync.mock.calls[0][1]({ reason: 0, errorDetails: "canceled" });
    await failure;
    await tick();
    expect(mockSynthesizers).toHaveLength(2);
    mockSynthesizers[1].speakSsmlAsync.mock.calls[0][1]({ reason: 4 });
    await second;
  });
});
