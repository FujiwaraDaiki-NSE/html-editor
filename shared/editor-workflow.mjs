/* Pure editor workflow primitives.

   The functions in this module deliberately do not know about React, the API, or
   the filesystem. A deck is a plain object with a `slides` array. Slides and
   their editable children have stable `id` values; child arrays may be named
   `elements`, `blocks`, or `children`.
*/

export const WORKFLOW_SCOPES = Object.freeze([
  "element",
  "current-slide",
  "selected-slides",
  "deck",
]);

export const WORKFLOW_EXECUTIONS = Object.freeze(["apply", "propose", "plan"]);
export const CHANGE_TYPES = Object.freeze([
  "text",
  "add",
  "delete",
  "layout",
  "style",
  "slide-add",
  "slide-delete",
  "slide-move",
  "settings",
]);

const CHILD_KEYS = Object.freeze(["elements", "blocks", "children"]);
const ABSENT = Symbol("absent");
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function requireRecord(value, name) {
  if (!isRecord(value)) throw new TypeError(`${name} must be an object.`);
  return value;
}

function requireArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array.`);
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string.`);
  return value;
}

function clone(value) {
  if (value === ABSENT) return ABSENT;
  if (Array.isArray(value)) return value.map(clone);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

function equal(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, index) => equal(item, right[index]));
  if (isRecord(left)) {
    if (!isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => hasOwn(right, key) && equal(left[key], right[key]));
  }
  return false;
}

function slideList(deck, name) {
  requireRecord(deck, "deck");
  const slides = requireArray(deck.slides, "deck.slides");
  if (name === undefined) return slides;
  if (typeof name !== "string") throw new TypeError("slide collection name must be a string.");
  return slides;
}

function idOf(value, name) {
  requireRecord(value, name);
  return requireString(value.id, `${name}.id`);
}

function childKey(slide) {
  requireRecord(slide, "slide");
  for (const key of CHILD_KEYS) if (hasOwn(slide, key)) return key;
  return null;
}

function indexed(items, name) {
  const map = new Map();
  for (const item of requireArray(items, name)) {
    const id = idOf(item, name);
    if (map.has(id)) throw new TypeError(`${name} contains duplicate id ${id}.`);
    map.set(id, item);
  }
  return map;
}

function changeTarget(change) {
  const type = requireString(change.type, "change.type");
  if (!CHANGE_TYPES.includes(type)) throw new TypeError(`Unknown change type: ${type}.`);
  if (type === "settings") return "deck";
  if (type === "slide-add" || type === "slide-delete" || type === "slide-move") return "slide";
  return hasOwn(change, "elementId") && change.elementId !== null ? "element" : "slide";
}

function validateScopeValue(scope) {
  if (!WORKFLOW_SCOPES.includes(scope)) throw new TypeError(`Unknown workflow scope: ${String(scope)}.`);
  return scope;
}

function validateExecutionValue(execution) {
  if (!WORKFLOW_EXECUTIONS.includes(execution)) throw new TypeError(`Unknown workflow execution: ${String(execution)}.`);
  return execution;
}

export function validateWorkflowOptions(scope, execution) {
  return { scope: validateScopeValue(scope), execution: validateExecutionValue(execution) };
}

/** Validate an intent and report every change that falls outside its scope. */
export function validateWorkflowRequest(request) {
  requireRecord(request, "request");
  if (!hasOwn(request, "scope")) throw new TypeError("request.scope is required.");
  if (!hasOwn(request, "execution")) throw new TypeError("request.execution is required.");
  if (!hasOwn(request, "changes")) throw new TypeError("request.changes is required.");
  const { scope, execution } = validateWorkflowOptions(request.scope, request.execution);
  const changes = requireArray(request.changes, "request.changes");
  const selectedSlideIds = scope === "selected-slides"
    ? requireArray(request.selectedSlideIds, "request.selectedSlideIds")
    : request.selectedSlideIds;
  if (scope !== "selected-slides" && hasOwn(request, "selectedSlideIds")) throw new TypeError("selectedSlideIds is only valid for selected-slides scope.");
  const selected = selectedSlideIds === undefined ? null : new Set(selectedSlideIds.map((id) => requireString(id, "selectedSlideIds entry")));
  const scopedSlideId = scope === "element" ? requireString(request.currentSlideId, "request.currentSlideId") : null;
  const scopedElementId = scope === "element" ? requireString(request.elementId, "request.elementId") : null;
  const violations = [];
  changes.forEach((change, index) => {
    requireRecord(change, `request.changes[${index}]`);
    const target = changeTarget(change);
    const slideId = change.slideId === undefined || change.slideId === null ? null : requireString(change.slideId, `request.changes[${index}].slideId`);
    const allowed = scope === "deck"
      ? true
      : scope === "element"
        ? target === "element" && slideId === scopedSlideId && change.elementId === scopedElementId
        : scope === "current-slide"
          ? target === "slide" && slideId !== null && request.currentSlideId === slideId
          : target !== "deck" && slideId !== null && selected.has(slideId);
    if (!allowed) violations.push({ index, type: change.type, slideId, elementId: change.elementId ?? null, target, reason: "change-out-of-scope" });
  });
  if (scope === "current-slide") requireString(request.currentSlideId, "request.currentSlideId");
  return { ok: violations.length === 0, scope, execution, violations };
}

export const validateEditorWorkflow = validateWorkflowRequest;
export const validateWorkflowScope = validateScopeValue;
export const validateWorkflowExecution = validateExecutionValue;

function mergeIdentifiedArray(base, agent, current, path, conflicts) {
  const baseMap = indexed(base, `${path} base`);
  const agentMap = indexed(agent, `${path} agent`);
  const currentMap = indexed(current, `${path} current`);
  const baseIds = base.map((item) => item.id);
  const agentIds = agent.map((item) => item.id);
  const currentIds = current.map((item) => item.id);
  const allIds = [...new Set([...currentIds, ...agentIds, ...baseIds])];
  const merged = new Map();
  for (const id of allIds) {
    merged.set(id, mergeValue(baseMap.has(id) ? baseMap.get(id) : ABSENT, agentMap.has(id) ? agentMap.get(id) : ABSENT, currentMap.has(id) ? currentMap.get(id) : ABSENT, `${path}[${id}]`, conflicts));
  }
  const baseOrder = baseIds.join("\u0000");
  const agentOrder = agentIds.join("\u0000");
  const currentOrder = currentIds.join("\u0000");
  const agentReordered = agentOrder !== baseOrder;
  const currentReordered = currentOrder !== baseOrder;
  if (agentReordered && currentReordered && agentOrder !== currentOrder) {
    conflicts.push(conflictEntry(`${path}.$order`, { unit: path.startsWith("deck.slides") ? "slide" : "element", base: clone(baseIds), current: clone(currentIds), agent: clone(agentIds) }, "Both sides reordered the same collection."));
  }
  const order = currentReordered ? currentIds : agentReordered ? agentIds : baseIds;
  const resultIds = [...order, ...allIds.filter((id) => !order.includes(id))];
  return resultIds.filter((id) => merged.get(id) !== ABSENT).map((id) => merged.get(id));
}

function conflictEntry(path, values, explanation) {
  const location = path.match(/\.slides\[([^\]]+)\](?:\.(?:elements|blocks|children)\[([^\]]+)\])?/);
  const unit = location?.[2] ? "element" : location ? "slide" : "deck";
  return {
    ...values,
    path,
    ...(hasOwn(values, "unit") ? {} : { unit }),
    ...(location ? { slideId: location[1] } : {}),
    ...(location?.[2] ? { elementId: location[2] } : {}),
    explanation,
  };
}

function mergeValue(base, agent, current, path, conflicts) {
  if (equal(agent, base)) return clone(current);
  if (equal(current, base)) return clone(agent);
  if (equal(agent, current)) return clone(agent);
  if (base === ABSENT) {
    if (current === ABSENT) return clone(agent);
    if (agent === ABSENT) return clone(current);
  }
  if (base !== ABSENT && agent === ABSENT) {
    if (equal(current, base)) return ABSENT;
    conflicts.push(conflictEntry(path, { base: clone(base), current: clone(current), agent: null }, "Agent deleted a unit edited by the user."));
    return clone(current);
  }
  if (base !== ABSENT && current === ABSENT) {
    if (equal(agent, base)) return ABSENT;
    conflicts.push(conflictEntry(path, { base: clone(base), current: null, agent: clone(agent) }, "The user deleted a unit edited by the Agent."));
    return ABSENT;
  }
  if (Array.isArray(base) && Array.isArray(agent) && Array.isArray(current) && base.every((item) => isRecord(item) && typeof item.id === "string") && agent.every((item) => isRecord(item) && typeof item.id === "string") && current.every((item) => isRecord(item) && typeof item.id === "string")) {
    return mergeIdentifiedArray(base, agent, current, path, conflicts);
  }
  if (isRecord(base) && isRecord(agent) && isRecord(current)) {
    const result = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(agent), ...Object.keys(current)])) {
      const value = mergeValue(hasOwn(base, key) ? base[key] : ABSENT, hasOwn(agent, key) ? agent[key] : ABSENT, hasOwn(current, key) ? current[key] : ABSENT, `${path}.${key}`, conflicts);
      if (value !== ABSENT) result[key] = value;
    }
    return result;
  }
  conflicts.push(conflictEntry(path, { base: clone(base), current: clone(current), agent: clone(agent) }, "Both sides changed the same value."));
  return clone(current);
}

/** Three-way merge that treats ID-bearing slides/elements as independent units. */
export function mergeEditorDecks(input) {
  requireRecord(input, "input");
  for (const key of ["base", "agent", "current"]) if (!hasOwn(input, key)) throw new TypeError(`input.${key} is required.`);
  const { base, agent, current } = input;
  slideList(base); slideList(agent); slideList(current);
  if (hasOwn(input, "scope")) validateScopeValue(input.scope);
  const conflicts = [];
  const merged = mergeValue(base, agent, current, "deck", conflicts);
  return { deck: merged, conflicts, ok: conflicts.length === 0 };
}

export const threeWayMergeDecks = mergeEditorDecks;
export const mergeAgentDraft = mergeEditorDecks;

function fieldType(key) {
  const normalized = key.toLowerCase();
  if (/text|content|html|title|label|value|description/.test(normalized)) return "text";
  if (/style|class|color|font|accent|theme/.test(normalized)) return "style";
  if (/layout|position|rect|direction|align|gap|width|height|order|grid|size|template/.test(normalized)) return "layout";
  return "layout";
}

function makeChange(type, details, reason, id) {
  return { id, type, reason, ...details };
}

function pushFieldChanges(changes, before, after, details, reason, idRef) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (key === "id" || key === "elements" || key === "blocks" || key === "children") continue;
    const beforePresent = hasOwn(before, key);
    const afterPresent = hasOwn(after, key);
    if (beforePresent && afterPresent && equal(before[key], after[key])) continue;
    const type = fieldType(key);
    changes.push(makeChange(type, { ...details, path: [...details.path, key], key, before: beforePresent ? clone(before[key]) : null, after: afterPresent ? clone(after[key]) : null, beforePresent, afterPresent }, reason, `change-${idRef.value++}`));
  }
}

/** Produce a deterministic, field-level change set from two decks. */
export function createEditorChangeSet(beforeDeck, afterDeck, reason) {
  slideList(beforeDeck); slideList(afterDeck); requireString(reason, "reason");
  const changes = [];
  const ref = { value: 1 };
  const beforeDeckFields = { ...beforeDeck };
  const afterDeckFields = { ...afterDeck };
  delete beforeDeckFields.slides; delete beforeDeckFields.settings;
  delete afterDeckFields.slides; delete afterDeckFields.settings;
  pushFieldChanges(changes, beforeDeckFields, afterDeckFields, { slideId: null, elementId: null, path: [] }, reason, ref);
  for (const change of changes) change.type = "settings";
  const beforeSlides = indexed(beforeDeck.slides, "beforeDeck.slides");
  const afterSlides = indexed(afterDeck.slides, "afterDeck.slides");
  const beforeOrder = beforeDeck.slides.map((slide) => slide.id);
  const afterOrder = afterDeck.slides.map((slide) => slide.id);
  const slidesMoved = !equal(beforeOrder, afterOrder);
  for (const slide of beforeDeck.slides) {
    if (!afterSlides.has(slide.id)) changes.push(makeChange("slide-delete", { path: ["slides", slide.id], slideId: slide.id, before: clone(slide), after: null, beforePresent: true, afterPresent: false, indexBefore: beforeDeck.slides.indexOf(slide) }, reason, `change-${ref.value++}`));
  }
  for (const slide of afterDeck.slides) {
    if (!beforeSlides.has(slide.id)) changes.push(makeChange("slide-add", { path: ["slides", slide.id], slideId: slide.id, before: null, after: clone(slide), beforePresent: false, afterPresent: true, indexAfter: afterDeck.slides.indexOf(slide) }, reason, `change-${ref.value++}`));
  }
  for (const slide of beforeDeck.slides) {
    if (!afterSlides.has(slide.id)) continue;
    const next = afterSlides.get(slide.id);
    const beforeKey = childKey(slide);
    const afterKey = childKey(next);
    const details = { slideId: slide.id, elementId: null, path: ["slides", slide.id] };
    const beforeWithoutChildren = { ...slide }; const afterWithoutChildren = { ...next };
    for (const key of CHILD_KEYS) { delete beforeWithoutChildren[key]; delete afterWithoutChildren[key]; }
    pushFieldChanges(changes, beforeWithoutChildren, afterWithoutChildren, details, reason, ref);
    if (beforeKey !== afterKey && (beforeKey !== null || afterKey !== null)) {
      changes.push(makeChange("layout", { ...details, path: [...details.path, "children-key"], key: "children-key", before: beforeKey, after: afterKey }, reason, `change-${ref.value++}`));
    }
    const beforeChildren = beforeKey === null ? [] : slide[beforeKey];
    const afterChildren = afterKey === null ? [] : next[afterKey];
    const beforeElements = indexed(beforeChildren, `slide ${slide.id} before children`);
    const afterElements = indexed(afterChildren, `slide ${slide.id} after children`);
    const elementsMoved = !equal(beforeChildren.map((item) => item.id), afterChildren.map((item) => item.id));
    if (elementsMoved) {
      changes.push(makeChange("layout", { ...details, path: [...details.path, beforeKey ?? afterKey ?? "elements", "$order"], key: "$order", before: beforeChildren.map((item) => item.id), after: afterChildren.map((item) => item.id) }, reason, `change-${ref.value++}`));
    }
    for (const element of beforeChildren) if (!afterElements.has(element.id)) changes.push(makeChange("delete", { ...details, elementId: element.id, path: [...details.path, beforeKey ?? afterKey ?? "elements", element.id], before: clone(element), after: null, beforePresent: true, afterPresent: false, indexBefore: beforeChildren.indexOf(element) }, reason, `change-${ref.value++}`));
    for (const element of afterChildren) if (!beforeElements.has(element.id)) changes.push(makeChange("add", { ...details, elementId: element.id, path: [...details.path, afterKey ?? beforeKey ?? "elements", element.id], before: null, after: clone(element), beforePresent: false, afterPresent: true, indexAfter: afterChildren.indexOf(element) }, reason, `change-${ref.value++}`));
    for (const element of beforeChildren) {
      if (!afterElements.has(element.id)) continue;
      pushFieldChanges(changes, element, afterElements.get(element.id), { ...details, elementId: element.id, path: [...details.path, beforeKey ?? afterKey ?? "elements", element.id] }, reason, ref);
    }
  }
  if (slidesMoved) changes.push(makeChange("slide-move", { path: ["slides"], slideId: null, before: beforeOrder, after: afterOrder }, reason, `change-${ref.value++}`));
  const beforeSettings = isRecord(beforeDeck.settings) ? beforeDeck.settings : {};
  const afterSettings = isRecord(afterDeck.settings) ? afterDeck.settings : {};
  pushFieldChanges(changes, beforeSettings, afterSettings, { slideId: null, elementId: null, path: ["settings"] }, reason, ref);
  for (const change of changes) if (change.path[0] === "settings") change.type = "settings";
  return { changes, before: clone(beforeDeck), after: clone(afterDeck), reason };
}

export const generateEditorChangeSet = createEditorChangeSet;
export const buildEditorChangeSet = createEditorChangeSet;

function htmlElementRange(html, elementId) {
  const tokens = [...String(html).matchAll(/<\/?[A-Za-z][^>]*>/g)];
  const stack = [];
  for (const token of tokens) {
    const parsed = parseTag(token[0]);
    if (!parsed) continue;
    if (parsed.closing) {
      const entry = stack.pop();
      if (entry?.elementId === elementId) return { start: entry.start, end: token.index + token[0].length };
      continue;
    }
    const entry = { start: token.index, elementId: parsed.attributes.get("data-weave-id") ?? null };
    if (parsed.selfClosing) {
      if (entry.elementId === elementId) return { start: entry.start, end: token.index + token[0].length };
    } else stack.push(entry);
  }
  return null;
}

/** True only when the complete HTML difference is contained by one selected element. */
export function htmlChangeWithinElement(beforeHtml, afterHtml, elementId) {
  requireString(elementId, "elementId");
  const before = String(beforeHtml);
  const after = String(afterHtml);
  const beforeRange = htmlElementRange(before, elementId);
  if (!beforeRange) return false;
  const prefix = before.slice(0, beforeRange.start);
  const suffix = before.slice(beforeRange.end);
  const afterRange = htmlElementRange(after, elementId);
  if (afterRange) return after.slice(0, afterRange.start) === prefix && after.slice(afterRange.end) === suffix;
  return after === `${prefix}${suffix}`;
}

function findSlide(deck, slideId) {
  const slides = slideList(deck);
  const index = slides.findIndex((slide) => slide.id === slideId);
  if (index < 0) throw new RangeError(`Slide ${slideId} was not found.`);
  return { slides, slide: slides[index], index };
}

function replaceAtPath(root, path, value, present) {
  const result = clone(root);
  let cursor = result;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (!isRecord(cursor[key]) && !Array.isArray(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  const key = path[path.length - 1];
  if (present) cursor[key] = clone(value); else delete cursor[key];
  return result;
}

function applyOrder(deck, slideId, order) {
  const result = clone(deck);
  const { slides } = findSlide(result, slideId);
  const slide = slides.find((item) => item.id === slideId);
  const key = childKey(slide);
  if (key === null) throw new RangeError(`Slide ${slideId} has no child collection.`);
  const elements = indexed(slide[key], `slide ${slideId}.${key}`);
  const ids = requireArray(order, "change order").map((id) => requireString(id, "change order entry"));
  slide[key] = ids.map((id) => elements.get(id)).filter((item) => item !== undefined);
  return result;
}

/** Apply one record in either direction without replacing unrelated fields. */
export function applyEditorChange(deck, change, direction) {
  slideList(deck); requireRecord(change, "change");
  if (direction !== "undo" && direction !== "redo") throw new TypeError("direction must be undo or redo.");
  const type = requireString(change.type, "change.type");
  if (!CHANGE_TYPES.includes(type)) throw new TypeError(`Unknown change type: ${type}.`);
  const value = direction === "undo" ? change.before : change.after;
  const present = direction === "undo" ? change.beforePresent !== false : change.afterPresent !== false;
  if (type === "slide-add" || type === "slide-delete") {
    const result = clone(deck);
    const existing = result.slides.findIndex((slide) => slide.id === change.slideId);
    if ((direction === "undo" && type === "slide-add") || (direction === "redo" && type === "slide-delete")) {
      if (existing >= 0) result.slides.splice(existing, 1);
      return result;
    }
    if (existing >= 0) result.slides[existing] = clone(value);
    else {
      const index = type === "slide-add" ? change.indexAfter : change.indexBefore;
      if (!Number.isInteger(index) || index < 0) throw new TypeError("slide add/delete change index is required.");
      result.slides.splice(Math.min(index, result.slides.length), 0, clone(value));
    }
    return result;
  }
  if (type === "slide-move") {
    const ids = direction === "undo" ? change.before : change.after;
    const slides = indexed(deck.slides, "deck.slides");
    const result = clone(deck);
    result.slides = ids.map((id) => slides.get(id)).filter((slide) => slide !== undefined);
    return result;
  }
  if (type === "settings") {
    const path = change.path?.[0] === "settings" ? ["settings", change.key] : [change.key];
    return replaceAtPath(deck, path, value, present);
  }
  const result = clone(deck);
  const { slide } = findSlide(result, change.slideId);
  if (type === "add" || type === "delete") {
    const key = childKey(slide);
    if (key === null) throw new RangeError(`Slide ${change.slideId} has no child collection.`);
    const elements = slide[key];
    const existing = elements.findIndex((item) => item.id === change.elementId);
    const adding = (type === "add" && direction === "redo") || (type === "delete" && direction === "undo");
    if (adding && existing < 0) {
      const index = type === "add" ? change.indexAfter : change.indexBefore;
      if (!Number.isInteger(index) || index < 0) throw new TypeError("element add/delete change index is required.");
      elements.splice(Math.min(index, elements.length), 0, clone(value));
    }
    if (!adding && existing >= 0) elements.splice(existing, 1);
    return result;
  }
  if (change.key === "$order") return applyOrder(result, change.slideId, value);
  const key = childKey(slide);
  if (change.elementId === null || change.elementId === undefined) {
    const slideIndex = result.slides.findIndex((item) => item.id === change.slideId);
    if (slideIndex < 0) throw new RangeError(`Slide ${change.slideId} was not found.`);
    if (present) result.slides[slideIndex][change.key] = clone(value); else delete result.slides[slideIndex][change.key];
    return result;
  }
  if (key === null) throw new RangeError(`Slide ${change.slideId} has no child collection.`);
  const element = slide[key].find((item) => item.id === change.elementId);
  if (!element) throw new RangeError(`Element ${change.elementId} was not found on slide ${change.slideId}.`);
  const elementIndex = slide[key].indexOf(element);
  const next = replaceAtPath(element, [change.key], value, present);
  slide[key][elementIndex] = next;
  return result;
}

export const applyWorkflowChange = applyEditorChange;

function selectHistoryChanges(changeSet, target) {
  requireArray(changeSet, "changeSet"); requireRecord(target, "target");
  requireString(target.kind, "target.kind");
  if (target.kind === "all") return changeSet;
  if (target.kind === "change") {
    requireString(target.changeId, "target.changeId");
    return changeSet.filter((change) => change.id === target.changeId);
  }
  if (target.kind === "slide") {
    requireString(target.slideId, "target.slideId");
    return changeSet.filter((change) => change.slideId === target.slideId);
  }
  throw new TypeError("target.kind must be change, slide, or all.");
}

export function applyEditorHistory(deck, changeSet, direction, target) {
  slideList(deck); requireArray(changeSet, "changeSet");
  if (direction !== "undo" && direction !== "redo") throw new TypeError("history direction must be undo or redo.");
  const selected = selectHistoryChanges(changeSet, target);
  const ordered = direction === "undo" ? [...selected].reverse() : selected;
  return ordered.reduce((current, change) => applyEditorChange(current, change, direction), clone(deck));
}

export const undoEditorHistory = (deck, changeSet, target) => applyEditorHistory(deck, changeSet, "undo", target);
export const redoEditorHistory = (deck, changeSet, target) => applyEditorHistory(deck, changeSet, "redo", target);
export const undoEditorChange = (deck, change) => applyEditorHistory(deck, [change], "undo", { kind: "change", changeId: change.id });
export const redoEditorChange = (deck, change) => applyEditorHistory(deck, [change], "redo", { kind: "change", changeId: change.id });
export const undoEditorSlide = (deck, changeSet, slideId) => applyEditorHistory(deck, changeSet, "undo", { kind: "slide", slideId });
export const redoEditorSlide = (deck, changeSet, slideId) => applyEditorHistory(deck, changeSet, "redo", { kind: "slide", slideId });
export const undoEditorDeck = (deck, changeSet) => applyEditorHistory(deck, changeSet, "undo", { kind: "all" });
export const redoEditorDeck = (deck, changeSet) => applyEditorHistory(deck, changeSet, "redo", { kind: "all" });

const sourceDiagnostic = (code, message, index, length, severity = "error") => ({ code, severity, message, source: "html", index, length });

function lineColumn(text, index) {
  const prefix = text.slice(0, Math.max(0, index));
  return { line: prefix.split("\n").length, column: prefix.length - prefix.lastIndexOf("\n") };
}

function parseTag(token) {
  const match = token.match(/^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)([\s\S]*?)(\/?)\s*>$/);
  if (!match) return null;
  const [, closing, name, rawAttributes, selfClosing] = match;
  if (closing) return { closing: true, name: name.toLowerCase(), attributes: new Map(), selfClosing: false };
  const attributes = new Map();
  const expression = /([A-Za-z_:][A-Za-z0-9:._-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let matchAttribute; let consumed = "";
  while ((matchAttribute = expression.exec(rawAttributes.replace(/\/\s*$/, ""))) !== null) {
    consumed += matchAttribute[0];
    const nameKey = matchAttribute[1].toLowerCase();
    if (attributes.has(nameKey)) attributes.set(`__duplicate__${nameKey}`, true);
    else attributes.set(nameKey, matchAttribute[2] ?? matchAttribute[3] ?? matchAttribute[4] ?? "");
  }
  const cleanRaw = rawAttributes.replace(/\/\s*$/, "");
  if (cleanRaw.replace(/\s/g, "") !== consumed.replace(/\s/g, "")) return null;
  return { closing: false, name: name.toLowerCase(), attributes, selfClosing: selfClosing === "/" || ["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"].includes(name.toLowerCase()) };
}

/** Validate HTML syntax and the editor's source/ID boundary contract. */
export function validateEditorHtmlSource(html) {
  if (typeof html !== "string") throw new TypeError("html must be a string.");
  const diagnostics = [];
  const stack = [];
  const ids = new Map();
  const tags = [];
  const tokenExpression = /<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][^>]*>/g;
  let token; let cursor = 0;
  while ((token = tokenExpression.exec(html)) !== null) {
    const raw = token[0];
    if (raw.startsWith("<!--")) {
      if (!raw.endsWith("-->")) diagnostics.push(sourceDiagnostic("html.unclosed-comment", "HTML comment is not closed.", token.index, raw.length));
      cursor = tokenExpression.lastIndex; continue;
    }
    const parsed = parseTag(raw);
    if (!parsed) {
      diagnostics.push(sourceDiagnostic("html.invalid-tag", "HTML tag syntax is invalid.", token.index, raw.length));
      cursor = tokenExpression.lastIndex; continue;
    }
    tags.push({ ...parsed, index: token.index, raw });
    if (parsed.closing) {
      if (stack.length === 0 || stack[stack.length - 1].name !== parsed.name) diagnostics.push(sourceDiagnostic("html.mismatched-tag", `Closing tag does not match ${stack.at(-1)?.name ?? "an opening tag"}.`, token.index, raw.length));
      else stack.pop();
      cursor = tokenExpression.lastIndex; continue;
    }
    for (const key of parsed.attributes.keys()) if (key.startsWith("__duplicate__")) diagnostics.push(sourceDiagnostic("html.duplicate-attribute", `Attribute ${key.slice(12)} is duplicated.`, token.index, raw.length));
    const id = parsed.attributes.get("data-weave-id");
    if (id !== undefined && id !== "") {
      if (ids.has(id)) diagnostics.push(sourceDiagnostic("html.duplicate-weave-id", `data-weave-id ${id} is duplicated.`, token.index, raw.length));
      else ids.set(id, token.index);
    }
    const isRoot = parsed.attributes.has("data-weave-slide-source");
    const slot = parsed.attributes.get("data-weave-slot");
    const nonEditable = ["em", "strong", "b", "i", "u", "s", "small", "sub", "sup", "br"].includes(parsed.name);
    const structural = parsed.name === "html" || parsed.name === "head" || parsed.name === "body" || nonEditable || (parsed.name === "section" && slot === "content");
    if (!isRoot && !structural && id === undefined) diagnostics.push(sourceDiagnostic("html.missing-weave-id", `Editable element <${parsed.name}> is missing data-weave-id.`, token.index, raw.length));
    if (!parsed.selfClosing) stack.push({ name: parsed.name, index: token.index });
    cursor = tokenExpression.lastIndex;
  }
  const unterminatedTag = html.slice(cursor).match(/<[A-Za-z][^>]*$/);
  if (unterminatedTag) diagnostics.push(sourceDiagnostic("html.invalid-tag", "HTML tag is not terminated with >.", cursor + unterminatedTag.index, unterminatedTag[0].length));
  const unterminatedComment = html.slice(cursor).match(/<!--[\s\S]*$/);
  if (unterminatedComment) diagnostics.push(sourceDiagnostic("html.unclosed-comment", "HTML comment is not closed.", cursor + unterminatedComment.index, unterminatedComment[0].length));
  if (/<(?![A-Za-z/!])/.test(html.slice(cursor))) diagnostics.push(sourceDiagnostic("html.invalid-text-tag", "HTML contains an invalid tag opener.", cursor, html.length - cursor));
  while (stack.length > 0) { const entry = stack.pop(); diagnostics.push(sourceDiagnostic("html.unclosed-tag", `Opening tag <${entry.name}> is not closed.`, entry.index, 1)); }
  const rootTags = tags.filter((tag) => !tag.closing && tag.attributes.has("data-weave-slide-source"));
  const hasBoundary = (attribute, value) => tags.some((tag) => !tag.closing && tag.attributes.get(attribute) === value);
  const checks = {
    syntax: { ok: !diagnostics.some((item) => item.code.startsWith("html.") && !["html.missing-weave-id", "html.duplicate-weave-id"].includes(item.code)) },
    slideSource: { ok: rootTags.length === 1, required: "data-weave-slide-source" },
    content: { ok: hasBoundary("data-weave-slot", "content"), required: 'data-weave-slot="content"' },
    title: { ok: hasBoundary("data-weave-slot", "title"), required: 'data-weave-slot="title"' },
    template: { ok: rootTags.length === 1 && rootTags[0].attributes.has("data-weave-template"), required: "data-weave-template" },
    layout: { ok: rootTags.length === 1 && rootTags[0].attributes.has("data-weave-layout"), required: "data-weave-layout" },
    ids: { ok: !diagnostics.some((item) => item.code === "html.missing-weave-id" || item.code === "html.duplicate-weave-id") },
  };
  for (const [name, check] of Object.entries(checks)) if (!check.ok && check.required) diagnostics.push(sourceDiagnostic(`html.missing-boundary-${name}`, `Required editor boundary ${check.required} is missing.`, 0, Math.min(1, html.length)));
  const positionDiagnostics = diagnostics.map((diagnostic) => ({ ...diagnostic, ...lineColumn(html, diagnostic.index) }));
  return { ok: positionDiagnostics.every((item) => item.severity !== "error"), diagnostics: positionDiagnostics, matrix: checks };
}

export const validateHtmlSourceBuffer = validateEditorHtmlSource;
export const validateSourceBuffer = validateEditorHtmlSource;

export function normalizeEditorDiagnostics(diagnostics) {
  requireArray(diagnostics, "diagnostics");
  return diagnostics.map((item, index) => {
    requireRecord(item, `diagnostics[${index}]`);
    if (!hasOwn(item, "severity")) throw new TypeError(`diagnostics[${index}].severity is required.`);
    if (!hasOwn(item, "message")) throw new TypeError(`diagnostics[${index}].message is required.`);
    const severity = item.severity;
    if (!["error", "warning", "suggestion"].includes(severity)) throw new TypeError(`Unknown diagnostic severity: ${String(severity)}.`);
    return {
      severity,
      code: hasOwn(item, "code") ? item.code : null,
      message: item.message,
      source: hasOwn(item, "source") ? item.source : null,
      slideId: hasOwn(item, "slideId") ? item.slideId : null,
      elementId: hasOwn(item, "elementId") ? item.elementId : null,
      explanation: hasOwn(item, "explanation") ? item.explanation : null,
      fixSuggestion: hasOwn(item, "fixSuggestion") ? item.fixSuggestion : null,
      ...(hasOwn(item, "index") ? { index: item.index } : {}),
      ...(hasOwn(item, "line") ? { line: item.line } : {}),
      ...(hasOwn(item, "column") ? { column: item.column } : {}),
    };
  });
}

export const normalizeDiagnostics = normalizeEditorDiagnostics;

export function diagnosticsBlock(diagnostics) {
  return normalizeEditorDiagnostics(diagnostics).some((item) => item.severity === "error");
}

export const hasBlockingDiagnostics = diagnosticsBlock;
