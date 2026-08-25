import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ServerRequestRouter } from "../server/codex/request-router.mjs";
import { checkGeneratedVersion } from "../server/codex/version.mjs";

class FakeClient extends EventEmitter {
  responses = [];
  errors = [];
  respond(id, result) { this.responses.push({ id, result }); }
  respondError(id, code, message) { this.errors.push({ id, code, message }); }
}

test("routes supported reverse requests and rejects unsupported requests explicitly", () => {
  const client = new FakeClient();
  const router = new ServerRequestRouter(client);
  client.emit("serverRequest", {
    id: 1,
    method: "item/commandExecution/requestApproval",
    params: { availableDecisions: ["accept", "decline"] },
  });
  assert.equal(router.list().length, 1);
  assert.throws(() => router.resolve(1, { decision: "invented" }), /not offered/);
  router.resolve(1, { decision: "accept" });
  assert.deepEqual(client.responses[0], { id: 1, result: { decision: "accept" } });

  client.emit("serverRequest", { id: 2, method: "item/tool/call", params: {} });
  assert.equal(client.errors[0].code, -32601);
  router.dispose();
});

test("times out pending reverse requests", async () => {
  const client = new FakeClient();
  const router = new ServerRequestRouter(client, { timeoutMs: 5 });
  client.emit("serverRequest", { id: 3, method: "item/tool/requestUserInput", params: {} });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(router.list().length, 0);
  assert.equal(client.errors[0].code, -32001);
  router.dispose();
});

test("clears reverse requests immediately when app-server disconnects", () => {
  const client = new FakeClient();
  const router = new ServerRequestRouter(client, { timeoutMs: 60_000 });
  client.emit("serverRequest", { id: 5, method: "item/tool/requestUserInput", params: {} });
  client.emit("connection", { status: "disconnected" });
  assert.equal(router.list().length, 0);
  router.dispose();
});

test("validates OAuth URLs before responding", () => {
  const client = new FakeClient();
  const router = new ServerRequestRouter(client);
  client.emit("serverRequest", { id: 4, method: "mcpServer/elicitation/request", params: {} });
  assert.throws(() => router.resolve(4, { url: "javascript:alert(1)" }), /HTTPS or loopback/);
  router.resolve(4, { url: "https://example.com/authorize", action: "accept" });
  router.dispose();
});

test("detects generated binding version mismatches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weave-version-"));
  const file = join(directory, "version.json");
  await writeFile(file, JSON.stringify({ cliVersion: "0.144.0" }));
  const result = await checkGeneratedVersion(file, { exec: () => "codex-cli 0.145.0" });
  assert.equal(result.matches, false);
  assert.equal(result.running, "0.145.0");
  assert.equal(result.generated, "0.144.0");
  assert.match(result.warning, /npm run codex:generate/);
});

test("accepts matching generated binding versions without a warning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weave-version-"));
  const file = join(directory, "version.json");
  await writeFile(file, JSON.stringify({ cliVersion: "0.145.0" }));
  const result = await checkGeneratedVersion(file, { exec: () => "codex-cli 0.145.0" });
  assert.equal(result.matches, true);
  assert.equal(result.warning, null);
});
