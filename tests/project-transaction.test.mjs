import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

test("deck saves are revision-guarded, replace slide files, and restore history on main", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-project-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_PROJECT_ROOT = root;
  try {
    const project = await import(`../server/project.mjs?transaction=${Date.now()}`);
    await project.ensureProject();

    const initial = await project.readProject();
    const initialRevision = project.getRevision();
    assert.match(initialRevision, /^[0-9a-f]{40}$/);
    assert.equal(project.projectState().project.revision, initialRevision);
    assert.equal((await readdir(join(root, ".weave"))).includes("current-buffer.json"), false);

    const onlySlide = { ...initial.slides[0], id: "renamed-slide", title: "Renamed and saved" };
    const saved = { title: "Transactional deck", defaultTemplateId: initial.defaultTemplateId, slides: [onlySlide] };
    await project.writeProject(saved, initialRevision);
    assert.equal((await readdir(join(root, ".weave"))).includes("current-buffer.json"), false);
    assert.deepEqual(await readdir(join(root, "slides")), ["renamed-slide.html"]);
    const savedCommit = project.commitIfChanged("Save transactional deck");
    assert.match(savedCommit, /^[0-9a-f]{40}$/);
    assert.equal(git(root, ["status", "--porcelain"]), "");

    await assert.rejects(
      project.writeProject({ ...saved, title: "Stale overwrite" }, initialRevision),
      (error) => error.code === "WEAVE_REVISION_CONFLICT"
        && error.expectedRevision === initialRevision
        && error.actualRevision === savedCommit,
    );
    assert.equal(JSON.parse(await readFile(join(root, ".weave", "deck.json"), "utf8")).title, "Transactional deck");

    await project.writeProject({ ...saved, title: "Transient buffer" });
    assert.equal((await project.readProject()).title, "Transient buffer");
    assert.notEqual(git(root, ["status", "--porcelain"]), "");
    git(root, ["restore", "--staged", "--worktree", "--", ".weave/deck.json", "slides"]);
    assert.equal(git(root, ["status", "--porcelain"]), "");

    const restoreRevision = await project.checkoutHistory(initialRevision);
    assert.equal(git(root, ["branch", "--show-current"]), "main");
    assert.equal(restoreRevision, savedCommit);
    assert.equal((await project.readProject()).title, initial.title);
    assert.equal(git(root, ["log", "-1", "--pretty=%s"]), "Save transactional deck");
    assert.notEqual(git(root, ["status", "--porcelain"]), "");

    project.commitIfChanged("Milestone: restored initial draft");

    await rename(join(root, "slides"), join(root, ".slides-crash.previous"));
    await mkdir(join(root, ".slides-crash.staged"));
    await writeFile(join(root, ".slides-crash.staged", "partial.html"), "partial");
    await rename(join(root, ".weave", "deck.json"), join(root, ".weave", ".deck-crash.previous"));
    await writeFile(join(root, ".weave", ".deck-crash.staged"), "partial");
    await project.ensureProject();
    assert.equal((await project.readProject()).title, initial.title);
    assert.equal((await readdir(root)).some((name) => name.includes("crash")), false);
    assert.equal((await readdir(join(root, ".weave"))).some((name) => name.includes("crash")), false);
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("writes keep policy failures inspectable until the commit gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-policy-gate-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_PROJECT_ROOT = root;
  try {
    const project = await import(`../server/project.mjs?policy-gate=${Date.now()}`);
    await project.ensureProject();
    const initial = await project.readProject();
    const unsafe = {
      ...initial,
      defaultTemplateId: initial.defaultTemplateId,
      slides: [{
        ...initial.slides[0],
        html: initial.slides[0].html.replace("</section>", '<script>alert(1)</script></section>'),
      }],
    };

    await project.writeProject(unsafe);
    assert.match(await readFile(join(root, "slides", `${unsafe.slides[0].id}.html`), "utf8"), /<script>\s*alert\(1\);?\s*<\/script>/);
    await assert.rejects(project.assertCommittable(), (error) => error.code === "WEAVE_CONTENT_POLICY");

    await project.writeProject(initial);
    await project.assertCommittable();

    await writeFile(join(root, "styles", "deck.css"), "body { color: red; }\n");
    await assert.rejects(project.assertCommittable(), (error) => error.code === "WEAVE_TAILWIND_STYLESHEET");
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("unmanaged files do not block project transactions", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-managed-status-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_PROJECT_ROOT = root;
  try {
    const project = await import(`../server/project.mjs?managed-status=${Date.now()}`);
    await project.ensureProject();
    await mkdir(join(root, "plans"));
    await writeFile(join(root, "plans", "2026-01-01-note.md"), "stray note\n");

    assert.notEqual(git(root, ["status", "--porcelain"]), "");
    assert.equal(project.projectState().project.clean, true);
    await project.assertSwitchable();

    const current = await project.readProject();
    await project.writeProject({ ...current, title: "Managed change" });
    assert.equal(project.projectState().project.clean, false);
    project.commitIfChanged("Save managed change");
    assert.equal(project.projectState().project.clean, true);
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("image assets are content-addressed, deduplicated, and SVG-audited", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-assets-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_PROJECT_ROOT = root;
  try {
    const project = await import(`../server/project.mjs?assets=${Date.now()}`);
    await project.ensureProject();
    const data = Buffer.from("small image").toString("base64");
    const first = await project.importImageAsset({ data, mimeType: "image/png" });
    const second = await project.importImageAsset({ data, mimeType: "image/png" });
    assert.equal(first.path, second.path);
    assert.equal(await readFile(join(root, first.path), "utf8"), "small image");
    await assert.rejects(project.importImageAsset({ data, mimeType: "image/tiff" }), /Unsupported image type/);
    const unsafeSvg = Buffer.from('<svg><script>alert(1)</script></svg>').toString("base64");
    await assert.rejects(project.importImageAsset({ data: unsafeSvg, mimeType: "image/svg+xml" }), (error) => error.code === "WEAVE_ASSET_POLICY");
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("reference imports preserve Unicode names, normalize paths, and track only the index", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-reference-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_PROJECT_ROOT = root;
  try {
    const project = await import(`../server/project.mjs?reference=${Date.now()}`);
    await project.ensureProject();
    const data = Buffer.from("reference").toString("base64");
    const first = await project.importReference({ data, mimeType: "application/pdf", name: "資料\\原稿 版..pdf" });
    const second = await project.importReference({ data, mimeType: "application/pdf", name: "資料\\原稿 版..pdf" });
    assert.deepEqual(second, first);
    assert.match(first.name, /^資料_原稿_版_\.pdf$/);
    assert.equal(JSON.parse(await readFile(join(root, "references", "index.json"), "utf8")).entries.length, 1);
    project.commitIfChanged("Track reference");
    assert.deepEqual(git(root, ["ls-files", "references"]), "references/index.json");
    assert.equal(git(root, ["ls-files", "references"]), "references/index.json");
    assert.match(git(root, ["status", "--porcelain", "--untracked-files=all"]), /references\/[0-9a-f]{12}-/);
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("reference shelves report missing entries and remove validated paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-reference-shelf-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_PROJECT_ROOT = root;
  try {
    const project = await import(`../server/project.mjs?reference-shelf=${Date.now()}`);
    await project.ensureProject();
    const data = Buffer.from("shelf reference").toString("base64");
    const reference = await project.importReference({ data, mimeType: "application/pdf", name: "brief.pdf" });
    assert.deepEqual((await project.readReferences()).map(({ missing }) => missing), [false]);
    await rm(join(root, reference.path));
    assert.deepEqual((await project.readReferences()).map(({ missing }) => missing), [true]);
    await assert.rejects(project.removeReference("slides/cover.html"), /Invalid reference path/);
    const remaining = await project.removeReference(reference.path);
    assert.deepEqual(remaining, []);
    assert.deepEqual(await project.readReferences(), []);
    assert.equal(JSON.parse(await readFile(join(root, "references", "index.json"), "utf8")).entries.length, 0);
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("folder imports exclude dot files and links while preserving structure", async () => {
  const home = await mkdtemp(join(tmpdir(), "weave-home-"));
  const root = join(home, "project");
  const source = join(home, "案件A");
  await mkdir(join(source, "docs"), { recursive: true });
  await writeFile(join(source, "docs", "brief.pdf"), "brief");
  await writeFile(join(source, ".env"), "secret");
  await symlink(join(source, "docs", "brief.pdf"), join(source, "linked.pdf"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  const previousHome = process.env.HOME;
  process.env.WEAVE_PROJECT_ROOT = root;
  process.env.HOME = home;
  try {
    const project = await import(`../server/project.mjs?folder=${Date.now()}`);
    await project.ensureProject();
    const entry = await project.importReferenceFolder({ source });
    assert.equal(entry.kind, "folder");
    assert.equal(entry.files, 1);
    await assert.rejects(project.importReferenceFolder({ source }), /already exists/);
    assert.equal(await readFile(join(root, entry.path, "docs", "brief.pdf"), "utf8"), "brief");
    assert.equal((await readdir(join(root, entry.path))).includes(".env"), false);
    assert.equal((await readdir(join(root, entry.path))).includes("linked.pdf"), false);
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("folder walks cap imports before copying oversized folders", async () => {
  const home = await mkdtemp(join(tmpdir(), "weave-home-cap-"));
  const root = join(home, "project");
  const source = join(home, "large");
  await mkdir(source, { recursive: true });
  await Promise.all(Array.from({ length: 2001 }, (_, index) => writeFile(join(source, `file-${index}.txt`), "x")));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  const previousHome = process.env.HOME;
  process.env.WEAVE_PROJECT_ROOT = root;
  process.env.HOME = home;
  try {
    const project = await import(`../server/project.mjs?folder-cap=${Date.now()}`);
    await project.ensureProject();
    assert.equal((await project.walkReferenceFolder(source)).capped, true);
    await assert.rejects(project.importReferenceFolder({ source }), /exceeds/);
    await assert.rejects(readdir(join(root, "references")), { code: "ENOENT" });
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("folder browsing counts only the current directory", async () => {
  const home = await mkdtemp(join(tmpdir(), "weave-home-browse-"));
  const root = join(home, "project");
  const source = join(home, "browse");
  await mkdir(join(source, "nested"), { recursive: true });
  await writeFile(join(source, "here.txt"), "here");
  await writeFile(join(source, "nested", "there.txt"), "there");
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  const previousHome = process.env.HOME;
  process.env.WEAVE_PROJECT_ROOT = root;
  process.env.HOME = home;
  try {
    const project = await import(`../server/project.mjs?folder-browse=${Date.now()}`);
    await project.ensureProject();
    const result = await project.listFolders(source);
    assert.equal(result.folderCount, 1);
    assert.equal(result.fileCount, 1);
    assert.equal("bytes" in result, false);
    assert.equal("capped" in result, false);
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("folder walks can be capped by a caller-provided time budget", async () => {
  const home = await mkdtemp(join(tmpdir(), "weave-home-budget-"));
  const source = join(home, "budget");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "file.txt"), "file");
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const project = await import(`../server/project.mjs?folder-budget=${Date.now()}`);
    assert.equal((await project.walkReferenceFolder(source, -1)).capped, true);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("folder browsing and imports reject paths outside the real home", async () => {
  const home = await mkdtemp(join(tmpdir(), "weave-home-boundary-"));
  const outside = await mkdtemp(join(tmpdir(), "weave-outside-"));
  const root = join(home, "project");
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  const previousHome = process.env.HOME;
  process.env.WEAVE_PROJECT_ROOT = root;
  process.env.HOME = home;
  try {
    const project = await import(`../server/project.mjs?folder-boundary=${Date.now()}`);
    await project.ensureProject();
    await assert.rejects(project.listFolders(outside), /inside the home/);
    await assert.rejects(project.importReferenceFolder({ source: outside }), /inside the home/);
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("folder sync replaces the copy and remove deletes the directory", async () => {
  const home = await mkdtemp(join(tmpdir(), "weave-home-sync-"));
  const root = join(home, "project");
  const source = join(home, "source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "old.txt"), "old");
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  const previousHome = process.env.HOME;
  process.env.WEAVE_PROJECT_ROOT = root;
  process.env.HOME = home;
  try {
    const project = await import(`../server/project.mjs?folder-sync=${Date.now()}`);
    await project.ensureProject();
    const entry = await project.importReferenceFolder({ source });
    await rm(join(source, "old.txt"));
    await writeFile(join(source, "new.txt"), "new");
    await project.syncReferenceFolder(entry.path);
    assert.equal(await readFile(join(root, entry.path, "new.txt"), "utf8"), "new");
    assert.equal((await readdir(join(root, entry.path))).includes("old.txt"), false);
    await project.removeReference(entry.path);
    await assert.rejects(readFile(join(root, entry.path)));
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("concurrent saves with one revision cannot overwrite each other", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-save-lock-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_PROJECT_ROOT = root;
  try {
    const project = await import(`../server/project.mjs?save-lock=${Date.now()}`);
    await project.ensureProject();
    const initial = await project.readProject();
    const revision = project.getRevision();
    const results = await Promise.allSettled([
      project.saveProject({ ...initial, title: "First save" }, revision, "First save", null),
      project.saveProject({ ...initial, title: "Second save" }, revision, "Second save", null),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected.reason.code, "WEAVE_REVISION_CONFLICT");
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("history preview preserves current assets and can return to the prior draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-history-tree-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_PROJECT_ROOT = root;
  try {
    const project = await import(`../server/project.mjs?history-tree=${Date.now()}`);
    await project.ensureProject();
    const revisionWithoutAssets = project.getRevision();
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets", "added.png"), "image");
    project.commitIfChanged("Add later asset");
    const dirtyDeck = { ...(await project.readProject(root)), title: "Unsaved current draft" };
    await project.writeProject(dirtyDeck, null, root);
    await project.checkoutHistory(revisionWithoutAssets);
    assert.equal(await readFile(join(root, "assets", "added.png"), "utf8"), "image");
    assert.equal(project.projectState().project.historyPreview, true);
    await project.checkoutMain();
    assert.deepEqual(await project.readProject(root), dirtyDeck);
    assert.equal(project.projectState().project.historyPreview, false);
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("restoring a pre-v2 history commit migrates it before the project is read", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-history-v1-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_PROJECT_ROOT = root;
  try {
    await mkdir(join(root, ".weave"), { recursive: true });
    await mkdir(join(root, "slides"), { recursive: true });
    await writeFile(join(root, ".weave/deck.json"), `${JSON.stringify({ title: "Legacy", slides: [{ id: "cover", title: "Legacy", notes: "" }] })}\n`);
    await writeFile(join(root, "slides/cover.html"), '<main class="weave-slide theme-orbit"><section data-weave-slot="content"><h1 data-weave-slot="title">Legacy</h1></section></main>');
    git(root, ["init", "-b", "main"]);
    git(root, ["add", "."]);
    git(root, ["-c", "user.name=Weave", "-c", "user.email=weave@localhost", "commit", "-m", "Legacy schema"]);
    const legacyRevision = git(root, ["rev-parse", "HEAD"]);
    const project = await import(`../server/project.mjs?history-v1=${Date.now()}`);
    await project.ensureProject();
    git(root, ["branch", "weave/variation/a", legacyRevision]);
    await project.checkoutVariation("weave/variation/a");
    assert.equal((await project.readProject()).title, "Legacy");
    await project.checkoutVariation("main");
    await project.checkoutHistory(legacyRevision);
    const restored = await project.readProject();
    assert.equal(restored.title, "Legacy");
    assert.equal(JSON.parse(await readFile(join(root, ".weave/deck.json"), "utf8")).schemaVersion, 2);
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("saving an imported bundle installs its template packages before validating slide references", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-template-import-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_PROJECT_ROOT = root;
  try {
    const project = await import(`../server/project.mjs?template-import=${Date.now()}`);
    await project.ensureProject();
    const deck = await project.readProject();
    const templates = await project.readTemplates();
    const orbit = templates.find((template) => template.id === "orbit");
    const importedLayout = { ...orbit.layouts[0], id: "portable", name: "Portable" };
    const packages = templates.map((template) => template.id === "orbit" ? { ...template, layouts: [...template.layouts, importedLayout] } : template);
    const importedDeck = { ...deck, slides: deck.slides.map((slide, index) => index === 0 ? { ...slide, layoutId: "portable" } : slide) };
    await project.saveProject(importedDeck, project.getRevision(), "Import portable templates", packages);
    assert.equal((await project.readProject()).slides[0].layoutId, "portable");
    assert.ok((await project.readTemplates()).find((template) => template.id === "orbit").layouts.some((layout) => layout.id === "portable"));
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("a rejected imported template package leaves both templates and deck untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-template-import-rollback-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_PROJECT_ROOT = root;
  try {
    const project = await import(`../server/project.mjs?template-import-rollback=${Date.now()}`);
    await project.ensureProject();
    const deck = await project.readProject();
    const templates = await project.readTemplates();
    const masterPath = join(root, "templates/orbit/master.html");
    const originalMaster = await readFile(masterPath, "utf8");
    const originalManifest = await readFile(join(root, ".weave/deck.json"), "utf8");
    const packages = templates.map((template) => template.id === "orbit" ? { ...template, masterHtml: template.masterHtml.replace("data-weave-layout-slot", "data-invalid-layout-slot") } : template);
    await assert.rejects(project.saveProject(deck, project.getRevision(), "Reject invalid template", packages), /data-weave-layout-slot/);
    assert.equal(await readFile(masterPath, "utf8"), originalMaster);
    assert.equal(await readFile(join(root, ".weave/deck.json"), "utf8"), originalManifest);
    assert.equal(git(root, ["status", "--porcelain"]), "");
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("restoring the pre-turn deck removes rejected slide HTML from active state", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-turn-restore-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_PROJECT_ROOT = root;
  try {
    const project = await import(`../server/project.mjs?turn-restore=${Date.now()}`);
    await project.ensureProject();
    const before = await project.readProject(root);
    const rejected = { ...before, slides: before.slides.map((slide) => ({ ...slide, html: slide.html.replace('data-weave-slot="content"', 'class="content" data-weave-slot="content"') })) };
    await project.writeProject(rejected, null, root);
    await assert.rejects(project.assertCommittable(root), (error) => error.code === "WEAVE_CONTENT_POLICY");
    await project.runProjectExclusive(() => project.writeProjectUnlocked(before, null, root), root);
    assert.deepEqual(await project.readProject(root), before);
    await project.assertCommittable(root);
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("restoring a rejected turn also restores the generated stylesheet", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-turn-css-restore-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_PROJECT_ROOT = root;
  try {
    const project = await import(`../server/project.mjs?turn-css-restore=${Date.now()}`);
    await project.ensureProject();
    const before = await project.readProject(root);
    const beforeCss = await project.readDeckCss(root);
    await writeFile(join(root, "styles", "deck.css"), "body { color: red; }\n");
    await assert.rejects(project.assertCommittable(root), (error) => error.code === "WEAVE_TAILWIND_STYLESHEET");
    await project.runProjectExclusive(async () => {
      await project.writeProjectUnlocked(before, null, root);
      await project.restoreDeckCss(beforeCss, root);
    }, root);
    assert.equal(await project.readDeckCss(root), beforeCss);
    await project.assertCommittable(root);
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery snapshots persist human edits and queued milestones across reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-recovery-draft-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_PROJECT_ROOT = root;
  try {
    const project = await import(`../server/project.mjs?recovery-draft=${Date.now()}`);
    await project.ensureProject();
    const baseDeck = await project.readProject(root);
    const humanDraft = { ...baseDeck, title: "Recovered human draft" };
    const fileSnapshot = await project.createAgentFileSnapshot(root);
    const snapshot = await project.createRecoverySnapshot({ baseRevision: project.getRevision(root), deck: baseDeck, css: await project.readDeckCss(root), agentFileSnapshot: fileSnapshot }, root);
    await project.updateRecoverySnapshot(snapshot, { humanDraft, queuedMilestone: "Review ready" }, root);
    const [recovered] = await project.readRecoverySnapshots(root);
    assert.deepEqual(recovered.humanDraft, humanDraft);
    assert.equal(recovered.queuedMilestone, "Review ready");
    assert.equal(recovered.agentFileSnapshot.directory, fileSnapshot.directory);
    assert.equal(recovered.status, "interrupted");
    await project.discardRecoverySnapshot(snapshot, root);
    await project.discardAgentFileSnapshot(fileSnapshot, root);
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("Agent file snapshots protect managed files while preserving human uploads", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-agent-files-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_PROJECT_ROOT = root;
  try {
    const project = await import(`../server/project.mjs?agent-files=${Date.now()}`);
    await project.ensureProject();
    await mkdir(join(root, "references"), { recursive: true });
    await writeFile(join(root, "references", "index.json"), "[{\"path\":\"before\"}]\n");
    await writeFile(join(root, "references", "base.txt"), "original reference");
    const beforeTemplates = await project.readTemplates(root);
    const beforeAgents = await readFile(join(root, "AGENTS.md"), "utf8");
    const beforeReferences = await readFile(join(root, "references", "index.json"), "utf8");
    const snapshot = await project.createAgentFileSnapshot(root);
    assert.equal(snapshot.directory.startsWith(root), false);
    await writeFile(join(root, "assets", "agent-only.txt"), "not allowed");
    const humanAsset = `assets/${"a".repeat(64)}.png`;
    await writeFile(join(root, humanAsset), "human upload");
    await project.captureAgentFilePreservation(snapshot, humanAsset, root);
    await writeFile(join(root, humanAsset), "agent overwrite");
    const humanReference = "references/human.txt";
    await writeFile(join(root, humanReference), "human reference");
    await project.captureAgentFilePreservation(snapshot, humanReference, root);
    await writeFile(join(root, humanReference), "agent overwrite");
    await writeFile(join(root, "AGENTS.md"), "agent mutation");
    await writeFile(join(root, "references", "index.json"), "[]");
    await writeFile(join(root, "references", "base.txt"), "agent mutation");
    await rm(project.templatesRoot(root), { recursive: true, force: true });
    await project.restoreAgentFileSnapshot(snapshot, root, { preserve: [humanAsset, humanReference] });
    await assert.rejects(readFile(join(root, "assets", "agent-only.txt")), (error) => error.code === "ENOENT");
    assert.equal(await readFile(join(root, humanAsset), "utf8"), "human upload");
    assert.equal(await readFile(join(root, humanReference), "utf8"), "human reference");
    assert.deepEqual(await project.readTemplates(root), beforeTemplates);
    assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), beforeAgents);
    assert.equal(await readFile(join(root, "references", "index.json"), "utf8"), beforeReferences);
    assert.equal(await readFile(join(root, "references", "base.txt"), "utf8"), "original reference");
    await project.discardAgentFileSnapshot(snapshot, root);
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt recovery records fail closed instead of exposing partial Agent output", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-recovery-corrupt-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_PROJECT_ROOT = root;
  try {
    const project = await import(`../server/project.mjs?recovery-corrupt=${Date.now()}`);
    await project.ensureProject();
    const snapshot = await project.createRecoverySnapshot({ baseRevision: project.getRevision(root), deck: await project.readProject(root), css: await project.readDeckCss(root) }, root);
    assert.equal(snapshot.path.startsWith(root), false);
    await writeFile(snapshot.path, "{\"baseDeck\":");
    await assert.rejects(project.readRecoverySnapshots(root), /Recovery record is unreadable/);
    await rm(snapshot.path, { force: true });
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("discarding a rejected variation returns to main and removes its branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-variation-restore-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_PROJECT_ROOT = root;
  try {
    const project = await import(`../server/project.mjs?variation-restore=${Date.now()}`);
    await project.ensureProject();
    const before = await project.readProject(root);
    const branch = project.createVariationBranch();
    await project.writeProject({ ...before, slides: before.slides.map((slide) => ({ ...slide, html: slide.html.replace('data-weave-slot="title"', 'class="title" data-weave-slot="title"') })) }, null, root);
    await assert.rejects(project.assertCommittable(root), (error) => error.code === "WEAVE_CONTENT_POLICY");
    project.discardVariation(branch, root);
    assert.equal(git(root, ["branch", "--show-current"]), "main");
    assert.deepEqual(project.getVariations(root), []);
    assert.deepEqual(await project.readProject(root), before);
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("a discarded variation can restore the dirty draft it inherited", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-variation-dirty-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_PROJECT_ROOT = root;
  try {
    const project = await import(`../server/project.mjs?variation-dirty=${Date.now()}`);
    await project.ensureProject();
    const dirtyDraft = { ...(await project.readProject(root)), title: "Unsaved before exploration" };
    await project.writeProject(dirtyDraft, null, root);
    const branch = project.createVariationBranch();
    const files = await project.createAgentFileSnapshot(root);
    const recovery = await project.createRecoverySnapshot({ baseRevision: project.getRevision(root), deck: dirtyDraft, css: await project.readDeckCss(root), agentFileSnapshot: files }, root);
    await writeFile(join(root, "AGENTS.md"), "agent mutation");
    project.discardVariation(branch, root);
    await project.restoreAgentFileSnapshot(files, root);
    await project.writeProjectUnlocked(recovery.baseDeck, null, root);
    assert.deepEqual(await project.readProject(root), dirtyDraft);
    assert.notEqual(await readFile(join(root, "AGENTS.md"), "utf8"), "agent mutation");
    assert.match(git(root, ["status", "--porcelain"]), /\.weave\/deck\.json/);
    await project.discardRecoverySnapshot(recovery, root);
    await project.discardAgentFileSnapshot(files, root);
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
