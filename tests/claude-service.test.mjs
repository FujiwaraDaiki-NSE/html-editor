import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeService } from "../server/claude/service.mjs";
import { AgentService } from "../server/agent-service.mjs";
import { CodexEventStream } from "../server/codex/event-stream.mjs";

const fixture = fileURLToPath(new URL("./fixtures/claude-cli.mjs", import.meta.url));
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "weave-claude-"));
  const calls = [];
  const options = { projectRoot: root, storageRoot: join(root, "history"), instructions: async () => "Edit project files only.",
    runCommand: async (_command, args) => ({ stdout: args[0] === "--version" ? "test-version" : '{"loggedIn":true}' }),
    spawnProcess: (command, args, options) => { calls.push({ command, args, options }); return spawn(process.execPath, [fixture, ...args], options); },
  };
  const service = new ClaudeService(options);
  t.after(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  await service.start();
  return { root, service, calls, options };
}
function completed(service) {
  return new Promise((resolve) => {
    const listener = (event) => { if (event.method === "turn/completed") { service.off("notification", listener); resolve(event.params.turn); } };
    service.on("notification", listener);
  });
}
const payload = (id, prompt, clientUserMessageId = "request-1") => ({ threadId: id, prompt, userPrompt: prompt, clientUserMessageId, model: "claude:sonnet", effort: "low" });

test("Claude launches independently, streams one answer, edits files and resumes its exact native session", async (t) => {
  const { root, service, calls, options } = await setup(t);
  await writeFile(join(root, "slide.html"), "<h1>Before</h1>");
  const thread = await service.startThread({ model: "claude:sonnet" });
  const done = completed(service);
  const request = payload(thread.id, "EDIT");
  const [accepted, duplicate] = await Promise.all([service.startTurn(request), service.startTurn(request)]);
  assert.equal(accepted.turn.id, duplicate.turn.id);
  assert.equal(calls.length, 1);
  const turn = await done;
  assert.equal(turn.status, "completed");
  assert.equal(turn.items.filter((item) => item.type === "agentMessage").length, 1);
  assert.equal(turn.items.find((item) => item.type === "agentMessage").text, "DONE");
  assert.equal(turn.items.find((item) => item.id === "tool-1").result, "file content");
  assert.equal(await readFile(join(root, "slide.html"), "utf8"), "<h1>After</h1>");
  assert.equal(calls[0].command, "claude");
  assert.ok(calls[0].args.includes("--restricted"));
  assert.ok(!calls[0].args.includes("--dangerously-skip-permissions"));
  assert.equal(calls[0].options.cwd, root);
  assert.ok(!calls[0].args.includes("--fallback-model"));
  const restarted = new ClaudeService(options);
  await restarted.start();
  t.after(() => restarted.stop());
  assert.equal((await restarted.readThread(thread.id)).turns[0].status, "completed");
  const followup = completed(restarted);
  await restarted.startTurn(payload(thread.id, "FOLLOWUP", "request-2"));
  assert.equal((await followup).status, "completed");
  const args = calls[1].args;
  assert.equal(args[args.indexOf("--resume") + 1], thread.sessionId);
  assert.equal((await restarted.listThreads()).data.length, 1);
});

test("permission denial, malformed JSON, and early exit cannot be reported as success", async (t) => {
  const { service } = await setup(t);
  for (const prompt of ["DENIED", "BAD_JSON", "EXIT"]) {
    const thread = await service.startThread({ model: "claude:sonnet" });
    const done = completed(service);
    await service.startTurn(payload(thread.id, prompt));
    const turn = await done;
    assert.equal(turn.status, "failed", prompt);
    assert.ok(turn.error.message, prompt);
    assert.equal(service.activeTurns.size, 0);
  }
});

test("interrupt waits for process termination and records interrupted history", async (t) => {
  const { service } = await setup(t);
  const thread = await service.startThread({ model: "claude:sonnet" });
  const done = completed(service);
  await service.startTurn(payload(thread.id, "WAIT"));
  await assert.rejects(service.startTurn(payload(thread.id, "WAIT", "another")), /running/);
  const result = await service.interruptTurn(thread.id);
  assert.equal(result.status, "interrupting");
  assert.equal((await done).status, "interrupted");
  assert.equal((await service.readThread(thread.id)).turns[0].status, "interrupted");
});

test("history is isolated by project, names and archives persist, and invalid models never fall back", async (t) => {
  const { service, root } = await setup(t);
  await assert.rejects(service.startThread({ model: null }), /Unknown Claude model/);
  const thread = await service.startThread({ model: "claude:sonnet" });
  await service.threadAction("name", { threadId: thread.id, name: "Review" });
  await service.threadAction("archive", { threadId: thread.id });
  assert.equal((await service.listThreads()).data.length, 0);
  assert.equal((await service.listThreads({ archived: true, searchTerm: "Review" })).data[0].id, thread.id);
  await assert.rejects(service.readThread("claude:../../secret"), /Invalid/);
  await service.setProjectRoot(join(root, "other-project"));
  assert.equal((await service.listThreads()).data.length, 0);
  await assert.rejects(service.readThread(thread.id), /ENOENT/);
});

test("Claude remains usable when Codex is disconnected and Claude requests never touch its client", async (t) => {
  const { service } = await setup(t);
  const codex = new EventEmitter();
  Object.assign(codex, { ready: false, connection: { status: "disconnected", error: "No Codex" },
    catalog: { models: [], skills: [], hooks: [], mcpServers: [], account: null }, activeTurns: new Map(), router: { list: () => [] }, events: new CodexEventStream(),
    start: async () => { throw new Error("No Codex"); }, stop: async () => {},
    startThread: () => assert.fail("Claude request reached Codex"),
  });
  const agents = new AgentService({ codex, claude: service });
  await agents.start();
  assert.equal(agents.ready, true);
  assert.equal(agents.catalog.providers.codex.ready, false);
  assert.equal(agents.catalog.providers.claude.ready, true);
  const thread = await agents.startThread({ model: "claude:sonnet" });
  await assert.rejects(agents.startTurn({ ...payload(thread.id, "test"), model: "gpt-model" }), /provider differs/);
  const done = completed(agents);
  await agents.startTurn(payload(thread.id, "test"));
  assert.equal((await done).status, "completed");
  assert.equal((await agents.listThreads({ archived: false })).data[0].id, thread.id);
});

test("lost authentication is explicit and stale running history is never automatically retried", async (t) => {
  const { service, options } = await setup(t);
  const thread = await service.startThread({ model: "claude:sonnet" });
  thread.turns.push({ id: "stale", status: "inProgress", items: [] });
  await service.persist(thread);
  assert.equal((await service.readThread(thread.id)).turns[0].status, "failed");
  const disconnected = new ClaudeService({ ...options, runCommand: async () => { throw new Error("Not logged in"); } });
  await disconnected.start();
  assert.equal(disconnected.ready, false);
  await assert.rejects(disconnected.startThread({ model: "claude:sonnet" }), /claude auth login/);
});

test("a rejected concurrent request cannot clear the reservation of a starting request", async (t) => {
  const { service, calls } = await setup(t);
  const thread = await service.startThread({ model: "claude:sonnet" });
  let release;
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  service.instructions = () => { entered(); return new Promise((resolve) => { release = () => resolve("Edit files."); }); };
  const done = completed(service);
  const first = service.startTurn(payload(thread.id, "test"));
  await waiting;
  await assert.rejects(service.startTurn(payload(thread.id, "test", "second")), /running/);
  await assert.rejects(service.startTurn(payload(thread.id, "test", "third")), /running/);
  assert.equal(service.activeTurns.size, 1);
  release();
  await first;
  assert.equal((await done).status, "completed");
  assert.equal(calls.length, 1);
});
