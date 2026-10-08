import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CodexEventStream } from "../server/codex/event-stream.mjs";
import { CodexService, turnInput, validateOAuthUrl } from "../server/codex/service.mjs";

class FakeClient extends EventEmitter {
  calls = [];
  respond() {}
  respondError() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/list") {
      return {
        data: [
          { id: "new", name: "Weave · Saved thread\u2063weave-ui-v1", cwd: "/workspace", threadSource: null },
          { id: "editor-child", name: "Weave · New conversation\u2063weave-editor-v1", cwd: "/workspace", threadSource: "weave" },
          { id: "old", name: null, cwd: "/workspace", threadSource: null },
          { id: "other", name: "Weave · Other", cwd: "/other", threadSource: null },
        ],
        nextCursor: null,
      };
    }
    if (method === "thread/read") {
      const values = {
        new: { id: "new", name: "Weave · Saved thread\u2063weave-ui-v1", cwd: "/workspace", threadSource: null, turns: [] },
        old: { id: "old", name: null, cwd: "/workspace", threadSource: null, turns: [] },
        other: { id: "other", name: "Weave · Other", cwd: "/other", threadSource: null, turns: [] },
      };
      return { thread: values[params.threadId] };
    }
    if (method === "thread/start") {
      return { thread: { id: "created", name: null, cwd: "/workspace", threadSource: "weave", turns: [] } };
    }
    if (method === "thread/name/set") return {};
    if (method === "turn/interrupt") return {};
    throw new Error(`Unexpected method: ${method}`);
  }
}

class HandshakeClient extends EventEmitter {
  calls = [];
  notifications = [];
  constructor({ initializeError = null } = {}) {
    super();
    this.initializeError = initializeError;
  }
  async start() {
    this.emit("connection", { status: "connected" });
  }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "initialize" && this.initializeError) throw this.initializeError;
    if (method === "initialize") return {};
    throw new Error(`Unexpected method: ${method}`);
  }
  notify(method, params) { this.notifications.push({ method, params }); }
  respond() {}
  respondError() {}
}

class MigrationClient extends FakeClient {
  nextThreadId = 1;
  threads = new Map([
    ["legacy", { id: "legacy", name: "Weave · Legacy conversation", cwd: "/workspace/a", threadSource: null, turns: [{ id: "old-turn", items: [] }] }],
  ]);

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/read") {
      const thread = this.threads.get(params.threadId);
      if (!thread) throw new Error(`unknown thread ${params.threadId}`);
      return { thread: structuredClone(thread) };
    }
    if (method === "thread/start") {
      const thread = { id: `continuation-${this.nextThreadId++}`, name: null, cwd: params.cwd, threadSource: "weave", turns: [] };
      this.threads.set(thread.id, thread);
      return { thread: structuredClone(thread) };
    }
    if (method === "thread/name/set") {
      const thread = this.threads.get(params.threadId);
      if (thread) thread.name = params.name;
      return {};
    }
    if (method === "thread/resume") return { thread: structuredClone(this.threads.get(params.threadId)) };
    if (method === "turn/start") return { turn: { id: `turn-${params.threadId}` } };
    throw new Error(`Unexpected method: ${method}`);
  }
}

test("lists only durably marked Weave Threads and excludes legacy/other-client Threads", async () => {
  const client = new FakeClient();
  const service = new CodexService({ projectRoot: "/workspace", workspaceRoot: "/", instructions: "test", chatInstructions: "chat test", client });
  service.ready = true;
  const result = await service.listThreads();
  assert.deepEqual(result.data.map((thread) => thread.id), ["new"]);
  service.router.dispose();
});

test("new Threads receive both app-server source and a durable name marker", async () => {
  const client = new FakeClient();
  const service = new CodexService({ projectRoot: "/workspace", workspaceRoot: "/", instructions: "test", chatInstructions: "chat test", client });
  service.ready = true;
  const thread = await service.startThread({ purpose: "chat", cwd: "/workspace" });
  assert.equal(thread.threadSource, "weave");
  assert.equal(thread.name, "Weave · New conversation");
  const startCall = client.calls.find(({ method }) => method === "thread/start");
  assert.equal(startCall.params.dynamicTools[0].name, "weave_ui");
  assert.deepEqual(startCall.params.dynamicTools[0].tools.map(({ name }) => name), ["inspect", "click", "fill", "select", "key", "edit_slides"]);
  assert.deepEqual(client.calls.at(-1), {
    method: "thread/name/set",
    params: { threadId: "created", name: "Weave · New conversation\u2063weave-ui-v1" },
  });
  service.router.dispose();
});

test("chat and editor Threads receive distinct capabilities and durable type markers", async () => {
  const client = new FakeClient();
  const service = new CodexService({ projectRoot: "/workspace", workspaceRoot: "/", instructions: "editor rules", chatInstructions: "chat rules", client });
  service.ready = true;
  await service.startThread({ purpose: "chat", cwd: "/workspace" });
  await service.startThread({ purpose: "editor", cwd: "/workspace" });
  const starts = client.calls.filter(({ method }) => method === "thread/start");
  assert.equal(starts[0].params.sandbox, "read-only");
  assert.equal(starts[0].params.baseInstructions, "chat rules");
  assert.equal(starts[0].params.dynamicTools[0].name, "weave_ui");
  assert.equal(starts[1].params.sandbox, "workspace-write");
  assert.equal(starts[1].params.baseInstructions, "editor rules");
  assert.equal(Object.hasOwn(starts[1].params, "dynamicTools"), false);
  assert.match(client.calls.filter(({ method }) => method === "thread/name/set")[1].params.name, /weave-editor-v1/);
  service.router.dispose();
});

test("presents delegated editor approvals in the parent chat while preserving child RPC context", async () => {
  const client = new FakeClient();
  const events = new CodexEventStream();
  const service = new CodexService({ projectRoot: "/workspace", workspaceRoot: "/", instructions: "editor rules", chatInstructions: "chat rules", client, eventStream: events });
  service.ready = true;
  await service.startThread({ purpose: "editor", cwd: "/workspace", parentThreadId: "chat-parent" });

  client.emit("serverRequest", {
    id: 77,
    method: "item/permissions/requestApproval",
    params: { threadId: "created", reason: "The editor needs write access." },
  });

  const pending = service.pendingRequests();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].parentThreadId, "chat-parent");
  assert.equal(pending[0].params.threadId, "created");
  const event = events.since().find((item) => item.type === "codex/pendingRequests");
  assert.equal(event.payload[0].parentThreadId, "chat-parent");
  assert.equal(event.payload[0].params.threadId, "created");

  service.router.resolve(77, { permissions: {}, scope: "turn" });
  assert.deepEqual(service.pendingRequests(), []);
  service.router.dispose();
});

test("legacy chat Threads migrate into the requested project and preserve history", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new MigrationClient();
  const service = new CodexService({ projectRoot: "/workspace/a", workspaceRoot: "/workspace", instructions: "editor rules", chatInstructions: "chat rules", client });
  service.ready = true;
  const ensured = await service.ensureChatThread("legacy", { cwd: "/workspace/b" });
  assert.equal(ensured.migrated, true);
  assert.equal(ensured.sourceThreadId, "legacy");
  assert.equal(ensured.thread.cwd, "/workspace/b");
  const result = await service.startTurn({ threadId: ensured.thread.id, prompt: "continue", clientUserMessageId: "migrate-1", purpose: "chat", cwd: "/workspace/b" });
  assert.equal(result.turn.id, `turn-${ensured.thread.id}`);
  const turnStart = client.calls.at(-1);
  assert.equal(turnStart.method, "turn/start");
  assert.match(turnStart.params.input[0].text, /Preserved conversation history from legacy/);
  assert.match(turnStart.params.input[0].text, /old-turn/);
  assert.match(turnStart.params.input[0].text, /Current user request:\ncontinue/);
  service.router.dispose();
});

test("thread listing searches the workspace and retains a continued chat after a project switch", async () => {
  const client = new MigrationClient();
  const service = new CodexService({ projectRoot: "/workspace/a", workspaceRoot: "/workspace", instructions: "editor rules", chatInstructions: "chat rules", client });
  service.ready = true;
  const ensured = await service.ensureChatThread("legacy", { cwd: "/workspace/b" });
  client.request = async (method, params) => {
    client.calls.push({ method, params });
    if (method === "thread/list") return { data: [{ ...client.threads.get(ensured.thread.id) }], nextCursor: null };
    if (method === "thread/read") return { thread: structuredClone(client.threads.get(params.threadId)) };
    throw new Error(`Unexpected method: ${method}`);
  };
  const result = await service.listThreads();
  assert.deepEqual(result.data.map((thread) => thread.id), [ensured.thread.id]);
  assert.equal(client.calls.find(({ method }) => method === "thread/list").params.cwd, null);
  service.router.dispose();
});

test("edit_slides delegates only from an active chat turn and rejects replay", async () => {
  const client = new FakeClient();
  const responses = [];
  client.respond = (id, result) => responses.push({ id, result });
  const calls = [];
  const service = new CodexService({
    projectRoot: "/workspace",
    workspaceRoot: "/",
    instructions: "editor rules",
    chatInstructions: "chat rules",
    client,
    editSlidesHandler: async (params, args) => {
      calls.push({ params, args });
      return { success: true, result: { changed: ["slide-1"] } };
    },
  });
  service.activeTurns.set("chat-1", "turn-1");
  service.turnPurposes.set("chat-1", "chat");
  const request = {
    id: 91,
    method: "item/tool/call",
    params: {
      threadId: "chat-1",
      turnId: "turn-1",
      callId: "edit-call-1",
      namespace: "weave_ui",
      tool: "edit_slides",
      arguments: {
        prompt: "Update the title",
        scope: { kind: "element", slideIds: ["slide-1"], elementId: "title" },
        execution: "apply",
        allowSkillChanges: false,
      },
    },
  };
  await service.handleDynamicToolCall(request);
  await service.handleDynamicToolCall({ ...request, id: 92 });
  assert.equal(calls.length, 1);
  assert.equal(responses.length, 2);
  assert.equal(responses[0].id, 91);
  assert.equal(responses[0].result.success, true);
  assert.equal(responses[1].id, 92);
  assert.equal(responses[1].result.success, false);
  assert.match(responses[1].result.contentItems[0].text, /already been handled/);
  service.router.dispose();
});

test("rejects a browser UI call that arrives after its chat turn completed", async () => {
  const client = new FakeClient();
  const responses = [];
  client.respond = (id, result) => responses.push({ id, result });
  const service = new CodexService({
    projectRoot: "/workspace",
    workspaceRoot: "/",
    instructions: "editor rules",
    chatInstructions: "chat rules",
    client,
  });
  service.activeTurns.set("chat-1", "turn-1");
  service.turnPurposes.set("chat-1", "chat");
  let dispatches = 0;
  const dispatch = service.uiTools.dispatch.bind(service.uiTools);
  service.uiTools.dispatch = (...args) => {
    dispatches += 1;
    return dispatch(...args);
  };
  service.handleNotification({
    method: "turn/completed",
    params: { threadId: "chat-1", turn: { id: "turn-1", status: "completed" } },
  });
  const result = await service.handleDynamicToolCall({
    id: 93,
    method: "item/tool/call",
    params: {
      threadId: "chat-1",
      turnId: "turn-1",
      callId: "late-browser-call",
      namespace: "weave_ui",
      tool: "click",
      arguments: { target: { id: "create-project" } },
    },
  });
  assert.equal(result.accepted, false);
  assert.equal(dispatches, 0);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, 93);
  assert.equal(responses[0].result.success, false);
  assert.match(responses[0].result.contentItems[0].text, /active chat coordinator turn/);
  service.router.dispose();
});

test("cancels an accepted browser UI call when its chat turn completes", async () => {
  const client = new FakeClient();
  const responses = [];
  client.respond = (id, result) => responses.push({ id, result });
  const service = new CodexService({
    projectRoot: "/workspace",
    workspaceRoot: "/",
    instructions: "editor rules",
    chatInstructions: "chat rules",
    client,
  });
  service.activeTurns.set("chat-1", "turn-1");
  service.turnPurposes.set("chat-1", "chat");
  service.uiTools.registerSession({ threadId: "chat-1" });
  const accepted = await service.handleDynamicToolCall({
    id: 94,
    method: "item/tool/call",
    params: {
      threadId: "chat-1",
      turnId: "turn-1",
      callId: "pending-browser-call",
      namespace: "weave_ui",
      tool: "click",
      arguments: { target: { id: "create-project" } },
    },
  });
  assert.equal(accepted.accepted, true);
  assert.equal(service.uiTools.snapshot().pending.length, 1);
  service.handleNotification({
    method: "turn/completed",
    params: { threadId: "chat-1", turn: { id: "turn-1", status: "interrupted" } },
  });
  assert.equal(service.uiTools.snapshot().pending.length, 0);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, 94);
  assert.equal(responses[0].result.success, false);
  service.router.dispose();
});

test("sending after restart resumes the saved thread before starting a turn", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new FakeClient();
  const originalRequest = client.request.bind(client);
  let loaded = false;
  client.request = async (method, params) => {
    if (method === "thread/resume") {
      client.calls.push({ method, params });
      loaded = true;
      return { thread: { id: params.threadId } };
    }
    if (method === "turn/start") {
      client.calls.push({ method, params });
      if (!loaded) throw new Error(`thread not found: ${params.threadId}`);
      return { turn: { id: "resumed-turn" } };
    }
    return originalRequest(method, params);
  };
  const service = new CodexService({ projectRoot: "/workspace", workspaceRoot: "/", instructions: "current rules", chatInstructions: "chat rules", client });
  t.after(() => service.router.dispose());
  const result = await service.startTurn({ threadId: "new", prompt: "continue", clientUserMessageId: "message-1", purpose: "chat", cwd: "/workspace" });
  assert.equal(result.turn.id, "resumed-turn");
  assert.deepEqual(client.calls.map(({ method }) => method), ["thread/read", "thread/resume", "turn/start"]);
  assert.deepEqual(client.calls[1].params, { threadId: "new", cwd: "/workspace", baseInstructions: "chat rules" });
  assert.equal(client.calls[2].params.threadId, "new");
});

test("a failed resume does not start a turn or replace the saved thread", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new FakeClient();
  const originalRequest = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === "thread/resume") {
      client.calls.push({ method, params });
      throw new Error("resume unavailable");
    }
    return originalRequest(method, params);
  };
  const service = new CodexService({ projectRoot: "/workspace", workspaceRoot: "/", instructions: "test", chatInstructions: "chat test", client });
  t.after(() => service.router.dispose());
  await assert.rejects(service.startTurn({ threadId: "new", prompt: "continue", clientUserMessageId: "message-2", purpose: "chat", cwd: "/workspace" }), /resume unavailable/);
  assert.deepEqual(client.calls.map(({ method }) => method), ["thread/read", "thread/resume"]);
  assert.equal(service.activeTurns.size, 0);
});

test("event stream replays missed events and then forwards live events", () => {
  const stream = new CodexEventStream();
  stream.publish("codex/notification", { method: "turn/started" });
  const response = new EventEmitter();
  response.destroyed = false;
  response.writableEnded = false;
  response.output = "";
  response.write = (chunk) => {
    response.output += chunk;
    return true;
  };
  stream.attach(response, 0);
  stream.publish("codex/notification", { method: "turn/completed" });
  response.emit("close");
  const events = response.output.trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((event) => event.payload.method), ["turn/started", "turn/completed"]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
});

test("event stream reports when requested history has expired", () => {
  const stream = new CodexEventStream({ limit: 2 });
  stream.publish("one", {});
  stream.publish("two", {});
  stream.publish("three", {});
  const response = new EventEmitter();
  Object.assign(response, { destroyed: false, writableEnded: false, output: "" });
  response.write = (chunk) => { response.output += chunk; return true; };
  stream.attach(response, 0);
  response.emit("close");
  const events = response.output.trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((event) => event.type), ["codex/gap", "two", "three"]);
  assert.deepEqual(events[0].payload, { requested: 0, oldest: 2, latest: 3 });
});

test("disconnect finalizes active turns so a retry is not blocked", () => {
  const client = new FakeClient();
  const service = new CodexService({ projectRoot: "/workspace", workspaceRoot: "/", instructions: "test", chatInstructions: "chat test", client });
  service.activeTurns.set("new", "turn-active");
  service.interruptingThreads.add("new");
  const completed = [];
  service.on("notification", (message) => {
    if (message.method === "turn/completed") completed.push(message);
  });
  client.emit("connection", { status: "disconnected", error: "socket closed" });
  assert.equal(service.activeTurns.size, 0);
  assert.equal(service.interruptingThreads.size, 0);
  assert.equal(completed[0].params.turn.status, "failed");
  service.router.dispose();
});

test("keeps internal editor child notifications out of the visible chat event stream", () => {
  const client = new FakeClient();
  const events = new CodexEventStream();
  const service = new CodexService({ projectRoot: "/workspace", workspaceRoot: "/", instructions: "editor rules", chatInstructions: "chat rules", client, eventStream: events });
  const forwarded = [];
  service.on("notification", (message) => forwarded.push(message));
  service.threadPurposes.set("editor-child", "editor");
  service.handleNotification({ method: "thread/started", params: { thread: { id: "editor-child", name: "Weave · New conversation\\u2063weave-editor-v1" } } });
  service.handleNotification({ method: "turn/started", params: { threadId: "editor-child", turn: { id: "editor-turn" } } });
  service.handleNotification({ method: "turn/completed", params: { threadId: "editor-child", turn: { id: "editor-turn", status: "completed" } } });
  assert.equal(forwarded.length, 3);
  assert.equal(events.since().filter((event) => event.type === "codex/notification").length, 0);
  service.threadPurposes.set("chat-1", "chat");
  service.handleNotification({ method: "turn/started", params: { threadId: "chat-1", turn: { id: "chat-turn" } } });
  assert.equal(events.since().filter((event) => event.type === "codex/notification").length, 1);
  service.router.dispose();
});

test("project root changes preserve an active chat coordinator and refresh its catalog", async () => {
  const client = new FakeClient();
  const events = new CodexEventStream();
  const service = new CodexService({ projectRoot: "/workspace", workspaceRoot: "/", instructions: "test", chatInstructions: "chat test", client, eventStream: events });
  service.ready = true;
  service.weaveThreadIds.add("new");
  service.activeTurns.set("new", "turn-active");
  service.turnPurposes.set("new", "chat");
  service.refreshCatalog = async () => ({ });

  await service.setProjectRoot("/other");

  assert.equal(service.projectRoot, "/other");
  assert.equal(service.activeTurns.get("new"), "turn-active");
  assert.equal(events.since().some((event) => event.type === "codex/notification" && event.payload.method === "turn/completed"), false);
  service.router.dispose();
});

test("project root changes reject while an editor turn is running", async () => {
  const client = new FakeClient();
  const service = new CodexService({ projectRoot: "/workspace", workspaceRoot: "/", instructions: "test", chatInstructions: "chat test", client });
  service.ready = true;
  service.weaveThreadIds.add("new");
  service.activeTurns.set("new", "turn-active");
  service.turnPurposes.set("new", "editor");
  await assert.rejects(service.setProjectRoot("/other"), /editor turn is running/);
  assert.equal(service.projectRoot, "/workspace");
  service.router.dispose();
});

test("project root changes reject a concurrent retarget", async () => {
  const client = new FakeClient();
  const service = new CodexService({ projectRoot: "/workspace", workspaceRoot: "/", instructions: "test", chatInstructions: "chat test", client });
  service.ready = true;
  service.retargeting = true;
  await assert.rejects(service.setProjectRoot("/second"), /already changing/);
  service.router.dispose();
});

test("deduplicates repeated Stop requests for the same active turn", async () => {
  const client = new FakeClient();
  const service = new CodexService({ projectRoot: "/workspace", workspaceRoot: "/", instructions: "test", chatInstructions: "chat test", client });
  service.ready = true;
  service.weaveThreadIds.add("new");
  service.activeTurns.set("new", "turn-active");
  assert.equal((await service.interruptTurn("new")).status, "interrupting");
  assert.equal((await service.interruptTurn("new")).status, "interrupting");
  assert.equal(client.calls.filter((call) => call.method === "turn/interrupt").length, 1);
  service.router.dispose();
});

test("accepts only HTTPS and loopback OAuth destinations", () => {
  assert.equal(validateOAuthUrl("https://auth.example.com/start"), "https://auth.example.com/start");
  assert.equal(validateOAuthUrl("http://127.0.0.1:4389/callback"), "http://127.0.0.1:4389/callback");
  assert.throws(() => validateOAuthUrl("javascript:alert(1)"), /unsafe OAuth URL/);
  assert.throws(() => validateOAuthUrl("http://example.com/login"), /unsafe OAuth URL/);
});

test("version mismatch is retained as a warning while a successful handshake makes Codex ready", async () => {
  const client = new HandshakeClient();
  const events = new CodexEventStream();
  const service = new CodexService({
    projectRoot: "/workspace",
    workspaceRoot: "/",
    instructions: "test",
    chatInstructions: "chat test",
    client,
    eventStream: events,
    checkVersion: async () => ({
      matches: false,
      running: "0.149.1",
      generated: "0.146.0",
      warning: "Generated bindings are from an older CLI.",
    }),
  });

  await service.start();
  assert.equal(service.version.matches, false);
  assert.equal(service.version.warning, "Generated bindings are from an older CLI.");
  assert.equal(service.ready, true);
  assert.equal(service.connection.status, "connected");
  assert.equal(client.calls[0].method, "initialize");
  assert.equal(client.calls[0].params.capabilities.experimentalApi, true);
  assert.deepEqual(client.notifications, [{ method: "initialized", params: {} }]);
  assert.deepEqual(
    events.since().filter((event) => event.type === "codex/connection").map((event) => event.payload.status),
    ["connecting", "connected"],
  );
  assert.deepEqual(events.since().find((event) => event.type === "codex/versionWarning")?.payload, {
    warning: "Generated bindings are from an older CLI.",
    generated: "0.146.0",
    running: "0.149.1",
  });
  service.router.dispose();
});

test("failed initialize publishes an actionable incompatible state and remains rejected", async () => {
  const client = new HandshakeClient({ initializeError: new Error("method not found") });
  const service = new CodexService({
    projectRoot: "/workspace",
    workspaceRoot: "/",
    instructions: "test",
    chatInstructions: "chat test",
    client,
    checkVersion: async () => ({ matches: false, running: "0.149.1", generated: "0.146.0", warning: "version mismatch" }),
  });

  await assert.rejects(service.start(), /method not found/);
  assert.equal(service.ready, false);
  assert.equal(service.connection.status, "incompatible");
  assert.match(service.connection.error, /initialize failed/);
  assert.match(service.connection.error, /generated bindings 0\.146\.0, running CLI 0\.149\.1/);
  assert.match(service.connection.error, /npm run codex:check/);
  client.emit("connection", { status: "connected" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.connection.status, "incompatible");
  service.router.dispose();
});

test("turn input keeps legacy text shape and adds only image attachments", () => {
  assert.deepEqual(turnInput("hello"), [{ type: "text", text: "hello", text_elements: [] }]);
  assert.deepEqual(turnInput("hello", [
    { path: "references/photo.png", name: "photo.png", bytes: 4 },
    { path: "references/file.pdf", name: "file.pdf", bytes: 4 },
  ], "/workspace"), [
    { type: "text", text: "hello", text_elements: [] },
    { type: "localImage", path: "/workspace/references/photo.png" },
  ]);
  assert.deepEqual(turnInput("hello", [
    { path: "../secret.png", mimeType: "image/png" },
    { path: "/Users/secret.png", mimeType: "image/png" },
    { path: "assets/secret.png", mimeType: "image/png" },
  ], "/workspace"), [{ type: "text", text: "hello", text_elements: [] }]);
});

test("turn input does not turn folder attachments into local images", () => {
  assert.deepEqual(turnInput("read this folder", [{ path: "references/docs", name: "docs", kind: "folder", files: 4, bytes: 20 }], "/workspace"), [{ type: "text", text: "read this folder", text_elements: [] }]);
});
