import { aborted, required } from "../../speech/common";
import { SpeechSocket } from "../../speech/socket";
import { AbstractSpeechSynthesis } from "../base";
import { SpeechSynthesisProvider } from "../types";
import type { SpeechSynthesisOptions } from "../types";

const DEFAULT_VOICE_SETTINGS = {
  speed: 1,
  volume: 1
} as const;

function clampVoiceSetting(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeVoiceSettings(
  settings: SpeechSynthesisOptions["settings"]
): { speed: number; volume: number } {
  return {
    // These are the same bounds and defaults used by the legacy Cartesia
    // manager. Cartesia rejects values outside these ranges.
    speed: clampVoiceSetting(
      settings?.speed,
      0.6,
      1.5,
      DEFAULT_VOICE_SETTINGS.speed
    ),
    volume: clampVoiceSetting(
      settings?.volume,
      0.5,
      2,
      DEFAULT_VOICE_SETTINGS.volume
    )
  };
}

interface CartesiaMessage {
  type?: string;
  error?: unknown;
  data?: string;
  done?: boolean;
}

/** Cartesia Speech Synthesis provider implementation. */
export class CartesiaSpeechSynthesis extends AbstractSpeechSynthesis {
  readonly provider = SpeechSynthesisProvider.Cartesia;

  constructor(options: SpeechSynthesisOptions) {
    super({
      ...options,
      settings: normalizeVoiceSettings(options.settings)
    });
  }

  protected generate(text: string, signal: AbortSignal): AsyncIterable<Buffer> {
    return this.generateCartesiaSpeech(text, signal);
  }

  private async *generateCartesiaSpeech(
    text: string,
    signal: AbortSignal
  ): AsyncGenerator<Buffer> {
    const apiKey = required(this.options.apiKey, "cartesia apiKey");
    const url = new URL(
      this.options.endpoint ?? "wss://api.cartesia.ai/tts/websocket"
    );
    url.searchParams.set("cartesia_version", "2025-04-16");
    url.searchParams.set("api_key", apiKey);

    const settings = this.options.settings ?? DEFAULT_VOICE_SETTINGS;
    const socket = new SpeechSocket(
      url.toString(),
      {},
      signal,
      this.options.timeoutMs,
      this.options.maxBufferBytes
    );

    try {
      await socket.ready;
      await socket.send(
        JSON.stringify({
          language: this.options.languageCode?.split("-")[0] || "fr",
          // The legacy manager used its per-call UUID as context_id. callId is
          // the corresponding stable session identifier in the typed API.
          context_id: this.options.callId,
          model_id: this.options.modelId ?? "sonic-3-latest",
          transcript: text,
          // The typed API owns one complete segment per stream, so every
          // request is final. Continuation is managed by the caller between
          // sequential synthesize calls.
          continue: false,
          voice: {
            mode: "id",
            id: this.options.voice
          },
          generation_config: {
            speed: settings.speed,
            volume: settings.volume
          },
          output_format: {
            container: "raw",
            sample_rate: 8000,
            encoding: "pcm_s16le"
          }
        })
      );

      for await (const message of socket.messages) {
        if (signal.aborted) {
          throw aborted();
        }

        if (message.binary) {
          throw new Error("Unexpected binary Cartesia TTS response");
        }

        const data = JSON.parse(message.data) as CartesiaMessage;

        if (data.error || data.type === "error") {
          throw new Error("Cartesia synthesis failed");
        }

        if (data.type === "chunk") {
          if (typeof data.data !== "string") {
            throw new Error("Cartesia chunk is missing audio data");
          }

          yield Buffer.from(data.data, "base64");
        }

        // The legacy implementation waited for both the done message type
        // and its affirmative flag before completing the generation.
        if (data.type === "done" && data.done === true) {
          return;
        }
      }

      throw new Error("Cartesia closed before synthesis completed");
    } finally {
      socket.close();
    }
  }
}
