import assert from "node:assert/strict";
import test from "node:test";

import { projectEventDecision } from "../app/project-events.ts";

test("quality-gate project errors remain visible while refreshing restored disk state", () => {
  assert.deepEqual(projectEventDecision({
    status: "error",
    error: "Content policy gate failed.",
    code: "WEAVE_CONTENT_POLICY",
    diagnostics: [
      { message: "Unsupported slide class: content" },
      { message: "Unsupported slide class: title" },
      { message: "Unsupported slide class: content" },
    ],
  }), {
    refreshState: true,
    error: "Content policy gate failed. Unsupported slide class: content Unsupported slide class: title",
    diagnostics: [
      { message: "Unsupported slide class: content" },
      { message: "Unsupported slide class: title" },
      { message: "Unsupported slide class: content" },
    ],
  });
});

test("a rollback failure keeps the UI on its last known-good state", () => {
  assert.deepEqual(projectEventDecision({
    status: "error",
    error: "Content policy gate failed.",
    cleanupError: "disk unavailable",
    diagnostics: [{ code: "design.unknown-class", message: "Unsupported slide class: content", severity: "error", source: "html" }],
  }), {
    refreshState: false,
    error: "Content policy gate failed. Unsupported slide class: content Restore failed: disk unavailable",
    diagnostics: [{ code: "design.unknown-class", message: "Unsupported slide class: content", severity: "error", source: "html" }],
  });
});

test("non-error project events continue to refresh editor state", () => {
  assert.deepEqual(projectEventDecision({ status: "updated" }), { refreshState: true, error: null, diagnostics: [] });
  assert.deepEqual(projectEventDecision({ status: "switched" }), { refreshState: true, error: null, diagnostics: [] });
});
