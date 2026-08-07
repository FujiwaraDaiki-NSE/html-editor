import assert from "node:assert/strict";
import test from "node:test";

import { auditContentPolicy } from "../shared/content-policy.mjs";
import { formatSlideHtml } from "../shared/html-format.mjs";
import { applyTemplateToSlideHtml } from "../shared/slide-slots.mjs";
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
