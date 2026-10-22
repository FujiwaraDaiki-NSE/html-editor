"use client";

/**
 * The browser side of Weave's UI operation protocol.
 *
 * Agent work is intentionally expressed as semantic requests.  The bridge never
 * accepts a CSS selector, JavaScript source, or a DOM method name from a caller.
 * A request is resolved against the live, visible controls in the application and
 * the native event is dispatched only after the target is made visible to the user.
 */

export const UI_BRIDGE_VERSION = 1 as const;

export type UiOperation = "inspect" | "click" | "fill" | "select" | "key";
export type UiTarget = {
  id?: string;
  role?: string;
  name?: string;
  label?: string;
  selector?: string;
};

export type UiToolArguments = {
  selector?: string;
  value?: string;
  label?: string;
  index?: number;
  clear?: boolean;
  key?: string;
  modifiers?: string[];
  button?: "left" | "middle" | "right";
  count?: number;
  includeText?: boolean;
  maxNodes?: number;
};

export type UiToolRequest = {
  requestId: string;
  tool: UiOperation;
  arguments: UiToolArguments;
};

export type UiKeyModifiers = {
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
};

export type UiRequest = {
  version: typeof UI_BRIDGE_VERSION;
  requestId: string;
  operation: UiOperation;
  target: UiTarget | null;
  value?: string;
  key?: string;
  modifiers?: UiKeyModifiers;
  count?: number;
};

export type UiControlSnapshot = {
  id: string | null;
  selector: string;
  role: string;
  name: string;
  text: string | null;
  type: string;
  value: string | null;
  checked: boolean | null;
  selected: string | null;
  options: Array<{ value: string; label: string; disabled: boolean }>;
  disabled: boolean;
  readOnly: boolean;
  visible: boolean;
  available: boolean;
  excluded: boolean;
};

export type UiOperationResponse = {
  version: typeof UI_BRIDGE_VERSION;
  requestId: string | null;
  operation: UiOperation | null;
  status: "completed" | "rejected" | "error";
  target: UiControlSnapshot | null;
  controls: UiControlSnapshot[];
  outcome: {
    eventDispatched: boolean;
    defaultPrevented?: boolean;
    focused?: boolean;
    value?: string | null;
    checked?: boolean | null;
    selected?: string | null;
  } | null;
  error: { code: string; message: string } | null;
};

export type UiBridgePhase = "idle" | "inspecting" | "pointing" | "performing" | "completed" | "rejected" | "error";

export type UiBridgeStatus = {
  phase: UiBridgePhase;
  requestId: string | null;
  label: string;
  message: string;
};

export type UiBridgeOptions = {
  root: HTMLElement | null;
  onStatus?: (status: UiBridgeStatus) => void;
  isRequestCurrent?: (request: UiRequest) => boolean;
};

export type UiBridge = {
  inspect(request: UiRequest): UiOperationResponse;
  perform(request: UiRequest): Promise<UiOperationResponse>;
  performTool(request: UiToolRequest): Promise<UiOperationResponse>;
  dispose(): void;
};

const CONTROL_SELECTOR = "button, input, select, textarea, a[href], [contenteditable=\"true\"], [role=\"button\"], [role=\"tab\"], [role=\"menuitem\"], [role=\"option\"]";
const HIDDEN_SELECTOR = "[hidden], [aria-hidden=\"true\"], .sr-only";
const EXCLUDED_SELECTOR = [
  "[data-ui-agent-exclude=\"true\"]",
  ".composer-dock",
  ".blocking-region",
  ".server-request",
  ".thread-popover",
  ".thread-actions-menu",
  "input[type=\"password\"]",
  "input[type=\"file\"]",
].join(",");
const SECRET_NAME = /password|passcode|secret|token|api[ -]?key|access[ -]?key|private[ -]?key/i;
const KEY_NAMES = new Set([
  "Enter", "Escape", "Tab", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "F1", "F2", "F3", "F4", "F5", "F6",
  "F7", "F8", "F9", "F10", "F11", "F12",
]);
const POINTER_CLASS = "ui-operation-target";
const POINTER_ID = "weave-ui-operation-pointer";
const POINTER_LABEL_ID = "weave-ui-operation-pointer-label";
// Leave the target visible long enough for a person to follow the operation
// before the native event is dispatched.
const POINTER_WAIT_MS = 600;
const MAX_FILL_LENGTH = 20_000;
const MAX_SELECTOR_LENGTH = 512;
let agentControlSequence = 0;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const normalizeName = (value: string) => value.replace(/\s+/g, " ").trim();
const equalName = (left: string, right: string) => normalizeName(left).toLocaleLowerCase() === normalizeName(right).toLocaleLowerCase();

const controlRole = (element: HTMLElement): string => {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit;
  if (element instanceof HTMLButtonElement) return "button";
  if (element instanceof HTMLAnchorElement) return "link";
  if (element instanceof HTMLSelectElement) return "combobox";
  if (element instanceof HTMLTextAreaElement) return "textbox";
  if (element instanceof HTMLInputElement) {
    if (element.type === "checkbox") return "checkbox";
    if (element.type === "radio") return "radio";
    return "textbox";
  }
  if (element.isContentEditable) return "textbox";
  return "generic";
};

const isHidden = (element: HTMLElement) => {
  if (element.matches(HIDDEN_SELECTOR) || element.closest(HIDDEN_SELECTOR)) return true;
  const style = window.getComputedStyle(element);
  return style.display === "none" || style.visibility === "hidden" || element.getClientRects().length === 0;
};

const isDisabled = (element: HTMLElement) => {
  if (element.getAttribute("aria-disabled") === "true") return true;
  if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement || element instanceof HTMLOptGroupElement || element instanceof HTMLOptionElement) return element.disabled;
  return false;
};

const isReadOnly = (element: HTMLElement) => {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.readOnly;
  return element.getAttribute("aria-readonly") === "true" || (element.isContentEditable && element.getAttribute("contenteditable") === "false");
};

const labelFor = (element: HTMLElement): string => {
  const aria = element.getAttribute("aria-label");
  if (aria) return normalizeName(aria);
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    if (normalizeName(text)) return normalizeName(text);
  }
  if (element.id) {
    const associated = document.querySelector(`label[for=\"${CSS.escape(element.id)}\"]`);
    if (associated && normalizeName(associated.textContent ?? "")) return normalizeName(associated.textContent ?? "");
  }
  const parentLabel = element.closest("label");
  if (parentLabel && normalizeName(parentLabel.textContent ?? "")) return normalizeName(parentLabel.textContent ?? "");
  const title = element.getAttribute("title");
  if (title) return normalizeName(title);
  return normalizeName(element.textContent ?? "");
};

const isSensitive = (element: HTMLElement, label: string) => {
  if (element instanceof HTMLInputElement && (element.type === "password" || element.type === "file")) return true;
  return SECRET_NAME.test(label) || SECRET_NAME.test(element.getAttribute("name") ?? "") || element.hasAttribute("data-sensitive");
};

const isAgentExcluded = (element: HTMLElement) => !!element.closest(EXCLUDED_SELECTOR);

const optionsFor = (element: HTMLElement) => element instanceof HTMLSelectElement
  ? Array.from(element.options).map((option) => ({ value: option.value, label: normalizeName(option.textContent ?? option.value), disabled: option.disabled || option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled }))
  : [];

const valueFor = (element: HTMLElement, sensitive: boolean): string | null => {
  if (sensitive) return null;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return element.value;
  if (element.isContentEditable) return element.textContent ?? "";
  return null;
};

const selectedFor = (element: HTMLElement): string | null => {
  if (element instanceof HTMLSelectElement) return element.value;
  return null;
};

const checkedFor = (element: HTMLElement): boolean | null => {
  if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) return element.checked;
  return null;
};

const stableIdFor = (element: HTMLElement): string | null => element.dataset.uiId || element.getAttribute("id") || element.dataset.uiAgentId || null;

const selectorValue = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const selectorFor = (element: HTMLElement): string => {
  const id = element.dataset.uiId;
  if (id) return `[data-ui-id="${selectorValue(id)}"]`;
  if (element.id) return `#${CSS.escape(element.id)}`;
  const agentId = element.dataset.uiAgentId;
  if (agentId) return `[data-ui-agent-id="${selectorValue(agentId)}"]`;
  const index = element.dataset.uiAgentIndex;
  if (index) return `[data-ui-agent-index="${selectorValue(index)}"]`;
  return element.tagName.toLowerCase();
};

const safeSelector = (value: unknown): value is string => typeof value === "string"
  && value.trim().length > 0
  && value.length <= MAX_SELECTOR_LENGTH
  && !/[{};<>]/.test(value)
  && !/(?:^|[^a-z])(?:script|style|iframe|object|embed)(?:[^a-z]|$)/i.test(value)
  && !value.includes(",");

const snapshot = (element: HTMLElement): UiControlSnapshot => {
  const name = labelFor(element);
  const excluded = isAgentExcluded(element);
  const sensitive = isSensitive(element, name) || excluded && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable);
  const disabled = isDisabled(element);
  const readOnly = isReadOnly(element);
  return {
    id: stableIdFor(element),
    selector: selectorFor(element),
    role: controlRole(element),
    name: sensitive ? "保護された入力" : name,
    text: sensitive ? null : normalizeName(element.textContent ?? "").slice(0, 500) || null,
    type: element instanceof HTMLInputElement ? element.type : element.tagName.toLowerCase(),
    value: valueFor(element, sensitive),
    checked: checkedFor(element),
    selected: selectedFor(element),
    options: sensitive ? [] : optionsFor(element),
    disabled,
    readOnly,
    visible: !isHidden(element),
    available: !disabled && !readOnly && !excluded,
    excluded,
  };
};

const errorResponse = (request: Partial<UiRequest>, code: string, message: string, controls: UiControlSnapshot[] = [], target: UiControlSnapshot | null = null): UiOperationResponse => ({
  version: UI_BRIDGE_VERSION,
  requestId: typeof request.requestId === "string" ? request.requestId : null,
  operation: request.operation === "inspect" || request.operation === "click" || request.operation === "fill" || request.operation === "select" || request.operation === "key" ? request.operation : null,
  status: "error",
  target,
  controls,
  outcome: null,
  error: { code, message },
});

const acceptedResponse = (request: UiRequest, target: UiControlSnapshot | null, controls: UiControlSnapshot[], outcome: UiOperationResponse["outcome"]): UiOperationResponse => ({
  version: UI_BRIDGE_VERSION,
  requestId: request.requestId,
  operation: request.operation,
  status: "completed",
  target,
  controls,
  outcome,
  error: null,
});

const rejectedResponse = (request: UiRequest, code: string, message: string, target: UiControlSnapshot | null, controls: UiControlSnapshot[]): UiOperationResponse => ({
  version: UI_BRIDGE_VERSION,
  requestId: request.requestId,
  operation: request.operation,
  status: "rejected",
  target,
  controls,
  outcome: null,
  error: { code, message },
});

const collectControls = (root: HTMLElement | null): HTMLElement[] => {
  if (!root) return [];
  const controls = Array.from(root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)).filter((element) => !isHidden(element));
  controls.forEach((element, index) => {
    if (!element.dataset.uiId && !element.id && !element.dataset.uiAgentId) {
      const role = controlRole(element);
      const label = normalizeName(labelFor(element)).toLocaleLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 48) || element.tagName.toLocaleLowerCase();
      const base = `weave-${role}-${label}`;
      element.dataset.uiAgentId = `${base}-${++agentControlSequence}`;
    }
    if (!element.dataset.uiId && !element.id && !element.dataset.uiAgentIndex) element.dataset.uiAgentIndex = String(index);
  });
  return controls;
};

const targetDescription = (element: HTMLElement) => labelFor(element) || stableIdFor(element) || controlRole(element);

const targetMatches = (element: HTMLElement, target: UiTarget) => {
  if (target.selector !== undefined) {
    if (!safeSelector(target.selector)) return false;
    try { return element.matches(target.selector); } catch { return false; }
  }
  const idMatch = target.id !== undefined && stableIdFor(element) === target.id;
  const roleMatch = target.role !== undefined && controlRole(element) === target.role;
  const name = labelFor(element);
  const nameMatch = target.name !== undefined && equalName(name, target.name);
  const labelMatch = target.label !== undefined && equalName(name, target.label);
  const hasField = target.id !== undefined || target.role !== undefined || target.name !== undefined || target.label !== undefined || target.selector !== undefined;
  if (!hasField) return false;
  // An id is stable and exact.  A semantic name/role pair is conjunctive; a sole
  // role or name is useful for inspect but is rejected as ambiguous for mutation.
  if (target.id !== undefined) return idMatch;
  if (target.role !== undefined && target.name !== undefined) return roleMatch && nameMatch;
  if (target.role !== undefined && target.label !== undefined) return roleMatch && labelMatch;
  return roleMatch || nameMatch || labelMatch;
};

const parseRequest = (value: unknown): UiRequest | null => {
  if (!isRecord(value) || value.version !== UI_BRIDGE_VERSION || typeof value.requestId !== "string" || !value.requestId.trim() || (value.operation !== "inspect" && value.operation !== "click" && value.operation !== "fill" && value.operation !== "select" && value.operation !== "key")) return null;
  const target = value.target === null ? null : isRecord(value.target) ? {
    ...(typeof value.target.id === "string" ? { id: value.target.id } : {}),
    ...(typeof value.target.role === "string" ? { role: value.target.role } : {}),
    ...(typeof value.target.name === "string" ? { name: value.target.name } : {}),
    ...(typeof value.target.label === "string" ? { label: value.target.label } : {}),
    ...(typeof value.target.selector === "string" ? { selector: value.target.selector } : {}),
  } : null;
  if (value.operation !== "inspect" && target === null) return null;
  if ((value.operation === "fill" || value.operation === "select") && typeof value.value !== "string") return null;
  if (value.operation === "key" && typeof value.key !== "string") return null;
  return {
    version: UI_BRIDGE_VERSION,
    requestId: value.requestId,
    operation: value.operation,
    target,
    ...(typeof value.value === "string" ? { value: value.value } : {}),
    ...(typeof value.key === "string" ? { key: value.key } : {}),
    ...(isRecord(value.modifiers) ? { modifiers: {
      ...(typeof value.modifiers.alt === "boolean" ? { alt: value.modifiers.alt } : {}),
      ...(typeof value.modifiers.ctrl === "boolean" ? { ctrl: value.modifiers.ctrl } : {}),
      ...(typeof value.modifiers.meta === "boolean" ? { meta: value.modifiers.meta } : {}),
      ...(typeof value.modifiers.shift === "boolean" ? { shift: value.modifiers.shift } : {}),
    } } : {}),
  } as UiRequest;
};

const requestLabel = (request: UiRequest, target: HTMLElement | null) => request.operation === "inspect" ? "画面上の操作を確認" : `${target ? targetDescription(target) : "対象"}を${request.operation === "click" ? "クリック" : request.operation === "fill" ? "入力" : request.operation === "select" ? "選択" : "キー操作"}`;

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

const ensurePointer = (host: HTMLElement | null) => {
  let pointer = document.getElementById(POINTER_ID);
  const pointerHost = host ?? document.body;
  if (pointer && pointer.parentElement !== pointerHost) {
    pointer.remove();
    pointer = null;
  }
  if (!pointer) {
    pointer = document.createElement("div");
    pointer.id = POINTER_ID;
    pointer.className = "ui-operation-pointer";
    pointer.setAttribute("aria-hidden", "true");
    pointerHost.appendChild(pointer);
  }
  let label = document.getElementById(POINTER_LABEL_ID);
  if (!label) {
    label = document.createElement("span");
    label.id = POINTER_LABEL_ID;
    label.className = "ui-operation-pointer-label";
    label.setAttribute("aria-hidden", "true");
    pointer.appendChild(label);
  }
  return { pointer, label };
};

const pointAt = async (element: HTMLElement, labelText: string, requestId: string) => {
  element.scrollIntoView({ block: "nearest", inline: "nearest" });
  element.classList.add(POINTER_CLASS);
  const host = element.closest("dialog[open]") as HTMLElement | null;
  const { pointer, label } = ensurePointer(host);
  const rect = element.getBoundingClientRect();
  const hostRect = host?.getBoundingClientRect();
  pointer.style.left = `${Math.max(6, rect.left + rect.width / 2 - 10 - (hostRect?.left ?? 0))}px`;
  pointer.style.top = `${Math.max(6, rect.top + rect.height / 2 - 10 - (hostRect?.top ?? 0))}px`;
  label.textContent = labelText;
  pointer.dataset.requestId = requestId;
  pointer.dataset.visible = "true";
  await wait(POINTER_WAIT_MS);
};

const clearPointer = (element: HTMLElement | null, requestId?: string) => {
  element?.classList.remove(POINTER_CLASS);
  const pointer = document.getElementById(POINTER_ID);
  if (pointer && (requestId === undefined || pointer.dataset.requestId === requestId)) {
    pointer.dataset.visible = "false";
    delete pointer.dataset.requestId;
  }
};

export function createUiBridge({ root, onStatus, isRequestCurrent }: UiBridgeOptions): UiBridge {
  let activeTarget: HTMLElement | null = null;
  let disposed = false;

  const status = (next: UiBridgeStatus) => onStatus?.(next);
  const controls = () => collectControls(root);
  const staleResponse = (request: UiRequest, label = "操作") => {
    const result = errorResponse(request, "request_stale", "画面または制作タスクが切り替わったため、操作を中止しました。", controls().map(snapshot));
    status({ phase: "error", requestId: request.requestId, label, message: result.error?.message ?? "操作を中止しました。" });
    return result;
  };

  const resolve = (request: UiRequest): { element: HTMLElement | null; all: HTMLElement[]; matches: HTMLElement[] } => {
    const all = controls();
    const matches = request.target === null ? [] : all.filter((element) => targetMatches(element, request.target as UiTarget));
    return { element: matches.length === 1 ? matches[0] : null, all, matches };
  };

  const inspect = (request: UiRequest): UiOperationResponse => {
    if (disposed) {
      const response = errorResponse(request, "bridge_disposed", "UIブリッジは終了しています。");
      status({ phase: "error", requestId: request.requestId, label: "画面を確認", message: response.error?.message ?? "UIブリッジは終了しています。" });
      return response;
    }
    if (request.target?.selector !== undefined && !safeSelector(request.target.selector)) {
      const response = errorResponse(request, "invalid_selector", "安全なUI selectorではありません。");
      status({ phase: "error", requestId: request.requestId, label: "画面を確認", message: response.error?.message ?? "安全なUI selectorではありません。" });
      return response;
    }
    status({ phase: "inspecting", requestId: request.requestId, label: "画面を確認", message: "現在の操作可能なUIを読み取っています。" });
    const all = controls();
    if (request.target === null) {
      const result: UiOperationResponse = {
        version: UI_BRIDGE_VERSION,
        requestId: request.requestId,
        operation: "inspect",
        status: "completed",
        target: null,
        controls: all.map(snapshot),
        outcome: { eventDispatched: false },
        error: null,
      };
      status({ phase: "completed", requestId: request.requestId, label: "画面を確認", message: "現在の操作可能なUIを確認しました。" });
      return result;
    }
    const result = resolve(request);
    if (result.matches.length === 0) {
      const response = errorResponse(request, "target_not_found", "指定されたUI要素が見つかりません。", all.map(snapshot));
      status({ phase: "error", requestId: request.requestId, label: "対象なし", message: response.error?.message ?? "指定されたUI要素が見つかりません。" });
      return response;
    }
    if (result.matches.length > 1) {
      const response = errorResponse(request, "ambiguous_target", "指定されたUI要素が複数あります。data-ui-idまたは名前とroleを指定してください。", all.map(snapshot));
      status({ phase: "error", requestId: request.requestId, label: "対象が複数", message: response.error?.message ?? "対象を一意に指定してください。" });
      return response;
    }
    const response: UiOperationResponse = {
        version: UI_BRIDGE_VERSION,
        requestId: request.requestId,
      operation: "inspect",
      status: "completed",
      target: snapshot(result.matches[0]),
      controls: all.map(snapshot),
        outcome: { eventDispatched: false },
        error: null,
      };
    status({ phase: "completed", requestId: request.requestId, label: "画面を確認", message: "指定したUIを確認しました。" });
    return response;
  };

  const performSingle = async (request: UiRequest): Promise<UiOperationResponse> => {
    if (disposed) return errorResponse(request, "bridge_disposed", "UIブリッジは終了しています。");
    if (isRequestCurrent && !isRequestCurrent(request)) return staleResponse(request);
    if (request.operation === "inspect") return inspect(request);
    if (request.target?.selector !== undefined && !safeSelector(request.target.selector)) {
      const result = errorResponse(request, "invalid_selector", "安全なUI selectorではありません。");
      status({ phase: "error", requestId: request.requestId, label: requestLabel(request, null), message: result.error?.message ?? "安全なUI selectorではありません。" });
      return result;
    }
    const resolved = resolve(request);
    const allSnapshots = resolved.all.map(snapshot);
    if (resolved.matches.length === 0) {
      const result = errorResponse(request, "target_not_found", "指定されたUI要素が見つかりません。", allSnapshots);
      status({ phase: "error", requestId: request.requestId, label: "対象なし", message: result.error?.message ?? "対象が見つかりません。" });
      return result;
    }
    if (resolved.matches.length > 1) {
      const result = errorResponse(request, "ambiguous_target", "指定されたUI要素が複数あります。data-ui-idまたは名前とroleを指定してください。", allSnapshots);
      status({ phase: "error", requestId: request.requestId, label: "対象が複数", message: result.error?.message ?? "対象を一意に指定してください。" });
      return result;
    }
    const element = resolved.matches[0];
    const targetSnapshot = snapshot(element);
    const label = requestLabel(request, element);
    if (isRequestCurrent && !isRequestCurrent(request)) return staleResponse(request, label);
    if (isAgentExcluded(element)) {
      const result = rejectedResponse(request, "agent_control_excluded", "このUIはAgentの汎用操作から除外されています。", targetSnapshot, allSnapshots);
      status({ phase: "rejected", requestId: request.requestId, label, message: result.error?.message ?? "このUIは操作できません。" });
      return result;
    }
    if (isDisabled(element)) {
      const result = rejectedResponse(request, "control_disabled", "このUI操作は現在無効です。", targetSnapshot, allSnapshots);
      status({ phase: "rejected", requestId: request.requestId, label, message: result.error?.message ?? "操作は無効です。" });
      return result;
    }
    if ((request.operation === "fill" || request.operation === "select") && isReadOnly(element)) {
      const result = rejectedResponse(request, "control_readonly", "このUIには入力できません。", targetSnapshot, allSnapshots);
      status({ phase: "rejected", requestId: request.requestId, label, message: result.error?.message ?? "入力できません。" });
      return result;
    }
    if (request.operation === "fill" && (request.value === undefined || request.value.length > MAX_FILL_LENGTH)) {
      const result = rejectedResponse(request, "invalid_value", "入力値がないか、許可された長さを超えています。", targetSnapshot, allSnapshots);
      status({ phase: "rejected", requestId: request.requestId, label, message: result.error?.message ?? "入力値を確認してください。" });
      return result;
    }
    if (request.operation === "select" && request.value === undefined) {
      const result = rejectedResponse(request, "invalid_value", "選択値が指定されていません。", targetSnapshot, allSnapshots);
      status({ phase: "rejected", requestId: request.requestId, label, message: result.error?.message ?? "選択値を指定してください。" });
      return result;
    }
    if (request.operation === "key" && (request.key === undefined || (!KEY_NAMES.has(request.key) && request.key.length !== 1))) {
      const result = rejectedResponse(request, "invalid_key", "許可されていないキーです。", targetSnapshot, allSnapshots);
      status({ phase: "rejected", requestId: request.requestId, label, message: result.error?.message ?? "キーを確認してください。" });
      return result;
    }
    if (request.operation === "click" && request.count !== undefined && (!Number.isSafeInteger(request.count) || request.count < 1 || request.count > 3)) {
      const result = rejectedResponse(request, "invalid_count", "クリック回数は1から3の整数で指定してください。", targetSnapshot, allSnapshots);
      status({ phase: "rejected", requestId: request.requestId, label, message: result.error?.message ?? "クリック回数を確認してください。" });
      return result;
    }
    if (request.operation === "fill" && !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) {
      const result = rejectedResponse(request, "unsupported_control", "入力を受け付けるUI要素ではありません。", targetSnapshot, allSnapshots);
      status({ phase: "rejected", requestId: request.requestId, label, message: result.error?.message ?? "このUIには入力できません。" });
      return result;
    }
    if (request.operation === "select" && !(element instanceof HTMLSelectElement)) {
      const result = rejectedResponse(request, "unsupported_control", "選択UIではありません。", targetSnapshot, allSnapshots);
      status({ phase: "rejected", requestId: request.requestId, label, message: result.error?.message ?? "選択UIではありません。" });
      return result;
    }
    if (request.operation === "select") {
      const option = Array.from((element as HTMLSelectElement).options).find((candidate) => candidate.value === request.value);
      if (!option) {
        const result = rejectedResponse(request, "option_not_found", "指定された選択肢がありません。", targetSnapshot, allSnapshots);
        status({ phase: "rejected", requestId: request.requestId, label, message: result.error?.message ?? "選択肢がありません。" });
        return result;
      }
      if (option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled)) {
        const result = rejectedResponse(request, "option_disabled", "指定された選択肢は無効です。", targetSnapshot, allSnapshots);
        status({ phase: "rejected", requestId: request.requestId, label, message: result.error?.message ?? "選択肢は無効です。" });
        return result;
      }
    }
    status({ phase: "pointing", requestId: request.requestId, label, message: `${label}の場所を示しています。` });
    activeTarget = element;
    await pointAt(element, label, request.requestId);
    if (isRequestCurrent && !isRequestCurrent(request)) {
      clearPointer(element, request.requestId);
      if (activeTarget === element) activeTarget = null;
      return staleResponse(request, label);
    }
    if (disposed) {
      clearPointer(element, request.requestId);
      if (activeTarget === element) activeTarget = null;
      return errorResponse(request, "bridge_disposed", "UIブリッジは終了しています。", allSnapshots, targetSnapshot);
    }
    if (!element.isConnected || isHidden(element)) {
      clearPointer(element, request.requestId);
      if (activeTarget === element) activeTarget = null;
      const result = errorResponse(request, "target_stale", "操作前に対象のUIが更新されたため、操作を中止しました。", controls().map(snapshot), targetSnapshot);
      status({ phase: "error", requestId: request.requestId, label, message: result.error?.message ?? "対象のUIが更新されました。" });
      return result;
    }
    status({ phase: "performing", requestId: request.requestId, label, message: `${label}を実行しています。` });
    let defaultPrevented = false;
    try {
      if (request.operation === "click") {
        if (!(element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLAnchorElement || element.getAttribute("role") === "button" || element.getAttribute("role") === "menuitem" || element.getAttribute("role") === "tab" || element.getAttribute("role") === "option")) throw new Error("unsupported_control");
        const count = request.count ?? 1;
        for (let index = 0; index < count; index += 1) element.click();
      } else if (request.operation === "fill") {
        if (element.isContentEditable) {
          element.textContent = request.value ?? "";
        } else {
          const setter = element instanceof HTMLInputElement
            ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
            : Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
          setter?.call(element, request.value ?? "");
        }
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: null }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (request.operation === "select") {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
        setter?.call(element, request.value ?? "");
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (request.operation === "key") {
        element.focus();
        const key = request.key === "Space" ? " " : request.key ?? "";
        const modifiers = request.modifiers ?? {};
        const init = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true, altKey: modifiers.alt === true, ctrlKey: modifiers.ctrl === true, metaKey: modifiers.meta === true, shiftKey: modifiers.shift === true };
        const down = new KeyboardEvent("keydown", init);
        defaultPrevented = !element.dispatchEvent(down);
        element.dispatchEvent(new KeyboardEvent("keyup", init));
      }
    } catch (error) {
      const message = error instanceof Error && error.message === "unsupported_control" ? "このUI操作には対応していません。" : error instanceof Error ? error.message : String(error);
      clearPointer(element, request.requestId);
      if (activeTarget === element) activeTarget = null;
      const result = errorResponse(request, "operation_failed", message, controls().map(snapshot), snapshot(element));
      status({ phase: "error", requestId: request.requestId, label, message });
      return result;
    }
    await wait(0);
    if (isRequestCurrent && !isRequestCurrent(request)) {
      clearPointer(element, request.requestId);
      if (activeTarget === element) activeTarget = null;
      return staleResponse(request, label);
    }
    const result = acceptedResponse(request, snapshot(element), controls().map(snapshot), {
      eventDispatched: true,
      defaultPrevented,
      focused: document.activeElement === element,
      value: valueFor(element, isSensitive(element, labelFor(element))),
      checked: checkedFor(element),
      selected: selectedFor(element),
    });
    clearPointer(element, request.requestId);
    if (activeTarget === element) activeTarget = null;
    status({ phase: "completed", requestId: request.requestId, label, message: `${label}が完了しました。` });
    return result;
  };

  // SSE delivery can contain several requested events in one read. Serialize
  // the visible pointer and DOM mutation so a later request cannot move the
  // pointer while an earlier request is still waiting to be shown.
  let operationQueue = Promise.resolve();
  const perform = (request: UiRequest) => {
    const result = operationQueue.then(() => performSingle(request)).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const response = errorResponse(request, "operation_failed", message, controls().map(snapshot));
      status({ phase: "error", requestId: request.requestId, label: requestLabel(request, null), message });
      return response;
    });
    operationQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  const performTool = async (request: UiToolRequest): Promise<UiOperationResponse> => {
    const args = request.arguments;
    if (request.tool === "inspect") {
      const selector = args.selector;
      if (selector !== undefined && !safeSelector(selector)) return errorResponse({ requestId: request.requestId, operation: "inspect" }, "invalid_selector", "安全なUI selectorではありません。");
      const result = inspect({ version: UI_BRIDGE_VERSION, requestId: request.requestId, operation: "inspect", target: selector === undefined ? null : { selector } });
      if (result.status !== "completed") return result;
      const maxNodes = args.maxNodes === undefined ? result.controls.length : Math.min(args.maxNodes, result.controls.length);
      return { ...result, controls: result.controls.slice(0, maxNodes) };
    }
    if (args.selector === undefined || !safeSelector(args.selector)) return errorResponse({ requestId: request.requestId, operation: request.tool }, "invalid_selector", "安全なUI selectorを指定してください。");
    if (request.tool === "fill") return perform({ version: UI_BRIDGE_VERSION, requestId: request.requestId, operation: "fill", target: { selector: args.selector }, value: args.value });
    if (request.tool === "click") return perform({ version: UI_BRIDGE_VERSION, requestId: request.requestId, operation: "click", target: { selector: args.selector }, count: args.count });
    if (request.tool === "key") return perform({
      version: UI_BRIDGE_VERSION,
      requestId: request.requestId,
      operation: "key",
      target: { selector: args.selector },
      key: args.key,
      modifiers: Array.isArray(args.modifiers) ? {
        alt: args.modifiers.includes("Alt"),
        ctrl: args.modifiers.includes("Control"),
        meta: args.modifiers.includes("Meta"),
        shift: args.modifiers.includes("Shift"),
      } : undefined,
    });
    if ((args.value !== undefined && args.label !== undefined) || (args.value !== undefined && args.index !== undefined) || (args.label !== undefined && args.index !== undefined)) return errorResponse({ requestId: request.requestId, operation: "select" }, "invalid_value", "selectの値を一つだけ指定してください。");
    let value = args.value;
    if (args.label !== undefined || args.index !== undefined) {
      const resolved = resolve({ version: UI_BRIDGE_VERSION, requestId: request.requestId, operation: "select", target: { selector: args.selector }, value: "" });
      if (resolved.matches.length !== 1 || !(resolved.matches[0] instanceof HTMLSelectElement)) return errorResponse({ requestId: request.requestId, operation: "select" }, "target_not_found", "選択UIが一意に見つかりません。", resolved.all.map(snapshot), resolved.matches.length === 1 ? snapshot(resolved.matches[0]) : null);
      const options = Array.from(resolved.matches[0].options);
      const option = args.label !== undefined
        ? options.find((candidate) => normalizeName(candidate.textContent ?? candidate.value) === normalizeName(args.label as string))
        : options[args.index as number];
      if (!option) return errorResponse({ requestId: request.requestId, operation: "select" }, "option_not_found", "指定された選択肢がありません。", resolved.all.map(snapshot), snapshot(resolved.matches[0]));
      value = option.value;
    }
    return perform({ version: UI_BRIDGE_VERSION, requestId: request.requestId, operation: "select", target: { selector: args.selector }, value });
  };

  const onRequestEvent = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    const request = isRecord(detail) ? parseRequest(detail.request) : null;
    if (!request) return;
    void perform(request).then((response) => window.dispatchEvent(new CustomEvent("weave:ui-response", { detail: { response } })));
  };
  const onMessage = (event: MessageEvent) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (!isRecord(event.data) || event.data.type !== "weave:ui-request") return;
    const request = parseRequest(event.data.request);
    if (!request) return;
    void perform(request).then((response) => window.postMessage({ type: "weave:ui-response", response }, window.location.origin));
  };
  window.addEventListener("weave:ui-request", onRequestEvent);
  window.addEventListener("message", onMessage);

  return {
    inspect,
    perform,
    performTool,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearPointer(activeTarget);
      activeTarget = null;
      window.removeEventListener("weave:ui-request", onRequestEvent);
      window.removeEventListener("message", onMessage);
      document.getElementById(POINTER_ID)?.remove();
      onStatus?.({ phase: "idle", requestId: null, label: "", message: "" });
    },
  };
}

export function installUiBridge(options: UiBridgeOptions): UiBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = createUiBridge(options);
  window.__WEAVE_UI_BRIDGE__?.dispose();
  window.__WEAVE_UI_BRIDGE__ = bridge;
  return bridge;
}

declare global {
  interface Window {
    __WEAVE_UI_BRIDGE__?: UiBridge;
  }
}
