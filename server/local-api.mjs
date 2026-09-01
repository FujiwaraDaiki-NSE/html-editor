import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acceptVariation,
  agentInstructions,
  assertCommittable,
  archiveVariation,
  checkoutHistory,
  checkoutMain,
  checkoutVariation,
  commitIfChanged,
  createVariationBranch,
  discardVariation,
  ensureProject,
  initializeCurrentProject,
  importImageAsset,
  assetMimeTypes,
  importReference,
  importReferenceFolder,
  listFolders,
  readReferences,
  removeReference,
  syncReferenceFolder,
  projectRoot,
  listProjects,
  createProject,
  renameProject,
  duplicateProject,
  archiveProject,
  assertSwitchable,
  switchProject,
  projectState,
  getVariationPreviews,
  readProject,
  readDeckCss,
  readTemplates,
  restoreDeckCss,
  assertAssetFilename,
  projectAssetPath,
  writeProject,
  writeProjectUnlocked,
  runProjectExclusive,
  saveProject,
} from "./project.mjs";
import { CodexService } from "./codex/service.mjs";
import { annotationPromptRules, canSendTurn } from "../shared/annotation.mjs";
import { contextPromptRules, editorEnvelope } from "../shared/context.mjs";
import { parseConfiguredPort } from "../scripts/dev-port.mjs";
import { isAllowedWebOrigin } from "./dev-origin.mjs";
import { routeMethodDecision } from "./route-methods.mjs";

const apiPort = Number(process.env.WEAVE_API_PORT ?? 4317);
await initializeCurrentProject();
const webPort = parseConfiguredPort(process.env.WEAVE_WEB_PORT);
const codex = new CodexService({ projectRoot: projectRoot(), instructions: agentInstructions });
const pendingTurns = new Map();
const completedSaves = new Map();
let projectSwitchQueue = Promise.resolve();
const migrationNotice = "Legacy .weave/chat.json history was removed. Conversations now use Codex app-server Threads only.";

function pendingTurn(value) {
  let resolveFinalization;
  const finalization = new Promise((resolve) => { resolveFinalization = resolve; });
  return { ...value, finalization, resolveFinalization };
}

function finishPendingTurn(threadId, pending) {
  pendingTurns.delete(threadId);
  pending.resolveFinalization();
}

function hasAllowedOrigin(request) {
  return isAllowedWebOrigin(request.headers.origin, webPort);
}

function corsHeaders(request) {
  const origin = request.headers.origin;
  const headers = {
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
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

async function sendAsset(request, response, filename, filePath) {
  try {
    assertAssetFilename(filename);
    const bytes = await readFile(filePath);
    const extension = filename.split(".").pop().toLowerCase();
    const mimeType = assetMimeTypes.get(extension);
    if (!mimeType) throw new Error("Unsupported asset type.");
    response.writeHead(200, { ...corsHeaders(request), "content-type": mimeType, "cache-control": "public, max-age=31536000, immutable" });
    response.end(bytes);
  } catch {
    sendJson(request, response, 404, { error: "Asset not found." });
  }
}

async function readJson(request, limit = 1_500_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request is too large."), { code: "WEAVE_REQUEST_TOO_LARGE" });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { code: "WEAVE_INVALID_JSON" });
  }
}

async function statePayload() {
  const state = projectState();
  const generatingBranches = new Set([...pendingTurns.values()].map((turn) => turn.branch).filter(Boolean));
  return {
    deck: await readProject(),
    css: await readDeckCss(),
    templates: await readTemplates(),
    references: await readReferences(),
    ...state,
    variations: state.variations.map((variation) => ({
      ...variation,
      status: generatingBranches.has(variation.branch) ? "generating" : "ready",
    })),
    codex: {
      ready: codex.ready,
      connection: codex.connection,
      version: codex.version,
      catalog: codex.catalog,
      activeTurns: Object.fromEntries(codex.activeTurns),
      pendingRequests: codex.router.list(),
    },
    migrationNotice,
  };
}

async function retargetCodex() {
  try {
    await codex.setProjectRoot(projectRoot());
  } catch (error) {
    codex.publishIncompatible(error, "project retarget");
  }
}

function enqueueProjectSwitch(operation) {
  const next = projectSwitchQueue.then(operation, operation);
  projectSwitchQueue = next.catch(() => {});
  return next;
}

function requireText(value, name, limit = 20_000) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} is required.`);
  if (text.length > limit) throw new Error(`${name} must be ${limit.toLocaleString()} characters or fewer.`);
  return text;
}

function requireTurnPrompt(payload) {
  const text = String(payload.prompt ?? "");
  const annotations = Array.isArray(payload.contextEnvelope?.annotations) ? payload.contextEnvelope.annotations : [];
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  if (!canSendTurn(text, annotations) && attachments.length === 0) throw new Error("Prompt text, an annotation, or an attachment is required.");
  return text.trim() ? requireText(text, "Prompt") : annotations.length > 0 ? "Use the attached editor annotations as the request for this turn." : "Read the attached files and act on them.";
}

function activeProjectTurn() {
  return codex.activeTurns.size > 0 || pendingTurns.size > 0;
}

function serializeEditorContext(payload) {
  if (!payload.contextEnvelope || typeof payload.contextEnvelope !== "object") return "";
  const envelope = editorEnvelope(payload.contextEnvelope);
  if (Object.keys(envelope).length === 0) return "";
  const annotations = Array.isArray(envelope.annotations) ? envelope.annotations : [];
  const annotationRules = annotations.length > 0 ? `\n\nAnnotation interpretation rules:\n${annotationPromptRules}` : "";
  return `\n\nEditor context envelope:\n${JSON.stringify(envelope)}\n\nContext rules:\n${contextPromptRules}${annotationRules}`;
}

async function startEditorTurn(payload, { variation = false } = {}) {
  if (activeProjectTurn()) throw new Error("Another Agent turn is already running in this project.");
  const prompt = requireTurnPrompt(payload);
  const root = projectRoot();
  let branch = null;
  let registeredPending = null;
  let registeredThreadId = null;
  if (variation) branch = createVariationBranch();
  try {
    const deck = await writeProject(payload.deck, null, root);
    const preTurnCss = await readDeckCss(root);
    const thread = await codex.startThread({
      approvalPolicy: payload.approvalPolicy ?? "never",
      model: payload.model,
    });
    registeredPending = pendingTurn({ prompt, branch, variation, deckTitle: deck.title, root, preTurnDeck: deck, preTurnCss });
    registeredThreadId = thread.id;
    pendingTurns.set(thread.id, registeredPending);
    const context = `${variation ? "Create a meaningfully different, polished direction. " : ""}User request: ${prompt}

The latest editor state has been written to slides/*.html.
Inspect the current project and edit the slides/*.html files directly. Do not edit styles/deck.css.
Do not commit; Weave will commit after this turn.${serializeEditorContext(payload)}`;
    const result = await codex.startTurn({
      threadId: thread.id,
      prompt: context,
      clientUserMessageId: payload.clientUserMessageId,
      model: payload.model,
      effort: payload.effort,
      approvalPolicy: payload.approvalPolicy ?? "never",
    });
    return { thread, turn: result.turn, branch };
  } catch (error) {
    if (registeredPending && registeredThreadId) finishPendingTurn(registeredThreadId, registeredPending);
    if (variation && branch) discardVariation(branch, root);
    throw error;
  }
}

async function restoreFailedTurn(pending) {
  await runProjectExclusive(async () => {
    if (pending.variation) {
      if (pending.branch) discardVariation(pending.branch, pending.root);
      return;
    }
    await writeProjectUnlocked(pending.preTurnDeck, null, pending.root);
    await restoreDeckCss(pending.preTurnCss, pending.root);
  }, pending.root);
}

codex.on("notification", (message) => {
  if (message.method !== "turn/completed") return;
  const threadId = message.params?.threadId;
  const pending = pendingTurns.get(threadId);
  if (!pending) return;
  void (async () => {
    const status = message.params?.turn?.status;
    if (status !== "completed") {
      let cleanupError;
      try {
        await restoreFailedTurn(pending);
      } catch (error) {
        cleanupError = error;
      }
      codex.events.publish("weave/project", {
        status: cleanupError ? "error" : status,
        ...projectState(),
        ...(cleanupError ? { error: `Could not restore the project after the Agent turn: ${cleanupError.message}` } : {}),
        ...(cleanupError ? { cleanupError: cleanupError.message } : {}),
      });
      finishPendingTurn(threadId, pending);
      return;
    }
    try {
      await runProjectExclusive(async () => {
        const project = await readProject(pending.root);
        await writeProjectUnlocked(project, null, pending.root);
        /* Ordinary Agent edits remain an unsaved working result. A variation needs a
           commit because its branch is the durable unit switched by the direction tabs. */
        if (pending.variation) {
          await assertCommittable(pending.root);
          commitIfChanged(`Variation: ${pending.prompt.replace(/\s+/g, " ").slice(0, 100)}`, pending.root);
        } else {
          await assertCommittable(pending.root);
        }
      }, pending.root);
      codex.events.publish("weave/project", {
        status: "updated",
        ...projectState(),
        deck: await readProject(pending.root),
      });
    } catch (error) {
      let cleanupError;
      try {
        await restoreFailedTurn(pending);
      } catch (restoreError) {
        cleanupError = restoreError;
      }
      codex.events.publish("weave/project", {
        status: "error",
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(Array.isArray(error.diagnostics) ? { diagnostics: error.diagnostics } : {}),
        ...(cleanupError ? { cleanupError: cleanupError.message } : {}),
      });
    } finally {
      finishPendingTurn(threadId, pending);
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
    const routeMethod = routeMethodDecision(url.pathname, request.method);
    if (!routeMethod.allowed) {
      response.setHeader("allow", routeMethod.allow);
      return sendJson(request, response, 405, { error: `Method ${request.method} is not allowed.` });
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      return sendJson(request, response, 200, { ok: true, codex: codex.ready });
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      return sendJson(request, response, 200, await statePayload());
    }
    if (request.method === "GET" && url.pathname === "/api/variations/compare") {
      if (activeProjectTurn()) return sendJson(request, response, 409, { error: "An Agent turn is running." });
      return sendJson(request, response, 200, { previews: getVariationPreviews() });
    }
    if (request.method === "GET" && url.pathname === "/api/projects") {
      return sendJson(request, response, 200, { projects: await listProjects() });
    }
    if (request.method === "GET" && url.pathname === "/api/folders") {
      return sendJson(request, response, 200, await listFolders(url.searchParams.get("path") || undefined));
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/assets/")) {
      const filename = url.pathname.slice("/api/assets/".length);
      let assetPath;
      try { assertAssetFilename(filename); assetPath = join(projectRoot(), "assets", filename); } catch { return sendJson(request, response, 404, { error: "Asset not found." }); }
      return sendAsset(request, response, filename, assetPath);
    }
    const projectAssetMatch = request.method === "GET" && url.pathname.match(/^\/api\/projects\/([^/]+)\/assets\/([^/]+)$/);
    if (projectAssetMatch) {
      const [, slug, filename] = projectAssetMatch;
      let assetPath;
      try { assertAssetFilename(filename); assetPath = projectAssetPath(slug, filename); } catch { return sendJson(request, response, 404, { error: "Asset not found." }); }
      return sendAsset(request, response, filename, assetPath);
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

    if (request.method !== "GET" && request.method !== "POST" && request.method !== "PATCH") return sendJson(request, response, 404, { error: "Not found." });
    const payload = await readJson(request, url.pathname === "/api/assets" ? 14_000_000 : url.pathname === "/api/references" ? 36_000_000 : url.pathname === "/api/save" ? 5_000_000 : 1_500_000);

    if (request.method === "POST" && url.pathname === "/api/projects") {
      const result = await enqueueProjectSwitch(async () => {
        if (activeProjectTurn()) throw new Error("An Agent turn is running.");
        await assertSwitchable();
        const slug = await createProject({ title: requireText(payload.title, "Title"), templateId: requireText(payload.templateId, "templateId") });
        await switchProject(slug);
        await ensureProject();
        await retargetCodex();
        codex.events.publish("weave/project", { status: "switched", ...projectState() });
        return { ...(await statePayload()), slug };
      });
      return sendJson(request, response, 201, result);
    }
    if (request.method === "POST" && url.pathname === "/api/projects/current") {
      const result = await enqueueProjectSwitch(async () => {
        if (activeProjectTurn() && payload.interrupt !== true) throw Object.assign(new Error("An Agent turn is running."), { code: "WEAVE_TURN_RUNNING" });
        if (payload.interrupt === true) {
          const finalizations = [...pendingTurns.values()].map((pending) => pending.finalization);
          await Promise.all([...codex.activeTurns.keys()].map((threadId) => codex.interruptTurn(threadId)));
          await Promise.all(finalizations);
        }
        await switchProject(requireText(payload.slug, "Project id"));
        await ensureProject();
        await retargetCodex();
        codex.events.publish("weave/project", { status: "switched", ...projectState() });
        return await statePayload();
      });
      return sendJson(request, response, 200, result);
    }
    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(duplicate|archive))?$/);
    if (projectMatch && request.method === "PATCH") {
      await renameProject(projectMatch[1], requireText(payload.title, "Title"));
      return sendJson(request, response, 200, { projects: await listProjects() });
    }
    if (projectMatch && request.method === "POST" && projectMatch[2] === "duplicate") {
      const slug = await duplicateProject(projectMatch[1]);
      return sendJson(request, response, 201, { slug, projects: await listProjects() });
    }
    if (projectMatch && request.method === "POST" && projectMatch[2] === "archive") {
      await archiveProject(projectMatch[1]);
      return sendJson(request, response, 200, { projects: await listProjects() });
    }

    if (url.pathname === "/api/assets") {
      return sendJson(request, response, 201, await importImageAsset(payload));
    }
    if (url.pathname === "/api/references") {
      return sendJson(request, response, 201, await importReference(payload));
    }
    if (url.pathname === "/api/references/folder") {
      return sendJson(request, response, 201, await importReferenceFolder(payload));
    }
    if (url.pathname === "/api/references/folder/sync") {
      return sendJson(request, response, 200, await syncReferenceFolder(payload.path));
    }
    if (url.pathname === "/api/references/remove") {
      return sendJson(request, response, 200, { references: await removeReference(payload.path) });
    }

    if (url.pathname === "/api/save") {
      if (activeProjectTurn()) return sendJson(request, response, 409, { error: "An Agent turn is running." });
      const idempotencyKey = String(payload.idempotencyKey ?? "");
      if (idempotencyKey && completedSaves.has(idempotencyKey)) {
        return sendJson(request, response, 200, completedSaves.get(idempotencyKey));
      }
      const { commit } = await saveProject(
        payload.deck,
        payload.expectedRevision,
        `Save: ${String(payload.message ?? payload.deck?.title ?? "Deck").slice(0, 120)}`,
        payload.templates ?? null,
      );
      const result = { ...(await statePayload()), commit };
      if (idempotencyKey) {
        completedSaves.set(idempotencyKey, result);
        if (completedSaves.size > 100) completedSaves.delete(completedSaves.keys().next().value);
      }
      return sendJson(request, response, 200, result);
    }
    if (url.pathname === "/api/history/checkout") {
      if (activeProjectTurn()) return sendJson(request, response, 409, { error: "An Agent turn is running." });
      await checkoutHistory(String(payload.commit ?? ""));
      return sendJson(request, response, 200, await statePayload());
    }
    if (url.pathname === "/api/history/main") {
      if (activeProjectTurn()) return sendJson(request, response, 409, { error: "An Agent turn is running." });
      checkoutMain();
      return sendJson(request, response, 200, await statePayload());
    }
    if (url.pathname === "/api/variations/checkout") {
      if (activeProjectTurn()) return sendJson(request, response, 409, { error: "An Agent turn is running." });
      await checkoutVariation(String(payload.branch ?? ""));
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
      if (activeProjectTurn()) return sendJson(request, response, 409, { error: "Another Agent turn is already running in this project." });
      const prompt = requireTurnPrompt(payload);
      const root = projectRoot();
      const deck = payload.deck ? await writeProject(payload.deck, null, root) : await readProject(root);
      const preTurnCss = await readDeckCss(root);
      const pending = pendingTurn({ prompt, branch: null, variation: false, root, preTurnDeck: deck, preTurnCss, deckTitle: deck.title });
      pendingTurns.set(payload.threadId, pending);
      try {
        const result = await codex.startTurn({ ...payload, prompt: `${prompt}${serializeEditorContext(payload)}` });
        return sendJson(request, response, 202, result);
      } catch (error) {
        finishPendingTurn(payload.threadId, pending);
        throw error;
      }
    }
    if (url.pathname === "/api/codex/turn/steer") {
      const prompt = requireTurnPrompt(payload);
      // Steer only tells the agent what to point at; writing the DOM here could overwrite its in-progress file edits.
      return sendJson(request, response, 202, await codex.steerTurn({ ...payload, prompt: `${prompt}${serializeEditorContext(payload)}` }));
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
    const status = error?.code === "WEAVE_REVISION_CONFLICT" ? 409
      : error?.code === "WEAVE_REQUEST_TOO_LARGE" ? 413
      : error?.code === "WEAVE_INVALID_JSON" ? 400
      : ["WEAVE_QUALITY_FAILED", "WEAVE_CONTENT_POLICY"].includes(error?.code) ? 422
      : ["WEAVE_PROJECT_DIRTY", "WEAVE_PROJECT_BLOCKED", "WEAVE_TURN_RUNNING"].includes(error?.code) ? 409
      : /required|invalid|unknown|not offered|exceeds|already exists/i.test(message) ? 400
      : /owned|running|save|proposal branch|cannot be archived/i.test(message) ? 409 : 500;
    return sendJson(request, response, status, { error: message, code: error?.code, diagnostics: error?.diagnostics });
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
