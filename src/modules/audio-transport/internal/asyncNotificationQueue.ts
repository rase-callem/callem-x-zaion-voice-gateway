import type { TransportNotification } from "../types";

type NotificationResult = IteratorResult<TransportNotification>;

export class AsyncNotificationQueue implements AsyncIterable<TransportNotification> {
  private readonly buffered: TransportNotification[] = [];
  private readonly waiters: Array<{
    resolve: (result: NotificationResult) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed = false;

  push(notification: TransportNotification): void {
    if (this.closed) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: notification });
      return;
    }

    this.buffered.push(notification);
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ done: true, value: undefined });
    }
  }

  fail(error: Error): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<TransportNotification> {
    return {
      next: (): Promise<NotificationResult> => {
        const notification = this.buffered.shift();
        if (notification) {
          return Promise.resolve({ done: false, value: notification });
        }

        if (this.closed) {
          return Promise.resolve({ done: true, value: undefined });
        }

        return new Promise<NotificationResult>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      }
    };
  }
}
