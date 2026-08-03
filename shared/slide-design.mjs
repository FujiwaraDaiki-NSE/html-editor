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

export const defaultDeckCss = `/* Weave deck styles.
   Authored at the ${designWidth}x${designHeight} design size in absolute pixels; the editor and the
   exported file both scale the whole slide to fit, so no responsive units are needed.
   Every selector stays under .weave-slide — that keeps these rules off the editor's own UI. */

/* A slide is a document root: it states its own typography rather than inheriting any,
   so it renders the same inside the editor's UI as it does in a file of its own. */
.weave-slide {
  --accent: #f6b84b;
  position: relative;
  width: ${designWidth}px;
  height: ${designHeight}px;
  overflow: hidden;
  background: #171a20;
  color: #f3f4f6;
  font: 400 16px/1.4 Inter, "Helvetica Neue", Arial, sans-serif;
  letter-spacing: normal;
  word-spacing: normal;
  text-align: left;
  text-transform: none;
  text-indent: 0;
}

.weave-slide.grid {
  background-color: #1a1e24;
  background-image:
    linear-gradient(rgba(255, 255, 255, .035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, .035) 1px, transparent 1px);
  background-size: 40px 40px;
}

.weave-slide::before {
  content: "";
  position: absolute;
  right: -18%;
  top: -32%;
  width: 52%;
  aspect-ratio: 1;
  border-radius: 50%;
  background: color-mix(in srgb, var(--accent) 9%, transparent);
}

.weave-slide.orbit::after {
  content: "";
  position: absolute;
  right: -17%;
  bottom: -31%;
  width: 38%;
  aspect-ratio: 1;
  border: 34px solid color-mix(in srgb, var(--accent) 62%, transparent);
  border-radius: 50%;
  opacity: .7;
}

.weave-slide.plain::before { display: none; }

.weave-slide .brand {
  position: absolute;
  left: 5.5%;
  top: 5.5%;
  display: flex;
  align-items: center;
  gap: 6px;
  color: #8a919b;
  font: 700 11px/1 ui-monospace, "SF Mono", monospace;
  letter-spacing: .22em;
}

.weave-slide .brand span { color: var(--accent); font-size: 8px; }

.weave-slide .page-number {
  position: absolute;
  right: 4.5%;
  top: 5.5%;
  color: #727982;
  font: 600 11px/1 ui-monospace, "SF Mono", monospace;
  letter-spacing: .1em;
}

.weave-slide .hero {
  position: absolute;
  left: 11%;
  top: 22%;
  width: 68%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 18px;
}

/* Blocks hug their own text, so a click target matches what you see. */
.weave-slide .hero > * {
  margin: 0;
  width: max-content;
  max-width: 100%;
}

.weave-slide .weave-container { width: 100%; display: flex; gap: 18px; }
.weave-slide .weave-container.column { flex-direction: column; }
.weave-slide .weave-container.row { flex-direction: row; align-items: flex-start; }
.weave-slide .weave-container.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.weave-slide .weave-container > * { min-width: 0; max-width: 100%; margin: 0; }

.weave-slide .eyebrow {
  color: var(--accent);
  font: 700 14px/1 ui-monospace, "SF Mono", monospace;
  letter-spacing: .16em;
}

.weave-slide .heading {
  font-size: 64px;
  font-weight: 600;
  line-height: .96;
  letter-spacing: -.055em;
}

.weave-slide .paragraph {
  max-width: 62%;
  color: #aeb4bd;
  font-size: 18px;
  line-height: 1.5;
}

.weave-slide .metrics {
  display: grid;
  grid-template-columns: auto auto auto auto;
  align-items: baseline;
  gap: 0 20px;
  margin-top: 10px;
}

.weave-slide .metrics strong {
  color: var(--accent);
  font-size: 34px;
  font-weight: 600;
  letter-spacing: -.04em;
}

.weave-slide .metrics span {
  max-width: 74px;
  color: #969da6;
  font-size: 12px;
  line-height: 1.2;
}

.weave-slide .note {
  margin-top: 22px;
  color: #676e77;
  font: 600 11px/1 ui-monospace, "SF Mono", monospace;
  letter-spacing: .14em;
}
`;

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
      return `${indent}<div class="weave-container ${classes}" data-weave-id="${id}">\n${children}\n${indent}</div>`;
    }
    if (block.kind === "metrics") {
      const cells = metricParts(block.text)
        .map((part, index) => (index % 2 === 0 ? `<strong>${textToHtml(part)}</strong>` : `<span>${textToHtml(part)}</span>`))
        .join("");
      return `${indent}<div class="${classes}" data-weave-id="${id}">${cells}</div>`;
    }
    const tag = blockTag(block.kind);
    return `${indent}<${tag} class="${classes}" data-weave-id="${id}">${textToHtml(block.text)}</${tag}>`;
  };
  const blocks = (deck.blocks ?? []).map((block) => renderBlock(block)).join("\n");
  const total = deck.total ?? 1;
  const position = deck.position ?? 1;
  return `<main class="weave-slide ${escapeHtml(deck.background ?? "orbit")}" style="--accent: ${escapeHtml(deck.accent ?? "#f6b84b")}" data-weave-slide>
    <div class="brand">WEAVE<span>●</span></div>
    <section class="hero">
${blocks}
    </section>
    <div class="page-number">${String(position).padStart(2, "0")} / ${String(total).padStart(2, "0")}</div>
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
