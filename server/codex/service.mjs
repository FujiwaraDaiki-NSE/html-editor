import { EventEmitter } from "node:events";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "./client.mjs";
import { CodexEventStream } from "./event-stream.mjs";
import { ServerRequestRouter } from "./request-router.mjs";
import { EDIT_SLIDES_TOOL_NAME, GET_SLIDE_LEARNING_TOOL_NAME, LEARN_SLIDE_PREFERENCE_TOOL_NAME, UI_RESULT_LIMIT, UI_TOOL_NAMESPACE, UiToolBridge, uiDynamicTools, validateEditSlidesArguments } from "./ui-tools.mjs";
import { validateLearnSlidePreferenceArguments } from "../slide-preference-learning.mjs";
import { checkGeneratedVersion } from "./version.mjs";
import { referencesRoot } from "../project.mjs";
import { isReferencePath } from "../../shared/context.mjs";

const WEAVE_THREAD_SOURCE = "weave";
const WEAVE_NAME_PREFIX = "Weave · ";
// Dynamic tools are attached at thread/start and are not exposed by the
// persisted thread/read shape. Keep a zero-width marker in the durable title
// so a service restart can distinguish a tool-capable chat from a legacy one.
const CHAT_TOOL_MARKER = "\u2063weave-ui-v1";
const CHAT_LEARNING_MARKER = "\u2063weave-ui-v2";
const EDITOR_THREAD_MARKER = "\u2063weave-editor-v1";
const THREAD_PURPOSES = new Set(["chat", "editor"]);

function requireThreadPurpose(value) {
  if (!THREAD_PURPOSES.has(value)) throw new Error("Thread purpose must be explicitly set to chat or editor.");
  return value;
}

function requireThreadCwd(value, name = "cwd") {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be an absolute workspace path.`);
  return resolve(value);
}

function requireWorkspaceCwd(value, workspaceRoot, name = "cwd") {
  const cwd = requireThreadCwd(value, name);
  if (!isWithinRoot(workspaceRoot, cwd)) throw new Error(`${name} must be inside the configured workspace root.`);
  return cwd;
}

function isWithinRoot(root, candidate) {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function markedThreadName(name, learning = false) {
  return `${name}${learning ? CHAT_LEARNING_MARKER : CHAT_TOOL_MARKER}`;
}

function markedEditorThreadName(name) {
  return `${name}${EDITOR_THREAD_MARKER}`;
}

function visibleThreadName(name) {
  return typeof name === "string" ? name.replaceAll(CHAT_TOOL_MARKER, "").replaceAll(CHAT_LEARNING_MARKER, "").replaceAll(EDITOR_THREAD_MARKER, "") : name;
}

function threadWithVisibleName(thread) {
  if (!thread || typeof thread !== "object") return thread;
  return { ...thread, name: visibleThreadName(thread.name) };
}

function isChatToolThread(thread) {
  return typeof thread?.name === "string" && (thread.name.includes(CHAT_TOOL_MARKER) || thread.name.includes(CHAT_LEARNING_MARKER));
}

function isLearningToolThread(thread) {
  return typeof thread?.name === "string" && thread.name.includes(CHAT_LEARNING_MARKER);
}

function originalHumanMessage(id, prompt) {
  // Missing original text never falls back to the constructed agent prompt.
  if (prompt === undefined || prompt === null || prompt === "") return null;
  if (typeof prompt !== "string" || prompt.length > 50_000 || prompt.includes("\0")) throw new Error("The original human prompt must be a string of at most 50,000 characters or null.");
  if (typeof id !== "string" || !id || id.length > 200) throw new Error("A human message id of at most 200 characters is required for learning evidence.");
  return { id, prompt };
}

function isSubagentThread(thread) {
  return Boolean(thread?.parentThreadId || thread?.threadSource === "subagent" ||
    (typeof thread?.source === "object" && thread.source !== null && "subAgent" in thread.source));
}

function isEditorThread(thread) {
  return typeof thread?.name === "string" && thread.name.includes(EDITOR_THREAD_MARKER);
}

function resultText(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) throw new Error("The edit_slides handler must return a JSON-serializable result.");
  if (text.length > UI_RESULT_LIMIT) throw new Error(`The edit_slides result exceeds ${UI_RESULT_LIMIT} characters.`);
  return text;
}

function dynamicToolResult(value, success) {
  return { contentItems: [{ type: "inputText", text: resultText(value) }], success };
}

export function turnInput(text, attachments, projectRoot) {
  const input = [{ type: "text", text, text_elements: [] }];
  if (!Array.isArray(attachments)) return input;
  for (const attachment of attachments) {
    if (!attachment || typeof attachment.path !== "string") continue;
    if (attachment.kind === "folder") continue;
    if (!isReferencePath(attachment.path)) continue;
    const referenceRoot = resolve(referencesRoot(projectRoot));
    const absolutePath = resolve(projectRoot, attachment.path);
    if (absolutePath !== referenceRoot && !absolutePath.startsWith(`${referenceRoot}/`)) continue;
    const path = attachment.path.toLowerCase();
    const mimeType = String(attachment.mimeType ?? "").toLowerCase();
    if (/\.(png|jpe?g|webp|gif|svg)$/.test(path) || /^image\/(png|jpe?g|webp|gif|svg\+xml)$/.test(mimeType)) {
      input.push({ type: "localImage", path: absolutePath });
    }
  }
  return input;
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
  constructor({ projectRoot, workspaceRoot, instructions, chatInstructions, client, eventStream, uiTools, editSlidesHandler = null, slidePreferenceLearning = null, checkVersion = checkGeneratedVersion } = {}) {
    super();
    this.projectRoot = requireThreadCwd(projectRoot);
    this.workspaceRoot = requireWorkspaceCwd(workspaceRoot, workspaceRoot, "workspaceRoot");
    this.instructions = instructions;
    this.chatInstructions = chatInstructions;
    this.client = client ?? new CodexAppServerClient({ cwd: projectRoot });
    this.events = eventStream ?? new CodexEventStream();
    this.uiTools = uiTools ?? new UiToolBridge({ events: this.events });
    this.onEditSlides = editSlidesHandler;
    this.slidePreferenceLearning = slidePreferenceLearning;
    this.router = null;
    this.ready = false;
    this.initializing = null;
    this.version = null;
    this.checkVersion = checkVersion;
    this.connection = { status: "connecting", error: null, cliVersion: null };
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
    this.retargeting = false;
    this.sentMessages = new Map();
    this.weaveThreadIds = new Set();
    this.threadCwds = new Map();
    this.threadPurposes = new Map();
    // Editor turns delegated from a chat run in a child thread. Reverse
    // requests (approval, elicitation, etc.) still belong to the child for
    // JSON-RPC resolution, but the browser must present them in the parent
    // chat so that hiding internal editor notifications cannot hide a request
    // that needs a user response.
    this.editorParentThreads = new Map();
    this.chatToolThreads = new Set();
    this.chatLearningThreads = new Set();
    this.turnPurposes = new Map();
    this.chatMigrations = new Map();
    this.editorThreadStarts = 0;
    // A migrated chat cannot use the excluded thread/inject_items endpoint.
    // Keep the source transcript until the continuation's first turn so it is
    // sent as explicit context in that turn input instead.
    this.threadHistories = new Map();
    this.editSlidesCalls = new Map();
    this.learningCalls = new Set();
    this.chatTurnMessages = new Map();

    this.attachClient(this.client);
  }

  attachClient(client) {
    this.client = client;
    this.router = new ServerRequestRouter(this.client, {
      onDynamicToolCall: (request) => this.handleDynamicToolCall(request),
    });
    this.client.on("notification", (message) => this.handleNotification(message));
    this.client.on("connection", (connection) => {
      this.ready = false;
      if (connection.status === "disconnected") {
        this.uiTools.cancelAll(connection.error ?? "Codex disconnected.");
        this.completeActiveTurns(connection.error ?? "Codex disconnected.");
        this.publishConnection({ ...connection, error: connection.error ?? null });
        return;
      }
      if (connection.status === "connected") {
        // The child process is reachable, but it is not ready until the official
        // initialize -> initialized handshake succeeds.
        this.publishConnection({ status: "connecting", error: null });
        void this.initialize().catch(() => {
          // initialize() publishes the actionable incompatible state. This catch
          // is deliberately attached because reconnect callbacks are fire-and-forget.
        });
        return;
      }
      this.publishConnection({ ...connection, error: connection.error ?? null });
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
    this.router.on("changed", () => this.events.publish("codex/pendingRequests", this.pendingRequests()));
  }

  async start() {
    const versionFile = resolve(
      fileURLToPath(new URL("../../generated/codex-app-server/version.json", import.meta.url)),
    );
    try {
      this.version = await this.checkVersion(versionFile);
    } catch (error) {
      this.publishIncompatible(error, "version check");
      throw error;
    }
    if (!this.version.matches) {
      this.events.publish("codex/versionWarning", {
        warning: this.version.warning,
        generated: this.version.generated,
        running: this.version.running,
      });
    }
    this.connection = {
      status: "connecting",
      error: null,
      cliVersion: this.version.running,
    };
    await this.client.start();
    await this.initialize();
  }

  async initialize() {
    if (this.ready) return;
    if (this.initializing) return await this.initializing;
    this.initializing = (async () => {
      try {
        await this.client.request("initialize", {
          clientInfo: { name: "weave_local", title: "Weave Local Editor", version: "0.1.0" },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            optOutNotificationMethods: [],
            mcpServerOpenaiFormElicitation: true,
          },
        });
        this.client.notify("initialized", {});
        this.ready = true;
        this.publishConnection({
          status: "connected",
          error: null,
          cliVersion: this.version?.running ?? null,
        });
        await this.refreshCatalog();
      } catch (error) {
        this.publishIncompatible(error, "initialize");
        throw error;
      }
    })().finally(() => {
      this.initializing = null;
    });
    return await this.initializing;
  }

  publishConnection(connection) {
    this.connection = {
      ...this.connection,
      ...connection,
      cliVersion: connection.cliVersion ?? this.version?.running ?? this.connection.cliVersion ?? null,
    };
    this.events.publish("codex/connection", this.connection);
  }

  publishIncompatible(error, phase) {
    this.ready = false;
    const message = error instanceof Error ? error.message : String(error);
    const generated = this.version?.generated ?? "unknown";
    const running = this.version?.running ?? "unknown";
    const actionable = `Codex app-server ${phase} failed: ${message} (generated bindings ${generated}, running CLI ${running}). Check the Codex CLI/app-server version with npm run codex:check and retry.`;
    this.publishConnection({ status: "incompatible", error: actionable });
  }

  /**
   * Return pending app-server requests with a presentation thread for the
   * browser. The request's params.threadId is intentionally left untouched:
   * local-api resolves by the original JSON-RPC id and must retain the child
   * thread context. Consumers should use parentThreadId for grouping when it
   * is present.
   */
  pendingRequests() {
    return this.router.list().map((request) => {
      const childThreadId = request.params?.threadId;
      const parentThreadId = typeof childThreadId === "string"
        ? this.editorParentThreads.get(childThreadId)
        : null;
      return parentThreadId
        ? { ...request, parentThreadId }
        : request;
    });
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

  isInternalEditorNotification(method, params) {
    const threadId = params.threadId ?? params.thread?.id ?? params.turn?.threadId ?? null;
    if (threadId && this.threadPurposes.get(threadId) === "editor") return true;
    if (isEditorThread(params.thread)) return true;
    return method === "thread/started" && this.editorThreadStarts > 0;
  }

  handleNotification(message) {
    const { method, params = {} } = message;
    const internalEditor = this.isInternalEditorNotification(method, params);
    // Native subagents are separate from Weave's delegated editor threads.
    if (isSubagentThread(params.thread)) return;
    if (method === "thread/started") {
      if (!internalEditor && !this.isWeaveThread(params.thread)) return;
      this.weaveThreadIds.add(params.thread.id);
    }
    const notificationThreadId = params.threadId ?? params.thread?.id;
    if (notificationThreadId && !internalEditor && !this.weaveThreadIds.has(notificationThreadId) && !this.activeTurns.has(notificationThreadId)) return;
    if (method === "turn/started") {
      const threadId = params.threadId ?? params.thread?.id;
      const turnId = params.turn?.id ?? params.turnId;
      if (threadId && turnId) {
        this.activeTurns.set(threadId, turnId);
        this.turnPurposes.set(threadId, this.threadPurposes.get(threadId) ?? "chat");
        const messages = this.chatTurnMessages.get(threadId);
        if (messages && messages.turnId === null) messages.turnId = turnId;
      }
    }
    if (method === "turn/completed") {
      const threadId = params.threadId;
      if (threadId) {
        const turnId = params.turn?.id ?? params.turnId ?? this.activeTurns.get(threadId);
        if (turnId) this.uiTools.cancelTurn(threadId, turnId);
        this.activeTurns.delete(threadId);
        this.turnPurposes.delete(threadId);
        this.interruptingThreads.delete(threadId);
        this.chatTurnMessages.delete(threadId);
        const prefix = `${threadId}:${turnId}:`;
        for (const key of this.editSlidesCalls.keys()) if (key.startsWith(prefix)) this.editSlidesCalls.delete(key);
        for (const key of this.learningCalls) if (key.startsWith(prefix)) this.learningCalls.delete(key);
      }
    }
    if (method === "thread/deleted" && params.threadId) {
      this.editorParentThreads.delete(params.threadId);
      this.chatTurnMessages.delete(params.threadId);
    }
    if (method === "account/updated" || method === "account/login/completed") void this.refreshCatalog();
    if (method === "skills/changed") void this.refreshCatalog();
    if (method === "mcpServer/oauthLogin/completed") void this.refreshCatalog();
    if (method === "mcpServer/startupStatus/updated") void this.refreshCatalog();
    if (!internalEditor) this.events.publish("codex/notification", message);
    this.emit("notification", message);
  }

  completeActiveTurns(error) {
    for (const [threadId, turnId] of this.activeTurns) {
      this.handleNotification({
        method: "turn/completed",
        params: {
          threadId,
          turn: { id: turnId, status: "failed", error },
        },
      });
    }
  }

  assertReady() {
    if (!this.ready) throw new Error("Codex app-server is not ready.");
  }

  assertNotRetargeting() {
    if (this.retargeting) throw new Error("Codex project root is changing.");
  }

  isWeaveThread(thread, expectedCwd = null) {
    const knownCwd = thread?.id ? this.threadCwds.get(thread.id) : null;
    const expectedRoot = expectedCwd ?? knownCwd ?? null;
    const threadCwd = typeof thread?.cwd === "string" ? resolve(thread.cwd) : null;
    return (
      !isSubagentThread(thread) &&
      threadCwd !== null &&
      (expectedRoot === null ? isWithinRoot(this.workspaceRoot, threadCwd) : threadCwd === expectedRoot) &&
      (
        thread?.threadSource === WEAVE_THREAD_SOURCE ||
        thread?.name?.startsWith(WEAVE_NAME_PREFIX) ||
        this.weaveThreadIds.has(thread?.id)
      )
    );
  }

  async assertWeaveThread(threadId, { includeTurns = false, cwd = null } = {}) {
    const result = await this.client.request("thread/read", { threadId, includeTurns });
    const expectedCwd = cwd === null || cwd === undefined
      ? this.threadCwds.get(threadId) ?? null
      : requireWorkspaceCwd(cwd, this.workspaceRoot);
    if (!this.isWeaveThread(result.thread, expectedCwd)) {
      throw new Error(
        `Thread is not owned by this Weave workspace (source=${result.thread?.threadSource ?? "none"}, cwd=${result.thread?.cwd ?? "none"}).`,
      );
    }
    this.weaveThreadIds.add(result.thread.id);
    this.threadCwds.set(result.thread.id, requireWorkspaceCwd(result.thread.cwd, this.workspaceRoot));
    return result.thread;
  }

  async listThreads({ searchTerm = null, archived = false, cursor = null } = {}) {
    this.assertReady();
    const result = await this.client.request("thread/list", {
      cwd: null,
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
        !isSubagentThread(thread) && !isEditorThread(thread) &&
        typeof thread.cwd === "string" && isWithinRoot(this.workspaceRoot, resolve(thread.cwd)) &&
        (thread.threadSource === WEAVE_THREAD_SOURCE || isChatToolThread(thread) || this.weaveThreadIds.has(thread.id))
      ) return thread;
      try {
        const read = await this.client.request("thread/read", { threadId: thread.id, includeTurns: false });
        return !isEditorThread(read.thread) && this.isWeaveThread(read.thread) && read.thread?.threadSource === WEAVE_THREAD_SOURCE
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
    for (const thread of data) {
      this.weaveThreadIds.add(thread.id);
      if (isChatToolThread(thread)) {
        this.chatToolThreads.add(thread.id);
        this.threadPurposes.set(thread.id, "chat");
      }
    }
    return { ...result, data: data.map(threadWithVisibleName) };
  }

  async startThread(options = {}) {
    this.assertNotRetargeting();
    this.assertReady();
    const purpose = requireThreadPurpose(options.purpose);
    if (options.cwd === undefined) throw new Error("Thread cwd must be explicitly set.");
    const cwd = requireWorkspaceCwd(options.cwd, this.workspaceRoot);
    if (options.parentThreadId !== undefined && options.parentThreadId !== null && (typeof options.parentThreadId !== "string" || options.parentThreadId.length === 0)) {
      throw new Error("parentThreadId must be a non-empty string or null.");
    }
    const isChat = purpose === "chat";
    const baseInstructions = options.instructions === undefined
      ? (isChat ? this.chatInstructions : this.instructions)
      : options.instructions;
    if (!isChat) this.editorThreadStarts += 1;
    try {
      const result = await this.client.request("thread/start", {
        cwd,
        approvalPolicy: options.approvalPolicy ?? "never",
        approvalsReviewer: options.approvalPolicy === "never" || !options.approvalPolicy ? null : "user",
        sandbox: isChat ? "read-only" : "workspace-write",
        baseInstructions,
        serviceName: "Weave",
        threadSource: WEAVE_THREAD_SOURCE,
        sessionStartSource: "clear",
        ephemeral: false,
        model: options.model ?? null,
        ...(isChat ? { dynamicTools: uiDynamicTools({ purpose, learning: this.slidePreferenceLearning !== null }) } : {}),
      });
      // Record the purpose before the name request. A child thread can emit
      // notifications between thread/start and thread/name/set; those events
      // must never make the browser switch away from its chat coordinator.
      this.weaveThreadIds.add(result.thread.id);
      this.threadCwds.set(result.thread.id, cwd);
      this.threadPurposes.set(result.thread.id, purpose);
      if (purpose === "editor" && options.parentThreadId !== undefined && options.parentThreadId !== null) {
        this.editorParentThreads.set(result.thread.id, options.parentThreadId);
      }
      if (isChat) this.chatToolThreads.add(result.thread.id);
      if (isChat && this.slidePreferenceLearning !== null) this.chatLearningThreads.add(result.thread.id);
      const threadName = `${WEAVE_NAME_PREFIX}New conversation`;
      const persistedThreadName = isChat
        ? markedThreadName(threadName, this.slidePreferenceLearning !== null)
        : markedEditorThreadName(threadName);
      await this.client.request("thread/name/set", {
        threadId: result.thread.id,
        name: persistedThreadName,
      });
      result.thread.name = threadName;
      return threadWithVisibleName(result.thread);
    } finally {
      if (!isChat) this.editorThreadStarts -= 1;
    }
  }

  async ensureChatThread(threadId, { cwd, approvalPolicy = "never", model } = {}) {
    this.assertNotRetargeting();
    if (cwd === undefined) throw new Error("Chat continuation cwd must be explicitly set.");
    // Read the source in its persisted project first. A chat can be resumed
    // after the user switches projects, so the requested destination cwd must
    // not be used to reject the source before migration is considered.
    const source = await this.assertWeaveThread(threadId, { includeTurns: true });
    if (this.threadPurposes.get(threadId) === "editor" || isEditorThread(source)) throw new Error("An editor thread cannot be used as a chat coordinator.");
    if (isChatToolThread(source)) {
      this.chatToolThreads.add(threadId);
      this.threadPurposes.set(threadId, "chat");
    }
    if (isLearningToolThread(source)) this.chatLearningThreads.add(threadId);
    const targetCwd = requireWorkspaceCwd(cwd, this.workspaceRoot);
    const alreadyToolCapable = this.chatToolThreads.has(threadId);
    const hasLearningTools = this.slidePreferenceLearning === null || this.chatLearningThreads.has(threadId);
    if (alreadyToolCapable && hasLearningTools && targetCwd === requireThreadCwd(source.cwd)) {
      return { thread: threadWithVisibleName(source), migrated: false, sourceThreadId: threadId };
    }
    if (this.activeTurns.has(threadId)) {
      throw new Error("An active chat coordinator cannot move to another project while its turn is running.");
    }

    const migrationKey = `${threadId}:${targetCwd}`;
    const existingMigration = this.chatMigrations.get(migrationKey);
    if (existingMigration) return await existingMigration;
    const migration = (async () => {
      const continuation = await this.startThread({ purpose: "chat", cwd: targetCwd, approvalPolicy, model });
      const history = Array.isArray(source.turns) && source.turns.length > 0
        ? source.turns.map((turn, index) => `Turn ${index + 1}:\n${JSON.stringify(turn)}`).join("\n\n")
        : "";
      const continuationName = `${WEAVE_NAME_PREFIX}Continuation`;
      await this.client.request("thread/name/set", {
        threadId: continuation.id,
        name: markedThreadName(continuationName, this.slidePreferenceLearning !== null),
      });
      continuation.name = continuationName;
      if (history) this.threadHistories.set(continuation.id, {
        sourceThreadId: source.id,
        text: history,
      });
      return { thread: threadWithVisibleName(continuation), migrated: true, sourceThreadId: source.id };
    })();
    this.chatMigrations.set(migrationKey, migration);
    try {
      return await migration;
    } finally {
      this.chatMigrations.delete(migrationKey);
    }
  }

  async readThread(threadId) {
    return threadWithVisibleName(await this.assertWeaveThread(threadId, { includeTurns: true }));
  }

  async resumeThread(threadId) {
    this.assertNotRetargeting();
    const thread = await this.assertWeaveThread(threadId);
    const purpose = this.threadPurposes.get(threadId) ?? (isEditorThread(thread) ? "editor" : "chat");
    const result = await this.client.request("thread/resume", {
      threadId,
      cwd: thread.cwd,
      baseInstructions: purpose === "chat" ? this.chatInstructions : this.instructions,
    });
    this.threadCwds.set(threadId, thread.cwd);
    return threadWithVisibleName(result.thread);
  }

  async forkThread(threadId, lastTurnId = null) {
    this.assertNotRetargeting();
    const source = await this.assertWeaveThread(threadId);
    const purpose = this.threadPurposes.get(threadId) ?? (isEditorThread(source) ? "editor" : "chat");
    const result = await this.client.request("thread/fork", {
      threadId,
      lastTurnId,
      cwd: source.cwd,
      baseInstructions: purpose === "chat" ? this.chatInstructions : this.instructions,
      threadSource: WEAVE_THREAD_SOURCE,
    });
    await this.client.request("thread/name/set", {
      threadId: result.thread.id,
      name: purpose === "editor"
        ? markedEditorThreadName(`${WEAVE_NAME_PREFIX}Fork`)
        : `${WEAVE_NAME_PREFIX}Fork`,
    });
    result.thread.name = `${WEAVE_NAME_PREFIX}Fork`;
    this.weaveThreadIds.add(result.thread.id);
    this.threadCwds.set(result.thread.id, source.cwd);
    if (this.threadPurposes.has(threadId)) this.threadPurposes.set(result.thread.id, this.threadPurposes.get(threadId));
    return threadWithVisibleName(result.thread);
  }

  async threadAction(action, params) {
    this.assertNotRetargeting();
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
    const thread = await this.assertWeaveThread(params.threadId);
    const safeParams = action === "name"
      ? { ...params, name: (isChatToolThread(thread) || this.chatToolThreads.has(params.threadId))
        ? markedThreadName(`${WEAVE_NAME_PREFIX}${String(params.name ?? "Untitled").replace(/^Weave · /, "")}`, isLearningToolThread(thread) || this.chatLearningThreads.has(params.threadId))
        : isEditorThread(thread) || this.threadPurposes.get(params.threadId) === "editor"
          ? markedEditorThreadName(`${WEAVE_NAME_PREFIX}${String(params.name ?? "Untitled").replace(/^Weave · /, "")}`)
        : `${WEAVE_NAME_PREFIX}${String(params.name ?? "Untitled").replace(/^Weave · /, "")}` }
      : params;
    return await this.client.request(method, safeParams);
  }

  async startTurn({ threadId: requestedThreadId, prompt, humanPrompt, clientUserMessageId, model, effort, approvalPolicy = "never", attachments, purpose, cwd, instructions }) {
    this.assertNotRetargeting();
    const turnPurpose = requireThreadPurpose(purpose);
    if (cwd === undefined) throw new Error("Turn cwd must be explicitly set.");
    if (!clientUserMessageId) throw new Error("clientUserMessageId is required.");
    const humanMessage = turnPurpose === "chat" ? originalHumanMessage(clientUserMessageId, humanPrompt) : null;

    // Every chat thread must have the dynamic-tool namespace. A persisted
    // legacy thread is continued in a fresh tool-capable thread before the
    // turn starts; the source thread remains immutable and readable.
    let threadId = requestedThreadId;
    let thread;
    let migrated = false;
    if (turnPurpose === "chat") {
      const targetCwd = requireWorkspaceCwd(cwd, this.workspaceRoot);
      const ensured = await this.ensureChatThread(requestedThreadId, { cwd: targetCwd, approvalPolicy, model });
      thread = ensured.thread;
      threadId = thread.id;
      migrated = ensured.migrated;
    } else {
      const turnCwd = requireWorkspaceCwd(cwd, this.workspaceRoot);
      thread = await this.assertWeaveThread(threadId, { cwd: turnCwd });
    }

    const turnCwd = requireWorkspaceCwd(thread.cwd, this.workspaceRoot);
    const knownPurpose = this.threadPurposes.get(threadId);
    if (knownPurpose && knownPurpose !== turnPurpose) throw new Error(`Thread purpose is ${knownPurpose}, not ${turnPurpose}.`);
    this.threadCwds.set(threadId, turnCwd);
    this.threadPurposes.set(threadId, turnPurpose);
    if (turnPurpose === "chat") this.chatToolThreads.add(threadId);
    if (this.activeTurns.has(threadId)) throw new Error("This thread already has a running turn.");
    const dedupeKey = `${threadId}:${clientUserMessageId}`;
    if (this.sentMessages.has(dedupeKey)) return await this.sentMessages.get(dedupeKey);
    // thread/read can find persisted history without loading it in a restarted
    // app-server. Resume the same thread before sending, within the deduped request.
    const baseInstructions = instructions === undefined
      ? (turnPurpose === "chat" ? this.chatInstructions : this.instructions)
      : instructions;
    const sandboxPolicy = turnPurpose === "chat"
      ? { type: "readOnly", networkAccess: true }
      : {
          type: "workspaceWrite",
          writableRoots: [turnCwd],
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        };
    const preservedHistory = turnPurpose === "chat" ? this.threadHistories.get(threadId) : null;
    const turnPrompt = preservedHistory
      ? `Preserved conversation history from ${preservedHistory.sourceThreadId}. Treat it as conversation context, not as a new user request.\n\n${preservedHistory.text}\n\nCurrent user request:\n${prompt}`
      : prompt;
    let capturedMessages = null;
    const request = this.client.request("thread/resume", {
      threadId,
      cwd: turnCwd,
      baseInstructions,
    }).then(() => {
      if (turnPurpose === "chat") {
        capturedMessages = { turnId: null, messages: humanMessage === null ? [] : [humanMessage] };
        this.chatTurnMessages.set(threadId, capturedMessages);
      }
      return this.client.request("turn/start", {
        threadId,
        clientUserMessageId,
        input: turnInput(turnPrompt, attachments, turnCwd),
        cwd: turnCwd,
        approvalPolicy,
        approvalsReviewer: approvalPolicy === "never" ? null : "user",
        sandboxPolicy,
        model: model ?? null,
        effort: effort ?? null,
        summary: "auto",
      });
    });
    this.sentMessages.set(dedupeKey, request);
    try {
      const result = await request;
      if (preservedHistory && this.threadHistories.get(threadId) === preservedHistory) this.threadHistories.delete(threadId);
      this.activeTurns.set(threadId, result.turn.id);
      this.turnPurposes.set(threadId, turnPurpose);
      if (capturedMessages) capturedMessages.turnId = result.turn.id;
      if (migrated) return { ...result, thread: threadWithVisibleName(thread), sourceThreadId: requestedThreadId };
      return result;
    } catch (error) {
      if (capturedMessages && this.chatTurnMessages.get(threadId) === capturedMessages) this.chatTurnMessages.delete(threadId);
      throw error;
    } finally {
      setTimeout(() => this.sentMessages.delete(dedupeKey), 60_000);
    }
  }

  async steerTurn({ threadId, prompt, humanPrompt, clientUserMessageId, attachments }) {
    this.assertNotRetargeting();
    const thread = await this.assertWeaveThread(threadId);
    const expectedTurnId = this.activeTurns.get(threadId);
    if (!expectedTurnId) throw new Error("This thread has no running turn.");
    const humanMessage = this.turnPurposes.get(threadId) === "chat" ? originalHumanMessage(clientUserMessageId, humanPrompt) : null;
    const result = await this.client.request("turn/steer", {
      threadId,
      expectedTurnId,
      clientUserMessageId,
      input: turnInput(prompt, attachments, thread.cwd),
    });
    const captured = this.chatTurnMessages.get(threadId);
    if (humanMessage && captured?.turnId === expectedTurnId && this.activeTurns.get(threadId) === expectedTurnId && !captured.messages.some((message) => message.id === humanMessage.id)) captured.messages.push(humanMessage);
    return result;
  }

  async interruptTurn(threadId) {
    await this.assertWeaveThread(threadId);
    const turnId = this.activeTurns.get(threadId);
    if (!turnId) return { status: "idle" };
    if (this.interruptingThreads.has(threadId)) return { status: "interrupting", turnId };
    this.uiTools.cancelTurn(threadId, turnId, "The chat coordinator turn was interrupted before the browser UI action completed.");
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

  isActiveChatTurn(params) {
    return typeof params?.threadId === "string"
      && typeof params?.turnId === "string"
      && this.activeTurns.get(params.threadId) === params.turnId
      && this.turnPurposes.get(params.threadId) === "chat"
      && !this.interruptingThreads.has(params.threadId);
  }

  rejectStaleUiTool(request) {
    const error = new Error("UI actions require an active chat coordinator turn.");
    error.code = "WEAVE_UI_STALE_TURN";
    this.client.respond(request.id, dynamicToolResult({ error: error.message, code: error.code }, false));
    return { accepted: false, error };
  }

  async handleEditSlidesCall(request) {
    const params = request.params;
    const threadId = params?.threadId;
    const turnId = params?.turnId;
    const callId = params?.callId;
    if (!this.isActiveChatTurn(params) || typeof callId !== "string" || callId.length === 0) {
      this.client.respond(request.id, dynamicToolResult({ error: "edit_slides requires an active chat coordinator turn." }, false));
      return { accepted: false, error: "No active chat coordinator turn." };
    }
    let args;
    try {
      args = validateEditSlidesArguments(params.arguments);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.client.respond(request.id, dynamicToolResult({ error: message }, false));
      return { accepted: false, error };
    }
    if (typeof this.onEditSlides !== "function") {
      const error = new Error("The edit_slides handler is not configured.");
      this.client.respond(request.id, dynamicToolResult({ error: error.message }, false));
      return { accepted: false, error };
    }
    const callKey = `${threadId}:${turnId}:${callId}`;
    if (this.editSlidesCalls.has(callKey)) {
      const error = new Error("This edit_slides call has already been handled and will not be replayed.");
      error.code = "WEAVE_UI_REPLAY";
      this.client.respond(request.id, dynamicToolResult({ error: error.message }, false));
      return { accepted: false, error };
    }
    let sessionId = null;
    let originalMessages = [];
    if (this.slidePreferenceLearning !== null) {
      try {
        sessionId = this.uiTools.activeThreadSession(threadId).sessionId;
      } catch (error) {
        this.client.respond(request.id, dynamicToolResult({ error: error.message, code: error.code }, false));
        return { accepted: false, error };
      }
      const captured = this.chatTurnMessages.get(threadId);
      if (captured?.turnId === turnId) originalMessages = structuredClone(captured.messages);
    }
    this.editSlidesCalls.set(callKey, { state: "pending" });
    try {
      const result = await this.onEditSlides(params, args);
      if (!result || typeof result !== "object" || typeof result.success !== "boolean") throw new Error("The edit_slides handler must return { success, result } or { success, error }.");
      if (result.success === true) {
        if (!Object.hasOwn(result, "result")) throw new Error("A successful edit_slides result must contain result.");
        const response = dynamicToolResult(result.result, true);
        this.editSlidesCalls.set(callKey, {
          state: "completed",
          threadId,
          turnId,
          sessionId,
          originalMessages,
          edit: {
            callId,
            execution: args.execution,
            scope: structuredClone(args.scope),
            projectRoot: result.result?.projectRoot,
            changeCount: result.result?.changeCount,
            conflictCount: result.result?.conflictCount,
          },
        });
        this.client.respond(request.id, response);
      } else {
        if (typeof result.error !== "string" || result.error.length === 0) throw new Error("A failed edit_slides result must contain a non-empty error.");
        this.client.respond(request.id, dynamicToolResult({ error: result.error }, false));
        this.editSlidesCalls.set(callKey, { state: "completed" });
      }
      return { accepted: true };
    } catch (error) {
      this.editSlidesCalls.set(callKey, { state: "completed" });
      const message = error instanceof Error ? error.message : String(error);
      this.client.respond(request.id, dynamicToolResult({ error: message }, false));
      return { accepted: false, error };
    } finally {
      // A delegated edit can settle after its root turn was interrupted. Keep
      // its actual result, but never retain old human evidence for a new turn.
      if (!this.isActiveChatTurn(params)) this.editSlidesCalls.delete(callKey);
    }
  }

  assertLearningSession(params, sessionId) {
    if (!this.isActiveChatTurn(params)) throw Object.assign(new Error("Learning requires an active chat coordinator turn."), { code: "WEAVE_UI_STALE_TURN" });
    const session = this.uiTools.activeThreadSession(params.threadId);
    if (session.sessionId !== sessionId) throw Object.assign(new Error("The browser that owned the slide correction is no longer attached to this chat."), { code: "WEAVE_UI_SESSION_MISMATCH" });
  }

  async handleSlideLearningCall(request) {
    const params = request.params;
    let canRecordFailure = false;
    try {
      if (this.slidePreferenceLearning === null) throw new Error("Slide preference learning is not configured.");
      if (typeof params.callId !== "string" || !params.callId || params.callId.length > 200) throw new Error("A learning tool call id is required.");
      const sessionId = this.uiTools.activeThreadSession(params.threadId).sessionId;
      this.assertLearningSession(params, sessionId);
      const callKey = `${params.threadId}:${params.turnId}:${params.callId}`;
      if (this.learningCalls.has(callKey)) throw Object.assign(new Error("This learning call has already been handled and will not be replayed."), { code: "WEAVE_UI_REPLAY" });
      this.learningCalls.add(callKey);
      canRecordFailure = true;
      let result;
      if (params.tool === GET_SLIDE_LEARNING_TOOL_NAME) {
        if (!params.arguments || typeof params.arguments !== "object" || Array.isArray(params.arguments) || Object.keys(params.arguments).length !== 0) throw new Error("get_slide_learning_context requires an empty argument object.");
        const state = await this.slidePreferenceLearning.getContext();
        this.assertLearningSession(params, sessionId);
        const captured = this.chatTurnMessages.get(params.threadId);
        const originalMessages = captured?.turnId === params.turnId ? structuredClone(captured.messages) : [];
        const successfulEdits = [...this.editSlidesCalls.values()]
          .filter((call) => call.state === "completed" && call.threadId === params.threadId && call.turnId === params.turnId && call.sessionId === sessionId && call.edit?.execution === "apply" && Number.isSafeInteger(call.edit.changeCount) && call.edit.changeCount > 0 && call.edit.conflictCount === 0 && typeof call.edit.projectRoot === "string")
          .map((call) => ({ ...call.edit, messageIds: call.originalMessages.map((message) => message.id) }));
        const reason = !state.enabled ? "Automatic slide preference learning is disabled." : originalMessages.length === 0 ? "No original human text is available for this turn." : successfulEdits.length === 0 ? "No successful applied slide edit with changes is available in this browser session." : null;
        result = { ...state, available: reason === null, reason, originalMessages, successfulEdits };
      } else {
        const args = validateLearnSlidePreferenceArguments(params.arguments);
        const edit = this.editSlidesCalls.get(`${params.threadId}:${params.turnId}:${args.editCallId}`);
        if (!edit || edit.state !== "completed" || !edit.edit) throw Object.assign(new Error("The referenced slide edit did not complete successfully in this chat turn."), { code: "WEAVE_LEARNING_NO_EDIT" });
        if (edit.sessionId !== sessionId) throw Object.assign(new Error("The referenced slide edit belongs to a different browser session."), { code: "WEAVE_UI_SESSION_MISMATCH" });
        result = await this.slidePreferenceLearning.learn(args, {
          threadId: params.threadId,
          turnId: params.turnId,
          edit: edit.edit,
          originalMessages: edit.originalMessages,
          assertAvailable: () => this.assertLearningSession(params, sessionId),
        });
        this.events.publish("weave/learning", { ...result, threadId: params.threadId, turnId: params.turnId });
      }
      this.client.respond(request.id, dynamicToolResult(result, true));
      return { accepted: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (canRecordFailure && params.tool === LEARN_SLIDE_PREFERENCE_TOOL_NAME && this.slidePreferenceLearning !== null) {
        try { await this.slidePreferenceLearning.recordFailure({ threadId: params.threadId, turnId: params.turnId }, message); } catch { /* Never roll back saved slides when learning storage is unavailable. */ }
      }
      this.client.respond(request.id, dynamicToolResult({ error: message, ...(error.code ? { code: error.code } : {}) }, false));
      return { accepted: false, error };
    }
  }

  handleDynamicToolCall(request) {
    if (request.params?.namespace === UI_TOOL_NAMESPACE && !this.isActiveChatTurn(request.params)) {
      return this.rejectStaleUiTool(request);
    }
    if (request.params?.namespace === UI_TOOL_NAMESPACE && request.params?.tool === EDIT_SLIDES_TOOL_NAME) {
      return this.handleEditSlidesCall(request);
    }
    if (request.params?.namespace === UI_TOOL_NAMESPACE && [GET_SLIDE_LEARNING_TOOL_NAME, LEARN_SLIDE_PREFERENCE_TOOL_NAME].includes(request.params?.tool)) {
      return this.handleSlideLearningCall(request);
    }
    return this.uiTools.dispatch(request, (id, result) => this.client.respond(id, result));
  }

  async stop() {
    this.uiTools.cancelAll("Codex app-server stopped.");
    this.router.dispose();
    await this.client.stop();
  }

  async setProjectRoot(root) {
    const nextRoot = requireWorkspaceCwd(root, this.workspaceRoot);
    if (this.retargeting) throw new Error("Codex project root is already changing.");
    if (nextRoot === this.projectRoot) return;
    const editorTurns = [...this.activeTurns.keys()].filter((threadId) => this.turnPurposes.get(threadId) === "editor");
    if (editorTurns.length > 0) throw new Error("Codex project root cannot change while an editor turn is running.");
    if (this.activeTurns.size > 0) {
      this.projectRoot = nextRoot;
      await this.refreshCatalog();
      this.events.publish("codex/projectRoot", { root: this.projectRoot, restarted: false });
      return;
    }
    this.retargeting = true;
    try {
      const pendingTurns = [...this.activeTurns.entries()];
      await Promise.all(pendingTurns.map(([threadId]) => this.interruptTurn(threadId).catch(() => {})));
      for (const [threadId, turnId] of pendingTurns) {
        if (this.activeTurns.get(threadId) === turnId) {
          this.handleNotification({
            method: "turn/completed",
            params: {
              threadId,
              turn: { id: turnId, status: "failed", error: "Codex project root changed." },
            },
          });
        }
      }
      this.interruptingThreads.clear();
      this.sentMessages.clear();
      await this.stop();
      this.projectRoot = nextRoot;
      this.ready = false;
      this.weaveThreadIds.clear();
      this.catalog = { models: [], skills: [], hooks: [], mcpServers: [], account: null, modelProvider: null };
      this.client = new CodexAppServerClient({ cwd: nextRoot });
      this.attachClient(this.client);
      this.events.publish("codex/connection", { status: "connecting", error: null });
      await this.start();
    } finally {
      this.retargeting = false;
    }
  }
}
