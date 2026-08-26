import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
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
    await writeFile(masterPath, master.replace("WEAVE", "CHANGED"));
    assert.match((await project.listProjects()).find((item) => item.slug === slug).thumbnailHtml, /CHANGED/);
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    if (previousWorkspaces === undefined) delete process.env.WEAVE_WORKSPACES_ROOT;
    else process.env.WEAVE_WORKSPACES_ROOT = previousWorkspaces;
    await rm(root, { recursive: true, force: true });
  }
});
