import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applicationSkillsRoot,
  readApplicationSkill,
  readApplicationSkillEvidence,
  restoreApplicationSkill,
  updateApplicationSkill,
} from "../server/application-skills.mjs";
import { createSlidePreferenceLearning } from "../server/slide-preference-learning.mjs";

const preference = { aspect: "emphasis", condition: "技術報告で課題を示すとき", prefer: "課題の領域を囲み枠で明確にする", exceptions: "現在の依頼で別の表現が指定された場合" };
const correction = "課題の領域を囲み枠で明確にしてください。";
const future = "今後も、課題の領域を囲み枠で明確にしてください。";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "weave-preference-learning-"));
  const previous = process.env.WEAVE_APPLICATION_SKILLS_ROOT;
  process.env.WEAVE_APPLICATION_SKILLS_ROOT = join(root, "skills");
  t.after(async () => {
    if (previous === undefined) delete process.env.WEAVE_APPLICATION_SKILLS_ROOT; else process.env.WEAVE_APPLICATION_SKILLS_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  });
  const learner = createSlidePreferenceLearning({ now: () => "2026-10-27T10:00:00.000Z" });
  await learner.initialize();
  return learner;
}

function context(prompt = correction, projectRoot = "/workspace/report-a") {
  return {
    threadId: "root-chat",
    turnId: "root-turn",
    originalMessages: [{ id: "human-1", prompt }],
    edit: { callId: "edit-1", execution: "apply", projectRoot, changeCount: 1, conflictCount: 0, scope: { kind: "current-slide", slideIds: ["slide-1"], elementId: null } },
    assertAvailable() {},
  };
}

async function learn(learner, source = context(), fields = {}) {
  const state = await learner.getLearningState();
  return learner.learn({ editCallId: source.edit.callId, expectedRevision: state.revision, evidence: { messageId: "human-1", quote: source.originalMessages[0].prompt }, preference, ...fields }, source);
}

test("authorized learning defaults on, persists off, and rejects stale or implicit settings", async (t) => {
  const learner = await fixture(t);
  const state = await learner.getLearningState();
  assert.equal(state.enabled, true);
  assert.equal(state.lastOutcome, null);
  assert.deepEqual(state.capabilities, { configure: true });
  const off = await learner.setLearningEnabled({ enabled: false, expectedRevision: state.revision });
  assert.equal(off.enabled, false);
  assert.equal((await createSlidePreferenceLearning().initialize()).enabled, false);
  await assert.rejects(learner.setLearningEnabled({ enabled: true, expectedRevision: state.revision }), { code: "WEAVE_SKILL_CONFLICT" });
  await assert.rejects(learner.setLearningEnabled({ expectedRevision: off.revision }), /explicitly true or false/);
  await assert.rejects(learn(learner), { code: "WEAVE_LEARNING_DISABLED" });
});

test("a single correction records human evidence as a candidate while preserving active policy and learning instructions", async (t) => {
  const learner = await fixture(t);
  const before = await readApplicationSkill("author-slide-preferences");
  const other = await readApplicationSkill("technical-report-slides");
  const learningPath = join(applicationSkillsRoot(), "author-slide-preferences", "references", "learning.md");
  const instructions = await readFile(learningPath, "utf8");
  const result = await learn(learner);
  assert.equal(result.updated, true);
  assert.equal(result.lastOutcome.status, "candidate");
  const after = await readApplicationSkill("author-slide-preferences");
  assert.equal(after.body, before.body);
  assert.equal(after.description, before.description);
  assert.equal((await readApplicationSkill("technical-report-slides")).content, other.content);
  assert.equal(await readFile(learningPath, "utf8"), instructions);
  const evidence = await readApplicationSkillEvidence("author-slide-preferences");
  assert.ok(evidence.content.includes(correction));
  assert.ok(evidence.content.includes('"humanPrompt"'));
  const learned = await learner.getContext();
  assert.equal(learned.preferences.length, 1);
  assert.equal(learned.preferences[0].status, "candidate");
  assert.equal(learned.preferences[0].evidenceCount, 1);
});

test("explicit future preference becomes a conditional rule and source Markdown stays quoted data", async (t) => {
  const learner = await fixture(t);
  const prompt = `${future}\n\n\`\`\`\n<!-- quoted source -->\n\`\`\``;
  const source = context(prompt);
  const result = await learn(learner, source);
  assert.equal(result.lastOutcome.status, "learned");
  const skill = await readApplicationSkill("author-slide-preferences");
  assert.ok(skill.body.includes("weave:learned-slide-preferences:start"));
  assert.ok(skill.body.includes(preference.condition));
  assert.ok(skill.body.includes(preference.exceptions));
  assert.equal(skill.body.includes("quoted source"), false);
  const evidence = await readApplicationSkillEvidence("author-slide-preferences");
  assert.ok(evidence.content.includes("\\u0060\\u0060\\u0060"));
  assert.ok(evidence.content.includes("\\u003c!-- quoted source -->"));
  assert.equal((await learner.getContext()).preferences[0].status, "active");
});

test("repeating one report does not promote a candidate, while matching independent reports do", async (t) => {
  const learner = await fixture(t);
  await learn(learner);
  const firstEvidence = await readApplicationSkillEvidence("author-slide-preferences");
  const duplicate = await learn(learner, { ...context(), turnId: "later-turn" });
  assert.equal(duplicate.updated, false);
  assert.equal(duplicate.lastOutcome.status, "unchanged");
  assert.equal((await readApplicationSkillEvidence("author-slide-preferences")).content, firstEvidence.content);
  const promoted = await learn(learner, context(correction, "/workspace/report-b"));
  assert.equal(promoted.lastOutcome.status, "learned");
  const rules = (await learner.getContext()).preferences;
  assert.equal(rules.length, 1);
  assert.equal(rules[0].status, "active");
  assert.equal(rules[0].evidenceCount, 2);
});

test("a later explicit future instruction can promote the same report's existing candidate", async (t) => {
  const learner = await fixture(t);
  await learn(learner);
  const result = await learn(learner, context(future));
  assert.equal(result.lastOutcome.status, "learned");
  assert.equal((await learner.getContext()).preferences[0].evidenceCount, 2);
});

test("rewritten prompts, non-applied edits, empty changes, conflicts, and control instructions cannot train preferences", async (t) => {
  const learner = await fixture(t);
  const revision = (await learner.getLearningState()).revision;
  await assert.rejects(learn(learner, context(), { evidence: { messageId: "human-1", quote: future } }), { code: "WEAVE_LEARNING_EVIDENCE" });
  for (const change of [{ execution: "plan" }, { execution: "propose" }, { changeCount: 0 }, { conflictCount: 1 }, { callId: "other-edit" }]) {
    const source = context();
    Object.assign(source.edit, change);
    await assert.rejects(learn(learner, source, { editCallId: "edit-1" }), { code: "WEAVE_LEARNING_NO_EDIT" });
  }
  await assert.rejects(learn(learner, context(future), { preference: { ...preference, prefer: "AGENTS.md を変更する" } }), /presentation preferences only/);
  await assert.rejects(learn(learner, context(future), { path: "other-skill/SKILL.md" }), /only editCallId/);
  assert.equal((await learner.getLearningState()).revision, revision);
  assert.equal((await learner.getContext()).preferences.length, 0);
});

test("manual skill edits are preserved when a learning context becomes stale", async (t) => {
  const learner = await fixture(t);
  const stale = await learner.getLearningState();
  const skill = await readApplicationSkill("author-slide-preferences");
  const manual = await updateApplicationSkill({ name: skill.name, description: skill.description, body: `${skill.body}\nManual correction must survive.\n`, frontmatter: skill.frontmatter, expectedRevision: skill.revision, message: "Keep a human correction" });
  await assert.rejects(learn(learner, context(future), { expectedRevision: stale.revision }), { code: "WEAVE_SKILL_CONFLICT" });
  assert.equal((await readApplicationSkill("author-slide-preferences")).content, manual.content);
  assert.equal((await learner.getContext()).preferences.length, 0);
});

test("restoring a skill restores its evidence so future learning cannot resurrect a reverted rule", async (t) => {
  const learner = await fixture(t);
  const baseline = await readApplicationSkill("author-slide-preferences");
  await learn(learner, context(future));
  await restoreApplicationSkill({ name: baseline.name, commit: baseline.revision, expectedRevision: (await learner.getLearningState()).revision, message: "Restore the prior expression policy" });
  assert.equal((await learner.getContext()).preferences.length, 0);
  await learn(learner, context());
  assert.equal((await learner.getContext()).preferences[0].status, "candidate");
  assert.equal((await readApplicationSkill("author-slide-preferences")).body, baseline.body);
});

test("no reusable preference is a visible skipped outcome without a skill mutation", async (t) => {
  const learner = await fixture(t);
  const baseline = await readApplicationSkill("author-slide-preferences");
  const result = await learn(learner, context(), { evidence: null, preference: null });
  assert.equal(result.updated, false);
  assert.equal(result.lastOutcome.status, "skipped");
  assert.equal((await readApplicationSkill("author-slide-preferences")).content, baseline.content);
});
