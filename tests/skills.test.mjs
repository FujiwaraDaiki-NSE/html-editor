import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createSkill,
  createProjectSkillSnapshot,
  deleteSkill,
  listSkills,
  parseSkillDocument,
  restoreProjectSkillSnapshot,
  updateSkill,
  uploadSkill,
  validateSkillName,
} from "../server/skills.mjs";

const fixtureContent = (name = "review-slides") => `---
name: ${name}
description: Review a slide
license: MIT
metadata:
  short-description: Slide review
---

# Review

Check the slide for clarity.
`;

async function fixtureRoots() {
  const home = await mkdtemp(join(tmpdir(), "weave-skill-home-"));
  const project = await mkdtemp(join(tmpdir(), "weave-skill-project-"));
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  process.env.WEAVE_SKILLS_ROOT = join(home, "editor-skills");
  return { home, project };
}

test("skill names and documents require the safe, explicit shape", () => {
  assert.equal(validateSkillName("review-slides"), "review-slides");
  assert.throws(() => validateSkillName("Review Slides"), /lowercase kebab-case/);
  assert.throws(() => validateSkillName("a".repeat(64)), /under 64/);
  assert.throws(() => parseSkillDocument("# no frontmatter"), /frontmatter/);
  assert.throws(() => parseSkillDocument("---\nname: review\ndescription: test\n---\n"), /body is required/);
  assert.throws(() => parseSkillDocument("---\nname: review\n---\nBody"), /description is required/);
  assert.throws(() => parseSkillDocument('---\nname: review\ndescription: test\n  orphan: true\n---\nBody'), /invalid YAML/);
});

test("multiline YAML descriptions remain readable without leaking into preserved frontmatter", () => {
  const parsed = parseSkillDocument(`---
name: slide-guidance
description: |-
  Create slides with the approved visual language.
  Use when a deck must match the house style.
metadata:
  short-description: Slide guidance
---

# Instructions

Keep the hierarchy clear.
`);
  assert.equal(parsed.description, "Create slides with the approved visual language.\nUse when a deck must match the house style.");
  assert.equal(parsed.unknownFrontmatter, "metadata:\n  short-description: Slide guidance");
});

test("editor skills round-trip with required fields and preserved frontmatter", async () => {
  const { home, project } = await fixtureRoots();
  try {
    const created = await createSkill(project, { scope: "editor", name: "review-slides", description: "Review a slide", body: "# Review", frontmatter: "license: MIT\nmetadata:\n  short-description: Slide review" });
    assert.equal(created.scope, "editor");
    assert.match(created.content, /license: MIT/);
    assert.match(created.content, /metadata:\n  short-description: Slide review/);

    const updated = await updateSkill(project, { scope: "editor", currentName: "review-slides", name: "review-slides", description: "Updated description", body: "Updated instructions", frontmatter: "license: MIT\nmetadata:\n  short-description: Slide review" });
    assert.equal(updated.description, "Updated description");
    assert.equal(updated.frontmatter, "license: MIT\nmetadata:\n  short-description: Slide review");
    assert.match(await readFile(join(home, "editor-skills/review-slides/SKILL.md"), "utf8"), /description: "Updated description"/);

    assert.deepEqual((await listSkills(project)).map(({ scope, name }) => ({ scope, name })), [{ scope: "editor", name: "review-slides" }]);
    assert.equal((await readFile(join(home, "editor-skills/review-slides/SKILL.md"), "utf8")).includes("Updated instructions"), true);

    const deleted = await deleteSkill(project, "editor", "review-slides");
    assert.equal(deleted.deleted, true);
    assert.deepEqual(await listSkills(project), []);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("folder operations preserve and remove skill support files", async () => {
  const { home, project } = await fixtureRoots();
  try {
    await createSkill(project, { scope: "editor", name: "with-resources", description: "Resource skill", body: "Use the resources." });
    const skillDirectory = join(home, "editor-skills", "with-resources");
    await mkdir(join(skillDirectory, "scripts"), { recursive: true });
    await mkdir(join(skillDirectory, "references"), { recursive: true });
    await writeFile(join(skillDirectory, "scripts", "check.sh"), "#!/bin/sh\nprintf ok\n");
    await writeFile(join(skillDirectory, "references", "guide.md"), "Keep this guide.\n");

    await updateSkill(project, { scope: "editor", currentName: "with-resources", name: "with-resources-renamed", description: "Renamed resource skill", body: "Use the resources.", frontmatter: null });
    await access(join(home, "editor-skills", "with-resources-renamed", "scripts", "check.sh"));
    assert.equal(await readFile(join(home, "editor-skills", "with-resources-renamed", "references", "guide.md"), "utf8"), "Keep this guide.\n");

    await access(join(home, "editor-skills", "with-resources-renamed", "scripts", "check.sh"));
    await deleteSkill(project, "editor", "with-resources-renamed");
    await assert.rejects(access(join(home, "editor-skills", "with-resources-renamed", "references", "guide.md")), { code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("failed Agent work can restore the complete project skill tree", async () => {
  const { home, project } = await fixtureRoots();
  try {
    const legacy = join(project, ".codex", "skills", "existing-skill");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "SKILL.md"), fixtureContent("existing-skill"));
    const snapshot = await createProjectSkillSnapshot(project);
    await rm(join(project, ".codex"), { recursive: true, force: true });

    await restoreProjectSkillSnapshot(project, snapshot);

    assert.match(await readFile(join(legacy, "SKILL.md"), "utf8"), /existing-skill/);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("failed Agent skill rollback replaces symlinked project paths without following them", async () => {
  const { home, project } = await fixtureRoots();
  const outside = await mkdtemp(join(tmpdir(), "weave-skill-restore-outside-"));
  try {
    const legacy = join(project, ".codex", "skills", "existing-skill");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "SKILL.md"), fixtureContent("existing-skill"));
    const snapshot = await createProjectSkillSnapshot(project);
    await rm(join(project, ".codex"), { recursive: true, force: true });
    await writeFile(join(outside, "sentinel.txt"), "untouched\n");
    await symlink(outside, join(project, ".codex"));

    await restoreProjectSkillSnapshot(project, snapshot);

    assert.equal(await readFile(join(outside, "sentinel.txt"), "utf8"), "untouched\n");
    assert.match(await readFile(join(legacy, "SKILL.md"), "utf8"), /existing-skill/);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("same names conflict across scopes and upload never overwrites", async () => {
  const { home, project } = await fixtureRoots();
  try {
    await createSkill(project, { scope: "editor", name: "shared-rule", description: "Common rule", body: "Common body" });
    await assert.rejects(createSkill(project, { scope: "editor", name: "shared-rule", description: "Project rule", body: "Project body" }), (error) => error?.code === "WEAVE_SKILL_CONFLICT");
    await assert.rejects(uploadSkill(project, { scope: "editor", filename: "SKILL.md", content: fixtureContent("shared-rule") }), (error) => error?.code === "WEAVE_SKILL_CONFLICT");
    await assert.rejects(uploadSkill(project, { scope: "editor", content: fixtureContent("new-rule") }), (error) => error?.code === "WEAVE_SKILL_INVALID");
    await assert.rejects(uploadSkill(project, { scope: "editor", filename: "notes.md", content: fixtureContent("new-rule") }), (error) => error?.code === "WEAVE_SKILL_INVALID");
    const source = await readFile(join(home, "editor-skills/shared-rule/SKILL.md"), "utf8");
    assert.match(source, /Common body/);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("invalid Agent-authored skill files remain visible, repairable, and deletable", async () => {
  const { home, project } = await fixtureRoots();
  try {
    const directory = join(home, "editor-skills", "broken-skill");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), "not valid frontmatter\n");

    const [broken] = await listSkills(project, "editor");
    assert.equal(broken.valid, false);
    assert.match(broken.error, /frontmatter/);

    const repaired = await updateSkill(project, { scope: "editor", currentName: "broken-skill", name: "broken-skill", description: "Repaired skill", body: "Use these instructions.", frontmatter: null });
    assert.equal(repaired.valid, true);

    await writeFile(join(directory, "SKILL.md"), "broken again\n");
    const deleted = await deleteSkill(project, "editor", "broken-skill");
    assert.equal(deleted.deleted, true);
    await assert.rejects(access(directory), { code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("oversized Agent-authored skill files cannot block listing, repair, or deletion", async () => {
  const { home, project } = await fixtureRoots();
  try {
    const repairDirectory = join(home, "editor-skills", "oversized-repair");
    const deleteDirectory = join(home, "editor-skills", "oversized-delete");
    await mkdir(repairDirectory, { recursive: true });
    await mkdir(deleteDirectory, { recursive: true });
    const oversized = "x".repeat(1_000_001);
    await writeFile(join(repairDirectory, "SKILL.md"), oversized);
    await writeFile(join(deleteDirectory, "SKILL.md"), oversized);

    const invalid = await listSkills(project, "editor");
    assert.equal(invalid.length, 2);
    assert.equal(invalid.every((skill) => !skill.valid && skill.content === ""), true);

    const repaired = await updateSkill(project, { scope: "editor", currentName: "oversized-repair", name: "oversized-repair", description: "Repaired", body: "Safe body", frontmatter: null });
    assert.equal(repaired.valid, true);
    await deleteSkill(project, "editor", "oversized-delete");
    await assert.rejects(access(deleteDirectory), { code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("partial Agent-authored skill folders without SKILL.md remain repairable and deletable", async () => {
  const { home, project } = await fixtureRoots();
  try {
    const repairDirectory = join(home, "editor-skills", "partial-repair");
    const deleteDirectory = join(home, "editor-skills", "partial-delete");
    await mkdir(join(repairDirectory, "references"), { recursive: true });
    await mkdir(join(deleteDirectory, "scripts"), { recursive: true });
    await writeFile(join(repairDirectory, "references", "note.md"), "Keep me.\n");

    const partial = await listSkills(project, "editor");
    assert.equal(partial.length, 2);
    assert.equal(partial.every((skill) => !skill.valid && /not found/i.test(skill.error)), true);

    const repaired = await updateSkill(project, { scope: "editor", currentName: "partial-repair", name: "partial-repair", description: "Recovered", body: "Recovered body", frontmatter: null });
    assert.equal(repaired.valid, true);
    assert.equal(await readFile(join(repairDirectory, "references", "note.md"), "utf8"), "Keep me.\n");
    await deleteSkill(project, "editor", "partial-delete");
    await assert.rejects(access(deleteDirectory), { code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("unsafe or unreadable SKILL.md entries cannot break the library listing", async () => {
  const { home, project } = await fixtureRoots();
  const outside = join(project, "outside.md");
  try {
    const linkedDirectory = join(home, "editor-skills", "linked-file");
    const unreadableDirectory = join(home, "editor-skills", "unreadable-file");
    await mkdir(linkedDirectory, { recursive: true });
    await mkdir(unreadableDirectory, { recursive: true });
    await writeFile(outside, fixtureContent("linked-file"));
    await symlink(outside, join(linkedDirectory, "SKILL.md"));
    const unreadablePath = join(unreadableDirectory, "SKILL.md");
    await writeFile(unreadablePath, fixtureContent("unreadable-file"));
    await chmod(unreadablePath, 0o000);

    const listed = await listSkills(project, "editor");
    assert.deepEqual(listed.map(({ name, valid }) => ({ name, valid })), [
      { name: "linked-file", valid: false },
      { name: "unreadable-file", valid: false },
    ]);

    await deleteSkill(project, "editor", "linked-file");
    await deleteSkill(project, "editor", "unreadable-file");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("skill paths reject symlinked skill directories", async () => {
  const { home, project } = await fixtureRoots();
  const outside = await mkdtemp(join(tmpdir(), "weave-skill-outside-"));
  try {
    await createSkill(project, { scope: "editor", name: "safe-skill", description: "Safe", body: "Body" });
    await rm(join(home, "editor-skills/safe-skill"), { recursive: true, force: true });
    await symlink(outside, join(home, "editor-skills/safe-skill"));
    await assert.rejects(updateSkill(project, { scope: "editor", currentName: "safe-skill", name: "safe-skill", description: "Unsafe", body: "Should not write", frontmatter: null }), (error) => error?.code === "WEAVE_SKILL_INVALID" || error?.code === "WEAVE_SKILL_NOT_FOUND");
    assert.equal((await listSkills(project)).some((skill) => skill.name === "safe-skill"), false);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("editor skills are shared across decks, isolated from Codex home, and passed fresh to the harness", async () => {
  const { home, project } = await fixtureRoots();
  const { CodexService } = await import("../server/codex/service.mjs");
  const { setEditorSkillEnabled } = await import("../server/skills.mjs");
  const codexHome = join(home, "codex-home");
  process.env.CODEX_HOME = codexHome;
  const other = join(home, "other-deck");
  try {
    await mkdir(join(codexHome, "skills", "external"), { recursive: true });
    await writeFile(join(codexHome, "skills", "external", "SKILL.md"), fixtureContent("external"));
    await mkdir(join(project, ".codex", "skills", "legacy"), { recursive: true });
    await writeFile(join(project, ".codex", "skills", "legacy", "SKILL.md"), fixtureContent("legacy"));
    await createSkill(project, { scope: "editor", name: "meaning", description: "Keep meaning", body: "Preserve causes and examples." });
    assert.deepEqual((await listSkills(other)).map(s => s.name), ["meaning"]);
    const harness = new CodexService({ projectRoot: other, instructions: "Base" });
    assert.match(await harness.editorInstructions(), /Preserve causes and examples/);
    assert.doesNotMatch(await harness.editorInstructions(), /external|legacy/);
    await setEditorSkillEnabled(project, "meaning", false);
    assert.equal((await listSkills(other))[0].enabled, false);
    assert.equal(await harness.editorInstructions(), "Base");
    await setEditorSkillEnabled(other, "meaning", true);
    assert.match(await harness.editorInstructions(), /Preserve causes and examples/);
    await assert.rejects(createSkill(project, { scope: "project", name: "rejected", description: "Old", body: "Old" }), /scope must be editor/);
    const results = await Promise.allSettled([project, other].map(root => createSkill(root, { scope: "editor", name: "same-name", description: "Concurrent", body: "One winner" })));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(results.find(r => r.status === "rejected").reason.code, "WEAVE_SKILL_CONFLICT");
    assert.equal(await readFile(join(codexHome, "skills", "external", "SKILL.md"), "utf8"), fixtureContent("external"));
    assert.equal(await readFile(join(project, ".codex", "skills", "legacy", "SKILL.md"), "utf8"), fixtureContent("legacy"));
  } finally {
    delete process.env.CODEX_HOME;
    delete process.env.WEAVE_SKILLS_ROOT;
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});
