import assert from "node:assert/strict";
import test from "node:test";

import { preservedSlideNumber, projectEventDecision, projectEventMatchesActivePreview, viewedSlideIdForHydration } from "../app/project-events.ts";

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
  assert.deepEqual(projectEventDecision({ status: "preview" }), { refreshState: true, error: null, diagnostics: [] });
  assert.deepEqual(projectEventDecision({ status: "updated" }), { refreshState: true, error: null, diagnostics: [] });
  assert.deepEqual(projectEventDecision({ status: "switched" }), { refreshState: true, error: null, diagnostics: [] });
});

test("project events apply only to their active preview turn", () => {
  const active = { threadId: "thread-b", turnId: "turn-b", previewSequence: 3 };
  assert.equal(projectEventMatchesActivePreview({ status: "preview", threadId: "thread-b", turnId: "turn-b", previewSequence: 2 }, active), true);
  assert.equal(projectEventMatchesActivePreview({ status: "preview", threadId: "thread-a", turnId: "turn-a", previewSequence: 1 }, active), false);
  assert.equal(projectEventMatchesActivePreview({ status: "updated", threadId: "thread-a", turnId: "turn-a" }, active), false);
  assert.equal(projectEventMatchesActivePreview({ status: "preview", threadId: "thread-a", turnId: "turn-a", previewSequence: 1 }, null), false);
  assert.equal(projectEventMatchesActivePreview({ status: "updated", threadId: "thread-a", turnId: "turn-a" }, null), true);
  assert.equal(projectEventMatchesActivePreview({ status: "switched" }, active), true);
});

test("project previews preserve the viewed slide by id and clamp a removed slide", () => {
  assert.equal(preservedSlideNumber([{ id: "a" }, { id: "b" }, { id: "c" }], [{ id: "b" }, { id: "a" }, { id: "c" }], 2), 1);
  assert.equal(preservedSlideNumber([{ id: "a" }, { id: "b" }, { id: "c" }], [{ id: "a" }, { id: "b" }], 3), 2);
  assert.equal(preservedSlideNumber([{ id: "b" }, { id: "a" }, { id: "c" }], [{ id: "a" }, { id: "b" }, { id: "c" }], 1), 2);
});

test("rollback restores the slide viewed at turn start when a preview temporarily removed it", () => {
  const baseline = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const preview = [{ id: "a" }, { id: "c" }];
  const previewNumber = preservedSlideNumber(baseline, preview, 2);
  assert.equal(previewNumber, 2);
  assert.equal(preservedSlideNumber(preview, baseline, previewNumber, "b"), 2);
});

test("initial mid-turn hydration captures the server slide before preview deletion and rollback", () => {
  const placeholder = [{ id: "opportunity" }];
  const hydrated = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const viewedId = viewedSlideIdForHydration(placeholder, hydrated, 2, false);
  assert.equal(viewedId, "b");
  const preview = [{ id: "a" }, { id: "c" }];
  const previewNumber = preservedSlideNumber(hydrated, preview, 2);
  assert.equal(preservedSlideNumber(preview, hydrated, previewNumber, viewedId), 2);
});
