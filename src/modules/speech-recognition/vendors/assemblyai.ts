import { aborted, asError, required } from "../../speech/common";
import { SpeechSocket } from "../../speech/socket";
import { AbstractSpeechRecognition } from "../base";
import { SpeechRecognitionProvider } from "../types";
import type { RecognitionDriver, SpeechRecognitionOptions } from "../types";

interface AssemblyAITurnMessage {
  type?: string;
  transcript?: string;
  end_of_turn?: boolean;
  turn_order?: number;
  error?: unknown;
  error_code?: unknown;
}

/** AssemblyAI's streaming protocol has provider-specific framing and turn state. */
class AssemblyAIRecognitionDriver implements RecognitionDriver {
  private socket?: SpeechSocket;
  private carry = Buffer.alloc(0);
  private ready = false;
  private stopped = false;

  constructor(private readonly options: SpeechRecognitionOptions) {}

  async start(
    signal: AbortSignal,
    emit: (text: string, final: boolean, cumulative?: boolean) => void,
    fail: (error: Error) => void
  ): Promise<void> {
    if (signal.aborted) {
      throw aborted();
    }

    const url = new URL(
      this.options.endpoint ?? "wss://streaming.assemblyai.com/v3/ws"
    );
    url.searchParams.set("sample_rate", "8000");
    url.searchParams.set("encoding", "pcm_s16le");
    url.searchParams.set(
      "speech_model",
      this.options.modelId ?? "universal-streaming-multilingual"
    );
    url.searchParams.set("language_detection", "true");

    const socket = (this.socket = new SpeechSocket(
      url.toString(),
      { Authorization: required(this.options.apiKey, "ASSEMBLYAI_API_KEY") },
      signal,
      this.options.timeoutMs,
      this.options.maxBufferBytes
    ));
    await socket.ready;
    this.ready = true;

    void this.readMessages(socket, signal, emit).catch(error => {
      if (!signal.aborted && !this.stopped) {
        fail(asError(error));
      }
    });
  }

  private async readMessages(
    socket: SpeechSocket,
    signal: AbortSignal,
    emit: (text: string, final: boolean, cumulative?: boolean) => void
  ): Promise<void> {
    let finalText = "";
    let currentPartial = "";
    let lastTurnOrder = -1;

    for await (const message of socket.messages) {
      if (signal.aborted) {
        return;
      }

      if (message.binary) {
        throw new Error("Unexpected binary AssemblyAI response");
      }

      let data: AssemblyAITurnMessage;

      try {
        data = JSON.parse(message.data) as AssemblyAITurnMessage;
      } catch {
        throw new Error("Invalid JSON from AssemblyAI");
      }

      if (data.error || data.error_code || data.type === "Error") {
        throw new Error("AssemblyAI recognition error");
      }

      if (data.type !== "Turn" || typeof data.transcript !== "string") {
        continue;
      }

      const transcript = data.transcript.trim();

      if (!transcript) {
        continue;
      }

      const turnOrder = data.turn_order ?? 0;
      const endOfTurn = !!data.end_of_turn;

      if (endOfTurn && turnOrder <= lastTurnOrder) {
        // AssemblyAI may repeat the final Turn message. The legacy adapter
        // ignored already-finalized turn orders instead of turning the repeat
        // into a duplicated partial segment.
        continue;
      }

      if (endOfTurn) {
        finalText += (finalText ? " " : "") + transcript;
        lastTurnOrder = turnOrder;
        currentPartial = "";
      } else {
        currentPartial = transcript;
      }

      const full = `${finalText}${currentPartial ? ` ${currentPartial}` : ""}`.trim();
      emit(full, endOfTurn, true);
    }
  }

  async send(audio: Buffer): Promise<void> {
    if (!this.socket || this.stopped) {
      throw aborted();
    }

    this.carry = Buffer.concat([this.carry, audio]);

    // AssemblyAI v3 accepts audio chunks between 50 and 1000 ms. AudioSocket
    // supplies 20 ms / 320-byte frames, so four frames make an 80 ms chunk.
    while (this.carry.length >= 1280) {
      const frame = this.carry.subarray(0, 1280);
      this.carry = this.carry.subarray(1280);
      await this.socket.send(frame);
    }
  }

  /** Flushes the legacy provider buffer and requests a graceful termination. */
  async terminate(): Promise<void> {
    if (!this.socket || !this.ready || this.stopped) {
      return;
    }

    try {
      if (this.carry.length) {
        const remainder = this.carry;
        this.carry = Buffer.alloc(0);
        await this.socket.send(remainder);
      }

      await this.socket.send(JSON.stringify({ type: "Terminate" }));
    } catch {
      // Shutdown is best effort. The base class still aborts and closes the socket.
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    this.carry = Buffer.alloc(0);
    this.socket?.close();
  }
}

/** AssemblyAI Speech-to-Text provider implementation. */
export class AssemblyAISpeechRecognition extends AbstractSpeechRecognition {
  readonly provider = SpeechRecognitionProvider.AssemblyAI;
  private assemblyDriver?: AssemblyAIRecognitionDriver;

  constructor(options: SpeechRecognitionOptions) {
    super(options);
  }

  protected createDriver(): RecognitionDriver {
    const driver = new AssemblyAIRecognitionDriver(this.options);
    this.assemblyDriver = driver;
    return driver;
  }

  async endRecognition(): Promise<void> {
    const driver = this.assemblyDriver;
    await driver?.terminate();
    await super.endRecognition();

    if (this.assemblyDriver === driver) {
      this.assemblyDriver = undefined;
    }
  }
}
