import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const files = [
  "../server/local-api.mjs",
  "../server/project.mjs",
  "../server/codex/client.mjs",
  "../server/codex/service.mjs",
  "../app/page.tsx",
];

test("clean-break architecture has no legacy chat persistence, RPC client, or endpoints", async () => {
  const source = (await Promise.all(files.map((file) => readFile(new URL(file, import.meta.url), "utf8")))).join("\n");
  for (const legacy of [
    "chatPath",
    "readChat",
    "writeChat",
    "appendChat",
    "/api/chat/",
    "/api/agent/",
    "class CodexAppServer ",
    "handleAgentTurn",
    "setMessages(",
  ]) {
    assert.equal(source.includes(legacy), false, `legacy symbol remains: ${legacy}`);
  }
  await assert.rejects(access(new URL("../workspaces/northstar/.weave/chat.json", import.meta.url)));
});

test("generated protocol and required architecture modules exist", async () => {
  for (const file of [
    "../generated/codex-app-server/ClientRequest.ts",
    "../generated/codex-app-server/ServerRequest.ts",
    "../generated/codex-app-server/version.json",
    "../server/codex/protocol.mjs",
    "../server/codex/request-router.mjs",
    "../server/codex/event-stream.mjs",
    "../app/codex/actions.ts",
    "../app/codex/selectors.ts",
    "../app/codex/components/ItemCard.tsx",
  ]) {
    await access(new URL(file, import.meta.url));
  }
});

test("UI uses Thread APIs, reducer, item cards, steering, interrupt, approvals, and catalogs", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  for (const surface of [
    "useReducer(codexReducer",
    "/codex/threads",
    "/codex/thread/start",
    "/codex/thread/resume",
    "/codex/thread/fork",
    "codex/turn/steer",
    "/codex/turn/interrupt",
    "pendingRequests",
    "catalog.skills",
    "catalog.hooks",
    "catalog.mcpServers",
    "ItemCard",
  ]) {
    assert.equal(page.includes(surface), true, `missing UI surface: ${surface}`);
  }
});

test("local API constrains origins and exposes reconnectable NDJSON events", async () => {
  const source = await readFile(new URL("../server/local-api.mjs", import.meta.url), "utf8");
  assert.match(source, /127\.0\.0\.1:3000/);
  assert.match(source, /application\/x-ndjson/);
  assert.match(source, /codex\.events\.attach/);
  assert.doesNotMatch(source, /response.*close.*interrupt/is);
});

test("production code does not call excluded or experimental app-server APIs", async () => {
  const source = (await Promise.all([
    readFile(new URL("../server/local-api.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server/codex/service.mjs", import.meta.url), "utf8"),
  ])).join("\n");
  for (const method of [
    "thread/rollback",
    "thread/inject_items",
    "thread/shellCommand",
    "process/spawn",
    "process/writeStdin",
    "process/resizePty",
    "process/kill",
    "experimentalFeature/enablement/set",
    "plugin/install",
    "plugin/uninstall",
    "marketplace/add",
    "config/value/write",
    "config/batchWrite",
    "externalAgentConfig/import",
  ]) {
    assert.equal(source.includes(`"${method}"`), false, `excluded method is called: ${method}`);
  }
});
