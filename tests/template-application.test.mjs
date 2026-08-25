import assert from "node:assert/strict";
import test from "node:test";

import { auditContentPolicy } from "../shared/content-policy.mjs";
import { formatSlideHtml } from "../shared/html-format.mjs";
import { applyTemplateToSlideHtml, updateSlidePageNumber, withUniqueFragmentIds } from "../shared/slide-slots.mjs";
import { builtInTemplates } from "../server/project.mjs";

const template = (id) => builtInTemplates.find((item) => item.id === id)?.html ?? "";
const source = `<main class="weave-slide theme-orbit bg-slate-950 text-slate-50" data-weave-slide data-weave-template="orbit">
  <div class="brand">OLD FRAME</div>
  <section class="hero flex flex-1 flex-col" data-weave-slot="content">
    <div class="eyebrow text-sm text-teal-400" data-weave-id="eyebrow-7">Context</div>
    <h1 class="heading text-7xl font-bold" data-weave-slot="title" data-weave-id="heading-7">A <em>moving</em> title</h1>
    <p class="paragraph" data-weave-id="body-7">Supporting copy</p>
  </section>
  <div class="page-number">03 / 07</div>
</main>`;

test("template application keeps both slots once and lets the frame own title typography", () => {
  const result = applyTemplateToSlideHtml(source, template("plain"), { position: 3, total: 7, accent: "#2dd4bf" });
  assert.match(result, /data-weave-template="plain"/);
  assert.match(result, /<h1 class="heading text-6xl font-semibold leading-none tracking-tight" data-weave-slot="title" data-weave-id="heading-7">A <em>moving<\/em> title<\/h1>/);
  assert.doesNotMatch(result, /class="heading text-7xl/);
  for (const id of ["heading-7", "eyebrow-7", "body-7"]) assert.equal((result.match(new RegExp(`data-weave-id="${id}"`, "g")) ?? []).length, 1, id);
  assert.ok(result.indexOf('data-weave-id="heading-7"') < result.indexOf('data-weave-id="eyebrow-7"'));
  assert.ok(result.indexOf('data-weave-id="eyebrow-7"') < result.indexOf('data-weave-id="body-7"'));
  assert.match(result, /class="text-teal-400">●<\/span>/);
  assert.match(result, /<div class="page-number [^"]*">03 \/ 07<\/div>/);
  assert.equal(auditContentPolicy({ html: result }).ok, true);
});

test("applying template B then A round-trips after canonical HTML formatting", async () => {
  const original = applyTemplateToSlideHtml(source, template("orbit"), { position: 3, total: 7, accent: "#2dd4bf" });
  const changed = applyTemplateToSlideHtml(original, template("grid"), { position: 3, total: 7, accent: "#2dd4bf" });
  const restored = applyTemplateToSlideHtml(changed, template("orbit"), { position: 3, total: 7, accent: "#2dd4bf" });
  assert.equal(await formatSlideHtml(restored), await formatSlideHtml(original));
});

test("a slotless slide is appended intact inside the new frame", () => {
  const slotless = '<main class="weave-slide"><header class="brand" data-weave-id="legacy-brand">Legacy brand</header><article data-weave-id="legacy-content"><h1>Agent title</h1><p>Agent body</p></article><div class="page-number" data-weave-id="legacy-page">09 / 09</div></main>';
  const result = applyTemplateToSlideHtml(slotless, template("grid"), { position: 12, total: 20, accent: "#fbbf24" });
  for (const value of ["legacy-content", "Agent title", "Agent body"]) assert.equal((result.match(new RegExp(value, "g")) ?? []).length, 1, value);
  assert.equal((result.match(/\bclass="[^"]*\bbrand\b[^"]*"/g) ?? []).length, 1);
  assert.equal((result.match(/\bclass="[^"]*\bpage-number\b[^"]*"/g) ?? []).length, 1);
  assert.doesNotMatch(result, /legacy-brand|legacy-page|09 \/ 09/);
  assert.match(result, /12 \/ 20/);
  assert.equal(auditContentPolicy({ html: result }).ok, true);
});

test("the year-end report frame keeps its furniture and updates its page number", () => {
  const result = applyTemplateToSlideHtml(source, template("year-end-report"), { position: 4, total: 12, accent: "#fbbf24" });
  assert.match(result, /data-weave-template="year-end-report"/);
  assert.match(result, /data-weave-id="year-end-report-organization">Organization Name<\/div>/);
  assert.match(result, /data-weave-id="year-end-report-copyright">© Organization Name<\/div>/);
  assert.match(result, /class="report-frame /);
  assert.match(result, /class="report-organization /);
  assert.match(result, /class="report-copyright /);
  assert.match(result, /data-weave-id="year-end-report-page-number">04 \/ 12<\/div>/);
  assert.match(result, /viewBox="0 0 1280 720"/);
  assert.equal(auditContentPolicy({ html: result }).ok, true);
});

test("report layout hooks survive new-slide id remapping", () => {
  const applied = applyTemplateToSlideHtml(source, template("year-end-report"));
  const remapped = applied.replace(/\bdata-weave-id\s*=\s*(["'])(.*?)\1/gi, (_, quote) => `data-weave-id=${quote}block-generated${quote}`);
  for (const className of ["report-frame", "report-organization", "report-copyright", "page-number"]) {
    assert.match(remapped, new RegExp(`class="[^"]*\\b${className}\\b`));
  }
});

test("page numbers are recalculated after deck mutations", () => {
  const first = applyTemplateToSlideHtml(source, template("year-end-report"), { position: 1, total: 1 });
  const second = applyTemplateToSlideHtml(source, template("year-end-report"), { position: 2, total: 2 });
  const numbered = [first, second].map((html, index, deck) => updateSlidePageNumber(html, index + 1, deck.length));
  assert.match(numbered[0], />01 \/ 02<\/div>/);
  assert.match(numbered[1], />02 \/ 02<\/div>/);
});

test("page numbering targets the frame footer when content uses the same class", () => {
  const withContentPage = source.replace('<p class="paragraph" data-weave-id="body-7">Supporting copy</p>', '<p class="page-number" data-weave-id="body-7">Content label</p>');
  const applied = applyTemplateToSlideHtml(withContentPage, template("year-end-report"), { position: 4, total: 8 });
  assert.match(applied, /data-weave-id="body-7">Content label<\/p>/);
  assert.match(applied, /data-weave-id="year-end-report-page-number">04 \/ 08<\/div>/);
  const renumbered = updateSlidePageNumber(applied, 5, 9);
  assert.match(renumbered, /data-weave-id="body-7">Content label<\/p>/);
  assert.match(renumbered, /data-weave-id="year-end-report-page-number">05 \/ 09<\/div>/);
});

test("page numbering supports a nested frame footer outside content", () => {
  const nested = template("plain").replace('<div class="page-number absolute top-0 right-0 p-8 text-xs font-semibold tracking-widest text-slate-400">01 / 01</div>', '<footer><div class="page-number">01 / 01</div></footer>');
  const applied = applyTemplateToSlideHtml(source, nested, { position: 3, total: 6 });
  assert.match(applied, /<footer><div class="page-number">03 \/ 06<\/div><\/footer>/);
  assert.match(updateSlidePageNumber(applied, 4, 7), /<footer><div class="page-number">04 \/ 07<\/div><\/footer>/);
});

test("template instances receive unique SVG fragment ids", () => {
  const first = applyTemplateToSlideHtml(source, template("year-end-report"), { instanceId: "slide-a" });
  const second = applyTemplateToSlideHtml(source, template("year-end-report"), { instanceId: "slide-b" });
  assert.match(first, /id="year-end-report-gradient-slide-a"/);
  assert.match(first, /fill="url\(#year-end-report-gradient-slide-a\)"/);
  assert.match(second, /id="year-end-report-gradient-slide-b"/);
  assert.match(second, /fill="url\(#year-end-report-gradient-slide-b\)"/);
});

test("duplicating an instantiated slide re-instances its SVG fragment ids", () => {
  const sourceSlide = applyTemplateToSlideHtml(source, template("year-end-report"), { instanceId: "slide-a" });
  const duplicate = withUniqueFragmentIds(sourceSlide, "slide-a-copy");
  assert.match(sourceSlide, /id="year-end-report-gradient-slide-a"/);
  assert.match(duplicate, /id="year-end-report-gradient-slide-a-slide-a-copy"/);
  assert.match(duplicate, /fill="url\(#year-end-report-gradient-slide-a-slide-a-copy\)"/);
  assert.doesNotMatch(duplicate, /id="year-end-report-gradient-slide-a"/);
});
