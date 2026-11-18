import { EventEmitter } from "node:events";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const exec = promisify(execFile);
// Versioned IDs are pinned to the official Anthropic model catalog (2026-11-18).
// Keep aliases for existing conversations, clearly separate from versioned choices.
export const CLAUDE_MODELS = [
  ...[
    ["opus", "5.5"], ["opus", "5"], ["opus", "4.8"], ["opus", "4.7"], ["opus", "4.6"],
    ["sonnet", "5.5"], ["sonnet", "5"], ["sonnet", "4.6"], ["haiku", "5.5"],
  ].map(([family, version]) => ({
    model: `claude-${family}-${version.replaceAll(".", "-")}`,
    displayName: `Claude ${family[0].toUpperCase()}${family.slice(1)} ${version}`,
    supportsEffort: true,
    defaultReasoningEffort: (family === "opus" || family === "haiku") && version === "5.5" ? "medium" : "high",
    version,
  })),
  ...["opus", "sonnet", "haiku"].map((family) => ({
    model: family, displayName: `Claude ${family[0].toUpperCase()}${family.slice(1)}（最新版）`,
    supportsEffort: family !== "haiku", defaultReasoningEffort: family === "haiku" ? null : "high", version: null,
  })),
].map(({ model, displayName, supportsEffort, defaultReasoningEffort, version }) => ({
  id: `claude:${model}`, provider: "claude", displayName, version,
  supportedReasoningEfforts: supportsEffort ? ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort })) : [],
  defaultReasoningEffort,
}));

// Claude Code owns authentication and its native session. Weave only stores the
// editor transcript; no Claude credentials or Codex app-server calls live here.
export class ClaudeService extends EventEmitter {
  constructor({ projectRoot, instructions, command = "claude", spawnProcess = spawn, runCommand = exec,
    storageRoot = fileURLToPath(new URL("../../.weave/claude", import.meta.url)) }) {
    super();
    Object.assign(this, { projectRoot, instructions, command, spawnProcess, runCommand, storageRoot });
    this.activeTurns = new Map();
    this.processes = new Map();
    this.sentMessages = new Map();
    this.stopping = false;
    this.ready = false;
    this.connection = { status: "connecting", error: null, cliVersion: null };
  }

  async start() {
    try {
      const { stdout: version } = await this.runCommand(this.command, ["--version"], { timeout: 10_000 });
      const { stdout } = await this.runCommand(this.command, ["auth", "status"], { timeout: 10_000 });
      const auth = JSON.parse(stdout);
      if (auth.loggedIn !== true) throw new Error("Run claude auth login on the editor host.");
      this.ready = true;
      this.connection = { status: "connected", error: null, cliVersion: version.trim() };
    } catch (error) {
      this.ready = false;
      this.connection = { status: "disconnected", error: `Claude Code unavailable. Run claude auth login on the editor host. ${error.message}`, cliVersion: null };
    }
    this.emit("connection", this.connection);
  }

  directory() { return join(this.storageRoot, createHash("sha256").update(resolve(this.projectRoot)).digest("hex")); }
  path(id) {
    if (!/^claude:[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid Claude thread ID.");
    return join(this.directory(), `${id.slice(7)}.json`);
  }
  async persist(thread) {
    const path = this.path(thread.id);
    await mkdir(this.directory(), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(thread), { mode: 0o600 });
    await rename(temp, path);
  }
  notify(method, params) { this.emit("notification", { method, params }); }
  async readThread(id) {
    const thread = JSON.parse(await readFile(this.path(id), "utf8"));
    if (thread.cwd !== this.projectRoot) throw new Error("Claude thread is not owned by this project.");
    if (!this.activeTurns.has(id)) {
      const unfinished = thread.turns.filter((turn) => turn.status === "inProgress");
      for (const turn of unfinished) {
        turn.status = "failed";
        turn.error = { message: "The editor restarted before the Claude Code result was recorded. This request was not retried." };
        for (const item of turn.items) if (item.status === "running") item.status = "failed";
      }
      if (unfinished.length) await this.persist(thread);
    }
    return thread;
  }
  async resumeThread(id) { return await this.readThread(id); }
  async listThreads({ searchTerm = null, archived = false, cursor = null } = {}) {
    if (cursor !== null) throw new Error("Claude history does not accept a cursor.");
    let names;
    try { names = await readdir(this.directory()); } catch (error) { if (error.code === "ENOENT") return { data: [], nextCursor: null }; throw error; }
    const threads = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => this.readThread(`claude:${name.slice(0, -5)}`)));
    const query = searchTerm === null ? "" : searchTerm.trim().toLocaleLowerCase();
    return { data: threads.filter((thread) => thread.archived === archived && `${thread.name}\n${thread.preview}`.toLocaleLowerCase().includes(query)).sort((a, b) => b.updatedAt - a.updatedAt), nextCursor: null };
  }
  assertModel(model) {
    if (!CLAUDE_MODELS.some((entry) => entry.id === model)) throw new Error("Unknown Claude model. Select a Claude model explicitly.");
  }
  async startThread({ model }) {
    this.assertModel(model);
    if (!this.ready) throw new Error(this.connection.error);
    const sessionId = randomUUID();
    const thread = { id: `claude:${sessionId}`, sessionId, sessionStarted: false, provider: "claude", model, cwd: this.projectRoot,
      effort: null,
      name: "Weave · Claude", preview: "", archived: false, status: "idle", createdAt: Date.now() / 1000, updatedAt: Date.now() / 1000, turns: [] };
    await this.persist(thread);
    this.notify("thread/started", { thread });
    return thread;
  }
  async threadAction(action, params) {
    const thread = await this.readThread(params.threadId);
    if (this.activeTurns.has(thread.id)) throw new Error("Claude thread is running.");
    if (action === "delete") { await rm(this.path(thread.id)); this.notify("thread/deleted", { threadId: thread.id }); return {}; }
    if (action === "name") {
      if (typeof params.name !== "string" || !params.name.trim()) throw new Error("Thread name is required.");
      thread.name = `Weave · ${params.name.replace(/^Weave · /, "")}`;
    } else if (action === "archive" || action === "unarchive") thread.archived = action === "archive";
    else throw new Error(`Claude Code does not support editor action: ${action}.`);
    await this.persist(thread);
    this.notify(action === "name" ? "thread/name/updated" : `thread/${action === "archive" ? "archived" : "unarchived"}`, { threadId: thread.id, name: thread.name });
    return {};
  }

  async startTurn(payload) {
    const { threadId, clientUserMessageId } = payload;
    if (typeof clientUserMessageId !== "string" || !clientUserMessageId) throw new Error("clientUserMessageId is required.");
    const key = `${threadId}:${clientUserMessageId}`;
    if (this.sentMessages.has(key)) return await this.sentMessages.get(key);
    const request = this.launch(payload);
    this.sentMessages.set(key, request);
    try { return await request; } catch (error) {
      this.sentMessages.delete(key);
      throw error;
    }
  }

  async launch({ threadId, prompt, userPrompt, model, effort, attachments }) {
    if (this.stopping) throw new Error("Claude Code service is stopping.");
    if (!this.ready) throw new Error(this.connection.error);
    if (typeof userPrompt !== "string") throw new Error("User prompt is required.");
    this.assertModel(model);
    if (this.activeTurns.has(threadId)) throw new Error("Claude thread is already running.");
    // Reserve before the first await so simultaneous submissions cannot launch twice.
    this.activeTurns.set(threadId, "starting");
    let thread;
    try { thread = await this.readThread(threadId); } catch (error) { this.activeTurns.delete(threadId); throw error; }
    if (thread.archived) { this.activeTurns.delete(threadId); throw new Error("Unarchive this Claude conversation before sending a request."); }
    const descriptor = CLAUDE_MODELS.find((entry) => entry.id === model);
    if (descriptor.supportedReasoningEfforts.length && !descriptor.supportedReasoningEfforts.some((entry) => entry.reasoningEffort === effort)) {
      this.activeTurns.delete(threadId); throw new Error("Invalid Claude reasoning effort.");
    }
    const turn = { id: randomUUID(), status: "inProgress", items: [], error: null };
    const user = { id: randomUUID(), type: "userMessage", content: [{ type: "text", text: userPrompt }], status: "completed" };
    turn.items.push(user);
    thread.turns.push(turn);
    thread.model = model;
    thread.effort = descriptor.supportedReasoningEfforts.length ? effort : null;
    thread.preview = userPrompt.slice(0, 160);
    let instructions;
    try { instructions = await this.instructions(); }
    catch (error) { this.activeTurns.delete(threadId); throw error; }
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--model", model.slice(7), "--settings", JSON.stringify({ fallbackModel: [], switchModelsOnFlag: false }), "--restricted", "--permission-mode", "acceptEdits", "--permission-prompts", "none",
      "--tools", "Read,Edit,Write,Glob,Grep", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--append-system-prompt", instructions,
      thread.sessionStarted ? "--resume" : "--session-id", thread.sessionId];
    if (descriptor.supportedReasoningEfforts.length) args.push("--effort", effort);
    const input = prompt + (attachments?.length ? `\n\nAttached project references (use Read to inspect them):\n${JSON.stringify(attachments)}` : "");
    let child;
    try {
      await this.persist(thread);
      if (this.stopping) throw new Error("Claude Code service is stopping.");
      child = this.spawnProcess(this.command, args, { cwd: this.projectRoot, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (error) { this.activeTurns.delete(threadId); throw error; }
    this.activeTurns.set(threadId, turn.id);
    let resolveDone;
    const record = { child, interrupted: false, done: new Promise((resolve) => { resolveDone = resolve; }) };
    this.processes.set(threadId, record);
    let result = null;
    let saveQueue = Promise.resolve();
    let protocolError = null;
    let stderr = "";
    const blocks = new Map();
    const itemEvent = (method, item) => this.notify(method, { threadId, turnId: turn.id, item });
    const completeMessage = (message) => {
      if (message.parent_tool_use_id) return;
      for (const [index, block] of (message.message?.content ?? []).entries()) {
        if (block.type !== "text" && block.type !== "tool_use") continue;
        const id = block.type === "tool_use" ? block.id : `${message.message.id}:${index}`;
        let item = turn.items.find((entry) => entry.id === id);
        if (!item) { item = { id, type: block.type === "text" ? "agentMessage" : "mcpToolCall", status: "running" }; turn.items.push(item); }
        Object.assign(item, block.type === "text" ? { text: block.text } : { server: "Claude Code", tool: block.name, arguments: block.input });
        item.status = block.type === "tool_use" ? "running" : "completed";
        itemEvent(block.type === "tool_use" ? "item/started" : "item/completed", item);
      }
    };
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.type === "system" && message.subtype === "init") {
          if (message.session_id !== thread.sessionId) throw new Error("Claude session ID did not match the requested session.");
          if (descriptor.version !== null && message.model !== model.slice(7)) throw new Error(`Claude Code selected ${message.model}, but this request requires ${model.slice(7)}.`);
          thread.sessionStarted = true;
          saveQueue = saveQueue.then(() => this.persist(thread)).catch((error) => { processError = error.message; });
        }
        if (message.type === "assistant") completeMessage(message);
        if (message.type === "user" && !message.parent_tool_use_id) {
          for (const block of message.message?.content ?? []) {
            if (block.type !== "tool_result") continue;
            const item = turn.items.find((entry) => entry.id === block.tool_use_id);
            if (!item) continue;
            item.status = block.is_error ? "failed" : "completed";
            item.result = block.content;
            itemEvent("item/completed", item);
          }
        }
        if (message.type === "result") result = message;
        if (message.type === "stream_event" && !message.parent_tool_use_id) {
          const event = message.event;
          if (event.type === "message_start") { blocks.clear(); blocks.set("message", event.message.id); }
          if (event.type === "content_block_start" && event.content_block.type === "text") {
            const item = { id: `${blocks.get("message")}:${event.index}`, type: "agentMessage", text: "", status: "running" };
            turn.items.push(item); blocks.set(event.index, item); itemEvent("item/started", item);
          }
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            const item = blocks.get(event.index);
            if (!item) throw new Error("Claude text delta has no content block.");
            item.text += event.delta.text;
            this.notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: item.id, delta: event.delta.text });
          }
        }
      } catch (error) { protocolError = error.message; this.signal(record, "SIGTERM"); }
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    let processError = null;
    child.on("error", (error) => { processError = error.message; });
    child.stdin.on("error", (error) => { processError = error.message; });
    child.once("close", (code) => {
      void (async () => {
        const denied = Array.isArray(result?.permission_denials) && result.permission_denials.length > 0;
        turn.status = record.interrupted ? "interrupted" : !protocolError && !processError && code === 0 && result?.subtype === "success" && !result.is_error && !denied ? "completed" : "failed";
        if (turn.status === "failed") turn.error = { message: protocolError ?? processError ?? (denied ? "Claude Code denied a tool permission. This editor permits project file tools only." : result?.errors?.join("\n") || result?.result || stderr || "Claude Code exited without a successful result.") };
        for (const item of turn.items) if (item.status === "running") item.status = turn.status;
        thread.updatedAt = Date.now() / 1000;
        thread.status = "idle";
        try { await saveQueue; await this.persist(thread); } catch (error) { turn.status = "failed"; turn.error = { message: `Could not save Claude history: ${error.message}` }; }
        this.activeTurns.delete(threadId);
        this.processes.delete(threadId);
        clearTimeout(record.killTimer);
        this.notify("turn/completed", { threadId, turn });
        resolveDone();
      })();
    });
    this.notify("turn/started", { threadId, turn: { ...turn, items: [] } });
    itemEvent("item/completed", user);
    child.stdin.end(input);
    return { turn: { id: turn.id, status: "inProgress", items: [] } };
  }
  signal(record, signal) {
    try { if (process.platform === "win32") record.child.kill(signal); else process.kill(-record.child.pid, signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  async interruptTurn(threadId) {
    await this.readThread(threadId);
    const record = this.processes.get(threadId);
    if (!record) return { status: "idle" };
    if (!record.interrupted) {
      record.interrupted = true;
      this.signal(record, "SIGTERM");
      record.killTimer = setTimeout(() => this.signal(record, "SIGKILL"), 5_000);
      record.killTimer.unref();
    }
    return { status: "interrupting", turnId: this.activeTurns.get(threadId) };
  }
  async stop() {
    this.stopping = true;
    const records = [...this.processes.entries()];
    await Promise.all(records.map(([id]) => this.interruptTurn(id)));
    await Promise.all(records.map(([, record]) => record.done));
  }
  async setProjectRoot(root) {
    if (this.activeTurns.size) throw new Error("Claude project cannot change while a turn is running.");
    this.projectRoot = root;
    this.sentMessages.clear();
  }
}
