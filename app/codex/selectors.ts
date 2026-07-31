import type { CodexUIState, ItemState, ThreadState, TurnState } from "./types";

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
