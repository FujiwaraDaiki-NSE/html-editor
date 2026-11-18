import { EventEmitter } from "node:events";
import { CodexService } from "./codex/service.mjs";
import { CodexEventStream } from "./codex/event-stream.mjs";
import { ClaudeService, CLAUDE_MODELS } from "./claude/service.mjs";

// Shared editor transport, with separate execution backends. Claude operations
// are dispatched locally and never sent to the Codex app-server.
export class AgentService extends EventEmitter {
  constructor(options) {
    super();
    this.codex = options.codex ?? new CodexService(options);
    this.claude = options.claude ?? new ClaudeService({ ...options, instructions: () => this.codex.editorInstructions() });
    this.events = new CodexEventStream();
    this.router = this.codex.router;
    this.codex.events.on("event", ({ type, payload }) => {
      if (type === "codex/connection" || type === "codex/catalog") this.publishState();
      else this.events.publish(type, payload);
    });
    this.codex.on("notification", (message) => this.emit("notification", message));
    this.claude.on("notification", (message) => { this.events.publish("codex/notification", message); this.emit("notification", message); });
    this.claude.on("connection", () => this.publishState());
  }
  get ready() { return this.codex.ready || this.claude.ready; }
  get version() { return this.codex.version; }
  get connection() { return { status: this.ready ? "connected" : "disconnected", error: this.ready ? null : [this.codex.connection.error, this.claude.connection.error].filter(Boolean).join("\n"), cliVersion: null }; }
  get activeTurns() { return new Map([...this.codex.activeTurns, ...this.claude.activeTurns]); }
  get catalog() {
    return { ...this.codex.catalog,
      models: [...this.codex.catalog.models.map((model) => ({ ...model, provider: "codex", available: this.codex.ready })), ...CLAUDE_MODELS.map((model) => ({ ...model, available: this.claude.ready }))],
      providers: { codex: { ready: this.codex.ready, connection: this.codex.connection }, claude: { ready: this.claude.ready, connection: this.claude.connection } },
    };
  }
  publishState() { this.events.publish("codex/connection", this.connection); this.events.publish("codex/catalog", this.catalog); }
  async start() { await Promise.allSettled([this.codex.start(), this.claude.start()]); this.router = this.codex.router; this.publishState(); }
  async stop() { await Promise.all([this.codex.stop(), this.claude.stop()]); }
  publishIncompatible(error, phase) { this.codex.publishIncompatible(error, phase); }
  async refreshCatalog() { await Promise.allSettled([this.codex.ready ? this.codex.refreshCatalog() : Promise.resolve(), this.claude.start()]); this.publishState(); return this.catalog; }
  forThread(id) { if (typeof id !== "string") throw new Error("Thread ID is required."); return id.startsWith("claude:") ? this.claude : this.codex; }
  forModel(model) {
    if (typeof model !== "string" || !model.trim()) throw new Error("Model is required. Select a model explicitly.");
    return model.startsWith("claude:") ? this.claude : this.codex;
  }
  async startThread(options) { return await this.forModel(options.model).startThread(options); }
  async readThread(id) { return await this.forThread(id).readThread(id); }
  async resumeThread(id) { return await this.forThread(id).resumeThread(id); }
  async listThreads(options) {
    const claude = await this.claude.listThreads({ ...options, cursor: null });
    if (!this.codex.ready) return claude;
    const codex = await this.codex.listThreads(options);
    return { ...codex, data: [...codex.data, ...claude.data].sort((a, b) => b.updatedAt - a.updatedAt) };
  }
  async startTurn(options) {
    const service = this.forThread(options.threadId);
    if (service !== this.forModel(options.model)) throw new Error("The model provider differs from this conversation. Start a new conversation to switch providers.");
    return await service.startTurn(options);
  }
  async steerTurn(options) {
    if (this.forThread(options.threadId) === this.claude) throw new Error("Claude Code does not accept instructions during a running turn. Stop it or wait for completion.");
    return await this.codex.steerTurn(options);
  }
  async interruptTurn(id) { return await this.forThread(id).interruptTurn(id); }
  async threadAction(action, params) { return await this.forThread(params.threadId).threadAction(action, params); }
  async forkThread(id, lastTurnId) {
    if (this.forThread(id) === this.claude) throw new Error("Claude conversation branching is not available in this editor.");
    return await this.codex.forkThread(id, lastTurnId);
  }
  async setProjectRoot(root) {
    await this.claude.setProjectRoot(root);
    await this.codex.setProjectRoot(root).catch((error) => this.codex.publishIncompatible(error, "project retarget"));
    this.router = this.codex.router;
    this.publishState();
  }
  async login(payload) { return await this.codex.login(payload); }
  async logout() { return await this.codex.logout(); }
  async setSkill(payload) { return await this.codex.setSkill(payload); }
  async startMcpOAuth(name) { return await this.codex.startMcpOAuth(name); }
  async readMcpResource(params) { return await this.codex.readMcpResource(params); }
  async callMcpTool(params) {
    if (this.forThread(params.threadId) === this.claude) throw new Error("Codex MCP tools cannot run in a Claude conversation.");
    return await this.codex.callMcpTool(params);
  }
}
