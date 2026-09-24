import { EventEmitter } from "node:events";

const mockSockets: MockSocket[] = [];
class MockSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = MockSocket.CONNECTING;
  send = jest.fn();
  close = jest.fn(() => { this.readyState = 3; this.emit("close"); });
  terminate = jest.fn(() => { this.readyState = 3; this.emit("close"); });
  constructor(readonly url: string) { super(); mockSockets.push(this); }
  open(): void { this.readyState = MockSocket.OPEN; this.emit("open"); }
  message(value: unknown): void { this.emit("message", Buffer.from(JSON.stringify(value))); }
}
jest.mock("ws", () => ({ __esModule: true, default: MockSocket }));

import { SonioxSpeechToText } from "./soniox";

describe("Soniox STT", () => {
  beforeEach(() => { mockSockets.length = 0; jest.spyOn(console, "info").mockImplementation(() => {}); });
  afterEach(() => jest.restoreAllMocks());

  it("sends the legacy start request and audio only after the socket opens", () => {
    const provider = new SonioxSpeechToText({ provider: "soniox", uuid: "call", webSocketUrl: "wss://example.test", apiKey: "key", silenceThreshold: 500, languageCode: "fr-FR" });
    const ws = mockSockets[0];
    provider.sendData(Buffer.from([1]));
    expect(ws.send).not.toHaveBeenCalled();
    ws.open();
    expect(JSON.parse(ws.send.mock.calls[0][0] as string)).toMatchObject({
      api_key: "key", audio_format: "pcm_s16le", sample_rate: 8000, num_channels: 1,
      model: "stt-rt-v4", language_hints: ["fr"], enable_endpoint_detection: false,
      max_non_final_tokens_duration_ms: 450
    });
    provider.sendData(Buffer.from([1, 2]));
    expect(ws.send.mock.calls[1][0]).toEqual(Buffer.from([1, 2]));
    provider.endRecognition();
    expect(ws.send.mock.calls[2][0]).toBe("");
    expect(ws.close).toHaveBeenCalled();
  });

  it("accumulates final tokens, filters duplicate text, and offsets a new turn", () => {
    const provider = new SonioxSpeechToText({ provider: "soniox", uuid: "call", webSocketUrl: "wss://example.test", apiKey: "key", silenceThreshold: 500 });
    const handler = jest.fn();
    provider.setHandler(handler);
    const ws = mockSockets[0];
    ws.open();
    ws.message({ tokens: [{ text: "hello", is_final: true, end_ms: 100 }, { text: " world", is_final: false, end_ms: 200 }] });
    ws.message({ tokens: [{ text: "hello", is_final: true, end_ms: 100 }] });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0][0]).toEqual({ transcription: "hello world" });
    expect(handler.mock.calls[1][0]).toEqual({ transcription: "hellohello" });
    provider.restartRecognition(12);
    expect(provider.end_ms).toBe(1200);
    ws.message({ tokens: [{ text: "old", is_final: true, end_ms: 200 }] });
    ws.message({ tokens: [{ text: "new", is_final: true, end_ms: 1300 }] });
    expect(handler.mock.calls.at(-1)?.[0]).toEqual({ transcription: "new" });
    provider.endRecognition();
  });

  it("terminates a connecting socket on hangup", () => {
    const provider = new SonioxSpeechToText({ provider: "soniox", uuid: "call", webSocketUrl: "wss://example.test", apiKey: "key", silenceThreshold: 500 });
    provider.endRecognition();
    expect(mockSockets[0].terminate).toHaveBeenCalled();
  });
});
