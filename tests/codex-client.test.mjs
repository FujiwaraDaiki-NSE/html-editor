import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CodexAppServerClient } from "../server/codex/client.mjs";
import { classifyMessage } from "../server/codex/protocol.mjs";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  kill() {
    this.emit("exit", 0, "SIGTERM");
  }
}

test("classifies responses and reverse requests by shape, not by id alone", () => {
  assert.equal(classifyMessage({ id: 1, result: {} }), "response");
  assert.equal(classifyMessage({ id: 1, method: "item/tool/requestUserInput", params: {} }), "serverRequest");
  assert.equal(classifyMessage({ method: "turn/started", params: {} }), "notification");
  assert.equal(classifyMessage({ id: 1 }), "invalid");
});

test("supports bidirectional JSON-RPC when request ids collide", async () => {
  const child = new FakeChild();
  const client = new CodexAppServerClient({ cwd: "/tmp/project", spawn: () => child, autoRestart: false });
  await client.start();
  const written = once(child.stdin, "data");
  const response = client.request("thread/list", {});
  const [chunk] = await written;
  assert.equal(JSON.parse(chunk.toString()).id, 1);

  const serverRequest = once(client, "serverRequest");
  child.stdout.write(`${JSON.stringify({ id: 1, method: "item/tool/requestUserInput", params: { questions: [] } })}\n`);
  const [reverse] = await serverRequest;
  assert.equal(reverse.method, "item/tool/requestUserInput");

  child.stdout.write(`${JSON.stringify({ id: 1, result: { data: [] } })}\n`);
  assert.deepEqual(await response, { data: [] });
  await client.stop();
});

test("releases pending requests on process exit", async () => {
  const child = new FakeChild();
  const client = new CodexAppServerClient({ cwd: "/tmp/project", spawn: () => child, autoRestart: false });
  await client.start();
  const pending = client.request("thread/read", { threadId: "x" });
  child.emit("exit", 9, null);
  await assert.rejects(pending, /exited/);
  assert.equal(client.pending.size, 0);
});

test("supports timeout and AbortSignal", async () => {
  const child = new FakeChild();
  const client = new CodexAppServerClient({ cwd: "/tmp/project", spawn: () => child, autoRestart: false });
  await client.start();
  await assert.rejects(client.request("slow", {}, { timeoutMs: 5 }), /timed out/);

  const controller = new AbortController();
  const aborted = client.request("abort", {}, { signal: controller.signal });
  controller.abort(new Error("stop now"));
  await assert.rejects(aborted, /stop now/);
  assert.equal(client.pending.size, 0);
  await client.stop();
});

test("restarts after an unexpected disconnect", async () => {
  const children = [new FakeChild(), new FakeChild()];
  let spawns = 0;
  const client = new CodexAppServerClient({
    cwd: "/tmp/project",
    spawn: () => children[spawns++],
    restartDelayMs: 5,
  });
  await client.start();
  children[0].emit("exit", 1, null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(spawns, 2);
  assert.equal(client.connected, true);
  await client.stop();
});
