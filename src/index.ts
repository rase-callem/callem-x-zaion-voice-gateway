import "dotenv/config";
import { AsteriskWebSocketGateway } from "./asteriskGateway";

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST;
const path = process.env.WS_PATH || undefined;
const echoMedia = process.env.ECHO_MEDIA === "true";

const gateway = new AsteriskWebSocketGateway({
  host,
  port,
  path,
  echoMedia,
  logger: console
});

gateway.on("control", (session, message) => {
  console.info({
    event: "control",
    callId: session.id,
    type: message.type,
    payload: message.payload
  });
});

gateway.on("media", (session, frame) => {
  console.debug({
    event: "media",
    callId: session.id,
    bytes: frame.byteLength,
    framesReceived: session.framesReceived
  });
});

gateway.start().catch((error) => {
  console.error("failed to start Asterisk WebSocket gateway", error);
  process.exitCode = 1;
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown(): void {
  gateway
    .stop()
    .catch((error) => console.error("failed to stop Asterisk WebSocket gateway", error))
    .finally(() => process.exit(0));
}
