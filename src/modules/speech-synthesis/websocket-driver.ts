import { randomUUID } from "crypto";
import { SpeechSocket } from "../speech/socket";
import { required } from "../speech/common";
import { SpeechSynthesisProvider } from "./types";
import type { SpeechSynthesisOptions } from "./types";

export type WebSocketSpeechSynthesisProvider =
  SpeechSynthesisProvider.Gradium | SpeechSynthesisProvider.Cartesia;

function decodeMuLaw(input: Buffer): Buffer {
  const output = Buffer.alloc(input.length * 2);

  for (let i = 0; i < input.length; i++) {
    const value = ~input[i] & 255;
    const magnitude = (((value & 15) << 3) + 132) << ((value >> 4) & 7);
    output.writeInt16LE(value & 128 ? 132 - magnitude : magnitude - 132, i * 2);
  }

  return output;
}

export async function* generateWebSocketSpeech(
  provider: WebSocketSpeechSynthesisProvider,
  text: string,
  signal: AbortSignal,
  options: SpeechSynthesisOptions
): AsyncGenerator<Buffer> {
  const key = required(options.apiKey, `${provider} apiKey`);
  let url: URL;
  let headers: Record<string, string>;

  if (provider === "cartesia") {
    url = new URL(options.endpoint ?? "wss://api.cartesia.ai/tts/websocket");
    url.searchParams.set("cartesia_version", "2025-04-16");
    url.searchParams.set("api_key", key);
    headers = {};
  } else {
    url = new URL(options.endpoint ?? "wss://eu.api.gradium.ai/api/speech/tts");
    headers = { "x-api-key": key };
  }

  const socket = new SpeechSocket(
    url.toString(),
    headers,
    signal,
    options.timeoutMs,
    options.maxBufferBytes
  );

  try {
    await socket.ready;

    if (provider === "cartesia") {
      await socket.send(
        JSON.stringify({
          context_id: randomUUID(),
          model_id: options.modelId ?? "sonic-3-latest",
          transcript: text,
          continue: false,
          language: options.languageCode?.split("-")[0] ?? "fr",
          voice: {
            mode: "id",
            id: options.voice
          },
          generation_config: {
            speed: options.settings?.speed,
            volume: options.settings?.volume
          },
          output_format: {
            container: "raw",
            sample_rate: 8000,
            encoding: "pcm_s16le"
          }
        })
      );
    } else {
      await socket.send(
        JSON.stringify({
          type: "setup",
          model_name: options.modelId ?? "default",
          voice_id: options.voice,
          output_format: "ulaw_8000"
        })
      );
    }

    for await (const message of socket.messages) {
      if (message.binary) {
        if (provider !== "gradium") {
          throw new Error("Unexpected binary TTS response");
        }

        yield decodeMuLaw(message.data);
        continue;
      }

      const data = JSON.parse(message.data) as {
        type?: string;
        error?: unknown;
        audio?: string;
        data?: string;
        isFinal?: boolean;
        done?: boolean;
      };

      if (data.error || data.type === "error") {
        throw new Error(`${provider} synthesis failed`);
      }

      if (provider === "gradium" && data.type === "ready") {
        await socket.send(
          JSON.stringify({
            type: "text",
            text
          })
        );
        await socket.send(JSON.stringify({ type: "end_of_stream" }));
      }

      const encoded = provider === "cartesia" ? data.data : data.audio;

      if (typeof encoded === "string" && encoded.length) {
        const audio = Buffer.from(encoded, "base64");
        yield provider === "gradium" ? decodeMuLaw(audio) : audio;
      }

      if (
        (provider === "cartesia" && data.type === "done") ||
        (provider === "gradium" &&
          ["end_of_stream", "done"].includes(data.type ?? ""))
      ) {
        return;
      }
    }

    throw new Error(`${provider} closed before synthesis completed`);
  } finally {
    socket.close();
  }
}
