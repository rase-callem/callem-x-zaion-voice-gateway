import { randomUUID } from "crypto";

export function createCallId(): string {
  return randomUUID();
}
