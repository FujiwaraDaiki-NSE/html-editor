import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { codexReducer, initialCodexState } from "../app/codex/reducer.ts";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/codex-events.json", import.meta.url), "utf8"),
);

function replay(events) {
  return events.reduce(
    (state, event) => codexReducer(state, { type: "event", ...event }),
    initialCodexState,
  );
}

test("replaying a saved event stream is deterministic and normalizes state", () => {
  const first = replay(fixture);
  const second = replay(fixture);
  assert.deepEqual(first, second);
  assert.equal(first.threads["thread-1"].turnIds[0], "turn-1");
  assert.equal(first.turns["turn-1"].status, "completed");
  assert.equal(first.items["message-1"].text, "Hello");
  assert.equal(first.items["reasoning-1"].reasoning[0], "Checking the deck.");
  assert.match(first.items["file-1"].diff, /deck\.json[\s\S]*--- a/);
  assert.equal(first.items["command-1"].type, "commandExecution");
  assert.equal(first.items["tool-1"].type, "mcpToolCall");
  assert.equal(first.items["future-1"].type, "futureItem");
});

test("delta before item/started is preserved", () => {
  const state = replay(fixture.slice(0, 4));
  assert.equal(state.items["message-1"].text, "Hello");
  assert.equal(state.items["message-1"].type, "agentMessage");
});

test("started events arriving after completion do not regress terminal state", () => {
  let state = replay(fixture.slice(0, 2));
  state = codexReducer(state, {
    type: "event",
    sequence: 50,
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "late", type: "agentMessage", status: "completed", text: "Final" },
    },
  });
  state = codexReducer(state, {
    type: "event",
    sequence: 51,
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "late", type: "agentMessage", status: "running" },
    },
  });
  assert.equal(state.items.late.status, "completed");
  assert.equal(state.items.late.text, "Final");
});

test("duplicate envelopes are idempotent", () => {
  const duplicated = fixture.flatMap((event) => [event, event]);
  assert.deepEqual(replay(duplicated), replay(fixture));
});

test("unknown events are retained without breaking known state", () => {
  const state = codexReducer(replay(fixture), {
    type: "event",
    sequence: 99,
    method: "future/event",
    params: { value: true },
  });
  assert.equal(state.unknownEvents.at(-1)?.method, "future/event");
  assert.equal(state.turns["turn-1"].status, "completed");
});

test("large command output is bounded and marked truncated", () => {
  let state = replay(fixture.slice(0, 2));
  state = codexReducer(state, {
    type: "event",
    sequence: 100,
    method: "item/commandExecution/outputDelta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "huge-command",
      delta: "x".repeat(150_000),
    },
  });
  assert.equal(state.items["huge-command"].output.length, 100_000);
  assert.equal(state.items["huge-command"].outputTruncated, true);
});

test("restores active per-Thread turn state after a page reload", () => {
  const state = codexReducer(initialCodexState, {
    type: "activeTurns",
    activeTurns: { "thread-live": "turn-live" },
  });
  assert.equal(state.activeThreadId, "thread-live");
  assert.equal(state.activeTurnId, "turn-live");
  assert.equal(state.turns["turn-live"].status, "running");
});

test("interruption finalizes both the Turn and its running Items", () => {
  let state = replay(fixture.slice(0, 4));
  state = codexReducer(state, {
    type: "event",
    sequence: 90,
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted" },
    },
  });
  assert.equal(state.turns["turn-1"].status, "interrupted");
  assert.equal(state.items["message-1"].status, "interrupted");
  assert.equal(state.activeTurnId, null);
});
