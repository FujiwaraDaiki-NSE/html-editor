/** Static safety checks for authored CSS and HTML. No source is modified here. */

import { auditTailwindSlideHtml } from "./tailwind-slide.mjs";

const finding = (code, message, source, index, length, severity = "error") => ({
  code,
  severity,
  message,
  source,
  index,
  length,
});

const collect = (text, expression, build) => {
  const diagnostics = [];
  expression.lastIndex = 0;
  for (const match of text.matchAll(expression)) diagnostics.push(build(match));
  return diagnostics;
};

const decodeAttributeValue = (value) => value
  .replace(/&#(\d+);?/g, (_, digits) => String.fromCodePoint(Number(digits)))
  .replace(/&#x([\da-f]+);?/gi, (_, digits) => String.fromCodePoint(Number.parseInt(digits, 16)))
  .replace(/&colon;?/gi, ":")
  .replace(/[\u0000-\u0020\u007f]+/g, "")
  .toLowerCase();

const isExternalUrl = (value) => /^(?:https?:)?\/\//i.test(value.trim());

export function auditCssSafety(input) {
  const css = typeof input === "string" ? input : "";
  const diagnostics = [
    ...collect(css, /@import\b/gi, (match) => finding(
      "css.import",
      "CSS @import is not allowed; keep slide styles self-contained.",
      "css",
      match.index,
      match[0].length,
    )),
    ...collect(css, /javascript\s*:/gi, (match) => finding(
      "css.javascript-url",
      "javascript: URLs are not allowed in CSS.",
      "css",
      match.index,
      match[0].length,
    )),
  ];

  for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s][^)]*?))\s*\)/gi)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (isExternalUrl(value)) {
      diagnostics.push(finding(
        "css.external-url",
        "External URLs are not allowed in CSS.",
        "css",
        match.index,
        match[0].length,
      ));
    }
  }
  return makePolicyResult(diagnostics);
}

export function auditHtmlSafety(input) {
  const html = typeof input === "string" ? input : "";
  const diagnostics = [
    ...collect(html, /<\s*script\b/gi, (match) => finding(
      "html.script",
      "Script elements are not allowed in slide HTML.",
      "html",
      match.index,
      match[0].length,
    )),
  ];

  const attributePattern = /\b(?:href|src|action|formaction|poster|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  /* Restrict attribute checks to markup so harmless slide text such as
     "document onload= complete" is not mistaken for an event handler. */
  for (const tag of html.matchAll(/<[^>]*>/g)) {
    const tagText = tag[0];
    for (const match of tagText.matchAll(/\s(on[a-z][\w:-]*)\s*=/gi)) {
      diagnostics.push(finding(
        "html.event-handler",
        `Inline event handler ${match[1]} is not allowed.`,
        "html",
        tag.index + match.index,
        match[0].length,
      ));
    }
    for (const match of tagText.matchAll(attributePattern)) {
      const value = match[1] ?? match[2] ?? match[3] ?? "";
      const normalized = decodeAttributeValue(value);
      if (normalized.startsWith("javascript:")) {
        diagnostics.push(finding(
          "html.javascript-url",
          "javascript: URLs are not allowed in HTML.",
          "html",
          tag.index + match.index,
          match[0].length,
        ));
      } else if (isExternalUrl(normalized)) {
        diagnostics.push(finding(
          "html.external-url",
          "External URLs are not allowed in slide HTML.",
          "html",
          tag.index + match.index,
          match[0].length,
        ));
      }
    }
  }
  return makePolicyResult(diagnostics);
}

export function auditContentPolicy({ css = "", html = "" } = {}) {
  const diagnostics = [
    ...auditCssSafety(css).diagnostics,
    ...auditHtmlSafety(html).diagnostics,
    ...auditTailwindSlideHtml(html),
    ...auditWeaveIdCoverage(html),
  ];
  return makePolicyResult(diagnostics);
}

export function auditWeaveIdCoverage(input) {
  const html = typeof input === "string" ? input : "";
  const diagnostics = [];
  const selectableTags = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "table", "svg", "img", "figure", "blockquote"]);
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const stack = [];

  for (const match of html.matchAll(/<[^>]*>/g)) {
    const tagText = match[0];
    const closing = /^<\s*\/\s*([a-z][\w:-]*)/i.exec(tagText);
    if (closing) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].tag === closing[1].toLowerCase()) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    const opening = /^<\s*([a-z][\w:-]*)\b/i.exec(tagText);
    if (!opening) continue;
    const tag = opening[1].toLowerCase();
    const hasId = /\bdata-weave-id\s*=/i.test(tagText);
    if (selectableTags.has(tag) && !hasId && !stack.some((entry) => entry.hasId)) {
      diagnostics.push(finding(
        "html.missing-weave-id",
        `Selectable <${tag}> elements must have a data-weave-id or an id-bearing ancestor.`,
        "html",
        match.index,
        tagText.length,
        "warning",
      ));
    }
    if (!voidTags.has(tag) && !/\/\s*>$/.test(tagText)) stack.push({ tag, hasId });
  }
  return diagnostics;
}

function makePolicyResult(diagnostics) {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
  return {
    ok: errors === 0,
    diagnostics,
    summary: { errors, warnings },
  };
}
