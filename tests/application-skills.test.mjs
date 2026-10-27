import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { load } from "js-yaml";
const skillRoot = await mkdtemp(join(tmpdir(), "weave-managed-skills-"));
const previousSkillsRoot = process.env.WEAVE_APPLICATION_SKILLS_ROOT;
process.env.WEAVE_APPLICATION_SKILLS_ROOT = skillRoot;
const { initializeApplicationSkills } = await import("../server/application-skills.mjs");
await initializeApplicationSkills();
const { applicationSkillInstructions } = await import("../server/agent-skills.mjs");
const { chatInstructions } = await import("../server/chat-workflow.mjs");
after(async () => {
  if (previousSkillsRoot === undefined) delete process.env.WEAVE_APPLICATION_SKILLS_ROOT;
  else process.env.WEAVE_APPLICATION_SKILLS_ROOT = previousSkillsRoot;
  await rm(skillRoot, { recursive: true, force: true });
});

const paths = [...applicationSkillInstructions.matchAll(/^- (.+\/SKILL\.md)$/gm)].map((match) => match[1]);

test("root chat and editor use the same readable application skills, outside user storage", async () => {
  const { agentInstructions } = await import("../server/project.mjs");
  assert.equal(paths.length, 2);
  assert.ok(chatInstructions.includes(applicationSkillInstructions));
  assert.ok(agentInstructions.includes(applicationSkillInstructions));
  for (const path of paths) {
    assert.ok(path.startsWith(`${skillRoot}/`));
    assert.ok(!path.includes("/.codex/skills/"));
    const content = await readFile(path, "utf8");
    const metadata = load(content.match(/^---\n([\s\S]*?)\n---/)[1]);
    assert.equal(typeof metadata.name, "string");
    assert.equal(typeof metadata.description, "string");
  }
});

test("new and reopened projects reference the shared skills without copying or overwriting preferences", async () => {
  const root = await mkdtemp(join(tmpdir(), "weave-application-skills-"));
  const previousRoot = process.env.WEAVE_PROJECT_ROOT;
  const previousWorkspaces = process.env.WEAVE_WORKSPACES_ROOT;
  process.env.WEAVE_PROJECT_ROOT = join(root, "startup");
  process.env.WEAVE_WORKSPACES_ROOT = join(root, "workspaces");
  try {
    const project = await import(`../server/project.mjs?application-skills=${Date.now()}`);
    const originals = await Promise.all(paths.map((path) => readFile(path, "utf8")));
    await project.ensureProject();
    await writeFile(join(project.projectRoot(), "AGENTS.md"), "Previous application instructions\n");
    await project.ensureProject();
    const restored = await readFile(join(project.projectRoot(), "AGENTS.md"), "utf8");
    assert.ok(restored.includes(applicationSkillInstructions));
    const slug = await project.createProject({ title: "Shared skills", templateId: "plain" });
    await project.switchProject(slug);
    const created = await readFile(join(project.projectRoot(), "AGENTS.md"), "utf8");
    assert.ok(created.includes(applicationSkillInstructions));
    assert.deepEqual(await Promise.all(paths.map((path) => readFile(path, "utf8"))), originals);
    for (const path of paths) {
      const name = path.split("/").at(-2);
      await assert.rejects(readFile(join(project.projectRoot(), ".codex", "skills", name, "SKILL.md")), { code: "ENOENT" });
    }
  } finally {
    if (previousRoot === undefined) delete process.env.WEAVE_PROJECT_ROOT; else process.env.WEAVE_PROJECT_ROOT = previousRoot;
    if (previousWorkspaces === undefined) delete process.env.WEAVE_WORKSPACES_ROOT; else process.env.WEAVE_WORKSPACES_ROOT = previousWorkspaces;
    await rm(root, { recursive: true, force: true });
  }
});
