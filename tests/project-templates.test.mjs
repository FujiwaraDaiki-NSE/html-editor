import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditContentPolicy } from "../shared/content-policy.mjs";
import { auditTailwindSlideHtml, buildTailwindSlideCss, defaultSlideClasses } from "../shared/tailwind-slide.mjs";
import { agentInstructions, builtInTemplates } from "../server/project.mjs";

test("agent instructions describe the template and slot vocabulary", () => {
  assert.match(agentInstructions, /templates\/<id>\.html/);
  assert.match(agentInstructions, /data-weave-slot="title"/);
  assert.match(agentInstructions, /data-weave-slot="content"/);
  assert.match(agentInstructions, /these roles are semantic attributes, never CSS classes/);
  assert.match(agentInstructions, /do not add title or content to class/);
  assert.match(agentInstructions, /title slot's text is the slide name/);
  assert.match(agentInstructions, /do not edit the shared template frame in place/);
});

test("built-in templates are valid empty frames with the title first inside content", () => {
  assert.deepEqual(builtInTemplates.map(({ id }) => id), ["orbit", "grid", "plain", "year-end-report", "year-end-report-cover", "year-end-report-agenda"]);
  const baseClasses = defaultSlideClasses.split(" ").filter((name) => name !== "bg-slate-950" && name !== "text-slate-50");
  const pairs = {
    orbit: ["theme-orbit", "bg-slate-950", "text-slate-50"],
    grid: ["theme-grid", "bg-slate-900", "text-slate-50"],
    plain: ["theme-plain", "bg-white", "text-slate-950"],
    "year-end-report": ["theme-plain", "bg-white", "text-slate-950"],
    "year-end-report-cover": ["theme-plain", "bg-white", "text-slate-950"],
    "year-end-report-agenda": ["theme-plain", "bg-white", "text-slate-950"],
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
    if (template.id.startsWith("year-end-report")) {
      assert.match(template.html, /viewBox="0 0 1280 720"/);
      assert.match(template.html, /<linearGradient id="year-end-report(?:-cover|-agenda)?-gradient"/);
      assert.match(template.html, /class="report-frame /);
      for (const dummy of [
        "Organization Name",
        "© Organization Name",
        "BRAND",
        "TAGLINE",
        "SUBTITLE",
        "YYYY.MM.DD",
        "Department",
        "Contact",
        "report-organization",
        "report-copyright",
        "report-brand-placeholder",
        "report-tagline",
        "report-subtitle",
        "report-meta",
        "page-number",
      ]) assert.doesNotMatch(template.html, new RegExp(dummy), `${template.id}: ${dummy}`);
      if (template.id === "year-end-report") {
        assert.match(template.html, /d="M0 0 L1280 0 C797\.33 24 402\.67 118 165\.33 285 C76 348 24 392 0 416 Z"/);
        assert.match(template.html, /x1="131" y1="69" x2="1280" y2="69" stroke="#e00000" stroke-width="2"/);
        assert.match(template.html, /x1="131" y1="662" x2="1280" y2="662" stroke="#004dff" stroke-width="2"/);
      }
      if (template.id === "year-end-report-cover") {
        assert.match(template.html, /d="M0 396 C232 150 757\.33 22 1280 0 L1280 720 L0 720 Z"/);
        assert.match(template.html, /x1="280" y1="69" x2="1280" y2="69" stroke="#e00000" stroke-width="2"/);
        assert.match(template.html, /x1="280" y1="662" x2="1280" y2="662" stroke="#004dff" stroke-width="2"/);
        assert.match(template.html, /<img class="report-logo" data-weave-id="year-end-report-cover-logo" src="assets\/9442acd1fa8abd6f7e4eeac678dad653a43d2d63663c45c1c09775bbc0dcf0ee\.png" alt="NIPPON STEEL ENGINEERING">/);
      } else {
        assert.doesNotMatch(template.html, /class="report-logo"/);
      }
      if (template.id === "year-end-report-agenda") {
        assert.match(template.html, /d="M0 0 L1280 0 C797\.33 24 402\.67 118 165\.33 285 C76 348 24 392 0 416 Z"/);
        assert.match(template.html, /x1="186\.67" y1="69" x2="1280" y2="69" stroke="#e00000" stroke-width="2"/);
        assert.match(template.html, /x1="186\.67" y1="662" x2="1280" y2="662" stroke="#004dff" stroke-width="2"/);
      }
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
    const logoAsset = "assets/9442acd1fa8abd6f7e4eeac678dad653a43d2d63663c45c1c09775bbc0dcf0ee.png";
    assert.deepEqual(await project.ensureTemplates(), ["templates/orbit.html", "templates/grid.html", "templates/plain.html", "templates/year-end-report.html", "templates/year-end-report-cover.html", "templates/year-end-report-agenda.html", logoAsset]);
    const firstOrbit = await readFile(join(root, "templates", "orbit.html"), "utf8");
    const firstLogo = await readFile(join(root, logoAsset));
    assert.equal(firstLogo.length, 71263);
    assert.equal(firstLogo.readUInt32BE(16), 250);
    assert.equal(firstLogo.readUInt32BE(20), 372);
    assert.equal(createHash("sha256").update(firstLogo).digest("hex"), "9442acd1fa8abd6f7e4eeac678dad653a43d2d63663c45c1c09775bbc0dcf0ee");
    assert.deepEqual(await project.ensureTemplates(), []);
    assert.equal(await readFile(join(root, "templates", "orbit.html"), "utf8"), firstOrbit);
    assert.deepEqual(await readFile(join(root, logoAsset)), firstLogo);

    await writeFile(join(root, logoAsset), "stale logo");
    assert.deepEqual(await project.ensureTemplates(), [logoAsset]);
    const refreshedLogo = await readFile(join(root, logoAsset));
    assert.equal(refreshedLogo.length, 71263);
    assert.equal(createHash("sha256").update(refreshedLogo).digest("hex"), "9442acd1fa8abd6f7e4eeac678dad653a43d2d63663c45c1c09775bbc0dcf0ee");

    await writeFile(join(root, "templates", "bad.html"), '<main class="weave-slide" data-weave-slide><script>alert(1)</script></main>');
    await writeFile(join(root, "templates", "fallback-card.html"), '<main class="weave-slide" data-weave-slide></main>');
    const templates = await project.readTemplates();
    assert.deepEqual(templates.map(({ id }) => id), ["fallback-card", "grid", "orbit", "plain", "year-end-report-agenda", "year-end-report-cover", "year-end-report"]);
    assert.equal(templates.find(({ id }) => id === "fallback-card")?.name, "fallback-card");
    assert.equal(templates.some(({ id }) => id === "bad"), false);
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("year-end report variants expose the source-derived CSS geometry", () => {
  const css = buildTailwindSlideCss();
  assert.match(css, /data-weave-template="year-end-report"[\s\S]*padding: 0 33\.33px 58px/);
  assert.match(css, /data-weave-template="year-end-report"[\s\S]*letter-spacing: normal/);
  assert.match(css, /data-weave-template="year-end-report"[\s\S]*padding-top: 90px[\s\S]*overflow: hidden/);
  assert.match(css, /data-weave-template="year-end-report"[\s\S]*top: 26px[\s\S]*left: 44px[\s\S]*color: #000[\s\S]*max-height: 43px[\s\S]*overflow: hidden/);
  assert.doesNotMatch(css, /data-weave-template="year-end-report"[^}]*:has\(br\)/);
  assert.match(css, /data-weave-template="year-end-report-cover"[\s\S]*top: 324px[\s\S]*left: 74\.67px[\s\S]*width: 1040px[\s\S]*bottom: 58px[\s\S]*overflow: hidden/);
  assert.match(css, /data-weave-template="year-end-report-cover"[\s\S]*top: 264px[\s\S]*border-left: 8px solid #e00000/);
  assert.match(css, /data-weave-template="year-end-report-cover"[\s\S]*\.report-logo \{[\s\S]*top: 22px[\s\S]*left: 56px[\s\S]*width: 157\.33px[\s\S]*height: auto/);
  assert.match(css, /data-weave-template="year-end-report-cover"[\s\S]*bottom: 88px[\s\S]*gap: 12px/);
  assert.match(css, /data-weave-template="year-end-report-agenda"[\s\S]*padding: 132px 122\.67px 58px/);
  assert.match(css, /data-weave-template="year-end-report-cover"[\s\S]*letter-spacing: normal/);
  assert.match(css, /data-weave-template="year-end-report-agenda"[\s\S]*letter-spacing: normal/);
  assert.match(css, /data-weave-template="year-end-report-agenda"[\s\S]*justify-content: center[\s\S]*overflow: hidden/);
});
