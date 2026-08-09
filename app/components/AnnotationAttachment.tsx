"use client";

type Props = {
  slideLabel: string;
  count: number;
  canRestore: boolean;
  canOverlay: boolean;
  overlayActive: boolean;
  onRestore: () => void;
  onToggleOverlay: () => void;
};

export function AnnotationAttachment({ slideLabel, count, canRestore, canOverlay, overlayActive, onRestore, onToggleOverlay }: Props) {
  return (
    <div className={`annotation-attachment ${overlayActive ? "overlay-active" : ""}`}>
      <span className="annotation-attachment-icon" aria-hidden="true">▱</span>
      <span><strong>{count} annotation{count === 1 ? "" : "s"}</strong><small>{slideLabel}</small></span>
      <span className="annotation-attachment-actions">
        <button
          type="button"
          className="annotation-overlay-toggle"
          aria-pressed={overlayActive}
          onClick={onToggleOverlay}
          disabled={!canOverlay}
          title={canOverlay ? "Compare these sent annotations on the canvas" : "The original slide no longer exists"}
        >{overlayActive ? "Hide overlay" : "Show overlay"}</button>
        <button type="button" onClick={onRestore} disabled={!canRestore} title={canRestore ? "Copy annotations back to the draft" : "The original slide no longer exists"}>Return to draft</button>
      </span>
    </div>
  );
}
