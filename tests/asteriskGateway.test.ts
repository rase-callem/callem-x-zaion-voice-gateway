import WebSocket from "ws";
import { AsteriskWebSocketGateway, parseControlMessage } from "../src/asteriskGateway";

describe("parseControlMessage", () => {
  it("parses JSON chan_websocket control messages", () => {
    expect(parseControlMessage('{"type":"MEDIA_START","connection_id":"abc","optimal_frame_size":320}')).toMatchObject({
      type: "MEDIA_START",
      payload: {
        connection_id: "abc",
        optimal_frame_size: 320
      }
    });
  });

  it("parses plain text chan_websocket control messages", () => {
    expect(parseControlMessage("MEDIA_START connection_id:abc optimal_frame_size:320")).toMatchObject({
      type: "MEDIA_START",
      payload: {
        connection_id: "abc",
        optimal_frame_size: "320"
      }
    });
  });
});

describe("AsteriskWebSocketGateway", () => {
  let gateway: AsteriskWebSocketGateway;

  afterEach(async () => {
    await gateway?.stop();
  });

  it("tracks multiple simultaneous calls independently", async () => {
    gateway = new AsteriskWebSocketGateway({ port: 0 });
    const mediaEvents: Array<{ callId: string; bytes: number }> = [];

    gateway.on("media", (session, frame) => {
      mediaEvents.push({ callId: session.id, bytes: frame.byteLength });
    });

    await gateway.start();
    const port = gateway.port;
    expect(port).toBeDefined();

    const first = await connect(`ws://127.0.0.1:${port}/media?connection_id=call-a`);
    const second = await connect(`ws://127.0.0.1:${port}/media?connection_id=call-b`);

    first.send(Buffer.from([1, 2, 3]));
    second.send(Buffer.from([4, 5]));

    await waitFor(() => mediaEvents.length === 2);

    expect(gateway.activeCalls).toHaveLength(2);
    expect(mediaEvents).toEqual(
      expect.arrayContaining([
        { callId: "call-a", bytes: 3 },
        { callId: "call-b", bytes: 2 }
      ])
    );

    first.close();
    second.close();
  });
});

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("condition was not met before timeout");
}
