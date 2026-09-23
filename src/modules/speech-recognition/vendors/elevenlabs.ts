import { aborted, asError, required } from "../../speech/common";
import { SpeechSocket } from "../../speech/socket";
import { AbstractSpeechRecognition } from "../base";
import { SpeechRecognitionProvider } from "../types";
import type { RecognitionDriver, SpeechRecognitionOptions } from "../types";

interface ElevenLabsMessage {
  message_type?: string;
  type?: string;
  text?: string;
  error?: unknown;
  message?: unknown;
}

function buildWebSocketUrl(options: SpeechRecognitionOptions): string {
  const url = new URL(
    options.endpoint || "wss://api.elevenlabs.io/v1/speech-to-text/realtime"
  );

  for (const [key, value] of Object.entries({
    model_id: options.modelId || "scribe_v2_realtime",
    audio_format: options.audioFormat || "pcm_8000",
    commit_strategy: options.commitStrategy || "manual",
    include_timestamps: String(options.includeTimestamps ?? false),
    language_code: (options.languageCode || "fr-FR").split("-")[0]
  })) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

class ElevenLabsRecognitionDriver implements RecognitionDriver {
  private socket?: SpeechSocket;
  private stopped = false;

  constructor(
    private readonly options: SpeechRecognitionOptions,
    private readonly sessionState: { previousTextSent: boolean }
  ) {}

  async start(
    signal: AbortSignal,
    emit: (text: string, final: boolean, cumulative?: boolean) => void,
    fail: (error: Error) => void
  ): Promise<void> {
    if (signal.aborted) {
      throw aborted();
    }

    const socket = (this.socket = new SpeechSocket(
      buildWebSocketUrl(this.options),
      { "xi-api-key": required(this.options.apiKey, "ELEVENLABS_API_KEY") },
      signal,
      this.options.timeoutMs,
      this.options.maxBufferBytes
    ));

    await socket.ready;

    void this.readMessages(signal, emit).catch(error => {
      if (!signal.aborted && !this.stopped) {
        fail(asError(error));
      }
    });
  }

  private async readMessages(
    signal: AbortSignal,
    emit: (text: string, final: boolean, cumulative?: boolean) => void
  ): Promise<void> {
    for await (const message of this.socket!.messages) {
      if (signal.aborted) {
        return;
      }

      if (message.binary) {
        throw new Error("Unexpected binary ElevenLabs STT response");
      }

      let data: ElevenLabsMessage;

      try {
        data = JSON.parse(message.data) as ElevenLabsMessage;
      } catch {
        throw new Error("Invalid JSON from ElevenLabs STT");
      }

      this.handleMessage(data, emit);
    }
  }

  private handleMessage(
    response: ElevenLabsMessage,
    emit: (text: string, final: boolean, cumulative?: boolean) => void
  ): void {
    const messageType = response.message_type ?? response.type;

    switch (messageType) {
      case "session_started":
        return;

      case "partial_transcript":
        if (typeof response.text === "string") {
          emit(response.text, false);
        }
        return;

      case "committed_transcript":
      case "committed_transcript_with_timestamps":
        if (typeof response.text === "string") {
          emit(response.text, true);
        }
        return;

      case "commit_throttled":
        return;

      case "auth_error":
      case "quota_exceeded":
      case "transcriber_error":
      case "input_error":
      case "error":
        throw new Error(
          `ElevenLabs ${messageType}: ${String(response.error ?? response.message ?? "unknown error")}`
        );

      default:
        return;
    }
  }

  async send(audio: Buffer): Promise<void> {
    const audioFormat = this.options.audioFormat || "pcm_8000";
    const parsedSampleRate = Number.parseInt(
      audioFormat.split("_")[1] ?? "",
      10
    );
    const sampleRate = this.options.sampleRate || parsedSampleRate || 8000;
    const message: Record<string, unknown> = {
      message_type: "input_audio_chunk",
      audio_base_64: audio.toString("base64"),
      sample_rate: sampleRate,
      commit: false
    };

    if (!this.sessionState.previousTextSent && this.options.lastAgentMessage) {
      message.previous_text = this.options.lastAgentMessage.slice(-50);
      this.sessionState.previousTextSent = true;
    }

    await this.socket!.send(JSON.stringify(message));
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.socket?.close();
  }
}

/** ElevenLabs Speech-to-Text provider implementation. */
export class ElevenLabsSpeechRecognition extends AbstractSpeechRecognition {
  readonly provider = SpeechRecognitionProvider.ElevenLabs;
  // The legacy manager sent previous_text only for the lifetime of the call,
  // including when a new provider socket was opened for the next turn.
  private readonly sessionState = { previousTextSent: false };

  constructor(options: SpeechRecognitionOptions) {
    super(options);
  }

  protected createDriver(): RecognitionDriver {
    return new ElevenLabsRecognitionDriver(this.options, this.sessionState);
  }
}
