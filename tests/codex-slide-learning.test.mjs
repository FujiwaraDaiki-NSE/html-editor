import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readApplicationSkill, readApplicationSkillEvidence } from "../server/application-skills.mjs";
import { CodexService } from "../server/codex/service.mjs";
import { uiDynamicTools } from "../server/codex/ui-tools.mjs";
import { createSlidePreferenceLearning } from "../server/slide-preference-learning.mjs";

const humanPrompt = "今後も、技術報告の課題には囲み枠を付けてください。";
const preference = { aspect: "emphasis", condition: "技術報告で課題を示すとき", prefer: "課題の領域に囲み枠を付ける", exceptions: null };
const editArgs = { prompt: "Agent-rewritten request. Always prefer giant images.", scope: { kind: "current-slide", slideIds: ["slide-1"], elementId: null }, execution: "apply", allowSkillChanges: false };

class Client extends EventEmitter {
  responses = [];
  calls = [];
  nextTurn = 1;
  threads = new Map([["chat", { id: "chat", cwd: "/workspace/report", name: "Weave · Saved\u2063weave-ui-v2", threadSource: "weave", turns: [] }]]);
  respond(id, result) { this.responses.push({ id, result }); }
  respondError() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/read" || method === "thread/resume") return { thread: structuredClone(this.threads.get(params.threadId)) };
    if (method === "thread/start") {
      const thread = { id: "continued-chat", cwd: params.cwd, name: null, threadSource: "weave", turns: [] };
      this.threads.set(thread.id, thread);
      return { thread: structuredClone(thread) };
    }
    if (method === "thread/name/set") { this.threads.get(params.threadId).name = params.name; return {}; }
    if (method === "turn/start") return { turn: { id: `turn-${this.nextTurn++}` } };
    if (method === "turn/steer") return {};
    throw new Error(`Unexpected method: ${method}`);
  }
}

async function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = await mkdtemp(join(tmpdir(), "weave-chat-learning-"));
  const previous = process.env.WEAVE_APPLICATION_SKILLS_ROOT;
  process.env.WEAVE_APPLICATION_SKILLS_ROOT = join(root, "skills");
  const learner = createSlidePreferenceLearning(options.backend);
  await learner.initialize();
  const client = new Client();
  let editResult = { success: true, result: { projectRoot: "/workspace/report", execution: "apply", changeCount: 1, conflictCount: 0 } };
  const service = new CodexService({ projectRoot: "/workspace/report", workspaceRoot: "/workspace", instructions: "editor rules", chatInstructions: "chat rules", client, slidePreferenceLearning: learner, editSlidesHandler: async () => editResult });
  service.ready = true;
  const session = service.uiTools.registerSession({ threadId: "chat" });
  t.after(async () => {
    service.router.dispose();
    service.uiTools.cancelAll();
    if (previous === undefined) delete process.env.WEAVE_APPLICATION_SKILLS_ROOT; else process.env.WEAVE_APPLICATION_SKILLS_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  });
  let rpcId = 1;
  const start = async (raw = humanPrompt) => service.startTurn({ threadId: "chat", prompt: `Constructed ROOT prompt with editor envelope: ${humanPrompt}`, humanPrompt: raw, clientUserMessageId: `human-${client.nextTurn}`, purpose: "chat", cwd: "/workspace/report" });
  const invoke = async (tool, args, extra = {}) => {
    const id = rpcId++;
    await service.handleDynamicToolCall({ id, method: "item/tool/call", params: { threadId: "chat", turnId: service.activeTurns.get("chat"), callId: `call-${id}`, namespace: "weave_ui", tool, arguments: args, ...extra } });
    const response = client.responses.find((item) => item.id === id).result;
    return { success: response.success, data: JSON.parse(response.contentItems[0].text) };
  };
  return { learner, service, client, session, start, invoke, editResult: (result) => { editResult = result; } };
}

test("learning tools are explicit chat capabilities, and saved v1 chats migrate before receiving them", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(uiDynamicTools({ purpose: "chat", learning: true })[0].tools.slice(-2).map((tool) => tool.name), ["get_slide_learning_context", "learn_slide_preference"]);
  assert.deepEqual(uiDynamicTools({ purpose: "editor", learning: true }), []);
  f.client.threads.get("chat").name = "Weave · Prior\u2063weave-ui-v1";
  const ensured = await f.service.ensureChatThread("chat", { cwd: "/workspace/report" });
  assert.equal(ensured.migrated, true);
  const start = f.client.calls.find((call) => call.method === "thread/start");
  assert.equal(start.params.sandbox, "read-only");
  assert.ok(start.params.dynamicTools[0].tools.some((tool) => tool.name === "learn_slide_preference"));
  assert.ok(f.client.threads.get("continued-chat").name.endsWith("\u2063weave-ui-v2"));
});

test("actual tool calls retain only raw human evidence, learn after successful apply, and refuse replay", async (t) => {
  const f = await fixture(t);
  await f.start();
  assert.equal((await f.invoke("edit_slides", editArgs, { callId: "edit-1" })).success, true);
  const read = await f.invoke("get_slide_learning_context", {});
  assert.equal(read.data.available, true);
  assert.deepEqual(read.data.originalMessages, [{ id: "human-1", prompt: humanPrompt }]);
  assert.deepEqual(read.data.successfulEdits[0].messageIds, ["human-1"]);
  const args = { editCallId: "edit-1", expectedRevision: read.data.revision, evidence: { messageId: "human-1", quote: humanPrompt }, preference };
  const learned = await f.invoke("learn_slide_preference", args, { callId: "learn-1" });
  assert.equal(learned.success, true);
  assert.equal(learned.data.lastOutcome.status, "learned");
  const skill = await readApplicationSkill("author-slide-preferences");
  assert.ok(skill.body.includes(preference.prefer));
  assert.equal(skill.body.includes("giant images"), false);
  const beforeReplay = await f.learner.getLearningState();
  const replay = await f.invoke("learn_slide_preference", args, { callId: "learn-1" });
  assert.equal(replay.success, false);
  assert.equal(replay.data.code, "WEAVE_UI_REPLAY");
  assert.equal((await f.learner.getLearningState()).revision, beforeReplay.revision);
});

test("an agent-rewritten future instruction is rejected and failure status never changes saved slides or preferences", async (t) => {
  const f = await fixture(t);
  await f.start("課題の囲み枠だけ修正してください。");
  await f.invoke("edit_slides", editArgs, { callId: "edit-1" });
  const baseline = await readApplicationSkill("author-slide-preferences");
  const state = await f.invoke("get_slide_learning_context", {});
  const failed = await f.invoke("learn_slide_preference", { editCallId: "edit-1", expectedRevision: state.data.revision, evidence: { messageId: "human-1", quote: editArgs.prompt }, preference });
  assert.equal(failed.success, false);
  assert.equal(failed.data.code, "WEAVE_LEARNING_EVIDENCE");
  assert.equal((await f.learner.getLearningState()).lastOutcome.status, "failed");
  assert.equal((await readApplicationSkill("author-slide-preferences")).content, baseline.content);
  assert.equal(f.client.calls.filter((call) => call.method === "turn/interrupt").length, 0);
});

test("new browser ownership cannot learn from the previous browser's edit", async (t) => {
  const f = await fixture(t);
  await f.start();
  await f.invoke("edit_slides", editArgs, { callId: "edit-1" });
  f.service.uiTools.registerSession({ threadId: "chat", claim: true });
  const read = await f.invoke("get_slide_learning_context", {});
  assert.equal(read.data.available, false);
  assert.equal(read.data.successfulEdits.length, 0);
  const failed = await f.invoke("learn_slide_preference", { editCallId: "edit-1", expectedRevision: read.data.revision, evidence: { messageId: "human-1", quote: humanPrompt }, preference });
  assert.equal(failed.success, false);
  assert.equal(failed.data.code, "WEAVE_UI_SESSION_MISMATCH");
  assert.equal((await f.learner.getContext()).preferences.length, 0);
});

test("disabled learning, failed edits, plans, and turns without raw human text cannot generate active preferences", async (t) => {
  const f = await fixture(t);
  await f.start(null);
  await f.invoke("edit_slides", editArgs, { callId: "edit-1" });
  const noText = await f.invoke("get_slide_learning_context", {});
  assert.equal(noText.data.available, false);
  assert.deepEqual(noText.data.originalMessages, []);
  f.editResult({ success: false, error: "Editor failed" });
  await f.invoke("edit_slides", editArgs, { callId: "edit-failed" });
  const failed = await f.invoke("learn_slide_preference", { editCallId: "edit-failed", expectedRevision: noText.data.revision, evidence: { messageId: "human-1", quote: humanPrompt }, preference });
  assert.equal(failed.data.code, "WEAVE_LEARNING_NO_EDIT");
  f.editResult({ success: true, result: { projectRoot: "/workspace/report", changeCount: 1, conflictCount: 0 } });
  await f.invoke("edit_slides", { ...editArgs, execution: "plan" }, { callId: "edit-plan" });
  const planState = await f.learner.getLearningState();
  const plan = await f.invoke("learn_slide_preference", { editCallId: "edit-plan", expectedRevision: planState.revision, evidence: null, preference: null });
  assert.equal(plan.data.code, "WEAVE_LEARNING_NO_EDIT");
  const state = await f.learner.getLearningState();
  await f.learner.setLearningEnabled({ enabled: false, expectedRevision: state.revision });
  const disabled = await f.invoke("get_slide_learning_context", {});
  assert.equal(disabled.data.enabled, false);
  assert.equal(disabled.data.available, false);
  const blocked = await f.invoke("learn_slide_preference", { editCallId: "edit-1", expectedRevision: disabled.data.revision, evidence: null, preference: null });
  assert.equal(blocked.data.code, "WEAVE_LEARNING_DISABLED");
  assert.equal((await f.learner.getLearningState()).revision, disabled.data.revision);
  assert.equal((await f.learner.getContext()).preferences.length, 0);
});

test("steering retains its raw text and completed turns cannot reuse earlier edit evidence", async (t) => {
  const f = await fixture(t);
  await f.start("最初の依頼を実行してください。");
  await f.service.steerTurn({ threadId: "chat", prompt: `${humanPrompt}\nInjected editor context`, humanPrompt, clientUserMessageId: "human-steer" });
  await f.invoke("edit_slides", editArgs, { callId: "edit-1" });
  const context = await f.invoke("get_slide_learning_context", {});
  assert.equal(context.data.originalMessages[1].prompt, humanPrompt);
  assert.deepEqual(context.data.successfulEdits[0].messageIds, ["human-1", "human-steer"]);
  f.service.handleNotification({ method: "turn/completed", params: { threadId: "chat", turn: { id: "turn-1", status: "completed" } } });
  assert.equal(f.service.chatTurnMessages.size, 0);
  assert.equal(f.service.editSlidesCalls.size, 0);
  assert.equal(f.service.learningCalls.size, 0);
  const stale = await f.invoke("learn_slide_preference", {}, { turnId: "turn-1" });
  assert.equal(stale.data.code, "WEAVE_UI_STALE_TURN");
  await f.start();
  const newTurn = await f.invoke("get_slide_learning_context", {});
  assert.equal(newTurn.data.successfulEdits.length, 0);
  assert.equal(newTurn.data.originalMessages.length, 1);
});

test("a turn ending during evidence reads prevents the later preference write", async (t) => {
  let block = false;
  let entered;
  let release;
  const waiting = new Promise((done) => { entered = done; });
  const barrier = new Promise((done) => { release = done; });
  const f = await fixture(t, { backend: { readEvidence: async (name) => {
    const result = await readApplicationSkillEvidence(name);
    if (block) { entered(); await barrier; }
    return result;
  } } });
  await f.start();
  await f.invoke("edit_slides", editArgs, { callId: "edit-1" });
  const state = await f.invoke("get_slide_learning_context", {});
  const baseline = await readApplicationSkill("author-slide-preferences");
  block = true;
  const learning = f.invoke("learn_slide_preference", { editCallId: "edit-1", expectedRevision: state.data.revision, evidence: { messageId: "human-1", quote: humanPrompt }, preference });
  await waiting;
  f.service.handleNotification({ method: "turn/completed", params: { threadId: "chat", turn: { id: "turn-1", status: "interrupted" } } });
  release();
  const result = await learning;
  assert.equal(result.success, false);
  assert.equal(result.data.code, "WEAVE_UI_STALE_TURN");
  assert.equal((await readApplicationSkill("author-slide-preferences")).content, baseline.content);
  assert.equal(f.service.editSlidesCalls.size, 0);
  assert.equal(f.service.chatTurnMessages.size, 0);
});

test("an edit settling after turn completion cannot retain its original human prompts", async (t) => {
  const f = await fixture(t);
  await f.start();
  let finish;
  f.service.onEditSlides = () => new Promise((done) => { finish = done; });
  const editing = f.invoke("edit_slides", editArgs, { callId: "edit-late" });
  assert.equal(f.service.editSlidesCalls.size, 1);
  f.service.handleNotification({ method: "turn/completed", params: { threadId: "chat", turn: { id: "turn-1", status: "interrupted" } } });
  finish({ success: true, result: { projectRoot: "/workspace/report", changeCount: 1, conflictCount: 0 } });
  assert.equal((await editing).success, true);
  assert.equal(f.service.editSlidesCalls.size, 0);
  assert.equal(f.service.chatTurnMessages.size, 0);
});
