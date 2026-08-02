import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  defaultDeckCss,
  designHeight,
  designWidth,
  renderSlideDocument,
  renderDeckDocument,
  renderSlideMarkup,
} from "../shared/slide-design.mjs";

const read = (file) => readFile(new URL(file, import.meta.url), "utf8");

const deck = {
  title: "Test deck",
  activeSlide: 1,
  background: "orbit",
  accent: "#f6b84b",
  blocks: [
    { id: "heading", kind: "heading", label: "Heading", text: "Two\nlines" },
    { id: "metrics", kind: "metrics", label: "Metrics row", text: "3.2×|faster|42%|less <rework>" },
  ],
  slides: [{ id: "one" }, { id: "two" }],
};

test("slide markup carries the classes and ids the stylesheet and editor rely on", () => {
  const markup = renderSlideMarkup(deck);
  assert.match(markup, /<main class="weave-slide orbit" style="--accent: #f6b84b">/);
  assert.match(markup, /<h1 class="heading" data-weave-id="heading">Two\nlines<\/h1>/);
  assert.match(markup, /<div class="metrics" data-weave-id="metrics"><strong>3\.2×<\/strong><span>faster<\/span>/);
  assert.match(markup, /01 \/ 02/);
  assert.equal(markup.includes("<rework>"), false, "block text must be escaped");
});

test("exported slides inline the project stylesheet and stay self-contained", () => {
  const html = renderSlideDocument(deck, defaultDeckCss);
  assert.match(html, /\.weave-slide \.heading/);
  assert.equal(html.includes("<link"), false, "no external stylesheet");
  assert.equal(html.includes("http://"), false, "no external references");
  assert.match(html, new RegExp(`innerWidth / ${designWidth}`));
});

test("the stylesheet is authored at the fixed design size, not in responsive units", () => {
  assert.match(defaultDeckCss, new RegExp(`width: ${designWidth}px`));
  assert.match(defaultDeckCss, new RegExp(`height: ${designHeight}px`));
  for (const responsive of ["clamp(", "vw", "vh"]) {
    assert.equal(defaultDeckCss.includes(responsive), false, `design CSS must not use ${responsive}`);
  }
  for (const rule of defaultDeckCss.matchAll(/^([.#a-z][^{]*)\{/gm)) {
    assert.match(rule[1].trim(), /^\.weave-slide\b/, `every rule stays scoped to the slide: ${rule[1].trim()}`);
  }
});

test("slide styling exists in exactly one place", async () => {
  const [globals, page, project] = await Promise.all([
    read("../app/globals.css"),
    read("../app/page.tsx"),
    read("../server/project.mjs"),
  ]);
  /* The editor's stylesheet may style its own chrome, never the slide's content. */
  for (const duplicated of [".slide-canvas", ".slide-content", ".block-heading", ".block-paragraph", ".metric-grid", ".slide-index"]) {
    assert.equal(globals.includes(duplicated), false, `globals.css still styles slide content: ${duplicated}`);
  }
  assert.equal(project.includes("<style>"), false, "the exporter must not carry a second stylesheet");
  for (const source of [page, project]) {
    assert.match(source, /shared\/slide-design\.mjs/);
  }
});

test("structured containers and style tokens render recursively", () => {
  const markup = renderSlideMarkup({
    ...deck,
    blocks: [{
      id: "grid",
      kind: "grid",
      style: { columns: 3 },
      children: [{ id: "nested", kind: "heading", text: "Nested", style: { color: "accent", align: "center" } }],
    }],
  });
  assert.match(markup, /class="weave-container grid columns-3"/);
  assert.match(markup, /class="heading align-center color-accent" data-weave-id="nested"/);
});

test("complete deck export is offline and keyboard-presentable", () => {
  const fullDeck = {
    ...deck,
    slides: [
      { id: "one", title: "One", background: "orbit", blocks: deck.blocks },
      { id: "two", title: "Two", background: "plain", blocks: deck.blocks },
    ],
  };
  const html = renderDeckDocument(fullDeck, defaultDeckCss);
  assert.equal((html.match(/class="weave-slide/g) ?? []).length, 2);
  assert.match(html, /ArrowRight/);
  assert.match(html, /requestFullscreen/);
  assert.match(html, /@page\{size:13\.333in 7\.5in/);
  assert.match(html, /page-break-after:always/);
  assert.equal(html.includes("<link"), false);
});
