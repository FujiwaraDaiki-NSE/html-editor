import { buildTailwindSlideCss, defaultSlideClasses } from "./tailwind-slide.mjs";

/* Slide geometry, the default stylesheet, and the export document wrappers.

   concept 2.10: the slide's `<main class="weave-slide">` fragment in slides/<id>.html is the
   single truth. This module no longer *generates* that markup on every save — it only:
     - states the fixed design size and ships the default deck.css,
     - wraps an already-authored fragment into a standalone / presentable document (export),
     - seeds/migrates a fragment from a block description (used once, not at runtime).

   Slides are authored at a fixed design size and scaled to fit wherever they are shown, which
   is what lets one stylesheet in absolute pixels serve every context. */

export const designWidth = 1280;
export const designHeight = 720;

export const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Metric rows keep "value|caption|value|caption" in one string. */
export const metricParts = (text) => text.split("|");

export const defaultDeckCss = buildTailwindSlideCss();

const containerKinds = new Set(["row", "column", "grid"]);
const blockTag = (kind) => (kind === "heading" ? "h1" : kind === "paragraph" ? "p" : "div");
/* Line breaks in slide text are <br> elements, not literal newlines: the canonical formatter
   (shared/html-format.mjs) collapses newlines but keeps <br>, and contentEditable emits <br>. */
const textToHtml = (text) => escapeHtml(text).replace(/\n/g, "<br>");

/* Seed/migration only: build a `<main class="weave-slide">` fragment from a block description.
   Never called at runtime — the fragment on disk is the truth once seeded. */
export function slideFragmentFromBlocks(deck) {
  const renderBlock = (block, depth = 0) => {
    const id = escapeHtml(block.id);
    const classes = escapeHtml(block.kind);
    const indent = "      ".padEnd(6 + depth * 2, " ");
    if (containerKinds.has(block.kind)) {
      const children = (block.children ?? []).map((child) => renderBlock(child, depth + 1)).join("\n");
      const layout = block.kind === "grid" ? "grid-cols-2" : `flex flex-${block.kind}`;
      return `${indent}<div class="weave-container ${classes} ${layout} w-full gap-4" data-weave-id="${id}">\n${children}\n${indent}</div>`;
    }
    if (block.kind === "metrics") {
      const cells = metricParts(block.text)
        .map((part, index) => (index % 2 === 0
          ? `<strong class="text-3xl font-semibold tracking-tight text-amber-400">${textToHtml(part)}</strong>`
          : `<span class="text-xs text-slate-400">${textToHtml(part)}</span>`))
        .join("");
      return `${indent}<div class="${classes} grid grid-cols-4 items-center gap-x-5 mt-2" data-weave-id="${id}">${cells}</div>`;
    }
    const tag = blockTag(block.kind);
    const utility = block.kind === "heading"
      ? "text-6xl font-semibold leading-none tracking-tight text-slate-50"
      : block.kind === "paragraph"
        ? "max-w-3xl text-lg leading-normal text-slate-300"
        : block.kind === "eyebrow"
          ? "text-sm font-bold uppercase tracking-widest text-amber-400"
          : "mt-6 text-xs font-semibold uppercase tracking-widest text-slate-400";
    return `${indent}<${tag} class="${classes} ${utility}" data-weave-id="${id}">${textToHtml(block.text)}</${tag}>`;
  };
  const blocks = (deck.blocks ?? []).map((block) => renderBlock(block)).join("\n");
  const total = deck.total ?? 1;
  const position = deck.position ?? 1;
  const theme = deck.background === "plain" ? "plain" : deck.background === "grid" ? "grid" : "orbit";
  const backgroundClass = theme === "plain" ? "bg-white text-slate-950" : theme === "grid" ? "bg-slate-900 text-slate-50" : "bg-slate-950 text-slate-50";
  return `<main class="${defaultSlideClasses} theme-${theme} ${backgroundClass}" data-weave-slide>
    <div class="brand flex items-center gap-2 text-xs font-bold tracking-widest text-slate-400">WEAVE<span class="text-amber-400">●</span></div>
    <section class="hero flex flex-1 flex-col items-start justify-center gap-6">
${blocks}
    </section>
    <div class="page-number absolute top-0 right-0 p-8 text-xs font-semibold tracking-widest text-slate-400">${String(position).padStart(2, "0")} / ${String(total).padStart(2, "0")}</div>
  </main>`;
}

/** A standalone slide file: deck.css inlined so the page stays self-contained. */
export function renderSlideDocument(slideFragment, css, title = "Weave slide") {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    html, body { height: 100%; margin: 0; overflow: hidden; }
    body { display: grid; place-items: center; background: #0c0e11; }
    .weave-slide { transform: scale(var(--slide-scale, 1)); }

${css.replace(/^/gm, "    ")}
  </style>
</head>
<body>
${slideFragment.replace(/^/gm, "  ")}
  <script>
    /* Fit the fixed-size slide to the window without touching its layout. */
    const slide = document.querySelector(".weave-slide");
    const fit = () => slide.style.setProperty(
      "--slide-scale",
      Math.min(innerWidth / ${designWidth}, innerHeight / ${designHeight}),
    );
    addEventListener("resize", fit);
    fit();
  </script>
</body>
</html>
`;
}

/** One offline, self-contained document containing the complete deck. */
export function renderDeckDocument(slideFragments, css, title = "Weave deck") {
  const slides = slideFragments.join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
html,body{height:100%;margin:0;background:#0c0e11;color:white;font-family:Arial,sans-serif;overflow:hidden}
.weave-present-stage{height:100%;display:grid;place-items:center}.weave-present-stage>.weave-slide{display:none;transform:scale(var(--slide-scale,1))}.weave-present-stage>.weave-slide.active{display:block}
.weave-present-controls{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);padding:8px 12px;border-radius:99px;background:#111c;color:#fff;font:13px Arial}.weave-present-controls button{border:0;background:transparent;color:inherit;cursor:pointer}
@page{size:13.333in 7.5in;margin:0}@media print{html,body{height:auto;overflow:visible;background:#fff}.weave-present-stage{display:block;height:auto}.weave-present-stage>.weave-slide{display:block!important;transform:none!important;break-after:page;page-break-after:always}.weave-present-controls{display:none}}
${css}
</style></head><body><div class="weave-present-stage">${slides}</div><div class="weave-present-controls"><button data-prev aria-label="Previous slide">←</button> <span data-position></span> <button data-next aria-label="Next slide">→</button> <button data-fullscreen>Fullscreen</button></div><script>
const slides=[...document.querySelectorAll('.weave-slide')];let current=Math.max(0,Math.min(slides.length-1,(parseInt(location.hash.slice(1),10)||1)-1));
const show=n=>{current=Math.max(0,Math.min(slides.length-1,n));slides.forEach((s,i)=>s.classList.toggle('active',i===current));document.querySelector('[data-position]').textContent=(current+1)+' / '+slides.length;location.hash=String(current+1);fit()};
const fit=()=>slides.forEach(s=>s.style.setProperty('--slide-scale',Math.min(innerWidth/${designWidth},innerHeight/${designHeight})));addEventListener('resize',fit);addEventListener('keydown',e=>{if(['ArrowRight','PageDown',' '].includes(e.key))show(current+1);if(['ArrowLeft','PageUp'].includes(e.key))show(current-1);if(e.key==='Home')show(0);if(e.key==='End')show(slides.length-1)});document.querySelector('[data-prev]').onclick=()=>show(current-1);document.querySelector('[data-next]').onclick=()=>show(current+1);document.querySelector('[data-fullscreen]').onclick=()=>document.documentElement.requestFullscreen?.();show(current);
</script></body></html>`;
}
