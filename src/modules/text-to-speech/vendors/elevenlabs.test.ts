import { EventEmitter } from "node:events";
import { promises as fsp, type Stats } from "node:fs";

const mockSockets: MockSocket[] = [];
class MockSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = MockSocket.CONNECTING;
  send = jest.fn();
  close = jest.fn(() => { this.readyState = 3; this.emit("close"); });
  terminate = jest.fn(() => { this.readyState = 3; this.emit("close"); });
  constructor(readonly url: string, readonly options: unknown) { super(); mockSockets.push(this); }
  open(): void { this.readyState = MockSocket.OPEN; this.emit("open"); }
  message(value: unknown): void { this.emit("message", Buffer.from(JSON.stringify(value))); }
}
jest.mock("ws", () => ({ __esModule: true, default: MockSocket }));

import { ElevenLabsTextToSpeech } from "./elevenlabs";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const options = { provider: "elevenlabs", uuid: "call", apiKey: "key", voiceId: "voice", projectID: "project" };

describe("ElevenLabs TTS", () => {
  beforeEach(() => { mockSockets.length = 0; });
  afterEach(() => jest.restoreAllMocks());

  it("streams cached PCM with the legacy frame split", async () => {
    jest.spyOn(fsp, "access").mockResolvedValue(undefined);
    jest.spyOn(fsp, "stat").mockResolvedValue({ size: 650 } as Stats);
    jest.spyOn(fsp, "readFile").mockResolvedValue(Buffer.alloc(650, 3));
    const manager = new ElevenLabsTextToSpeech(options);
    const frames: Buffer[] = [];
    manager.setHandler((frame) => frames.push(frame));
    await manager.sendText({ text: "Bonjour", isFinal: true });
    expect(frames.map((frame) => frame.length)).toEqual([320, 320, 10]);
    expect(frames[0]).toEqual(Buffer.alloc(320, 3));
    expect(mockSockets).toHaveLength(0);
    await manager.disconnect();
  });

  it("splits mixed text and a static audio code in order", async () => {
    jest.spyOn(fsp, "access").mockResolvedValue(undefined);
    jest.spyOn(fsp, "stat").mockResolvedValue({ size: 320 } as Stats);
    const read = jest.spyOn(fsp, "readFile").mockImplementation(async (file) =>
      Buffer.alloc(320, String(file).includes("TTS-1") ? 2 : 1));
    const manager = new ElevenLabsTextToSpeech(options);
    const frames: Buffer[] = [];
    manager.setHandler((frame) => frames.push(frame));
    await manager.sendText({ text: "Hello [TTS-1]", isFinal: true });
    expect(frames.map((frame) => frame[0])).toEqual([1, 2]);
    expect(read.mock.calls[1][0]).toBe("/mnt/tts-cache/elevenlabs/project/TTS-1.pcm");
    await manager.disconnect();
  });

  it("generates over WebSocket, emits raw PCM, and saves the cache", async () => {
    jest.spyOn(fsp, "access").mockRejectedValue(new Error("ENOENT"));
    const mkdir = jest.spyOn(fsp, "mkdir").mockResolvedValue(undefined);
    const write = jest.spyOn(fsp, "writeFile").mockResolvedValue(undefined);
    const manager = new ElevenLabsTextToSpeech({ ...options, voiceSettings: { stability: 2, speed: 0.1 } });
    const frames: Buffer[] = [];
    manager.setHandler((frame) => frames.push(frame));
    const result = manager.sendText({ text: "Hello", isFinal: true });
    await tick();
    const ws = mockSockets[0];
    expect(ws.url).toContain("output_format=pcm_8000");
    ws.open();
    await tick();
    expect(JSON.parse(ws.send.mock.calls[0][0] as string)).toMatchObject({
      text: "Hello", flush: true, voice_settings: { stability: 1, speed: 0.25 }
    });
    ws.message({ audio: Buffer.alloc(650, 4).toString("base64"), isFinal: true });
    await result;
    await tick();
    expect(frames.map((frame) => frame.length)).toEqual([320, 320, 10]);
    expect(mkdir).toHaveBeenCalledWith("/mnt/tts-cache/elevenlabs", { recursive: true });
    expect(write.mock.calls[0][1]).toEqual(Buffer.alloc(650, 4));
    await manager.disconnect();
  });

  it("requeues a phrase after connection loss and rejects pending work on disconnect", async () => {
    jest.spyOn(fsp, "access").mockRejectedValue(new Error("ENOENT"));
    jest.spyOn(fsp, "mkdir").mockResolvedValue(undefined);
    jest.spyOn(fsp, "writeFile").mockResolvedValue(undefined);
    const manager = new ElevenLabsTextToSpeech(options);
    const result = manager.sendText({ text: "retry", isFinal: false });
    await tick();
    mockSockets[0].open();
    await tick();
    mockSockets[0].close();
    await tick();
    await tick();
    expect(mockSockets).toHaveLength(2);
    mockSockets[1].open();
    await tick();
    expect(JSON.parse(mockSockets[1].send.mock.calls[0][0] as string).text).toBe("retry");
    const rejected = expect(result).rejects.toThrow("disconnected");
    await manager.disconnect();
    await rejected;
  });

  it("terminates a connecting socket and rejects its connect promise on hangup", async () => {
    const manager = new ElevenLabsTextToSpeech(options);
    const connecting = manager.connect();
    const rejection = expect(connecting).rejects.toThrow("CONNECTION_CLOSED");
    await manager.disconnect();
    expect(mockSockets[0].terminate).toHaveBeenCalled();
    await rejection;
  });
});
