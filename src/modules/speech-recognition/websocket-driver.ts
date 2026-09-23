import { SpeechSocket } from "../speech/socket";
import { aborted, asError, required } from "../speech/common";
import { AbstractSpeechRecognition } from "./base";
import type { RecognitionDriver, SpeechRecognitionOptions } from "./types";
import { SpeechRecognitionProvider } from "./types";

interface RecognitionMessage {
  type?: string;
  message_type?: string;
  error?: unknown;
  error_code?: unknown;
  text?: string;
  transcript?: string;
  is_final?: boolean;
  end_of_turn?: boolean;
  turn_order?: number;
  tokens?: { text?: string; is_final?: boolean; end_ms?: number }[];
  data?: { is_final?: boolean; utterance?: { text?: string } };
}

export type WebSocketRecognitionProvider =
  | SpeechRecognitionProvider.Callem
  | SpeechRecognitionProvider.Kroko
  | SpeechRecognitionProvider.Soniox
  | SpeechRecognitionProvider.Gladia
  | SpeechRecognitionProvider.AssemblyAI;

function withQuery(base: string, params: Record<string, string>): string {
  const url = new URL(base);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

class WebRecognitionDriver implements RecognitionDriver {
  private socket?: SpeechSocket;
  private carry: Buffer = Buffer.alloc(0);
  private stopped = false;

  constructor(
    private readonly provider: WebSocketRecognitionProvider,
    private readonly options: SpeechRecognitionOptions
  ) {}

  async start(
    signal: AbortSignal,
    emit: (text: string, final: boolean, cumulative?: boolean) => void,
    fail: (error: Error) => void
  ): Promise<void> {
    const lang = this.options.languageCode ?? "fr-FR";
    let url = this.options.endpoint ?? "";
    let headers: Record<string, string> = {};
    let setup: unknown;

    if (this.provider === "soniox") {
      url ||= "wss://stt-rt.soniox.com/transcribe-websocket";
      setup = {
        api_key: required(this.options.apiKey, "SONIOX_API_KEY"),
        audio_format: "pcm_s16le",
        sample_rate: 8000,
        num_channels: 1,
        model: this.options.modelId ?? "stt-rt-v4",
        language_hints: [lang.split("-")[0]],
        enable_non_final_tokens: true,
        enable_endpoint_detection: false,
        max_non_final_tokens_duration_ms: Math.min(
          Math.max((this.options.silenceThreshold ?? 800) - 50, 360),
          6000
        )
      };
    } else if (this.provider === "assemblyai") {
      headers = {
        Authorization: required(this.options.apiKey, "ASSEMBLYAI_API_KEY")
      };
      url = withQuery(url || "wss://streaming.assemblyai.com/v3/ws", {
        sample_rate: "8000",
        encoding: "pcm_s16le",
        speech_model:
          this.options.modelId ?? "universal-streaming-multilingual",
        language_detection: "true"
      });
    } else if (this.provider === "kroko") {
      url = withQuery(
        url || "wss://app.kroko.ai/api/v1/transcripts/streaming",
        {
          apiKey: required(this.options.apiKey, "KROKO_CLOUD_API_KEY"),
          languageCode: lang,
          endpoints: "false"
        }
      );
      setup = {
        type: "start",
        encoding: "FLOAT32",
        sampleRate: 16000,
        languageCode: lang,
        channels: 1
      };
    } else if (this.provider === "callem") {
      url ||= "ws://localhost:8000";
      setup = {
        type: "start",
        chunk_ms: 320
      };
    } else {
      const response = await fetch(url || "https://api.gladia.io/v2/live", {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          "X-Gladia-Key": required(this.options.apiKey, "GLADIA_API_KEY")
        },
        body: JSON.stringify({
          encoding: "wav/pcm",
          bit_depth: 16,
          sample_rate: 8000,
          channels: 1,
          model: this.options.modelId ?? "solaria-1",
          endpointing: 10,
          maximum_duration_without_endpointing: 60,
          language_config: {
            languages: [lang.split("-")[0]],
            code_switching: false
          },
          messages_config: {
            receive_partial_transcripts: true,
            receive_final_transcripts: true,
            receive_speech_events: false,
            receive_pre_processing_events: false,
            receive_realtime_processing_events: false,
            receive_post_processing_events: false,
            receive_acknowledgments: false,
            receive_errors: true,
            receive_lifecycle_events: false
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Gladia session HTTP ${response.status}`);
      }

      const body = (await response.json()) as { url?: string };
      url = required(body.url, "Gladia session URL");
    }

    if (signal.aborted) {
      throw aborted();
    }

    const socket = (this.socket = new SpeechSocket(
      url,
      headers,
      signal,
      this.options.timeoutMs,
      this.options.maxBufferBytes
    ));
    await socket.ready;

    if (setup) {
      await socket.send(JSON.stringify(setup));
    }

    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const readiness = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    if (this.provider !== "callem" && this.provider !== "kroko") {
      readyResolve();
    }

    void (async () => {
      let finalTokens = "";
      let lastTurn = -1;
      let lastSonioxFinalEndMs = -1;
      let lastSonioxPartialEndMs = -1;

      for await (const message of socket.messages) {
        if (signal.aborted) {
          return;
        }

        if (message.binary) {
          throw new Error("Unexpected binary STT response");
        }

        // Provider payload is validated at the protocol boundary before emission.
        const data = JSON.parse(message.data) as RecognitionMessage;

        if (
          data.error ||
          data.error_code ||
          /error|quota_exceeded/.test(String(data.message_type ?? data.type))
        ) {
          throw new Error(`${this.provider} recognition error`);
        }

        if (data.type === "ready" || data.type === "connected") {
          readyResolve();
          continue;
        }

        if (this.provider === "soniox") {
          let partial = "";

          for (const token of data.tokens ?? []) {
            if (typeof token.text !== "string" || token.text.startsWith("<")) {
              continue;
            }

            // Soniox repeats the complete token window in later messages.
            // Use the legacy end_ms cursor to avoid appending those tokens
            // more than once.
            if (token.is_final) {
              if (
                typeof token.end_ms === "number" &&
                token.end_ms <= lastSonioxFinalEndMs
              ) {
                continue;
              }

              finalTokens += token.text;
              if (typeof token.end_ms === "number") {
                lastSonioxFinalEndMs = Math.max(
                  lastSonioxFinalEndMs,
                  token.end_ms
                );
              }
            } else {
              if (
                typeof token.end_ms === "number" &&
                token.end_ms <=
                  Math.max(lastSonioxFinalEndMs, lastSonioxPartialEndMs)
              ) {
                continue;
              }

              partial += token.text;
              if (typeof token.end_ms === "number") {
                lastSonioxPartialEndMs = Math.max(
                  lastSonioxPartialEndMs,
                  token.end_ms
                );
              }
            }
          }

          emit(finalTokens + partial, !partial, true);
        } else if (this.provider === "assemblyai" && data.type === "Turn") {
          if (
            typeof data.transcript === "string" &&
            (data.turn_order ?? 0) > lastTurn
          ) {
            emit(data.transcript, !!data.end_of_turn);

            if (data.end_of_turn) {
              lastTurn = data.turn_order ?? 0;
            }
          }
        } else if (this.provider === "gladia" && data.type === "transcript") {
          if (typeof data.data?.utterance?.text === "string") {
            emit(data.data!.utterance!.text!, !!data.data!.is_final);
          }
        } else if (
          (this.provider === "callem" || this.provider === "kroko") &&
          typeof data.text === "string"
        ) {
          emit(
            data.text,
            this.provider === "callem" ? !!data.is_final : data.type === "final"
          );
        }
      }
    })().catch((error) => {
      readyReject(asError(error));

      if (!signal.aborted && !this.stopped) {
        fail(asError(error));
      }
    });
    const abortReady = () => readyReject(aborted());
    signal.addEventListener("abort", abortReady, { once: true });

    if (signal.aborted) {
      abortReady();
    }

    try {
      await readiness;
    } finally {
      signal.removeEventListener("abort", abortReady);
    }
  }

  async send(audio: Buffer): Promise<void> {
    const socket = this.socket!;

    if (
      this.provider === "assemblyai" ||
      this.provider === "callem" ||
      this.provider === "kroko"
    ) {
      this.carry = Buffer.concat([this.carry, audio]);
      const size =
        this.provider === "assemblyai"
          ? 1280
          : this.provider === "callem"
            ? 320
            : 160;

      while (this.carry.length >= size) {
        const frame = this.carry.subarray(0, size);
        this.carry = this.carry.subarray(size);

        if (this.provider === "assemblyai") {
          await socket.send(frame);
        } else {
          const output = Buffer.alloc(
            frame.length * (this.provider === "kroko" ? 4 : 2)
          );

          for (let i = 0; i < frame.length / 2; i++) {
            const sample = frame.readInt16LE(i * 2);

            if (this.provider === "kroko") {
              const current = sample / 32768;
              const next =
                i + 1 < frame.length / 2
                  ? frame.readInt16LE(i * 2 + 2) / 32768
                  : current;
              output.writeFloatLE(current, i * 8);
              output.writeFloatLE((current + next) / 2, i * 8 + 4);
            } else {
              output.writeInt16LE(sample, i * 4);
              output.writeInt16LE(sample, i * 4 + 2);
            }
          }

          await socket.send(output);
        }
      }
    } else {
      await socket.send(audio);
    }
  }

  async close(): Promise<void> {
    this.stopped = true;

    // The legacy adapters padded a final partial frame before closing.
    if (
      this.carry.length &&
      (this.provider === "kroko" || this.provider === "callem") &&
      this.socket
    ) {
      const size = this.provider === "kroko" ? 160 : 320;
      const padded = Buffer.alloc(size);
      this.carry.copy(padded);
      this.carry = Buffer.alloc(0);

      try {
        await this.send(padded);
      } catch {
        // Cancellation/hangup must not be masked by a best-effort flush.
      }
    }

    this.carry = Buffer.alloc(0);
    this.socket?.close();
  }
}

export function createWebSocketRecognitionDriver(
  provider: WebSocketRecognitionProvider,
  options: SpeechRecognitionOptions
): RecognitionDriver {
  return new WebRecognitionDriver(provider, options);
}
