import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ServerRequestRouter } from "../server/codex/request-router.mjs";
import {
  UiToolBridge,
  UI_TOOL_NAMESPACE,
  uiDynamicTools,
} from "../server/codex/ui-tools.mjs";

class FakeClient extends EventEmitter {
  responses = [];
  errors = [];

  respond(id, result) { this.responses.push({ id, result }); }
  respondError(id, code, message) { this.errors.push({ id, code, message }); }
}

function request(id = 7, overrides = {}) {
  return {
    id,
    method: "item/tool/call",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: `call-${id}`,
      namespace: UI_TOOL_NAMESPACE,
      tool: "inspect",
      arguments: { target: null },
      ...overrides,
    },
  };
}

test("registers semantic browser tools with the experimental dynamic-tool contract", () => {
  const [namespace] = uiDynamicTools({ purpose: "chat" });
  assert.equal(namespace.type, "namespace");
  assert.equal(namespace.name, UI_TOOL_NAMESPACE);
  assert.deepEqual(namespace.tools.map(({ name }) => name), ["inspect", "click", "fill", "select", "key", "edit_slides"]);
  assert.deepEqual(namespace.tools.find(({ name }) => name === "inspect").inputSchema.required, ["target"]);
  assert.deepEqual(namespace.tools.find(({ name }) => name === "select").inputSchema.required, ["target", "value"]);
  assert.deepEqual(namespace.tools.find(({ name }) => name === "edit_slides").inputSchema.required, ["prompt", "scope", "execution", "allowSkillChanges"]);
  assert.deepEqual(uiDynamicTools({ purpose: "editor" }), []);
});

test("dispatches one correlated browser request and returns the original JSON-RPC id", () => {
  const events = [];
  let ids = 0;
  const bridge = new UiToolBridge({
    events: { publish: (type, payload) => events.push({ type, payload }) },
    idFactory: () => ids++ === 0 ? "session-1" : "browser-request-1",
    tokenFactory: () => "token-1",
  });
  const session = bridge.registerSession({ threadId: "thread-1" });
  const responses = [];
  bridge.dispatch(request(17), (id, result) => responses.push({ id, result }));
  const requested = events.find(({ payload }) => payload.phase === "requested").payload;
  assert.equal(requested.sessionId, session.sessionId);
  assert.deepEqual(requested.request, {
    version: 1,
    requestId: "browser-request-1",
    operation: "inspect",
    target: null,
  });

  const result = {
    version: 1,
    requestId: "browser-request-1",
    operation: "inspect",
    status: "completed",
    target: null,
    controls: [{ id: "projects", role: "button" }],
    outcome: { eventDispatched: false },
    error: null,
  };
  bridge.respond({ sessionId: session.sessionId, token: session.token, response: result });
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, 17);
  assert.equal(responses[0].result.success, true);
  assert.match(responses[0].result.contentItems[0].text, /projects/);
  assert.equal(events.filter(({ payload }) => payload.phase === "completed").length, 1);
});

test("isolates active browser sessions and rejects a response from a different session", () => {
  const bridge = new UiToolBridge({ idFactory: (() => { let i = 0; return () => `session-${++i}`; })(), tokenFactory: (() => { let i = 0; return () => `token-${++i}`; })() });
  const first = bridge.registerSession({ threadId: "thread-1" });
  assert.throws(() => bridge.registerSession({ threadId: "thread-1" }), { code: "WEAVE_UI_OWNERSHIP_REQUIRED" });
  const second = bridge.registerSession({ threadId: "thread-1", claim: true });
  assert.equal(bridge.snapshot().sessions.find(({ sessionId }) => sessionId === first.sessionId).activeThreadId, null);
  assert.equal(bridge.snapshot().sessions.find(({ sessionId }) => sessionId === second.sessionId).activeThreadId, "thread-1");
  assert.throws(() => bridge.touchSession({ sessionId: first.sessionId, token: first.token, threadId: "thread-1" }), { code: "WEAVE_UI_OWNERSHIP_REQUIRED" });
  bridge.dispatch(request(1), () => {});
  const requestId = bridge.snapshot().pending[0].requestId;
  assert.throws(() => bridge.respond({
    sessionId: first.sessionId,
    token: first.token,
    response: { requestId, status: "completed", error: null },
  }), { code: "WEAVE_UI_SESSION_MISMATCH" });
  bridge.touchSession({ sessionId: first.sessionId, token: first.token, threadId: "thread-1", claim: true });
  assert.throws(() => bridge.touchSession({ sessionId: second.sessionId, token: second.token, threadId: "thread-1" }), { code: "WEAVE_UI_OWNERSHIP_REQUIRED" });
  bridge.cancelAll();
});

test("rejects duplicate calls without dispatching the browser action again", () => {
  const bridge = new UiToolBridge({ idFactory: () => "session", tokenFactory: () => "token" });
  const session = bridge.registerSession({ threadId: "thread-1" });
  let count = 0;
  bridge.on("event", ({ payload: event }) => { if (event.phase === "requested") count += 1; });
  const payload = request(9, { callId: "same-call" });
  bridge.dispatch(payload, () => {});
  assert.equal(bridge.dispatch(payload, () => {}).accepted, false);
  const requestId = bridge.snapshot().pending[0].requestId;
  bridge.respond({ sessionId: session.sessionId, token: session.token, response: { requestId, status: "completed", target: null, controls: [], outcome: null, error: null } });
  assert.equal(count, 1);
  assert.equal(bridge.dispatch(payload, () => {}).accepted, false);
});

test("times out a pending request and refuses a late browser response", async () => {
  const bridge = new UiToolBridge({ timeoutMs: 5, idFactory: () => "session", tokenFactory: () => "token" });
  const session = bridge.registerSession({ threadId: "thread-1" });
  const responses = [];
  bridge.dispatch(request(2), (id, result) => responses.push({ id, result }));
  const requestId = bridge.snapshot().pending[0].requestId;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(responses[0].id, 2);
  assert.equal(responses[0].result.success, false);
  assert.throws(() => bridge.respond({ sessionId: session.sessionId, token: session.token, response: { requestId, status: "completed" } }), { code: "WEAVE_UI_REPLAY" });
});

test("cancels old-thread requests when a browser session rebinds and rejects concurrent actions", () => {
  let ids = 0;
  const bridge = new UiToolBridge({ idFactory: () => `id-${++ids}`, tokenFactory: () => "token" });
  const session = bridge.registerSession({ threadId: "thread-1" });
  const responses = [];
  bridge.dispatch(request(20), (id, result) => responses.push({ id, result }));
  assert.equal(bridge.dispatch(request(21, { turnId: "turn-2", callId: "call-21" }), () => {}).accepted, false);
  const oldRequestId = bridge.snapshot().pending[0].requestId;
  bridge.touchSession({ sessionId: session.sessionId, token: session.token, threadId: "thread-2", claim: true });
  assert.equal(bridge.snapshot().pending.length, 0);
  assert.equal(responses[0].id, 20);
  assert.equal(responses[0].result.success, false);
  assert.throws(() => bridge.respond({ sessionId: session.sessionId, token: session.token, response: { requestId: oldRequestId, status: "completed" } }), { code: "WEAVE_UI_SESSION_MISMATCH" });
});

test("keeps completed call tombstones beyond the session idle TTL", () => {
  let now = 0;
  let ids = 0;
  const bridge = new UiToolBridge({ sessionTtlMs: 10, now: () => now, idFactory: () => `id-${++ids}`, tokenFactory: () => "token" });
  const session = bridge.registerSession({ threadId: "thread-1" });
  const payload = request(30, { callId: "long-lived-call" });
  bridge.dispatch(payload, () => {});
  const requestId = bridge.snapshot().pending[0].requestId;
  bridge.respond({ sessionId: session.sessionId, token: session.token, response: { requestId, status: "completed", target: null, controls: [], outcome: null, error: null } });
  now = 100;
  assert.equal(bridge.dispatch(payload, () => {}).accepted, false);
});

test("does not correlate a delayed browser response with a reused JSON-RPC id", () => {
  let ids = 0;
  const bridge = new UiToolBridge({ idFactory: () => `id-${++ids}`, tokenFactory: () => "token" });
  const session = bridge.registerSession({ threadId: "thread-1" });
  const first = [];
  bridge.dispatch(request(40), (id, result) => first.push({ id, result }));
  const oldRequestId = bridge.snapshot().pending[0].requestId;
  bridge.cancelAll("connection reset");
  const second = [];
  bridge.dispatch(request(40, { turnId: "turn-2", callId: "call-40-2" }), (id, result) => second.push({ id, result }));
  const newRequestId = bridge.snapshot().pending[0].requestId;
  assert.notEqual(oldRequestId, newRequestId);
  assert.throws(() => bridge.respond({ sessionId: session.sessionId, token: session.token, response: { requestId: oldRequestId, status: "completed" } }), { code: "WEAVE_UI_REPLAY" });
  assert.equal(bridge.snapshot().pending[0].requestId, newRequestId);
  bridge.respond({ sessionId: session.sessionId, token: session.token, response: { requestId: newRequestId, status: "completed", target: null, controls: [], outcome: null, error: null } });
  assert.equal(second.length, 1);
});

test("cancels pending browser actions when their coordinator turn ends", () => {
  const bridge = new UiToolBridge({ idFactory: (() => { let i = 0; return () => `id-${++i}`; })(), tokenFactory: () => "token" });
  const session = bridge.registerSession({ threadId: "thread-1" });
  const responses = [];
  bridge.dispatch(request(41), (id, result) => responses.push({ id, result }));
  const requestId = bridge.snapshot().pending[0].requestId;
  assert.equal(bridge.cancelTurn("thread-1", "turn-1", "turn completed"), 1);
  assert.equal(bridge.snapshot().pending.length, 0);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, 41);
  assert.equal(responses[0].result.success, false);
  assert.match(responses[0].result.contentItems[0].text, /turn completed/);
  const canceled = bridge.snapshot();
  assert.equal(canceled.pending.length, 0);
  assert.throws(() => bridge.respond({ sessionId: session.sessionId, token: session.token, response: { requestId, status: "completed" } }), { code: "WEAVE_UI_REPLAY" });
});

test("routes item/tool/call to the bridge while preserving ordinary approval requests", () => {
  const client = new FakeClient();
  const seen = [];
  const router = new ServerRequestRouter(client, { onDynamicToolCall: (incoming) => seen.push(incoming) });
  client.emit("serverRequest", request(3));
  assert.equal(seen.length, 1);
  assert.equal(client.errors.length, 0);
  client.emit("serverRequest", { id: 4, method: "item/tool/requestUserInput", params: {} });
  assert.equal(router.list().length, 1);
  router.dispose();
});
