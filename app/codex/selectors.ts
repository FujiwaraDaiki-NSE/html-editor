import type { CodexUIState, ItemState, PendingServerRequest, ThreadState, TurnState } from "./types";

export const isConversationMessage = (item: ItemState) => item.type === "agentMessage" || item.type === "userMessage";

export type PendingRequestScope = "active" | "other" | "unscoped";

export function pendingRequestThreadId(request: PendingServerRequest): string | null {
  const threadId = request.params?.threadId;
  return typeof threadId === "string" && threadId.length > 0 ? threadId : null;
}

export function pendingRequestScope(request: PendingServerRequest, activeThreadId: string | null): PendingRequestScope {
  const threadId = pendingRequestThreadId(request);
  if (!threadId) return "unscoped";
  return threadId === activeThreadId ? "active" : "other";
}

export function partitionPendingRequests(requests: PendingServerRequest[], activeThreadId: string | null) {
  return requests.reduce(
    (groups, request) => {
      groups[pendingRequestScope(request, activeThreadId)].push(request);
      return groups;
    },
    { active: [], other: [], unscoped: [] } as Record<PendingRequestScope, PendingServerRequest[]>,
  );
}

export const selectActiveThread = (state: CodexUIState): ThreadState | null =>
  state.activeThreadId ? state.threads[state.activeThreadId] ?? null : null;

export const selectThreadTurns = (state: CodexUIState, threadId: string | null): TurnState[] =>
  threadId
    ? (state.threads[threadId]?.turnIds ?? []).map((id) => state.turns[id]).filter(Boolean)
    : [];

export const selectTurnItems = (state: CodexUIState, turnId: string): ItemState[] =>
  (state.turns[turnId]?.itemIds ?? []).map((id) => state.items[id]).filter(Boolean);

export const selectThreadRunning = (state: CodexUIState, threadId: string | null) =>
  threadId
    ? selectThreadTurns(state, threadId).some((turn) => ["starting", "running", "inProgress"].includes(turn.status))
    : false;
