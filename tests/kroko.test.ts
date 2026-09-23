import { once } from "events";
import { AddressInfo } from "net";
import { WebSocketServer } from "ws";
import {
  createSpeechRecognition,
  SpeechRecognition
} from "../src/modules/speech-recognition";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error("Condition not reached");
}

describe("Kroko speech recognition", () => {
  let server: WebSocketServer;
  let recognition: SpeechRecognition | undefined;

  beforeEach(async () => {
    server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");
  });

  afterEach(async () => {
    await recognition?.endRecognition();
    recognition = undefined;

    for (const client of server.clients) {
      client.terminate();
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("sends the legacy start handshake and interpolated Float32 packets", async () => {
    const starts: Record<string, unknown>[] = [];
    const packets: Buffer[] = [];

    server.on("connection", (socket, request) => {
      expect(request.url).toContain("apiKey=test-key");
      expect(request.url).toContain("languageCode=fr-FR");
      expect(request.url).toContain("endpoints=false");

      socket.on("message", (data, binary) => {
        if (binary) {
          packets.push(Buffer.from(data as Buffer));
          return;
        }

        starts.push(JSON.parse(data.toString()) as Record<string, unknown>);
        socket.send(JSON.stringify({ type: "connected" }));
      });
    });

    recognition = createSpeechRecognition({
      provider: "kroko",
      endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
      apiKey: "test-key",
      callId: "call",
      onTranscription: jest.fn(),
      onError: jest.fn()
    });

    await recognition.startRecognition();
    expect(starts).toEqual([
      {
        type: "start",
        encoding: "FLOAT32",
        sampleRate: 16000,
        languageCode: "fr-FR",
        channels: 1
      }
    ]);

    const input = Buffer.alloc(160);
    input.writeInt16LE(0, 0);
    input.writeInt16LE(1000, 2);
    input.writeInt16LE(2000, 4);
    for (let offset = 6; offset < input.length; offset += 2) {
      input.writeInt16LE(2000, offset);
    }
    await recognition.sendData(input);
    await until(() => packets.length === 1);

    expect(packets[0]).toHaveLength(640);
    expect(packets[0].readFloatLE(0)).toBeCloseTo(0);
    expect(packets[0].readFloatLE(4)).toBeCloseTo(500 / 32768);
    expect(packets[0].readFloatLE(8)).toBeCloseTo(1000 / 32768);
    expect(packets[0].readFloatLE(12)).toBeCloseTo(1500 / 32768);
  });

  test("accumulates and normalizes partial and final transcripts", async () => {
    const results: { transcription: string; isFinal: boolean }[] = [];

    server.on("connection", (socket) => {
      socket.on("message", (data, binary) => {
        if (!binary) {
          socket.send(JSON.stringify({ type: "connected" }));
        }
      });
    });

    recognition = createSpeechRecognition({
      provider: "kroko",
      endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
      apiKey: "test-key",
      callId: "call",
      onTranscription: (result) =>
        results.push({
          transcription: result.transcription,
          isFinal: result.isFinal
        }),
      onError: jest.fn()
    });

    await recognition.startRecognition();
    const peer = [...server.clients][0];
    peer.send(JSON.stringify({ type: "partial", text: " Bonjour   à " }));
    peer.send(JSON.stringify({ type: "final", text: "Bonjour à tous" }));
    peer.send(JSON.stringify({ type: "final", text: "la suite" }));

    await until(() => results.length === 3);
    expect(results).toEqual([
      { transcription: "bonjour à", isFinal: false },
      { transcription: "bonjour à tous", isFinal: true },
      { transcription: "bonjour à tous la suite", isFinal: true }
    ]);
  });

  test("does not reopen after cancellation while waiting for connected", async () => {
    recognition = createSpeechRecognition({
      provider: "kroko",
      endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
      apiKey: "test-key",
      callId: "call",
      onTranscription: jest.fn(),
      onError: jest.fn()
    });

    const starting = recognition.startRecognition();
    const rejection = expect(starting).rejects.toThrow();
    await tick();
    await recognition.endRecognition();
    await rejection;
    expect(recognition.state).toBe("closed");
  });
});
