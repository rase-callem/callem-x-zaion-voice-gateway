import { SpeechSocket } from "../../speech/socket";
import { aborted, asError, required } from "../../speech/common";
import { AbstractSpeechRecognition } from "../base";
import { SpeechRecognitionProvider } from "../types";
import type {
  RecognitionDriver,
  SpeechRecognitionOptions
} from "../types";

const KROKO_URL = "wss://app.kroko.ai/api/v1/transcripts/streaming";
const DEFAULT_FRAMES_PER_PACKET_16K = 160;
const FLOAT32_BYTES = 4;

interface KrokoMessage {
  type?: string;
  error?: unknown;
  error_code?: unknown;
  message_type?: unknown;
  text?: string;
}

function withQuery(base: string, params: Record<string, string>): string {
  const url = new URL(base);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normaliseTranscript(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Kroko's typed gateway input is PCM16LE at 8 kHz; Kroko receives Float32 at 16 kHz. */
class KrokoRecognitionDriver implements RecognitionDriver {
  private socket?: SpeechSocket;
  private audioBytes = Buffer.alloc(0);
  private stopped = false;
  private previousSample = 0;
  private finalTranscription = "";

  private readonly framesPerPacket16k = positiveInteger(
    process.env.KROKO_FRAMES_16K,
    DEFAULT_FRAMES_PER_PACKET_16K
  );
  private readonly inputGain = finiteNumber(process.env.KROKO_INPUT_GAIN, 1);
  private readonly preemphasis = finiteNumber(process.env.KROKO_PREEMPH, 0);

  constructor(private readonly options: SpeechRecognitionOptions) {}

  async start(
    signal: AbortSignal,
    emit: (text: string, final: boolean, cumulative?: boolean) => void,
    fail: (error: Error) => void
  ): Promise<void> {
    const languageCode = this.options.languageCode ?? "fr-FR";
    const url = withQuery(this.options.endpoint ?? KROKO_URL, {
      apiKey: required(this.options.apiKey, "KROKO_CLOUD_API_KEY"),
      languageCode,
      endpoints: "false"
    });

    const socket = (this.socket = new SpeechSocket(
      url,
      {},
      signal,
      this.options.timeoutMs,
      this.options.maxBufferBytes
    ));
    await socket.ready;

    await socket.send(
      JSON.stringify({
        type: "start",
        encoding: "FLOAT32",
        sampleRate: 16000,
        languageCode,
        channels: 1
      })
    );

    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const readiness = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    void (async () => {
      try {
        for await (const message of socket.messages) {
          if (signal.aborted) {
            return;
          }

          if (message.binary) {
            throw new Error("Unexpected binary Kroko response");
          }

          const data = JSON.parse(message.data) as KrokoMessage;

          if (
            data.error ||
            data.error_code ||
            /error|quota_exceeded/i.test(
              String(data.message_type ?? data.type)
            )
          ) {
            throw new Error("kroko recognition error");
          }

          if (data.type === "connected") {
            readyResolve();
            continue;
          }

          if (typeof data.text !== "string" || !data.text) {
            continue;
          }

          if (data.type === "final") {
            this.finalTranscription = [this.finalTranscription, data.text]
              .filter(Boolean)
              .join(" ");
            const finalText = normaliseTranscript(this.finalTranscription);

            if (finalText) {
              emit(finalText, true, true);
            }
          } else {
            const partialText = normaliseTranscript(
              [this.finalTranscription, data.text].filter(Boolean).join(" ")
            );

            if (partialText) {
              emit(partialText, false, true);
            }
          }
        }

        if (!signal.aborted && !this.stopped) {
          throw new Error("Kroko closed the recognition connection");
        }
      } catch (error) {
        const reason = asError(error);
        readyReject(reason);

        if (!signal.aborted && !this.stopped) {
          fail(reason);
        }
      }
    })();

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
    if (this.stopped || !this.socket) {
      throw aborted();
    }

    const samples = new Float32Array(audio.length / 2);
    for (let index = 0; index < samples.length; index++) {
      samples[index] =
        (audio.readInt16LE(index * 2) / 32768) * this.inputGain;
    }

    const processed = this.applyPreemphasis(samples);
    const upsampled = this.upsample2x(processed);
    const output = Buffer.allocUnsafe(upsampled.length * FLOAT32_BYTES);

    for (let index = 0; index < upsampled.length; index++) {
      output.writeFloatLE(upsampled[index], index * FLOAT32_BYTES);
    }

    this.audioBytes = Buffer.concat([this.audioBytes, output]);
    await this.flushPackets();
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.audioBytes = Buffer.alloc(0);
    this.socket?.close();
  }

  private applyPreemphasis(samples: Float32Array): Float32Array {
    if (!this.preemphasis) {
      return samples;
    }

    const output = new Float32Array(samples.length);
    let previous = this.previousSample;

    for (let index = 0; index < samples.length; index++) {
      output[index] = samples[index] - this.preemphasis * previous;
      previous = samples[index];
    }

    this.previousSample = previous;
    return output;
  }

  private upsample2x(samples: Float32Array): Float32Array {
    if (!samples.length) {
      return samples;
    }

    const output = new Float32Array(samples.length * 2);

    for (let index = 0; index < samples.length - 1; index++) {
      const current = samples[index];
      const next = samples[index + 1];
      output[index * 2] = current;
      output[index * 2 + 1] = (current + next) * 0.5;
    }

    const last = samples[samples.length - 1];
    output[output.length - 2] = last;
    output[output.length - 1] = last;
    return output;
  }

  private async flushPackets(): Promise<void> {
    const packetBytes = this.framesPerPacket16k * FLOAT32_BYTES;

    while (this.audioBytes.length >= packetBytes) {
      const packet = this.audioBytes.subarray(0, packetBytes);
      this.audioBytes = this.audioBytes.subarray(packetBytes);
      await this.socket!.send(packet);
    }
  }
}

/** Kroko Cloud Speech-to-Text provider implementation. */
export class KrokoSpeechRecognition extends AbstractSpeechRecognition {
  readonly provider = SpeechRecognitionProvider.Kroko;

  constructor(options: SpeechRecognitionOptions) {
    super(options);
  }

  protected createDriver(): RecognitionDriver {
    return new KrokoRecognitionDriver(this.options);
  }
}
