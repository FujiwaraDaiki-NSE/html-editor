import assert from "node:assert/strict";
import test from "node:test";

import {
  DROP_EDGE_PX,
  resolveBlockDropIntent,
} from "../shared/block-placement.mjs";

const rect = (left, top, right, bottom) => ({ left, top, right, bottom });
const block = (id, parentId, box, layout, container = false, locked = false) => ({
  id,
  parentId,
  rect: rect(...box),
  layout,
  container,
  locked,
});
const root = (layout = "column", id = null, box = [0, 0, 800, 600]) => ({
  id,
  rect: rect(...box),
  layout,
  container: true,
  locked: false,
});
const resolve = ({ candidates, pointer, draggedId = "dragged", rootDescriptor = root() }) => resolveBlockDropIntent({
  candidates,
  pointer,
  draggedId,
  root: rootDescriptor,
});

test("inserts before or after a sibling on the parent's screen-space axis", () => {
  const candidates = [
    block("first", null, [100, 40, 700, 120], "column"),
    block("second", null, [100, 160, 700, 240], "column"),
  ];

  const before = resolve({ candidates, pointer: { x: 300, y: 180 } });
  assert.equal(before?.kind, "insert");
  assert.equal(before?.targetId, "second");
  assert.equal(before?.placement, "before");
  assert.equal(before?.axis, "y");
  assert.deepEqual(before?.preview.rect, { left: 100, top: 159, right: 700, bottom: 161 });

  const after = resolve({ candidates, pointer: { x: 300, y: 225 } });
  assert.equal(after?.targetId, "second");
  assert.equal(after?.placement, "after");
  assert.equal(after?.axis, "y");
});

test("chooses the deepest empty nested container for an inside intent", () => {
  const candidates = [
    block("outer", null, [80, 40, 720, 560], "column", true),
    block("empty-row", "outer", [300, 220, 600, 380], "row", true),
  ];

  const intent = resolve({ candidates, pointer: { x: 450, y: 300 } });
  assert.equal(intent?.kind, "inside");
  assert.equal(intent?.targetId, "empty-row");
  assert.equal(intent?.placement, "inside");
  assert.equal(intent?.axis, "x");
  assert.deepEqual(intent?.preview.anchor, rect(300, 220, 600, 380));
});

test("uses the whitespace of a non-empty nested container for an inside intent", () => {
  const candidates = [
    block("outer", null, [80, 40, 720, 560], "column", true),
    block("nested", "outer", [300, 180, 600, 420], "row", true),
    block("nested-child", "nested", [320, 200, 580, 260], "row"),
  ];

  const intent = resolve({ candidates, pointer: { x: 450, y: 340 } });
  assert.equal(intent?.kind, "inside");
  assert.equal(intent?.targetId, "nested");
  assert.equal(intent?.placement, "inside");
  assert.equal(intent?.axis, "x");
});

test("uses a left or right edge of a leaf in a column to request a wrapped row", () => {
  const candidates = [block("leaf", null, [100, 160, 500, 260], "column")];

  const left = resolve({ candidates, pointer: { x: 100 + DROP_EDGE_PX - 1, y: 210 } });
  assert.equal(left?.kind, "wrap");
  assert.equal(left?.targetId, "leaf");
  assert.equal(left?.placement, "before");
  assert.equal(left?.axis, "x");
  assert.equal(left?.preview.kind, "wrap-row");

  const right = resolve({ candidates, pointer: { x: 500 - DROP_EDGE_PX + 1, y: 210 } });
  assert.equal(right?.kind, "wrap");
  assert.equal(right?.targetId, "leaf");
  assert.equal(right?.placement, "after");
});

test("resolves root whitespace to the nearest root child", () => {
  const candidates = [
    block("top", null, [100, 80, 700, 160], "column"),
    block("bottom", null, [100, 360, 700, 440], "column"),
  ];

  const intent = resolve({ candidates, pointer: { x: 760, y: 500 } });
  assert.equal(intent?.kind, "insert");
  assert.equal(intent?.targetId, "bottom");
  assert.equal(intent?.placement, "after");
  assert.equal(intent?.parentId, null);
  assert.equal(intent?.axis, "y");
});

test("uses the grid cell's nearest edge to choose a deterministic axis", () => {
  const candidates = [
    block("grid", null, [100, 80, 700, 440], "grid", true),
    block("cell-a", "grid", [120, 100, 380, 240], "grid"),
    block("cell-b", "grid", [420, 100, 680, 240], "grid"),
    block("cell-c", "grid", [120, 280, 380, 420], "grid"),
  ];

  const horizontal = resolve({ candidates, pointer: { x: 340, y: 170 } });
  assert.equal(horizontal?.targetId, "cell-a");
  assert.equal(horizontal?.axis, "x");
  assert.equal(horizontal?.placement, "after");

  const vertical = resolve({ candidates, pointer: { x: 250, y: 260 } });
  assert.equal(vertical?.targetId, "cell-a");
  assert.equal(vertical?.axis, "y");
  assert.equal(vertical?.placement, "after");
});

test("skips locked title and the dragged subtree, without changing the snapshot", () => {
  const candidates = [
    block("dragged", null, [100, 70, 700, 520], "column", true),
    block("descendant", "dragged", [200, 180, 600, 300], "column"),
    block("title", null, [100, 40, 700, 68], "column", false, true),
    block("other", null, [100, 540, 700, 580], "column"),
  ];
  const snapshot = structuredClone(candidates);

  const titleArea = resolve({ candidates, pointer: { x: 300, y: 54 } });
  assert.equal(titleArea, null, "a locked title is an occupied, invalid drop region");

  const draggedArea = resolve({ candidates, pointer: { x: 300, y: 230 } });
  assert.equal(draggedArea, null, "the dragged subtree is an occupied, invalid drop region");
  assert.deepEqual(candidates, snapshot);
});

test("is independent of editor zoom because thresholds use screen pixels", () => {
  const candidates = [block("leaf", null, [300, 180, 700, 280], "column")];
  const screenPoint = { x: 300 + DROP_EDGE_PX - 1, y: 230 };
  const intent = resolve({ candidates, pointer: screenPoint });
  assert.equal(intent?.kind, "wrap");
  assert.equal(intent?.placement, "before");
});

test("returns null outside the declared root geometry", () => {
  const candidates = [block("leaf", null, [300, 180, 700, 280], "column")];
  assert.equal(resolve({ candidates, pointer: { x: 801, y: 300 } }), null);
});

