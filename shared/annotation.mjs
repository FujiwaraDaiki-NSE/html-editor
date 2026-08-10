import { designHeight, designWidth } from "./slide-design.mjs";

export const toSlidePoint = (point, viewport, scale, scroll) => ({
  x: (point.clientX - viewport.left + scroll.left) / scale,
  y: (point.clientY - viewport.top + scroll.top) / scale,
});

export const toClientPoint = (point, viewport, scale, scroll) => ({
  clientX: viewport.left + point.x * scale - scroll.left,
  clientY: viewport.top + point.y * scale - scroll.top,
});

const round = (value) => Math.round(value * 10) / 10;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const minimumRectSize = 8;

export function clampRect(rect) {
  const left = clamp(Math.min(rect.x, rect.x + rect.w), 0, designWidth);
  const right = clamp(Math.max(rect.x, rect.x + rect.w), 0, designWidth);
  const top = clamp(Math.min(rect.y, rect.y + rect.h), 0, designHeight);
  const bottom = clamp(Math.max(rect.y, rect.y + rect.h), 0, designHeight);
  return { x: round(left), y: round(top), w: round(right - left), h: round(bottom - top) };
}

export const rectFromPoints = (a, b) => clampRect({ x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y });

export const rectFromClientBox = (box, viewport, scale, scroll) => rectFromPoints(
  toSlidePoint({ clientX: box.left, clientY: box.top }, viewport, scale, scroll),
  toSlidePoint({ clientX: box.left + box.width, clientY: box.top + box.height }, viewport, scale, scroll),
);

export const nextOrder = (annotations) => Math.max(0, ...annotations.map(({ order }) => order)) + 1;

export function translateRect(rect, dx, dy) {
  return {
    x: round(clamp(rect.x + dx, 0, Math.max(0, designWidth - rect.w))),
    y: round(clamp(rect.y + dy, 0, Math.max(0, designHeight - rect.h))),
    w: rect.w,
    h: rect.h,
  };
}

const resizedCoordinate = (moving, opposite, original, limit) => {
  const bounded = clamp(moving, 0, limit);
  if (Math.abs(bounded - opposite) >= minimumRectSize) return bounded;
  const direction = bounded === opposite
    ? (original < opposite ? -1 : 1)
    : (bounded < opposite ? -1 : 1);
  const preferred = opposite + direction * minimumRectSize;
  return preferred >= 0 && preferred <= limit
    ? preferred
    : opposite - direction * minimumRectSize;
};

export function resizeRect(rect, handle, point) {
  const corners = {
    nw: { moving: { x: rect.x, y: rect.y }, opposite: { x: rect.x + rect.w, y: rect.y + rect.h } },
    ne: { moving: { x: rect.x + rect.w, y: rect.y }, opposite: { x: rect.x, y: rect.y + rect.h } },
    sw: { moving: { x: rect.x, y: rect.y + rect.h }, opposite: { x: rect.x + rect.w, y: rect.y } },
    se: { moving: { x: rect.x + rect.w, y: rect.y + rect.h }, opposite: { x: rect.x, y: rect.y } },
  };
  const corner = corners[handle];
  if (!corner) throw new TypeError(`Unknown resize handle: ${handle}`);
  const moving = {
    x: resizedCoordinate(point.x, corner.opposite.x, corner.moving.x, designWidth),
    y: resizedCoordinate(point.y, corner.opposite.y, corner.moving.y, designHeight),
  };
  return rectFromPoints(corner.opposite, moving);
}

export const rectsIntersect = (a, b) => (
  a.x < b.x + b.w && a.x + a.w > b.x
  && a.y < b.y + b.h && a.y + a.h > b.y
);

export const intersectingIds = (rect, boxes) => boxes.filter((box) => rectsIntersect(rect, box.rect)).map((box) => box.id);

export function refreshAnnotations(annotations, boxes) {
  const boxesById = new Map(boxes.map((box) => [box.id, box]));
  return annotations.map((annotation) => {
    const elementBox = annotation.target.kind === "element" ? boxesById.get(annotation.target.weaveId) : null;
    const sourceRect = elementBox?.rect ?? annotation.rect;
    const rect = { x: sourceRect.x, y: sourceRect.y, w: sourceRect.w, h: sourceRect.h };
    const target = annotation.target.kind === "element"
      ? {
          ...annotation.target,
          ...(typeof elementBox?.html === "string" ? { html: elementBox.html } : {}),
          ...(typeof elementBox?.elementKind === "string" ? { elementKind: elementBox.elementKind } : {}),
          ...(typeof elementBox?.textExcerpt === "string" ? { textExcerpt: elementBox.textExcerpt } : {}),
        }
      : annotation.target;
    return { ...annotation, target, rect, intersects: intersectingIds(rect, boxes) };
  });
}

export const canSendTurn = (text, annotations) => String(text ?? "").trim().length > 0 || annotations.length > 0;

export const annotationPromptRules = `Treat editor annotation rectangles as an approximation of proportion and reading order, not as coordinate specifications.
Build the result with Row, Column, or Grid flow structure using the project's existing utility classes. Absolute positioning is prohibited for interpreting annotations.
Regularize spacing and alignment yourself when annotation rectangles are misaligned or overlap; tidying them into a coherent composition is part of the editing task.
A @N reference in the request text refers to the annotation whose order is N.`;

export const annotationEnvelope = (annotations) => annotations
  .map((annotation) => ({
    id: annotation.id,
    order: annotation.order,
    target: annotation.target.kind === "element"
      ? { kind: "element", weaveId: annotation.target.weaveId, html: String(annotation.target.html ?? "") }
      : { kind: "region" },
    rect: { x: annotation.rect.x, y: annotation.rect.y, w: annotation.rect.w, h: annotation.rect.h },
    label: annotation.label ?? "",
    intersects: [...(annotation.intersects ?? [])],
  }))
  .sort((a, b) => a.order - b.order);

export const referenceToken = (annotation) => `@${annotation.order}`;

export function referencedOrders(text) {
  const orders = new Set();
  for (const match of text.matchAll(/@(\d+)/g)) {
    if (match.index > 0 && /\w/.test(text[match.index - 1])) continue;
    orders.add(Number(match[1]));
  }
  return [...orders].sort((a, b) => a - b);
}

export function resolveReferences(text, annotations) {
  const idsByOrder = new Map(annotations.map(({ order, id }) => [order, id]));
  return referencedOrders(text).flatMap((order) => idsByOrder.has(order) ? [{ order, id: idsByOrder.get(order) }] : []);
}
