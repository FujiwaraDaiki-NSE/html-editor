import { createServer } from "node:http";
import {
  acceptVariation,
  agentInstructions,
  archiveVariation,
  checkoutHistory,
  checkoutMain,
  checkoutVariation,
  commitIfChanged,
  createVariationBranch,
  ensureProject,
  projectRoot,
  projectState,
  readDeck,
  readDeckCss,
  writeDeck,
} from "./project.mjs";
import { CodexService } from "./codex/service.mjs";

const apiPort = Number(process.env.WEAVE_API_PORT ?? 4317);
const codex = new CodexService({ projectRoot, instructions: agentInstructions });
const pendingTurns = new Map();
const migrationNotice = "Legacy .weave/chat.json history was removed. Conversations now use Codex app-server Threads only.";

function hasAllowedOrigin(request) {
  const origin = request.headers.origin;
  return !origin || origin === "http://localhost:3000" || origin === "http://127.0.0.1:3000";
}

function corsHeaders(request) {
  const origin = request.headers.origin;
  const headers = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin",
  };
  if (origin && hasAllowedOrigin(request)) headers["access-control-allow-origin"] = origin;
  return headers;
}

function sendJson(request, response, status, value) {
  response.writeHead(status, { ...corsHeaders(request), "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_500_000) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function statePayload() {
  return {
    deck: await readDeck(),
    css: await readDeckCss(),
    ...projectState(),
    codex: {
      ready: codex.ready,
      connection: codex.ready ? "connected" : "connecting",
      version: codex.version,
      catalog: codex.catalog,
      activeTurns: Object.fromEntries(codex.activeTurns),
      pendingRequests: codex.router.list(),
    },
    migrationNotice,
  };
}

function requireText(value, name, limit = 20_000) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} is required.`);
  if (text.length > limit) throw new Error(`${name} must be ${limit.toLocaleString()} characters or fewer.`);
  return text;
}

function activeProjectTurn() {
  return codex.activeTurns.size > 0;
}

async function startEditorTurn(payload, { variation = false } = {}) {
  if (activeProjectTurn()) throw new Error("Another Agent turn is already running in this project.");
  const prompt = requireText(payload.prompt, "Prompt");
  let branch = null;
  if (variation) branch = createVariationBranch();
  const deck = await writeDeck(payload.deck, false);
  const thread = await codex.startThread({
    approvalPolicy: payload.approvalPolicy ?? "never",
    model: payload.model,
  });
  const context = `${variation ? "Create a meaningfully different, polished direction. " : ""}User request: ${prompt}

Current editor selection: ${String(payload.selectedId ?? "none")}
The latest editor state has been written to .weave/current-buffer.json and .weave/deck.json.
Inspect the current project, edit .weave/deck.json, and keep the matching files under slides/ consistent.
Do not commit; Weave will commit after this turn.`;
  const result = await codex.startTurn({
    threadId: thread.id,
    prompt: context,
    clientUserMessageId: payload.clientUserMessageId,
    model: payload.model,
    effort: payload.effort,
    approvalPolicy: payload.approvalPolicy ?? "never",
  });
  pendingTurns.set(thread.id, { prompt, branch, variation, deckTitle: deck.title });
  return { thread, turn: result.turn, branch };
}

codex.client.on("notification", (message) => {
  if (message.method !== "turn/completed") return;
  const threadId = message.params?.threadId;
  const pending = pendingTurns.get(threadId);
  if (!pending) return;
  pendingTurns.delete(threadId);
  void (async () => {
    const status = message.params?.turn?.status;
    if (status !== "completed") {
      codex.events.publish("weave/project", { status, ...projectState() });
      return;
    }
    try {
      await readDeck();
      commitIfChanged(
        pending.variation
          ? `Variation: ${pending.prompt.replace(/\s+/g, " ").slice(0, 100)}`
          : `Agent: ${pending.prompt.replace(/\s+/g, " ").slice(0, 110)}`,
      );
      codex.events.publish("weave/project", { status: "updated", ...projectState(), deck: await readDeck() });
    } catch (error) {
      codex.events.publish("weave/project", { status: "error", error: error.message });
    }
  })();
});

const server = createServer(async (request, response) => {
  try {
    if (!hasAllowedOrigin(request)) return sendJson(request, response, 403, { error: "Origin is not allowed." });
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders(request));
      return response.end();
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return sendJson(request, response, 200, { ok: true, codex: codex.ready });
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      return sendJson(request, response, 200, await statePayload());
    }
    if (request.method === "GET" && url.pathname === "/api/codex/events") {
      const sequence = Number(url.searchParams.get("after") ?? 0);
      response.writeHead(200, {
        ...corsHeaders(request),
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      codex.events.attach(response, Number.isFinite(sequence) ? sequence : 0);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/codex/threads") {
      return sendJson(request, response, 200, await codex.listThreads({
        searchTerm: url.searchParams.get("q"),
        archived: url.searchParams.get("archived") === "true",
        cursor: url.searchParams.get("cursor"),
      }));
    }

    if (request.method !== "POST") return sendJson(request, response, 404, { error: "Not found." });
    const payload = await readJson(request);

    if (url.pathname === "/api/save") {
      if (activeProjectTurn()) return sendJson(request, response, 409, { error: "An Agent turn is running." });
      const deck = await writeDeck(payload.deck);
      const commit = commitIfChanged(`Save: ${String(payload.message ?? deck.title).slice(0, 120)}`);
      return sendJson(request, response, 200, { ...(await statePayload()), commit });
    }
    if (url.pathname === "/api/history/checkout") {
      if (activeProjectTurn()) return sendJson(request, response, 409, { error: "An Agent turn is running." });
      checkoutHistory(String(payload.commit ?? ""));
      return sendJson(request, response, 200, await statePayload());
    }
    if (url.pathname === "/api/history/main") {
      if (activeProjectTurn()) return sendJson(request, response, 409, { error: "An Agent turn is running." });
      checkoutMain();
      return sendJson(request, response, 200, await statePayload());
    }
    if (url.pathname === "/api/variations/checkout") {
      if (activeProjectTurn()) return sendJson(request, response, 409, { error: "An Agent turn is running." });
      checkoutVariation(String(payload.branch ?? ""));
      return sendJson(request, response, 200, await statePayload());
    }
    if (url.pathname === "/api/variations/generate") {
      return sendJson(request, response, 202, await startEditorTurn(payload, { variation: true }));
    }
    if (url.pathname === "/api/variations/accept") {
      if (activeProjectTurn()) return sendJson(request, response, 409, { error: "An Agent turn is running." });
      acceptVariation();
      return sendJson(request, response, 200, await statePayload());
    }
    if (url.pathname === "/api/variations/archive") {
      if (activeProjectTurn()) return sendJson(request, response, 409, { error: "An Agent turn is running." });
      archiveVariation();
      return sendJson(request, response, 200, await statePayload());
    }

    if (url.pathname === "/api/codex/thread/start") {
      return sendJson(request, response, 201, { thread: await codex.startThread(payload) });
    }
    if (url.pathname === "/api/codex/thread/read") {
      return sendJson(request, response, 200, { thread: await codex.readThread(payload.threadId) });
    }
    if (url.pathname === "/api/codex/thread/resume") {
      return sendJson(request, response, 200, { thread: await codex.resumeThread(payload.threadId) });
    }
    if (url.pathname === "/api/codex/thread/fork") {
      return sendJson(request, response, 201, { thread: await codex.forkThread(payload.threadId, payload.lastTurnId) });
    }
    if (url.pathname === "/api/codex/thread/action") {
      return sendJson(request, response, 200, await codex.threadAction(payload.action, payload.params ?? {}));
    }
    if (url.pathname === "/api/codex/turn/start") {
      const prompt = requireText(payload.prompt, "Prompt");
      if (payload.deck) await writeDeck(payload.deck);
      const result = await codex.startTurn({ ...payload, prompt });
      pendingTurns.set(payload.threadId, { prompt, branch: null, variation: false });
      return sendJson(request, response, 202, result);
    }
    if (url.pathname === "/api/codex/turn/steer") {
      const prompt = requireText(payload.prompt, "Prompt");
      return sendJson(request, response, 202, await codex.steerTurn({ ...payload, prompt }));
    }
    if (url.pathname === "/api/codex/turn/interrupt") {
      return sendJson(request, response, 202, await codex.interruptTurn(payload.threadId));
    }
    if (url.pathname === "/api/codex/request/resolve") {
      codex.router.resolve(payload.id, payload.result);
      return sendJson(request, response, 200, { ok: true });
    }
    if (url.pathname === "/api/codex/request/reject") {
      codex.router.reject(payload.id, payload.message);
      return sendJson(request, response, 200, { ok: true });
    }
    if (url.pathname === "/api/codex/catalog/refresh") {
      return sendJson(request, response, 200, await codex.refreshCatalog());
    }
    if (url.pathname === "/api/codex/skill/config") {
      return sendJson(request, response, 200, await codex.setSkill(payload));
    }
    if (url.pathname === "/api/codex/account/login") {
      const login = payload.type === "apiKey"
        ? { type: "apiKey", apiKey: requireText(payload.apiKey, "API key", 20_000) }
        : { type: "chatgpt", codexStreamlinedLogin: true, useHostedLoginSuccessPage: true };
      return sendJson(request, response, 200, await codex.login(login));
    }
    if (url.pathname === "/api/codex/account/logout") {
      return sendJson(request, response, 200, await codex.logout());
    }
    if (url.pathname === "/api/codex/mcp/oauth") {
      return sendJson(request, response, 200, await codex.startMcpOAuth(requireText(payload.name, "MCP server name", 200)));
    }
    if (url.pathname === "/api/codex/mcp/resource/read") {
      return sendJson(request, response, 200, await codex.readMcpResource({
        threadId: payload.threadId ?? null,
        server: requireText(payload.server, "MCP server name", 200),
        uri: requireText(payload.uri, "Resource URI", 4_000),
      }));
    }
    if (url.pathname === "/api/codex/mcp/tool/call") {
      return sendJson(request, response, 200, await codex.callMcpTool({
        threadId: requireText(payload.threadId, "Thread id", 200),
        server: requireText(payload.server, "MCP server name", 200),
        tool: requireText(payload.tool, "Tool name", 500),
        arguments: payload.arguments && typeof payload.arguments === "object" ? payload.arguments : {},
      }));
    }
    return sendJson(request, response, 404, { error: "Not found." });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /required|invalid|unknown|not offered/i.test(message) ? 400 : /owned|running|save/i.test(message) ? 409 : 500;
    return sendJson(request, response, status, { error: message });
  }
});

await ensureProject();
server.listen(apiPort, "127.0.0.1", () => {
  console.log(`Weave local API: http://127.0.0.1:${apiPort}`);
  console.log(migrationNotice);
  void codex.start().catch((error) => {
    console.error(`Codex app-server unavailable: ${error.message}`);
  });
});

async function shutdown() {
  await codex.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
