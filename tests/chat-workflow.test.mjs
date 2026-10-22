import assert from "node:assert/strict";
import test from "node:test";
import { delegatedEditorContext } from "../server/chat-workflow.mjs";

const deck = { slides: [{ id: "cover" }, { id: "body" }] };
const request = { prompt: "見出しを更新", scope: { kind: "current-slide", slideIds: ["cover"], elementId: null }, execution: "apply", allowSkillChanges: false };

test("delegation carries explicit scope, execution, and skill permission", () => {
  assert.deepEqual(delegatedEditorContext(request, deck), { modificationScope: request.scope, executionMode: "apply", allowSkillChanges: false });
  assert.deepEqual(delegatedEditorContext({ ...request, scope: { kind: "deck", slideIds: [], elementId: null }, execution: "plan" }, deck).modificationScope, { kind: "deck", slideIds: [], elementId: null });
});

test("delegation rejects stale slide ids after a project switch", () => {
  assert.throws(() => delegatedEditorContext({ ...request, scope: { ...request.scope, slideIds: ["old-project-slide"] } }, deck), /valid slide editing scope/);
});

test("delegation never invents omitted scope or execution parameters", () => {
  for (const field of ["prompt", "scope", "execution", "allowSkillChanges"]) {
    const incomplete = { ...request };
    delete incomplete[field];
    assert.throws(() => delegatedEditorContext(incomplete, deck));
  }
  assert.throws(() => delegatedEditorContext({ ...request, scope: { kind: "current-slide", slideIds: ["cover"] } }, deck), /elementId/);
});

test("delegation rejects ambiguous element and slide boundaries", () => {
  assert.throws(() => delegatedEditorContext({ ...request, scope: { kind: "element", slideIds: ["cover"], elementId: null } }, deck), /elementId/);
  assert.throws(() => delegatedEditorContext({ ...request, scope: { ...request.scope, slideIds: ["cover", "body"] } }, deck), /exactly one/);
  assert.throws(() => delegatedEditorContext({ ...request, scope: { kind: "selected-slides", slideIds: ["cover", "cover"], elementId: null } }, deck), /Duplicate/);
});
