interface RecognitionEvent { result: { reason: number; text: string } }
interface RecognizerMock {
  recognizing?: (_sender: unknown, event: RecognitionEvent) => void;
  recognized?: (_sender: unknown, event: RecognitionEvent) => void;
  sessionStarted?: () => void;
  sessionStopped?: () => void;
  startContinuousRecognitionAsync: jest.Mock;
  stopContinuousRecognitionAsync: jest.Mock;
  close: jest.Mock;
}

const mockRecognizers: RecognizerMock[] = [];
const mockStreams: Array<{ write: jest.Mock; close: jest.Mock }> = [];
jest.mock("microsoft-cognitiveservices-speech-sdk", () => ({
  SpeechConfig: { fromSubscription: jest.fn(() => ({ setProfanity: jest.fn(), setProperty: jest.fn() })) },
  ProfanityOption: { Raw: 1 },
  PropertyId: { SpeechServiceConnection_InitialSilenceTimeoutMs: 1, SpeechServiceConnection_EndSilenceTimeoutMs: 2 },
  AudioStreamFormat: { getWaveFormatPCM: jest.fn() },
  AudioInputStream: { createPushStream: jest.fn(() => {
    const stream = { write: jest.fn(), close: jest.fn() };
    mockStreams.push(stream);
    return stream;
  }) },
  AudioConfig: { fromStreamInput: jest.fn() },
  SpeechRecognizer: jest.fn().mockImplementation(() => {
    const recognizer: RecognizerMock = {
      startContinuousRecognitionAsync: jest.fn((success: () => void) => success()),
      stopContinuousRecognitionAsync: jest.fn((success: () => void) => success()),
      close: jest.fn()
    };
    mockRecognizers.push(recognizer);
    return recognizer;
  }),
  ResultReason: { RecognizingSpeech: 1, RecognizedSpeech: 2, NoMatch: 3 },
  CancellationReason: { Error: 1 }
}));

import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { AzureSpeechToText } from "./azure";

describe("Azure STT", () => {
  beforeEach(() => { mockRecognizers.length = 0; mockStreams.length = 0; });
  afterEach(() => jest.useRealTimers());

  it("emits accumulated partial and final text, and writes PCM after session start", () => {
    const provider = new AzureSpeechToText({ provider: "azure", uuid: "call", apiKey: "key", region: "region" });
    const handler = jest.fn();
    provider.setHandler(handler);
    const recognizer = mockRecognizers[0];
    provider.sendData(Buffer.from([1, 2]));
    expect(mockStreams[0].write).not.toHaveBeenCalled();
    recognizer.sessionStarted?.();
    provider.sendData(Buffer.from([1, 2]));
    expect(Buffer.from(mockStreams[0].write.mock.calls[0][0] as ArrayBuffer)).toEqual(Buffer.from([1, 2]));
    recognizer.recognizing?.(null, { result: { reason: 1, text: "bonjour" } });
    recognizer.recognized?.(null, { result: { reason: 2, text: "bonjour" } });
    recognizer.recognizing?.(null, { result: { reason: 1, text: "vous" } });
    expect(handler.mock.calls.map(([value]) => value)).toEqual([
      { transcription: "bonjour", isFinal: false },
      { transcription: "bonjour vous", isFinal: false }
    ]);
    expect(sdk.AudioStreamFormat.getWaveFormatPCM).toHaveBeenCalledWith(8000, 16, 1);
    provider.endRecognition();
  });

  it("ignores late events during restart and replaces SDK resources", () => {
    const provider = new AzureSpeechToText({ provider: "azure", uuid: "call", apiKey: "key", region: "region", startTime: 10 });
    const first = mockRecognizers[0];
    let finishStop: (() => void) | undefined;
    first.stopContinuousRecognitionAsync.mockImplementationOnce((success: () => void) => { finishStop = success; });
    const handler = jest.fn();
    provider.setHandler(handler);
    provider.restartRecognition(20);
    first.recognized?.(null, { result: { reason: 2, text: "late" } });
    expect(handler).not.toHaveBeenCalled();
    finishStop?.();
    expect(mockStreams[0].close).toHaveBeenCalled();
    expect(first.close).toHaveBeenCalled();
    expect(mockRecognizers).toHaveLength(2);
    expect(provider.lastStartTime).toBe(10);
    expect(provider.startTime).toBe(20);
    provider.endRecognition();
  });

  it("forces cleanup when Azure stop never calls back", () => {
    jest.useFakeTimers();
    const provider = new AzureSpeechToText({ provider: "azure", uuid: "call", apiKey: "key", region: "region" });
    mockRecognizers[0].stopContinuousRecognitionAsync.mockImplementationOnce(() => {});
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
    provider.endRecognition();
    jest.advanceTimersByTime(3000);
    expect(mockStreams[0].close).toHaveBeenCalled();
    expect(mockRecognizers[0].close).toHaveBeenCalled();
    warning.mockRestore();
  });

  it("does not restart recognition after hangup", () => {
    const provider = new AzureSpeechToText({ provider: "azure", uuid: "call", apiKey: "key", region: "region" });
    let finishRestart: (() => void) | undefined;
    mockRecognizers[0].stopContinuousRecognitionAsync.mockImplementationOnce((success: () => void) => { finishRestart = success; });
    provider.restartRecognition(2);
    provider.endRecognition();
    finishRestart?.();
    expect(mockRecognizers).toHaveLength(1);
  });
});
