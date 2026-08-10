import assert from "node:assert/strict";
import test from "node:test";

import {
  annotationPromptRules,
  annotationEnvelope,
  canSendTurn,
  clampRect,
  intersectingIds,
  insertReferenceAt,
  nextOrder,
  pointerTabText,
  rectFromClientBox,
  rectFromPoints,
  rectsIntersect,
  refreshAnnotations,
  referencedOrders,
  referenceToken,
  resizeRect,
  resolveReferences,
  toClientPoint,
  toSlidePoint,
  translateRect,
} from "../shared/annotation.mjs";

test("slide and client coordinates round-trip at every supported scale", () => {
  const viewport = { left: 37, top: 82 };
  const point = { x: 456, y: 123 };
  for (const scale of [0.25, 1, 4]) {
    for (const scroll of [{ left: 0, top: 0 }, { left: 194, top: 47 }]) {
      assert.deepEqual(toSlidePoint(toClientPoint(point, viewport, scale, scroll), viewport, scale, scroll), point);
    }
  }
});

test("pointer coordinates account for viewport origin, scale, and scroll", () => {
  assert.deepEqual(
    toSlidePoint({ clientX: 250, clientY: 180 }, { left: 50, top: 30 }, 0.5, { left: 40, top: 10 }),
    { x: 480, y: 320 },
  );
});

test("client boxes use the same slide coordinate conversion as pointer points", () => {
  const viewport = { left: 50, top: 30 };
  const scroll = { left: 40, top: 10 };
  const scale = 0.5;
  const box = { left: 250, top: 180, width: 120, height: 45 };
  const start = toSlidePoint({ clientX: box.left, clientY: box.top }, viewport, scale, scroll);
  const end = toSlidePoint({ clientX: box.left + box.width, clientY: box.top + box.height }, viewport, scale, scroll);
  assert.deepEqual(rectFromClientBox(box, viewport, scale, scroll), rectFromPoints(start, end));
  assert.deepEqual(rectFromClientBox(box, viewport, scale, scroll), { x: 480, y: 320, w: 240, h: 90 });
});

test("rectangles normalize reversed drags and clamp to the slide", () => {
  assert.deepEqual(rectFromPoints({ x: 420.04, y: 310.06 }, { x: 120.02, y: 90.03 }), { x: 120, y: 90, w: 300, h: 220 });
  assert.deepEqual(rectFromPoints({ x: 120, y: 80 }, { x: 1400, y: 900 }), { x: 120, y: 80, w: 1160, h: 640 });
  assert.deepEqual(clampRect({ x: -50, y: -25, w: 200, h: 100 }), { x: 0, y: 0, w: 150, h: 75 });
});

test("annotation orders start at one and never fill deleted gaps", () => {
  assert.equal(nextOrder([]), 1);
  assert.equal(nextOrder([{ order: 1 }, { order: 3 }]), 4);
  assert.equal(nextOrder([{ order: 9 }, { order: 2 }, { order: 4 }]), 10);
});

test("translated rectangles stop at every slide edge without changing size", () => {
  const rect = { x: 100, y: 80, w: 240, h: 160 };
  assert.deepEqual(translateRect(rect, -500, 0), { x: 0, y: 80, w: 240, h: 160 }, "left");
  assert.deepEqual(translateRect(rect, 2000, 0), { x: 1040, y: 80, w: 240, h: 160 }, "right");
  assert.deepEqual(translateRect(rect, 0, -500), { x: 100, y: 0, w: 240, h: 160 }, "top");
  assert.deepEqual(translateRect(rect, 0, 2000), { x: 100, y: 560, w: 240, h: 160 }, "bottom");
});

test("resizing keeps the opposite corner fixed and flips past it", () => {
  const rect = { x: 100, y: 100, w: 200, h: 120 };
  assert.deepEqual(resizeRect(rect, "nw", { x: 40, y: 60 }), { x: 40, y: 60, w: 260, h: 160 });
  assert.deepEqual(resizeRect(rect, "se", { x: 50, y: 40 }), { x: 50, y: 40, w: 50, h: 60 });
});

test("resizing clamps to the slide and enforces an eight-unit minimum", () => {
  const rect = { x: 100, y: 100, w: 200, h: 120 };
  assert.deepEqual(resizeRect(rect, "nw", { x: -100, y: -100 }), { x: 0, y: 0, w: 300, h: 220 });
  assert.deepEqual(resizeRect(rect, "se", { x: 2000, y: 2000 }), { x: 100, y: 100, w: 1180, h: 620 });
  assert.deepEqual(resizeRect(rect, "se", { x: 103, y: 104 }), { x: 100, y: 100, w: 8, h: 8 });
  assert.deepEqual(resizeRect({ x: 0, y: 0, w: 20, h: 20 }, "se", { x: 0, y: 0 }), { x: 0, y: 0, w: 8, h: 8 });
});

test("rectangles intersect only when their overlap has positive area", () => {
  const subject = { x: 10, y: 10, w: 40, h: 30 };
  assert.equal(rectsIntersect(subject, { x: 30, y: 20, w: 40, h: 40 }), true, "overlap");
  assert.equal(rectsIntersect(subject, { x: 0, y: 0, w: 100, h: 100 }), true, "containment");
  assert.equal(rectsIntersect(subject, { x: 80, y: 80, w: 10, h: 10 }), false, "disjoint");
  assert.equal(rectsIntersect(subject, { x: 50, y: 15, w: 10, h: 10 }), false, "edge contact");
});

test("intersecting ids preserve input order", () => {
  const boxes = [
    { id: "second", rect: { x: 30, y: 30, w: 20, h: 20 } },
    { id: "outside", rect: { x: 90, y: 90, w: 10, h: 10 } },
    { id: "first", rect: { x: 0, y: 0, w: 15, h: 15 } },
  ];
  assert.deepEqual(intersectingIds({ x: 10, y: 10, w: 30, h: 30 }, boxes), ["second", "first"]);
});

test("refreshing annotations updates element geometry and every intersection list", () => {
  const boxes = [
    { id: "heading", rect: { x: 40, y: 30, w: 180, h: 60 }, html: '<h1 data-weave-id="heading">Current title</h1>', elementKind: "heading", textExcerpt: "Current title" },
    { id: "content", rect: { x: 0, y: 0, w: 500, h: 300 }, html: '<section data-weave-id="content"></section>', elementKind: "section", textExcerpt: "" },
    { id: "fallback-overlap", rect: { x: 700, y: 400, w: 80, h: 80 }, html: '<div data-weave-id="fallback-overlap"></div>', elementKind: "div", textExcerpt: "" },
  ];
  const annotations = [
    { id: "element", target: { kind: "element", weaveId: "heading", html: '<h1 data-weave-id="heading">Old title</h1>', elementKind: "h1", textExcerpt: "Old title" }, rect: { x: 1, y: 2, w: 3, h: 4 }, intersects: [] },
    { id: "region", target: { kind: "region" }, rect: { x: 450, y: 250, w: 100, h: 100 }, intersects: ["stale"] },
    { id: "missing", target: { kind: "element", weaveId: "removed", html: '<p data-weave-id="removed">Last capture</p>', elementKind: "paragraph", textExcerpt: "Last capture" }, rect: { x: 720, y: 420, w: 20, h: 20 }, intersects: [] },
  ];
  const refreshed = refreshAnnotations(annotations, boxes);
  assert.deepEqual(refreshed, [
    { id: "element", target: { kind: "element", weaveId: "heading", html: boxes[0].html, elementKind: boxes[0].elementKind, textExcerpt: boxes[0].textExcerpt }, rect: boxes[0].rect, intersects: ["heading", "content"] },
    { id: "region", target: { kind: "region" }, rect: annotations[1].rect, intersects: ["content"] },
    { id: "missing", target: { ...annotations[2].target }, rect: annotations[2].rect, intersects: ["fallback-overlap"] },
  ]);
  assert.notStrictEqual(refreshed[0].rect, boxes[0].rect);
  boxes[0].rect.x = 999;
  assert.equal(refreshed[0].rect.x, 40);
});

test("refreshing keeps the last element snapshot after its box disappears", () => {
  const annotation = {
    id: "removed", target: { kind: "element", weaveId: "removed", html: '<figure data-weave-id="removed">Last capture</figure>', elementKind: "image", textExcerpt: "Last capture" },
    rect: { x: 90, y: 120, w: 320, h: 180 }, intersects: ["stale"],
  };
  assert.deepEqual(refreshAnnotations([annotation], []), [{
    ...annotation,
    target: { ...annotation.target },
    rect: { ...annotation.rect },
    intersects: [],
  }]);
});

test("a turn can be sent with prompt text or annotations", () => {
  assert.equal(canSendTurn("Change the headline", []), true);
  assert.equal(canSendTurn("  \n", [{ id: "annotation" }]), true);
  assert.equal(canSendTurn("", []), false);
  assert.equal(canSendTurn("  \n", []), false);
});

test("annotation prompt rules require flow interpretation rather than literal coordinates", () => {
  assert.match(annotationPromptRules, /approximation.+proportion.+reading order/is);
  assert.match(annotationPromptRules, /not as coordinate specifications/i);
  assert.match(annotationPromptRules, /Row, Column, or Grid flow structure/i);
  assert.match(annotationPromptRules, /misaligned or overlap/i);
  assert.match(annotationPromptRules, /tidying.+part of the editing task/i);
  assert.match(annotationPromptRules, /Absolute positioning is prohibited/i);
  assert.doesNotMatch(annotationPromptRules, /(?:use|prefer|reproduce with) absolute positioning/i);
  assert.match(annotationPromptRules, /@N reference.+annotation whose order is N/i);
});

test("the annotation envelope sorts both target kinds and copies defensively", () => {
  const annotations = [
    {
      id: "region-id", order: 2, target: { kind: "region" },
      rect: { x: 20, y: 30, w: 400, h: 200 },
    },
    {
      id: "element-id", order: 1, target: { kind: "element", weaveId: "heading", html: '<h1 data-weave-id="heading">Title</h1>', elementKind: "heading", textExcerpt: "Title" },
      rect: { x: 10, y: 15, w: 300, h: 80 }, label: "Two lines", intersects: ["heading"],
    },
  ];
  const envelope = annotationEnvelope(annotations);
  assert.deepEqual(envelope, [
    {
      id: "element-id", order: 1, target: { kind: "element", weaveId: "heading", elementKind: "heading", textExcerpt: "Title" },
      rect: { x: 10, y: 15, w: 300, h: 80 }, label: "Two lines", intersects: ["heading"],
    },
    {
      id: "region-id", order: 2, target: { kind: "region" },
      rect: { x: 20, y: 30, w: 400, h: 200 }, label: "", intersects: [],
    },
  ]);
  assert.equal("html" in envelope[1].target, false);

  envelope[0].target.weaveId = "changed";
  envelope[0].target.textExcerpt = "changed";
  envelope[0].rect.x = 999;
  envelope[0].intersects.push("changed");
  assert.deepEqual(annotations[1], {
    id: "element-id", order: 1, target: { kind: "element", weaveId: "heading", html: '<h1 data-weave-id="heading">Title</h1>', elementKind: "heading", textExcerpt: "Title" },
    rect: { x: 10, y: 15, w: 300, h: 80 }, label: "Two lines", intersects: ["heading"],
  });
});

test("reference tokens resolve known orders and ignore email-like text", () => {
  const annotations = [{ id: "one", order: 1 }, { id: "twelve", order: 12 }];
  assert.equal(referenceToken(annotations[1]), "@12");
  assert.deepEqual(referencedOrders("a@1"), []);
  assert.deepEqual(referencedOrders("Use @12, @3, and @1 twice: @1. Ignore a@1."), [1, 3, 12]);
  assert.deepEqual(resolveReferences("Use @12, unknown @3, then @1 and a@1", annotations), [
    { order: 1, id: "one" },
    { order: 12, id: "twelve" },
  ]);
});

test("references insert after a typed at sign at the caret", () => {
  assert.deepEqual(insertReferenceAt("Make @ larger", 6, 2, { afterAtSign: true }), { text: "Make @2 larger", caret: 7 });
  assert.deepEqual(insertReferenceAt("@", 1, 1, { afterAtSign: true }), { text: "@1", caret: 2 });
});

test("typed references insert in the middle and at the end without moving surrounding text", () => {
  assert.deepEqual(insertReferenceAt("Compare @ with this", 9, 12, { afterAtSign: true }), { text: "Compare @12 with this", caret: 11 });
  assert.deepEqual(insertReferenceAt("Use @", 5, 3, { afterAtSign: true }), { text: "Use @3", caret: 6 });
});

test("button-style references work in empty drafts and add only necessary spacing", () => {
  assert.deepEqual(insertReferenceAt("", 0, 1, { afterAtSign: false }), { text: "@1", caret: 2 });
  assert.deepEqual(insertReferenceAt("Make this smaller", 9, 4, { afterAtSign: false }), { text: "Make this @4 smaller", caret: 12 });
});

test("pointer tabs normalize whitespace and truncate only the excerpt", () => {
  assert.equal(pointerTabText("heading", "  Quarterly\n priorities  "), "heading · Quarterly priorities");
  assert.equal(pointerTabText("paragraph", "abcdefghijklmnopqrstuvwxyz", 10), "paragraph · abcdefghi…");
  assert.equal(pointerTabText("image", ""), "image");
});
