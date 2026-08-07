/* Tailwind-standard utilities supported by slide HTML. This one registry drives the
   inspector, the precompiled slide stylesheet, and the save-time design audit. */

import { contentSlotName, titleSlotName } from "./slide-slots.mjs";

const option = (label, className, css) => ({ label, className, css });

export const slideControlGroups = {
  fontSize: {
    label: "Size",
    options: [
      option("Inherit", "", ""),
      option("xs", "text-xs", "font-size: 0.75rem; line-height: 1rem"),
      option("sm", "text-sm", "font-size: 0.875rem; line-height: 1.25rem"),
      option("base", "text-base", "font-size: 1rem; line-height: 1.5rem"),
      option("lg", "text-lg", "font-size: 1.125rem; line-height: 1.75rem"),
      option("xl", "text-xl", "font-size: 1.25rem; line-height: 1.75rem"),
      option("2xl", "text-2xl", "font-size: 1.5rem; line-height: 2rem"),
      option("3xl", "text-3xl", "font-size: 1.875rem; line-height: 2.25rem"),
      option("4xl", "text-4xl", "font-size: 2.25rem; line-height: 2.5rem"),
      option("5xl", "text-5xl", "font-size: 3rem; line-height: 1"),
      option("6xl", "text-6xl", "font-size: 3.75rem; line-height: 1"),
      option("7xl", "text-7xl", "font-size: 4.5rem; line-height: 1"),
      option("8xl", "text-8xl", "font-size: 6rem; line-height: 1"),
      option("9xl", "text-9xl", "font-size: 8rem; line-height: 1"),
    ],
  },
  fontWeight: {
    label: "Weight",
    options: [
      option("Inherit", "", ""),
      option("Normal", "font-normal", "font-weight: 400"),
      option("Medium", "font-medium", "font-weight: 500"),
      option("Semibold", "font-semibold", "font-weight: 600"),
      option("Bold", "font-bold", "font-weight: 700"),
      option("Extrabold", "font-extrabold", "font-weight: 800"),
    ],
  },
  lineHeight: {
    label: "Leading",
    options: [
      option("Inherit", "", ""),
      option("None", "leading-none", "line-height: 1"),
      option("Tight", "leading-tight", "line-height: 1.25"),
      option("Snug", "leading-snug", "line-height: 1.375"),
      option("Normal", "leading-normal", "line-height: 1.5"),
      option("Relaxed", "leading-relaxed", "line-height: 1.625"),
      option("Loose", "leading-loose", "line-height: 2"),
    ],
  },
  textAlign: {
    label: "Align",
    options: [option("Inherit", "", ""), option("≡", "text-left", "text-align: left"), option("≣", "text-center", "text-align: center"), option("☷", "text-right", "text-align: right")],
  },
  maxWidth: {
    label: "Measure",
    options: [
      option("None", "max-w-none", "max-width: none"), option("sm", "max-w-sm", "max-width: 24rem"),
      option("md", "max-w-md", "max-width: 28rem"), option("lg", "max-w-lg", "max-width: 32rem"),
      option("xl", "max-w-xl", "max-width: 36rem"), option("2xl", "max-w-2xl", "max-width: 42rem"),
      option("3xl", "max-w-3xl", "max-width: 48rem"), option("4xl", "max-w-4xl", "max-width: 56rem"),
      option("Full", "max-w-full", "max-width: 100%"),
    ],
  },
  color: {
    label: "Color",
    options: [
      option("Inherit", "", ""),
      option("Slate 50", "text-slate-50", "color: #f8fafc"), option("Slate 300", "text-slate-300", "color: #cbd5e1"),
      option("Slate 400", "text-slate-400", "color: #94a3b8"), option("Amber", "text-amber-400", "color: #fbbf24"),
      option("Teal", "text-teal-400", "color: #2dd4bf"), option("Violet", "text-violet-400", "color: #a78bfa"),
      option("Rose", "text-rose-400", "color: #fb7185"), option("Emerald", "text-emerald-400", "color: #34d399"),
    ],
  },
  gap: {
    label: "Gap",
    options: [0, 1, 2, 3, 4, 6, 8, 12, 16].map((n) => option(String(n), `gap-${n}`, `gap: ${n === 0 ? 0 : n * 0.25}rem`)),
  },
  padding: {
    label: "Padding",
    options: [0, 1, 2, 3, 4, 6, 8, 12, 16].map((n) => option(String(n), `p-${n}`, `padding: ${n === 0 ? 0 : n * 0.25}rem`)),
  },
  justifyContent: {
    label: "Justify",
    options: [option("Start", "justify-start", "justify-content: flex-start"), option("Center", "justify-center", "justify-content: center"), option("Between", "justify-between", "justify-content: space-between"), option("End", "justify-end", "justify-content: flex-end")],
  },
  alignItems: {
    label: "Align items",
    options: [option("Start", "items-start", "align-items: flex-start"), option("Center", "items-center", "align-items: center"), option("Stretch", "items-stretch", "align-items: stretch"), option("End", "items-end", "align-items: flex-end")],
  },
  listMarker: {
    label: "Marker",
    options: [option("Inherit", "", ""), option("Bullet", "list-disc", "list-style-type: disc"), option("Number", "list-decimal", "list-style-type: decimal"), option("None", "list-none", "list-style-type: none")],
  },
  imageFit: {
    label: "Fit",
    options: [option("Cover", "object-cover", "object-fit: cover"), option("Contain", "object-contain", "object-fit: contain")],
  },
  aspectRatio: {
    label: "Aspect",
    options: [option("16:9", "aspect-video", "aspect-ratio: 16 / 9"), option("4:3", "aspect-4/3", "aspect-ratio: 4 / 3"), option("1:1", "aspect-square", "aspect-ratio: 1 / 1"), option("Auto", "aspect-auto", "aspect-ratio: auto")],
  },
  background: {
    label: "Background",
    options: [option("None", "bg-transparent", "background-color: transparent"), option("800", "bg-slate-800", "background-color: #1e293b"), option("900", "bg-slate-900", "background-color: #0f172a"), option("950", "bg-slate-950", "background-color: #020617"), option("White", "bg-white", "background-color: #fff")],
  },
  borderStyle: {
    label: "Border",
    options: [option("None", "border-transparent", "border-color: transparent"), option("All", "border", "border-width: 1px"), option("2px", "border-2", "border-width: 2px"), option("Top", "border-t", "border-top-width: 1px"), option("Bottom", "border-b", "border-bottom-width: 1px")],
  },
  borderColor: {
    label: "Border color",
    options: [option("Transparent", "border-transparent", "border-color: transparent"), option("Slate 700", "border-slate-700", "border-color: #334155"), option("Slate 300", "border-slate-300", "border-color: #cbd5e1")],
  },
  radius: {
    label: "Radius",
    options: [option("None", "rounded-none", "border-radius: 0"), option("md", "rounded-md", "border-radius: 0.375rem"), option("lg", "rounded-lg", "border-radius: 0.5rem"), option("xl", "rounded-xl", "border-radius: 0.75rem")],
  },
  shadow: {
    label: "Shadow",
    options: [option("None", "shadow-none", "box-shadow: none"), option("Large", "shadow-lg", "box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)")],
  },
  marginTop: {
    label: "Space above",
    options: [option("0", "mt-0", "margin-top: 0"), ...[2, 4, 6, 8].map((n) => option(String(n), `mt-${n}`, `margin-top: ${n * 0.25}rem`))],
  },
};

/* Controls grouped by how widely each one applies. Width and Position sit above these: every block
   has them whatever it is, so the editor renders them itself rather than reading them from here.
   What follows is what changes with the block's kind, and then the details that only mean anything
   once a particular choice has been made — hidden until it is, and shown beneath the choice that
   asked for them rather than gathered into a section of their own. */
export const textControlKeys = ["fontSize", "fontWeight", "lineHeight", "textAlign", "color"];
export const containerControlKeys = ["gap", "padding", "justifyContent", "alignItems"];
export const advancedControlKeys = ["maxWidth"];
export const allControlKeys = [...new Set([...textControlKeys, ...containerControlKeys, ...advancedControlKeys, "listMarker", "imageFit", "aspectRatio", "background", "borderStyle", "borderColor", "radius", "shadow", "marginTop"])];
export const listControlKeys = ["listMarker"];
export const imageControlKeys = ["imageFit", "aspectRatio", "radius"];
export const decorationControlKeys = ["background", "borderStyle", "borderColor", "radius", "shadow"];

export const readUtilityClass = (classes, key) => slideControlGroups[key].options.find(({ className }) => className && classes.includes(className))?.className ?? "";
export const applyUtilityClass = (classes, key, className) => {
  const group = new Set(slideControlGroups[key].options.map((option) => option.className).filter(Boolean));
  return [...classes.filter((name) => !group.has(name)), ...(className ? [className] : [])];
};

/* Sizing is stated as an intent — Fill, Hug or Fixed — never as a class. Width is the main axis
   inside a Row but the cross axis inside a Column, so the same intent needs a different utility
   depending on the parent. The editor owns that mapping; nobody has to reason about flex axes. */
const mainAxisSize = { fill: "flex-1", hug: "flex-none", fixed: "flex-none", ratio: "flex-none" };
const crossAxisSize = { fill: "self-stretch", hug: "self-start", fixed: "self-start" };
const alignSelfClasses = ["self-stretch", "self-start", "self-center", "self-end"];
/* w-full sized every container before intents existed: it reads as Fill and is dropped on write. */
export const ratioOptions = ["1/4", "1/3", "1/2", "2/3", "3/4"].map((value) => ({ value: `basis-${value}`, label: value }));
const ratioClasses = ratioOptions.map(({ value }) => value);
const sizeClasses = [...new Set([...Object.values(mainAxisSize), ...alignSelfClasses, ...ratioClasses, "w-full"])];

export const sizeIntents = [{ value: "fill", label: "Fill" }, { value: "hug", label: "Hug" }, { value: "fixed", label: "Fixed" }, { value: "ratio", label: "Ratio" }];
/* Where the block itself sits — distinct from textAlign, which only moves the text inside it. */
export const blockPositionOptions = [{ value: "self-start", label: "Start" }, { value: "self-center", label: "Center" }, { value: "self-end", label: "End" }];

/* A measure caps the box; max-w-none and max-w-full name a limit without imposing one. */
const constrains = (name) => name.startsWith("max-w-") && name !== "max-w-none" && name !== "max-w-full";
const isMeasured = (classes) => [...classes].some(constrains);
const defaultMeasure = "max-w-3xl";

/** Which intent the classes already express, given the parent's layout direction and classes. */
export function readSize(classes, parentDirection, parentClasses = []) {
  const list = new Set(classes);
  if (parentDirection === "row" && ratioClasses.some((name) => list.has(name))) return "ratio";
  // A cap wins over flex-1 or self-stretch: the box stops at the measure however hard it was told
  // to grow, so Fixed is what it renders as and what the inspector has to say.
  if (isMeasured(list)) return "fixed";
  if (list.has("w-full")) return "fill";
  if (parentDirection === "column") {
    if (list.has("self-stretch")) return "fill";
    // An unplaced block inherits the parent's align-items, which stretches unless it says otherwise.
    const stretched = !alignSelfClasses.some((name) => list.has(name))
      && ![...parentClasses].some((name) => name.startsWith("items-") && name !== "items-stretch");
    return stretched ? "fill" : "hug";
  }
  return list.has("flex-1") ? "fill" : "hug";
}

/* Fixed is the intent that owns a measure; Fill and Hug are defined by not having one. Writing the
   measure alongside the flex class is what makes an intent survive a read — set Hug on a measured
   block without dropping the cap and it would read straight back as Fixed. */
const withMeasure = (classes, intent) => intent === "fixed"
  ? (isMeasured(classes) ? classes : [...classes, defaultMeasure])
  : classes.filter((name) => !constrains(name));

/** Rewrite the sizing classes for an intent, keeping any horizontal alignment already chosen. */
export function applySize(classes, intent, parentDirection) {
  const kept = classes.filter((name) => !sizeClasses.includes(name));
  // A grid cell is sized by its parent's template, so it carries no sizing class of its own.
  if (parentDirection === "grid") return kept;
  if (intent === "ratio" && parentDirection === "row") {
    const basis = classes.find((name) => ratioClasses.includes(name)) ?? "basis-1/2";
    return [...withMeasure(kept, "hug"), "flex-none", basis];
  }
  const measured = withMeasure(kept, intent);
  if (parentDirection !== "column") return [...measured, mainAxisSize[intent] ?? mainAxisSize.fill];
  if (intent === "fill") return [...measured, crossAxisSize.fill];
  return [...measured, classes.find((name) => name === "self-center" || name === "self-end") ?? crossAxisSize[intent] ?? crossAxisSize.hug];
}

export const readBlockPosition = (classes) => classes.find((name) => name !== "self-stretch" && alignSelfClasses.includes(name)) ?? "";
export const applyBlockPosition = (classes, className) => [...classes.filter((name) => !alignSelfClasses.includes(name)), className];

const extraUtilities = {
  relative: "position: relative", absolute: "position: absolute", "inset-0": "inset: 0", "inset-x-0": "left: 0; right: 0",
  "top-0": "top: 0", "right-0": "right: 0", "bottom-0": "bottom: 0", "left-0": "left: 0",
  flex: "display: flex", grid: "display: grid", "flex-1": "flex: 1 1 0%", "flex-none": "flex: none",
  "self-stretch": "align-self: stretch", "self-start": "align-self: flex-start", "self-center": "align-self: center", "self-end": "align-self: flex-end",
  "flex-row": "flex-direction: row", "flex-col": "flex-direction: column", "flex-wrap": "flex-wrap: wrap",
  "grid-cols-2": "grid-template-columns: repeat(2, minmax(0, 1fr))", "grid-cols-3": "grid-template-columns: repeat(3, minmax(0, 1fr))", "grid-cols-4": "grid-template-columns: repeat(4, minmax(0, 1fr))",
  "col-span-2": "grid-column: span 2 / span 2", "col-span-3": "grid-column: span 3 / span 3", "row-span-2": "grid-row: span 2 / span 2",
  "basis-1/4": "flex-basis: 25%", "basis-1/3": "flex-basis: 33.333333%", "basis-1/2": "flex-basis: 50%", "basis-2/3": "flex-basis: 66.666667%", "basis-3/4": "flex-basis: 75%",
  "gap-x-5": "column-gap: 1.25rem", "gap-y-2": "row-gap: 0.5rem", "pl-6": "padding-left: 1.5rem", "pl-8": "padding-left: 2rem",
  "w-full": "width: 100%", "h-full": "height: 100%", "min-w-0": "min-width: 0", "overflow-hidden": "overflow: hidden",
  "object-center": "object-position: center", "border-collapse": "border-collapse: collapse", "p-2": "padding: 0.5rem",
  "text-slate-950": "color: #020617", uppercase: "text-transform: uppercase", "tracking-tight": "letter-spacing: -0.025em", "tracking-wide": "letter-spacing: 0.025em", "tracking-widest": "letter-spacing: 0.1em",
};

export const structuralSlideClasses = new Set(["weave-slide", "hero", "brand", "page-number", "heading", "paragraph", "eyebrow", "note", "metrics", "image", "list", "table", "weave-container", "row", "column", "grid", "theme-orbit", "theme-grid", "theme-plain"]);
export const utilityDeclarations = new Map([
  ...Object.values(slideControlGroups).flatMap((group) => group.options.flatMap(({ className, css }) => className ? [[className, css]] : [])),
  ...Object.entries(extraUtilities),
]);
export const allowedSlideClasses = new Set([...structuralSlideClasses, ...utilityDeclarations.keys()]);

/* text-lg carries a fixed 1.75rem line-height; leading-normal is emitted after size utilities so
   inherited line-height stays unitless and each descendant recomputes it at its own font size. */
export const defaultSlideClasses = "weave-slide relative flex h-full w-full flex-col overflow-hidden bg-slate-950 p-16 text-slate-50 text-lg leading-normal";

const escapeClass = (name) => name.replaceAll("/", "\\/");
export function buildTailwindSlideCss() {
  const utilities = [...utilityDeclarations].map(([name, declarations]) => `.weave-slide.${escapeClass(name)}, .weave-slide .${escapeClass(name)} { ${declarations}; }`).join("\n");
  return `/* weave-tailwind-slide-v1: precompiled Tailwind-standard slide utilities. */
.weave-slide, .weave-slide * { box-sizing: border-box; }
.weave-slide { --weave-accent: #fbbf24; width: 1280px; height: 720px; margin: 0; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
.weave-slide:has(.text-teal-400) { --weave-accent: #2dd4bf; }
.weave-slide:has(.text-violet-400) { --weave-accent: #a78bfa; }
.weave-slide:has(.text-rose-400) { --weave-accent: #fb7185; }
.weave-slide:has(.text-emerald-400) { --weave-accent: #34d399; }
.weave-slide.theme-grid {
  background-image: linear-gradient(rgb(255 255 255 / 0.04) 1px, transparent 1px), linear-gradient(90deg, rgb(255 255 255 / 0.04) 1px, transparent 1px);
  background-size: 40px 40px;
}
.weave-slide.theme-orbit::before, .weave-slide.theme-grid::before {
  content: ""; position: absolute; right: -18%; top: -32%; width: 52%; aspect-ratio: 1; border-radius: 9999px;
  background: color-mix(in srgb, var(--weave-accent) 10%, transparent); pointer-events: none;
}
.weave-slide.theme-orbit::after {
  content: ""; position: absolute; right: -17%; bottom: -31%; width: 38%; aspect-ratio: 1; border-radius: 9999px;
  border: 34px solid color-mix(in srgb, var(--weave-accent) 62%, transparent); opacity: 0.7; pointer-events: none;
}
.weave-slide > * { min-width: 0; }
.weave-slide :where(h1, h2, h3, p, ul, ol) { margin: 0; font-size: inherit; font-weight: inherit; }
${utilities}
`;
}

export function auditTailwindSlideHtml(html) {
  const diagnostics = [];
  for (const match of String(html).matchAll(/\sstyle\s*=/gi)) diagnostics.push({ code: "design.inline-style", severity: "error", message: "Inline style is not allowed; use Tailwind classes.", source: "html", index: match.index, length: match[0].length });
  for (const match of String(html).matchAll(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    for (const className of (match[1] ?? match[2] ?? "").split(/\s+/).filter(Boolean)) {
      if (className === "weave-selected") continue;
      if (className.includes("[") || className.includes("]")) diagnostics.push({ code: "design.arbitrary-class", severity: "error", message: `Arbitrary Tailwind value is not allowed: ${className}`, source: "html", index: match.index, length: match[0].length });
      else if (!allowedSlideClasses.has(className)) diagnostics.push({ code: "design.unknown-class", severity: "error", message: `Unsupported slide class: ${className}`, source: "html", index: match.index, length: match[0].length });
    }
  }
  return diagnostics;
}

const legacyUtilities = {
  brand: "flex items-center gap-2 text-xs font-bold tracking-widest text-slate-400",
  "page-number": "absolute top-0 right-0 p-8 text-xs font-semibold tracking-widest text-slate-400",
  hero: "flex flex-1 flex-col items-start justify-center gap-6",
  heading: "text-6xl font-semibold leading-none tracking-tight text-slate-50",
  paragraph: "max-w-3xl text-lg leading-normal text-slate-300",
  eyebrow: "text-sm font-bold uppercase tracking-widest text-amber-400",
  note: "mt-6 text-xs font-semibold uppercase tracking-widest text-slate-400",
  metrics: "grid grid-cols-4 items-center gap-x-5 mt-2",
};

// Migration runs in both Node and the browser, so slot discovery stays string-only.
const openingTagWithClass = (html, className) => {
  const tags = /<([a-z][\w:-]*)\b[^>]*>/gi;
  for (const match of html.matchAll(tags)) {
    const classes = match[0].match(/\bclass\s*=\s*(["'])(.*?)\1/i)?.[2].split(/\s+/) ?? [];
    if (classes.includes(className)) return { index: match.index, end: match.index + match[0].length, tag: match[1], opening: match[0] };
  }
  return null;
};

const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const directChildWithClass = (html, parent, className) => {
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

const closingTagEnd = (html, opening) => {
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

const withAttribute = (opening, name, value) => opening.replace(/(\s*\/?>)$/, ` ${name}="${value}"$1`);
const stableHash = (value) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(36);
};
const uniqueTitleId = (html) => {
  const ids = new Set([...html.matchAll(/\bdata-weave-id\s*=\s*(["'])(.*?)\1/gi)].map((match) => match[2]));
  const base = `title-${stableHash(html)}`;
  let id = base;
  for (let suffix = 2; ids.has(id); suffix += 1) id = `${base}-${suffix}`;
  return id;
};

const migrateSlideSlots = (html) => {
  if (/\bdata-weave-slot\s*=/i.test(html)) return html;
  const mainMatch = /<main\b[^>]*>/i.exec(html);
  const main = mainMatch ? { index: mainMatch.index, end: mainMatch.index + mainMatch[0].length, tag: "main", opening: mainMatch[0] } : null;
  const content = openingTagWithClass(html, "hero") ?? (main && directChildWithClass(html, main, "flex-1"));
  if (!content) return html;
  const closing = closingTagEnd(html, content);
  if (!closing) return html;
  const inner = html.slice(content.end, closing.start);
  const heading = /<h1\b[^>]*>/i.exec(inner);
  const title = `<h1 class="heading text-6xl font-semibold leading-none tracking-tight text-slate-50" data-weave-slot="${titleSlotName}" data-weave-id="${uniqueTitleId(html)}"></h1>`;
  const slottedInner = heading
    ? `${inner.slice(0, heading.index)}${withAttribute(heading[0], "data-weave-slot", titleSlotName)}${inner.slice(heading.index + heading[0].length)}`
    : `${title}${inner}`;
  const slottedContent = withAttribute(content.opening, "data-weave-slot", contentSlotName)
    + slottedInner
    + html.slice(closing.start, closing.end);
  return `${html.slice(0, content.index)}${slottedContent}${html.slice(closing.end)}`;
};

// Accent and kind-identity classes stay explicit; only these old inherited defaults move to root.
const stripLegacyInheritedDefaults = (html) => html.replace(/<([a-z][\w:-]*)\b[^>]*>/gi, (opening) => {
  const attribute = opening.match(/\bclass\s*=\s*(["'])(.*?)\1/i);
  if (!attribute) return opening;
  const classes = attribute[2].split(/\s+/).filter(Boolean);
  const remove = new Set();
  if (classes.includes("paragraph")) { remove.add("text-lg"); remove.add("text-slate-300"); }
  if (classes.includes("heading") && !/\bdata-weave-slot\s*=\s*(?:"title"|'title')/i.test(opening)) { remove.add("text-6xl"); remove.add("text-slate-50"); }
  if (remove.size === 0) return opening;
  return opening.replace(attribute[0], `class=${attribute[1]}${classes.filter((name) => !remove.has(name)).join(" ")}${attribute[1]}`);
});

/** One-way migration for decks created before Tailwind classes became the source of truth. */
export function migrateSlideHtmlToTailwind(input) {
  let html = String(input).replace(/\sstyle\s*=\s*(?:"[^"]*"|'[^']*')/gi, "");
  html = html.replace(/class=(['"])([^'"]*)\1/gi, (attribute, quote, value) => {
    let classes = value.split(/\s+/).filter(Boolean);
    const add = [];
    if (classes.includes("weave-slide")) {
      const theme = classes.includes("theme-plain") || classes.includes("plain") ? "plain" : classes.includes("theme-grid") || classes.includes("grid") ? "grid" : "orbit";
      classes = classes.filter((className) => !["orbit", "grid", "plain"].includes(className));
      add.push(...defaultSlideClasses.split(" "));
      const background = theme === "plain" ? "bg-white" : theme === "grid" ? "bg-slate-900" : "bg-slate-950";
      add.push(`theme-${theme}`, background, theme === "plain" ? "text-slate-950" : "text-slate-50");
    }
    for (const [structural, utilities] of Object.entries(legacyUtilities)) if (classes.includes(structural)) add.push(...utilities.split(" "));
    if (classes.includes("weave-container")) {
      // w-full is what the old stylesheet said, so it stays: readSize treats it as Fill and the
      // honest class replaces it the first time the block's size is set.
      add.push("w-full", "gap-4");
      if (classes.includes("grid")) add.push("grid", "grid-cols-2");
      else add.push("flex", classes.includes("column") ? "flex-col" : "flex-row");
    }
    return `class=${quote}${[...new Set([...classes, ...add])].join(" ")}${quote}`;
  });
  html = html.replace(/<strong(?![^>]*\bclass=)/gi, '<strong class="text-3xl font-semibold tracking-tight text-amber-400"');
  html = html.replace(/<span(?![^>]*\bclass=)/gi, '<span class="text-xs text-slate-400"');
  return stripLegacyInheritedDefaults(migrateSlideSlots(html));
}
