import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  applicationSkillsRoot,
  getApplicationSkillHistory,
  getApplicationSkillVersion,
  initializeApplicationSkills,
  listApplicationSkills,
  readApplicationLearningState,
  readApplicationSkill,
  readApplicationSkillEvidence,
  restoreApplicationSkill,
  updateApplicationLearningState,
  updateApplicationSkill,
} from "../server/application-skills.mjs";

const execute = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function git(root, ...args) {
  return (await execute("git", ["-C", root, ...args], { encoding: "utf8" })).stdout.trim();
}

async function fixture(operation) {
  const temporary = await mkdtemp(join(tmpdir(), "weave-application-skill-store-"));
  const previous = process.env.WEAVE_APPLICATION_SKILLS_ROOT;
  const root = join(temporary, "application-skills");
  process.env.WEAVE_APPLICATION_SKILLS_ROOT = root;
  try { return await operation(root, temporary); } finally {
    if (previous === undefined) delete process.env.WEAVE_APPLICATION_SKILLS_ROOT; else process.env.WEAVE_APPLICATION_SKILLS_ROOT = previous;
    await rm(temporary, { recursive: true, force: true });
  }
}

function update(skill, values = {}) {
  return {
    name: skill.name,
    description: skill.description,
    body: skill.body,
    frontmatter: skill.frontmatter,
    expectedRevision: skill.revision,
    message: "Update the shared instructions because the author revised the guidance",
    ...values,
  };
}

test("application storage uses its own persistent directory and rejects explicit invalid configuration", () => {
  const previous = process.env.WEAVE_APPLICATION_SKILLS_ROOT;
  try {
    delete process.env.WEAVE_APPLICATION_SKILLS_ROOT;
    assert.equal(applicationSkillsRoot(), join(homedir(), ".local/state/weave/application-skills"));
    for (const invalid of ["", "   ", "relative/path", "/", homedir()]) {
      process.env.WEAVE_APPLICATION_SKILLS_ROOT = invalid;
      assert.throws(applicationSkillsRoot, { code: "WEAVE_SKILL_INVALID" });
    }
  } finally {
    if (previous === undefined) delete process.env.WEAVE_APPLICATION_SKILLS_ROOT; else process.env.WEAVE_APPLICATION_SKILLS_ROOT = previous;
  }
});

test("initialization seeds both complete folders once in an independent Git repo and preserves learned edits", async () => fixture(async (root) => {
  const initialized = await initializeApplicationSkills();
  const skills = await listApplicationSkills();
  assert.equal(initialized.root, root);
  assert.equal(skills.length, 2);
  assert.equal(await git(root, "rev-parse", "--show-toplevel"), root);
  assert.equal(await git(root, "remote"), "");
  assert.equal(await git(root, "status", "--porcelain"), "");
  for (const skill of skills) {
    assert.equal(skill.valid, true);
    assert.equal(skill.scope, "application");
    assert.equal(skill.location, "application");
    assert.equal(skill.revision, initialized.revision);
    assert.deepEqual(skill.capabilities, { edit: true, history: true, restore: true, delete: false, move: false });
    assert.equal(skill.content, await readFile(join(repoRoot, "agent-skills", skill.name, "SKILL.md"), "utf8"));
  }
  const author = skills.find(({ name }) => name === "author-slide-preferences");
  for (const reference of ["evidence.md", "learning.md"]) {
    assert.equal(await readFile(join(root, author.name, "references", reference), "utf8"), await readFile(join(repoRoot, "agent-skills", author.name, "references", reference), "utf8"));
  }
  const modified = await updateApplicationSkill(update(author, { body: `${author.body}\n\nRetain this learned preference.`, frontmatter: "license: MIT\nmetadata:\n  source: Author" }));
  await initializeApplicationSkills();
  const reopened = await readApplicationSkill(author.name);
  assert.equal(reopened.body, modified.body);
  assert.equal(reopened.frontmatter, "license: MIT\nmetadata:\n  source: Author");
  assert.equal(reopened.revision, modified.revision);
  assert.equal(await git(root, "status", "--porcelain"), "");
  assert.equal(await readFile(join(repoRoot, "agent-skills", author.name, "SKILL.md"), "utf8"), author.content);

  // Startup also leaves direct user edits intact instead of silently reinstalling defaults.
  await writeFile(author.filePath, `${modified.content}\nDirect local edit.\n`);
  await initializeApplicationSkills();
  assert.match((await readApplicationSkill(author.name)).body, /Direct local edit/);
}));

test("history, version inspection, and complete folder restore preserve earlier commits and global learning settings", async () => fixture(async (root) => {
  const author = await readApplicationSkill("author-slide-preferences");
  const originalEvidence = await readApplicationSkillEvidence(author.name);
  const first = await updateApplicationSkill(update(author, {
    body: `${author.body}\n\nAuthor approved a clearer hierarchy.`,
    evidence: `${originalEvidence.content}\nAccepted author instruction.\n`,
    learningState: { version: 1, enabled: true, lastOutcome: { status: "updated" } },
    message: "Learn the approved hierarchy preference from an explicit author correction",
  }));
  assert.equal((await readApplicationLearningState()).revision, first.revision);
  const state = await updateApplicationLearningState({ expectedRevision: first.revision, state: { version: 1, enabled: false, lastOutcome: null }, message: "Disable learning because the author paused automatic preference updates" });
  const preview = await getApplicationSkillVersion(author.name, author.revision);
  assert.equal(preview.commit, author.revision);
  assert.equal(preview.revision, state.revision);
  assert.equal(preview.skill.revision, state.revision);
  assert.equal(preview.skill.content, author.content);

  // Untracked files in the selected folder are replaced by the selected version as well.
  await writeFile(join(root, author.name, "references", "later.md"), "A later resource\n");
  const restored = await restoreApplicationSkill({ name: author.name, commit: author.revision, expectedRevision: state.revision, message: "Restore the earlier preference because the latest guidance was superseded" });
  assert.notEqual(restored.revision, author.revision);
  assert.notEqual(restored.revision, first.revision);
  assert.equal(restored.content, author.content);
  assert.equal((await readApplicationSkillEvidence(author.name)).content, originalEvidence.content);
  await assert.rejects(access(join(root, author.name, "references", "later.md")), { code: "ENOENT" });
  assert.equal((await readApplicationLearningState()).state.enabled, false);
  assert.equal(await git(root, "merge-base", "--is-ancestor", first.revision, restored.revision), "");
  assert.equal(await git(root, "rev-parse", `${restored.revision}^`), state.revision);
  const history = await getApplicationSkillHistory(author.name);
  assert.deepEqual(history.entries.map(({ id }) => id), [restored.revision, first.revision, author.revision]);
  assert.equal(history.entries[1].message, "Learn the approved hierarchy preference from an explicit author correction");
  assert.ok(history.entries.every(({ shortId, date }) => shortId.length >= 7 && !Number.isNaN(Date.parse(date))));
  assert.equal((await getApplicationSkillHistory("technical-report-slides")).entries.length, 1);
  assert.equal(await git(root, "status", "--porcelain"), "");

  const secondRestore = await restoreApplicationSkill({ name: author.name, commit: author.revision, expectedRevision: restored.revision, message: "Confirm the restored version after reviewing its unchanged content" });
  assert.notEqual(secondRestore.revision, restored.revision);
  assert.equal((await getApplicationSkillHistory(author.name)).entries[0].id, secondRestore.revision);
}));

test("simultaneous project writes share one lock and stale revisions never overwrite another edit", async () => fixture(async () => {
  const skills = await listApplicationSkills();
  const results = await Promise.allSettled(skills.map((skill) => updateApplicationSkill(update(skill, { body: `${skill.body}\n\nProject correction.` }))));
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  const rejected = results.find(({ status }) => status === "rejected");
  assert.equal(rejected.reason.code, "WEAVE_SKILL_CONFLICT");
  const stale = skills[0];
  await assert.rejects(updateApplicationSkill(update(stale)), { code: "WEAVE_SKILL_CONFLICT" });
  await assert.rejects(restoreApplicationSkill({ name: stale.name, commit: stale.revision, expectedRevision: stale.revision, message: "Restore the initial version because the author requested it" }), { code: "WEAVE_SKILL_CONFLICT" });
}));

test("independent app processes serialize writes and recover a dead process lock", async () => fixture(async (root) => {
  const skill = await readApplicationSkill("author-slide-preferences");
  const lockPath = `${root}.lock`;
  await mkdir(lockPath);
  await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: 1_073_741_823, token: "dead-owner" }));
  const moduleUrl = new URL("../server/application-skills.mjs", import.meta.url).href;
  const script = `import { updateApplicationSkill } from ${JSON.stringify(moduleUrl)};\ntry { const result = await updateApplicationSkill(${JSON.stringify(update(skill, { body: `${skill.body}\n\nShared process correction.` }))}); process.stdout.write(JSON.stringify({revision:result.revision})); } catch (error) { if(error.code !== 'WEAVE_SKILL_CONFLICT') throw error; process.stdout.write(JSON.stringify({code:error.code})); }`;
  const children = await Promise.all([0, 1].map(() => execute(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env } })));
  const results = children.map(({ stdout }) => JSON.parse(stdout));
  assert.equal(results.filter(({ revision }) => typeof revision === "string").length, 1);
  assert.equal(results.filter(({ code }) => code === "WEAVE_SKILL_CONFLICT").length, 1);
  assert.equal((await getApplicationSkillHistory(skill.name)).entries.length, 2);
  await assert.rejects(access(lockPath), { code: "ENOENT" });
}));

test("Git commits include only selected skill changes and preserve unrelated staged and working files", async () => fixture(async (root) => {
  const skill = await readApplicationSkill("technical-report-slides");
  await writeFile(join(root, "private-notes.txt"), "A user-staged note\n");
  await git(root, "add", "--", "private-notes.txt");
  await writeFile(join(root, "untracked.txt"), "A separate work in progress\n");
  const updated = await updateApplicationSkill(update(skill, { body: `${skill.body}\n\nUpdated technical guidance.` }));
  assert.equal(await git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", updated.revision), `${skill.name}/SKILL.md`);
  assert.equal(await git(root, "diff", "--cached", "--name-only"), "private-notes.txt");
  assert.equal(await readFile(join(root, "private-notes.txt"), "utf8"), "A user-staged note\n");
  assert.equal(await readFile(join(root, "untracked.txt"), "utf8"), "A separate work in progress\n");
}));

test("a Git write failure rolls back skill, evidence, learning state, and HEAD together", async () => fixture(async (root, temporary) => {
  const skill = await readApplicationSkill("author-slide-preferences");
  const evidence = await readApplicationSkillEvidence(skill.name);
  const beforeIndex = await git(root, "ls-files", "--stage");
  const binary = (await execute("which", ["git"], { encoding: "utf8" })).stdout.trim();
  const bin = join(temporary, "bin");
  await mkdir(bin);
  const wrapper = join(bin, "git");
  await writeFile(wrapper, `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nconst args = process.argv.slice(2);\nif (args.includes('commit-tree')) { process.stderr.write('Injected Git failure\\n'); process.exit(42); }\nconst child = spawnSync(${JSON.stringify(binary)}, args, {stdio:'inherit',env:process.env});\nprocess.exit(child.status ?? 1);\n`);
  await chmod(wrapper, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  try {
    await assert.rejects(updateApplicationSkill(update(skill, { body: "Replacement body", evidence: "Replacement evidence\n", learningState: { enabled: true } })), { code: "WEAVE_SKILL_GIT" });
    const later = join(root, skill.name, "references", "later.md");
    await writeFile(later, "Preserve the full existing folder if restore fails\n");
    await assert.rejects(restoreApplicationSkill({ name: skill.name, commit: skill.revision, expectedRevision: skill.revision, message: "Restore earlier instructions after reviewing the author's guidance" }), { code: "WEAVE_SKILL_GIT" });
    assert.equal(await readFile(later, "utf8"), "Preserve the full existing folder if restore fails\n");
    await rm(later);
  } finally { process.env.PATH = previousPath; }
  assert.equal((await readApplicationSkill(skill.name)).content, skill.content);
  assert.equal((await readApplicationSkillEvidence(skill.name)).content, evidence.content);
  assert.deepEqual(await readApplicationLearningState(), { revision: skill.revision, state: null });
  assert.equal(await git(root, "rev-parse", "HEAD"), skill.revision);
  assert.equal(await git(root, "ls-files", "--stage"), beforeIndex);
  assert.equal(await git(root, "status", "--porcelain"), "");
}));

test("only supported names and reachable full commit IDs can access history", async () => fixture(async (root) => {
  const skill = await readApplicationSkill("technical-report-slides");
  await assert.rejects(readApplicationSkill("../outside"), { code: "WEAVE_SKILL_INVALID" });
  await assert.rejects(readApplicationSkill("other-skill"), { code: "WEAVE_SKILL_NOT_FOUND" });
  await assert.rejects(getApplicationSkillVersion(skill.name, "HEAD:../outside"), { code: "WEAVE_SKILL_INVALID" });
  await assert.rejects(getApplicationSkillVersion(skill.name, "1".repeat(40)), { code: "WEAVE_SKILL_NOT_FOUND" });
  const tree = await git(root, "rev-parse", "HEAD^{tree}");
  const unreachable = (await execute("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "-C", root, "commit-tree", tree, "-m", "Unreachable version"], { encoding: "utf8" })).stdout.trim();
  await assert.rejects(getApplicationSkillVersion(skill.name, unreachable), { code: "WEAVE_SKILL_NOT_FOUND" });
  await assert.rejects(updateApplicationSkill(update(skill, { expectedRevision: null })), { code: "WEAVE_SKILL_INVALID" });
  await assert.rejects(updateApplicationSkill(update(skill, { message: "" })), { code: "WEAVE_SKILL_INVALID" });
  const omitted = update(skill);
  delete omitted.frontmatter;
  await assert.rejects(updateApplicationSkill(omitted), { code: "WEAVE_SKILL_INVALID" });
  await assert.rejects(updateApplicationSkill(update(skill, { frontmatter: undefined })), { code: "WEAVE_SKILL_INVALID" });
}));

test("storage refuses foreign repositories and symbolic links without changing their targets", async () => fixture(async (root, temporary) => {
  await mkdir(root);
  await git(root, "init", "--quiet");
  await assert.rejects(initializeApplicationSkills(), { code: "WEAVE_SKILL_INVALID" });
  await rm(root, { recursive: true });
  const outside = join(temporary, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "Untouched\n");
  await symlink(outside, root);
  await assert.rejects(initializeApplicationSkills(), { code: "WEAVE_SKILL_INVALID" });
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "Untouched\n");
  await rm(root);
  const skill = await readApplicationSkill("technical-report-slides");
  await rm(skill.filePath);
  await symlink(join(outside, "sentinel"), skill.filePath);
  assert.equal((await readApplicationSkill(skill.name)).valid, false);
  await assert.rejects(updateApplicationSkill(update(skill, { body: "Do not follow links" })), { code: "WEAVE_SKILL_INVALID" });
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "Untouched\n");
}));
