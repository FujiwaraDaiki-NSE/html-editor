import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { classifyMessage, parseJsonLine, rpcError } from "./protocol.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;

export class CodexAppServerClient extends EventEmitter {
  constructor({
    cwd,
    command = "codex",
    args = ["app-server", "--listen", "stdio://"],
    spawn = nodeSpawn,
    requestTimeoutMs = DEFAULT_TIMEOUT_MS,
    autoRestart = true,
    restartDelayMs = 750,
  } = {}) {
    super();
    this.cwd = cwd;
    this.command = command;
    this.args = args;
    this.spawn = spawn;
    this.requestTimeoutMs = requestTimeoutMs;
    this.autoRestart = autoRestart;
    this.restartDelayMs = restartDelayMs;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stopping = false;
    this.restartTimer = null;
  }

  get connected() {
    return Boolean(this.child?.stdin?.writable);
  }

  async start() {
    if (this.child) return;
    this.stopping = false;
    const child = this.spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) this.emit("log", text);
    });
    child.once("error", (error) => this.handleExit(child, error));
    child.once("exit", (code, signal) => {
      this.handleExit(child, new Error(`Codex app-server exited (${code ?? signal ?? "unknown"}).`));
    });
    this.emit("connection", { status: "connected" });
  }

  handleLine(line) {
    const parsed = parseJsonLine(line);
    if (!parsed.ok) {
      this.emit("protocolError", parsed.error, line);
      return;
    }
    const { message } = parsed;
    const kind = classifyMessage(message);
    if (kind === "response") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.emit("orphanResponse", message);
        return;
      }
      this.pending.delete(message.id);
      pending.cleanup();
      if (message.error) {
        const error = new Error(message.error.message ?? "Codex request failed.");
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    this.emit(kind, message);
  }

  request(method, params, { timeoutMs = this.requestTimeoutMs, signal } = {}) {
    if (!this.connected) return Promise.reject(new Error("Codex app-server is not connected."));
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer;
      const abort = () => {
        this.pending.delete(id);
        cleanup();
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        reject(new Error(`${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { resolve, reject, cleanup, method });
      this.write({ method, id, params });
    });
  }

  notify(method, params) {
    this.write({ method, params });
  }

  respond(id, result) {
    this.write({ id, result });
  }

  respondError(id, code, message, data) {
    this.write({ id, error: rpcError(code, message, data) });
  }

  write(message) {
    if (!this.connected) throw new Error("Codex app-server is not connected.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleExit(child, error) {
    if (this.child !== child) return;
    this.child = null;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("connection", { status: "disconnected", error: error.message });
    if (!this.stopping && this.autoRestart && !this.restartTimer) {
      this.emit("connection", { status: "reconnecting" });
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        void this.start().catch((restartError) => this.emit("error", restartError));
      }, this.restartDelayMs);
    }
  }

  async stop() {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.kill("SIGTERM");
    const error = new Error("Codex app-server stopped.");
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }
}
