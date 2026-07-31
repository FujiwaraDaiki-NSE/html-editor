/* The single description of what a slide looks like, used by both the canvas and the
   exported HTML. The canvas renders these tags as React elements and the exporter writes
   them as text; both attach the same classes, so `deck.css` is the only stylesheet and
   the two can no longer drift apart.

   Slides are authored at a fixed design size and scaled to fit wherever they are shown,
   which is what lets one stylesheet in absolute pixels serve every context. */

export const designWidth = 1280;
export const designHeight = 720;

/** Tag per block kind. Anything unknown falls back to a plain container. */
export const blockTag = (kind) => (kind === "heading" ? "h1" : kind === "paragraph" ? "p" : "div");

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
  white-space: pre-wrap;
}

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

/** The slide element itself, exactly as the canvas builds it. */
export function renderSlideMarkup(deck) {
  const blocks = deck.blocks
    .map((block) => {
      const id = escapeHtml(block.id);
      if (block.kind === "metrics") {
        const cells = metricParts(block.text)
          .map((part, index) =>
            index % 2 === 0
              ? `<strong>${escapeHtml(part)}</strong>`
              : `<span>${escapeHtml(part)}</span>`)
          .join("");
        return `      <div class="metrics" data-weave-id="${id}">${cells}</div>`;
      }
      const tag = blockTag(block.kind);
      return `      <${tag} class="${escapeHtml(block.kind)}" data-weave-id="${id}">${escapeHtml(block.text)}</${tag}>`;
    })
    .join("\n");
  const total = deck.slides?.length ?? 1;
  return `  <main class="weave-slide ${escapeHtml(deck.background)}" style="--accent: ${escapeHtml(deck.accent)}">
    <div class="brand">WEAVE<span>●</span></div>
    <section class="hero">
${blocks}
    </section>
    <div class="page-number">${String(deck.activeSlide).padStart(2, "0")} / ${String(total).padStart(2, "0")}</div>
  </main>`;
}

/** A standalone slide file: deck.css inlined so the page stays self-contained. */
export function renderSlideDocument(deck, css) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(deck.title)}</title>
  <style>
    html, body { height: 100%; margin: 0; overflow: hidden; }
    body { display: grid; place-items: center; background: #0c0e11; }
    .weave-slide { transform: scale(var(--slide-scale, 1)); }

${css.replace(/^/gm, "    ")}
  </style>
</head>
<body>
${renderSlideMarkup(deck)}
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
