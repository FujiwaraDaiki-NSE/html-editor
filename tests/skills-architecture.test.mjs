import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [page, css, api, routes, skills, project] = await Promise.all([
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  readFile(new URL("../server/local-api.mjs", import.meta.url), "utf8"),
  readFile(new URL("../server/route-methods.mjs", import.meta.url), "utf8"),
  readFile(new URL("../server/skills.mjs", import.meta.url), "utf8"),
  readFile(new URL("../server/project.mjs", import.meta.url), "utf8"),
]);

test("Skills is a first-class activity on desktop and mobile", () => {
  assert.match(page, /type ActivityView = .*"skills"/);
  assert.match(page, /type MobileView = .*"skills"/);
  assert.match(page, /aria-label="スキル"/);
  assert.match(page, /activityView === "skills" \? skillsSidebar/);
  assert.match(page, /className="activity-panel skills-panel"/);
  assert.match(page, /SKILL\.mdをアップロード/);
  assert.match(page, /className="skill-dialog" role="dialog"/);
  assert.match(page, /skillStatus\.state === "error" \? "alert" : "status"/);
  assert.match(page, /skillDialogTriggerRef/);
  assert.match(page, /event\.key !== "Tab"/);
  assert.match(page, /showActivity\("skills"\)/);
  assert.match(page, />その他\{/);
  assert.match(css, /\.skill-card-list/);
  assert.match(css, /\.skill-dialog-backdrop/);
  assert.match(css, /grid-template-columns: repeat\(4, 1fr\)/);
  assert.match(css, /grid-template-rows: repeat\(2, minmax\(44px, 1fr\)\)/);
});

test("Skills API has editor-only CRUD and upload routes", () => {
  for (const route of [
    'url.pathname === "/api/skills"',
    'url.pathname === "/api/skills/upload"',
    'scopedSkill = url.pathname.match',
    'method === "DELETE"',
  ]) assert.match(api, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(routes, /skills.*upload[\s\S]*POST/);
  assert.match(skills, /value\.length >= 64/);
  assert.match(skills, /WEAVE_SKILL_CONFLICT/);
  assert.match(skills, /await rename\(tempPath, path\)/);
  assert.match(api, /restoreProjectSkillSnapshot\(pending\.root, pending\.projectSkillSnapshot\)/);
  assert.match(api, /runSkillMutation\(operation\)[\s\S]*enqueueProjectSwitch[\s\S]*activeProjectTurn/);
  assert.match(skills, /unknownFrontmatter/);
  assert.match(project, /managedPaths = \[[\s\S]*\.codex\/skills/);
  assert.match(project, /createAgentFileSnapshot/);
  assert.match(project, /for \(const name of \["assets", "templates", "AGENTS\.md", "references", "\.codex\/skills"\]\)/);
  assert.match(project, /restoreGitDirectoryToDraft\(commit, "templates", currentProjectRoot, true\)/);
});

test("Skills GUI exposes editor-wide controls without project or Codex-wide moves", () => {
  assert.doesNotMatch(page, /<section><h3>(?:Skills|スキル)<\/h3>/);
  assert.match(page, /html-editor共通/);
  assert.match(page, /すべての資料で有効/);
  assert.doesNotMatch(page, /共通に格上げ|プロジェクト固有へ格下げ|この1回だけプロジェクトスキル/);
});
