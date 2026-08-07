export const titleSlotName = "title";
export const contentSlotName = "content";
export const titleSlotSelector = `[data-weave-slot="${titleSlotName}"]`;
export const contentSlotSelector = `[data-weave-slot="${contentSlotName}"]`;

export const openingTagWithClass = (html, className) => {
  const tags = /<([a-z][\w:-]*)\b[^>]*>/gi;
  for (const match of html.matchAll(tags)) {
    const classes = match[0].match(/\bclass\s*=\s*(["'])(.*?)\1/i)?.[2].split(/\s+/) ?? [];
    if (classes.includes(className)) return { index: match.index, end: match.index + match[0].length, tag: match[1], opening: match[0] };
  }
  return null;
};

const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
export const directChildWithClass = (html, parent, className) => {
  const tags = /<\/?([a-z][\w:-]*)\b[^>]*>/gi;
  tags.lastIndex = parent.end;
  let depth = 0;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    if (match[0][1] === "/") {
      if (depth === 0) return null;
      depth -= 1;
      continue;
    }
    const classes = match[0].match(/\bclass\s*=\s*(["'])(.*?)\1/i)?.[2].split(/\s+/) ?? [];
    if (depth === 0 && classes.includes(className)) return { index: match.index, end: tags.lastIndex, tag: match[1], opening: match[0] };
    if (!voidTags.has(match[1].toLowerCase()) && !/\/\s*>$/.test(match[0])) depth += 1;
  }
  return null;
};

export const closingTagEnd = (html, opening) => {
  const tags = new RegExp(`<\\/?${opening.tag}\\b[^>]*>`, "gi");
  tags.lastIndex = opening.end;
  let depth = 1;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    if (match[0][1] === "/") depth -= 1;
    else if (!/\/\s*>$/.test(match[0])) depth += 1;
    if (depth === 0) return { start: match.index, end: tags.lastIndex };
  }
  return null;
};

export const withAttribute = (opening, name, value) => opening.replace(/(\s*\/?>)$/, ` ${name}="${value}"$1`);

const openingTagWithAttribute = (html, name, value) => {
  const tags = /<([a-z][\w:-]*)\b[^>]*>/gi;
  for (const match of html.matchAll(tags)) {
    const attribute = match[0].match(new RegExp(`\\b${name}\\s*=\\s*(["'])${value}\\1`, "i"));
    if (attribute) return { index: match.index, end: match.index + match[0].length, tag: match[1], opening: match[0] };
  }
  return null;
};

const attributeValue = (opening, name) => opening.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"))?.[2] ?? null;
const setAttribute = (opening, name, value) => {
  const expression = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i");
  return expression.test(opening) ? opening.replace(expression, `${name}="${value}"`) : withAttribute(opening, name, value);
};
const elementInner = (html, opening) => {
  const closing = closingTagEnd(html, opening);
  return closing ? { inner: html.slice(opening.end, closing.start), closing } : null;
};
const replaceElementInner = (html, opening, inner, nextOpening = opening.opening) => {
  const element = elementInner(html, opening);
  if (!element) return html;
  return `${html.slice(0, opening.index)}${nextOpening}${inner}${html.slice(element.closing.start)}`;
};
const appendToInner = (frameInner, content) => {
  const moved = content.trim();
  if (!moved) return frameInner;
  const trailing = frameInner.match(/\s*$/)?.[0] ?? "";
  const head = frameInner.slice(0, frameInner.length - trailing.length);
  return `${head}${head ? "\n" : ""}${moved}${trailing}`;
};
const withoutFrameFurniture = (html) => {
  let content = html;
  while (true) {
    const opening = [openingTagWithClass(content, "brand"), openingTagWithClass(content, "page-number")]
      .filter(Boolean)
      .sort((a, b) => a.index - b.index)[0];
    if (!opening) return content;
    const closing = closingTagEnd(content, opening);
    content = closing
      ? `${content.slice(0, opening.index)}${content.slice(closing.end)}`
      : `${content.slice(0, opening.index)}${content.slice(opening.end)}`;
  }
};

const accentClasses = ["text-amber-400", "text-teal-400", "text-violet-400", "text-rose-400", "text-emerald-400"];
const accentClass = new Map([
  ["#fbbf24", "text-amber-400"], ["#2dd4bf", "text-teal-400"], ["#a78bfa", "text-violet-400"],
  ["#fb7185", "text-rose-400"], ["#34d399", "text-emerald-400"],
]);
const applyFrameAccent = (html, accent) => {
  const target = accentClasses.includes(accent) ? accent : accentClass.get(String(accent).toLowerCase());
  if (!target) return html;
  return html.replace(/\bclass\s*=\s*(["'])(.*?)\1/gi, (attribute, quote, value) => {
    const classes = value.split(/\s+/).filter(Boolean);
    if (!classes.some((name) => accentClasses.includes(name))) return attribute;
    return `class=${quote}${[...classes.filter((name) => !accentClasses.includes(name)), target].join(" ")}${quote}`;
  });
};

export function applyTemplateToSlideHtml(slideInput, templateInput, { position = 1, total = 1, accent = "#fbbf24" } = {}) {
  const slideHtml = String(slideInput);
  let frame = applyFrameAccent(String(templateInput), accent);
  const frameTitle = openingTagWithAttribute(frame, "data-weave-slot", titleSlotName);
  const frameContent = openingTagWithAttribute(frame, "data-weave-slot", contentSlotName);
  const frameMain = openingTagWithClass(frame, "weave-slide");
  if (!frameTitle || !frameContent || !frameMain) return slideHtml;

  const slideTitle = openingTagWithAttribute(slideHtml, "data-weave-slot", titleSlotName);
  const slideContent = openingTagWithAttribute(slideHtml, "data-weave-slot", contentSlotName);
  const slideTitleElement = slideTitle && elementInner(slideHtml, slideTitle);
  const slideContentElement = slideContent && elementInner(slideHtml, slideContent);
  let movedContent = slideContentElement?.inner ?? "";
  if (slideTitle && slideTitleElement && slideContentElement && slideTitle.index >= slideContent.end && slideTitleElement.closing.end <= slideContentElement.closing.start) {
    const start = slideTitle.index - slideContent.end;
    const end = slideTitleElement.closing.end - slideContent.end;
    movedContent = `${movedContent.slice(0, start)}${movedContent.slice(end)}`;
  }
  if (!slideTitle && !slideContent) {
    const slideMain = openingTagWithClass(slideHtml, "weave-slide");
    movedContent = withoutFrameFurniture(slideMain ? elementInner(slideHtml, slideMain)?.inner ?? slideHtml : slideHtml);
  }

  const titleId = slideTitle ? attributeValue(slideTitle.opening, "data-weave-id") : null;
  const nextTitleOpening = titleId ? setAttribute(frameTitle.opening, "data-weave-id", titleId) : frameTitle.opening;
  frame = replaceElementInner(frame, frameTitle, slideTitleElement?.inner ?? "", nextTitleOpening);

  const nextContent = openingTagWithAttribute(frame, "data-weave-slot", contentSlotName);
  const nextContentElement = nextContent && elementInner(frame, nextContent);
  if (!nextContent || !nextContentElement) return slideHtml;
  frame = replaceElementInner(frame, nextContent, appendToInner(nextContentElement.inner, movedContent));

  const page = openingTagWithClass(frame, "page-number");
  if (page) frame = replaceElementInner(frame, page, `${String(position).padStart(2, "0")} / ${String(total).padStart(2, "0")}`);
  const main = openingTagWithClass(frame, "weave-slide");
  const mainElement = main && elementInner(frame, main);
  return main && mainElement ? frame.slice(main.index, mainElement.closing.end) : slideHtml;
}

const namedEntities = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };

const decodeEntities = (value) => value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/gi, (entity, name) => {
  if (name[0] !== "#") return namedEntities[name.toLowerCase()] ?? entity;
  const hex = name[1]?.toLowerCase() === "x";
  const point = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
  try { return Number.isFinite(point) ? String.fromCodePoint(point) : entity; } catch { return entity; }
});

export function titleFromSlideHtml(input) {
  const html = String(input);
  const match = html.match(/<([a-z][\w:-]*)\b(?=[^>]*\bdata-weave-slot\s*=\s*(?:"title"|'title'))[^>]*>([\s\S]*?)<\/\1\s*>/i);
  if (!match) return null;
  return decodeEntities(match[2].replace(/<br\s*\/?\s*>/gi, " ").replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}
