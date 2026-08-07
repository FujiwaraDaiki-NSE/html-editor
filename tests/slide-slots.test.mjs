import assert from "node:assert/strict";
import test from "node:test";

import { formatSlideHtml } from "../shared/html-format.mjs";
import { titleFromSlideHtml } from "../shared/slide-slots.mjs";
import { migrateSlideHtmlToTailwind } from "../shared/tailwind-slide.mjs";

test("slide migration lifts the first hero heading into the title slot", () => {
  const input = '<main class="weave-slide plain"><div class="brand">Brand</div><section class="hero"><p class="paragraph" data-weave-id="p1">Before</p><h1 class="heading custom" data-weave-id="h1">A &amp; B</h1><h1 class="heading" data-weave-id="h2">Second</h1></section></main>';
  const migrated = migrateSlideHtmlToTailwind(input);
  assert.match(migrated, /<h1 class="heading custom [^"]*" data-weave-id="h1" data-weave-slot="title">A &amp; B<\/h1>\s*<section class="hero [^"]*" data-weave-slot="content">/);
  const content = migrated.match(/<section[^>]*data-weave-slot="content"[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? "";
  assert.equal(content.includes('data-weave-id="h1"'), false);
  assert.equal(content.includes('data-weave-id="h2"'), true, "only the first heading is lifted");
  assert.equal(migrateSlideHtmlToTailwind(migrated), migrated);
});

test("slide migration creates a deterministic unique empty title when the hero has no heading", () => {
  const input = '<main><section class="hero"><p class="paragraph" data-weave-id="body">Body</p></section></main>';
  const migrated = migrateSlideHtmlToTailwind(input);
  const titleId = migrated.match(/data-weave-slot="title" data-weave-id="([^"]+)"/)?.[1];
  assert.ok(titleId);
  assert.notEqual(titleId, "body");
  assert.match(migrated, /<h1 class="heading text-6xl font-semibold leading-none tracking-tight text-slate-50" data-weave-slot="title" data-weave-id="[^"]+"><\/h1>\s*<section class="hero [^"]*" data-weave-slot="content">/);
  assert.equal(migrateSlideHtmlToTailwind(input), migrated, "the same source produces the same id");
  assert.equal(migrateSlideHtmlToTailwind(migrated), migrated);
});

test("slide migration leaves html without a hero untouched", () => {
  const input = "<main><p>No slot target</p></main>";
  assert.equal(migrateSlideHtmlToTailwind(input), input);
});

test("titleFromSlideHtml returns plain decoded title text", () => {
  const html = '<main><h1 data-weave-slot="title">Q3 &amp; Q4<br><span>growth</span> &#x1f680;</h1></main>';
  assert.equal(titleFromSlideHtml(html), "Q3 & Q4 growth 🚀");
});

test("titleFromSlideHtml returns an empty string for an empty title", () => {
  assert.equal(titleFromSlideHtml('<h1 data-weave-slot="title"></h1>'), "");
});

test("titleFromSlideHtml preserves a manifest title when the title slot is absent", () => {
  const title = "Agent-authored title";
  const derived = titleFromSlideHtml('<main><section class="content">Body</section></main>');
  assert.equal(derived, null);
  assert.equal(derived ?? title, title);
});

test("a long title stays clean through the canonical formatter", async () => {
  const title = "Make ideas visible while keeping every collaborator aligned around the decisions that matter most.";
  const formatted = await formatSlideHtml(`<main class="weave-slide"><h1 class="heading text-6xl font-semibold leading-none tracking-tight text-slate-50" data-weave-slot="title" data-weave-id="heading-long">${title}</h1><section class="hero" data-weave-slot="content"></section></main>`);
  assert.match(formatted, /data-weave-id="heading-long"\s*>\s*\n/);
  assert.equal(titleFromSlideHtml(formatted), title);
  assert.equal(titleFromSlideHtml(formatted)?.includes("\n"), false);
});

test("a title with br has one value before and after formatting", async () => {
  const html = '<main><h1 data-weave-slot="title">Make ideas visible,<br>while moving</h1></main>';
  const title = titleFromSlideHtml(html);
  assert.equal(title, "Make ideas visible, while moving");
  assert.equal(titleFromSlideHtml(await formatSlideHtml(html)), title);
});
