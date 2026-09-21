import net from "net";
import { Readable } from "stream";
import WebSocket, { type RawData } from "ws";
import {
  AUDIO_SOCKET_PACKET_TYPES,
  AudioSocketTransportServer,
  ChanWebSocketAudioTransportServer,
  createAudioTransportServer,
  decodeAudioSocketPackets,
  encodeAudioSocketPacket,
  parseControlMessage,
  resolveAudioTransportProtocol,
  uuidStringToAudioSocketPayload
} from "../src/modules/audio-transport";
import { Configuration } from "../src/common";
import { CallHandler } from "../src/modules/call-handler";
import type { AudioCallContext, TransportNotification } from "../src/modules/audio-transport";

class CapturingCallHandler extends CallHandler {
  readonly calls: AudioCallContext[] = [];
  private readonly waiters: Array<(call: AudioCallContext) => void> = [];

  async handle(call: AudioCallContext): Promise<void> {
    this.calls.push(call);
    this.waiters.shift()?.(call);
  }

  async waitForCall(index = 0): Promise<AudioCallContext> {
    if (this.calls[index]) {
      return this.calls[index];
    }

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

describe("audio transport factory", () => {
  it("requires a known AUDIO_TRANSPORT_PROTOCOL value", () => {
    expect(resolveAudioTransportProtocol("audiosocket")).toBe("audiosocket");
    expect(resolveAudioTransportProtocol("chan_websocket")).toBe("chan_websocket");
    expect(() => resolveAudioTransportProtocol(undefined)).toThrow("AUDIO_TRANSPORT_PROTOCOL");
    expect(() => resolveAudioTransportProtocol("rtp")).toThrow("Unsupported AUDIO_TRANSPORT_PROTOCOL");
  });

  it("creates the selected transport server", () => {
    const handler = new CapturingCallHandler();

    expect(createAudioTransportServer({ protocol: "audiosocket", port: 0, callHandler: handler }).protocol).toBe(
      "audiosocket"
    );
    expect(createAudioTransportServer({ protocol: "chan_websocket", port: 0, callHandler: handler }).protocol).toBe(
      "chan_websocket"
    );
  });
});

describe("Configuration", () => {
  it("loads gateway env variables and defaults the port", () => {
    const configuration = Configuration.load({
      loadDotenvFile: false,
      env: {
        AUDIO_TRANSPORT_PROTOCOL: "chan_websocket",
        HOST: " 127.0.0.1 ",
        WS_PATH: "/media"
      }
    });

    expect(configuration).toMatchObject({
      audioTransportProtocol: "chan_websocket",
      host: "127.0.0.1",
      port: 8080,
      wsPath: "/media"
    });
  });

  it("validates PORT", () => {
    expect(() =>
      Configuration.load({
        loadDotenvFile: false,
        env: {
          PORT: "not-a-port"
        }
      })
    ).toThrow("PORT must be an integer");
  });
});

describe("chan_websocket control parsing", () => {
  it("parses JSON control messages", () => {
    expect(parseControlMessage('{"type":"MEDIA_START","connection_id":"abc","optimal_frame_size":320}')).toMatchObject({
      type: "MEDIA_START",
      format: "json",
      payload: {
        connection_id: "abc",
        optimal_frame_size: 320
      }
    });
  });

  it("parses plain text control messages", () => {
    expect(parseControlMessage("MEDIA_START connection_id:abc optimal_frame_size:320")).toMatchObject({
      type: "MEDIA_START",
      format: "plain-text",
      payload: {
        connection_id: "abc",
        optimal_frame_size: "320"
      }
    });
  });
});

describe("ChanWebSocketAudioTransportServer", () => {
  let server: ChanWebSocketAudioTransportServer | undefined;
  const clients: WebSocket[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.close();
    }

    await server?.stop();
    server = undefined;
  });

  it("tracks simultaneous calls and exposes incoming audio streams", async () => {
    const handler = new CapturingCallHandler();
    server = new ChanWebSocketAudioTransportServer({
      host: "127.0.0.1",
      port: 0,
      callHandler: handler
    });

    await server.start();

    const first = await connectWebSocket(`ws://127.0.0.1:${server.port}/media?connection_id=call-a`);
    const second = await connectWebSocket(`ws://127.0.0.1:${server.port}/media?connection_id=call-b`);
    clients.push(first, second);

    const firstCall = await handler.waitForCall(0);
    const secondCall = await handler.waitForCall(1);
    const firstFrame = readNextChunk(firstCall.incomingAudio);
    const secondFrame = readNextChunk(secondCall.incomingAudio);

    first.send(Buffer.from([1, 2, 3]));
    second.send(Buffer.from([4, 5]));

    await expect(firstFrame).resolves.toEqual(Buffer.from([1, 2, 3]));
    await expect(secondFrame).resolves.toEqual(Buffer.from([4, 5]));

    expect(server.activeCalls.map((call) => call.id)).toEqual(expect.arrayContaining(["call-a", "call-b"]));
    expect(firstCall.stats.bytesReceived).toBe(3);
    expect(secondCall.stats.bytesReceived).toBe(2);
  });

  it("normalizes control notifications and rekeys calls from MEDIA_START", async () => {
    const handler = new CapturingCallHandler();
    server = new ChanWebSocketAudioTransportServer({
      host: "127.0.0.1",
      port: 0,
      callHandler: handler
    });

    await server.start();

    const client = await connectWebSocket(`ws://127.0.0.1:${server.port}/media?connection_id=temp-call`);
    clients.push(client);

    const call = await handler.waitForCall();
    const mediaStarted = waitForNotification(call, (notification) => notification.type === "media_started");

    client.send(
      JSON.stringify({
        type: "MEDIA_START",
        connection_id: "call-json",
        format: "slin16",
        optimal_frame_size: 640,
        ptime: 20
      })
    );

    await expect(mediaStarted).resolves.toMatchObject({
      type: "media_started",
      name: "MEDIA_START",
      payload: {
        connection_id: "call-json"
      }
    });
    expect(call.id).toBe("call-json");
    expect(call.format).toMatchObject({
      raw: "slin16",
      sampleRateHz: 16000,
      frameSizeBytes: 640,
      ptimeMs: 20
    });
    expect(server.activeCalls.map((activeCall) => activeCall.id)).toEqual(["call-json"]);
  });

  it("writes outbound audio and serializes supported commands", async () => {
    const handler = new CapturingCallHandler();
    server = new ChanWebSocketAudioTransportServer({
      host: "127.0.0.1",
      port: 0,
      callHandler: handler
    });

    await server.start();

    const client = await connectWebSocket(`ws://127.0.0.1:${server.port}/media?connection_id=call-out`);
    clients.push(client);
    const call = await handler.waitForCall();

    const outboundAudio = waitForWebSocketMessage(client);
    call.outgoingAudio.write(Buffer.from([9, 8, 7]));
    await expect(outboundAudio).resolves.toEqual({
      data: Buffer.from([9, 8, 7]),
      isBinary: true
    });

    const outboundCommand = waitForWebSocketMessage(client);
    await expect(call.sendCommand({ type: "answer" })).resolves.toMatchObject({ ok: true });
    await expect(outboundCommand).resolves.toEqual({
      data: Buffer.from("ANSWER"),
      isBinary: false
    });

    expect(call.supportsCommand("pause_media")).toBe(true);
    await expect(call.sendCommand({ type: "unsupported_command" })).resolves.toMatchObject({
      ok: false,
      unsupported: true
    });
  });
});

describe("AudioSocketTransportServer", () => {
  let server: AudioSocketTransportServer | undefined;
  const clients: net.Socket[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.destroy();
    }

    await server?.stop();
    server = undefined;
  });

  it("reassembles packets, rekeys UUID sessions, and exposes incoming audio", async () => {
    const handler = new CapturingCallHandler();
    server = new AudioSocketTransportServer({
      host: "127.0.0.1",
      port: 0,
      callHandler: handler
    });

    await server.start();

    const client = await connectTcp(server.port);
    clients.push(client);
    const call = await handler.waitForCall();

    const uuid = "11111111-2222-3333-4444-555555555555";
    const uuidPacket = encodeAudioSocketPacket(AUDIO_SOCKET_PACKET_TYPES.UUID, uuidStringToAudioSocketPayload(uuid));
    const audioPacket = encodeAudioSocketPacket(AUDIO_SOCKET_PACKET_TYPES.SLIN_16KHZ, Buffer.from([1, 2, 3, 4]));
    const uuidNotification = waitForNotification(
      call,
      (notification) => notification.type === "control" && notification.name === "UUID"
    );
    const inboundAudio = readNextChunk(call.incomingAudio);

    client.write(uuidPacket.subarray(0, 5));
    client.write(Buffer.concat([uuidPacket.subarray(5), audioPacket]));

    await expect(uuidNotification).resolves.toMatchObject({
      callId: uuid,
      payload: { uuid }
    });
    await expect(inboundAudio).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
    expect(call.id).toBe(uuid);
    expect(call.format).toMatchObject({
      encoding: "signed-linear-16",
      sampleRateHz: 16000
    });
    expect(server.activeCalls.map((activeCall) => activeCall.id)).toEqual([uuid]);
  });

  it("maps DTMF, error, and hangup packets to notifications", async () => {
    const handler = new CapturingCallHandler();
    server = new AudioSocketTransportServer({
      host: "127.0.0.1",
      port: 0,
      callHandler: handler
    });

    await server.start();

    const client = await connectTcp(server.port);
    clients.push(client);
    const call = await handler.waitForCall();

    const dtmf = waitForNotification(call, (notification) => notification.type === "dtmf");
    client.write(encodeAudioSocketPacket(AUDIO_SOCKET_PACKET_TYPES.DTMF, Buffer.from("5", "ascii")));
    await expect(dtmf).resolves.toMatchObject({
      type: "dtmf",
      payload: { digit: "5" }
    });

    const error = waitForNotification(call, (notification) => notification.type === "error");
    client.write(encodeAudioSocketPacket(AUDIO_SOCKET_PACKET_TYPES.ERROR, Buffer.from([0x42])));
    await expect(error).resolves.toMatchObject({
      type: "error",
      payload: { code: 0x42 }
    });

    const hangup = waitForNotification(call, (notification) => notification.type === "hangup");
    client.write(encodeAudioSocketPacket(AUDIO_SOCKET_PACKET_TYPES.TERMINATE));
    await expect(hangup).resolves.toMatchObject({
      type: "hangup",
      name: "HANGUP"
    });
  });

  it("frames outbound audio and reports unsupported commands", async () => {
    const handler = new CapturingCallHandler();
    server = new AudioSocketTransportServer({
      host: "127.0.0.1",
      port: 0,
      callHandler: handler
    });

    await server.start();

    const client = await connectTcp(server.port);
    clients.push(client);
    const call = await handler.waitForCall();

    const outboundAudio = readNextSocketData(client);
    call.outgoingAudio.write(Buffer.from([9, 8, 7, 6]));
    const decodedAudio = decodeAudioSocketPackets(await outboundAudio);
    expect(decodedAudio.packets).toHaveLength(1);
    expect(decodedAudio.packets[0]).toMatchObject({
      type: AUDIO_SOCKET_PACKET_TYPES.SLIN_8KHZ,
      payload: Buffer.from([9, 8, 7, 6])
    });

    expect(call.supportsCommand("pause_media")).toBe(false);
    await expect(call.sendCommand({ type: "pause_media" })).resolves.toMatchObject({
      ok: false,
      unsupported: true
    });

    const hangupPacket = readNextSocketData(client);
    await expect(call.sendCommand({ type: "hangup" })).resolves.toMatchObject({ ok: true });
    expect(await hangupPacket).toEqual(encodeAudioSocketPacket(AUDIO_SOCKET_PACKET_TYPES.TERMINATE));
  });
});

async function connectWebSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function connectTcp(port: number | undefined): Promise<net.Socket> {
  if (port === undefined) {
    throw new Error("server did not expose a listening port");
  }

  const socket = net.createConnection({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function readNextChunk(readable: Readable): Promise<Buffer> {
  const existing = readable.read();
  if (existing) {
    return Buffer.from(existing);
  }

  return new Promise<Buffer>((resolve, reject) => {
    const cleanup = (): void => {
      readable.off("data", onData);
      readable.off("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      cleanup();
      resolve(Buffer.from(chunk));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    readable.once("data", onData);
    readable.once("error", onError);
  });
}

async function waitForNotification(
  call: AudioCallContext,
  predicate: (notification: TransportNotification) => boolean
): Promise<TransportNotification> {
  const deadline = Date.now() + 1000;

  for await (const notification of call.notifications) {
    if (predicate(notification)) {
      return notification;
    }

    if (Date.now() > deadline) {
      break;
    }
  }

  throw new Error("notification was not received before timeout");
}

async function waitForWebSocketMessage(socket: WebSocket): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    const onMessage = (data: RawData, isBinary: boolean): void => {
      cleanup();
      resolve({ data: rawDataToBuffer(data), isBinary });
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    socket.once("message", onMessage);
    socket.once("error", onError);
  });
}

async function readNextSocketData(socket: net.Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      cleanup();
      resolve(Buffer.from(chunk));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    socket.once("data", onData);
    socket.once("error", onError);
  });
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }

  return Buffer.from(data as ArrayBuffer);
}
