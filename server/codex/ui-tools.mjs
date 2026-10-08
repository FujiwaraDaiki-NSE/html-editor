import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export const UI_TOOL_NAMESPACE = "weave_ui";
export const UI_TOOL_TIMEOUT_MS = 30_000;
export const UI_SESSION_TTL_MS = 5 * 60_000;
export const UI_RESULT_LIMIT = 120_000;

const BROWSER_UI_TOOL_NAMES = new Set(["inspect", "click", "fill", "select", "key"]);
export const EDIT_SLIDES_TOOL_NAME = "edit_slides";
const EDIT_SLIDE_SCOPE_KINDS = new Set(["element", "current-slide", "selected-slides", "deck"]);
const EDIT_SLIDE_EXECUTIONS = new Set(["apply", "plan", "propose"]);

const targetSchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 500 },
    role: { type: "string", minLength: 1, maxLength: 200 },
    name: { type: "string", minLength: 1, maxLength: 4_000 },
    label: { type: "string", minLength: 1, maxLength: 4_000 },
  },
};

const targetOrNullSchema = { oneOf: [targetSchema, { type: "null" }] };

const uiToolSchemas = {
  inspect: {
    type: "object",
    additionalProperties: false,
    properties: {
      target: targetOrNullSchema,
    },
    required: ["target"],
  },
  click: {
    type: "object",
    additionalProperties: false,
    properties: {
      target: targetSchema,
    },
    required: ["target"],
  },
  fill: {
    type: "object",
    additionalProperties: false,
    properties: {
      target: targetSchema,
      value: { type: "string", maxLength: 50_000 },
    },
    required: ["target", "value"],
  },
  select: {
    type: "object",
    additionalProperties: false,
    properties: {
      target: targetSchema,
      value: { type: "string", maxLength: 4_000 },
    },
    required: ["target", "value"],
  },
  key: {
    type: "object",
    additionalProperties: false,
    properties: {
      key: { type: "string", minLength: 1, maxLength: 100 },
      target: targetSchema,
      modifiers: {
        type: "object",
        additionalProperties: false,
        properties: {
          alt: { type: "boolean" },
          ctrl: { type: "boolean" },
          meta: { type: "boolean" },
          shift: { type: "boolean" },
        },
      },
    },
    required: ["target", "key"],
  },
  [EDIT_SLIDES_TOOL_NAME]: {
    type: "object",
    additionalProperties: false,
    properties: {
      prompt: { type: "string", minLength: 1, maxLength: 50_000 },
      scope: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { enum: ["element", "current-slide", "selected-slides", "deck"] },
          slideIds: { type: "array", items: { type: "string", minLength: 1, maxLength: 500 }, minItems: 0, maxItems: 100 },
          elementId: { oneOf: [{ type: "string", minLength: 1, maxLength: 500 }, { type: "null" }] },
        },
        required: ["kind", "slideIds", "elementId"],
      },
      execution: { enum: ["apply", "plan", "propose"] },
      allowSkillChanges: { type: "boolean" },
    },
    required: ["prompt", "scope", "execution", "allowSkillChanges"],
  },
};

const uiToolDescriptions = {
  inspect: "Read the current live Weave editor controls. Use a returned semantic id, role, name, or label to choose the next UI action.",
  click: "Click one control in the current live Weave editor and report the resulting visible state.",
  fill: "Replace the value of one live Weave editor input, textarea, or editable element and report the resulting value.",
  select: "Choose one option in a live Weave editor select element by its value and report the resulting visible state.",
  key: "Send one keyboard key with optional modifiers to the current live Weave editor or a selected control.",
  [EDIT_SLIDES_TOOL_NAME]: "Delegate a slide editing request to a scoped Weave editor turn and report its actual result.",
};

function toolSpec(name) {
  return {
    type: "function",
    name,
    description: uiToolDescriptions[name],
    inputSchema: uiToolSchemas[name],
  };
}

/**
 * Dynamic tools are registered on a Codex thread, not globally on the local
 * HTTP server. Keep this as a function so a caller cannot mutate the shared
 * schema object between thread starts.
 */
export function uiDynamicTools({ purpose } = {}) {
  if (purpose !== "chat") return [];
  return [{
    type: "namespace",
    name: UI_TOOL_NAMESPACE,
    description: "Operate the currently attached Weave browser UI through a visible, correlated action.",
    tools: [...BROWSER_UI_TOOL_NAMES, EDIT_SLIDES_TOOL_NAME].map(toolSpec),
  }];
}

export function validateEditSlidesArguments(rawArguments) {
  if (!isRecord(rawArguments)) throw bridgeError("edit_slides arguments must be an object.");
  const args = rawArguments;
  if (Object.keys(args).some((key) => !["prompt", "scope", "execution", "allowSkillChanges"].includes(key))) {
    throw bridgeError("edit_slides arguments contain an unsupported field.");
  }
  if (typeof args.prompt !== "string" || args.prompt.length === 0 || args.prompt.length > 50_000) {
    throw bridgeError("edit_slides prompt must be a non-empty string of at most 50,000 characters.");
  }
  if (!isRecord(args.scope) || Object.keys(args.scope).some((key) => !["kind", "slideIds", "elementId"].includes(key))) {
    throw bridgeError("edit_slides scope must contain only kind, slideIds, and elementId.");
  }
  if (!EDIT_SLIDE_SCOPE_KINDS.has(args.scope.kind)) throw bridgeError("edit_slides scope kind is invalid.");
  if (!Array.isArray(args.scope.slideIds) || args.scope.slideIds.length > 100 || args.scope.slideIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 500)) {
    throw bridgeError("edit_slides scope.slideIds must be an array of slide ids.");
  }
  if (typeof args.scope.elementId !== "string" && args.scope.elementId !== null) throw bridgeError("edit_slides scope.elementId must be a string or null.");
  if (!EDIT_SLIDE_EXECUTIONS.has(args.execution)) throw bridgeError("edit_slides execution is invalid.");
  if (typeof args.allowSkillChanges !== "boolean") throw bridgeError("edit_slides allowSkillChanges must be boolean.");
  return args;
}

function bridgeError(message, code = "WEAVE_UI_INVALID") {
  return Object.assign(new Error(message), { code });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, name, max = 500) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw bridgeError(`${name} must be a non-empty string of at most ${max} characters.`);
  }
  return value;
}

function requiredToken(value) {
  return requiredString(value, "session token", 200);
}

function requestIdKey(value) {
  if (typeof value !== "string" && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    throw bridgeError("UI request id must be a string or safe integer.");
  }
  return String(value);
}

function jsonText(value) {
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw bridgeError("UI result must be JSON serializable.");
  return serialized;
}

function boundedText(value, name = "UI result") {
  const text = jsonText(value);
  if (text.length > UI_RESULT_LIMIT) throw bridgeError(`${name} exceeds ${UI_RESULT_LIMIT} characters.`);
  return text;
}

function publicSession(session, includeToken = false) {
  return {
    sessionId: session.sessionId,
    ...(includeToken ? { token: session.token } : {}),
    activeThreadId: session.activeThreadId,
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.lastSeenAt + session.ttlMs,
  };
}

function publicPending(request) {
  return {
    requestId: request.requestId,
    sessionId: request.sessionId,
    threadId: request.threadId,
    turnId: request.turnId,
    callId: request.callId,
    namespace: request.namespace,
    tool: request.tool,
    arguments: request.arguments,
    createdAt: request.createdAt,
    deadlineAt: request.deadlineAt,
    phase: request.phase,
    request: request.browserRequest,
  };
}

function browserRequestFor(request) {
  const args = request.arguments;
  return {
    version: 1,
    requestId: request.requestId,
    operation: request.tool,
    target: args.target,
    ...(args.value === undefined ? {} : { value: args.value }),
    ...(args.key === undefined ? {} : { key: args.key }),
    ...(args.modifiers === undefined ? {} : { modifiers: args.modifiers }),
  };
}

export class UiToolBridge extends EventEmitter {
  constructor({
    events,
    timeoutMs = UI_TOOL_TIMEOUT_MS,
    sessionTtlMs = UI_SESSION_TTL_MS,
    now = Date.now,
    idFactory = randomUUID,
    tokenFactory = () => randomBytes(32).toString("base64url"),
  } = {}) {
    super();
    this.events = events ?? null;
    this.timeoutMs = timeoutMs;
    this.sessionTtlMs = sessionTtlMs;
    this.now = now;
    this.idFactory = idFactory;
    this.tokenFactory = tokenFactory;
    this.sessions = new Map();
    this.revokedSessionIds = new Set();
    this.threadSessions = new Map();
    this.pending = new Map();
    this.completed = new Map();
  }

  publish(type, payload) {
    if (this.events?.publish) this.events.publish(type, payload);
    this.emit("event", { type, payload });
  }

  prune() {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (now - session.lastSeenAt <= session.ttlMs) continue;
      this.releaseSessionInternal(session, "UI browser session expired.");
    }
  }

  registerSession(payload = {}) {
    this.prune();
    if (!isRecord(payload)) throw bridgeError("UI session payload must be an object.");
    const suppliedId = payload.sessionId;
    const sessionId = suppliedId === undefined ? this.idFactory() : requiredString(suppliedId, "sessionId", 200);
    if (this.revokedSessionIds.has(sessionId)) throw bridgeError("UI session was revoked; start a new browser session.", "WEAVE_UI_UNAUTHORIZED");
    const existing = this.sessions.get(sessionId);
    if (existing) {
      const token = requiredToken(payload.token);
      if (token !== existing.token) throw bridgeError("UI session token is invalid.", "WEAVE_UI_UNAUTHORIZED");
      if (Object.hasOwn(payload, "threadId") && payload.threadId !== existing.activeThreadId && payload.claim !== true) {
        throw bridgeError("UI session ownership must be explicitly claimed after another browser took control.", "WEAVE_UI_OWNERSHIP_REQUIRED");
      }
      existing.lastSeenAt = this.now();
      if (Object.hasOwn(payload, "threadId")) this.bindThread(existing, payload.threadId);
      return publicSession(existing, true);
    }
    if (Object.hasOwn(payload, "threadId") && payload.threadId !== null) {
      const requestedThreadId = requiredString(payload.threadId, "threadId", 200);
      if (this.threadSessions.has(requestedThreadId) && payload.claim !== true) {
        throw bridgeError("UI session ownership must be explicitly claimed when another browser already controls this thread.", "WEAVE_UI_OWNERSHIP_REQUIRED");
      }
    }
    const token = payload.token === undefined ? this.tokenFactory() : requiredToken(payload.token);
    const session = {
      sessionId,
      token,
      ttlMs: this.sessionTtlMs,
      activeThreadId: null,
      requiresClaim: false,
      lastSeenAt: this.now(),
    };
    this.sessions.set(sessionId, session);
    if (Object.hasOwn(payload, "threadId")) this.bindThread(session, payload.threadId);
    this.publish("weave/ui", { phase: "session-ready", session: publicSession(session) });
    return publicSession(session, true);
  }

  authenticate(payload) {
    if (!isRecord(payload)) throw bridgeError("UI session payload must be an object.");
    const sessionId = requiredString(payload.sessionId, "sessionId", 200);
    const token = requiredToken(payload.token);
    const session = this.sessions.get(sessionId);
    if (!session || session.token !== token) throw bridgeError("UI session token is invalid.", "WEAVE_UI_UNAUTHORIZED");
    if (this.now() - session.lastSeenAt > session.ttlMs) {
      this.releaseSessionInternal(session, "UI browser session expired.");
      throw bridgeError("UI browser session expired.", "WEAVE_UI_SESSION_EXPIRED");
    }
    session.lastSeenAt = this.now();
    return session;
  }

  touchSession(payload) {
    const session = this.authenticate(payload);
    if (Object.hasOwn(payload, "threadId") && payload.threadId !== session.activeThreadId && payload.claim !== true) {
      throw bridgeError("UI session ownership must be explicitly claimed when changing the active browser tab.", "WEAVE_UI_OWNERSHIP_REQUIRED");
    }
    if (Object.hasOwn(payload, "threadId")) this.bindThread(session, payload.threadId);
    this.publish("weave/ui", { phase: "session-active", session: publicSession(session) });
    return publicSession(session);
  }

  bindThread(session, threadId) {
    if (threadId === null) {
      if (session.activeThreadId) {
        this.cancelThreadRequests(session, session.activeThreadId, "The browser UI session is no longer attached to this thread.", "session-detached");
        if (this.threadSessions.get(session.activeThreadId) === session.sessionId) this.threadSessions.delete(session.activeThreadId);
      }
      session.activeThreadId = null;
      return;
    }
    const value = requiredString(threadId, "threadId", 200);
    if (session.activeThreadId && session.activeThreadId !== value) {
      this.cancelThreadRequests(session, session.activeThreadId, "The browser UI session moved to another thread.", "session-rebound");
      if (this.threadSessions.get(session.activeThreadId) === session.sessionId) this.threadSessions.delete(session.activeThreadId);
    }
    const previousSessionId = this.threadSessions.get(value);
    if (previousSessionId && previousSessionId !== session.sessionId) {
      const previous = this.sessions.get(previousSessionId);
      if (previous?.activeThreadId === value) {
        this.cancelThreadRequests(previous, value, "Another browser UI session took control of this thread.", "session-replaced");
        previous.activeThreadId = null;
        previous.requiresClaim = true;
      }
    }
    this.threadSessions.set(value, session.sessionId);
    session.activeThreadId = value;
  }

  cancelThreadRequests(session, threadId, reason, phase = "session-released") {
    for (const request of [...this.pending.values()]) {
      if (request.sessionId !== session.sessionId || request.threadId !== threadId) continue;
      this.finish(request, false, null, reason, phase);
    }
  }

  releaseSession(payload, reason = "UI browser session was released.") {
    const session = this.authenticate(payload);
    return this.releaseSessionInternal(session, reason);
  }

  releaseSessionInternal(session, reason) {
    const affected = [...this.pending.values()].filter((entry) => entry.sessionId === session.sessionId);
    for (const entry of affected) this.finish(entry, false, null, reason, "session-released");
    if (session.activeThreadId) this.threadSessions.delete(session.activeThreadId);
    this.sessions.delete(session.sessionId);
    this.revokedSessionIds.add(session.sessionId);
    this.publish("weave/ui", { phase: "session-released", sessionId: session.sessionId, reason });
    return { sessionId: session.sessionId, released: true };
  }

  snapshot() {
    this.prune();
    return {
      namespace: UI_TOOL_NAMESPACE,
      sessions: [...this.sessions.values()].map((session) => publicSession(session)),
      pending: [...this.pending.values()].map(publicPending),
    };
  }

  validateArguments(tool, rawArguments) {
    if (!BROWSER_UI_TOOL_NAMES.has(tool)) throw bridgeError(`Unknown Weave browser UI tool: ${tool}.`, "WEAVE_UI_TOOL_UNKNOWN");
    if (!isRecord(rawArguments)) throw bridgeError("UI tool arguments must be an object.");
    const args = rawArguments;
    const validateTarget = (value, required = true) => {
      if (value === null && !required) return;
      if (!isRecord(value)) throw bridgeError("target must be an object.");
      const fields = ["id", "role", "name", "label"].filter((name) => Object.hasOwn(value, name));
      if (fields.length === 0) throw bridgeError("target must identify an element by id, role, name, or label.");
      for (const field of fields) requiredString(value[field], `target.${field}`, field === "id" ? 500 : field === "role" ? 200 : 4_000);
      for (const field of Object.keys(value)) if (!["id", "role", "name", "label"].includes(field)) throw bridgeError(`target.${field} is not supported.`);
    };
    if (tool === "inspect") {
      if (!Object.hasOwn(args, "target")) throw bridgeError("inspect requires target; use null to inspect the whole live UI.");
      validateTarget(args.target, false);
      return args;
    }
    validateTarget(args.target);
    if (tool === "click") return args;
    if (tool === "fill") {
      if (typeof args.value !== "string" || args.value.length > 50_000) throw bridgeError("value must be a string of at most 50,000 characters.");
      return args;
    }
    if (tool === "select") {
      if (typeof args.value !== "string" || args.value.length > 4_000) throw bridgeError("value must be a string of at most 4,000 characters.");
      return args;
    }
    if (typeof args.key !== "string" || args.key.length === 0 || args.key.length > 100) throw bridgeError("key must be a non-empty string of at most 100 characters.");
    if (Object.hasOwn(args, "modifiers")) {
      if (!isRecord(args.modifiers) || Object.keys(args.modifiers).some((modifier) => !["alt", "ctrl", "meta", "shift"].includes(modifier)) || Object.values(args.modifiers).some((enabled) => typeof enabled !== "boolean")) throw bridgeError("modifiers must contain only boolean alt, ctrl, meta, or shift fields.");
    }
    return args;
  }

  failRequest(request, error, phase = "failed") {
    const message = error instanceof Error ? error.message : String(error);
    const code = error?.code ?? "WEAVE_UI_FAILED";
    request.phase = phase;
    this.publish("weave/ui", {
      phase,
      requestId: request.requestId,
      sessionId: request.sessionId,
      threadId: request.threadId,
      turnId: request.turnId,
      callId: request.callId,
      namespace: request.namespace,
      tool: request.tool,
      error: message,
      code,
    });
    return { contentItems: [{ type: "inputText", text: `Weave UI action failed: ${message}` }], success: false };
  }

  dispatch(serverRequest, respond) {
    this.prune();
    let request;
    try {
      if (!isRecord(serverRequest?.params)) throw bridgeError("Dynamic UI request parameters are invalid.");
      const params = serverRequest.params;
      const rpcId = serverRequest.id;
      requestIdKey(rpcId);
      const requestId = requiredString(String(this.idFactory()), "UI browser request id", 200);
      const threadId = requiredString(params.threadId, "threadId", 200);
      const turnId = requiredString(params.turnId, "turnId", 200);
      const callId = requiredString(params.callId, "callId", 200);
      const namespace = params.namespace === null ? null : requiredString(params.namespace, "namespace", 200);
      if (namespace !== UI_TOOL_NAMESPACE) throw bridgeError("Dynamic UI request namespace is not supported.", "WEAVE_UI_TOOL_UNKNOWN");
      const tool = requiredString(params.tool, "tool", 200);
      const args = this.validateArguments(tool, params.arguments);
      const sessionId = this.threadSessions.get(threadId);
      const session = sessionId ? this.sessions.get(sessionId) : null;
      if (!session) throw bridgeError("No active Weave browser session is attached to this thread.", "WEAVE_UI_NO_SESSION");
      const duplicateCallKey = `${threadId}:${turnId}:${callId}`;
      const duplicate = this.completed.get(duplicateCallKey) ?? [...this.pending.values()].find((entry) => entry.callKey === duplicateCallKey);
      if (duplicate) throw bridgeError("This UI action has already been handled and will not be replayed.", "WEAVE_UI_REPLAY");
      if (session.activeThreadId !== threadId) throw bridgeError("This browser UI session is no longer attached to the requested thread.", "WEAVE_UI_SESSION_MISMATCH");
      if ([...this.pending.values()].some((entry) => entry.sessionId === session.sessionId)) {
        throw bridgeError("Another UI action is still being shown in this browser session. Wait for its result before sending another action.", "WEAVE_UI_BUSY");
      }
      request = {
        requestId,
        rpcId,
        sessionId,
        threadId,
        turnId,
        callId,
        callKey: duplicateCallKey,
        namespace,
        tool,
        arguments: args,
        browserRequest: null,
        createdAt: this.now(),
        deadlineAt: this.now() + this.timeoutMs,
        phase: "requested",
        respond,
        timer: null,
      };
      request.browserRequest = browserRequestFor(request);
      if (this.pending.has(requestId)) throw bridgeError("This UI request id is already pending and will not be replayed.", "WEAVE_UI_REPLAY");
      this.pending.set(requestId, request);
      request.timer = setTimeout(() => {
        if (this.pending.get(requestId) !== request) return;
        this.finish(request, false, null, "The browser did not report a result before the UI action timed out.", "timeout");
      }, this.timeoutMs);
      this.publish("weave/ui", {
        phase: "requested",
        requestId,
        sessionId,
        threadId,
        turnId,
        callId,
        namespace,
        tool,
        arguments: args,
        request: request.browserRequest,
        createdAt: request.createdAt,
        deadlineAt: request.deadlineAt,
      });
      return { accepted: true, requestId };
    } catch (error) {
      const failed = request ?? {
        requestId: serverRequest?.id === undefined ? null : String(serverRequest.id),
        sessionId: null,
        threadId: serverRequest?.params?.threadId ?? null,
        turnId: serverRequest?.params?.turnId ?? null,
        callId: serverRequest?.params?.callId ?? null,
        namespace: serverRequest?.params?.namespace ?? null,
        tool: serverRequest?.params?.tool ?? null,
        phase: "failed",
      };
      const result = this.failRequest(failed, error);
      try { respond(serverRequest.id, result); } catch { /* app-server disconnected */ }
      return { accepted: false, error };
    }
  }

  finish(request, success, result, error = null, phase = success ? "completed" : "failed") {
    if (this.pending.get(request.requestId) !== request) return false;
    clearTimeout(request.timer);
    const text = success ? boundedText(result) : String(error ?? "The browser reported that the UI action failed.");
    this.pending.delete(request.requestId);
    request.phase = phase;
    const response = { contentItems: [{ type: "inputText", text }], success: Boolean(success) };
    // Keep the call tombstone for the lifetime of this bridge. Session expiry or
    // a new browser token must never make a prior call executable again.
    this.completed.set(request.callKey, { requestId: request.requestId, sessionId: request.sessionId, threadId: request.threadId, turnId: request.turnId, callId: request.callId });
    this.publish("weave/ui", {
      phase,
      requestId: request.requestId,
      sessionId: request.sessionId,
      threadId: request.threadId,
      turnId: request.turnId,
      callId: request.callId,
      namespace: request.namespace,
      tool: request.tool,
      success: Boolean(success),
      ...(success ? { result } : { error: text }),
    });
    try { request.respond(request.rpcId, response); } catch { /* app-server disconnected */ }
    return true;
  }

  respond(payload) {
    this.prune();
    if (!isRecord(payload)) throw bridgeError("UI response payload must be an object.");
    if (!isRecord(payload.response)) throw bridgeError("UI response must be provided in the response field.");
    const response = payload.response;
    const requestId = requestIdKey(response.requestId);
    const request = this.pending.get(requestId);
    if (!request) {
      const completed = [...this.completed.values()].find((entry) => entry.requestId === requestId);
      if (completed) {
        const session = this.authenticate(payload);
        if (session.sessionId !== completed.sessionId || session.activeThreadId !== completed.threadId) {
          throw bridgeError("The UI response belongs to a browser session that is no longer attached to this thread.", "WEAVE_UI_SESSION_MISMATCH");
        }
        throw bridgeError("This UI request has already completed and will not be replayed.", "WEAVE_UI_REPLAY");
      }
      throw bridgeError("The UI request is no longer pending.", "WEAVE_UI_NOT_PENDING");
    }
    const session = this.authenticate(payload);
    if (session.sessionId !== request.sessionId) throw bridgeError("The UI response belongs to a different browser session.", "WEAVE_UI_SESSION_MISMATCH");
    if (session.activeThreadId !== request.threadId) {
      throw bridgeError("The UI response belongs to a browser session that is no longer attached to this thread.", "WEAVE_UI_SESSION_MISMATCH");
    }
    const status = response.status;
    if (!["completed", "rejected", "error"].includes(status)) throw bridgeError("UI response status must be completed, rejected, or error.");
    if (status === "completed") this.finish(request, true, response, null, "completed");
    else this.finish(request, false, null, response.error?.message ?? "The browser rejected the UI action.", "failed");
    return { ok: true, requestId, phase: request.phase };
  }

  cancelAll(reason = "The Codex app-server connection closed.") {
    for (const request of [...this.pending.values()]) this.finish(request, false, null, reason, "failed");
  }

  cancelTurn(threadId, turnId, reason = "The chat coordinator turn ended before the browser UI action completed.") {
    let canceled = 0;
    for (const request of [...this.pending.values()]) {
      if (request.threadId !== threadId || request.turnId !== turnId) continue;
      if (this.finish(request, false, null, reason, "canceled")) canceled += 1;
    }
    return canceled;
  }
}
