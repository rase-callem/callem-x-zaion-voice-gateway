import { once } from "events";
import { AddressInfo } from "net";
import { WebSocketServer, WebSocket } from "ws";
import {
  createSpeechRecognition,
  SpeechRecognition
} from "../src/modules/speech-recognition";
import {
  createSpeechSynthesis,
  SpeechSynthesis,
  PcmWaveDecoder
} from "../src/modules/speech-synthesis";
import { SpeechQueue } from "../src/modules/speech/common";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error("Condition not reached");
}

async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return chunks;
}

let server: WebSocketServer;

let endpoint: string;

let recognition: SpeechRecognition | undefined;

let synthesis: SpeechSynthesis | undefined;

beforeEach(async () => {
  server = new WebSocketServer({
    port: 0,
    host: "127.0.0.1"
  });
  await once(server, "listening");
  endpoint = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await recognition?.endRecognition();
  await synthesis?.close();
  recognition = undefined;
  synthesis = undefined;

  for (const client of server.clients) {
    client.terminate();
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test.each([
  "Azure",
  "Google",
  "Callem",
  "Kroko",
  "Soniox",
  "Gladia",
  "ElevenLabs",
  "AssemblyAI"
])("STT factory selects %s without connecting", (provider) => {
  recognition = createSpeechRecognition({
    provider,
    callId: "call",
    onTranscription: jest.fn(),
    onError: jest.fn()
  });
  expect(recognition.provider).toBe(provider.toLowerCase());
  expect(recognition.state).toBe("idle");
});

test.each(["Azure", "Voxygen", "ElevenLabs", "Gradium", "Cartesia"])(
  "TTS factory selects %s without connecting",
  (provider) => {
    synthesis = createSpeechSynthesis({
      provider,
      voice: "voice",
      callId: "call"
    });
    expect(synthesis.provider).toBe(provider.toLowerCase());
  }
);

test("factories reject unknown providers", () => {
  expect(() =>
    createSpeechSynthesis({
      provider: "unknown",
      voice: "voice",
      callId: "call"
    })
  ).toThrow("Unsupported");
  expect(() =>
    createSpeechRecognition({
      provider: "unknown",
      callId: "call",
      onTranscription: jest.fn(),
      onError: jest.fn()
    })
  ).toThrow("Unsupported");
});

test("AssemblyAI buffers 20ms frames, accumulates turns and keeps identical final notifications", async () => {
  let peer!: WebSocket;
  const audio: Buffer[] = [];
  const results: unknown[] = [];
  server.on("connection", (ws) => {
    peer = ws;
    ws.on("message", (data, binary) => {
      if (binary) {
        audio.push(Buffer.from(data as Buffer));
      }
    });
  });
  recognition = createSpeechRecognition({
    provider: "assemblyai",
    endpoint,
    apiKey: "test",
    callId: "call",
    onTranscription: (result) => results.push(result),
    onError: jest.fn()
  });
  await recognition.startRecognition();

  for (let i = 0; i < 4; i++) {
    await recognition.sendData(Buffer.alloc(320, i));
  }

  await until(() => audio.length === 1);
  expect(audio[0]).toHaveLength(1280);
  peer.send(
    JSON.stringify({
      type: "Turn",
      transcript: "Bonjour",
      turn_order: 0,
      end_of_turn: false
    })
  );
  peer.send(
    JSON.stringify({
      type: "Turn",
      transcript: "Bonjour",
      turn_order: 0,
      end_of_turn: true
    })
  );
  peer.send(
    JSON.stringify({
      type: "Turn",
      transcript: "Bonjour",
      turn_order: 0,
      end_of_turn: true
    })
  );
  peer.send(
    JSON.stringify({
      type: "Turn",
      transcript: "à tous",
      turn_order: 1,
      end_of_turn: false
    })
  );
  await until(() => results.length === 3);
  expect(results).toEqual([
    expect.objectContaining({
      transcription: "Bonjour",
      isFinal: false
    }),
    expect.objectContaining({
      transcription: "Bonjour",
      isFinal: true
    }),
    expect.objectContaining({
      transcription: "Bonjour à tous",
      isFinal: false
    })
  ]);
});

test("AssemblyAI flushes the final audio buffer and sends Terminate on hangup", async () => {
  const messages: Array<Buffer | string> = [];
  server.on("connection", (ws) =>
    ws.on("message", (data, binary) => {
      messages.push(binary ? Buffer.from(data as Buffer) : data.toString());
    })
  );

  recognition = createSpeechRecognition({
    provider: "assemblyai",
    endpoint,
    apiKey: "test",
    callId: "call",
    onTranscription: jest.fn(),
    onError: jest.fn()
  });
  await recognition.startRecognition();
  await recognition.sendData(Buffer.alloc(320, 7));
  await recognition.endRecognition();

  await until(() => messages.length === 2);
  expect(messages[0]).toEqual(Buffer.alloc(320, 7));
  expect(JSON.parse(messages[1] as string)).toEqual({ type: "Terminate" });
});

test("STT malformed provider messages fail once and release the connection", async () => {
  let peer!: WebSocket;
  const onError = jest.fn();
  server.on("connection", (ws) => {
    peer = ws;
  });
  recognition = createSpeechRecognition({
    provider: "soniox",
    endpoint,
    apiKey: "test",
    callId: "call",
    onTranscription: jest.fn(),
    onError
  });
  await recognition.startRecognition();
  peer.send("not JSON");
  await until(() => recognition!.state === "failed");
  expect(onError).toHaveBeenCalledTimes(1);
  await expect(recognition.sendData(Buffer.alloc(320))).rejects.toThrow(
    "not listening"
  );
});

test("STT startup waiting for readiness can be canceled and cannot reopen after hangup", async () => {
  recognition = createSpeechRecognition({
    provider: "kroko",
    endpoint,
    apiKey: "test",
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
  await expect(recognition.startRecognition()).rejects.toThrow("closed");
});

test("Callem waits for ready, resamples PCM, then switches to Soniox after two restarts", async () => {
  const starts: Record<string, unknown>[] = [];
  const audio: Buffer[] = [];
  server.on("connection", (ws) =>
    ws.on("message", (data, binary) => {
      if (binary) {
        audio.push(Buffer.from(data as Buffer));
      } else {
        const message = JSON.parse(data.toString());
        starts.push(message);

        if (message.type === "start") {
          ws.send(JSON.stringify({ type: "ready" }));
        }
      }
    })
  );
  recognition = createSpeechRecognition({
    provider: "callem",
    endpoint,
    sonioxEndpoint: endpoint,
    sonioxApiKey: "test",
    callId: "call",
    onTranscription: jest.fn(),
    onError: jest.fn()
  });
  await recognition.startRecognition();
  const input = Buffer.alloc(320);
  input.writeInt16LE(-1234);
  await recognition.sendData(input);
  await until(() => audio.length === 1);
  expect(audio[0].length).toBe(640);
  expect(audio[0].readInt16LE(0)).toBe(-1234);
  expect(audio[0].readInt16LE(2)).toBe(-1234);
  await recognition.restartRecognition();
  await recognition.restartRecognition();
  await until(() => starts.length === 3);
  expect(starts[2]).toMatchObject({
    model: "stt-rt-v4",
    sample_rate: 8000
  });
});

test.each(["elevenlabs", "cartesia", "gradium"])(
  "%s streams audio and handles completion immediately followed by close",
  async (provider) => {
    let sent = false;
    server.on("connection", (ws) =>
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString());

        if (provider === "gradium" && message.type === "setup") {
          ws.send(JSON.stringify({ type: "ready" }));

          return;
        }

        if (
          sent ||
          !(message.transcript || (message.text && message.text !== " "))
        ) {
          return;
        }

        sent = true;
        const audio =
          provider === "gradium"
            ? Buffer.alloc(173, 0xff)
            : Buffer.alloc(346, 2);

        if (provider === "cartesia") {
          ws.send(
            JSON.stringify({
              type: "chunk",
              data: audio.subarray(0, 101).toString("base64")
            })
          );
          ws.send(
            JSON.stringify({
              type: "chunk",
              data: audio.subarray(101).toString("base64")
            })
          );
          ws.send(
            JSON.stringify({
              type: "done",
              done: true
            })
          );
        } else {
          ws.send(
            JSON.stringify({
              type: "audio",
              audio: audio.subarray(0, 101).toString("base64")
            })
          );
          ws.send(
            JSON.stringify({
              type: "audio",
              audio: audio.subarray(101).toString("base64")
            })
          );
          ws.send(
            JSON.stringify(
              provider === "gradium"
                ? { type: "end_of_stream" }
                : { isFinal: true }
            )
          );
        }

        ws.close();
      })
    );
    synthesis = createSpeechSynthesis({
      provider,
      endpoint,
      apiKey: "test",
      voice: "voice",
      callId: "call"
    });
    const chunks = await collect(synthesis.synthesize("Bonjour"));
    expect(chunks.map((chunk) => chunk.length)).toEqual([320, 26]);
    expect(Buffer.concat(chunks)).toEqual(
      Buffer.alloc(346, provider === "gradium" ? 0 : 2)
    );
  }
);

test("Cartesia keeps the legacy request context and voice setting normalization", async () => {
  let request: Record<string, unknown> | undefined;
  server.on("connection", (ws) =>
    ws.on("message", (raw) => {
      request = JSON.parse(raw.toString());
      ws.send(
        JSON.stringify({
          type: "chunk",
          data: Buffer.alloc(320, 2).toString("base64")
        })
      );
      ws.send(JSON.stringify({ type: "done", done: true }));
    })
  );

  synthesis = createSpeechSynthesis({
    provider: "cartesia",
    endpoint,
    apiKey: "test",
    voice: "voice",
    callId: "call",
    languageCode: "fr-FR",
    settings: { speed: 2, volume: 0.1 }
  });

  await collect(synthesis.synthesize("Bonjour"));

  expect(request).toMatchObject({
    language: "fr",
    context_id: "call",
    model_id: "sonic-3-latest",
    transcript: "Bonjour",
    continue: false,
    voice: { mode: "id", id: "voice" },
    generation_config: { speed: 1.5, volume: 0.5 },
    output_format: {
      container: "raw",
      sample_rate: 8000,
      encoding: "pcm_s16le"
    }
  });
});

test("ElevenLabs keeps the streaming query options and final generation signal", async () => {
  let requestUrl = "";
  const messages: Record<string, unknown>[] = [];

  server.on("connection", (ws, request) => {
    requestUrl = request.url ?? "";
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      messages.push(message);

      if (message.flush === true) {
        ws.send(
          JSON.stringify({ audio: Buffer.alloc(320).toString("base64") })
        );
        ws.send(JSON.stringify({ isFinal: true }));
      }
    });
  });

  synthesis = createSpeechSynthesis({
    provider: "elevenlabs",
    endpoint,
    apiKey: "test",
    voice: "voice",
    callId: "call"
  });

  await collect(synthesis.synthesize("Bonjour"));

  const query = new URL(requestUrl, "ws://localhost").searchParams;
  expect(query.get("auto_mode")).toBe("true");
  expect(query.get("apply_text_normalization")).toBe("auto");
  expect(query.get("inactivity_timeout")).toBe("6");
  expect(query.get("model_id")).toBe("eleven_turbo_v2_5");
  expect(messages.at(-1)).toEqual({
    text: "",
    try_trigger_generation: true
  });
});

test("TTS interruption stops buffered frames and rejects outstanding reads", async () => {
  server.on("connection", (ws) =>
    ws.on("message", (raw) => {
      if (JSON.parse(raw.toString()).transcript) {
        ws.send(
          JSON.stringify({
            type: "chunk",
            data: Buffer.alloc(960).toString("base64")
          })
        );
      }
    })
  );
  synthesis = createSpeechSynthesis({
    provider: "cartesia",
    endpoint,
    apiKey: "test",
    voice: "voice",
    callId: "call"
  });
  const stream = synthesis.synthesize("Bonjour")[Symbol.asyncIterator]();
  expect((await stream.next()).value).toHaveLength(320);
  synthesis.cancel();
  await expect(stream.next()).rejects.toThrow("aborted");
});

test("TTS detects a half-closed provider stream", async () => {
  server.on("connection", (ws) => ws.on("message", () => ws.close()));
  synthesis = createSpeechSynthesis({
    provider: "cartesia",
    endpoint,
    apiKey: "test",
    voice: "voice",
    callId: "call"
  });
  await expect(collect(synthesis.synthesize("Bonjour"))).rejects.toThrow(
    "closed"
  );
});

test("TTS timeout closes a stalled provider", async () => {
  synthesis = createSpeechSynthesis({
    provider: "cartesia",
    endpoint,
    apiKey: "test",
    voice: "voice",
    callId: "call",
    timeoutMs: 30
  });
  await expect(collect(synthesis.synthesize("Bonjour"))).rejects.toThrow(
    "aborted"
  );
});

test("bounded queue fails immediately on a slow consumer", async () => {
  const queue = new SpeechQueue<Buffer>(8);
  queue.push(Buffer.alloc(8), 8);
  expect(() => queue.push(Buffer.alloc(1), 1)).toThrow("limit");
  await expect(queue[Symbol.asyncIterator]().next()).rejects.toThrow("limit");
});

test("WAV decoder handles arbitrary chunk boundaries, metadata and truncated streams", () => {
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(4, 40);
  const junk = Buffer.from([74, 85, 78, 75, 1, 0, 0, 0, 42, 0]);
  const wave = Buffer.concat([
    header.subarray(0, 36),
    junk,
    header.subarray(36),
    Buffer.from([1, 2, 3, 4])
  ]);
  const decoder = new PcmWaveDecoder();
  const output: Buffer[] = [];

  for (const byte of wave) {
    output.push(decoder.push(Buffer.from([byte])));
  }

  decoder.finish();
  expect(Buffer.concat(output)).toEqual(Buffer.from([1, 2, 3, 4]));
  const truncated = new PcmWaveDecoder();
  truncated.push(header);
  expect(() => truncated.finish()).toThrow("Truncated");
});

test("Gladia initializes HTTP session and delivers partial/final transcripts", async () => {
  let peer!: WebSocket;
  server.on("connection", (ws) => {
    peer = ws;
  });
  const fetchMock = jest
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify({ url: endpoint }), { status: 200 })
    );
  const onTranscription = jest.fn();

  try {
    recognition = createSpeechRecognition({
      provider: "gladia",
      apiKey: "test",
      callId: "call",
      language: { code: "en-US" },
      onTranscription,
      onError: jest.fn()
    });
    await recognition.startRecognition();
    expect(
      JSON.parse(fetchMock.mock.calls[0][1]!.body as string).language_config
        .languages
    ).toEqual(["en"]);
    peer.send(
      JSON.stringify({
        type: "transcript",
        data: {
          is_final: false,
          utterance: { text: "Hello" }
        }
      })
    );
    peer.send(
      JSON.stringify({
        type: "transcript",
        data: {
          is_final: true,
          utterance: { text: "Hello" }
        }
      })
    );
    await until(() => onTranscription.mock.calls.length === 2);
    expect(onTranscription).toHaveBeenLastCalledWith(
      expect.objectContaining({
        transcription: "Hello",
        isFinal: true
      })
    );
  } finally {
    fetchMock.mockRestore();
  }
});

test("ElevenLabs encodes raw PCM and accumulates committed transcripts", async () => {
  let peer!: WebSocket;
  const inputs: Record<string, unknown>[] = [];
  const onTranscription = jest.fn();
  server.on("connection", (ws) => {
    peer = ws;
    ws.on("message", (data) => inputs.push(JSON.parse(data.toString())));
  });
  recognition = createSpeechRecognition({
    provider: "elevenlabs",
    endpoint,
    apiKey: "test",
    callId: "call",
    onTranscription,
    onError: jest.fn()
  });
  await recognition.startRecognition();
  const pcm = Buffer.from([1, 2, 3, 4]);
  await recognition.sendData(pcm);
  await until(() => inputs.length === 1);
  expect(inputs[0]).toMatchObject({
    audio_base_64: pcm.toString("base64"),
    sample_rate: 8000
  });
  peer.send(
    JSON.stringify({
      message_type: "committed_transcript",
      text: "Hello"
    })
  );
  peer.send(
    JSON.stringify({
      message_type: "partial_transcript",
      text: "world"
    })
  );
  await until(() => onTranscription.mock.calls.length === 2);
  expect(onTranscription).toHaveBeenLastCalledWith(
    expect.objectContaining({
      transcription: "Hello world",
      isFinal: false
    })
  );

  peer.send(
    JSON.stringify({
      message_type: "committed_transcript_with_timestamps",
      text: "again",
      words: []
    })
  );
  await until(() => onTranscription.mock.calls.length === 3);
  expect(onTranscription).toHaveBeenLastCalledWith(
    expect.objectContaining({
      transcription: "Hello again",
      isFinal: true
    })
  );
});

test("ElevenLabs STT preserves the include_timestamps query option", async () => {
  let requestUrl = "";
  const inputs: Record<string, unknown>[] = [];
  server.on("connection", (_ws, request) => {
    requestUrl = request.url ?? "";
    _ws.on("message", (data) => inputs.push(JSON.parse(data.toString())));
  });

  const lastAgentMessage = "A".repeat(60);
  recognition = createSpeechRecognition({
    provider: "elevenlabs",
    endpoint,
    apiKey: "test",
    audioFormat: "pcm_16000",
    commitStrategy: "manual",
    includeTimestamps: true,
    lastAgentMessage,
    callId: "call",
    onTranscription: jest.fn(),
    onError: jest.fn()
  });
  await recognition.startRecognition();

  const query = new URL(requestUrl, "ws://localhost").searchParams;
  expect(query.get("audio_format")).toBe("pcm_16000");
  expect(query.get("commit_strategy")).toBe("manual");
  expect(query.get("include_timestamps")).toBe("true");

  await recognition.sendData(Buffer.from([1, 2]));
  await until(() => inputs.length === 1);
  expect(inputs[0]).toMatchObject({
    sample_rate: 16000,
    previous_text: lastAgentMessage.slice(-50)
  });
});

test("ElevenLabs sends previous_text only once across turn restarts", async () => {
  const inputs: Record<string, unknown>[] = [];
  server.on("connection", (ws) =>
    ws.on("message", (data) => inputs.push(JSON.parse(data.toString())))
  );

  recognition = createSpeechRecognition({
    provider: "elevenlabs",
    endpoint,
    apiKey: "test",
    lastAgentMessage: "The previous agent turn",
    callId: "call",
    onTranscription: jest.fn(),
    onError: jest.fn()
  });
  await recognition.startRecognition();
  await recognition.sendData(Buffer.from([1, 2]));
  await until(() => inputs.length === 1);

  await recognition.restartRecognition();
  await recognition.sendData(Buffer.from([3, 4]));
  await until(() => inputs.length === 2);

  expect(inputs[0]).toHaveProperty("previous_text", "The previous agent turn");
  expect(inputs[1]).not.toHaveProperty("previous_text");
});
