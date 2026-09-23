# Speech providers

`createSpeechRecognition` and `createSpeechSynthesis` select a provider using the
case-insensitive `provider` field used by the legacy `index.js` engine objects.
Each module exports an interface, an abstract lifecycle implementation, and named
provider implementations. Construction does not connect to a provider.

Provider implementations live in dedicated files under `speech-recognition/vendors`
and `speech-synthesis/vendors`. Shared lifecycle code and provider protocol drivers
remain alongside those folders so vendor files stay small and easy to replace.
Cloud SDK imports and HTTP/WAV handling live inside their vendor files. The shared
WebSocket helper only owns connection lifecycle and bounded transport I/O; it does
not contain a cloud SDK.

Provider names are available as `SpeechRecognitionProvider` and
`SpeechSynthesisProvider` enums. Use those enum values when constructing providers
in TypeScript; the factories still accept the legacy lowercase provider strings.

| Module | Providers |
| --- | --- |
| Speech recognition | Azure, Google, Callem, Kroko, Soniox, Gladia, ElevenLabs, AssemblyAI |
| Speech synthesis | Azure, Voxygen, ElevenLabs, Gradium, Cartesia |

Credentials come from `.env.example` variables or explicit options. Google uses
Application Default Credentials. Unknown providers fail explicitly. The SDKs
require a modern Node runtime (Google SDK requires Node 22 or later).

## Recognition

```ts
import {
  createSpeechRecognition,
  SpeechRecognitionProvider,
} from "../speech-recognition";

const stt = createSpeechRecognition({
  ...sttEngine,
  provider: SpeechRecognitionProvider.Azure,
  callId: call.id,
  onTranscription: result => handleTranscript(result.transcription, result.isFinal),
  onError: error => handleProviderFailure(error),
});
await stt.startRecognition();
try {
  for await (const chunk of call.incomingAudio) {
    await stt.sendData(chunk); // Await writes to propagate backpressure.
  }
} finally {
  await stt.endRecognition();
}
```

Input is raw **PCM16LE, mono, 8 kHz**, with complete two-byte samples. Validate
`call.format` and convert other transport formats before sending. Do not pass
AudioSocket headers. Oversized input and concurrent writes are rejected. Azure's
SDK push stream does not expose downstream drain signals; feed it at real-time
call pace rather than replaying an unbounded recording.

Transcriptions contain the current turn's finalized segments plus its latest
partial; final notifications are delivered even when text matches the partial.
`restartRecognition()` cancels the old stream and starts a fresh turn, dropping
old buffered audio/results. `endRecognition()` is terminal cancellation for
hangup, not an end-of-input flush; it discards outstanding provider results.
Calls to lifecycle methods should be awaited. Failures are reported through
`onError`; awaited startup/writes also reject. Callbacks should not throw.

Callem uses Vosk for the first two turns, then switches to Soniox on the second
restart, as in the source implementation. Configure both endpoints/credentials.
Kroko explicitly converts 8 kHz PCM to 16 kHz float audio; it does not guess
endianness or sample rate from packet size. AssemblyAI coalesces 20 ms frames into
80 ms packets. ElevenLabs uses the configured commit strategy, which defaults to
the legacy manual strategy; turn restarts remain controlled by the caller.

## Synthesis

```ts
import {
  createSpeechSynthesis,
  SpeechSynthesisProvider,
} from "../speech-synthesis";
import { once } from "node:events";

const tts = createSpeechSynthesis({
  ...ttsEngine,
  provider: SpeechSynthesisProvider.Azure,
  callId: call.id
});
try {
  // Consume LLM text segments sequentially, in their original order.
  for await (const pcm of tts.synthesize(textSegment, { signal: turnAbortSignal })) {
    if (!call.outgoingAudio.write(pcm)) await once(call.outgoingAudio, 'drain');
  }
} finally {
  await tts.close(); // At call hangup; keep the instance for subsequent segments.
}
```

Each synthesis stream represents one complete text segment. Unlike the legacy
`sendText({ text, isFinal })` queue, the caller owns segment sequencing; concurrent
synthesis requests on one instance are rejected. Call `cancel()` or abort the
signal to interrupt the active segment, and settle/return its iterator before
starting another. Breaking iteration closes provider resources. `close()` is
terminal; it immediately aborts active I/O.

Output is raw PCM16LE, mono, 8 kHz, in 320-byte frames plus a possible shorter,
sample-aligned final frame. AudioSocket framing and playback pacing belong to
the audio transport. Gradium's 8 kHz µ-law output is decoded to PCM. Voxygen WAV
headers and metadata are parsed incrementally; WAV headers never reach the call.
Synthesis streams audio as it arrives without retaining a complete recording.
Provider disconnect before completion, malformed output, overflow, and timeout
reject the iterator. Always handle iterator errors and transport write errors.

`timeoutMs` bounds STT startup/socket writes (default 15 seconds) and entire TTS
segments (default 60 seconds). `maxBufferBytes` bounds queued WebSocket/SDK output
(default 1 MiB); overflow fails rather than growing without limit. HTTP output
uses pull-based reads. STT has no automatic reconnect/replay: the call pipeline
must decide what to do after a failure.

The modules deliberately do not implement legacy filesystem caches, static
`[TTS-X]` recordings, database updates, or Asterisk packet generation. Those
are orchestration/storage/transport concerns. The gateway entry point is not
wired to a conversation pipeline by this change. Tests use local fake provider
servers and SDK mocks; real account integration requires provider credentials.
