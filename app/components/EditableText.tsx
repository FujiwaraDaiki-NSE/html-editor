"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ElementType,
  type FocusEvent as ReactFocusEvent,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { normalizePastedText } from "./editable-text-utils";

type EditableTextProps = Omit<HTMLAttributes<HTMLElement>, "onChange" | "children" | "dangerouslySetInnerHTML"> & {
  value: string;
  onChange: (next: string) => void;
  /** Enter inserts a line break; when false it commits and leaves the field. */
  multiline?: boolean;
  as?: ElementType;
  label?: string;
  draggable?: boolean;
  onEditingChange?: (editing: boolean) => void;
};

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* innerText keeps the line breaks the caret actually sees; contenteditable pads
   runs of spaces with NBSP and trailing <br>, neither of which belongs in state. */
const readText = (element: HTMLElement) =>
  element.innerText.replace(/\u00a0/g, " ").replace(/\n$/, "");

const insertPlainText = (element: HTMLElement, text: string) => {
  const selection = element.ownerDocument.defaultView?.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.commonAncestorContainer)) return;
  range.deleteContents();
  const node = element.ownerDocument.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
};

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
  if (container.classList.contains("editable-text")) fields.push(container);
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
  onKeyDown,
  onPaste,
  onClick,
  onCompositionStart,
  onCompositionEnd,
  multiline = true,
  as = "span",
  className,
  label,
  onEditingChange,
  tabIndex,
  ...rest
}: EditableTextProps) {
  const ref = useRef<HTMLElement>(null);
  const snapshotRef = useRef(value);
  const draftRef = useRef(value);
  const composingRef = useRef(false);
  const [editing, setEditing] = useState(false);
  /* Rendered once, then owned by the DOM. The object identity has to stay stable too:
     React re-applies dangerouslySetInnerHTML whenever it receives a new object, which
     would wipe the text under the caret on every keystroke. */
  const [initialHtml] = useState(() => escapeHtml(value));
  const html = useMemo(() => ({ __html: initialHtml }), [initialHtml]);

  useEffect(() => {
    const element = ref.current;
    if (!element || editing) return;
    if (readText(element) !== value) element.textContent = value;
    draftRef.current = value;
  }, [editing, value]);

  const commit = () => {
    const element = ref.current;
    if (!element) return;
    const next = readText(element);
    draftRef.current = next;
    setEditing(false);
    onEditingChange?.(false);
    if (next !== value) onChange(next);
  };

  const beginEditing = (point?: { x: number; y: number }) => {
    const element = ref.current;
    if (!element || editing) return;
    snapshotRef.current = readText(element);
    draftRef.current = snapshotRef.current;
    setEditing(true);
    onEditingChange?.(true);
    requestAnimationFrame(() => {
      element.focus({ preventScroll: true });
      if (point) placeCaret(element, point.x, point.y);
    });
  };

  const cancel = () => {
    const element = ref.current;
    if (!element) return;
    element.textContent = snapshotRef.current;
    draftRef.current = snapshotRef.current;
    composingRef.current = false;
    setEditing(false);
    onEditingChange?.(false);
  };

  const Tag: ElementType = as;
  return (
    <Tag
      {...rest}
      ref={ref}
      contentEditable={editing}
      suppressContentEditableWarning
      spellCheck={false}
      role="textbox"
      aria-label={label}
      aria-multiline={multiline}
      aria-readonly={!editing}
      aria-keyshortcuts="Enter F2 Escape Control+Enter Meta+Enter"
      data-editing={editing ? "true" : "false"}
      tabIndex={tabIndex ?? 0}
      className={`editable-text ${className ?? ""}`.trim()}
      dangerouslySetInnerHTML={html}
      onInput={() => {
        if (ref.current) draftRef.current = readText(ref.current);
      }}
      onFocus={(event: ReactFocusEvent<HTMLElement>) => onFocus?.(event)}
      onBlur={(event: ReactFocusEvent<HTMLElement>) => {
        if (editing) commit();
        onBlur?.(event);
      }}
      onClick={(event: ReactMouseEvent<HTMLElement>) => {
        onClick?.(event);
        if (!event.defaultPrevented && !editing) {
          beginEditing({ x: event.clientX, y: event.clientY });
        }
      }}
      onCompositionStart={(event) => {
        composingRef.current = true;
        onCompositionStart?.(event);
      }}
      onCompositionEnd={(event) => {
        composingRef.current = false;
        if (ref.current) draftRef.current = readText(ref.current);
        onCompositionEnd?.(event);
      }}
      onKeyDown={(event: ReactKeyboardEvent<HTMLElement>) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (!editing) {
          if (event.key === "Enter" || event.key === "F2") {
            event.preventDefault();
            event.stopPropagation();
            beginEditing();
          }
          return;
        }
        if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancel();
          return;
        }
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey || !multiline)) {
          event.preventDefault();
          event.stopPropagation();
          commit();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          document.execCommand("insertLineBreak");
          if (ref.current) draftRef.current = readText(ref.current);
        }
      }}
      onPaste={(event: ReactClipboardEvent<HTMLElement>) => {
        onPaste?.(event);
        if (event.defaultPrevented || !editing) return;
        event.preventDefault();
        const text = normalizePastedText(event.clipboardData.getData("text/plain"), multiline);
        if (ref.current) {
          insertPlainText(ref.current, text);
          draftRef.current = readText(ref.current);
        }
      }}
    />
  );
}
