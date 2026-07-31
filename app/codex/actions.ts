/* eslint-disable @typescript-eslint/no-explicit-any -- app-server envelopes are versioned generated unions at the transport boundary. */
import type { CodexAction, PendingServerRequest } from "./types";

export type StreamEnvelope = {
  sequence: number;
  type: string;
  payload: any;
};

export function actionFromStreamEvent(event: StreamEnvelope): CodexAction | null {
  if (event.type === "codex/notification") {
    return {
      type: "event",
      method: event.payload?.method ?? "unknown",
      params: event.payload?.params ?? {},
      sequence: event.sequence,
    };
  }
  if (event.type === "codex/connection") {
    return { type: "connection", connection: event.payload };
  }
  if (event.type === "codex/pendingRequests") {
    return { type: "pendingRequests", requests: event.payload as PendingServerRequest[] };
  }
  if (event.type === "codex/catalog") {
    return { type: "catalog", catalog: event.payload };
  }
  return null;
}
