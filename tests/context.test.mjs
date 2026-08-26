import assert from "node:assert/strict";
import test from "node:test";

import { editorEnvelope, isReferencePath, overflowingIds, contextPromptRules } from "../shared/context.mjs";
import { designHeight, designWidth } from "../shared/slide-design.mjs";

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
    overflowing: ["headline", "metrics", "body"],
  });
  assert.deepEqual(envelope.selected, { id: "headline", kind: "heading", text: "Northstar growth outlook" });
  assert.equal("activeSlideHtml" in envelope, false);
  assert.equal("css" in envelope, false);
  assert.equal("revision" in envelope, false);
  assert.equal("recentHistory" in envelope, false);
  assert.equal("selectedText" in envelope, false);
  assert.equal("label" in envelope.selected, false);
  assert.equal(envelope.slide, "opportunity");
  assert.deepEqual(envelope.overflowing, ["headline", "metrics", "body"]);
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

test("overflowingIds reports frame and content overflow in input order", () => {
  assert.deepEqual(overflowingIds([
    { id: "left", box: { left: -2, top: 0, right: 100, bottom: 100 }, scrollHeight: 100, clientHeight: 100 },
    { id: "bottom", box: { left: 0, top: 0, right: 100, bottom: 722 }, scrollHeight: 100, clientHeight: 100 },
    { id: "content", box: { left: 0, top: 0, right: 100, bottom: 100 }, scrollHeight: 121, clientHeight: 100 },
    { id: "left", box: { left: -4, top: 0, right: 100, bottom: 100 }, scrollHeight: 200, clientHeight: 100 },
  ]), ["left", "bottom", "content"]);
});

test("overflowingIds stays empty for a slide that fits", () => {
  assert.deepEqual(overflowingIds([
    { id: "eyebrow", box: { left: 80, top: 64, right: 520, bottom: 88 }, scrollHeight: 24, clientHeight: 24 },
    { id: "heading", box: { left: 80, top: 180, right: 1120, bottom: 380 }, scrollHeight: 200, clientHeight: 200 },
    { id: "note", box: { left: 80, top: 620, right: 600, bottom: 656 }, scrollHeight: 36, clientHeight: 36 },
  ]), []);
});

test("overflowingIds ignores a one-pixel-or-less excess", () => {
  assert.deepEqual(overflowingIds([
    { id: "edge-left", box: { left: -1, top: 0, right: 100, bottom: 100 }, scrollHeight: 100, clientHeight: 100 },
    { id: "edge-right", box: { left: 0, top: 0, right: designWidth + 1, bottom: designHeight }, scrollHeight: 101, clientHeight: 100 },
    { id: "edge-bottom", box: { left: 0, top: 0, right: 100, bottom: designHeight + 1 }, scrollHeight: 100, clientHeight: 100 },
  ]), []);
});

test("overflowingIds caps the result at twenty unique ids", () => {
  const measurements = Array.from({ length: 25 }, (_, index) => ({
    id: `overflow-${index}`,
    box: { left: 0, top: 0, right: designWidth, bottom: designHeight + 2 },
    scrollHeight: 100, clientHeight: 100,
  }));
  assert.equal(overflowingIds(measurements).length, 20);
});

test("editor envelopes include non-empty overflowing ids only", () => {
  assert.deepEqual(editorEnvelope({ overflowing: ["headline", "body", "", "headline"] }).overflowing, ["headline", "body"]);
  assert.equal("overflowing" in editorEnvelope({ overflowing: [] }), false);
});

test("editor envelopes normalize attachments, cap them, and omit invalid or empty values", () => {
  const attachments = Array.from({ length: 22 }, (_, index) => ({ path: `references/${index}.pdf`, name: `資料${index}.pdf`, bytes: index + 1 }));
  attachments.push({ path: "", name: "bad", bytes: 1 }, { path: "references/bad", name: "bad", bytes: "1" });
  assert.equal(editorEnvelope({ attachments }).attachments.length, 20);
  assert.equal("attachments" in editorEnvelope({ attachments: [] }), false);
  assert.equal("attachments" in editorEnvelope({ attachments: [{ path: "references/b", name: "", bytes: 1 }] }), false);
  assert.equal("attachments" in editorEnvelope({ attachments: [
    { path: "../secret.png", name: "secret.png", bytes: 1 },
    { path: "/Users/secret.png", name: "secret.png", bytes: 1 },
    { path: "assets/secret.png", name: "secret.png", bytes: 1 },
  ] }), false);
});

test("context rules describe the file-backed truth", () => {
  assert.match(contextPromptRules, /slide HTML, CSS, templates, and history from project files/);
  assert.match(contextPromptRules, /slides\/<slide>\.html/);
  assert.match(contextPromptRules, /data-weave-id/);
  assert.match(contextPromptRules, /prefer the id/);
  assert.match(contextPromptRules, /rendering result/);
});

test("reference paths allow nested folders without allowing traversal", () => {
  assert.equal(isReferencePath("references/project/docs/brief.pdf"), true);
  assert.equal(isReferencePath("references/../secret"), false);
  assert.equal(isReferencePath("references//secret"), false);
  assert.equal(isReferencePath("references/\\secret"), false);
  assert.equal(isReferencePath("/references/secret"), false);
});

test("folder attachments require kind and a file count", () => {
  assert.deepEqual(editorEnvelope({ attachments: [{ path: "references/docs", name: "docs", bytes: 12, kind: "folder", files: 3 }] }).attachments, [{ path: "references/docs", name: "docs", bytes: 12, kind: "folder", files: 3 }]);
  assert.equal("attachments" in editorEnvelope({ attachments: [{ path: "references/docs", name: "docs", bytes: 12, kind: "folder" }] }), false);
});
