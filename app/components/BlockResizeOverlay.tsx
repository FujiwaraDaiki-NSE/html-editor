"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  BLOCK_RESIZE_HANDLES,
  KEYBOARD_RESIZE_STEP_PX,
  MIN_BLOCK_RESIZE_PX,
  aspectRatioForResize,
  keyboardResizeBlock,
  resizeBlock,
  scaledResizeSize,
} from "../../shared/block-resize.mjs";

export type BlockResizeHandle = "e" | "s" | "se";
export type BlockResizeSize = { width: number; height: number };
export type BlockResizeRect = { left: number; top: number; width: number; height: number };
export type BlockResizeBounds = BlockResizeSize;
export type BlockResizeNode = {
  width: number;
  height: number;
  tagName: string;
  aspectRatio: number | null;
};
export type BlockResizeSource = "pointer" | "keyboard";

export type BlockResizeStart = {
  handle: BlockResizeHandle;
  origin: BlockResizeSize;
  source: BlockResizeSource;
  pointerId: number | null;
};
export type BlockResizePreview = {
  handle: BlockResizeHandle;
  size: BlockResizeSize;
  source: BlockResizeSource;
  shiftKey: boolean;
};
export type BlockResizeCommit = BlockResizePreview;
export type BlockResizeCancel = {
  handle: BlockResizeHandle;
  origin: BlockResizeSize;
  source: BlockResizeSource;
  pointerId: number | null;
};

export type BlockResizeOverlayProps = {
  rect: BlockResizeRect;
  scale: number;
  activeNode: BlockResizeNode;
  maxSize: BlockResizeBounds;
  minSize: number;
  previewSize: BlockResizeSize | null;
  onStart: (payload: BlockResizeStart) => void;
  onPreview: (payload: BlockResizePreview) => void;
  onCommit: (payload: BlockResizeCommit) => void;
  onCancel: (payload: BlockResizeCancel) => void;
};

type PointerGesture = {
  handle: BlockResizeHandle;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  origin: BlockResizeSize;
  scale: number;
  minSize: number;
  maxSize: BlockResizeBounds;
  tagName: string;
  aspectRatio: number | null;
  target: HTMLButtonElement;
};

const handleLabels: Record<BlockResizeHandle, string> = {
  e: "右端",
  s: "下端",
  se: "右下隅",
};
const handleNames: Record<BlockResizeHandle, string> = {
  e: "east",
  s: "south",
  se: "southeast",
};
const resizeHandles = BLOCK_RESIZE_HANDLES as BlockResizeHandle[];

const copySize = (size: BlockResizeSize): BlockResizeSize => ({ width: size.width, height: size.height });

const pointerDelta = (gesture: PointerGesture, event: ReactPointerEvent<HTMLButtonElement>) => ({
  x: event.clientX - gesture.startClientX,
  y: event.clientY - gesture.startClientY,
});

export function BlockResizeOverlay({
  rect,
  scale,
  activeNode,
  maxSize,
  minSize,
  previewSize,
  onStart,
  onPreview,
  onCommit,
  onCancel,
}: BlockResizeOverlayProps) {
  const gestureRef = useRef<PointerGesture | null>(null);
  const [activeHandle, setActiveHandle] = useState<BlockResizeHandle | null>(null);

  const cancelGesture = useCallback(() => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (gesture.target.hasPointerCapture(gesture.pointerId)) gesture.target.releasePointerCapture(gesture.pointerId);
    gestureRef.current = null;
    setActiveHandle(null);
    onCancel({
      handle: gesture.handle,
      origin: copySize(gesture.origin),
      source: "pointer",
      pointerId: gesture.pointerId,
    });
  }, [onCancel]);

  useEffect(() => {
    if (activeHandle === null) return;
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelGesture();
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [activeHandle, cancelGesture]);

  const startPointerGesture = (handle: BlockResizeHandle, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || gestureRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    if (minSize < MIN_BLOCK_RESIZE_PX) throw new RangeError(`minSize must be at least ${MIN_BLOCK_RESIZE_PX}px.`);
    const target = event.currentTarget;
    const gesture: PointerGesture = {
      handle,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      origin: { width: activeNode.width, height: activeNode.height },
      scale,
      minSize,
      maxSize: { width: maxSize.width, height: maxSize.height },
      tagName: activeNode.tagName,
      aspectRatio: activeNode.aspectRatio,
      target,
    };
    gestureRef.current = gesture;
    setActiveHandle(handle);
    target.setPointerCapture(event.pointerId);
    onStart({ handle, origin: copySize(gesture.origin), source: "pointer", pointerId: event.pointerId });
  };

  const previewPointerGesture = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const size = resizeBlock({
      handle: gesture.handle,
      origin: gesture.origin,
      screenDelta: pointerDelta(gesture, event),
      scale: gesture.scale,
      minSize: gesture.minSize,
      maxSize: gesture.maxSize,
      tagName: gesture.tagName,
      aspectRatio: gesture.aspectRatio,
      shiftKey: event.shiftKey,
    });
    onPreview({ handle: gesture.handle, size, source: "pointer", shiftKey: event.shiftKey });
  };

  const finishPointerGesture = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.type === "pointercancel") {
      cancelGesture();
      return;
    }
    const size = resizeBlock({
      handle: gesture.handle,
      origin: gesture.origin,
      screenDelta: pointerDelta(gesture, event),
      scale: gesture.scale,
      minSize: gesture.minSize,
      maxSize: gesture.maxSize,
      tagName: gesture.tagName,
      aspectRatio: gesture.aspectRatio,
      shiftKey: event.shiftKey,
    });
    onPreview({ handle: gesture.handle, size, source: "pointer", shiftKey: event.shiftKey });
    if (gesture.target.hasPointerCapture(gesture.pointerId)) gesture.target.releasePointerCapture(gesture.pointerId);
    gestureRef.current = null;
    setActiveHandle(null);
    onCommit({ handle: gesture.handle, size, source: "pointer", shiftKey: event.shiftKey });
  };

  const onHandleKeyDown = (handle: BlockResizeHandle, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      if (!gestureRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      cancelGesture();
      return;
    }
    if (gestureRef.current) return;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    const origin = previewSize ? copySize(previewSize) : { width: activeNode.width, height: activeNode.height };
    const size = keyboardResizeBlock({
      handle,
      origin,
      key: event.key,
      scale,
      step: 4 * KEYBOARD_RESIZE_STEP_PX,
      minSize,
      maxSize,
      tagName: activeNode.tagName,
      aspectRatio: activeNode.aspectRatio,
      shiftKey: event.shiftKey,
    });
    if (size === null) return;
    event.preventDefault();
    event.stopPropagation();
    onStart({ handle, origin: copySize(origin), source: "keyboard", pointerId: null });
    onPreview({ handle, size, source: "keyboard", shiftKey: event.shiftKey });
    onCommit({ handle, size, source: "keyboard", shiftKey: event.shiftKey });
  };

  const displayedSize = previewSize ? scaledResizeSize({ size: previewSize, scale }) : { width: rect.width, height: rect.height };
  const overlayStyle: CSSProperties = {
    position: "absolute",
    left: rect.left,
    top: rect.top,
    width: displayedSize.width,
    height: displayedSize.height,
    pointerEvents: "none",
  };

  return (
    <div
      className="block-resize-overlay"
      style={overlayStyle}
      data-resize-active={activeHandle ?? ""}
      role="group"
      aria-label="選択ブロックのサイズ変更"
    >
      {resizeHandles.map((handle) => (
        <button
          key={handle}
          type="button"
          className={`block-resize-handle ${handle} ${handleNames[handle]}`}
          data-resize-handle={handle}
          aria-label={`選択ブロックの${handleLabels[handle]}をサイズ変更`}
          style={{ pointerEvents: "auto", touchAction: "none" }}
          onPointerDown={(event) => startPointerGesture(handle, event)}
          onPointerMove={previewPointerGesture}
          onPointerUp={finishPointerGesture}
          onPointerCancel={finishPointerGesture}
          onKeyDown={(event) => onHandleKeyDown(handle, event)}
        />
      ))}
    </div>
  );
}

export { MIN_BLOCK_RESIZE_PX };
export { aspectRatioForResize };
