/**
 * The smallest useful model for resizing a live slide block.
 *
 * The editor renders a slide at a scale, so pointer deltas arrive in screen
 * pixels while block dimensions are expressed in the slide's coordinate
 * system.  Keeping the conversion and the bounds in this module means the
 * React chrome and the persistence layer can share the exact same rules.
 */

export const MIN_BLOCK_RESIZE_PX = 24;
export const KEYBOARD_RESIZE_STEP_PX = 1;
export const BLOCK_RESIZE_HANDLES = Object.freeze(["e", "s", "se"]);

const imageTags = new Set(["img", "svg"]);
const horizontalKeys = new Set(["ArrowLeft", "ArrowRight"]);
const verticalKeys = new Set(["ArrowUp", "ArrowDown"]);

const finitePositive = (value, name) => {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive finite number.`);
  return value;
};

const assertHandle = (handle) => {
  if (!BLOCK_RESIZE_HANDLES.includes(handle)) throw new TypeError(`Unknown resize handle: ${handle}.`);
};

const assertSize = (size, name) => {
  if (!size || typeof size !== "object") throw new TypeError(`${name} is required.`);
  finitePositive(size.width, `${name}.width`);
  finitePositive(size.height, `${name}.height`);
};

const assertBounds = (bounds) => {
  assertSize(bounds, "maxSize");
};

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

const normalizeTagName = (tagName) => {
  if (typeof tagName !== "string" || tagName.length === 0) throw new TypeError("tagName is required.");
  return tagName.toLowerCase();
};

/**
 * Resolve the ratio used by a corner resize.
 *
 * An explicitly supplied ratio wins. Images and SVG roots keep their current
 * rendered ratio when no ratio was supplied. Other elements return null so a
 * corner stays free-form unless Shift is held during the gesture.
 */
export function aspectRatioForResize({ tagName, width, height, aspectRatio }) {
  const tag = normalizeTagName(tagName);
  finitePositive(width, "width");
  finitePositive(height, "height");
  if (aspectRatio !== null && (!Number.isFinite(aspectRatio) || aspectRatio <= 0)) {
    throw new TypeError("aspectRatio must be null or a positive finite number.");
  }
  return aspectRatio ?? (imageTags.has(tag) ? width / height : null);
}

const aspectConstrainedSize = ({ origin, requestedWidth, requestedHeight, ratio, minSize, maxSize }) => {
  // Width is the scalar used for the ratio pair. These limits satisfy both
  // axis minima and both parent bounds at the same time.
  const minimumWidth = Math.max(minSize, minSize * ratio);
  const maximumWidth = Math.min(maxSize.width, maxSize.height * ratio);
  if (maximumWidth < minimumWidth) {
    throw new RangeError("maxSize cannot contain the requested minimum aspect-constrained size.");
  }

  // Follow the axis that received the larger visual movement. Comparing the
  // movement after conversion to width keeps the decision stable for a wide
  // and a tall ratio alike.
  const widthDriven = Math.abs(requestedWidth - origin.width) >= Math.abs(requestedHeight - origin.height) * ratio;
  const requested = widthDriven ? requestedWidth : requestedHeight * ratio;
  const width = clamp(requested, minimumWidth, maximumWidth);
  return { width, height: width / ratio };
};

/**
 * Calculate the preview size for a pointer gesture.
 *
 * `screenDelta` is measured in CSS pixels. `scale` converts it to the block's
 * coordinate system. `maxSize` is deliberately required: callers must pass
 * the available size in the selected block's parent rather than relying on
 * an implicit slide or viewport bound.
 */
export function resizeBlock({ handle, origin, screenDelta, scale, minSize, maxSize, tagName, aspectRatio, shiftKey }) {
  assertHandle(handle);
  assertSize(origin, "origin");
  if (!screenDelta || typeof screenDelta !== "object") throw new TypeError("screenDelta is required.");
  if (!Number.isFinite(screenDelta.x) || !Number.isFinite(screenDelta.y)) throw new TypeError("screenDelta must contain finite x and y values.");
  finitePositive(scale, "scale");
  finitePositive(minSize, "minSize");
  if (minSize < MIN_BLOCK_RESIZE_PX) throw new RangeError(`minSize must be at least ${MIN_BLOCK_RESIZE_PX}px.`);
  assertBounds(maxSize);
  if (maxSize.width < minSize || maxSize.height < minSize) throw new RangeError("maxSize must be at least minSize on both axes.");
  if (typeof shiftKey !== "boolean") throw new TypeError("shiftKey must be boolean.");

  const deltaX = screenDelta.x / scale;
  const deltaY = screenDelta.y / scale;
  const requestedWidth = handle === "s" ? origin.width : origin.width + deltaX;
  const requestedHeight = handle === "e" ? origin.height : origin.height + deltaY;
  const freeSize = {
    width: handle === "s" ? origin.width : clamp(requestedWidth, minSize, maxSize.width),
    height: handle === "e" ? origin.height : clamp(requestedHeight, minSize, maxSize.height),
  };

  if (handle !== "se") return freeSize;

  const normalizedTagName = normalizeTagName(tagName);
  const resolvedRatio = aspectRatioForResize({ tagName: normalizedTagName, width: origin.width, height: origin.height, aspectRatio });
  const shouldConstrain = shiftKey || imageTags.has(normalizedTagName);
  const ratio = resolvedRatio ?? (shouldConstrain ? origin.width / origin.height : null);
  if (!shouldConstrain || ratio === null) return freeSize;
  return aspectConstrainedSize({ origin, requestedWidth, requestedHeight, ratio, minSize, maxSize });
}

/**
 * Calculate one keyboard step. Unsupported arrows return null so a handle can
 * leave browser focus navigation alone when the key is for another axis.
 */
export function keyboardResizeBlock({ handle, origin, key, scale, step, minSize, maxSize, tagName, aspectRatio, shiftKey }) {
  assertHandle(handle);
  if (typeof key !== "string") throw new TypeError("key is required.");
  finitePositive(scale, "scale");
  finitePositive(step, "step");
  const horizontal = horizontalKeys.has(key);
  const vertical = verticalKeys.has(key);
  if ((handle === "e" && !horizontal) || (handle === "s" && !vertical) || (handle === "se" && !horizontal && !vertical)) return null;
  const direction = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;
  const screenDelta = {
    x: horizontal ? direction * step * scale : 0,
    y: vertical ? direction * step * scale : 0,
  };
  return resizeBlock({ handle, origin, screenDelta, scale, minSize, maxSize, tagName, aspectRatio, shiftKey });
}

/**
 * Return the size that should be painted by the overlay. Keeping this tiny
 * helper pure makes it clear that the overlay never mutates the live block.
 */
export function scaledResizeSize({ size, scale }) {
  assertSize(size, "size");
  finitePositive(scale, "scale");
  return { width: size.width * scale, height: size.height * scale };
}
