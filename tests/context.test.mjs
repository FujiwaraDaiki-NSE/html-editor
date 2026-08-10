import assert from "node:assert/strict";
import test from "node:test";

import { editorEnvelope, contextPromptRules } from "../shared/context.mjs";

const typicalAnnotations = [
  {
    id: "annotation-element", order: 1,
    target: { kind: "element", weaveId: "headline", elementKind: "heading", textExcerpt: "Northstar growth outlook" },
    rect: { x: 80, y: 70, w: 520, h: 96 }, label: "Keep this prominent", intersects: ["headline", "metrics"],
  },
  {
    id: "annotation-region", order: 2, target: { kind: "region" },
    rect: { x: 640, y: 120, w: 520, h: 420 }, label: "Customer proof", intersects: ["metrics", "body"],
  },
];

test("editor envelopes keep only the compact perspective", () => {
  const envelope = editorEnvelope({
    slide: "opportunity",
    activeSlideHtml: "<main>should not travel</main>", css: ".huge-css{}",
    revision: "rev-1", recentHistory: [{ message: "old" }], selectedText: "browser range",
    selected: { id: "headline", kind: "heading", label: "heading", text: "Northstar growth outlook" },
    annotations: typicalAnnotations,
  });
  assert.deepEqual(envelope.selected, { id: "headline", kind: "heading", text: "Northstar growth outlook" });
  assert.equal("activeSlideHtml" in envelope, false);
  assert.equal("css" in envelope, false);
  assert.equal("revision" in envelope, false);
  assert.equal("recentHistory" in envelope, false);
  assert.equal("selectedText" in envelope, false);
  assert.equal("label" in envelope.selected, false);
  assert.equal(envelope.slide, "opportunity");
  assert.equal(`slides/${envelope.slide}.html`, "slides/opportunity.html");
  /* The slide HTML travels as a file path, so the element target names the element instead of quoting it. */
  assert.equal("html" in envelope.annotations[0].target, false);
  assert.equal(envelope.annotations[0].target.elementKind, "heading");
  assert.ok(JSON.stringify(envelope).length < 1024, `envelope is ${JSON.stringify(envelope).length} bytes`);
});

test("empty and invalid inputs fail safe", () => {
  assert.doesNotThrow(() => editorEnvelope());
  assert.deepEqual(editorEnvelope(), {});
  assert.doesNotThrow(() => editorEnvelope([]));
  assert.doesNotThrow(() => editorEnvelope({ slide: 4, annotations: "not an array", selected: [] }));
  assert.deepEqual(editorEnvelope({ slide: 4, annotations: "not an array", selected: [] }), { slide: "4" });
});

test("context rules describe the file-backed truth", () => {
  assert.match(contextPromptRules, /slide HTML, CSS, templates, and history from project files/);
  assert.match(contextPromptRules, /slides\/<slide>\.html/);
  assert.match(contextPromptRules, /data-weave-id/);
  assert.match(contextPromptRules, /prefer the id/);
});
