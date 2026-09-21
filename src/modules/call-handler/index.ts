import type { AudioCallContext } from "../audio-transport/types";

export abstract class CallHandler {
  abstract handle(call: AudioCallContext): Promise<void>;
}

export class NoopCallHandler extends CallHandler {
  async handle(call: AudioCallContext): Promise<void> {
    call.incomingAudio.resume();
  }
}

export class PlaceholderCallHandler extends CallHandler {
  async handle(call: AudioCallContext): Promise<void> {
    call.incomingAudio.resume();

    for await (const notification of call.notifications) {
      console.info({
        event: "transport_notification",
        callId: notification.callId,
        protocol: notification.protocol,
        type: notification.type,
        name: notification.name,
        payload: notification.payload
      });
    }
  }
}
