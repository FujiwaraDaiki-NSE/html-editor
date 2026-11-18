import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { consolidateSlideSkills } from "../scripts/consolidate-slide-skills.mjs";
import { consolidateApplicationSlideSkills, initializeApplicationSkills, readApplicationSkill, updateApplicationSkill, updateApplicationLearningState } from "../server/application-skills.mjs";
import { parseSkillDocument } from "../server/skills.mjs";
const execute = promisify(execFile);
const fixture = (name) => readFile(new URL(`./fixtures/legacy-slide-skills/${name}.md`, import.meta.url), "utf8");

async function withStore(run) {
  const temporary = await mkdtemp(join(tmpdir(), "weave-consolidation-"));
  const previous = { application: process.env.WEAVE_APPLICATION_SKILLS_ROOT, editor: process.env.WEAVE_SKILLS_ROOT };
  const applicationRoot = join(temporary, "application");
  const editorRoot = join(temporary, "editor");
  process.env.WEAVE_APPLICATION_SKILLS_ROOT = applicationRoot;
  process.env.WEAVE_SKILLS_ROOT = editorRoot;
  try { await run({ applicationRoot, editorRoot }); }
  finally {
    for (const [key, value] of [["WEAVE_APPLICATION_SKILLS_ROOT", previous.application], ["WEAVE_SKILLS_ROOT", previous.editor]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

async function legacyStore(roots) {
  await initializeApplicationSkills();
  for (const name of ["technical-report-slides", "author-slide-preferences"]) {
    const old = parseSkillDocument(await fixture(name), name);
    const current = await readApplicationSkill(name);
    await updateApplicationSkill({ name, description: old.description, body: old.body, frontmatter: "metadata:\n  owner: retained", expectedRevision: current.revision, message: "Install the former approved rules to exercise upgrade behavior" });
  }
  await mkdir(join(roots.editorRoot, "slide-authoring", "references"), { recursive: true });
  await writeFile(join(roots.editorRoot, "slide-authoring", "SKILL.md"), await fixture("slide-authoring"));
  await writeFile(join(roots.editorRoot, "slide-authoring", "references", "sources.md"), "Keep the original sources.\n");
}

test("consolidation preserves learned blocks, candidate evidence, settings, metadata and reachable history; retries are unchanged", async () => withStore(async (roots) => {
  await legacyStore(roots);
  const learned = '<!-- weave:learned-slide-preferences:start -->\n## Learned\n\n```json\n[{"id":"retained-active","prefer":"Keep my agreed typography"}]\n```\n<!-- weave:learned-slide-preferences:end -->';
  const author = await readApplicationSkill("author-slide-preferences");
  const evidence = 'Original evidence\n<!-- weave:slide-preference-evidence:start -->\n```json\n{"version":1,"entries":[{"id":"retained-candidate","status":"candidate"}]}\n```\n<!-- weave:slide-preference-evidence:end -->\n';
  const saved = await updateApplicationSkill({ name: author.name, description: "Custom description kept during consolidation", body: author.body + "\n\n" + learned, frontmatter: author.frontmatter, expectedRevision: author.revision, evidence, message: "Retain existing learning data for the upgrade" });
  const state = { version: 1, enabled: false, lastOutcome: null };
  const before = await updateApplicationLearningState({ expectedRevision: saved.revision, state, message: "Preserve disabled learning during maintenance" });
  const settingsPath = join(roots.applicationRoot, ".weave", "slide-preference-learning.json");
  const settings = await readFile(settingsPath, "utf8");
  const migrated = await consolidateSlideSkills(roots);
  assert.equal(migrated.changed, true);
  assert.equal(migrated.editorUpdated, true);
  const after = await readApplicationSkill(author.name);
  assert.ok(after.body.endsWith(learned));
  assert.equal(after.frontmatter, author.frontmatter);
  assert.equal(after.description, "Custom description kept during consolidation");
  const laterEvidence = await readFile(join(roots.applicationRoot, author.name, "references", "evidence.md"), "utf8");
  assert.ok(laterEvidence.startsWith(evidence));
  assert.equal(laterEvidence.split('"status":"candidate"').length, 2);
  assert.equal(await readFile(settingsPath, "utf8"), settings);
  await execute("git", ["-C", roots.applicationRoot, "merge-base", "--is-ancestor", before.revision, migrated.revision]);
  assert.equal(await readFile(join(roots.editorRoot, "slide-authoring", "references", "before-consolidation.md"), "utf8"), await fixture("slide-authoring"));
  assert.equal(await readFile(join(roots.editorRoot, "slide-authoring", "references", "sources.md"), "utf8"), "Keep the original sources.\n");
  assert.deepEqual(await consolidateSlideSkills(roots), { revision: migrated.revision, changed: false, editorUpdated: false });
}));

test("unknown application instructions prevent the entire body/evidence consolidation", async () => withStore(async (roots) => {
  await legacyStore(roots);
  const skill = await readApplicationSkill("author-slide-preferences");
  const saved = await updateApplicationSkill({ name: skill.name, description: skill.description, body: skill.body + "\n\nCustom accepted rule", frontmatter: skill.frontmatter, expectedRevision: skill.revision, message: "Keep a custom rule the migration must not discard" });
  const technical = await readApplicationSkill("technical-report-slides");
  await assert.rejects(consolidateSlideSkills(roots), /custom instructions/);
  assert.equal((await readApplicationSkill(skill.name)).content, saved.content);
  assert.equal((await readApplicationSkill(technical.name)).content, technical.content);
  assert.equal((await readApplicationSkill(skill.name)).revision, saved.revision);
  assert.equal(await readFile(join(roots.editorRoot, "slide-authoring", "SKILL.md"), "utf8"), await fixture("slide-authoring"));
}));

test("unknown editor instructions are rejected before application changes", async () => withStore(async (roots) => {
  await legacyStore(roots);
  const before = await readApplicationSkill("technical-report-slides");
  await writeFile(join(roots.editorRoot, "slide-authoring", "SKILL.md"), (await fixture("slide-authoring")) + "\nCustom editor instruction\n");
  await assert.rejects(consolidateSlideSkills(roots), /custom instructions/);
  assert.equal((await readApplicationSkill(before.name)).content, before.content);
  assert.equal((await readApplicationSkill(before.name)).revision, before.revision);
}));

test("startup adds a missing standard baseline without replacing old approved instructions", async () => withStore(async (roots) => {
  await legacyStore(roots);
  const before = await readApplicationSkill("author-slide-preferences");
  await rm(join(roots.applicationRoot, "slide-authoring"), { recursive: true });
  const result = await initializeApplicationSkills();
  assert.notEqual(result.revision, before.revision);
  assert.equal((await readApplicationSkill(before.name)).content, before.content);
  assert.equal((await readApplicationSkill("slide-authoring")).valid, true);
  assert.equal((await initializeApplicationSkills()).revision, result.revision);
}));

test("stale revisions cannot consolidate over a newer preference edit", async () => withStore(async (roots) => {
  await legacyStore(roots);
  const before = await readApplicationSkill("author-slide-preferences");
  const saved = await updateApplicationSkill({ name: before.name, description: before.description, body: before.body, frontmatter: "metadata:\n  newer: true", expectedRevision: before.revision, message: "Retain a newer metadata edit while maintenance was pending" });
  await assert.rejects(consolidateApplicationSlideSkills(before.revision), { code: "WEAVE_SKILL_CONFLICT" });
  assert.equal((await readApplicationSkill(before.name)).content, saved.content);
  assert.equal((await readApplicationSkill(before.name)).revision, saved.revision);
}));
