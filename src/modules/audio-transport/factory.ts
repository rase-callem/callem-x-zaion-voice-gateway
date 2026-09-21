import { AudioSocketTransportServer } from "./audiosocket";
import { ChanWebSocketAudioTransportServer } from "./chan-websocket";
import type { CallHandler } from "../call-handler";
import type { Logger } from "../../common";
import type { AudioTransportProtocol, AudioTransportServer } from "./types";

export interface CreateAudioTransportServerOptions {
  protocol?: string;
  host?: string;
  port: number;
  path?: string;
  logger?: Logger;
  callHandler: CallHandler;
}

export function createAudioTransportServer(options: CreateAudioTransportServerOptions): AudioTransportServer {
  const protocol = resolveAudioTransportProtocol(options.protocol);

  if (protocol === "audiosocket") {
    return new AudioSocketTransportServer({
      host: options.host,
      port: options.port,
      logger: options.logger,
      callHandler: options.callHandler
    });
  }

  return new ChanWebSocketAudioTransportServer({
    host: options.host,
    port: options.port,
    path: options.path,
    logger: options.logger,
    callHandler: options.callHandler
  });
}

export function resolveAudioTransportProtocol(value: string | undefined): AudioTransportProtocol {
  if (value === "audiosocket" || value === "chan_websocket") {
    return value;
  }

  if (!value) {
    throw new Error("AUDIO_TRANSPORT_PROTOCOL is required and must be audiosocket or chan_websocket");
  }

  throw new Error(`Unsupported AUDIO_TRANSPORT_PROTOCOL "${value}". Expected audiosocket or chan_websocket`);
}
