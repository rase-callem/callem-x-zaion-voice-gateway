import { Configuration } from "./common";
import { createAudioTransportServer, PlaceholderCallHandler } from "./modules";

const configuration = Configuration.load();

const server = createAudioTransportServer({
  protocol: configuration.audioTransportProtocol,
  host: configuration.host,
  port: configuration.port,
  path: configuration.wsPath,
  logger: console,
  callHandler: new PlaceholderCallHandler()
});

server.start().catch((error) => {
  console.error("failed to start audio transport server", error);
  process.exitCode = 1;
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown(): void {
  server
    .stop()
    .catch((error) => console.error("failed to stop audio transport server", error))
    .finally(() => process.exit(0));
}
