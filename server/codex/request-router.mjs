import { EventEmitter } from "node:events";

const UI_REQUESTS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

export class ServerRequestRouter extends EventEmitter {
  constructor(client, { timeoutMs = 5 * 60_000 } = {}) {
    super();
    this.client = client;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.onRequest = (request) => this.route(request);
    this.onConnection = (connection) => {
      if (connection.status !== "disconnected") return;
      for (const request of this.pending.values()) clearTimeout(request.timer);
      this.pending.clear();
      this.emit("changed", this.list());
    };
    client.on("serverRequest", this.onRequest);
    client.on("connection", this.onConnection);
  }

  route(request) {
    if (!UI_REQUESTS.has(request.method)) {
      this.client.respondError(request.id, -32601, `Weave does not support server request ${request.method}.`);
      this.emit("rejected", request);
      return;
    }
    if (request.method === "mcpServer/elicitation/request" && request.params?.url) {
      try {
        const url = new URL(request.params.url);
        const safe =
          url.protocol === "https:" ||
          (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname));
        if (!safe) throw new Error("unsafe");
      } catch {
        this.client.respondError(request.id, -32602, "app-server supplied an unsafe elicitation URL.");
        this.emit("rejected", request);
        return;
      }
    }
    const timer = setTimeout(() => {
      if (!this.pending.delete(String(request.id))) return;
      try {
        this.client.respondError(request.id, -32001, "The Weave request timed out.");
      } catch {
        // The app-server process may have disconnected while the request was pending.
      }
      this.emit("changed", this.list());
    }, this.timeoutMs);
    this.pending.set(String(request.id), {
      id: request.id,
      method: request.method,
      params: request.params ?? {},
      createdAt: Date.now(),
      timer,
    });
    this.emit("changed", this.list());
  }

  list() {
    return [...this.pending.values()].map((entry) => ({
      id: entry.id,
      method: entry.method,
      params: entry.params,
      createdAt: entry.createdAt,
    }));
  }

  resolve(id, result) {
    const key = String(id);
    const request = this.pending.get(key);
    if (!request) throw new Error("The app-server request is no longer pending.");
    this.validate(request, result);
    clearTimeout(request.timer);
    this.pending.delete(key);
    this.client.respond(request.id, result);
    this.emit("changed", this.list());
  }

  reject(id, message = "Canceled by the user.") {
    const key = String(id);
    const request = this.pending.get(key);
    if (!request) throw new Error("The app-server request is no longer pending.");
    clearTimeout(request.timer);
    this.pending.delete(key);
    this.client.respondError(request.id, -32000, message);
    this.emit("changed", this.list());
  }

  validate(request, result) {
    if (!result || typeof result !== "object") throw new Error("A structured response is required.");
    const available = request.params.availableDecisions;
    if (Array.isArray(available) && Object.hasOwn(result, "decision")) {
      const names = available.map((value) => typeof value === "string" ? value : value?.decision).filter(Boolean);
      if (!names.includes(result.decision)) throw new Error("The selected decision was not offered by app-server.");
    }
    const url = result.oauthUrl ?? result.url;
    if (url) {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname))) {
        throw new Error("Only HTTPS or loopback OAuth URLs are allowed.");
      }
    }
  }

  dispose() {
    this.client.off("serverRequest", this.onRequest);
    this.client.off("connection", this.onConnection);
    for (const request of this.pending.values()) clearTimeout(request.timer);
    this.pending.clear();
  }
}
