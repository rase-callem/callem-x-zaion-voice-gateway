# AudioSocket Call Client

A small browser client for testing an AudioSocket-compatible WebSocket bridge.

## Commands

```sh
yarn install
yarn dev
```

The browser cannot connect directly to Asterisk AudioSocket TCP. Use a `ws://` or `wss://` server URL that accepts binary PCM16 little-endian microphone frames and returns binary PCM16 little-endian audio frames for playback.

On connect, the client sends:

```json
{
  "type": "start",
  "codec": "pcm_s16le",
  "sampleRate": 16000,
  "channels": 1
}
```

On hangup, it sends:

```json
{ "type": "stop" }
```
