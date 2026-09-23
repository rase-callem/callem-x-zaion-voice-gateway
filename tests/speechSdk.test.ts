const mockRecognizers: any[] = [];

const mockInputs: any[] = [];

const mockSpeechConfigs: any[] = [];

const mockSynthesizers: any[] = [];

const mockGoogleClients: any[] = [];

jest.mock("microsoft-cognitiveservices-speech-sdk", () => ({
  SpeechConfig: {
    fromSubscription: jest.fn(() => {
      const config = {
        setProfanity: jest.fn(),
        setProperty: jest.fn()
      };
      mockSpeechConfigs.push(config);
      return config;
    })
  },
  ProfanityOption: { Raw: 0 },
  PropertyId: {
    SpeechServiceConnection_InitialSilenceTimeoutMs: 29,
    SpeechServiceConnection_EndSilenceTimeoutMs: 30
  },
  AudioStreamFormat: { getWaveFormatPCM: jest.fn() },
  AudioInputStream: {
    createPushStream: () => {
      const input = {
        write: jest.fn(),
        close: jest.fn()
      };
      mockInputs.push(input);

      return input;
    }
  },
  AudioConfig: { fromStreamInput: () => ({ close: jest.fn() }) },
  ResultReason: {
    RecognizingSpeech: 2,
    RecognizedSpeech: 3,
    SynthesizingAudioCompleted: 2
  },
  SpeechSynthesisOutputFormat: { Raw8Khz16BitMonoPcm: 0 },
  SpeechRecognizer: jest.fn().mockImplementation(() => {
    const recognizer = {
      close: jest.fn(),
      startContinuousRecognitionAsync: jest.fn((success: () => void) =>
        success()
      )
    };
    mockRecognizers.push(recognizer);

    return recognizer;
  }),
  SpeechSynthesizer: jest.fn().mockImplementation(() => {
    const synthesizer = {
      close: jest.fn(),
      speakSsmlAsync: jest.fn()
    };
    mockSynthesizers.push(synthesizer);

    return synthesizer;
  })
}));

jest.mock("@google-cloud/speech", () => ({
  SpeechClient: jest.fn().mockImplementation(() => {
    const { Duplex } = jest.requireActual("stream");
    const stream = new Duplex({
      readableObjectMode: true,
      read() {},
      write(_chunk: Buffer, _encoding: string, callback: () => void) {
        callback();
      }
    });
    const client = {
      stream,
      streamingRecognize: jest.fn(() => stream),
      close: jest.fn(async () => {})
    };
    mockGoogleClients.push(client);

    return client;
  })
}));

import { createSpeechRecognition } from "../src/modules/speech-recognition";
import { createSpeechSynthesis } from "../src/modules/speech-synthesis";

beforeEach(() => {
  mockRecognizers.length = 0;
  mockInputs.length = 0;
  mockSpeechConfigs.length = 0;
  mockSynthesizers.length = 0;
  mockGoogleClients.length = 0;
});

const options = {
  callId: "call",
  apiKey: "test",
  region: "test",
  onTranscription: jest.fn(),
  onError: jest.fn()
};

test("Azure matches legacy configuration, result filtering, and stale-event handling", async () => {
  const onTranscription = jest.fn();
  const stt = createSpeechRecognition({
    ...options,
    provider: "azure",
    onTranscription
  });
  await stt.startRecognition();
  expect(mockSpeechConfigs[0].setProperty.mock.calls).toEqual([
    [29, "15000"],
    [30, "5000"]
  ]);
  const backing = Buffer.from([99, 99, 1, 2, 3, 4, 88, 88]);
  await stt.sendData(backing.subarray(2, 6));
  expect(Buffer.from(mockInputs[0].write.mock.calls[0][0])).toEqual(
    Buffer.from([1, 2, 3, 4])
  );
  mockRecognizers[0].recognizing(null, {
    result: { reason: 0, text: "ignored" }
  });
  mockRecognizers[0].recognizing(null, {
    result: { reason: 2, text: "Hello" }
  });
  mockRecognizers[0].recognized(null, {
    result: {
      reason: 3,
      text: "Hello"
    }
  });
  mockRecognizers[0].recognizing(null, {
    result: { reason: 2, text: "   " }
  });
  mockRecognizers[0].recognized(null, {
    result: { reason: 3, text: "   " }
  });
  expect(onTranscription).toHaveBeenCalledTimes(2);
  await stt.restartRecognition();
  mockRecognizers[0].recognized(null, {
    result: {
      reason: 3,
      text: "stale"
    }
  });
  expect(onTranscription).toHaveBeenCalledTimes(2);
  await stt.endRecognition();
  mockRecognizers[1].recognizing(null, { result: { text: "late" } });
  expect(onTranscription).toHaveBeenCalledTimes(2);
  expect(
    mockRecognizers.every(
      (recognizer) => recognizer.close.mock.calls.length === 1
    )
  ).toBe(true);
});

test("Google matches legacy request and transcript behavior", async () => {
  const onError = jest.fn();
  const onTranscription = jest.fn();
  const stt = createSpeechRecognition({
    ...options,
    provider: "google",
    onError,
    onTranscription
  });
  await stt.startRecognition();
  const client = mockGoogleClients[0];
  expect(client.streamingRecognize).toHaveBeenCalledWith({
    config: {
      encoding: "LINEAR16",
      sampleRateHertz: 8000,
      languageCode: "fr-FR",
      alternativeLanguageCodes: [],
      enableWordTimeOffsets: true,
      model: "telephony"
    },
    interimResults: true
  });
  await stt.sendData(Buffer.alloc(320));
  client.stream.emit("data", {
    results: [
      {
        alternatives: [{ transcript: "Hello" }],
        isFinal: false
      }
    ]
  });
  client.stream.emit("data", {
    results: [
      {
        alternatives: [{ transcript: "Hello" }],
        isFinal: true
      }
    ]
  });
  expect(onTranscription).toHaveBeenLastCalledWith(
    expect.objectContaining({
      transcription: "hello",
      isFinal: false
    })
  );

  jest.useFakeTimers();
  try {
    jest.advanceTimersByTime(2001);
    client.stream.emit("data", {
      results: [
        {
          alternatives: [{ transcript: "Hello" }],
          isFinal: true
        }
      ]
    });
  } finally {
    jest.useRealTimers();
  }
  expect(onTranscription).toHaveBeenLastCalledWith(
    expect.objectContaining({
      transcription: "hello",
      isFinal: true
    })
  );
  client.stream.emit("end");
  expect(stt.state).toBe("failed");
  expect(onError).toHaveBeenCalledTimes(1);
  expect(client.close).toHaveBeenCalledTimes(1);
  await stt.endRecognition();
});

test("Azure synthesis escapes SSML, preserves split samples and closes after completion", async () => {
  const tts = createSpeechSynthesis({
    provider: "azure",
    callId: "call",
    apiKey: "test",
    region: "test",
    voice: "voice",
    settings: { speed: 1.2 }
  });
  const iterator = tts
    .synthesize("Hello <world> & friends")
    [Symbol.asyncIterator]();
  const first = iterator.next();
  const sdk = mockSynthesizers[0];
  expect(sdk.speakSsmlAsync.mock.calls[0][0]).toContain(
    "Hello &lt;world&gt; &amp; friends"
  );
  expect(sdk.speakSsmlAsync.mock.calls[0][0]).toContain('rate="20%"');
  sdk.synthesizing(null, {
    result: { audioData: Uint8Array.from([1, 2, 3]).buffer }
  });
  sdk.synthesizing(null, {
    result: { audioData: Uint8Array.from([4]).buffer }
  });
  sdk.speakSsmlAsync.mock.calls[0][1]({ reason: 2 });
  expect((await first).value).toEqual(Buffer.from([1, 2, 3, 4]));
  expect((await iterator.next()).done).toBe(true);
  expect(sdk.close).toHaveBeenCalledTimes(1);
  await tts.close();
});

test("Azure synthesis abort rejects an outstanding read and closes SDK resources", async () => {
  const tts = createSpeechSynthesis({
    provider: "azure",
    callId: "call",
    apiKey: "test",
    region: "test",
    voice: "voice"
  });
  const iterator = tts.synthesize("Hello")[Symbol.asyncIterator]();
  const next = iterator.next();
  tts.cancel();
  await expect(next).rejects.toThrow("aborted");
  expect(mockSynthesizers[0].close).toHaveBeenCalledTimes(1);
  await tts.close();
});
