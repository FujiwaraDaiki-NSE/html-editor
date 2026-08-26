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

/* Unlike openingTagWithAttribute, this matcher deliberately does not inspect the
   value. It is used for the empty insertion point owned by a Master. */
const openingTagWithAttributeName = (html, name) => {
  const tags = /<([a-z][\w:-]*)\b[^>]*>/gi;
  for (const match of html.matchAll(tags)) {
    if (new RegExp(`\\b${name}\\s*(?:=\\s*(?:(["'])(.*?)\\1|[^\\s>]+))?`, "i").test(match[0])) {
      return { index: match.index, end: match.index + match[0].length, tag: match[1], opening: match[0] };
    }
  }
  return null;
};

const firstMain = (html) => {
  const match = String(html).match(/<main\b[^>]*>/i);
  return match ? { index: match.index, end: match.index + match[0].length, tag: "main", opening: match[0] } : null;
};

const attributeValue = (opening, name) => opening.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"))?.[2] ?? null;
const setAttribute = (opening, name, value) => {
  const expression = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i");
  return expression.test(opening) ? opening.replace(expression, `${name}="${value}"`) : withAttribute(opening, name, value);
};
const escapeAttributeValue = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");
const removeAttribute = (opening, name) => opening.replace(new RegExp(`\\s+${name}(?:\\s*=\\s*(?:(["'])(.*?)\\1|[^\\s>]+))?`, "ig"), "");
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

const framePageNumber = (html) => {
  const main = openingTagWithClass(html, "weave-slide") ?? firstMain(html);
  const mainElement = main && elementInner(html, main);
  if (!main || !mainElement) return null;
  const content = openingTagWithAttribute(html, "data-weave-slot", contentSlotName);
  const contentElement = content && elementInner(html, content);
  const tags = /<([a-z][\w:-]*)\b[^>]*>/gi;
  for (const match of html.matchAll(tags)) {
    if (match.index <= main.index || match.index >= mainElement.closing.start) continue;
    if (content && contentElement && match.index >= content.index && match.index < contentElement.closing.end) continue;
    const classes = match[0].match(/\bclass\s*=\s*(["'])(.*?)\1/i)?.[2].split(/\s+/) ?? [];
    if (classes.includes("page-number")) return { index: match.index, end: match.index + match[0].length, tag: match[1], opening: match[0] };
  }
  return null;
};

export const withUniqueFragmentIds = (html, instanceId) => {
  if (!instanceId) return html;
  const suffix = String(instanceId).replace(/[^a-z0-9_-]+/gi, "-");
  const ids = [...html.matchAll(/\sid\s*=\s*(["'])(.*?)\1/gi)].map((match) => match[2]);
  return ids.reduce((result, id) => result
    .replaceAll(`id="${id}"`, `id="${id}-${suffix}"`)
    .replaceAll(`id='${id}'`, `id='${id}-${suffix}'`)
    .replaceAll(`url(#${id})`, `url(#${id}-${suffix})`)
    .replaceAll(`href="#${id}"`, `href="#${id}-${suffix}"`)
    .replaceAll(`href='#${id}'`, `href='#${id}-${suffix}'`), html);
};

export function applyTemplateToSlideHtml(slideInput, templateInput, { position = 1, total = 1, accent = "#fbbf24", instanceId = null } = {}) {
  const slideHtml = String(slideInput);
  let frame = withUniqueFragmentIds(applyFrameAccent(String(templateInput), accent), instanceId);
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

  const page = framePageNumber(frame);
  if (page) frame = replaceElementInner(frame, page, `${String(position).padStart(2, "0")} / ${String(total).padStart(2, "0")}`);
  const main = openingTagWithClass(frame, "weave-slide");
  const mainElement = main && elementInner(frame, main);
  return main && mainElement ? frame.slice(main.index, mainElement.closing.end) : slideHtml;
}

const requiredString = (value, name) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value;
};

const slotElement = (html, name, sourceName) => {
  const opening = openingTagWithAttribute(html, "data-weave-slot", name);
  if (!opening) throw new Error(`${sourceName} is missing data-weave-slot="${name}".`);
  const element = elementInner(html, opening);
  if (!element) throw new Error(`${sourceName} has an unclosed ${name} slot.`);
  return { opening, ...element };
};
const attributeCount = (html, name, value = null) => {
  const tags = /<([a-z][\w:-]*)\b[^>]*>/gi;
  let count = 0;
  for (const match of String(html).matchAll(tags)) {
    const expression = value == null
      ? new RegExp(`\\b${name}\\s*(?:=\\s*(?:(["'])(.*?)\\1|[^\\s>]+))?`, "i")
      : new RegExp(`\\b${name}\\s*=\\s*(["'])${value}\\1`, "i");
    if (expression.test(match[0])) count += 1;
  }
  return count;
};
const validateSlotLayer = (html, sourceName, allowBody) => {
  if (attributeCount(html, "data-weave-slot", contentSlotName) !== 1) throw new Error(`${sourceName} must contain exactly one content slot.`);
  if (attributeCount(html, "data-weave-slot", titleSlotName) !== 1) throw new Error(`${sourceName} must contain exactly one title slot.`);
  const content = slotElement(html, contentSlotName, sourceName);
  const title = slotElement(html, titleSlotName, sourceName);
  if (title.opening.index < content.opening.end || title.closing.end > content.closing.start) throw new Error(`${sourceName} title slot must be inside its content slot.`);
  if (!allowBody && removeNestedElement(content.inner, content.opening, content, title.opening, title).trim()) {
    throw new Error(`${sourceName} content slot may contain only its title slot.`);
  }
  return { content, title };
};

const removeNestedElement = (html, parentOpening, parentElement, childOpening, childElement) => {
  if (!childOpening || !childElement) return html;
  if (childOpening.index < parentOpening.end || childElement.closing.end > parentElement.closing.start) return html;
  const start = childOpening.index - parentOpening.end;
  const end = childElement.closing.end - parentOpening.end;
  return `${html.slice(0, start)}${html.slice(end)}`;
};

const canonicalTitleOpening = (opening) => {
  const tag = opening.match(/^<([a-z][\w:-]*)\b/i)?.[1] ?? "h1";
  const id = attributeValue(opening, "data-weave-id");
  return `<${tag} data-weave-slot="${titleSlotName}"${id ? ` data-weave-id="${escapeAttributeValue(id)}"` : ""}>`;
};

/**
 * Compose the persisted slide source with a Template's inherited Master and
 * selected Layout. The returned HTML is a render artifact; callers should
 * persist extractSlideSourceHtml instead.
 */
export function composeSlideHtml({ slideHtml, masterHtml, layoutHtml, templateId, layoutId, position, total, accent, instanceId } = {}) {
  const slide = requiredString(slideHtml, "slideHtml");
  const master = requiredString(masterHtml, "masterHtml");
  const layout = requiredString(layoutHtml, "layoutHtml");
  const template = requiredString(templateId, "templateId");
  const selectedLayout = requiredString(layoutId, "layoutId");
  const selectedAccent = requiredString(accent, "accent");
  if (!Number.isFinite(Number(position)) || Number(position) < 1) throw new Error("position must be a positive number.");
  if (!Number.isFinite(Number(total)) || Number(total) < 1) throw new Error("total must be a positive number.");

  if (attributeCount(master, "data-weave-layout-slot") !== 1) throw new Error("masterHtml must contain exactly one data-weave-layout-slot.");
  if (attributeCount(master, "data-weave-slot") !== 0) throw new Error("masterHtml must not contain slide content slots.");
  const { content: sourceContent, title: sourceTitle } = validateSlotLayer(slide, "slideHtml", true);
  validateSlotLayer(layout, "layoutHtml", false);
  let movedContent = sourceContent.inner;
  movedContent = removeNestedElement(movedContent, sourceContent.opening, sourceContent, sourceTitle.opening, sourceTitle);

  let frame = master;
  const layoutSlot = openingTagWithAttributeName(frame, "data-weave-layout-slot");
  if (!layoutSlot) throw new Error("masterHtml is missing data-weave-layout-slot.");
  const layoutSlotElement = elementInner(frame, layoutSlot);
  if (!layoutSlotElement) throw new Error("masterHtml has an unclosed data-weave-layout-slot.");
  frame = `${frame.slice(0, layoutSlot.index)}${layout}${frame.slice(layoutSlotElement.closing.end)}`;
  frame = withUniqueFragmentIds(applyFrameAccent(frame, selectedAccent), instanceId);

  const root = firstMain(frame);
  if (!root) throw new Error("masterHtml must contain a <main> root.");
  const rootElement = elementInner(frame, root);
  if (!rootElement) throw new Error("masterHtml has an unclosed <main> root.");
  let rootOpening = removeAttribute(root.opening, "data-weave-slide-source");
  rootOpening = setAttribute(rootOpening, "data-weave-template", escapeAttributeValue(template));
  rootOpening = setAttribute(rootOpening, "data-weave-layout", escapeAttributeValue(selectedLayout));
  rootOpening = setAttribute(rootOpening, "data-weave-accent", escapeAttributeValue(selectedAccent));
  frame = replaceElementInner(frame, root, rootElement.inner, rootOpening);

  const frameTitle = slotElement(frame, titleSlotName, "master/layout composition");
  slotElement(frame, contentSlotName, "master/layout composition");
  const titleId = attributeValue(sourceTitle.opening.opening, "data-weave-id");
  const titleOpening = titleId ? setAttribute(frameTitle.opening.opening, "data-weave-id", escapeAttributeValue(titleId)) : frameTitle.opening.opening;
  frame = replaceElementInner(frame, frameTitle.opening, sourceTitle.inner, titleOpening);
  const nextContent = slotElement(frame, contentSlotName, "master/layout composition");
  frame = replaceElementInner(frame, nextContent.opening, appendToInner(nextContent.inner, movedContent));

  const page = framePageNumber(frame);
  if (page) frame = replaceElementInner(frame, page, `${String(position).padStart(2, "0")} / ${String(total).padStart(2, "0")}`);
  const resultRoot = firstMain(frame);
  const resultElement = resultRoot && elementInner(frame, resultRoot);
  if (!resultRoot || !resultElement) throw new Error("Composed slide has no complete <main> root.");
  return frame.slice(resultRoot.index, resultElement.closing.end);
}

/**
 * Reduce a rendered slide back to its persisted source. Only the title and
 * content slots survive; Master/Layout furniture is intentionally discarded.
 */
export function extractSlideSourceHtml(renderedHtml, { templateId, layoutId, accent } = {}) {
  const rendered = requiredString(renderedHtml, "renderedHtml");
  const template = requiredString(templateId, "templateId");
  const selectedLayout = requiredString(layoutId, "layoutId");
  const selectedAccent = requiredString(accent, "accent");
  const root = firstMain(rendered);
  if (!root) throw new Error("renderedHtml must contain a <main> root.");
  const rootElement = elementInner(rendered, root);
  if (!rootElement) throw new Error("renderedHtml has an unclosed <main> root.");
  const { content, title } = validateSlotLayer(rendered, "renderedHtml", true);
  let body = content.inner;
  body = removeNestedElement(body, content.opening, content, title.opening, title);
  const titleElement = rendered.slice(title.opening.index, title.closing.end);
  const titleOpening = canonicalTitleOpening(title.opening.opening);
  const canonicalTitle = titleElement.replace(title.opening.opening, titleOpening);
  const canonicalRoot = `<main data-weave-slide-source data-weave-template="${escapeAttributeValue(template)}" data-weave-layout="${escapeAttributeValue(selectedLayout)}" data-weave-accent="${escapeAttributeValue(selectedAccent)}">`;
  return `${canonicalRoot}<section data-weave-slot="${contentSlotName}">${canonicalTitle}${body}</section></main>`;
}

/** Capture a legacy rendered frame as a Layout fragment without slide content. */
export function extractLayoutSnapshotHtml(renderedHtml, { removeMasterFurniture }) {
  const rendered = requiredString(renderedHtml, "renderedHtml");
  if (typeof removeMasterFurniture !== "boolean") throw new Error("removeMasterFurniture is required.");
  const root = firstMain(rendered);
  if (!root) throw new Error("renderedHtml must contain a <main> root.");
  const rootElement = elementInner(rendered, root);
  if (!rootElement) throw new Error("renderedHtml has an unclosed <main> root.");
  const content = slotElement(rendered, contentSlotName, "renderedHtml");
  const title = slotElement(rendered, titleSlotName, "renderedHtml");
  const emptyTitle = `${title.opening.opening}${rendered.slice(title.closing.start, title.closing.end)}`;
  const withoutContent = replaceElementInner(rendered, content.opening, emptyTitle);
  const nextRoot = firstMain(withoutContent);
  const nextRootElement = nextRoot && elementInner(withoutContent, nextRoot);
  if (!nextRoot || !nextRootElement) throw new Error("Layout snapshot has no complete <main> root.");
  return removeMasterFurniture ? withoutFrameFurniture(nextRootElement.inner) : nextRootElement.inner;
}

/** True when a legacy slide owns frame furniture beyond Master-owned brand/page nodes. */
export function hasLegacyFurnitureOutsideContent(renderedHtml) {
  const rendered = requiredString(renderedHtml, "renderedHtml");
  const root = firstMain(rendered);
  if (!root) throw new Error("renderedHtml must contain a <main> root.");
  const rootElement = elementInner(rendered, root);
  if (!rootElement) throw new Error("renderedHtml has an unclosed <main> root.");
  const content = slotElement(rendered, contentSlotName, "renderedHtml");
  const masterFurnitureRanges = ["brand", "page-number"].map((className) => {
    const opening = openingTagWithClass(rendered, className);
    const closing = opening && closingTagEnd(rendered, opening);
    return opening && closing ? { start: opening.index, end: closing.end } : null;
  }).filter(Boolean);
  const tags = /<([a-z][\w:-]*)\b[^>]*>/gi;
  for (const match of rendered.matchAll(tags)) {
    if (match.index === root.index || match.index < root.end || match.index >= rootElement.closing.start) continue;
    if (match.index >= content.opening.index && match.index < content.closing.end) continue;
    if (masterFurnitureRanges.some((range) => match.index >= range.start && match.index < range.end)) continue;
    return true;
  }
  return false;
}

export function updateSlidePageNumber(input, position, total) {
  const html = String(input);
  const page = framePageNumber(html);
  return page
    ? replaceElementInner(html, page, `${String(position).padStart(2, "0")} / ${String(total).padStart(2, "0")}`)
    : html;
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
