/*
 * Screen-space drop intent resolution for the block canvas.
 *
 * The resolver only reads the geometry snapshot supplied by its caller. It
 * does not inspect or mutate the DOM, and it never scales a threshold by the
 * editor zoom. `rect` values are therefore expected to be in client/screen
 * pixels (the same coordinate space as `pointer`).
 *
 * `layout` on a container is the layout used by that container's direct
 * children. A leaf's `layout` value is accepted for a uniform descriptor shape
 * but its parent descriptor (or `root`) supplies the layout used to place it.
 * A root is a container descriptor with an explicit `id`; use `null` when the
 * root has no model id. `targetId` is that explicit root id for a root-inside
 * intent, including `null` when the caller chose an anonymous root.
 *
 * Required call shape:
 *
 *   resolveBlockDropIntent({
 *     candidates: BlockGeometry[],
 *     pointer: { x: number, y: number },
 *     draggedId: string,
 *     root: BlockRoot,
 *   })
 *
 * The caller may omit the dragged subtree from `candidates`; the resolver
 * still rejects a descriptor whose id is the dragged id or whose supplied
 * parent chain leads to it.
 */

export const DROP_EDGE_PX = 24;
export const DROP_CONTAINER_EDGE_PX = 18;
export const DROP_PREVIEW_THICKNESS_PX = 2;

/** @typedef {{left:number, top:number, right:number, bottom:number}} PlacementRect */
/** @typedef {{x:number, y:number}} PlacementPoint */
/* The public JS boundary is `string` so a caller whose DOM classifier has not
   narrowed its result yet can call the resolver; runtime validation below
   accepts only row, column, or grid. */
/** @typedef {{id:string, parentId:string|null, rect:PlacementRect, layout:string, container:boolean, locked:boolean}} BlockGeometry */
/** @typedef {{id:string|null, rect:PlacementRect, layout:string, container:true, locked:false}} BlockRoot */
/** @typedef {{kind:"line"|"inside", rect:PlacementRect, anchor:PlacementRect} | {kind:"wrap-row", rect:PlacementRect, anchor:PlacementRect, line:PlacementRect}} BlockDropPreview */
/** @typedef {{kind:"insert"|"inside"|"wrap", targetId:string|null, parentId:string|null, placement:"before"|"after"|"inside", axis:"x"|"y", preview:BlockDropPreview}} BlockDropIntent */

const layouts = new Set(["row", "column", "grid"]);

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isObject = (value) => value !== null && typeof value === "object";

const assertObject = (value, name) => {
  if (!isObject(value)) throw new TypeError(`${name} is required.`);
};

const assertString = (value, name) => {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} is required.`);
};

const assertBoolean = (value, name) => {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean.`);
};

const assertLayout = (value, name) => {
  if (!layouts.has(value)) throw new TypeError(`${name} must be row, column, or grid.`);
};

const rectFrom = (value, name) => {
  assertObject(value, name);
  for (const key of ["left", "top", "right", "bottom"]) {
    if (!isFiniteNumber(value[key])) throw new TypeError(`${name}.${key} must be a finite number.`);
  }
  if (value.right < value.left || value.bottom < value.top) throw new TypeError(`${name} must have non-negative dimensions.`);
  return Object.freeze({ left: value.left, top: value.top, right: value.right, bottom: value.bottom });
};

const pointFrom = (value) => {
  assertObject(value, "pointer");
  if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y)) throw new TypeError("pointer.x and pointer.y must be finite numbers.");
  return { x: value.x, y: value.y };
};

const geometryFrom = (value, name) => {
  assertObject(value, name);
  assertString(value.id, `${name}.id`);
  if (value.parentId !== null && typeof value.parentId !== "string") throw new TypeError(`${name}.parentId must be a string or null.`);
  const rect = rectFrom(value.rect, `${name}.rect`);
  assertLayout(value.layout, `${name}.layout`);
  assertBoolean(value.container, `${name}.container`);
  assertBoolean(value.locked, `${name}.locked`);
  return Object.freeze({
    id: value.id,
    parentId: value.parentId,
    rect,
    layout: value.layout,
    container: value.container,
    locked: value.locked,
  });
};

const rootFrom = (value) => {
  assertObject(value, "root");
  if (value.id !== null && typeof value.id !== "string") throw new TypeError("root.id must be a string or null.");
  const rect = rectFrom(value.rect, "root.rect");
  assertLayout(value.layout, "root.layout");
  if (value.container !== true) throw new TypeError("root.container must be true.");
  if (value.locked !== false) throw new TypeError("root.locked must be false.");
  return Object.freeze({ id: value.id, rect, layout: value.layout, container: true, locked: false });
};

const contains = (rect, point) => point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
const distanceToRectSquared = (rect, point) => {
  const dx = point.x < rect.left ? rect.left - point.x : point.x > rect.right ? point.x - rect.right : 0;
  const dy = point.y < rect.top ? rect.top - point.y : point.y > rect.bottom ? point.y - rect.bottom : 0;
  return dx * dx + dy * dy;
};
const distanceToVerticalEdge = (rect, point) => Math.min(Math.abs(point.x - rect.left), Math.abs(rect.right - point.x));
const distanceToHorizontalEdge = (rect, point) => Math.min(Math.abs(point.y - rect.top), Math.abs(rect.bottom - point.y));

const insetRect = (rect, amount) => ({
  left: rect.left + Math.min(amount, (rect.right - rect.left) / 2),
  top: rect.top + Math.min(amount, (rect.bottom - rect.top) / 2),
  right: rect.right - Math.min(amount, (rect.right - rect.left) / 2),
  bottom: rect.bottom - Math.min(amount, (rect.bottom - rect.top) / 2),
});

const linePreview = (rect, axis, placement) => {
  if (axis === "x") {
    const edge = placement === "before" ? rect.left : rect.right;
    const half = DROP_PREVIEW_THICKNESS_PX / 2;
    return { left: edge - half, top: rect.top, right: edge + half, bottom: rect.bottom };
  }
  const edge = placement === "before" ? rect.top : rect.bottom;
  const half = DROP_PREVIEW_THICKNESS_PX / 2;
  return { left: rect.left, top: edge - half, right: rect.right, bottom: edge + half };
};

const previewForInsert = (target, axis, placement) => Object.freeze({
  kind: "line",
  rect: Object.freeze(linePreview(target.rect, axis, placement)),
  anchor: target.rect,
});

const previewForInside = (target) => Object.freeze({
  kind: "inside",
  rect: Object.freeze(insetRect(target.rect, DROP_CONTAINER_EDGE_PX)),
  anchor: target.rect,
});

const previewForWrap = (target, placement) => Object.freeze({
  kind: "wrap-row",
  rect: target.rect,
  line: Object.freeze(linePreview(target.rect, "x", placement)),
  anchor: target.rect,
});

const axisForLayout = (layout) => layout === "column" ? "y" : "x";

/* Grid placement follows the nearest visible edge. A point inside a cell has
   an x axis tie-break, matching the natural left-to-right DOM order; a point
   outside the cell chooses whichever edge it is nearest to. */
const gridAxis = (rect, point) => {
  const insideX = point.x >= rect.left && point.x <= rect.right;
  const insideY = point.y >= rect.top && point.y <= rect.bottom;
  if (insideX && insideY) return "x";
  if (insideY) return "x";
  if (insideX) return "y";
  return distanceToVerticalEdge(rect, point) <= distanceToHorizontalEdge(rect, point) ? "x" : "y";
};

const axisForParent = (parent, root, target, point) => {
  const layout = parent ? parent.layout : root.layout;
  return layout === "grid" ? gridAxis(target.rect, point) : axisForLayout(layout);
};

const siblingPlacement = (target, axis, point) => {
  const coordinate = axis === "x" ? point.x : point.y;
  const start = axis === "x" ? target.rect.left : target.rect.top;
  const end = axis === "x" ? target.rect.right : target.rect.bottom;
  return coordinate <= start + (end - start) / 2 ? "before" : "after";
};

const compareStable = (a, b, point) => {
  const distance = distanceToRectSquared(a.rect, point) - distanceToRectSquared(b.rect, point);
  if (distance !== 0) return distance;
  const area = (a.rect.right - a.rect.left) * (a.rect.bottom - a.rect.top)
    - (b.rect.right - b.rect.left) * (b.rect.bottom - b.rect.top);
  if (area !== 0) return area;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

const isInDraggedSubtree = (candidate, byId, draggedId) => {
  if (candidate.id === draggedId) return true;
  const visited = new Set();
  let parentId = candidate.parentId;
  while (parentId !== null && !visited.has(parentId)) {
    if (parentId === draggedId) return true;
    visited.add(parentId);
    parentId = byId.get(parentId)?.parentId ?? null;
  }
  return false;
};

const directChildren = (parentId, candidates) => candidates.filter((candidate) => candidate.parentId === parentId);

const nearestDirectChild = (parentId, candidates, point) => {
  const children = directChildren(parentId, candidates);
  if (children.length === 0) return null;
  return [...children].sort((a, b) => compareStable(a, b, point))[0];
};

const deepestContaining = (candidates, point) => {
  const hits = candidates.filter((candidate) => contains(candidate.rect, point));
  if (hits.length === 0) return null;
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const depth = (candidate) => {
    let value = 0;
    let parentId = candidate.parentId;
    const visited = new Set();
    while (parentId !== null && !visited.has(parentId)) {
      const parent = byId.get(parentId);
      if (!parent) break;
      value += 1;
      visited.add(parentId);
      parentId = parent.parentId;
    }
    return value;
  };
  return [...hits].sort((a, b) => {
    const depthDifference = depth(b) - depth(a);
    if (depthDifference !== 0) return depthDifference;
    const area = (a.rect.right - a.rect.left) * (a.rect.bottom - a.rect.top)
      - (b.rect.right - b.rect.left) * (b.rect.bottom - b.rect.top);
    if (area !== 0) return area;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
};

const intentForSibling = (target, parent, root, point) => {
  const axis = axisForParent(parent, root, target, point);
  const placement = siblingPlacement(target, axis, point);
  return Object.freeze({
    kind: "insert",
    targetId: target.id,
    parentId: parent?.id ?? root.id,
    placement,
    axis,
    preview: previewForInsert(target, axis, placement),
  });
};

const intentForInside = (target, root) => Object.freeze({
  kind: "inside",
  targetId: target.id,
  parentId: target.id ?? root.id,
  placement: "inside",
  axis: axisForLayout(target.layout),
  preview: previewForInside(target),
});

const intentForWrap = (target, parent, root, placement) => Object.freeze({
  kind: "wrap",
  targetId: target.id,
  parentId: parent?.id ?? root.id,
  placement,
  axis: "x",
  preview: previewForWrap(target, placement),
});

const resolveTarget = ({ target, candidates, root, byId, point }) => {
  if (target?.container) {
    const children = directChildren(target.id, candidates);
    if (target.layout === "grid" && children.length > 0) {
      /* Grid gaps belong to the nearest cell: the same DOM-order insertion
         line can represent either a column edge or a row edge. */
      const nearest = nearestDirectChild(target.id, candidates, point);
      if (nearest) return intentForSibling(nearest, target, root, point);
    }
    if (target.id !== root.id) {
      /* A nested container's padding and gaps are an explicit inside affordance.
         Its children are chosen earlier by deepestContaining when the pointer
         is actually over a child, so this branch is reached only for the
         container's own whitespace (including an empty container). */
      const parent = target.parentId === root.id ? root : byId.get(target.parentId);
      const axis = axisForParent(parent === root ? null : parent, root, target, point);
      const coordinate = axis === "x" ? point.x : point.y;
      const start = axis === "x" ? target.rect.left : target.rect.top;
      const end = axis === "x" ? target.rect.right : target.rect.bottom;
      if (coordinate - start <= DROP_CONTAINER_EDGE_PX) return intentForSibling(target, parent === root ? null : parent, root, point);
      if (end - coordinate <= DROP_CONTAINER_EDGE_PX) return intentForSibling(target, parent === root ? null : parent, root, point);
      return intentForInside(target, root);
    }
    if (children.length === 0) return intentForInside(target, root);
    const nearest = nearestDirectChild(target.id, candidates, point);
    if (!nearest) return intentForInside(target, root);
    return intentForSibling(nearest, target, root, point);
  }
  if (!target) return null;
  const parent = target.parentId === root.id ? root : byId.get(target.parentId);
  if (!parent && target.parentId !== null) return null;
  if (parent?.locked) return null;
  if (parent?.layout === "column"
    && !target.container
    && target.rect.right - target.rect.left >= DROP_EDGE_PX * 2) {
    const leftDistance = Math.abs(point.x - target.rect.left);
    const rightDistance = Math.abs(target.rect.right - point.x);
    const nearLeft = leftDistance <= DROP_EDGE_PX;
    const nearRight = rightDistance <= DROP_EDGE_PX;
    if (nearLeft || nearRight) {
      const placement = leftDistance <= rightDistance ? "before" : "after";
      return intentForWrap(target, parent === root ? null : parent, root, placement);
    }
  }
  return intentForSibling(target, parent === root ? null : parent, root, point);
};

/**
 * Resolve one deterministic, screen-space placement intent.
 *
 * @param {{candidates:BlockGeometry[], pointer:PlacementPoint, draggedId:string, root:BlockRoot}} params
 * @param {BlockGeometry[]} params.candidates BlockGeometry descriptors.
 * @param {PlacementPoint} params.pointer Pointer in the same screen-pixel space as every rect.
 * @param {string} params.draggedId Id of the block being moved.
 * @param {BlockRoot} params.root Root geometry.
 * @returns {BlockDropIntent|null}
 */
export function resolveBlockDropIntent(params) {
  assertObject(params, "params");
  if (!Array.isArray(params.candidates)) throw new TypeError("candidates is required and must be an array.");
  assertString(params.draggedId, "draggedId");
  const point = pointFrom(params.pointer);
  const root = rootFrom(params.root);
  const rawCandidates = params.candidates.map((candidate, index) => ({ ...geometryFrom(candidate, `candidates[${index}]`), sourceIndex: index }));
  const byId = new Map();
  for (const candidate of rawCandidates) {
    if (byId.has(candidate.id)) throw new TypeError(`duplicate candidate id: ${candidate.id}`);
    byId.set(candidate.id, candidate);
  }
  if (!contains(root.rect, point)) return null;
  const blocked = rawCandidates.filter((candidate) => candidate.locked || isInDraggedSubtree(candidate, byId, params.draggedId));
  /* A locked block and the dragged subtree are occupied regions, rather than
     root whitespace. Returning null here prevents a pointer over a title or
     over the block being moved from falling through to a distant sibling. */
  if (blocked.some((candidate) => contains(candidate.rect, point))) return null;
  const usable = rawCandidates.filter((candidate) => !candidate.locked && !isInDraggedSubtree(candidate, byId, params.draggedId));

  const hit = deepestContaining(usable, point);
  if (hit) return resolveTarget({ target: hit, candidates: usable, root, byId, point });

  const rootId = root.id;
  const nearest = nearestDirectChild(rootId, usable, point);
  if (nearest) return intentForSibling(nearest, null, root, point);
  return Object.freeze({
    kind: "inside",
    targetId: root.id,
    parentId: root.id,
    placement: "inside",
    axis: axisForLayout(root.layout),
    preview: Object.freeze({ kind: "inside", rect: Object.freeze(insetRect(root.rect, DROP_CONTAINER_EDGE_PX)), anchor: root.rect }),
  });
}

