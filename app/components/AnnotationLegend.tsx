"use client";

import type { CSSProperties } from "react";
import type { Annotation } from "./AnnotationOverlay";

type Props = { annotations: Annotation[] };

const thumbnailRectStyle = (annotation: Annotation): CSSProperties => ({
  left: `${annotation.rect.x / 12.8}%`,
  top: `${annotation.rect.y / 7.2}%`,
  width: `${annotation.rect.w / 12.8}%`,
  height: `${annotation.rect.h / 7.2}%`,
});

export function AnnotationLegend({ annotations }: Props) {
  return (
    <ol className="annotation-legend" aria-label="Agentへの指示">
      {[...annotations].sort((a, b) => a.order - b.order).map((annotation) => {
        const elementKind = annotation.target.kind === "element" ? annotation.target.elementKind || "element" : null;
        const text = annotation.target.kind === "element"
          ? annotation.target.textExcerpt
          : annotation.label.trim();
        return (
          <li className="annotation-legend-item" key={annotation.id}>
            <span className="annotation-thumbnail" aria-hidden="true">
              <span
                className={`annotation-thumbnail-rect annotation-${annotation.target.kind}`}
                style={thumbnailRectStyle(annotation)}
              />
            </span>
            <strong className="annotation-legend-order">@{annotation.order}</strong>
            <span className="annotation-legend-text" title={text || elementKind || "指定範囲"}>
              {elementKind ? <strong>{elementKind}</strong> : text || "指定範囲"}
              {elementKind && text ? <span> · {text}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
