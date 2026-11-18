import assert from "node:assert/strict";
import test from "node:test";

import {
  KEYBOARD_RESIZE_STEP_PX,
  MIN_BLOCK_RESIZE_PX,
  aspectRatioForResize,
  keyboardResizeBlock,
  resizeBlock,
  scaledResizeSize,
} from "../shared/block-resize.mjs";

const base = {
  origin: { width: 120, height: 80 },
  scale: 0.5,
  minSize: MIN_BLOCK_RESIZE_PX,
  maxSize: { width: 400, height: 300 },
  tagName: "div",
  aspectRatio: null,
  shiftKey: false,
};

test("east and south pointer deltas are converted from screen pixels and bounded by the parent", () => {
  assert.deepEqual(resizeBlock({ ...base, handle: "e", screenDelta: { x: 30, y: 900 } }), { width: 180, height: 80 });
  assert.deepEqual(resizeBlock({ ...base, handle: "s", screenDelta: { x: 900, y: 110 } }), { width: 120, height: 300 });
  assert.deepEqual(resizeBlock({ ...base, handle: "e", screenDelta: { x: -100, y: 0 } }), { width: 24, height: 80 });
});

test("southeast can resize each axis independently while respecting both maxima", () => {
  assert.deepEqual(resizeBlock({ ...base, handle: "se", screenDelta: { x: 50, y: 25 } }), { width: 220, height: 130 });
  assert.deepEqual(resizeBlock({ ...base, handle: "se", screenDelta: { x: 10_000, y: 10_000 } }), { width: 400, height: 300 });
});

test("Shift on a generic corner keeps the block's current aspect ratio", () => {
  assert.deepEqual(resizeBlock({ ...base, handle: "se", screenDelta: { x: 30, y: 0 }, shiftKey: true }), { width: 180, height: 120 });
  assert.deepEqual(resizeBlock({ ...base, handle: "se", screenDelta: { x: 0, y: 30 }, shiftKey: true }), { width: 210, height: 140 });
});

test("images and SVG roots keep their current ratio on a corner without Shift", () => {
  assert.equal(aspectRatioForResize({ tagName: "img", width: 160, height: 90, aspectRatio: null }), 16 / 9);
  assert.equal(aspectRatioForResize({ tagName: "svg", width: 100, height: 100, aspectRatio: null }), 1);
  assert.deepEqual(resizeBlock({ ...base, origin: { width: 160, height: 90 }, tagName: "img", handle: "se", screenDelta: { x: 40, y: 0 } }), { width: 240, height: 135 });
  assert.deepEqual(resizeBlock({ ...base, origin: { width: 160, height: 90 }, tagName: "svg", handle: "se", screenDelta: { x: 0, y: 30 } }), { width: 266.66666666666663, height: 150 });
});

test("aspect constrained dimensions fit the narrowest parent bound", () => {
  assert.deepEqual(resizeBlock({ ...base, origin: { width: 100, height: 50 }, handle: "se", screenDelta: { x: 200, y: 0 }, shiftKey: true, maxSize: { width: 160, height: 60 } }), { width: 120, height: 60 });
});

test("keyboard arrows use logical one pixel steps and ignore the other axis", () => {
  const common = { ...base, step: KEYBOARD_RESIZE_STEP_PX };
  assert.deepEqual(keyboardResizeBlock({ ...common, handle: "e", key: "ArrowRight" }), { width: 121, height: 80 });
  assert.equal(keyboardResizeBlock({ ...common, handle: "e", key: "ArrowDown" }), null);
  assert.deepEqual(keyboardResizeBlock({ ...common, handle: "s", key: "ArrowUp" }), { width: 120, height: 79 });
  assert.deepEqual(keyboardResizeBlock({ ...common, handle: "se", key: "ArrowRight", shiftKey: true }), { width: 121, height: 80.66666666666667 });
});

test("minimum policy and scaled overlay geometry are explicit", () => {
  assert.throws(() => resizeBlock({ ...base, handle: "e", minSize: 20, screenDelta: { x: 0, y: 0 } }), /at least 24/);
  assert.throws(() => resizeBlock({ ...base, handle: "e", maxSize: { width: 20, height: 80 }, screenDelta: { x: 0, y: 0 } }), /at least minSize/);
  assert.deepEqual(scaledResizeSize({ size: { width: 200, height: 100 }, scale: 0.5 }), { width: 100, height: 50 });
});
