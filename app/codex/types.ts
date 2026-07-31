/* eslint-disable @typescript-eslint/no-explicit-any -- raw fields retain generated protocol payloads for unknown-item fallback. */
export type CodexConnectionState = {
  status: "connecting" | "connected" | "reconnecting" | "disconnected" | "incompatible";
  error: string | null;
  cliVersion?: string;
};

export type ThreadState = {
  id: string;
  name: string | null;
  preview: string;
  status: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  turnIds: string[];
  raw?: Record<string, unknown>;
};

export type TurnState = {
  id: string;
  threadId: string;
  status: string;
  itemIds: string[];
  diff: string;
  error: string | null;
  raw?: Record<string, unknown>;
};

export type ItemState = {
  id: string;
  threadId: string;
  turnId: string;
  type: string;
  status: string;
  text: string;
  output: string;
  outputTruncated: boolean;
  reasoning: string[];
  diff: string;
  raw?: Record<string, unknown>;
};

export type PendingServerRequest = {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
  createdAt: number;
};

export type CodexCatalog = {
  models: unknown[];
  skills: unknown[];
  hooks: unknown[];
  mcpServers: unknown[];
  account: Record<string, unknown> | null;
  modelProvider: Record<string, unknown> | null;
};

export type CodexUIState = {
  threads: Record<string, ThreadState>;
  threadOrder: string[];
  turns: Record<string, TurnState>;
  items: Record<string, ItemState>;
  activeThreadId: string | null;
  activeTurnId: string | null;
  pendingRequests: Record<string, PendingServerRequest>;
  connection: CodexConnectionState;
  catalog: CodexCatalog;
  unknownEvents: Array<{ method: string; params: unknown }>;
  lastEventSequence: number;
};

export type CodexAction =
  | { type: "connection"; connection: Partial<CodexConnectionState> }
  | { type: "threadsLoaded"; threads: Array<Record<string, any>>; archived?: boolean }
  | { type: "threadLoaded"; thread: Record<string, any>; activate?: boolean }
  | { type: "activateThread"; threadId: string | null }
  | { type: "activeTurns"; activeTurns: Record<string, string> }
  | { type: "pendingRequests"; requests: PendingServerRequest[] }
  | { type: "catalog"; catalog: Partial<CodexCatalog> }
  | { type: "event"; method: string; params: Record<string, any>; sequence: number };
