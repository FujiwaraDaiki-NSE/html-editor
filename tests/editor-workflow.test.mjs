import assert from "node:assert/strict";
import test from "node:test";

import {
  applyEditorChange,
  applyEditorHistory,
  createEditorChangeSet,
  diagnosticsBlock,
  htmlChangeWithinElement,
  mergeEditorDecks,
  normalizeEditorDiagnostics,
  validateEditorHtmlSource,
  validateWorkflowOptions,
  validateWorkflowRequest,
} from "../shared/editor-workflow.mjs";
import { sourceElementIdAtOffset, validateEditableSlideSource } from "../app/editor-source.ts";

const deck = (title = "Old", extra = {}) => ({
  settings: { grid: true },
  slides: [{ id: "s1", layout: "cover", elements: [{ id: "title", text: title, style: "large" }, { id: "body", text: "Body" }] }],
  ...extra,
});

test("workflow scope and execution are strict, and out-of-scope edits are reported", () => {
  assert.deepEqual(validateWorkflowOptions("selected-slides", "propose"), { scope: "selected-slides", execution: "propose" });
  assert.throws(() => validateWorkflowOptions("slide", "apply"), /Unknown workflow scope/);
  assert.throws(() => validateWorkflowOptions("deck", "preview"), /Unknown workflow execution/);
  const result = validateWorkflowRequest({
    scope: "selected-slides", execution: "apply", selectedSlideIds: ["s1"],
    changes: [{ id: "a", type: "text", slideId: "s2", elementId: "title" }, { id: "b", type: "settings" }],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.map(({ index, target }) => ({ index, target })), [{ index: 0, target: "element" }, { index: 1, target: "deck" }]);
  assert.throws(() => validateWorkflowRequest({ scope: "deck", execution: "apply" }), /changes is required/);

  const elementResult = validateWorkflowRequest({
    scope: "element", execution: "apply", currentSlideId: "s1", elementId: "title",
    changes: [{ id: "a", type: "text", slideId: "s1", elementId: "body" }],
  });
  assert.equal(elementResult.ok, false);
});

test("HTML element scope rejects changes outside the selected boundary", () => {
  const before = '<main data-weave-slide-source><section data-weave-slot="content"><h1 data-weave-id="title">Old</h1><p data-weave-id="body">Body</p></section></main>';
  assert.equal(htmlChangeWithinElement(before, before.replace("Old", "New"), "title"), true);
  assert.equal(htmlChangeWithinElement(before, before.replace("Body", "Other"), "title"), false);
});

test("three-way merge combines independent user and Agent fields", () => {
  const base = deck();
  const agent = deck();
  agent.slides[0].elements[1].style = "muted";
  const current = deck("User title");
  current.slides[0].elements[1].text = "User body";
  const merged = mergeEditorDecks({ base, agent, current });
  assert.equal(merged.ok, true);
  assert.deepEqual(merged.deck.slides[0].elements, [
    { id: "title", text: "User title", style: "large" },
    { id: "body", text: "User body", style: "muted" },
  ]);
  assert.notStrictEqual(merged.deck, current);
});

test("three-way conflicts are local and preserve the current draft", () => {
  const result = mergeEditorDecks({ base: deck(), agent: deck("Agent title"), current: deck("User title") });
  assert.equal(result.ok, false);
  assert.equal(result.deck.slides[0].elements[0].text, "User title");
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].unit, "element");
  assert.equal(result.conflicts[0].elementId, "title");
  assert.equal(result.conflicts[0].slideId, "s1");
  assert.match(result.conflicts[0].path, /title/);
});

test("change sets preserve reason and classify slide, element, and settings edits", () => {
  const before = deck();
  const after = deck("New title");
  after.slides[0].elements[1].text = "New body";
  after.slides[0].elements.push({ id: "note", text: "Added" });
  after.settings.grid = false;
  const set = createEditorChangeSet(before, after, "Apply brief");
  assert.equal(set.reason, "Apply brief");
  assert.deepEqual(new Set(set.changes.map(({ type }) => type)), new Set(["text", "add", "layout", "settings"]));
  assert.ok(set.changes.every((change) => change.reason === "Apply brief" && "before" in change && "after" in change));
  assert.equal(set.changes.find((change) => change.elementId === "title").type, "text");
  assert.equal(set.changes.find((change) => change.key === "grid").type, "settings");
});

test("deck fields are included and rejected outside deck scope", () => {
  const before = deck("Old", { title: "Deck A", defaultTemplateId: "orbit" });
  const after = deck("Old", { title: "Deck B", defaultTemplateId: "grid" });
  const set = createEditorChangeSet(before, after, "Rename deck");
  assert.deepEqual(set.changes.map((change) => change.key), ["title", "defaultTemplateId"]);
  assert.equal(validateWorkflowRequest({ scope: "current-slide", execution: "apply", currentSlideId: "s1", changes: set.changes }).ok, false);
  assert.deepEqual(applyEditorHistory(before, set.changes, "redo", { kind: "all" }), after);
});

test("single and slide history actions do not undo unrelated later edits", () => {
  const before = deck();
  const after = deck("New title");
  const set = createEditorChangeSet(before, after, "Change title");
  const later = structuredClone(after);
  later.slides[0].elements[1].text = "Later user edit";
  const undone = applyEditorHistory(later, set.changes, "undo", { kind: "change", changeId: set.changes[0].id });
  assert.equal(undone.slides[0].elements[0].text, "Old");
  assert.equal(undone.slides[0].elements[1].text, "Later user edit");
  const redone = applyEditorHistory(undone, set.changes, "redo", { kind: "change", changeId: set.changes[0].id });
  assert.equal(redone.slides[0].elements[0].text, "New title");
  assert.equal(redone.slides[0].elements[1].text, "Later user edit");
  assert.throws(() => applyEditorHistory(later, set.changes, "undo", { kind: "deck" }), /target.kind/);
});

test("full history handles inserted, deleted, and moved elements in both directions", () => {
  const before = { settings: {}, slides: [{ id: "s1", elements: [{ id: "a", text: "a" }, { id: "b", text: "b" }, { id: "c", text: "c" }] }] };
  const after = { settings: {}, slides: [{ id: "s1", elements: [{ id: "c", text: "C" }, { id: "a", text: "a" }, { id: "d", text: "d" }] }] };
  const changes = createEditorChangeSet(before, after, "Rearrange").changes;
  assert.deepEqual(applyEditorHistory(before, changes, "redo", { kind: "all" }), after);
  assert.deepEqual(applyEditorHistory(after, changes, "undo", { kind: "all" }), before);
});

test("HTML source validation returns syntax, IDs, and boundary matrix", () => {
  const valid = validateEditorHtmlSource('<main data-weave-slide-source data-weave-template="cover" data-weave-layout="hero"><section data-weave-slot="content"><h1 data-weave-slot="title" data-weave-id="title">Title <em>now</em><br></h1></section></main>');
  assert.equal(valid.ok, true);
  assert.equal(valid.matrix.syntax.ok, true);
  assert.equal(valid.matrix.slideSource.ok, true);
  assert.equal(valid.matrix.content.ok, true);
  assert.equal(valid.matrix.title.ok, true);
  const invalid = validateEditorHtmlSource('<main data-weave-slide-source data-weave-template="cover"><section data-weave-slot="content"><p data-weave-id="x"></section><div data-weave-id="x"></div>');
  assert.equal(invalid.ok, false);
  assert.ok(invalid.diagnostics.some((item) => item.code === "html.mismatched-tag"));
  assert.ok(invalid.diagnostics.some((item) => item.code === "html.duplicate-weave-id"));
  assert.ok(invalid.diagnostics.some((item) => item.code === "html.missing-boundary-title"));
  assert.ok(invalid.diagnostics.every((item) => item.line >= 1 && item.column >= 1));
});

test("source editing accepts inline formatting and resolves a caret inside element text", () => {
  const source = '<main data-weave-slide-source data-weave-template="cover" data-weave-layout="hero"><section data-weave-slot="content"><h1 data-weave-slot="title" data-weave-id="title">Title <em>now</em><br></h1><div data-weave-id="metrics"><strong>42%</strong><span>less rework</span></div></section></main>';
  assert.deepEqual(validateEditableSlideSource(source), []);
  assert.equal(sourceElementIdAtOffset(source, source.indexOf("now") + 1), "title");
});

test("diagnostics normalize all severities and only errors block", () => {
  const diagnostics = normalizeEditorDiagnostics([
    { severity: "warning", code: "layout", message: "Tight", slideId: "s1", elementId: "body", explanation: "Spacing", fixSuggestion: "Increase gap" },
    { severity: "suggestion", message: "Try a larger title" },
  ]);
  assert.deepEqual(diagnostics[0], { severity: "warning", code: "layout", message: "Tight", source: null, slideId: "s1", elementId: "body", explanation: "Spacing", fixSuggestion: "Increase gap" });
  assert.equal(diagnostics[1].fixSuggestion, null);
  assert.equal(diagnosticsBlock(diagnostics), false);
  assert.equal(diagnosticsBlock([...diagnostics, { severity: "error", message: "Broken" }]), true);
  assert.throws(() => normalizeEditorDiagnostics([{ severity: "info", message: "No" }]), /Unknown diagnostic severity/);
});

test("a single record can be applied in either direction", () => {
  const before = deck();
  const after = deck("New title");
  const change = createEditorChangeSet(before, after, "Rename").changes[0];
  assert.equal(applyEditorChange(before, change, "redo").slides[0].elements[0].text, "New title");
  assert.equal(applyEditorChange(after, change, "undo").slides[0].elements[0].text, "Old");
});
