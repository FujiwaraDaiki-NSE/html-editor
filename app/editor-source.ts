export type SourceProblem = { code: string; message: string; line: number; column: number };

const lineColumn = (source: string, index: number) => {
  const before = source.slice(0, index);
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
};

export function validateEditableSlideSource(source: string): SourceProblem[] {
  const problems: SourceProblem[] = [];
  const required = [
    ["source.root", /<main\b[^>]*\bdata-weave-slide-source\b/i, "スライドのルート data-weave-slide-source が必要です。"],
    ["source.content", /<section\b[^>]*\bdata-weave-slot=["']content["']/i, "contentスロットが必要です。"],
    ["source.title", /<h1\b[^>]*\bdata-weave-slot=["']title["']/i, "titleスロットが必要です。"],
    ["source.template", /<main\b[^>]*\bdata-weave-template=["'][^"']+["']/i, "テンプレート境界が必要です。"],
    ["source.layout", /<main\b[^>]*\bdata-weave-layout=["'][^"']+["']/i, "レイアウト境界が必要です。"],
  ] as const;
  for (const [code, pattern, message] of required) {
    if (!pattern.test(source)) problems.push({ code, message, line: 1, column: 1 });
  }

  const ids = new Map<string, number>();
  for (const match of source.matchAll(/\bdata-weave-id\s*=\s*["']([^"']+)["']/gi)) {
    const id = match[1];
    const index = match.index;
    const existing = ids.get(id);
    if (existing !== undefined) {
      problems.push({ code: "source.duplicate-id", message: `data-weave-id「${id}」が重複しています。`, ...lineColumn(source, index) });
    } else ids.set(id, index);
  }

  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const inlineFormattingTags = new Set(["span", "em", "strong", "b", "i", "u", "s", "small", "sub", "sup", "br"]);
  const stack: Array<{ tag: string; index: number }> = [];
  for (const match of source.matchAll(/<\/?\s*([a-z][\w:-]*)\b[^>]*>/gi)) {
    const tag = match[1].toLowerCase();
    const token = match[0];
    const index = match.index;
    if (/^<\//.test(token)) {
      const open = stack.pop();
      if (!open || open.tag !== tag) {
        problems.push({ code: "source.tag-mismatch", message: `閉じタグ </${tag}> の対応関係を確認してください。`, ...lineColumn(source, index) });
      }
    } else {
      const isRoot = /\bdata-weave-slide-source\b/i.test(token);
      const isContentBoundary = tag === "section" && /\bdata-weave-slot\s*=\s*["']content["']/i.test(token);
      if (!isRoot && !isContentBoundary && !inlineFormattingTags.has(tag) && !/\bdata-weave-id\s*=\s*["'][^"']+["']/i.test(token)) {
        problems.push({ code: "source.missing-id", message: `<${tag}> に編集境界の data-weave-id が必要です。`, ...lineColumn(source, index) });
      }
      if (!voidTags.has(tag) && !/\/\s*>$/.test(token)) stack.push({ tag, index });
    }
  }
  for (const open of stack) problems.push({ code: "source.unclosed-tag", message: `<${open.tag}> が閉じられていません。`, ...lineColumn(source, open.index) });
  return problems;
}

export function sourceOffsetForElement(source: string, elementId: string): number {
  const escaped = elementId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`data-weave-id\\s*=\\s*["']${escaped}["']`, "i").exec(source);
  return match?.index ?? 0;
}

export function sourceElementIdAtOffset(source: string, offset: number): string | null {
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const stack: Array<{ tag: string; id: string | null }> = [];
  for (const match of source.matchAll(/<\/?\s*([a-z][\w:-]*)\b[^>]*>/gi)) {
    if (match.index > offset) break;
    const tag = match[1].toLowerCase();
    const token = match[0];
    if (/^<\//.test(token)) { stack.pop(); continue; }
    const id = /\bdata-weave-id\s*=\s*["']([^"']+)["']/i.exec(token)?.[1] ?? null;
    if (match.index <= offset && offset <= match.index + token.length && id) return id;
    if (!voidTags.has(tag) && !/\/\s*>$/.test(token)) stack.push({ tag, id });
  }
  return [...stack].reverse().find((entry) => entry.id)?.id ?? null;
}
