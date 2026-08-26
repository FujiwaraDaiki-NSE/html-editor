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
    const saved = { title: "Transactional deck", slides: [onlySlide] };
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
    assert.notEqual(restoreRevision, initialRevision);
    assert.notEqual(restoreRevision, savedCommit);
    assert.equal((await project.readProject()).title, initial.title);
    assert.match(git(root, ["log", "-1", "--pretty=%s"]), /^Restore history /);
    assert.equal(git(root, ["status", "--porcelain"]), "");

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
      slides: [{
        ...initial.slides[0],
        html: '<main class="weave-slide" data-weave-slide><script>alert(1)</script></main>',
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
      project.saveProject({ ...initial, title: "First save" }, revision, "First save"),
      project.saveProject({ ...initial, title: "Second save" }, revision, "Second save"),
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

test("history restore removes managed directories absent from the target commit", async () => {
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
    await project.checkoutHistory(revisionWithoutAssets);
    await assert.rejects(readFile(join(root, "assets", "added.png")), (error) => error.code === "ENOENT");
    assert.equal(git(root, ["status", "--porcelain"]), "");
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
