import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createSkill,
  createProjectSkillSnapshot,
  deleteSkill,
  demoteSkill,
  listSkills,
  parseSkillDocument,
  promoteSkill,
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

test("project and common skills round-trip with required fields and preserved frontmatter", async () => {
  const { home, project } = await fixtureRoots();
  try {
    const created = await createSkill(project, { scope: "project", name: "review-slides", description: "Review a slide", body: "# Review", frontmatter: "license: MIT\nmetadata:\n  short-description: Slide review" });
    assert.equal(created.scope, "project");
    assert.equal(created.path, ".codex/skills/review-slides/SKILL.md");
    assert.match(created.content, /license: MIT/);
    assert.match(created.content, /metadata:\n  short-description: Slide review/);

    const updated = await updateSkill(project, { scope: "project", currentName: "review-slides", name: "review-slides", description: "Updated description", body: "Updated instructions", frontmatter: "license: MIT\nmetadata:\n  short-description: Slide review" });
    assert.equal(updated.description, "Updated description");
    assert.equal(updated.frontmatter, "license: MIT\nmetadata:\n  short-description: Slide review");
    assert.match(await readFile(join(project, ".codex/skills/review-slides/SKILL.md"), "utf8"), /description: "Updated description"/);

    await promoteSkill(project, "review-slides");
    assert.deepEqual((await listSkills(project)).map(({ scope, name }) => ({ scope, name })), [{ scope: "common", name: "review-slides" }]);
    assert.equal((await readFile(join(home, ".codex/skills/review-slides/SKILL.md"), "utf8")).includes("Updated instructions"), true);

    await demoteSkill(project, "review-slides");
    const deleted = await deleteSkill(project, "project", "review-slides");
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
    await createSkill(project, { scope: "project", name: "with-resources", description: "Resource skill", body: "Use the resources." });
    const skillDirectory = join(project, ".codex", "skills", "with-resources");
    await mkdir(join(skillDirectory, "scripts"), { recursive: true });
    await mkdir(join(skillDirectory, "references"), { recursive: true });
    await writeFile(join(skillDirectory, "scripts", "check.sh"), "#!/bin/sh\nprintf ok\n");
    await writeFile(join(skillDirectory, "references", "guide.md"), "Keep this guide.\n");

    await updateSkill(project, { scope: "project", currentName: "with-resources", name: "with-resources-renamed", description: "Renamed resource skill", body: "Use the resources.", frontmatter: null });
    await access(join(project, ".codex", "skills", "with-resources-renamed", "scripts", "check.sh"));
    assert.equal(await readFile(join(project, ".codex", "skills", "with-resources-renamed", "references", "guide.md"), "utf8"), "Keep this guide.\n");

    await promoteSkill(project, "with-resources-renamed");
    await access(join(home, ".codex", "skills", "with-resources-renamed", "scripts", "check.sh"));
    await demoteSkill(project, "with-resources-renamed");
    await deleteSkill(project, "project", "with-resources-renamed");
    await assert.rejects(access(join(project, ".codex", "skills", "with-resources-renamed", "references", "guide.md")), { code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("failed Agent work can restore the complete project skill tree", async () => {
  const { home, project } = await fixtureRoots();
  try {
    await createSkill(project, { scope: "project", name: "existing-skill", description: "Original", body: "Original body" });
    const snapshot = await createProjectSkillSnapshot(project);
    await updateSkill(project, { scope: "project", currentName: "existing-skill", name: "existing-skill", description: "Changed", body: "Changed body", frontmatter: null });
    await createSkill(project, { scope: "project", name: "partial-skill", description: "Partial", body: "Partial body" });
    await rm(join(project, ".codex"), { recursive: true, force: true });

    await restoreProjectSkillSnapshot(project, snapshot);

    const restored = await listSkills(project, "project");
    assert.deepEqual(restored.map(({ name, description, body }) => ({ name, description, body })), [{ name: "existing-skill", description: "Original", body: "Original body" }]);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("failed Agent skill rollback replaces symlinked project paths without following them", async () => {
  const { home, project } = await fixtureRoots();
  const outside = await mkdtemp(join(tmpdir(), "weave-skill-restore-outside-"));
  try {
    await createSkill(project, { scope: "project", name: "existing-skill", description: "Original", body: "Original body" });
    const snapshot = await createProjectSkillSnapshot(project);
    await rm(join(project, ".codex"), { recursive: true, force: true });
    await writeFile(join(outside, "sentinel.txt"), "untouched\n");
    await symlink(outside, join(project, ".codex"));

    await restoreProjectSkillSnapshot(project, snapshot);

    assert.equal(await readFile(join(outside, "sentinel.txt"), "utf8"), "untouched\n");
    assert.equal((await listSkills(project, "project"))[0].name, "existing-skill");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("common skills use CODEX_HOME when configured", async () => {
  const { home, project } = await fixtureRoots();
  const codexHome = await mkdtemp(join(tmpdir(), "weave-codex-home-"));
  process.env.CODEX_HOME = codexHome;
  try {
    const created = await createSkill(project, { scope: "common", name: "configured-home", description: "Configured home", body: "Use the configured home." });
    assert.equal(created.path, "$CODEX_HOME/skills/configured-home/SKILL.md");
    await access(join(codexHome, "skills", "configured-home", "SKILL.md"));
    await assert.rejects(access(join(home, ".codex", "skills", "configured-home", "SKILL.md")), { code: "ENOENT" });
  } finally {
    delete process.env.CODEX_HOME;
    await rm(codexHome, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("same names conflict across scopes and upload never overwrites", async () => {
  const { home, project } = await fixtureRoots();
  try {
    await createSkill(project, { scope: "common", name: "shared-rule", description: "Common rule", body: "Common body" });
    await assert.rejects(createSkill(project, { scope: "project", name: "shared-rule", description: "Project rule", body: "Project body" }), (error) => error?.code === "WEAVE_SKILL_CONFLICT");
    await assert.rejects(uploadSkill(project, { scope: "common", filename: "SKILL.md", content: fixtureContent("shared-rule") }), (error) => error?.code === "WEAVE_SKILL_CONFLICT");
    await assert.rejects(uploadSkill(project, { scope: "project", content: fixtureContent("new-rule") }), (error) => error?.code === "WEAVE_SKILL_INVALID");
    await assert.rejects(uploadSkill(project, { scope: "project", filename: "notes.md", content: fixtureContent("new-rule") }), (error) => error?.code === "WEAVE_SKILL_INVALID");
    const source = await readFile(join(home, ".codex/skills/shared-rule/SKILL.md"), "utf8");
    assert.match(source, /Common body/);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("invalid Agent-authored skill files remain visible, repairable, and deletable", async () => {
  const { home, project } = await fixtureRoots();
  try {
    const directory = join(project, ".codex", "skills", "broken-skill");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), "not valid frontmatter\n");

    const [broken] = await listSkills(project, "project");
    assert.equal(broken.valid, false);
    assert.match(broken.error, /frontmatter/);

    const repaired = await updateSkill(project, { scope: "project", currentName: "broken-skill", name: "broken-skill", description: "Repaired skill", body: "Use these instructions.", frontmatter: null });
    assert.equal(repaired.valid, true);

    await writeFile(join(directory, "SKILL.md"), "broken again\n");
    const deleted = await deleteSkill(project, "project", "broken-skill");
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
    const repairDirectory = join(project, ".codex", "skills", "oversized-repair");
    const deleteDirectory = join(project, ".codex", "skills", "oversized-delete");
    await mkdir(repairDirectory, { recursive: true });
    await mkdir(deleteDirectory, { recursive: true });
    const oversized = "x".repeat(1_000_001);
    await writeFile(join(repairDirectory, "SKILL.md"), oversized);
    await writeFile(join(deleteDirectory, "SKILL.md"), oversized);

    const invalid = await listSkills(project, "project");
    assert.equal(invalid.length, 2);
    assert.equal(invalid.every((skill) => !skill.valid && skill.content === ""), true);

    const repaired = await updateSkill(project, { scope: "project", currentName: "oversized-repair", name: "oversized-repair", description: "Repaired", body: "Safe body", frontmatter: null });
    assert.equal(repaired.valid, true);
    await deleteSkill(project, "project", "oversized-delete");
    await assert.rejects(access(deleteDirectory), { code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("partial Agent-authored skill folders without SKILL.md remain repairable and deletable", async () => {
  const { home, project } = await fixtureRoots();
  try {
    const repairDirectory = join(project, ".codex", "skills", "partial-repair");
    const deleteDirectory = join(project, ".codex", "skills", "partial-delete");
    await mkdir(join(repairDirectory, "references"), { recursive: true });
    await mkdir(join(deleteDirectory, "scripts"), { recursive: true });
    await writeFile(join(repairDirectory, "references", "note.md"), "Keep me.\n");

    const partial = await listSkills(project, "project");
    assert.equal(partial.length, 2);
    assert.equal(partial.every((skill) => !skill.valid && /not found/i.test(skill.error)), true);

    const repaired = await updateSkill(project, { scope: "project", currentName: "partial-repair", name: "partial-repair", description: "Recovered", body: "Recovered body", frontmatter: null });
    assert.equal(repaired.valid, true);
    assert.equal(await readFile(join(repairDirectory, "references", "note.md"), "utf8"), "Keep me.\n");
    await deleteSkill(project, "project", "partial-delete");
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
    const linkedDirectory = join(project, ".codex", "skills", "linked-file");
    const unreadableDirectory = join(project, ".codex", "skills", "unreadable-file");
    await mkdir(linkedDirectory, { recursive: true });
    await mkdir(unreadableDirectory, { recursive: true });
    await writeFile(outside, fixtureContent("linked-file"));
    await symlink(outside, join(linkedDirectory, "SKILL.md"));
    const unreadablePath = join(unreadableDirectory, "SKILL.md");
    await writeFile(unreadablePath, fixtureContent("unreadable-file"));
    await chmod(unreadablePath, 0o000);

    const listed = await listSkills(project, "project");
    assert.deepEqual(listed.map(({ name, valid }) => ({ name, valid })), [
      { name: "linked-file", valid: false },
      { name: "unreadable-file", valid: false },
    ]);

    await deleteSkill(project, "project", "linked-file");
    await deleteSkill(project, "project", "unreadable-file");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("skill paths reject symlinked skill directories", async () => {
  const { home, project } = await fixtureRoots();
  const outside = await mkdtemp(join(tmpdir(), "weave-skill-outside-"));
  try {
    await createSkill(project, { scope: "project", name: "safe-skill", description: "Safe", body: "Body" });
    await rm(join(project, ".codex/skills/safe-skill"), { recursive: true, force: true });
    await symlink(outside, join(project, ".codex/skills/safe-skill"));
    await assert.rejects(updateSkill(project, { scope: "project", currentName: "safe-skill", name: "safe-skill", description: "Unsafe", body: "Should not write", frontmatter: null }), (error) => error?.code === "WEAVE_SKILL_INVALID" || error?.code === "WEAVE_SKILL_NOT_FOUND");
    assert.equal((await listSkills(project)).some((skill) => skill.name === "safe-skill"), false);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
