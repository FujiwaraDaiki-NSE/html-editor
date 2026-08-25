import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditContentPolicy } from "../shared/content-policy.mjs";
import { auditTailwindSlideHtml, defaultSlideClasses } from "../shared/tailwind-slide.mjs";
import { agentInstructions, builtInTemplates } from "../server/project.mjs";

test("agent instructions describe the template and slot vocabulary", () => {
  assert.match(agentInstructions, /templates\/<id>\.html/);
  assert.match(agentInstructions, /data-weave-slot="title"/);
  assert.match(agentInstructions, /data-weave-slot="content"/);
  assert.match(agentInstructions, /title slot's text is the slide name/);
  assert.match(agentInstructions, /do not edit the shared template frame in place/);
});

test("built-in templates are valid empty frames with the title first inside content", () => {
  assert.deepEqual(builtInTemplates.map(({ id }) => id), ["orbit", "grid", "plain", "year-end-report"]);
  const baseClasses = defaultSlideClasses.split(" ").filter((name) => name !== "bg-slate-950" && name !== "text-slate-50");
  const pairs = {
    orbit: ["theme-orbit", "bg-slate-950", "text-slate-50"],
    grid: ["theme-grid", "bg-slate-900", "text-slate-50"],
    plain: ["theme-plain", "bg-white", "text-slate-950"],
    "year-end-report": ["theme-plain", "bg-white", "text-slate-950"],
  };
  for (const template of builtInTemplates) {
    assert.equal(auditContentPolicy({ html: template.html }).ok, true, template.id);
    assert.deepEqual(auditTailwindSlideHtml(template.html), [], template.id);
    const main = template.html.match(/<main\b[^>]*>/i)?.[0] ?? "";
    const rootClasses = main.match(/\bclass="([^"]*)"/i)?.[1].split(/\s+/) ?? [];
    for (const className of [...baseClasses, ...pairs[template.id]]) assert.equal(rootClasses.includes(className), true, `${template.id}: ${className}`);
    assert.equal(rootClasses.filter((name) => name.startsWith("bg-")).length, 1, template.id);
    assert.equal(rootClasses.filter((name) => name === "text-slate-50" || name === "text-slate-950").length, 1, template.id);
    assert.equal(main.includes(`data-weave-template="${template.id}"`), true);
    assert.equal(main.includes(`data-weave-template-name="${template.name}"`), true);
    const content = template.html.match(/<section\b[^>]*data-weave-slot="content"[^>]*>([\s\S]*?)<\/section>/i)?.[1] ?? "";
    assert.match(content, /^\s*<h1\b[^>]*data-weave-slot="title"[^>]*data-weave-id="title"[^>]*><\/h1>\s*$/i);
    if (template.id === "year-end-report") {
      assert.match(template.html, /viewBox="0 0 1280 720"/);
      assert.match(template.html, /d="M0 0 L1280 0 C797\.33 24 402\.67 118 165\.33 285 C76 348 24 392 0 416 Z"/);
      assert.match(template.html, /x1="131" y1="69" x2="1280" y2="69" stroke="#e00000" stroke-width="2"/);
      assert.match(template.html, /x1="131" y1="662" x2="1280" y2="662" stroke="#004dff" stroke-width="2"/);
      assert.match(template.html, /data-weave-id="year-end-report-organization"/);
      assert.match(template.html, /data-weave-id="year-end-report-copyright"/);
      assert.match(template.html, /class="report-frame /);
      assert.match(template.html, /class="report-organization /);
      assert.match(template.html, /class="report-copyright /);
      assert.match(template.html, /class="page-number [^"]*" data-weave-id="year-end-report-page-number"/);
      assert.doesNotMatch(template.html, /style\s*=/i);
    }
  }
});

test("template seeding is idempotent and discovery skips bad files with sensible identity fallbacks", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-templates-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_PROJECT_ROOT = root;
  try {
    const project = await import(`../server/project.mjs?templates=${Date.now()}`);
    assert.deepEqual(await project.ensureTemplates(), ["templates/orbit.html", "templates/grid.html", "templates/plain.html", "templates/year-end-report.html"]);
    const firstOrbit = await readFile(join(root, "templates", "orbit.html"), "utf8");
    assert.deepEqual(await project.ensureTemplates(), []);
    assert.equal(await readFile(join(root, "templates", "orbit.html"), "utf8"), firstOrbit);

    await writeFile(join(root, "templates", "bad.html"), '<main class="weave-slide" data-weave-slide><script>alert(1)</script></main>');
    await writeFile(join(root, "templates", "fallback-card.html"), '<main class="weave-slide" data-weave-slide></main>');
    const templates = await project.readTemplates();
    assert.deepEqual(templates.map(({ id }) => id), ["fallback-card", "grid", "orbit", "plain", "year-end-report"]);
    assert.equal(templates.find(({ id }) => id === "fallback-card")?.name, "fallback-card");
    assert.equal(templates.some(({ id }) => id === "bad"), false);
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
