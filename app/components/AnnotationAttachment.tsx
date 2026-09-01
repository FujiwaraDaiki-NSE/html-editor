"use client";

import { AnnotationLegend } from "./AnnotationLegend";
import type { Annotation } from "./AnnotationOverlay";

type Props = {
  slideLabel: string;
  annotations: Annotation[];
  canRestore: boolean;
  canOverlay: boolean;
  overlayActive: boolean;
  onRestore: () => void;
  onToggleOverlay: () => void;
};

export function AnnotationAttachment({ slideLabel, annotations, canRestore, canOverlay, overlayActive, onRestore, onToggleOverlay }: Props) {
  const count = annotations.length;
  return (
    <div className={`annotation-attachment ${overlayActive ? "overlay-active" : ""}`}>
      <span className="annotation-attachment-icon" aria-hidden="true">▱</span>
      <span className="annotation-attachment-summary"><strong>Agentへの指示 {count}件</strong><small>{slideLabel}</small></span>
      <span className="annotation-attachment-actions">
        <button
          type="button"
          className="annotation-overlay-toggle"
          aria-pressed={overlayActive}
          onClick={onToggleOverlay}
          disabled={!canOverlay}
          title={canOverlay ? "送信した指示をキャンバス上で比較します" : "元のスライドが存在しません"}
        >{overlayActive ? "比較を隠す" : "比較を表示"}</button>
        <button type="button" onClick={onRestore} disabled={!canRestore} title={canRestore ? "送信した指示を編集中のスライドへ戻します" : "元のスライドが存在しません"}>下書きに戻す</button>
      </span>
      <AnnotationLegend annotations={annotations} />
    </div>
  );
}
