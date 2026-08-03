import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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
    assert.equal(git(root, ["ls-files", ".weave/current-buffer.json"]), "");

    const onlySlide = { ...initial.slides[0], id: "renamed-slide", title: "Renamed and saved" };
    const saved = { title: "Transactional deck", slides: [onlySlide] };
    await project.writeProject(saved, false, initialRevision);
    assert.deepEqual(await readdir(join(root, "slides")), ["renamed-slide.html"]);
    const savedCommit = project.commitIfChanged("Save transactional deck");
    assert.match(savedCommit, /^[0-9a-f]{40}$/);
    assert.equal(git(root, ["status", "--porcelain"]), "");

    await assert.rejects(
      project.writeProject({ ...saved, title: "Stale overwrite" }, false, initialRevision),
      (error) => error.code === "WEAVE_REVISION_CONFLICT"
        && error.expectedRevision === initialRevision
        && error.actualRevision === savedCommit,
    );
    assert.equal(JSON.parse(await readFile(join(root, ".weave", "deck.json"), "utf8")).title, "Transactional deck");

    await project.writeProject({ ...saved, title: "Transient buffer" }, true);
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
