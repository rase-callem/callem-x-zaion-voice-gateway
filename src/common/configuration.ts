import { config as loadDotenv } from "dotenv";

export interface ConfigurationLoadOptions {
  env?: Record<string, string | undefined>;
  loadDotenvFile?: boolean;
}

export class Configuration {
  readonly audioTransportProtocol?: string;
  readonly host?: string;
  readonly port: number;
  readonly wsPath?: string;

  private constructor(values: {
    audioTransportProtocol?: string;
    host?: string;
    port: number;
    wsPath?: string;
  }) {
    this.audioTransportProtocol = values.audioTransportProtocol;
    this.host = values.host;
    this.port = values.port;
    this.wsPath = values.wsPath;
  }

  static load(options: ConfigurationLoadOptions = {}): Configuration {
    if (options.loadDotenvFile ?? true) {
      loadDotenv();
    }

    const env = options.env ?? process.env;

    return new Configuration({
      audioTransportProtocol: optionalEnv(env.AUDIO_TRANSPORT_PROTOCOL),
      host: optionalEnv(env.HOST),
      port: parsePort(env.PORT),
      wsPath: optionalEnv(env.WS_PATH)
    });
  }
}

function optionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parsePort(value: string | undefined): number {
  const rawValue = value ?? "8080";
  const port = Number(rawValue);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535. Received "${rawValue}"`);
  }

  return port;
}
