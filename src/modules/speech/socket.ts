import WebSocket from "ws";
import { aborted, asError, SpeechQueue } from "./common";

export type SpeechMessage =
  | { data: Buffer; binary: true }
  | { data: string; binary: false };

/** Owns socket listeners, bounded ingress/egress and cancellation for one provider connection. */
export class SpeechSocket {
  readonly messages: SpeechQueue<SpeechMessage>;
  private readonly ws: WebSocket;
  private disposed = false;
  private abortListener: () => void;
  private pending = new Set<(error: Error) => void>();
  readonly ready: Promise<void>;

  constructor(
    url: string,
    headers: Record<string, string>,
    private readonly signal: AbortSignal,
    private readonly timeoutMs = 15000,
    private readonly limit = 1024 * 1024
  ) {
    this.messages = new SpeechQueue(limit);
    this.ws = new WebSocket(url, {
      headers,
      maxPayload: limit,
      handshakeTimeout: timeoutMs,
      perMessageDeflate: false
    });
    this.abortListener = () => this.close(aborted());
    this.ready = new Promise<void>((resolve, reject) => {
      this.pending.add(reject);
      this.ws.once("open", () => {
        this.pending.delete(reject);
        resolve();
      });
    });
    this.ws.on("message", (data, binary) => {
      try {
        const buffer = Buffer.isBuffer(data)
          ? data
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : Buffer.concat(data);
        if (binary) {
          this.messages.push(
            {
              data: buffer,
              binary: true
            },
            buffer.length
          );
        } else {
          this.messages.push(
            {
              data: buffer.toString("utf8"),
              binary: false
            },
            buffer.length
          );
        }
      } catch (error) {
        this.close(asError(error));
      }
    });
    this.ws.on("error", error => this.close(error));
    this.ws.on("unexpected-response", (_request, response) => {
      response.resume();
      this.close(new Error(`Speech WebSocket HTTP ${response.statusCode}`));
    });
    this.ws.on("close", () => this.close(new Error("Speech provider closed the connection"), false));
    signal.addEventListener("abort", this.abortListener, { once: true });

    if (signal.aborted) {
      this.close(aborted());
    }
  }

  async send(data: string | Buffer): Promise<void> {
    await this.ready;

    if (this.disposed || this.signal.aborted) {
      throw aborted();
    }

    if (this.ws.bufferedAmount + Buffer.byteLength(data) > this.limit) {
      throw new Error("Speech input buffer limit exceeded");
    }

    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        clearTimeout(timer);
        this.pending.delete(fail);
        reject(error);
      };
      const timer = setTimeout(() => {
        const error = new Error("Speech send timed out");
        fail(error);
        this.close(error);
      }, this.timeoutMs);
      this.pending.add(fail);
      this.ws.send(data, error => {
        clearTimeout(timer);
        this.pending.delete(fail);

        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  close(error?: Error, discard = true): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.signal.removeEventListener("abort", this.abortListener);

    for (const reject of this.pending) {
      reject(error ?? aborted());
    }

    this.pending.clear();
    this.messages.end(error, discard);
    // Keep the error listener installed: terminate during CONNECTING emits an error asynchronously.
    this.ws.terminate();
  }
}
