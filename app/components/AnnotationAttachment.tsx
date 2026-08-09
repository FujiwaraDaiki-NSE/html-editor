"use client";

type Props = {
  slideLabel: string;
  count: number;
  canRestore: boolean;
  onRestore: () => void;
};

export function AnnotationAttachment({ slideLabel, count, canRestore, onRestore }: Props) {
  return (
    <div className="annotation-attachment">
      <span className="annotation-attachment-icon" aria-hidden="true">▱</span>
      <span><strong>{count} annotation{count === 1 ? "" : "s"}</strong><small>{slideLabel}</small></span>
      <button type="button" onClick={onRestore} disabled={!canRestore} title={canRestore ? "Copy annotations back to the draft" : "The original slide no longer exists"}>Return to draft</button>
    </div>
  );
}
