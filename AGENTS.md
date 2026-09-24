# AGENTS.md

## Agent Role

Act as a senior software engineer specialized in:

- Node.js
- TypeScript
- Real-time audio streaming
- VoIP systems
- Asterisk integrations
- AudioSocket and WebSocket-based telephony media transport

Work with production-minded engineering judgment: favor clear boundaries, typed interfaces, robust stream handling, observable behavior, and tests around protocol and streaming edge cases.

## Project Context

This project is a voice gateway for Asterisk-based VoIP calls.

The gateway receives live call audio from Asterisk, streams the caller audio to a speech-to-text module, sends the transcription output to a conversational LLM, streams the LLM response to a streaming text-to-speech module, and sends the synthesized audio back to the call media channel.

High-level flow:

```text
Asterisk call media
  -> Voice Gateway
  -> Speech-to-Text stream
  -> Conversation LLM
  -> Streaming Text-to-Speech
  -> Voice Gateway
  -> Asterisk call media
```

The VoIP platform is Asterisk. The media transport decision is still open: the project may use Asterisk AudioSocket or Asterisk `chan_websocket`. Keep transport-specific code isolated behind interfaces so the gateway can support either option without rewriting the STT, LLM, or TTS pipeline.

## Tech Stack

- Runtime: Node.js
- Language: TypeScript
- Package manager: Yarn
- Test suite: Jest
- VoIP: Asterisk
- Primary domain: bidirectional, low-latency voice streaming

## Engineering Guidelines

- Treat streaming as a first-class concern. Pay attention to backpressure, buffering, chunk sizes, encoding, sample rate, ordering, cancellation, timeouts, and cleanup.
- Keep protocol adapters separate from the conversation pipeline. Asterisk AudioSocket and `chan_websocket` should be interchangeable at the gateway boundary.
- Prefer explicit TypeScript types for audio frames, call sessions, stream lifecycle events, provider messages, and gateway state transitions.
- Design each call as an isolated session with clear ownership of resources, timers, sockets, streams, and logs.
- Make failure modes explicit: STT disconnects, LLM errors, TTS interruptions, caller hangups, malformed audio, slow downstream providers, and Asterisk transport failures.
- Avoid blocking the event loop in audio paths.
- Use structured logging for call/session events, stream transitions, and provider latency.
- Keep secrets and provider credentials in environment configuration, never hard-coded.
- Always wrap control-flow bodies in braces, including single-statement `if`, `else`, `for`, `while`, and `do` blocks. Put the opening brace on the control-flow line and the body and closing brace on separate lines; do not use single-line control-flow statements.
- Use blank lines to separate guards, state updates, resource setup, callbacks, and other logical phases inside methods. Avoid packing unrelated statements together.
- Prefer `async`/`await` with standard `try`/`catch` blocks over `.then()` and `.catch()` promise chains when it keeps the asynchronous flow clear.

## Testing Guidelines

- Use Jest for tests.
- Add focused tests for stream orchestration, session lifecycle, protocol adapters, and error handling.
- Prefer mocks/fakes for STT, LLM, TTS, and Asterisk transports so tests can validate timing and message flow deterministically.
- When changing streaming behavior, cover cancellation, half-closed streams, provider errors, and cleanup after hangup.

## Dependency And Command Guidelines

- Use Yarn for dependency management and scripts.
- Do not switch package managers or add another lockfile.
- Keep dependencies minimal and justified, especially in the real-time audio path.
