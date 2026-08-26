import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("template catalog stores one package with named layouts", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-template-package-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_PROJECT_ROOT = root;
  try {
    const project = await import(`../server/project.mjs?package=${Date.now()}`);
    const seeded = await project.ensureTemplates();
    assert.ok(seeded.includes("templates/year-end-report/template.json"));
    const report = (await project.readTemplates()).find((template) => template.id === "year-end-report");
    assert.deepEqual(report.layouts.map((layout) => layout.id), ["cover", "content", "agenda"]);
    assert.equal(report.defaultLayoutId, "cover");
    assert.equal(report.layouts.length, 3);
    assert.match(await readFile(join(root, "templates/year-end-report/master.html"), "utf8"), /data-weave-layout-slot/);
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("project creation persists explicit references and thumbnails compose inherited master", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-template-project-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  const previousWorkspaces = process.env.WEAVE_WORKSPACES_ROOT;
  process.env.WEAVE_WORKSPACES_ROOT = root;
  process.env.WEAVE_PROJECT_ROOT = join(root, "startup");
  try {
    const project = await import(`../server/project.mjs?create=${Date.now()}`);
    await project.ensureProject();
    const slug = await project.createProject({ title: "Report", templateId: "year-end-report" });
    const projectRoot = join(root, slug);
    const manifest = JSON.parse(await readFile(join(projectRoot, ".weave/deck.json"), "utf8"));
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.defaultTemplateId, "year-end-report");
    assert.deepEqual(manifest.slides[0], {
      id: "cover", title: "Report", notes: "", templateId: "year-end-report", layoutId: "cover", accent: "#fbbf24",
    });
    assert.match(await readFile(join(projectRoot, "slides/cover.html"), "utf8"), /data-weave-slide-source/);
    const masterPath = join(projectRoot, "templates/year-end-report/master.html");
    const master = await readFile(masterPath, "utf8");
    await writeFile(masterPath, master.replace("<div data-weave-layout-slot></div>", "<div>CHANGED</div><div data-weave-layout-slot></div>"));
    assert.match((await project.listProjects()).find((item) => item.slug === slug).thumbnailHtml, /CHANGED/);
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    if (previousWorkspaces === undefined) delete process.env.WEAVE_WORKSPACES_ROOT;
    else process.env.WEAVE_WORKSPACES_ROOT = previousWorkspaces;
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy rendered slides migrate without replacing project content or materializing furniture", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-template-legacy-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_PROJECT_ROOT = root;
  try {
    await mkdir(join(root, ".weave"), { recursive: true });
    await mkdir(join(root, "slides"), { recursive: true });
    await writeFile(join(root, ".weave/deck.json"), `${JSON.stringify({ title: "DTF", slides: [{ id: "cover", title: "DB automation", notes: "" }, { id: "legal", title: "Legal", notes: "" }] }, null, 2)}\n`);
    await writeFile(join(root, "slides/cover.html"), `<main class="weave-slide theme-plain bg-white" data-weave-slide data-weave-template="year-end-report-cover">
      <img class="report-frame" data-weave-id="cover-background" src="assets/background.png" alt="">
      <img class="report-brand-placeholder" data-weave-id="report-brand" src="assets/logo.png" alt="Logo">
      <p class="report-tagline" data-weave-id="tagline">Inherited tagline</p>
      <section class="content hero" data-weave-slot="content" data-weave-id="content">
        <h1 class="title heading" data-weave-slot="title" data-weave-id="title">DB automation</h1>
      </section>
      <p class="report-organization" data-weave-id="organization">Inherited organization</p>
      <aside data-weave-id="legal">CONFIDENTIAL-X</aside>
    </main>`);
    await writeFile(join(root, "slides/legal.html"), `<main class="weave-slide theme-plain" data-weave-template="year-end-report-cover"><aside data-weave-id="legal-2">UNMARKED-FURNITURE</aside><section data-weave-slot="content"><h1 data-weave-slot="title" data-weave-id="title-2">Legal</h1></section></main>`);
    const project = await import(`../server/project.mjs?legacy=${Date.now()}`);
    await project.ensureProject();
    const deck = await project.readProject();
    assert.equal(deck.title, "DTF");
    assert.equal(deck.slides.length, 2);
    assert.equal(deck.slides[0].templateId, "year-end-report");
    assert.match(deck.slides[0].layoutId, /^migrated-/);
    assert.match(deck.slides[0].html, /DB automation/);
    assert.doesNotMatch(deck.slides[0].html, /Inherited tagline|Inherited organization|report-frame/);
    const report = (await project.readTemplates()).find((template) => template.id === "year-end-report");
    const migrated = report.layouts.find((layout) => layout.id === deck.slides[0].layoutId);
    assert.match(migrated.html, /Inherited tagline/);
    assert.match(migrated.html, /Inherited organization/);
    assert.match(migrated.html, /CONFIDENTIAL-X/);
    assert.match(migrated.html, /class="report-logo"/);
    assert.doesNotMatch(migrated.html, />DB automation</);
    assert.match(report.layouts.find((layout) => layout.id === deck.slides[1].layoutId).html, /UNMARKED-FURNITURE/);
    JSON.parse(await readFile(join(root, "templates/year-end-report/template.json"), "utf8"));
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy projects remain reachable in the gallery before they are selected for migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-template-gallery-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  const previousWorkspaces = process.env.WEAVE_WORKSPACES_ROOT;
  process.env.WEAVE_WORKSPACES_ROOT = root;
  process.env.WEAVE_PROJECT_ROOT = join(root, "startup");
  try {
    for (const slug of ["first", "second"]) {
      await mkdir(join(root, slug, ".weave"), { recursive: true });
      await mkdir(join(root, slug, "slides"), { recursive: true });
      await writeFile(join(root, slug, ".weave/deck.json"), `${JSON.stringify({ title: slug, slides: [{ id: "cover", title: slug, notes: "" }] })}\n`);
      await writeFile(join(root, slug, "slides/cover.html"), `<main class="weave-slide theme-orbit"><section data-weave-slot="content"><h1 data-weave-slot="title">${slug}</h1></section></main>`);
    }
    const project = await import(`../server/project.mjs?gallery=${Date.now()}`);
    assert.deepEqual(new Set((await project.listProjects()).map(({ slug }) => slug)), new Set(["first", "second"]));
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    if (previousWorkspaces === undefined) delete process.env.WEAVE_WORKSPACES_ROOT;
    else process.env.WEAVE_WORKSPACES_ROOT = previousWorkspaces;
    await rm(root, { recursive: true, force: true });
  }
});

test("a malformed manifest is reported instead of being replaced with seed content", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-template-malformed-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_PROJECT_ROOT = root;
  try {
    await mkdir(join(root, ".weave"), { recursive: true });
    await writeFile(join(root, ".weave/deck.json"), "{broken");
    const project = await import(`../server/project.mjs?malformed=${Date.now()}`);
    await assert.rejects(project.readProject(), /JSON/);
    await assert.rejects(project.ensureProject(), /JSON/);
    assert.equal(await readFile(join(root, ".weave/deck.json"), "utf8"), "{broken");
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
