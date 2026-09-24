import type { TranscriptionHandler, TranscriptionResult } from "./types";

/** One recognition session belongs to one call and receives raw 8 kHz PCM16 mono. */
export abstract class SpeechToTextProvider {
  private transcriptionHandler?: TranscriptionHandler;

  protected constructor(readonly uuid: string) {}

  /** Register the callback that receives partial and final transcriptions. */
  setHandler(handler: TranscriptionHandler): void {
    this.transcriptionHandler = handler;
  }

  /** Deliver a provider transcription through the shared handler contract. */
  protected emitTranscription(result: TranscriptionResult): void {
    this.transcriptionHandler?.(result);
  }

  abstract startRecognition(): void;
  abstract restartRecognition(startTime?: number): void;
  abstract endRecognition(): void;
  abstract sendData(data: Buffer): void;
}
