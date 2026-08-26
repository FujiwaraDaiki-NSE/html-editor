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
    const slug = await project.createProject({ title: "A $& <Deck>", templateId: "grid" });
    assert.equal(project.projectRoot(), startup);
    const rootPath = join(workspaces, slug);
    assert.equal(git(rootPath, ["rev-list", "--count", "HEAD"]), "1");
    assert.equal(JSON.parse(await readFile(join(rootPath, ".weave", "deck.json"), "utf8")).slides.length, 1);
    const coverHtml = await readFile(join(rootPath, "slides", "cover.html"), "utf8");
    assert.equal(coverHtml.includes("A $&amp; &lt;Deck&gt;"), true);
    assert.match(coverHtml, /data-weave-slide-source/);
    assert.equal(coverHtml.match(/<h1\b/g)?.length, 1);
    await access(join(rootPath, "AGENTS.md"));
    await access(join(rootPath, "styles", "deck.css"));

    const second = await project.createProject({ title: "Second", templateId: "plain" });
    const assetFilename = `${"a".repeat(64)}.png`;
    const jpegAssetFilename = `${"b".repeat(64)}.jpeg`;
    const shortAssetFilename = "60d970719b3607e5.png";
    const upperJpegAssetFilename = "IMG_1234.JPG";
    const upperPngAssetFilename = "Photo.PNG";
    const svgAssetFilename = "svg-cover.jpeg";
    await mkdir(join(rootPath, "assets"), { recursive: true });
    await writeFile(join(rootPath, "assets", assetFilename), "png");
    await writeFile(join(rootPath, "assets", jpegAssetFilename), "jpeg");
    await writeFile(join(rootPath, "assets", shortAssetFilename), "short");
    await writeFile(join(rootPath, "assets", upperJpegAssetFilename), "upper jpeg");
    await writeFile(join(rootPath, "assets", upperPngAssetFilename), "upper png");
    await writeFile(join(rootPath, "assets", svgAssetFilename), "svg asset");
    const assetMarkup = `<div data-weave-id="asset-probe"><img src="assets/${assetFilename}"><svg><image href="assets/${svgAssetFilename}"><image xlink:href="assets/${jpegAssetFilename}" clip-path="url(#cover-clip)"><image href="#cover-image"><a href="assets/${shortAssetFilename}"></a></svg><img src="assets/${jpegAssetFilename}"><img src="assets/${shortAssetFilename}"><img src="assets/${upperJpegAssetFilename}"><img src="assets/${upperPngAssetFilename}"><img src="assets/example.png"><img src="assets/x.exe"></div>`;
    await writeFile(join(rootPath, "slides", "cover.html"), coverHtml.replace("</section>", `${assetMarkup}</section>`));
    git(rootPath, ["add", "."]);
    git(rootPath, ["-c", "user.name=Weave", "-c", "user.email=weave@localhost", "commit", "-m", "Add thumbnail asset"]);
    const listed = await project.listProjects();
    assert.deepEqual(new Set(listed.map(({ slug: id }) => id)), new Set([slug, second]));
    assert.equal(listed.every((item) => item.slideCount === 1 && item.thumbnailHtml.length > 0), true);
    assert.match(listed.find((item) => item.slug === slug).thumbnailHtml, new RegExp(`src="[^\"]*/api/projects/${slug}/assets/${assetFilename}"`));
    assert.match(listed.find((item) => item.slug === slug).thumbnailHtml, new RegExp(`src="[^\"]*/api/projects/${slug}/assets/${jpegAssetFilename}"`));
    assert.match(listed.find((item) => item.slug === slug).thumbnailHtml, new RegExp(`src="[^\"]*/api/projects/${slug}/assets/${shortAssetFilename}"`));
    assert.match(listed.find((item) => item.slug === slug).thumbnailHtml, new RegExp(`src="[^\"]*/api/projects/${slug}/assets/${upperJpegAssetFilename}"`));
    assert.match(listed.find((item) => item.slug === slug).thumbnailHtml, new RegExp(`src="[^\"]*/api/projects/${slug}/assets/${upperPngAssetFilename}"`));
    assert.match(listed.find((item) => item.slug === slug).thumbnailHtml, new RegExp(`href="[^\"]*/api/projects/${slug}/assets/${svgAssetFilename}"`));
    assert.match(listed.find((item) => item.slug === slug).thumbnailHtml, new RegExp(`xlink:href="[^\"]*/api/projects/${slug}/assets/${jpegAssetFilename}"`));
    assert.match(listed.find((item) => item.slug === slug).thumbnailHtml, /clip-path="url\(#cover-clip\)"/);
    assert.match(listed.find((item) => item.slug === slug).thumbnailHtml, /href="#cover-image"/);
    assert.match(listed.find((item) => item.slug === slug).thumbnailHtml, new RegExp(`href="assets/${shortAssetFilename}"`));
    assert.match(listed.find((item) => item.slug === slug).thumbnailHtml, new RegExp(`src="[^\"]*/api/projects/${slug}/assets/example\\.png"`));
    assert.match(listed.find((item) => item.slug === slug).thumbnailHtml, /src="assets\/x\.exe"/);
    for (const valid of [jpegAssetFilename, shortAssetFilename, upperJpegAssetFilename, upperPngAssetFilename]) assert.equal(project.assertAssetFilename(valid), valid);
    assert.equal(project.assetMimeTypes.get(upperJpegAssetFilename.split(".").pop().toLowerCase()), "image/jpeg");
    for (const invalid of ["../secret.png", "a/b.png", ".hidden.png", "no-extension", "x.exe", ""]) assert.throws(() => project.assertAssetFilename(invalid), /Asset not found/);
    await mkdir(join(workspaces, ".hidden"));
    await mkdir(join(workspaces, "not-a-project"));
    assert.equal((await project.listProjects()).length, 2);

    const beforeRename = git(join(workspaces, second), ["rev-parse", "HEAD"]);
    await project.renameProject(second, "Renamed");
    assert.equal(JSON.parse(await readFile(join(workspaces, second, ".weave", "deck.json"), "utf8")).title, "Renamed");
    assert.equal(git(join(workspaces, second), ["rev-list", "--count", "HEAD"]), "2");
    assert.notEqual(git(join(workspaces, second), ["rev-parse", "HEAD"]), beforeRename);

    await project.switchProject(slug);
    const referenceData = Buffer.from("do not copy this binary").toString("base64");
    await project.importReference({ data: referenceData, mimeType: "application/pdf", name: "brief.pdf" });
    project.commitIfChanged("Track reference catalogue");
    assert.equal((await project.listProjects()).find((item) => item.slug === slug).current, true);
    const copy = await project.duplicateProject(slug);
    assert.equal(git(join(workspaces, copy), ["rev-list", "--count", "HEAD"]), "1");
    assert.match(JSON.parse(await readFile(join(workspaces, copy, ".weave", "deck.json"), "utf8")).title, /のコピー$/);
    assert.equal(git(join(workspaces, slug), ["branch", "--list"]), "* main");
    assert.equal(git(join(workspaces, copy), ["ls-files", "references"]), "references/index.json");

    await project.archiveProject(second);
    await access(join(workspaces, ".archive", second, ".git"));
    await assert.rejects(project.archiveProject(slug), /current project/);
    for (const invalid of ["../x", "/abs", "Bad Slug", ".archive"]) await assert.rejects(project.renameProject(invalid, "x"), /Invalid project id/);

    await project.switchProject(copy);
    await writeFile(join(workspaces, copy, "dirty.txt"), "dirty");
    await project.switchProject(slug);
    await project.switchProject(copy);
    await writeFile(join(workspaces, copy, "slides", "dirty.html"), "<main></main>");
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
    const first = await project.createProject({ title: "First", templateId: "orbit" });
    const second = await project.createProject({ title: "Second", templateId: "plain" });
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

test("concurrent project creation reserves distinct slugs", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-project-create-lock-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  const previousWorkspaces = process.env.WEAVE_WORKSPACES_ROOT;
  process.env.WEAVE_PROJECT_ROOT = join(root, "startup");
  process.env.WEAVE_WORKSPACES_ROOT = join(root, "workspaces");
  try {
    const project = await import(`../server/project.mjs?create-lock=${Date.now()}`);
    const slugs = await Promise.all([
      project.createProject({ title: "Same title", templateId: "orbit" }),
      project.createProject({ title: "Same title", templateId: "orbit" }),
    ]);
    assert.equal(new Set(slugs).size, 2);
    assert.deepEqual(new Set(slugs), new Set(["same-title", "same-title-2"]));
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT;
    else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    if (previousWorkspaces === undefined) delete process.env.WEAVE_WORKSPACES_ROOT;
    else process.env.WEAVE_WORKSPACES_ROOT = previousWorkspaces;
    await rm(root, { recursive: true, force: true });
  }
});
