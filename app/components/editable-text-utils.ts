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

const textOfNode = (node: Node): string => {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  if (node.nodeName.toLowerCase() === "br") return " ";
  return Array.from(node.childNodes, textOfNode).join("");
};

/** Read visible text cheaply while preserving explicit HTML line-break boundaries. */
export function textExcerptOfNode(node: Node, maxLength = 72): string {
  const text = textOfNode(node).replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}
