import assert from "node:assert/strict";
import test from "node:test";

import {
  annotationEnvelope,
  clampRect,
  intersectingIds,
  rectFromPoints,
  rectsIntersect,
  referencedOrders,
  referenceToken,
  resolveReferences,
  toClientPoint,
  toSlidePoint,
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

test("rectangles normalize reversed drags and clamp to the slide", () => {
  assert.deepEqual(rectFromPoints({ x: 420.04, y: 310.06 }, { x: 120.02, y: 90.03 }), { x: 120, y: 90, w: 300, h: 220 });
  assert.deepEqual(rectFromPoints({ x: 120, y: 80 }, { x: 1400, y: 900 }), { x: 120, y: 80, w: 1160, h: 640 });
  assert.deepEqual(clampRect({ x: -50, y: -25, w: 200, h: 100 }), { x: 0, y: 0, w: 150, h: 75 });
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

test("the annotation envelope sorts both target kinds and copies defensively", () => {
  const annotations = [
    {
      id: "region-id", order: 2, target: { kind: "region" },
      rect: { x: 20, y: 30, w: 400, h: 200 },
    },
    {
      id: "element-id", order: 1, target: { kind: "element", weaveId: "heading" },
      rect: { x: 10, y: 15, w: 300, h: 80 }, label: "Two lines", intersects: ["heading"],
    },
  ];
  const envelope = annotationEnvelope(annotations);
  assert.deepEqual(envelope, [
    {
      id: "element-id", order: 1, target: { kind: "element", weaveId: "heading" },
      rect: { x: 10, y: 15, w: 300, h: 80 }, label: "Two lines", intersects: ["heading"],
    },
    {
      id: "region-id", order: 2, target: { kind: "region" },
      rect: { x: 20, y: 30, w: 400, h: 200 }, label: "", intersects: [],
    },
  ]);

  envelope[0].target.weaveId = "changed";
  envelope[0].rect.x = 999;
  envelope[0].intersects.push("changed");
  assert.deepEqual(annotations[1], {
    id: "element-id", order: 1, target: { kind: "element", weaveId: "heading" },
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
