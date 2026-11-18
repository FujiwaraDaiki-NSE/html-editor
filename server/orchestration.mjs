import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const text = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`); return value; };

/** Owns durable message receipts and delegated work independently of model turns. */
export class Orchestration {
  constructor({ path, events, startChat, steerChat, interruptChat, chatActive, execute, interruptWorker, wakePrompt, onTaskSettled }) {
    Object.assign(this, { path, events, startChat, steerChat, interruptChat, chatActive, execute, interruptWorker, wakePrompt, onTaskSettled });
    this.messages = []; this.tasks = []; this.conversations = new Map(); this.payloads = new Map();
    this.pumping = new Set(); this.runningTasks = new Map(); this.gates = new Map(); this.saves = Promise.resolve(); this.stopping = false;
  }
  async load() {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      this.messages = data.messages; this.tasks = data.tasks; this.conversations = new Map(data.conversations);
      for (const item of this.messages) if (item.status === 'queued') { item.status = 'failed'; item.error = 'Editor restarted before delivery. This message was not resent.'; }
      for (const task of this.tasks) if (!TERMINAL.has(task.status)) { task.status = 'failed'; task.error = 'Editor restarted before completion. Review the recovered editor draft; this task was not restarted.'; }
      await this.save();
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  snapshot(root) { return { tasks: this.tasks.filter(t => t.root === root), messages: this.messages.filter(m => m.root === root) }; }
  async save() {
    const data = JSON.stringify({ tasks: this.tasks, messages: this.messages, conversations: [...this.conversations] });
    const write = this.saves.then(async () => { await mkdir(dirname(this.path), { recursive: true }); const temp = `${this.path}.${randomUUID()}.tmp`; await writeFile(temp, data, { mode: 0o600 }); await rename(temp, this.path); });
    this.saves = write.catch(() => {}); await write;
    this.events.publish('weave/orchestration', { tasks: this.tasks, messages: this.messages });
  }
  context(threadId) { const c = this.conversations.get(threadId); if (!c) throw new Error('Conversation context is unavailable. Send a message first.'); return c; }
  async receive(payload, { automatic = false } = {}) {
    if (this.stopping) throw new Error('Orchestrator is stopping.');
    text(payload.clientUserMessageId, 'Message ID'); text(payload.threadId, 'Thread ID'); text(payload.prompt, 'Prompt');
    const duplicate = this.messages.find(m => m.threadId === payload.threadId && m.id === payload.clientUserMessageId);
    if (duplicate) return { message: duplicate };
    let context = this.conversations.get(payload.threadId);
    if (!automatic) {
      const version = context ? context.version + 1 : 1;
      context = { threadId: payload.threadId, root: payload.root, model: payload.model, effort: payload.effort, workerModel: payload.workerModel, workerEffort: payload.workerEffort, approvalPolicy: payload.approvalPolicy, contextEnvelope: payload.contextEnvelope, version };
      this.conversations.set(payload.threadId, context);
      for (const task of this.tasks.filter(t => t.threadId === payload.threadId && !TERMINAL.has(t.status) && t.applied !== true)) {
        task.version = version; task.latestInstruction = payload.prompt; task.instructionStatus = 'pending';
      }
    } else context = this.context(payload.threadId);
    const message = { id: payload.clientUserMessageId, threadId: payload.threadId, root: payload.root, text: payload.prompt, automatic, version: context.version, status: 'queued', createdAt: Date.now(), error: null };
    this.messages.push(message); this.payloads.set(`${message.threadId}:${message.id}`, payload); await this.save();
    if (!automatic && this.chatActive(payload.threadId)) {
      if (payload.threadId.startsWith('claude:')) await this.interruptChat(payload.threadId);
      else {
        try { await this.steerChat(payload); message.status = 'delivered'; this.payloads.delete(`${message.threadId}:${message.id}`); await this.save(); return { message }; }
        catch (error) { if (!/no running turn/i.test(error.message)) { message.status = 'unknown'; message.error = 'Delivery could not be confirmed. Inspect the conversation before resending. ' + error.message; this.payloads.delete(`${message.threadId}:${message.id}`); await this.save(); return { message }; } }
      }
    }
    void this.pump(payload.threadId);
    return { message };
  }
  async pump(threadId) {
    if (this.stopping || this.pumping.has(threadId) || this.chatActive(threadId)) return;
    const message = this.messages.find(m => m.threadId === threadId && m.status === 'queued');
    if (!message) return;
    this.pumping.add(threadId);
    try {
      const payload = this.payloads.get(`${message.threadId}:${message.id}`); if (!payload) throw new Error('Queued message payload is unavailable.');
      const result = await this.startChat(payload, message.automatic);
      message.status = 'delivered'; message.turnId = result.turn.id; this.payloads.delete(`${message.threadId}:${message.id}`); await this.save();
    } catch (error) { message.status = 'failed'; message.error = error.message; if (message.automatic) { for (const task of this.tasks.filter(t => t.threadId === threadId && t.status === 'reviewing')) task.error = `レビュー依頼を渡せませんでした: ${error.message}`; } await this.save(); }
    finally { this.pumping.delete(threadId); if (!this.chatActive(threadId)) void this.pump(threadId); }
  }
  async wake(threadId, prompt) {
    const c = this.context(threadId); if (c.paused || this.stopping) return;
    await this.receive({ ...c, prompt: "【作業通知】担当の状況を確認し、必要なレビューと報告を行ってください。", automaticInstructions: prompt, clientUserMessageId: randomUUID() }, { automatic: true });
  }
  assertWorker(threadId) {
    const c = this.context(threadId);
    if (c.paused) throw new Error('This conversation was stopped. Wait for a new human instruction.');
    text(c.workerModel, 'Codex implementation model'); text(c.workerEffort, 'Codex implementation effort');
    if (!["never", "on-request", "untrusted"].includes(c.approvalPolicy)) throw new Error("The implementation approval policy is required.");
    if (c.workerModel.startsWith('claude:')) throw new Error('The implementation agent must use Codex.');
  }
  async create(threadId, args) {
    const c = this.context(threadId);
    this.assertWorker(threadId);
    const task = { id: randomUUID(), threadId, root: c.root, model: c.workerModel, effort: c.workerEffort, approvalPolicy: c.approvalPolicy, prompt: args.prompt, variation: args.variation === true, scope: args.scope, allowSkillChanges: args.allowSkillChanges, contextEnvelope: structuredClone(c.contextEnvelope), version: c.version, latestInstruction: this.messages.filter(message => message.threadId === threadId && !message.automatic).at(-1).text, instructionStatus: 'current', proposal: args.proposal === undefined ? null : args.proposal, status: args.deferStart === true ? 'preparing' : 'queued', createdAt: Date.now(), workerThreadId: null, workerTurnId: null, attempt: 0, activity: '開始待ち', report: null, review: null, error: null };
    this.tasks.push(task); await this.save(); if (args.deferStart !== true) void this.run();
    return { taskId: task.id, status: task.status, message: 'Task accepted. Work runs independently. Respond to the user now; you will be notified when review is needed.' };
  }
  async activate(taskIds) {
    for (const id of taskIds) { const task = this.tasks.find(task => task.id === id); if (!task) throw new Error('Unknown task.'); if (task.status === 'preparing') task.status = 'queued'; else if (task.status !== 'cancelled') throw new Error('Task is no longer preparing.'); }
    await this.save(); void this.run();
  }
  task(threadId, id) { const task = this.tasks.find(t => t.id === id && t.threadId === threadId); if (!task) throw new Error('Task does not belong to this conversation.'); return task; }
  async control(threadId, { taskId, action, instruction, version }) {
    const task = this.task(threadId, taskId);
    if (task.version !== version || TERMINAL.has(task.status) || task.applied === true) throw new Error('Task version or state changed. Read its current state.');
    text(instruction, 'Instruction');
    if (!['continue', 'revise', 'cancel'].includes(action)) throw new Error('Unknown task action.');
    task.instructionStatus = 'current'; task.review = instruction;
    if (action === 'continue') { if (task.status === 'awaiting_approval') task.prompt = instruction; await this.save(); void this.run(); return task; }
    if (action === 'revise') task.prompt = instruction;
    if (['preparing', 'queued', 'awaiting_approval'].includes(task.status)) {
      if (action === 'cancel') task.status = 'cancelled';
      await this.save(); void this.run(); return task;
    }
    task.restart = action === 'revise'; task.status = 'cancelling'; await this.save();
    const gate = this.gates.get(task.id); if (gate) gate(false); else if (task.workerThreadId) await this.interruptWorker(task.workerThreadId);
    return task;
  }
  async review(threadId, { taskId, version, decision, reason }) {
    const task = this.task(threadId, taskId);
    if (this.context(threadId).paused) throw new Error('This conversation was stopped.');
    if (task.status !== 'reviewing' || task.version !== version) throw new Error('Review is stale. Read the task and latest instructions again.');
    text(reason, 'Review reason'); if (!['approve', 'revise', 'reject'].includes(decision)) throw new Error('Unknown review decision.');
    task.review = reason; task.error = null; task.instructionStatus = 'current'; task.restart = decision === 'revise';
    if (task.restart) task.prompt = reason;
    task.status = decision === 'approve' ? 'applying' : 'cancelling'; task.approvedVersion = decision === 'approve' ? version : null; task.activity = decision === 'approve' ? 'レビュー合格・反映処理中' : '修正・中止のため復旧中'; await this.save();
    const gate = this.gates.get(task.id); if (!gate) throw new Error('Review gate is no longer active.'); gate(decision === 'approve');
    return { taskId, status: task.status };
  }
  assertApply(id) {
    const task = this.tasks.find(t => t.id === id);
    if (!task || task.status !== 'applying' || task.approvedVersion !== task.version || task.instructionStatus !== 'current') throw new Error('Instructions changed after review. This edit cannot be applied.');
  }
  async progress(threadId, item) {
    const task = this.tasks.find(t => t.workerThreadId === threadId && t.status === 'running'); if (!task) return;
    const labels = { commandExecution: 'コマンドを実行中', fileChange: 'ファイルを編集中', reasoning: '実装方法を検討中', agentMessage: '作業結果を整理中', mcpToolCall: '資料を確認中' };
    if (!Object.hasOwn(labels, item.type)) return;
    task.activity = labels[item.type]; task.activityAt = Date.now(); await this.save();
  }
  async workerStarted(id, threadId, turnId) {
    const task = this.tasks.find(t => t.id === id); task.workerThreadId = threadId; task.workerTurnId = turnId; task.workerStartedAt = Date.now(); if (task.status === 'running') task.activity = 'Codexが編集しています'; await this.save();
  }
  async workerReady(id, report) {
    const task = this.tasks.find(t => t.id === id);
    if (task.status === 'cancelling') return false;
    const promise = new Promise(resolve => this.gates.set(id, resolve));
    task.report = report; task.status = 'reviewing'; task.activity = 'オーケストレータのレビュー待ち'; await this.save();
    void this.wake(task.threadId, `Codex task ${id} requires review. Read it using tasks, inspect the changes and latest human instructions, then call review_edit. Do not claim completion before the task is completed.`).catch(error => { task.error = error.message; void this.save(); });
    try { return await promise; } finally { this.gates.delete(id); }
  }
  get running() { return this.runningTasks.keys().next().value ?? null; }
  canRun(task) {
    const active = [...this.runningTasks.values()];
    if (!task.proposal) return active.length === 0;
    if (active.length >= 3 || active.some(other => !other.proposal)) return false;
    return !active.some(other => other.proposal.groupId === task.proposal.groupId && other.proposal.candidateId === task.proposal.candidateId);
  }
  async run() {
    if (this.stopping) return;
    for (const task of this.tasks.filter(t => t.status === 'queued' && t.instructionStatus === 'current')) {
      if (!this.canRun(task)) continue;
      this.runningTasks.set(task.id, task); task.status = 'running'; task.attempt++; task.finishedAt = null; task.workerStartedAt = null; task.workerThreadId = null; task.workerTurnId = null; task.startedAt = Date.now(); task.activity = 'Codexを起動中'; task.activityAt = task.startedAt;
      void this.runTask(task);
    }
  }
  async runTask(task) {
    try {
      await this.save();
      const outcome = await this.execute(task);
      task.outcome = outcome;
      if (task.restart) { task.restart = false; task.report = null; task.applied = false; task.status = 'queued'; task.activity = '修正指示で再実行待ち'; }
      else if (task.status === 'cancelling') task.status = 'cancelled';
      else { task.status = outcome.success ? 'completed' : 'failed'; task.error = outcome.success ? null : outcome.error; }
    } catch (error) { task.status = 'failed'; task.error = error.message; }
    finally {
      task.finishedAt = Date.now();
      if (task.status === 'completed') task.activity = task.proposal ? 'レビュー済み・比較できます（未採用）' : 'オーケストレータのレビュー後、反映を確認済み';
      if (task.status === 'failed') task.activity = '結果を反映できませんでした';
      if (task.status === 'cancelled') task.activity = '変更を採用せず終了';
      if (TERMINAL.has(task.status) && this.onTaskSettled) {
        try { await this.onTaskSettled(task); } catch (error) { task.status = 'failed'; task.error = `Could not publish the verified result: ${error.message}`; task.activity = '結果を保存できませんでした'; }
      }
      await this.save();
      this.runningTasks.delete(task.id);
      if (TERMINAL.has(task.status)) void this.wake(task.threadId, `Codex task ${task.id} is ${task.status}. Read its status using tasks and report the actual outcome to the user.`).catch(() => {});
      void this.run();
    }
  }
  learningContext(threadId) {
    const originalMessages = this.messages.filter(message => message.threadId === threadId && !message.automatic && message.status === 'delivered').map(message => ({ id: message.id, prompt: message.text }));
    const successfulEdits = this.tasks.filter(task => task.threadId === threadId && task.status === 'completed' && task.applied === true && task.approvedVersion === task.version && task.instructionStatus === 'current' && task.outcome?.success === true && task.outcome.result?.changeCount > 0 && task.outcome.result.conflictCount === 0).map(task => ({ callId: task.id, execution: 'apply', scope: task.scope, projectRoot: task.root, changeCount: task.outcome.result.changeCount, conflictCount: 0, messageIds: this.messages.filter(message => message.threadId === threadId && !message.automatic && message.version <= task.version).map(message => message.id) }));
    return { originalMessages, successfulEdits };
  }
  async cancelConversation(threadId) {
    const context = this.conversations.get(threadId); if (context) context.paused = true;
    for (const task of this.tasks.filter(t => t.threadId === threadId && !TERMINAL.has(t.status) && t.applied !== true)) await this.control(threadId, { taskId: task.id, action: 'cancel', instruction: 'User stopped this conversation.', version: task.version });
    for (const message of this.messages.filter(m => m.threadId === threadId && m.status === 'queued')) message.status = 'cancelled';
    await this.save(); if (this.chatActive(threadId)) await this.interruptChat(threadId);
  }
  async stop() { this.stopping = true; for (const threadId of this.conversations.keys()) await this.cancelConversation(threadId); await this.saves; }
}
