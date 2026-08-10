import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("projects are independent repositories with lifecycle operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-project-management-"));
  const workspaces = join(root, "workspaces");
  const startup = join(root, "startup");
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  const previousWorkspaces = process.env.WEAVE_WORKSPACES_ROOT;
  process.env.WEAVE_PROJECT_ROOT = startup;
  process.env.WEAVE_WORKSPACES_ROOT = workspaces;
  try {
    const project = await import(`../server/project.mjs?management=${Date.now()}`);
    await project.ensureProject();
    const slug = await project.createProject({ title: "A <Deck>", template: "grid" });
    const rootPath = join(workspaces, slug);
    assert.equal(git(rootPath, ["rev-list", "--count", "HEAD"]), "1");
    assert.equal(JSON.parse(await readFile(join(rootPath, ".weave", "deck.json"), "utf8")).slides.length, 1);
    assert.equal((await readFile(join(rootPath, "slides", "cover.html"), "utf8")).includes("A &lt;Deck&gt;"), true);
    await access(join(rootPath, "AGENTS.md"));
    await access(join(rootPath, "styles", "deck.css"));

    const second = await project.createProject({ title: "Second", template: "plain" });
    const listed = await project.listProjects();
    assert.deepEqual(new Set(listed.map(({ slug: id }) => id)), new Set([slug, second]));
    assert.equal(listed.every((item) => item.slideCount === 1 && item.thumbnailHtml.length > 0), true);
    await mkdir(join(workspaces, ".hidden"));
    await mkdir(join(workspaces, "not-a-project"));
    assert.equal((await project.listProjects()).length, 2);

    const beforeRename = git(join(workspaces, second), ["rev-parse", "HEAD"]);
    await project.renameProject(second, "Renamed");
    assert.equal(JSON.parse(await readFile(join(workspaces, second, ".weave", "deck.json"), "utf8")).title, "Renamed");
    assert.equal(git(join(workspaces, second), ["rev-list", "--count", "HEAD"]), "2");
    assert.notEqual(git(join(workspaces, second), ["rev-parse", "HEAD"]), beforeRename);

    await project.switchProject(slug);
    assert.equal((await project.listProjects()).find((item) => item.slug === slug).current, true);
    const copy = await project.duplicateProject(slug);
    assert.equal(git(join(workspaces, copy), ["rev-list", "--count", "HEAD"]), "1");
    assert.match(JSON.parse(await readFile(join(workspaces, copy, ".weave", "deck.json"), "utf8")).title, /のコピー$/);
    assert.equal(git(join(workspaces, slug), ["branch", "--list"]), "* main");

    await project.archiveProject(second);
    await access(join(workspaces, ".archive", second, ".git"));
    await assert.rejects(project.archiveProject(slug), /current project/);
    for (const invalid of ["../x", "/abs", "Bad Slug", ".archive"]) await assert.rejects(project.renameProject(invalid, "x"), /Invalid project id/);

    await project.switchProject(copy);
    await writeFile(join(workspaces, copy, "dirty.txt"), "dirty");
    await assert.rejects(project.switchProject(slug), (error) => error.code === "WEAVE_PROJECT_DIRTY");
    git(join(workspaces, copy), ["clean", "-fd"]);
    git(join(workspaces, slug), ["branch", "weave/variation/open"]);
    await assert.rejects(project.switchProject(slug), (error) => error.code === "WEAVE_PROJECT_BLOCKED");
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    if (previousWorkspaces === undefined) delete process.env.WEAVE_WORKSPACES_ROOT;
    else process.env.WEAVE_WORKSPACES_ROOT = previousWorkspaces;
    await rm(root, { recursive: true, force: true });
  }
});

test("initializes the persisted project and falls back safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-project-current-"));
  const workspaces = join(root, "workspaces");
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  const previousWorkspaces = process.env.WEAVE_WORKSPACES_ROOT;
  delete process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_WORKSPACES_ROOT = workspaces;
  try {
    const project = await import(`../server/project.mjs?current=${Date.now()}`);
    const first = await project.createProject({ title: "First" });
    const second = await project.createProject({ title: "Second" });
    const currentPath = join(root, ".weave", "current.json");
    await mkdir(join(root, ".weave"), { recursive: true });
    await writeFile(currentPath, JSON.stringify({ slug: first }));
    await project.initializeCurrentProject();
    assert.equal(project.projectRoot(), join(workspaces, first));

    await writeFile(currentPath, JSON.stringify({ slug: "missing" }));
    const newest = (await project.listProjects())[0].slug;
    await project.initializeCurrentProject();
    assert.equal(project.projectRoot(), join(workspaces, newest));
    assert.ok([first, second].includes(newest));
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    if (previousWorkspaces === undefined) delete process.env.WEAVE_WORKSPACES_ROOT;
    else process.env.WEAVE_WORKSPACES_ROOT = previousWorkspaces;
    await rm(root, { recursive: true, force: true });
  }
});

test("initialization leaves the default root untouched without projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-project-empty-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  const previousWorkspaces = process.env.WEAVE_WORKSPACES_ROOT;
  delete process.env.WEAVE_PROJECT_ROOT;
  process.env.WEAVE_WORKSPACES_ROOT = join(root, "workspaces");
  try {
    const project = await import(`../server/project.mjs?empty=${Date.now()}`);
    await project.initializeCurrentProject();
    assert.equal(project.projectRoot(), join(root, "workspaces", "northstar"));
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    if (previousWorkspaces === undefined) delete process.env.WEAVE_WORKSPACES_ROOT;
    else process.env.WEAVE_WORKSPACES_ROOT = previousWorkspaces;
    await rm(root, { recursive: true, force: true });
  }
});
