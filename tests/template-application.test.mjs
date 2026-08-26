import assert from "node:assert/strict";
import test from "node:test";

import { auditContentPolicy } from "../shared/content-policy.mjs";
import { formatSlideHtml } from "../shared/html-format.mjs";
import { composeSlideHtml, extractSlideSourceHtml, updateSlidePageNumber, withUniqueFragmentIds } from "../shared/slide-slots.mjs";
import { builtInTemplates } from "../server/project.mjs";

const template = (id, layoutId = "content") => {
  const item = builtInTemplates.find((candidate) => candidate.id === id);
  const layout = item?.layouts.find((candidate) => candidate.id === layoutId);
  return { templateId: id, layoutId, masterHtml: item?.masterHtml ?? "", layoutHtml: layout?.html ?? "" };
};
const apply = (sourceHtml, id, layoutId = "content", options = {}) => composeSlideHtml({ slideHtml: sourceHtml, ...template(id, layoutId), position: 1, total: 1, accent: "#fbbf24", ...options });
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
  const result = apply(source, "plain", "content", { position: 3, total: 7, accent: "#2dd4bf" });
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
  const original = apply(source, "orbit", "content", { position: 3, total: 7, accent: "#2dd4bf" });
  const changed = apply(extractSlideSourceHtml(original, { templateId: "grid", layoutId: "content", accent: "#2dd4bf" }), "grid", "content", { position: 3, total: 7, accent: "#2dd4bf" });
  const restored = apply(extractSlideSourceHtml(changed, { templateId: "orbit", layoutId: "content", accent: "#2dd4bf" }), "orbit", "content", { position: 3, total: 7, accent: "#2dd4bf" });
  assert.equal(await formatSlideHtml(restored), await formatSlideHtml(original));
});

test("a source slide composes only through the selected layout", () => {
  const sourceSlide = '<main data-weave-slide-source><section data-weave-slot="content"><h1 data-weave-slot="title" data-weave-id="title">Agent title</h1><p data-weave-id="legacy-content">Agent body</p></section></main>';
  const result = apply(sourceSlide, "grid", "content", { position: 12, total: 20, accent: "#fbbf24" });
  for (const value of ["legacy-content", "Agent title", "Agent body"]) assert.equal((result.match(new RegExp(value, "g")) ?? []).length, 1, value);
  assert.equal((result.match(/\bclass="[^"]*\bbrand\b[^"]*"/g) ?? []).length, 1);
  assert.equal((result.match(/\bclass="[^"]*\bpage-number\b[^"]*"/g) ?? []).length, 1);
  assert.match(result, /12 \/ 20/);
  assert.equal(auditContentPolicy({ html: result }).ok, true);
});

test("the year-end report frame keeps its SVG and omits placeholder furniture", () => {
  const result = apply(source, "year-end-report", "content", { position: 4, total: 12, accent: "#fbbf24" });
  assert.match(result, /data-weave-template="year-end-report"/);
  assert.match(result, /class="report-frame /);
  assert.match(result, /viewBox="0 0 1280 720"/);
  for (const dummy of ["Organization Name", "© Organization Name", "BRAND", "TAGLINE", "SUBTITLE", "YYYY.MM.DD", "Department", "Contact", "report-organization", "report-copyright", "report-brand-placeholder", "report-tagline", "report-subtitle", "report-meta"]) {
    assert.doesNotMatch(result, new RegExp(dummy), dummy);
  }
  assert.equal(auditContentPolicy({ html: result }).ok, true);
});

test("report layout hooks survive new-slide id remapping", () => {
  const applied = apply(source, "year-end-report");
  const remapped = applied.replace(/\bdata-weave-id\s*=\s*(["'])(.*?)\1/gi, (_, quote) => `data-weave-id=${quote}block-generated${quote}`);
  for (const className of ["report-frame"]) {
    assert.match(remapped, new RegExp(`class="[^"]*\\b${className}\\b`));
  }
});

test("page numbering supports a nested frame footer outside content", () => {
  const nested = template("plain").masterHtml.replace('<div class="page-number absolute top-0 right-0 p-8 text-xs font-semibold tracking-widest text-slate-400">01 / 01</div>', '<footer><div class="page-number">01 / 01</div></footer>');
  const applied = composeSlideHtml({ slideHtml: source, ...template("plain"), masterHtml: nested, position: 3, total: 6, accent: "#fbbf24" });
  assert.match(applied, /<footer><div class="page-number">03 \/ 06<\/div><\/footer>/);
  assert.match(updateSlidePageNumber(applied, 4, 7), /<footer><div class="page-number">04 \/ 07<\/div><\/footer>/);
});

test("template instances receive unique report SVG fragment ids", () => {
  const first = apply(source, "year-end-report", "content", { instanceId: "slide-a" });
  const second = apply(source, "year-end-report", "content", { instanceId: "slide-b" });
  assert.match(first, /id="year-end-report-gradient-slide-a"/);
  assert.match(first, /fill="url\(#year-end-report-gradient-slide-a\)"/);
  assert.match(second, /id="year-end-report-gradient-slide-b"/);
  assert.match(second, /fill="url\(#year-end-report-gradient-slide-b\)"/);
});

test("duplicating an instantiated slide re-instances its SVG fragment ids", () => {
  const sourceSlide = apply(source, "year-end-report", "content", { instanceId: "slide-a" });
  const duplicate = withUniqueFragmentIds(sourceSlide, "slide-a-copy");
  assert.match(sourceSlide, /id="year-end-report-gradient-slide-a"/);
  assert.match(duplicate, /id="year-end-report-gradient-slide-a-slide-a-copy"/);
  assert.match(duplicate, /fill="url\(#year-end-report-gradient-slide-a-slide-a-copy\)"/);
  assert.doesNotMatch(duplicate, /id="year-end-report-gradient-slide-a"/);
});

test("hierarchical composition inserts a layout into the master and fills the editable slots", () => {
  const masterHtml = `<main class="weave-slide master" data-weave-slide><div class="master-brand">MASTER</div><div data-weave-layout-slot></div><div class="page-number">01 / 01</div><svg><defs><linearGradient id="master-gradient" /></defs><path fill="url(#master-gradient)" /></svg></main>`;
  const layoutHtml = `<section class="content-layout"><section data-weave-slot="content"><h1 class="layout-heading" data-weave-slot="title" data-weave-id="layout-title"></h1></section></section>`;
  const slideHtml = `<main data-weave-slide-source data-weave-template="old" data-weave-layout="old" data-weave-accent="#fbbf24"><section data-weave-slot="content"><h1 data-weave-slot="title" data-weave-id="slide-title">Quarterly <em>review</em></h1><p data-weave-id="body">Supporting copy</p></section></main>`;
  const result = composeSlideHtml({ slideHtml, masterHtml, layoutHtml, templateId: "annual-report", layoutId: "content", position: 2, total: 8, accent: "#2dd4bf", instanceId: "slide-2" });

  assert.match(result, /data-weave-template="annual-report"/);
  assert.match(result, /data-weave-layout="content"/);
  assert.match(result, /data-weave-accent="#2dd4bf"/);
  assert.match(result, /class="master-brand">MASTER/);
  assert.match(result, /class="layout-heading"[^>]*data-weave-id="slide-title">Quarterly <em>review<\/em>/);
  assert.match(result, /data-weave-id="body">Supporting copy/);
  assert.match(result, /class="page-number">02 \/ 08<\/div>/);
  assert.match(result, /id="master-gradient-slide-2"/);
  assert.match(result, /url\(#master-gradient-slide-2\)/);
  assert.equal((result.match(/data-weave-slot="title"/g) ?? []).length, 1);
  assert.equal((result.match(/data-weave-slot="content"/g) ?? []).length, 1);
});

test("hierarchical extraction keeps only title/content and round-trips without inherited furniture", () => {
  const rendered = `<main class="weave-slide" data-weave-template="annual-report" data-weave-layout="content" data-weave-accent="#2dd4bf"><header class="master-brand">MASTER</header><div data-weave-layout-slot><section class="content-layout"><section class="layout-content" data-weave-slot="content"><h1 class="layout-heading" data-weave-slot="title" data-weave-id="slide-title">Quarterly review</h1><p data-weave-id="body">Supporting copy</p></section></section></div><footer class="page-number">02 / 08</footer></main>`;
  const sourceHtml = extractSlideSourceHtml(rendered, { templateId: "annual-report", layoutId: "content", accent: "#2dd4bf" });

  assert.match(sourceHtml, /^<main data-weave-slide-source data-weave-template="annual-report" data-weave-layout="content" data-weave-accent="#2dd4bf">/);
  assert.doesNotMatch(sourceHtml, /master-brand|layout-content|layout-heading|page-number|data-weave-layout-slot/);
  assert.match(sourceHtml, /<h1 data-weave-slot="title" data-weave-id="slide-title">Quarterly review<\/h1>/);
  assert.match(sourceHtml, /<p data-weave-id="body">Supporting copy<\/p>/);
});

test("hierarchical composition rejects incomplete masters, layouts, and slide sources", () => {
  const args = { slideHtml: '<main><section data-weave-slot="content"><h1 data-weave-slot="title"></h1></section></main>', masterHtml: '<main><div data-weave-layout-slot></div></main>', layoutHtml: '<section><h1 data-weave-slot="title"></h1></section>', templateId: "template", layoutId: "layout", position: 1, total: 1, accent: "#fbbf24" };
  assert.throws(() => composeSlideHtml({ ...args, layoutHtml: "" }), /layoutHtml is required/);
  assert.throws(() => composeSlideHtml({ ...args, masterHtml: "<main></main>" }), /data-weave-layout-slot/);
  assert.throws(() => composeSlideHtml({ ...args, slideHtml: "<main></main>" }), /exactly one content slot/);
  assert.throws(() => composeSlideHtml(args), /layoutHtml must contain exactly one content slot/);
  assert.throws(() => composeSlideHtml({ ...args, layoutHtml: '<section data-weave-slot="content"><h1 data-weave-slot="title"></h1><aside>Inherited decoration</aside></section>' }), /may contain only its title slot/);
  assert.throws(() => composeSlideHtml({ ...args, slideHtml: '<main><section data-weave-slot="content"><h1 data-weave-slot="title"></h1></section><section data-weave-slot="content"></section></main>', layoutHtml: '<section data-weave-slot="content"><h1 data-weave-slot="title"></h1></section>' }), /exactly one content slot/);
});
