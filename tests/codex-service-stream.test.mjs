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
          { id: "new", name: "Weave · Saved thread", cwd: "/workspace", threadSource: null },
          { id: "old", name: null, cwd: "/workspace", threadSource: null },
          { id: "other", name: "Weave · Other", cwd: "/other", threadSource: null },
        ],
        nextCursor: null,
      };
    }
    if (method === "thread/read") {
      const values = {
        new: { id: "new", name: "Weave · Saved thread", cwd: "/workspace", threadSource: null, turns: [] },
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

class DelayedInterruptClient extends FakeClient {
  interruptStarted = false;
  releaseInterrupt = null;

  async request(method, params) {
    if (method !== "turn/interrupt") return await super.request(method, params);
    this.calls.push({ method, params });
    this.interruptStarted = true;
    await new Promise((resolve) => { this.releaseInterrupt = resolve; });
    return {};
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

test("lists only durably marked Weave Threads and excludes legacy/other-client Threads", async () => {
  const client = new FakeClient();
  const service = new CodexService({ projectRoot: "/workspace", instructions: "test", client });
  service.ready = true;
  const result = await service.listThreads();
  assert.deepEqual(result.data.map((thread) => thread.id), ["new"]);
  service.router.dispose();
});

test("new Threads receive both app-server source and a durable name marker", async () => {
  const client = new FakeClient();
  const service = new CodexService({ projectRoot: "/workspace", instructions: "test", client });
  service.ready = true;
  const thread = await service.startThread();
  assert.equal(thread.threadSource, "weave");
  assert.equal(thread.name, "Weave · New conversation");
  assert.deepEqual(client.calls.at(-1), {
    method: "thread/name/set",
    params: { threadId: "created", name: "Weave · New conversation" },
  });
  service.router.dispose();
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
  const service = new CodexService({ projectRoot: "/workspace", instructions: "test", client });
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

test("project root changes finalize interrupted turns before stopping the client", async () => {
  const client = new FakeClient();
  const events = new CodexEventStream();
  const service = new CodexService({ projectRoot: "/workspace", instructions: "test", client, eventStream: events });
  service.ready = true;
  service.weaveThreadIds.add("new");
  service.activeTurns.set("new", "turn-active");
  service.stop = async () => {};
  service.start = async () => {};

  await service.setProjectRoot("/other");

  const completed = events.since().find((event) => event.type === "codex/notification" && event.payload.method === "turn/completed");
  assert.deepEqual(completed?.payload.params, {
    threadId: "new",
    turn: { id: "turn-active", status: "failed", error: "Codex project root changed." },
  });
  assert.equal(service.activeTurns.size, 0);
  service.router.dispose();
});

test("project root changes reject new thread and turn operations while interrupt is pending", async () => {
  const client = new DelayedInterruptClient();
  const service = new CodexService({ projectRoot: "/workspace", instructions: "test", client });
  service.ready = true;
  service.weaveThreadIds.add("new");
  service.activeTurns.set("new", "turn-active");
  service.stop = async () => {};
  service.start = async () => {};

  const changing = service.setProjectRoot("/other");
  while (!client.interruptStarted) await new Promise((resolve) => setImmediate(resolve));
  client.emit("notification", {
    method: "turn/completed",
    params: { threadId: "new", turn: { id: "turn-active", status: "completed" } },
  });
  await assert.rejects(service.startThread(), /project root is changing/);
  await assert.rejects(service.resumeThread("new"), /project root is changing/);
  await assert.rejects(service.forkThread("new"), /project root is changing/);
  await assert.rejects(service.threadAction("archive", { threadId: "new" }), /project root is changing/);
  await assert.rejects(
    service.startTurn({ threadId: "new", prompt: "new turn", clientUserMessageId: "new-message" }),
    /project root is changing/,
  );
  await assert.rejects(
    service.steerTurn({ threadId: "new", prompt: "steer", clientUserMessageId: "steer-message" }),
    /project root is changing/,
  );
  client.releaseInterrupt();
  await changing;
  assert.equal(client.calls.some((call) => call.method === "turn/start"), false);
  assert.equal(service.retargeting, false);
  service.router.dispose();
});

test("project root changes reject a concurrent retarget and keep the first root", async () => {
  const client = new DelayedInterruptClient();
  const service = new CodexService({ projectRoot: "/workspace", instructions: "test", client });
  service.ready = true;
  service.weaveThreadIds.add("new");
  service.activeTurns.set("new", "turn-active");
  service.stop = async () => {};
  service.start = async () => {};

  const firstChange = service.setProjectRoot("/first");
  while (!client.interruptStarted) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(service.setProjectRoot("/second"), /already changing/);
  client.releaseInterrupt();
  await firstChange;
  assert.equal(service.projectRoot, "/first");
  assert.equal(service.retargeting, false);
  service.router.dispose();
});

test("deduplicates repeated Stop requests for the same active turn", async () => {
  const client = new FakeClient();
  const service = new CodexService({ projectRoot: "/workspace", instructions: "test", client });
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
    instructions: "test",
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
  assert.equal(client.calls[0].params.capabilities.experimentalApi, false);
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
    instructions: "test",
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
