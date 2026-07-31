"use client";

import { useEffect, useMemo, useRef, useState, type ElementType } from "react";

type EditableTextProps = {
  value: string;
  onChange: (next: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  /** Enter inserts a line break; when false it commits and leaves the field. */
  multiline?: boolean;
  as?: "span" | "strong";
  className?: string;
  label?: string;
};

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* innerText keeps the line breaks the caret actually sees; contenteditable pads
   runs of spaces with NBSP and trailing <br>, neither of which belongs in state. */
const readText = (element: HTMLElement) =>
  element.innerText.replace(/\u00a0/g, " ").replace(/\n$/, "");

const placeCaret = (element: HTMLElement, x: number, y: number) => {
  const selection = window.getSelection();
  if (!selection) return;
  const document = element.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = document.caretPositionFromPoint?.(x, y);
  let range = position ? document.createRange() : document.caretRangeFromPoint?.(x, y) ?? null;
  if (position && range) range.setStart(position.offsetNode, position.offset);
  /* Clicks on the block's padding resolve to a caret outside the text; those land at its end. */
  if (!range || !element.contains(range.startContainer)) {
    range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
};

/* Squared distance from a point to a rect — zero when the point is inside it. */
const distanceTo = (element: HTMLElement, x: number, y: number) => {
  const rect = element.getBoundingClientRect();
  const dx = Math.max(rect.left - x, 0, x - rect.right);
  const dy = Math.max(rect.top - y, 0, y - rect.bottom);
  return dx * dx + dy * dy;
};

/* Puts the caret in the text nearest the click. Called for the whole block, because a
   click on its padding — or on the gap after a short line — never reaches the text node
   itself, and a draggable block suppresses the browser's own caret placement anyway. */
export function focusEditableAt(container: HTMLElement, x: number, y: number) {
  const fields = Array.from(container.querySelectorAll<HTMLElement>(".editable-text"));
  let target: HTMLElement | null = null;
  let best = Infinity;
  for (const field of fields) {
    const distance = distanceTo(field, x, y);
    if (distance < best) {
      best = distance;
      target = field;
    }
  }
  if (!target || target === container.ownerDocument.activeElement) return;
  target.focus({ preventScroll: true });
  placeCaret(target, x, y);
}

/* Text edited in place on the slide. Edits from elsewhere (inspector, agent) are written
   into the node only while the caret sits somewhere else. */
export function EditableText({
  value,
  onChange,
  onFocus,
  onBlur,
  multiline = true,
  as = "span",
  className,
  label,
}: EditableTextProps) {
  const ref = useRef<HTMLElement>(null);
  /* Rendered once, then owned by the DOM. The object identity has to stay stable too:
     React re-applies dangerouslySetInnerHTML whenever it receives a new object, which
     would wipe the text under the caret on every keystroke. */
  const [initialHtml] = useState(() => escapeHtml(value));
  const html = useMemo(() => ({ __html: initialHtml }), [initialHtml]);

  useEffect(() => {
    const element = ref.current;
    if (!element || element.ownerDocument.activeElement === element) return;
    if (readText(element) !== value) element.textContent = value;
  }, [value]);

  const commit = () => {
    const element = ref.current;
    if (element) onChange(readText(element));
  };

  const Tag: ElementType = as;
  return (
    <Tag
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      role="textbox"
      aria-label={label}
      aria-multiline={multiline}
      className={`editable-text ${className ?? ""}`.trim()}
      dangerouslySetInnerHTML={html}
      onInput={commit}
      onFocus={() => onFocus?.()}
      onBlur={() => {
        commit();
        onBlur?.();
      }}
      onKeyDown={(event: React.KeyboardEvent<HTMLElement>) => {
        if (event.key === "Escape" || (event.key === "Enter" && !multiline)) {
          event.preventDefault();
          ref.current?.blur();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          document.execCommand("insertLineBreak");
        }
      }}
      onPaste={(event: React.ClipboardEvent<HTMLElement>) => {
        event.preventDefault();
        const text = event.clipboardData.getData("text/plain");
        document.execCommand("insertText", false, multiline ? text : text.replace(/\s*\n\s*/g, " "));
      }}
    />
  );
}
