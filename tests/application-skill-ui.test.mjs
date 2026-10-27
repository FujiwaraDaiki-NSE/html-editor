import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { isApplicationSkill, mutateApplicationSkill, readApplicationSkillHistory, readApplicationSkillVersion, readLearningState, SkillRequestError, updateLearningState } from "../app/components/application-skill-requests.ts";

const revision = "a".repeat(40);
const nextRevision = "b".repeat(40);
const skill = {
  name: "author-slide-preferences", description: "資料の好み", body: "見出しを短くする。", content: "---\nname: author-slide-preferences\n---\n見出しを短くする。",
  frontmatter: null, scope: "application", location: "application", path: "author-slide-preferences/SKILL.md", filePath: "/skills/author-slide-preferences/SKILL.md",
  valid: true, error: null, revision,
  capabilities: { edit: true, history: true, restore: true, delete: false, move: false },
};
const learning = { enabled: true, revision, capabilities: { configure: true }, unavailableReason: null, lastOutcome: { status: "learned", at: "2026-10-27T09:00:00Z", reason: "明示された好みを反映しました。", ruleId: "short-title", threadId: "thread-1", turnId: "turn-1" } };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function mockFetch(t, implementation) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  t.after(() => { globalThis.fetch = original; });
}

test("application skill reads keep the current revision and inspect a selected historical version without a mutation", async (t) => {
  const calls = [];
  const entry = { id: nextRevision, shortId: "bbbbbbb", message: "短い見出しを指定", date: "2026-10-27T09:00:00Z" };
  mockFetch(t, async (url, options) => {
    calls.push({ url, options });
    return response(String(url).includes("/version?") ? { revision, skill } : { revision, entries: [entry] });
  });
  const controller = new AbortController();
  const history = await readApplicationSkillHistory(skill.name, controller.signal);
  const version = await readApplicationSkillVersion(skill.name, entry.id, controller.signal);
  assert.deepEqual(history, { revision, entries: [entry] });
  assert.equal(version.skill.body, skill.body);
  assert.equal(version.revision, revision);
  assert.equal(calls[0].url, `/api/skills/application/${skill.name}/history`);
  assert.equal(calls[1].url, `/api/skills/application/${skill.name}/version?commit=${entry.id}`);
  assert.ok(calls.every(({ options }) => options.method === undefined && options.signal === controller.signal));
});

test("editing and restoration send the displayed revision and keep backend capabilities", async (t) => {
  const calls = [];
  const result = { skill: { ...skill, revision: nextRevision }, skills: [{ ...skill, revision: nextRevision }], project: { clean: true, commit: "current", revision: "c".repeat(40) } };
  mockFetch(t, async (url, options) => { calls.push({ url, options, payload: JSON.parse(options.body) }); return response(result); });
  const updated = await mutateApplicationSkill(skill.name, "update", { name: skill.name, description: "短い見出し", body: "見出しは一行にする。", frontmatter: null, expectedRevision: revision, message: "見出しの好みを追記" });
  await mutateApplicationSkill(skill.name, "restore", { commit: "d".repeat(40), expectedRevision: nextRevision, message: "以前の内容へ戻す" });
  assert.equal(calls[0].options.method, "PATCH");
  assert.equal(calls[0].url, `/api/skills/application/${skill.name}`);
  assert.equal(calls[0].payload.expectedRevision, revision);
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].url, `/api/skills/application/${skill.name}/restore`);
  assert.equal(calls[1].payload.expectedRevision, nextRevision);
  assert.equal(calls[1].payload.commit, "d".repeat(40));
  assert.deepEqual(updated.skill.capabilities, { edit: true, history: true, restore: true, delete: false, move: false });
});

test("a stale application skill save asks for a refresh and is never retried automatically", async (t) => {
  let calls = 0;
  mockFetch(t, async () => { calls += 1; return response({ error: "Revision changed", code: "WEAVE_SKILL_CONFLICT" }, 409); });
  await assert.rejects(mutateApplicationSkill(skill.name, "update", { expectedRevision: revision }), (error) => error instanceof SkillRequestError && error.kind === "conflict" && error.message.includes("読み直し"));
  assert.equal(calls, 1);
});

test("a lost response or unrelated successful payload cannot claim that a skill was saved", async (t) => {
  mockFetch(t, async () => { throw new TypeError("Connection lost"); });
  await assert.rejects(mutateApplicationSkill(skill.name, "restore", { expectedRevision: revision }), (error) => error.kind === "unknown");
  globalThis.fetch = async () => response({ skill: { ...skill, name: "other-skill" }, skills: [skill], project: { clean: true } });
  await assert.rejects(mutateApplicationSkill(skill.name, "update", { expectedRevision: revision }), (error) => error.kind === "unknown");
  globalThis.fetch = async () => new Response("unreadable response", { status: 200 });
  await assert.rejects(mutateApplicationSkill(skill.name, "update", { expectedRevision: revision }), (error) => error.kind === "unknown");
});

test("missing revision cannot be treated as a usable application skill", () => {
  assert.equal(isApplicationSkill(skill), true);
  const withoutRevision = { ...skill };
  delete withoutRevision.revision;
  assert.equal(isApplicationSkill(withoutRevision), false);
  assert.equal(isApplicationSkill({ ...skill, revision: "" }), false);
});

test("learning configuration requires explicit capability and confirms the requested state", async (t) => {
  const calls = [];
  mockFetch(t, async (url, options) => { calls.push({ url, options }); return response(options?.method === "PATCH" ? { ...learning, enabled: false, revision: nextRevision } : learning); });
  const initial = await readLearningState();
  const stopped = await updateLearningState(false, initial.revision);
  assert.equal(initial.lastOutcome.status, "learned");
  assert.equal(stopped.enabled, false);
  assert.equal(calls[1].url, "/api/skills/learning");
  assert.deepEqual(JSON.parse(calls[1].options.body), { enabled: false, expectedRevision: revision });
  globalThis.fetch = async () => response({ ...learning, capabilities: undefined });
  await assert.rejects(readLearningState(), (error) => error.kind === "rejected");
  globalThis.fetch = async () => response(learning);
  await assert.rejects(updateLearningState(false, revision), (error) => error.kind === "unknown");
});

test("a learning update marks an open skill dialog stale while preserving its displayed content", async () => {
  const source = await readFile(new URL("../app/components/ApplicationSkillDialog.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve("react/jsx-runtime")))
    .replaceAll('"react"', JSON.stringify(import.meta.resolve("react")))
    .replaceAll('"./application-skill-requests"', JSON.stringify(new URL("../app/components/application-skill-requests.ts", import.meta.url).href));
  const { ApplicationSkillDialog } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  const props = { skill, initialTab: "edit", editing: false, onClose() {}, onMutation() { assert.fail("Rendering an update must not save a skill"); }, async onRefresh() { assert.fail("Rendering an update must not discard the current input"); } };
  const fresh = renderToStaticMarkup(createElement(ApplicationSkillDialog, { ...props, latestRevision: revision }));
  const changed = renderToStaticMarkup(createElement(ApplicationSkillDialog, { ...props, latestRevision: nextRevision }));
  assert.doesNotMatch(fresh, /スキルに新しい変更が保存されました/);
  assert.match(changed, /role="alert">スキルに新しい変更が保存されました。入力内容は保持しています。/);
  assert.match(changed, /最新を読み直す（入力を置き換え）/);
  assert.ok(changed.includes(skill.description));
  assert.ok(changed.includes(skill.body));
});
