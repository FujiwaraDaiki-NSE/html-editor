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
  assert.match(page, /role="tablist" aria-label="スキルの適用範囲"/);
  assert.match(page, /scope === "project" \? "プロジェクト固有" : "共通"/);
  assert.match(page, /SKILL\.mdをアップロード/);
  assert.match(page, /className="skill-dialog" role="dialog"/);
  assert.match(page, /共通スキルに格上げしました。/);
  assert.match(page, /プロジェクト固有へ格下げ/);
  assert.match(page, /typeof catalogSkill\?\.enabled === "boolean"/);
  assert.match(page, /entry\.path === skill\.filePath/);
  assert.doesNotMatch(page, /entry\.path\.endsWith\(skill\.path\)/);
  assert.match(page, /typeof entry\.path !== "string" \|\| !entry\.path\.trim\(\)/);
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

test("Skills API has explicit scoped CRUD, upload, and move routes", () => {
  for (const route of [
    'url.pathname === "/api/skills"',
    'url.pathname === "/api/skills/upload"',
    '"/api/skills/promote", "/api/skills/demote"',
    'scopedSkillAction = url.pathname.match',
    'scopedSkill = url.pathname.match',
    'method === "DELETE"',
  ]) assert.match(api, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(routes, /project\|common[\s\S]*PATCH.*DELETE/);
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

test("Legacy cramped Settings skill toggles are removed but catalog support remains card-local", () => {
  assert.doesNotMatch(page, /<section><h3>(?:Skills|スキル)<\/h3>/);
  assert.match(page, /catalogSkills/);
  assert.match(page, /codex\/skill\/config/);
});
