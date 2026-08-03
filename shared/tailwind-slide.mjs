/* Tailwind-standard utilities supported by slide HTML. This one registry drives the
   inspector, the precompiled slide stylesheet, and the save-time design audit. */

const option = (label, className, css) => ({ label, className, css });

export const slideControlGroups = {
  fontSize: {
    label: "Size",
    options: [
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
    options: [option("≡", "text-left", "text-align: left"), option("≣", "text-center", "text-align: center"), option("☷", "text-right", "text-align: right")],
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
};

export const textControlKeys = ["fontSize", "fontWeight", "lineHeight", "textAlign", "maxWidth", "color"];
export const containerControlKeys = ["gap", "padding", "justifyContent", "alignItems"];

const extraUtilities = {
  relative: "position: relative", absolute: "position: absolute", "inset-0": "inset: 0", "inset-x-0": "left: 0; right: 0",
  "top-0": "top: 0", "right-0": "right: 0", "bottom-0": "bottom: 0", "left-0": "left: 0",
  flex: "display: flex", grid: "display: grid", "flex-1": "flex: 1 1 0%", "flex-none": "flex: none",
  "flex-row": "flex-direction: row", "flex-col": "flex-direction: column", "flex-wrap": "flex-wrap: wrap",
  "grid-cols-2": "grid-template-columns: repeat(2, minmax(0, 1fr))", "grid-cols-3": "grid-template-columns: repeat(3, minmax(0, 1fr))", "grid-cols-4": "grid-template-columns: repeat(4, minmax(0, 1fr))",
  "gap-x-5": "column-gap: 1.25rem", "gap-y-2": "row-gap: 0.5rem", "mt-2": "margin-top: 0.5rem", "mt-4": "margin-top: 1rem", "mt-6": "margin-top: 1.5rem", "mt-8": "margin-top: 2rem",
  "w-full": "width: 100%", "h-full": "height: 100%", "min-w-0": "min-width: 0", "overflow-hidden": "overflow: hidden",
  "bg-slate-950": "background-color: #020617", "bg-slate-900": "background-color: #0f172a", "bg-slate-800": "background-color: #1e293b", "bg-white": "background-color: #fff",
  "text-slate-950": "color: #020617", uppercase: "text-transform: uppercase", "tracking-tight": "letter-spacing: -0.025em", "tracking-wide": "letter-spacing: 0.025em", "tracking-widest": "letter-spacing: 0.1em",
  "rounded-md": "border-radius: 0.375rem", "rounded-lg": "border-radius: 0.5rem", "rounded-xl": "border-radius: 0.75rem", "shadow-lg": "box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
};

export const structuralSlideClasses = new Set(["weave-slide", "hero", "brand", "page-number", "heading", "paragraph", "eyebrow", "note", "metrics", "weave-container", "row", "column", "grid", "theme-orbit", "theme-grid", "theme-plain"]);
export const utilityDeclarations = new Map([
  ...Object.values(slideControlGroups).flatMap((group) => group.options.map(({ className, css }) => [className, css])),
  ...Object.entries(extraUtilities),
]);
export const allowedSlideClasses = new Set([...structuralSlideClasses, ...utilityDeclarations.keys()]);

export const defaultSlideClasses = "weave-slide relative flex h-full w-full flex-col overflow-hidden bg-slate-950 p-16 text-slate-50";

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
      add.push("w-full", "gap-4");
      if (classes.includes("grid")) add.push("grid", "grid-cols-2");
      else add.push("flex", classes.includes("column") ? "flex-col" : "flex-row");
    }
    return `class=${quote}${[...new Set([...classes, ...add])].join(" ")}${quote}`;
  });
  html = html.replace(/<strong(?![^>]*\bclass=)/gi, '<strong class="text-3xl font-semibold tracking-tight text-amber-400"');
  html = html.replace(/<span(?![^>]*\bclass=)/gi, '<span class="text-xs text-slate-400"');
  return html;
}
