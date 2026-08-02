/** Normalise clipboard text before it enters the contenteditable DOM. */
export function normalizePastedText(text: string, multiline: boolean) {
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/\u00a0/g, " ");

  return multiline
    ? normalized
    : normalized.replace(/[\t\n\f\v ]+/g, " ");
}
