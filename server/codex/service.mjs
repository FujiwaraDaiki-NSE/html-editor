import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "./client.mjs";
import { CodexEventStream } from "./event-stream.mjs";
import { ServerRequestRouter } from "./request-router.mjs";
import { checkGeneratedVersion } from "./version.mjs";

const WEAVE_THREAD_SOURCE = "weave";
const WEAVE_NAME_PREFIX = "Weave · ";

function textInput(text) {
  return [{ type: "text", text, text_elements: [] }];
}

function unwrapList(result) {
  return result?.data ?? result?.models ?? result?.skills ?? result?.hooks ?? result?.servers ?? [];
}

export function validateOAuthUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
  ) {
    throw new Error("app-server returned an unsafe OAuth URL.");
  }
  return url.toString();
}

export class CodexService extends EventEmitter {
  constructor({ projectRoot, instructions, client, eventStream } = {}) {
    super();
    this.projectRoot = projectRoot;
    this.instructions = instructions;
    this.client = client ?? new CodexAppServerClient({ cwd: projectRoot });
    this.events = eventStream ?? new CodexEventStream();
    this.router = null;
    this.ready = false;
    this.initializing = null;
    this.version = null;
    this.catalog = {
      models: [],
      skills: [],
      hooks: [],
      mcpServers: [],
      account: null,
      modelProvider: null,
    };
    this.activeTurns = new Map();
    this.interruptingThreads = new Set();
    this.sentMessages = new Map();
    this.weaveThreadIds = new Set();

    this.attachClient(this.client);
  }

  attachClient(client) {
    this.client = client;
    this.router = new ServerRequestRouter(this.client);
    this.client.on("notification", (message) => this.handleNotification(message));
    this.client.on("connection", (connection) => {
      this.ready = false;
      if (connection.status === "disconnected") {
        for (const [threadId, turnId] of this.activeTurns) {
          this.handleNotification({
            method: "turn/completed",
            params: {
              threadId,
              turn: { id: turnId, status: "failed", error: connection.error ?? "Codex disconnected." },
            },
          });
        }
      }
      this.events.publish("codex/connection", connection);
      if (connection.status === "connected") void this.initialize();
    });
    this.client.on("protocolError", (error, line) => {
      this.events.publish("codex/protocolError", { error: error.message, line: String(line).slice(0, 1000) });
    });
    this.client.on("orphanResponse", (message) => {
      this.events.publish("codex/orphanResponse", { id: message.id });
    });
    this.client.on("log", (message) => {
      this.emitDiagnostic = Boolean(String(message));
      this.events.publish("codex/log", { message: "Codex app-server emitted a local diagnostic." });
    });
    this.router.on("changed", (requests) => this.events.publish("codex/pendingRequests", requests));
  }

  async start() {
    const versionFile = resolve(
      fileURLToPath(new URL("../../generated/codex-app-server/version.json", import.meta.url)),
    );
    this.version = await checkGeneratedVersion(versionFile);
    if (!this.version.compatible) {
      this.events.publish("codex/connection", {
        status: "incompatible",
        error: this.version.message,
        cliVersion: this.version.running,
      });
      throw new Error(this.version.message);
    }
    await this.client.start();
    await this.initialize();
  }

  async initialize() {
    if (this.ready) return;
    if (this.initializing) return await this.initializing;
    this.initializing = (async () => {
      await this.client.request("initialize", {
        clientInfo: { name: "weave_local", title: "Weave Local Editor", version: "0.1.0" },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
          optOutNotificationMethods: [],
          mcpServerOpenaiFormElicitation: true,
        },
      });
      this.client.notify("initialized", {});
      this.ready = true;
      this.events.publish("codex/connection", {
        status: "connected",
        error: null,
        cliVersion: this.version?.running,
      });
      await this.refreshCatalog();
    })().finally(() => {
      this.initializing = null;
    });
    return await this.initializing;
  }

  async refreshCatalog() {
    const calls = {
      models: ["model/list", { limit: 100 }],
      skills: ["skills/list", { cwds: [this.projectRoot] }],
      hooks: ["hooks/list", { cwds: [this.projectRoot] }],
      mcpServers: ["mcpServerStatus/list", {}],
      account: ["account/read", { refreshToken: false }],
    };
    const entries = await Promise.all(
      Object.entries(calls).map(async ([key, [method, params]]) => {
        try {
          return [key, await this.client.request(method, params)];
        } catch (error) {
          this.events.publish("codex/catalogError", { key, error: error.message });
          return [key, null];
        }
      }),
    );
    for (const [key, result] of entries) {
      if (result === null) continue;
      if (key === "account") this.catalog.account = result.account ?? null;
      else this.catalog[key] = unwrapList(result);
    }
    const selectedModel = this.catalog.models[0]?.id ?? this.catalog.models[0]?.model;
    if (selectedModel) {
      try {
        this.catalog.modelProvider = await this.client.request("modelProvider/capabilities/read", {});
      } catch {
        this.catalog.modelProvider = null;
      }
    }
    this.events.publish("codex/catalog", this.catalog);
    return this.catalog;
  }

  handleNotification(message) {
    const { method, params = {} } = message;
    if (method === "turn/started") {
      const threadId = params.threadId ?? params.thread?.id;
      const turnId = params.turn?.id ?? params.turnId;
      if (threadId && turnId) this.activeTurns.set(threadId, turnId);
    }
    if (method === "turn/completed") {
      const threadId = params.threadId;
      if (threadId) {
        this.activeTurns.delete(threadId);
        this.interruptingThreads.delete(threadId);
      }
    }
    if (method === "account/updated" || method === "account/login/completed") void this.refreshCatalog();
    if (method === "skills/changed") void this.refreshCatalog();
    if (method === "mcpServer/oauthLogin/completed") void this.refreshCatalog();
    if (method === "mcpServer/startupStatus/updated") void this.refreshCatalog();
    this.events.publish("codex/notification", message);
    this.emit("notification", message);
  }

  assertReady() {
    if (!this.ready) throw new Error("Codex app-server is not ready.");
  }

  isWeaveThread(thread) {
    return (
      thread?.cwd === this.projectRoot &&
      (
        thread?.threadSource === WEAVE_THREAD_SOURCE ||
        thread?.name?.startsWith(WEAVE_NAME_PREFIX) ||
        this.weaveThreadIds.has(thread?.id)
      )
    );
  }

  async assertWeaveThread(threadId, { includeTurns = false } = {}) {
    const result = await this.client.request("thread/read", { threadId, includeTurns });
    if (!this.isWeaveThread(result.thread)) {
      throw new Error(
        `Thread is not owned by this Weave project (source=${result.thread?.threadSource ?? "none"}, cwd=${result.thread?.cwd ?? "none"}).`,
      );
    }
    this.weaveThreadIds.add(result.thread.id);
    return result.thread;
  }

  async listThreads({ searchTerm = null, archived = false, cursor = null } = {}) {
    this.assertReady();
    const result = await this.client.request("thread/list", {
      cwd: this.projectRoot,
      archived,
      searchTerm: null,
      cursor,
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["appServer", "vscode"],
    });
    const checked = await Promise.all((result.data ?? []).map(async (thread) => {
      if (
        thread.cwd === this.projectRoot &&
        (thread.name?.startsWith(WEAVE_NAME_PREFIX) || this.weaveThreadIds.has(thread.id))
      ) return thread;
      try {
        const read = await this.client.request("thread/read", { threadId: thread.id, includeTurns: false });
        return read.thread?.threadSource === WEAVE_THREAD_SOURCE && read.thread?.cwd === this.projectRoot
          ? { ...thread, threadSource: WEAVE_THREAD_SOURCE }
          : null;
      } catch {
        return null;
      }
    }));
    const query = searchTerm?.trim().toLocaleLowerCase();
    const data = checked
      .filter(Boolean)
      .filter((thread) => !query || `${thread.name ?? ""}\n${thread.preview ?? ""}`.toLocaleLowerCase().includes(query));
    for (const thread of data) this.weaveThreadIds.add(thread.id);
    return { ...result, data };
  }

  async startThread(options = {}) {
    this.assertReady();
    const result = await this.client.request("thread/start", {
      cwd: this.projectRoot,
      approvalPolicy: options.approvalPolicy ?? "never",
      approvalsReviewer: options.approvalPolicy === "never" || !options.approvalPolicy ? null : "user",
      sandbox: "workspace-write",
      baseInstructions: this.instructions,
      serviceName: "Weave",
      threadSource: WEAVE_THREAD_SOURCE,
      sessionStartSource: "clear",
      ephemeral: false,
      model: options.model ?? null,
    });
    await this.client.request("thread/name/set", {
      threadId: result.thread.id,
      name: `${WEAVE_NAME_PREFIX}New conversation`,
    });
    result.thread.name = `${WEAVE_NAME_PREFIX}New conversation`;
    this.weaveThreadIds.add(result.thread.id);
    return result.thread;
  }

  async readThread(threadId) {
    return await this.assertWeaveThread(threadId, { includeTurns: true });
  }

  async resumeThread(threadId) {
    await this.assertWeaveThread(threadId);
    const result = await this.client.request("thread/resume", {
      threadId,
      cwd: this.projectRoot,
      baseInstructions: this.instructions,
    });
    return result.thread;
  }

  async forkThread(threadId, lastTurnId = null) {
    await this.assertWeaveThread(threadId);
    const result = await this.client.request("thread/fork", {
      threadId,
      lastTurnId,
      cwd: this.projectRoot,
      baseInstructions: this.instructions,
      threadSource: WEAVE_THREAD_SOURCE,
    });
    await this.client.request("thread/name/set", {
      threadId: result.thread.id,
      name: `${WEAVE_NAME_PREFIX}Fork`,
    });
    result.thread.name = `${WEAVE_NAME_PREFIX}Fork`;
    this.weaveThreadIds.add(result.thread.id);
    return result.thread;
  }

  async threadAction(action, params) {
    const methodByAction = {
      name: "thread/name/set",
      goalSet: "thread/goal/set",
      goalGet: "thread/goal/get",
      goalClear: "thread/goal/clear",
      archive: "thread/archive",
      unarchive: "thread/unarchive",
      delete: "thread/delete",
      compact: "thread/compact/start",
    };
    const method = methodByAction[action];
    if (!method) throw new Error("Unknown thread action.");
    await this.assertWeaveThread(params.threadId);
    const safeParams = action === "name"
      ? { ...params, name: `${WEAVE_NAME_PREFIX}${String(params.name ?? "Untitled").replace(/^Weave · /, "")}` }
      : params;
    return await this.client.request(method, safeParams);
  }

  async startTurn({ threadId, prompt, clientUserMessageId, model, effort, approvalPolicy = "never" }) {
    await this.assertWeaveThread(threadId);
    if (this.activeTurns.has(threadId)) throw new Error("This thread already has a running turn.");
    if (!clientUserMessageId) throw new Error("clientUserMessageId is required.");
    const dedupeKey = `${threadId}:${clientUserMessageId}`;
    if (this.sentMessages.has(dedupeKey)) return this.sentMessages.get(dedupeKey);
    const request = this.client.request("turn/start", {
      threadId,
      clientUserMessageId,
      input: textInput(prompt),
      cwd: this.projectRoot,
      approvalPolicy,
      approvalsReviewer: approvalPolicy === "never" ? null : "user",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [this.projectRoot],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      model: model ?? null,
      effort: effort ?? null,
      summary: "auto",
    });
    this.sentMessages.set(dedupeKey, request);
    try {
      const result = await request;
      this.activeTurns.set(threadId, result.turn.id);
      return result;
    } finally {
      setTimeout(() => this.sentMessages.delete(dedupeKey), 60_000);
    }
  }

  async steerTurn({ threadId, prompt, clientUserMessageId }) {
    await this.assertWeaveThread(threadId);
    const expectedTurnId = this.activeTurns.get(threadId);
    if (!expectedTurnId) throw new Error("This thread has no running turn.");
    return await this.client.request("turn/steer", {
      threadId,
      expectedTurnId,
      clientUserMessageId,
      input: textInput(prompt),
    });
  }

  async interruptTurn(threadId) {
    await this.assertWeaveThread(threadId);
    const turnId = this.activeTurns.get(threadId);
    if (!turnId) return { status: "idle" };
    if (this.interruptingThreads.has(threadId)) return { status: "interrupting", turnId };
    this.interruptingThreads.add(threadId);
    try {
      await this.client.request("turn/interrupt", { threadId, turnId });
    } catch (error) {
      this.interruptingThreads.delete(threadId);
      throw error;
    }
    return { status: "interrupting", turnId };
  }

  async login(payload) {
    const result = await this.client.request("account/login/start", payload);
    if (result.authUrl) validateOAuthUrl(result.authUrl);
    return result;
  }

  async logout() {
    const result = await this.client.request("account/logout", undefined);
    await this.refreshCatalog();
    return result;
  }

  async setSkill(payload) {
    const result = await this.client.request("skills/config/write", payload);
    await this.refreshCatalog();
    return result;
  }

  async startMcpOAuth(name) {
    const result = await this.client.request("mcpServer/oauth/login", { name });
    validateOAuthUrl(result.authorizationUrl ?? result.url);
    return result;
  }

  async readMcpResource(params) {
    if (params.threadId) await this.assertWeaveThread(params.threadId);
    return await this.client.request("mcpServer/resource/read", params);
  }

  async callMcpTool(params) {
    await this.assertWeaveThread(params.threadId);
    return await this.client.request("mcpServer/tool/call", params);
  }

  async stop() {
    this.router.dispose();
    await this.client.stop();
  }

  async setProjectRoot(root) {
    if (root === this.projectRoot) return;
    await Promise.all([...this.activeTurns.keys()].map((threadId) => this.interruptTurn(threadId).catch(() => {})));
    this.activeTurns.clear();
    this.interruptingThreads.clear();
    this.sentMessages.clear();
    await this.stop();
    this.projectRoot = root;
    this.ready = false;
    this.weaveThreadIds.clear();
    this.catalog = { models: [], skills: [], hooks: [], mcpServers: [], account: null, modelProvider: null };
    this.client = new CodexAppServerClient({ cwd: root });
    this.attachClient(this.client);
    this.events.publish("codex/connection", { status: "connecting", error: null });
    await this.start();
  }
}
