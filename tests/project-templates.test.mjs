import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditContentPolicy } from "../shared/content-policy.mjs";
import { auditTailwindSlideHtml, defaultSlideClasses } from "../shared/tailwind-slide.mjs";
import { builtInTemplates } from "../server/project.mjs";

test("built-in templates are valid empty frames with the title first inside content", () => {
  assert.deepEqual(builtInTemplates.map(({ id }) => id), ["orbit", "grid", "plain"]);
  const baseClasses = defaultSlideClasses.split(" ").filter((name) => name !== "bg-slate-950" && name !== "text-slate-50");
  const pairs = { orbit: ["bg-slate-950", "text-slate-50"], grid: ["bg-slate-900", "text-slate-50"], plain: ["bg-white", "text-slate-950"] };
  for (const template of builtInTemplates) {
    assert.equal(auditContentPolicy({ html: template.html }).ok, true, template.id);
    assert.deepEqual(auditTailwindSlideHtml(template.html), [], template.id);
    const main = template.html.match(/<main\b[^>]*>/i)?.[0] ?? "";
    const rootClasses = main.match(/\bclass="([^"]*)"/i)?.[1].split(/\s+/) ?? [];
    for (const className of [...baseClasses, `theme-${template.id}`, ...pairs[template.id]]) assert.equal(rootClasses.includes(className), true, `${template.id}: ${className}`);
    assert.equal(rootClasses.filter((name) => name.startsWith("bg-")).length, 1, template.id);
    assert.equal(rootClasses.filter((name) => name === "text-slate-50" || name === "text-slate-950").length, 1, template.id);
    assert.equal(main.includes(`data-weave-template="${template.id}"`), true);
    assert.equal(main.includes(`data-weave-template-name="${template.name}"`), true);
    const content = template.html.match(/<section\b[^>]*data-weave-slot="content"[^>]*>([\s\S]*?)<\/section>/i)?.[1] ?? "";
    assert.match(content, /^\s*<h1\b[^>]*data-weave-slot="title"[^>]*data-weave-id="title"[^>]*><\/h1>\s*$/i);
  }
});

test("template seeding is idempotent and discovery skips bad files with sensible identity fallbacks", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-templates-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_PROJECT_ROOT = root;
  try {
    const project = await import(`../server/project.mjs?templates=${Date.now()}`);
    assert.deepEqual(await project.ensureTemplates(), ["templates/orbit.html", "templates/grid.html", "templates/plain.html"]);
    const firstOrbit = await readFile(join(root, "templates", "orbit.html"), "utf8");
    assert.deepEqual(await project.ensureTemplates(), []);
    assert.equal(await readFile(join(root, "templates", "orbit.html"), "utf8"), firstOrbit);

    await writeFile(join(root, "templates", "bad.html"), '<main class="weave-slide" data-weave-slide><script>alert(1)</script></main>');
    await writeFile(join(root, "templates", "fallback-card.html"), '<main class="weave-slide" data-weave-slide></main>');
    const templates = await project.readTemplates();
    assert.deepEqual(templates.map(({ id }) => id), ["fallback-card", "grid", "orbit", "plain"]);
    assert.equal(templates.find(({ id }) => id === "fallback-card")?.name, "fallback-card");
    assert.equal(templates.some(({ id }) => id === "bad"), false);
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
