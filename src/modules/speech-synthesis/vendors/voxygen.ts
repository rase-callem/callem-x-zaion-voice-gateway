import { AbstractSpeechSynthesis } from "../base";
import { required } from "../../speech/common";
import { SpeechSynthesisProvider } from "../types";
import type { SpeechSynthesisOptions } from "../types";

/** Voxygen Speech Synthesis provider implementation. */
export class VoxygenSpeechSynthesis extends AbstractSpeechSynthesis {
  readonly provider = SpeechSynthesisProvider.Voxygen;

  constructor(options: SpeechSynthesisOptions) {
    super(options);
  }

  protected generate(text: string, signal: AbortSignal): AsyncIterable<Buffer> {
    return this.generateVoxygenSpeech(text, signal);
  }

  private async *generateVoxygenSpeech(
    text: string,
    signal: AbortSignal
  ): AsyncGenerator<Buffer> {
    const url = new URL(
      this.options.endpoint ?? "https://ws.voxygen.fr/ntts/tts1"
    );

    for (const [key, value] of Object.entries({
      text,
      voice: this.options.voice,
      frequency: "8000",
      header: "wav-stream-header",
      coding: "lin",
      "articulation-rate": `${Math.round((this.options.settings?.speed ?? 1) * 100)}%`
    })) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url, {
      signal,
      headers: {
        Authorization: `Bearer ${required(this.options.apiKey, "VOXYGEN_TOKEN")}`
      }
    });

    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Voxygen HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new PcmWaveDecoder();

    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }

        const pcm = decoder.push(Buffer.from(result.value));
        if (pcm.length) {
          yield pcm;
        }
      }

      decoder.finish();
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }
}

class PcmWaveDecoder {
  private pending: Buffer = Buffer.alloc(0);
  private riff = false;
  private format = false;
  private data = false;
  private remaining?: number;

  push(chunk: Buffer): Buffer {
    if (this.data) {
      return this.take(chunk);
    }

    this.pending = Buffer.concat([this.pending, chunk]);

    if (!this.riff) {
      if (this.pending.length < 12) {
        return Buffer.alloc(0);
      }

      if (
        this.pending.toString("ascii", 0, 4) !== "RIFF" ||
        this.pending.toString("ascii", 8, 12) !== "WAVE"
      ) {
        throw new Error("Invalid WAV header");
      }

      this.pending = this.pending.subarray(12);
      this.riff = true;
    }

    while (this.pending.length >= 8) {
      const name = this.pending.toString("ascii", 0, 4);
      const size = this.pending.readUInt32LE(4);

      if (name === "data") {
        if (!this.format) {
          throw new Error("WAV data precedes format");
        }

        this.data = true;
        this.remaining = size === 0xffffffff || size === 0 ? undefined : size;
        const output = this.take(this.pending.subarray(8));
        this.pending = Buffer.alloc(0);
        return output;
      }

      if (size > 65536) {
        throw new Error("WAV metadata exceeds limit");
      }

      if (this.pending.length < 8 + size + (size % 2)) {
        return Buffer.alloc(0);
      }

      if (name === "fmt ") {
        if (
          size < 16 ||
          this.pending.readUInt16LE(8) !== 1 ||
          this.pending.readUInt16LE(10) !== 1 ||
          this.pending.readUInt32LE(12) !== 8000 ||
          this.pending.readUInt16LE(22) !== 16
        ) {
          throw new Error("Expected mono PCM16 8 kHz WAV");
        }

        this.format = true;
      }

      this.pending = this.pending.subarray(8 + size + (size % 2));
    }

    return Buffer.alloc(0);
  }

  private take(chunk: Buffer): Buffer {
    if (this.remaining === undefined) {
      return chunk;
    }

    const output = chunk.subarray(0, this.remaining);
    this.remaining -= output.length;
    return output;
  }

  finish(): void {
    if (!this.data || (this.remaining !== undefined && this.remaining > 0)) {
      throw new Error("Truncated WAV response");
    }
  }
}

export { PcmWaveDecoder };
