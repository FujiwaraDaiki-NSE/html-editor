import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  defaultDeckCss,
  designHeight,
  designWidth,
  renderDeckDocument,
  renderSlideDocument,
  slideFragmentFromBlocks,
} from "../shared/slide-design.mjs";

const read = (file) => readFile(new URL(file, import.meta.url), "utf8");

const blocks = [
  { id: "heading", kind: "heading", text: "Two\nlines" },
  { id: "metrics", kind: "metrics", text: "3.2×|faster|42%|less <rework>" },
];
const fragment = (overrides = {}) => slideFragmentFromBlocks({ background: "orbit", accent: "#f6b84b", total: 2, position: 1, blocks, ...overrides });

test("the seed fragment carries the classes and ids the stylesheet and editor rely on", () => {
  const markup = fragment();
  assert.match(markup, /<main class="weave-slide [^"]*bg-slate-950[^"]*" data-weave-slide>/);
  assert.equal(markup.includes(" style="), false, "slide styling must stay in Tailwind classes");
  assert.match(markup, /<h1 class="heading [^"]*text-6xl[^"]*" data-weave-id="heading">Two<br>lines<\/h1>/);
  assert.match(markup, /<div class="metrics [^"]*grid-cols-4[^"]*" data-weave-id="metrics"><strong class="[^"]*text-3xl/);
  assert.match(markup, /01 \/ 02/);
  assert.equal(markup.includes("<rework>"), false, "block text must be escaped");
});

test("line breaks in slide text are <br>, never literal newlines", () => {
  const markup = fragment();
  const heading = markup.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)[1];
  assert.equal(heading.includes("\n"), false, "a literal newline would be collapsed by the formatter");
  assert.match(heading, /Two<br>lines/);
});

test("exported slides inline the project stylesheet and stay self-contained", () => {
  const html = renderSlideDocument(fragment(), defaultDeckCss, "Test slide");
  assert.match(html, /\.weave-slide \.text-6xl/);
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

test("generated theme backgrounds remain visible and follow Tailwind accent colors", () => {
  assert.match(defaultDeckCss, /\.weave-slide\.theme-grid \{/);
  assert.match(defaultDeckCss, /background-size: 40px 40px/);
  assert.match(defaultDeckCss, /\.weave-slide\.theme-orbit::after/);
  assert.match(defaultDeckCss, /:has\(\.text-teal-400\)/);
  assert.match(defaultDeckCss, /var\(--weave-accent\)/);
});

test("design CSS relies on <br>, not white-space: pre (the formatter reflows text)", () => {
  /* Prettier reindents/wraps long text; under white-space: pre-wrap that indentation would
     surface as visible spaces after a save. Line breaks are <br> elements instead. */
  assert.equal(/white-space:\s*pre/.test(defaultDeckCss), false, "design CSS must not use white-space: pre*");
});

test("slide styling exists in exactly one place", async () => {
  const [globals, page, project] = await Promise.all([
    read("../app/globals.css"),
    read("../app/page.tsx"),
    read("../server/project.mjs"),
  ]);
  for (const duplicated of [".slide-canvas", ".slide-content", ".block-heading", ".block-paragraph", ".metric-grid", ".slide-index"]) {
    assert.equal(globals.includes(duplicated), false, `globals.css still styles slide content: ${duplicated}`);
  }
  assert.equal(project.includes("<style>"), false, "the exporter must not carry a second stylesheet");
  for (const source of [page, project]) {
    assert.match(source, /shared\/slide-design\.mjs/);
  }
});

test("structured containers render recursively", () => {
  const markup = slideFragmentFromBlocks({
    background: "orbit",
    accent: "#f6b84b",
    total: 1,
    position: 1,
    blocks: [{
      id: "grid",
      kind: "grid",
      children: [{ id: "nested", kind: "heading", text: "Nested" }],
    }],
  });
  assert.match(markup, /class="weave-container grid [^"]*grid-cols-2[^"]*" data-weave-id="grid"/);
  assert.match(markup, /<h1 class="heading [^"]*text-6xl[^"]*" data-weave-id="nested">Nested<\/h1>/);
});

test("complete deck export is offline and keyboard-presentable", () => {
  const html = renderDeckDocument([fragment({ position: 1 }), fragment({ position: 2, background: "plain" })], defaultDeckCss, "Full deck");
  assert.equal((html.match(/class="weave-slide/g) ?? []).length, 2);
  assert.match(html, /ArrowRight/);
  assert.match(html, /requestFullscreen/);
  assert.match(html, /@page\{size:13\.333in 7\.5in/);
  assert.match(html, /page-break-after:always/);
  assert.equal(html.includes("<link"), false);
});
