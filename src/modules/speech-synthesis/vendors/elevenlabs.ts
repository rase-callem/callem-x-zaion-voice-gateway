import { AbstractSpeechSynthesis } from "../base";
import { SpeechSocket } from "../../speech/socket";
import { aborted, required } from "../../speech/common";
import { SpeechSynthesisProvider } from "../types";
import type { SpeechSynthesisOptions } from "../types";

const DEFAULT_VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.5,
  style: 0,
  use_speaker_boost: false,
  speed: 1
};

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
): NonNullable<SpeechSynthesisOptions["settings"]> {
  return {
    stability: clampVoiceSetting(
      settings?.stability,
      0,
      1,
      DEFAULT_VOICE_SETTINGS.stability
    ),
    similarity_boost: clampVoiceSetting(
      settings?.similarity_boost,
      0,
      1,
      DEFAULT_VOICE_SETTINGS.similarity_boost
    ),
    style: clampVoiceSetting(
      settings?.style,
      0,
      1,
      DEFAULT_VOICE_SETTINGS.style
    ),
    use_speaker_boost:
      typeof settings?.use_speaker_boost === "boolean"
        ? settings.use_speaker_boost
        : DEFAULT_VOICE_SETTINGS.use_speaker_boost,
    speed: clampVoiceSetting(
      settings?.speed,
      0.25,
      4,
      DEFAULT_VOICE_SETTINGS.speed
    )
  };
}

/** ElevenLabs Speech Synthesis provider implementation. */
export class ElevenLabsSpeechSynthesis extends AbstractSpeechSynthesis {
  readonly provider = SpeechSynthesisProvider.ElevenLabs;

  constructor(options: SpeechSynthesisOptions) {
    super({
      ...options,
      settings: normalizeVoiceSettings(options.settings)
    });
  }

  protected generate(text: string, signal: AbortSignal): AsyncIterable<Buffer> {
    return this.generateSpeech(text, signal);
  }

  private async *generateSpeech(
    text: string,
    signal: AbortSignal
  ): AsyncGenerator<Buffer> {
    const apiKey = required(this.options.apiKey, "ELEVENLABS_API_KEY");
    const url = new URL(
      this.options.endpoint ??
        `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.options.voice)}/stream-input`
    );
    url.searchParams.set(
      "model_id",
      this.options.modelId ?? "eleven_turbo_v2_5"
    );
    url.searchParams.set("output_format", "pcm_8000");
    url.searchParams.set("auto_mode", "true");
    url.searchParams.set("apply_text_normalization", "auto");
    url.searchParams.set(
      "inactivity_timeout",
      String(this.options.inactivityTimeoutSeconds ?? 6)
    );

    const socket = new SpeechSocket(
      url.toString(),
      { "xi-api-key": apiKey },
      signal,
      this.options.timeoutMs,
      this.options.maxBufferBytes
    );

    try {
      await socket.ready;
      await socket.send(
        JSON.stringify({
          text: " ",
          voice_settings: this.options.settings
        })
      );
      await socket.send(JSON.stringify({ text, flush: true }));
      await socket.send(
        JSON.stringify({
          text: "",
          try_trigger_generation: true
        })
      );

      for await (const message of socket.messages) {
        if (signal.aborted) {
          throw aborted();
        }

        if (message.binary) {
          throw new Error("Unexpected binary ElevenLabs TTS response");
        }

        const data = JSON.parse(message.data) as {
          audio?: string;
          error?: unknown;
          isFinal?: boolean;
        };

        if (data.error) {
          throw new Error("ElevenLabs synthesis failed");
        }

        if (data.audio) {
          yield Buffer.from(data.audio, "base64");
        }

        if (data.isFinal) {
          return;
        }
      }

      throw new Error("ElevenLabs closed before synthesis completed");
    } finally {
      socket.close();
    }
  }
}
