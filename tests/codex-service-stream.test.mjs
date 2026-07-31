import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CodexEventStream } from "../server/codex/event-stream.mjs";
import { CodexService, validateOAuthUrl } from "../server/codex/service.mjs";

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
