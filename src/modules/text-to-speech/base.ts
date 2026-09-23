import type { AudioFrameHandler, TextToSpeechInput } from "./types";

/** TTS emits raw PCM16 mono frames at 8 kHz; the transport applies wire framing. */
export abstract class TextToSpeechProvider {
  private audioFrameHandler?: AudioFrameHandler;

  protected constructor(readonly uuid: string) {}

  /** Register the callback that receives raw PCM audio frames. */
  setHandler(handler: AudioFrameHandler): void {
    this.audioFrameHandler = handler;
  }

  /** Deliver a raw PCM frame through the shared TTS handler contract. */
  protected emitAudioFrame(frame: Buffer): void {
    if (!this.audioFrameHandler) {
      return;
    }

    this.audioFrameHandler(frame);
  }

  abstract connect(): Promise<void>;
  abstract sendText(input: TextToSpeechInput): Promise<void>;
  abstract disconnect(): Promise<void>;
}
