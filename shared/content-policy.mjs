/** Static safety checks for authored CSS and HTML. No source is modified here. */

const finding = (code, message, source, index, length) => ({
  code,
  severity: "error",
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
  ];
  return makePolicyResult(diagnostics);
}

function makePolicyResult(diagnostics) {
  return {
    ok: diagnostics.length === 0,
    diagnostics,
    summary: { errors: diagnostics.length, warnings: 0 },
  };
}
