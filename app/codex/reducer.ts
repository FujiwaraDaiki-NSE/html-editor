/* eslint-disable @typescript-eslint/no-explicit-any -- reducer accepts forward-compatible app-server payloads and preserves unknown fields. */
import type { CodexAction, CodexUIState, ItemState, ThreadState, TurnState } from "./types";

const OUTPUT_LIMIT = 100_000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "interrupted", "canceled", "cancelled"]);

export const initialCodexState: CodexUIState = {
  threads: {},
  threadOrder: [],
  turns: {},
  items: {},
  activeThreadId: null,
  activeTurnId: null,
  pendingRequests: {},
  connection: { status: "connecting", error: null },
  catalog: { models: [], skills: [], hooks: [], mcpServers: [], account: null, modelProvider: null },
  unknownEvents: [],
  lastEventSequence: 0,
};

function threadFrom(raw: Record<string, any>, previous?: ThreadState): ThreadState {
  return {
    id: raw.id,
    name: raw.name ?? previous?.name ?? null,
    preview: raw.preview ?? previous?.preview ?? "",
    status: typeof raw.status === "string" ? raw.status : raw.status?.type ?? previous?.status ?? "idle",
    archived: raw.archived ?? previous?.archived ?? false,
    createdAt: raw.createdAt ?? previous?.createdAt ?? 0,
    updatedAt: raw.updatedAt ?? raw.recencyAt ?? previous?.updatedAt ?? 0,
    turnIds: previous?.turnIds ?? [],
    raw: { ...(previous?.raw ?? {}), ...raw },
  };
}

function turnFrom(raw: Record<string, any>, threadId: string, previous?: TurnState): TurnState {
  const incomingStatus = typeof raw.status === "string" ? raw.status : raw.status?.type;
  const status =
    previous && TERMINAL_STATUSES.has(previous.status) && !TERMINAL_STATUSES.has(incomingStatus)
      ? previous.status
      : incomingStatus ?? previous?.status ?? "running";
  return {
    id: raw.id,
    threadId,
    status,
    itemIds: previous?.itemIds ?? [],
    diff: raw.diff ?? previous?.diff ?? "",
    error: raw.error?.message ?? previous?.error ?? null,
    raw: { ...(previous?.raw ?? {}), ...raw },
  };
}

function itemFrom(raw: Record<string, any>, threadId: string, turnId: string, previous?: ItemState): ItemState {
  const contentText = Array.isArray(raw.content)
    ? raw.content.map((part: Record<string, unknown>) => part.text).filter(Boolean).join("\n")
    : "";
  const finalText =
    raw.text ??
    raw.message ??
    (contentText || null) ??
    raw.command ??
    (raw.server && raw.tool ? `${raw.server} / ${raw.tool}` : null) ??
    raw.prompt ??
    raw.review ??
    previous?.text ??
    "";
  const rawOutput =
    raw.aggregatedOutput ??
    (raw.result ? JSON.stringify(raw.result, null, 2) : null) ??
    (raw.contentItems ? JSON.stringify(raw.contentItems, null, 2) : null);
  const output = rawOutput ?? previous?.output ?? "";
  const outputTruncated = output.length > OUTPUT_LIMIT || previous?.outputTruncated === true;
  const changesDiff = Array.isArray(raw.changes)
    ? raw.changes.map(
        (change: Record<string, string>) => `${change.kind ?? "update"} ${change.path ?? ""}\n${change.diff ?? ""}`,
      ).join("\n")
    : "";
  const incomingStatus = typeof raw.status === "string" ? raw.status : raw.status?.type;
  const status =
    previous && TERMINAL_STATUSES.has(previous.status) && !TERMINAL_STATUSES.has(incomingStatus)
      ? previous.status
      : incomingStatus ?? previous?.status ?? "running";
  return {
    id: raw.id,
    threadId,
    turnId,
    type: raw.type ?? previous?.type ?? "unknown",
    status,
    text: typeof finalText === "string" ? finalText : previous?.text ?? "",
    output: output.length > OUTPUT_LIMIT ? output.slice(output.length - OUTPUT_LIMIT) : output,
    outputTruncated,
    reasoning: raw.summary ?? previous?.reasoning ?? [],
    diff: raw.diff ?? raw.patch ?? (changesDiff || null) ?? previous?.diff ?? "",
    raw: { ...(previous?.raw ?? {}), ...raw },
  };
}

function appendLimited(current: string, delta: string) {
  const combined = current + delta;
  if (combined.length <= OUTPUT_LIMIT) return { text: combined, truncated: false };
  return { text: combined.slice(combined.length - OUTPUT_LIMIT), truncated: true };
}

function ensureTurn(state: CodexUIState, threadId: string, turnId: string) {
  const turn = state.turns[turnId] ?? turnFrom({ id: turnId }, threadId);
  state.turns[turnId] = turn;
  const thread = state.threads[threadId] ?? threadFrom({ id: threadId });
  if (!thread.turnIds.includes(turnId)) thread.turnIds = [...thread.turnIds, turnId];
  state.threads[threadId] = thread;
  return turn;
}

function ensureItem(state: CodexUIState, threadId: string, turnId: string, itemId: string, raw = {}) {
  const turn = ensureTurn(state, threadId, turnId);
  const item = itemFrom({ id: itemId, ...raw }, threadId, turnId, state.items[itemId]);
  state.items[itemId] = item;
  if (!turn.itemIds.includes(itemId)) turn.itemIds = [...turn.itemIds, itemId];
  return item;
}

function hydrateThread(state: CodexUIState, raw: Record<string, any>) {
  const thread = threadFrom(raw, state.threads[raw.id]);
  state.threads[raw.id] = thread;
  for (const rawTurn of raw.turns ?? []) {
    const turn = turnFrom(rawTurn, raw.id, state.turns[rawTurn.id]);
    state.turns[turn.id] = turn;
    if (!thread.turnIds.includes(turn.id)) thread.turnIds.push(turn.id);
    for (const rawItem of rawTurn.items ?? []) {
      const item = itemFrom(
        {
          ...rawItem,
          status: rawItem.status ?? (TERMINAL_STATUSES.has(turn.status) ? "completed" : "running"),
        },
        raw.id,
        turn.id,
        state.items[rawItem.id],
      );
      state.items[item.id] = item;
      if (!turn.itemIds.includes(item.id)) turn.itemIds.push(item.id);
    }
  }
}

function applyEvent(state: CodexUIState, method: string, params: Record<string, any>) {
  const threadId = params.threadId ?? params.thread?.id ?? state.activeThreadId ?? "unknown-thread";
  const turnId = params.turnId ?? params.turn?.id ?? params.item?.turnId ?? state.activeTurnId ?? `pending:${threadId}`;
  const itemId = params.itemId ?? params.item?.id;

  if (method === "thread/started") {
    hydrateThread(state, params.thread);
    state.activeThreadId = params.thread.id;
    return;
  }
  if (method === "thread/status/changed") {
    state.threads[threadId] = threadFrom(
      { id: threadId, status: params.status },
      state.threads[threadId],
    );
    return;
  }
  if (method === "thread/name/updated") {
    state.threads[threadId] = threadFrom({ id: threadId, name: params.name }, state.threads[threadId]);
    return;
  }
  if (method === "thread/archived" || method === "thread/unarchived") {
    state.threads[threadId] = threadFrom(
      { id: threadId, archived: method === "thread/archived" },
      state.threads[threadId],
    );
    return;
  }
  if (method === "thread/deleted") {
    delete state.threads[threadId];
    state.threadOrder = state.threadOrder.filter((id) => id !== threadId);
    if (state.activeThreadId === threadId) state.activeThreadId = null;
    return;
  }
  if (method === "turn/started") {
    const turn = turnFrom(params.turn ?? { id: turnId }, threadId, state.turns[turnId]);
    state.turns[turn.id] = turn;
    ensureTurn(state, threadId, turn.id);
    state.activeThreadId = threadId;
    state.activeTurnId = turn.id;
    return;
  }
  if (method === "turn/diff/updated") {
    ensureTurn(state, threadId, turnId).diff = params.diff ?? "";
    return;
  }
  if (method === "turn/plan/updated") {
    const item = ensureItem(state, threadId, turnId, `plan:${turnId}`, { type: "plan" });
    item.text = [
      params.explanation,
      ...(params.plan ?? []).map((step: Record<string, string>) => `[${step.status}] ${step.step}`),
    ].filter(Boolean).join("\n");
    item.status = (params.plan ?? []).every((step: Record<string, string>) => step.status === "completed")
      ? "completed"
      : "running";
    return;
  }
  if (method === "turn/completed") {
    const turn = turnFrom(params.turn ?? { id: turnId }, threadId, state.turns[turnId]);
    state.turns[turn.id] = turn;
    ensureTurn(state, threadId, turn.id);
    if (turn.status === "interrupted" || turn.status === "failed") {
      for (const id of turn.itemIds) {
        const item = state.items[id];
        if (item && !TERMINAL_STATUSES.has(item.status)) item.status = turn.status;
      }
    }
    if (state.activeTurnId === turn.id) state.activeTurnId = null;
    return;
  }
  if (method === "item/started" || method === "item/completed") {
    const item = ensureItem(state, threadId, turnId, params.item.id, { ...params.item, _method: method });
    if (method === "item/completed" && item.status === "running") item.status = "completed";
    return;
  }
  if (!itemId && method.startsWith("item/")) {
    state.unknownEvents.push({ method, params });
    return;
  }
  if (method === "item/agentMessage/delta" || method === "item/plan/delta") {
    const item = ensureItem(state, threadId, turnId, itemId, {
      type: method.includes("agentMessage") ? "agentMessage" : "plan",
    });
    if (!TERMINAL_STATUSES.has(item.status) || !item.text) item.text += params.delta ?? "";
    return;
  }
  if (method === "item/reasoning/summaryPartAdded") {
    const item = ensureItem(state, threadId, turnId, itemId, { type: "reasoning" });
    const index = params.summaryIndex ?? item.reasoning.length;
    if (item.reasoning[index] === undefined) item.reasoning[index] = "";
    return;
  }
  if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
    const item = ensureItem(state, threadId, turnId, itemId, { type: "reasoning" });
    const index = params.summaryIndex ?? Math.max(0, item.reasoning.length - 1);
    item.reasoning[index] = `${item.reasoning[index] ?? ""}${params.delta ?? ""}`;
    return;
  }
  if (
    method === "item/commandExecution/outputDelta" ||
    method === "item/fileChange/outputDelta" ||
    method === "item/mcpToolCall/progress"
  ) {
    const item = ensureItem(state, threadId, turnId, itemId);
    const appended = appendLimited(item.output, params.delta ?? params.message ?? "");
    item.output = appended.text;
    item.outputTruncated ||= appended.truncated;
    return;
  }
  if (method === "item/fileChange/patchUpdated") {
    ensureItem(state, threadId, turnId, itemId, { type: "fileChange" }).diff =
      params.patch ??
      params.diff ??
      (params.changes ?? []).map(
        (change: Record<string, string>) => `${change.kind ?? "update"} ${change.path ?? ""}\n${change.diff ?? ""}`,
      ).join("\n");
    return;
  }
  state.unknownEvents.push({ method, params });
  if (state.unknownEvents.length > 100) state.unknownEvents.shift();
}

export function codexReducer(current: CodexUIState, action: CodexAction): CodexUIState {
  if (action.type === "connection") {
    return { ...current, connection: { ...current.connection, ...action.connection } };
  }
  if (action.type === "pendingRequests") {
    return {
      ...current,
      pendingRequests: Object.fromEntries(action.requests.map((request) => [String(request.id), request])),
    };
  }
  if (action.type === "catalog") {
    return { ...current, catalog: { ...current.catalog, ...action.catalog } };
  }
  if (action.type === "activateThread") return { ...current, activeThreadId: action.threadId };
  const state: CodexUIState = structuredClone(current);
  if (action.type === "activeTurns") {
    for (const [threadId, turnId] of Object.entries(action.activeTurns)) {
      ensureTurn(state, threadId, turnId).status = "running";
    }
    const selectedTurn = state.activeThreadId ? action.activeTurns[state.activeThreadId] : null;
    state.activeTurnId = selectedTurn ?? Object.values(action.activeTurns)[0] ?? null;
    if (!state.activeThreadId && state.activeTurnId) {
      state.activeThreadId = state.turns[state.activeTurnId]?.threadId ?? null;
    }
    return state;
  }
  if (action.type === "threadsLoaded") {
    state.threadOrder = [];
    for (const raw of action.threads) {
      const thread = threadFrom({ ...raw, archived: action.archived ?? raw.archived }, state.threads[raw.id]);
      state.threads[raw.id] = thread;
      state.threadOrder.push(raw.id);
    }
    if (state.activeThreadId && state.threads[state.activeThreadId] && !state.threadOrder.includes(state.activeThreadId)) {
      state.threadOrder.unshift(state.activeThreadId);
    }
    state.threadOrder.sort((a, b) => (state.threads[b]?.updatedAt ?? 0) - (state.threads[a]?.updatedAt ?? 0));
    return state;
  }
  if (action.type === "threadLoaded") {
    hydrateThread(state, action.thread);
    if (!state.threadOrder.includes(action.thread.id)) state.threadOrder.unshift(action.thread.id);
    if (action.activate) state.activeThreadId = action.thread.id;
    return state;
  }
  if (action.sequence <= current.lastEventSequence) return current;
  state.lastEventSequence = action.sequence;
  applyEvent(state, action.method, action.params);
  return state;
}
