"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { pointerTabText } from "../../shared/annotation.mjs";

export type AnnotationRect = { x: number; y: number; w: number; h: number };
export type Annotation = {
  id: string;
  order: number;
  slideId: string;
  target: { kind: "region" } | { kind: "element"; weaveId: string; html: string; elementKind: string; textExcerpt: string };
  rect: AnnotationRect;
  label: string;
  intersects: string[];
};
export type ResizeHandle = "nw" | "ne" | "sw" | "se";
export type AnnotationGestureKind = "move" | ResizeHandle;
export type PointerCandidate = { id: string; rect: AnnotationRect; elementKind: string; textExcerpt: string };

type Props = {
  interactive: boolean;
  pointerPicking: boolean;
  pointerCandidates: PointerCandidate[];
  annotations: Annotation[];
  recalledAnnotations: Annotation[];
  selectedId: string | null;
  draftRect: AnnotationRect | null;
  focusAnnotationId: string | null;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onFocusHandled: () => void;
  onPointerPick: (weaveId: string) => void;
  onPointerPickCancel: () => void;
  onSelect: (id: string) => void;
  onLabelChange: (id: string, label: string) => void;
  onDelete: (id: string) => void;
  onGestureStart: (event: ReactPointerEvent<HTMLElement>, id: string, kind: AnnotationGestureKind) => void;
  onGestureMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onGestureEnd: (event: ReactPointerEvent<HTMLElement>) => void;
};

const rectStyle = (rect: AnnotationRect): CSSProperties => ({
  left: rect.x,
  top: rect.y,
  width: rect.w,
  height: rect.h,
});

const pointerTabStyle = (rect: AnnotationRect): CSSProperties => ({
  left: rect.x,
  "--pointer-tab-y": `${rect.y}px`,
} as CSSProperties);

function PointerPickingLayer({ candidates, annotations, onPick, onCancel }: {
  candidates: PointerCandidate[];
  annotations: Annotation[];
  onPick: (weaveId: string) => void;
  onCancel: () => void;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  return (
    <div
      className="annotation-overlay-layer pointer-picking-layer"
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      {candidates.map((candidate) => {
        const existing = annotations.find((annotation) => annotation.target.kind === "element" && annotation.target.weaveId === candidate.id);
        const label = existing ? `@${existing.order}` : pointerTabText(candidate.elementKind, candidate.textExcerpt);
        return <button
          type="button"
          className={`pointer-pick-frame ${hoveredId === candidate.id ? "hovered" : ""}`}
          style={rectStyle(candidate.rect)}
          aria-label={`${existing ? "Select" : "Point to"} ${label}`}
          key={`frame-${candidate.id}`}
          onPointerEnter={() => setHoveredId(candidate.id)}
          onPointerLeave={() => setHoveredId((current) => current === candidate.id ? null : current)}
          onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onClick={(event) => { event.stopPropagation(); onPick(candidate.id); }}
        />;
      })}
      {candidates.map((candidate) => {
        const existing = annotations.find((annotation) => annotation.target.kind === "element" && annotation.target.weaveId === candidate.id);
        const label = existing ? `@${existing.order}` : pointerTabText(candidate.elementKind, candidate.textExcerpt);
        return <button
          type="button"
          className={`pointer-pick-tab ${existing ? "existing" : ""}`}
          style={pointerTabStyle(candidate.rect)}
          key={`tab-${candidate.id}`}
          onPointerEnter={() => setHoveredId(candidate.id)}
          onPointerLeave={() => setHoveredId((current) => current === candidate.id ? null : current)}
          onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onClick={(event) => { event.stopPropagation(); onPick(candidate.id); }}
        >{label}</button>;
      })}
    </div>
  );
}

export function AnnotationOverlay({
  interactive,
  pointerPicking,
  pointerCandidates,
  annotations,
  recalledAnnotations,
  selectedId,
  draftRect,
  focusAnnotationId,
  scrollRef,
  onFocusHandled,
  onPointerPick,
  onPointerPickCancel,
  onSelect,
  onLabelChange,
  onDelete,
  onGestureStart,
  onGestureMove,
  onGestureEnd,
}: Props) {
  const inputsRef = useRef(new Map<string, HTMLInputElement>());

  useEffect(() => {
    if (!interactive || !focusAnnotationId) return;
    const annotation = annotations.find((item) => item.id === focusAnnotationId);
    if (!annotation) return;
    if (annotation.target.kind !== "region") {
      onFocusHandled();
      return;
    }
    const input = inputsRef.current.get(focusAnnotationId);
    if (!input) return;
    input.focus();
    onFocusHandled();
  }, [annotations, focusAnnotationId, interactive, onFocusHandled]);

  const gestureProps = (id: string, kind: AnnotationGestureKind) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => onGestureStart(event, id, kind),
    onPointerMove: onGestureMove,
    onPointerUp: onGestureEnd,
    onPointerCancel: onGestureEnd,
  });

  return (
    <div className="annotation-overlay-scroll" ref={scrollRef}>
      {recalledAnnotations.length > 0 && (
        <div className="annotation-overlay-layer annotation-recall-layer" aria-hidden="true">
          {recalledAnnotations.map((annotation) => (
            <div
              className={`annotation-box annotation-recall-box annotation-${annotation.target.kind}`}
              style={rectStyle(annotation.rect)}
              key={annotation.id}
            >
              <span className="annotation-order annotation-order-static annotation-recall-order">S·{annotation.order}</span>
              {annotation.target.kind === "region" && annotation.label && <span className="annotation-label-static annotation-recall-label">{annotation.label}</span>}
            </div>
          ))}
        </div>
      )}
      <div className={`annotation-overlay-layer ${interactive ? "interactive" : "readonly"}`}>
        {annotations.map((annotation) => (
          <div
            className={`annotation-box annotation-${annotation.target.kind} ${selectedId === annotation.id ? "selected" : ""}`}
            style={rectStyle(annotation.rect)}
            key={annotation.id}
          >
            {interactive ? (
              <>
                {annotation.target.kind === "region" ? (
                  <button
                    type="button"
                    className="annotation-order"
                    aria-label={`Move annotation ${annotation.order}`}
                    title={`Move annotation ${annotation.order}`}
                    {...gestureProps(annotation.id, "move")}
                  >{annotation.order}</button>
                ) : (
                  <span className="annotation-order annotation-order-static" aria-label={`Annotation ${annotation.order}`}>{annotation.order}</span>
                )}
                {annotation.target.kind === "region" && (
                  <input
                    ref={(node) => {
                      if (node) inputsRef.current.set(annotation.id, node);
                      else inputsRef.current.delete(annotation.id);
                    }}
                    className="annotation-label"
                    value={annotation.label}
                    aria-label={`Annotation ${annotation.order} label`}
                    placeholder="Label"
                    onFocus={() => onSelect(annotation.id)}
                    onPointerDown={(event) => { event.stopPropagation(); onSelect(annotation.id); }}
                    onKeyDown={(event) => {
                      if (event.key !== "Escape") return;
                      event.preventDefault();
                      event.stopPropagation();
                      event.currentTarget.blur();
                    }}
                    onChange={(event) => onLabelChange(annotation.id, event.target.value)}
                  />
                )}
                <button
                  type="button"
                  className="annotation-delete"
                  aria-label={`Delete annotation ${annotation.order}`}
                  title="Delete annotation"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => { event.stopPropagation(); onDelete(annotation.id); }}
                >×</button>
                {annotation.target.kind === "region" && (["nw", "ne", "sw", "se"] as ResizeHandle[]).map((handle) => (
                  <button
                    type="button"
                    className={`annotation-handle ${handle}`}
                    aria-label={`Resize annotation ${annotation.order} from ${handle}`}
                    key={handle}
                    {...gestureProps(annotation.id, handle)}
                  />
                ))}
              </>
            ) : (
              <>
                <span className="annotation-order annotation-order-static" aria-label={`Annotation ${annotation.order}`}>{annotation.order}</span>
                {annotation.target.kind === "region" && annotation.label && <span className="annotation-label-static">{annotation.label}</span>}
              </>
            )}
          </div>
        ))}
        {interactive && draftRect && <div className="annotation-box annotation-draft" style={rectStyle(draftRect)} />}
      </div>
      {pointerPicking && <PointerPickingLayer candidates={pointerCandidates} annotations={annotations} onPick={onPointerPick} onCancel={onPointerPickCancel} />}
    </div>
  );
}
