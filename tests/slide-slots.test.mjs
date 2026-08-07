import assert from "node:assert/strict";
import test from "node:test";

import { formatSlideHtml } from "../shared/html-format.mjs";
import { titleFromSlideHtml } from "../shared/slide-slots.mjs";
import { migrateSlideHtmlToTailwind } from "../shared/tailwind-slide.mjs";

const classesFor = (html, id) => {
  const opening = html.match(new RegExp(`<[^>]*data-weave-id="${id}"[^>]*>`))?.[0] ?? "";
  return opening.match(/\bclass="([^"]*)"/)?.[1].split(/\s+/).filter(Boolean) ?? [];
};

test("slide migration tags the first hero heading in place without changing its classes", () => {
  const input = '<main class="weave-slide plain"><div class="brand">Brand</div><section class="hero"><p class="paragraph" data-weave-id="p1">Before</p><h1 class="custom-title text-7xl" data-weave-id="h1">A &amp; B</h1><h1 class="heading" data-weave-id="h2">Second</h1></section></main>';
  const migrated = migrateSlideHtmlToTailwind(input);
  const content = migrated.match(/<section[^>]*data-weave-slot="content"[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? "";
  assert.match(content, /<h1 class="custom-title text-7xl" data-weave-id="h1" data-weave-slot="title">A &amp; B<\/h1>/);
  assert.ok(content.indexOf('data-weave-id="p1"') < content.indexOf('data-weave-id="h1"'), "content order stays unchanged");
  assert.equal((content.match(/data-weave-slot="title"/g) ?? []).length, 1, "only the first heading is tagged");
  assert.equal(migrateSlideHtmlToTailwind(migrated), migrated);
});

test("slide migration creates a deterministic unique empty title when the hero has no heading", () => {
  const input = '<main><section class="hero"><p class="paragraph" data-weave-id="body">Body</p></section></main>';
  const migrated = migrateSlideHtmlToTailwind(input);
  const titleId = migrated.match(/data-weave-slot="title" data-weave-id="([^"]+)"/)?.[1];
  assert.ok(titleId);
  assert.notEqual(titleId, "body");
  assert.match(migrated, /<section class="hero [^"]*" data-weave-slot="content"><h1 class="heading text-6xl font-semibold leading-none tracking-tight text-slate-50" data-weave-slot="title" data-weave-id="[^"]+"><\/h1><p/);
  assert.equal(migrateSlideHtmlToTailwind(input), migrated, "the same source produces the same id");
  assert.equal(migrateSlideHtmlToTailwind(migrated), migrated);
});

test("slide migration uses the first direct flex-1 child when there is no hero", () => {
  const input = '<main><header><div class="flex-1" data-weave-id="nested">Not the flow region</div></header><section class="relative flex flex-1 flex-col" data-weave-id="content"><div><h1 class="text-5xl font-semibold" data-weave-id="heading">Title</h1></div></section></main>';
  const migrated = migrateSlideHtmlToTailwind(input);
  assert.doesNotMatch(migrated, /data-weave-id="nested"[^>]*data-weave-slot/);
  assert.match(migrated, /<section class="relative flex flex-1 flex-col" data-weave-id="content" data-weave-slot="content">/);
  assert.match(migrated, /<h1 class="text-5xl font-semibold" data-weave-id="heading" data-weave-slot="title">Title<\/h1>/);
  assert.equal(migrateSlideHtmlToTailwind(migrated), migrated);
});

test("an agent-authored slide migrates without moving its title or changing title classes", () => {
  const input = '<main class="weave-slide relative flex h-full w-full flex-col overflow-hidden bg-slate-950 p-16 text-slate-50 theme-orbit" data-weave-slide=""><img class="absolute inset-0 h-full w-full object-cover object-center" src="assets/example.png" alt="Example"><div class="brand relative flex items-center gap-2" data-weave-id="brand-1">WEAVE</div><section class="relative flex flex-1 flex-col items-start justify-center gap-6" data-weave-id="hero-1"><div class="text-sm font-bold uppercase" data-weave-id="eyebrow-1">SHOWCASE</div><h1 class="max-w-3xl text-7xl font-extrabold leading-none tracking-tight text-slate-50" data-weave-id="heading-1">Make ideas visible.</h1><p class="max-w-xl text-lg leading-relaxed text-slate-300" data-weave-id="paragraph-1">Supporting copy.</p></section></main>';
  const migrated = migrateSlideHtmlToTailwind(input);
  const content = migrated.match(/<section[^>]*data-weave-slot="content"[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? "";
  assert.match(content, /<h1 class="max-w-3xl text-7xl font-extrabold leading-none tracking-tight text-slate-50" data-weave-id="heading-1" data-weave-slot="title">/);
  assert.ok(content.indexOf('data-weave-id="eyebrow-1"') < content.indexOf('data-weave-id="heading-1"'));
  assert.ok(content.indexOf('data-weave-id="heading-1"') < content.indexOf('data-weave-id="paragraph-1"'));
  assert.equal(migrateSlideHtmlToTailwind(migrated), migrated);
});

test("slide migration leaves html without a hero or direct flex-1 region untouched", () => {
  const input = "<main><p>No slot target</p></main>";
  assert.equal(migrateSlideHtmlToTailwind(input), input);
});

test("inheritance migration strips only legacy paragraph and non-title heading defaults", () => {
  const input = '<main class="weave-slide theme-orbit" data-weave-slide><section class="hero" data-weave-slot="content"><h1 class="heading text-6xl font-semibold leading-none tracking-tight text-slate-50" data-weave-slot="title" data-weave-id="title">Title</h1><h2 class="heading text-6xl font-semibold leading-none tracking-tight text-slate-50" data-weave-id="heading">Heading</h2><h2 class="heading text-5xl text-slate-400" data-weave-id="custom-heading">Custom heading</h2><p class="paragraph max-w-3xl text-lg leading-normal text-slate-300" data-weave-id="paragraph">Body</p><p class="paragraph text-5xl text-slate-400 text-amber-400" data-weave-id="custom">Custom</p><div class="eyebrow text-sm font-bold uppercase tracking-widest text-amber-400" data-weave-id="eyebrow">Label</div><div class="note mt-6 text-xs font-semibold uppercase tracking-widest text-slate-400" data-weave-id="note">Note</div><div class="metrics grid grid-cols-4" data-weave-id="metrics"><strong class="text-3xl text-amber-400" data-weave-id="metric">24%</strong><span class="text-xs text-slate-400" data-weave-id="caption">growth</span></div></section></main>';
  const migrated = migrateSlideHtmlToTailwind(input);
  assert.deepEqual(classesFor(migrated, "title"), ["heading", "text-6xl", "font-semibold", "leading-none", "tracking-tight", "text-slate-50"]);
  assert.equal(classesFor(migrated, "heading").includes("text-6xl"), false);
  assert.equal(classesFor(migrated, "heading").includes("text-slate-50"), false);
  for (const className of ["text-5xl", "text-slate-400"]) assert.ok(classesFor(migrated, "custom-heading").includes(className));
  assert.equal(classesFor(migrated, "paragraph").includes("text-lg"), false);
  assert.equal(classesFor(migrated, "paragraph").includes("text-slate-300"), false);
  for (const className of ["text-5xl", "text-slate-400", "text-amber-400"]) assert.ok(classesFor(migrated, "custom").includes(className));
  for (const [id, className] of [["eyebrow", "text-sm"], ["eyebrow", "text-amber-400"], ["note", "text-xs"], ["metric", "text-amber-400"], ["caption", "text-xs"]]) assert.ok(classesFor(migrated, id).includes(className));
  assert.equal(migrateSlideHtmlToTailwind(migrated), migrated);
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
