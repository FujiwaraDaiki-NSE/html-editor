import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestration } from '../server/orchestration.mjs';
const scope = { kind: 'current-slide', slideIds: ['one'], elementId: null };
const args = { prompt: 'Update the title only.', scope, execution: 'apply', allowSkillChanges: false };
const input = (id, mode = 'apply') => ({ threadId: 'parent', root: '/project', model: 'claude:claude-opus-5-5', effort: 'low', workerModel: 'gpt-test', workerEffort: 'medium', approvalPolicy: 'never', prompt: `Instruction ${id}`, clientUserMessageId: id, contextEnvelope: { modificationScope: scope, executionMode: mode } });
const until = async predicate => { for (let n = 0; n < 500; n++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('Timed out waiting for task transition'); };
async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'weave-orchestration-'));
  const active = new Set(); const chats = []; const applied = []; const steered = []; const interrupted = []; const events = [];
  let manager;
  const params = { path: join(root, 'state.json'), events: { publish: (type, value) => events.push({ type, value: structuredClone(value) }) }, chatActive: id => active.has(id),
    startChat: async payload => { chats.push(payload); active.add(payload.threadId); return { turn: { id: `turn-${chats.length}` } }; },
    steerChat: async payload => { steered.push(payload); }, interruptChat: async id => { interrupted.push(id); active.delete(id); },
    interruptWorker: async () => {},
    execute: async task => {
      await manager.workerStarted(task.id, `worker-${task.id}`, `turn-${task.id}`);
      const yes = await manager.workerReady(task.id, { workerOutput: 'Changed title only.', sources: [{ slideId: 'one', before: 'Before', after: 'After' }] });
      if (options.beforeApply) await options.beforeApply();
      if (yes) { manager.assertApply(task.id); applied.push(task.id); }
      return yes ? { success: true } : { success: false, error: 'Rejected' };
    },
  };
  manager = new Orchestration(params); await manager.load();
  t.after(async () => { await manager.stop(); await until(() => manager.running === null); await rm(root, { recursive: true, force: true }); });
  return { manager, active, chats, applied, steered, interrupted, events, root, params };
}

test('delegation returns before the worker finishes, and no result applies before current review', async t => {
  const { manager, active, chats, applied } = await setup(t);
  await manager.receive(input('one')); await until(() => chats.length === 1);
  const receipt = await manager.create('parent', args); const task = manager.task('parent', receipt.taskId);
  await until(() => task.status === 'reviewing');
  assert.equal(active.has('parent'), true, 'worker does not occupy the parent turn');
  assert.deepEqual(applied, []);
  const duplicate = await manager.receive(input('one'));
  assert.equal(duplicate.message.id, 'one'); assert.equal(manager.messages.filter(m => !m.automatic).length, 1);
  await manager.receive(input('two'));
  assert.equal(task.version, 2); assert.equal(task.instructionStatus, 'pending');
  await assert.rejects(manager.review('parent', { taskId: task.id, version: 1, decision: 'approve', reason: 'Old review' }), /stale/);
  await manager.review('parent', { taskId: task.id, version: 2, decision: 'approve', reason: 'The title source matches both human instructions and the scope.' });
  await until(() => task.status === 'completed'); assert.deepEqual(applied, [task.id]);
});

test('additional Codex messages are steered without blocking delegated work', async t => {
  const { manager, chats, steered } = await setup(t);
  await manager.receive({ ...input('one'), threadId: 'codex-parent', model: 'gpt-test' }); await until(() => chats.length === 1);
  const result = await manager.receive({ ...input('two'), threadId: 'codex-parent', model: 'gpt-test' });
  assert.equal(result.message.status, 'delivered'); assert.equal(steered.length, 1); assert.equal(chats.length, 1);
});

test('confirm mode never starts a worker before human approval; changed proposals need another decision', async t => {
  const { manager } = await setup(t); await manager.receive(input('one', 'confirm'));
  const { taskId } = await manager.create('parent', args); const task = manager.task('parent', taskId);
  assert.equal(task.status, 'awaiting_approval'); assert.equal(manager.running, null);
  await manager.receive(input('two', 'confirm'));
  await assert.rejects(manager.approve('parent', taskId, 1), /changed/);
  await assert.rejects(manager.approve('parent', taskId, 2), /changed/);
  await manager.control('parent', { taskId, version: 2, action: 'continue', instruction: 'Edit the title according to both instructions.' });
  await manager.approve('parent', taskId, 2); await until(() => task.status === 'reviewing');
  assert.equal(task.attempt, 1);
  await manager.review('parent', { taskId, version: 2, decision: 'reject', reason: 'Keep the current title.' });
  await until(() => task.status === 'cancelled');
});

test('a message arriving after review invalidates application at the commit boundary', async t => {
  let release; const hold = new Promise(r => { release = r; });
  const { manager, applied } = await setup(t, { beforeApply: () => hold });
  await manager.receive(input('one')); const { taskId } = await manager.create('parent', args); const task = manager.task('parent', taskId);
  await until(() => task.status === 'reviewing');
  await manager.review('parent', { taskId, version: 1, decision: 'approve', reason: 'Checked the exact source change.' });
  await manager.receive(input('two')); release(); await until(() => task.status === 'failed');
  assert.match(task.error, /Instructions changed/); assert.deepEqual(applied, []);
});

test('workspace writes are queued, cancellation settles one task, and the next task still runs', async t => {
  const { manager, applied } = await setup(t); await manager.receive(input('one'));
  const first = await manager.create('parent', args); const second = await manager.create('parent', { ...args, prompt: 'Change another title.' });
  const a = manager.task('parent', first.taskId); const b = manager.task('parent', second.taskId);
  await until(() => a.status === 'reviewing'); assert.equal(b.status, 'queued');
  await manager.control('parent', { taskId: a.id, version: 1, action: 'cancel', instruction: 'Do not edit this slide.' });
  await until(() => b.status === 'reviewing'); assert.equal(a.status, 'cancelled');
  await manager.review('parent', { taskId: b.id, version: 1, decision: 'approve', reason: 'The independent request is satisfied.' });
  await until(() => b.status === 'completed'); assert.deepEqual(applied, [b.id]);
});

test('restart preserves task history but never retries unfinished edits or undelivered messages', async t => {
  const { manager, root, params } = await setup(t); await manager.receive(input('one'));
  const { taskId } = await manager.create('parent', args); await until(() => manager.task('parent', taskId).status === 'reviewing');
  const copy = join(root, 'restart.json'); await copyFile(params.path, copy);
  const restarted = new Orchestration({ ...params, path: copy, startChat: () => assert.fail('Must not resend on restart'), execute: () => assert.fail('Must not restart edits') });
  await restarted.load(); assert.equal(restarted.task('parent', taskId).status, 'failed'); assert.match(restarted.task('parent', taskId).error, /restarted/);
  await restarted.stop();
});

test('explicit stop cancels all work and never wakes the orchestrator with a late result', async t => {
  const { manager, chats } = await setup(t); await manager.receive(input('one')); await until(() => chats.length === 1);
  const { taskId } = await manager.create('parent', args); await until(() => manager.task('parent', taskId).status === 'reviewing');
  await manager.cancelConversation('parent'); await until(() => manager.task('parent', taskId).status === 'cancelled');
  const count = chats.length; await manager.wake('parent', 'Late result'); assert.equal(chats.length, count);
  await assert.rejects(manager.create('parent', args), /stopped/);
});

test('Claude receives additional instructions by restarting only its response, while its Codex task stays alive', async t => {
  const { manager, chats, interrupted, applied } = await setup(t);
  await manager.receive({ ...input('one'), threadId: 'claude:parent' }); await until(() => chats.length === 1);
  const { taskId } = await manager.create('claude:parent', args); const task = manager.task('claude:parent', taskId);
  await until(() => task.status === 'reviewing');
  await manager.receive({ ...input('two'), threadId: 'claude:parent' }); await until(() => chats.length === 2);
  assert.deepEqual(interrupted, ['claude:parent']); assert.equal(task.status, 'reviewing'); assert.equal(task.version, 2); assert.deepEqual(applied, []);
  await assert.rejects(manager.control('unrelated', { taskId, version: 2, action: 'cancel', instruction: 'wrong owner' }), /does not belong/);
});

test('an uncertain steering response is not automatically retried as another message', async t => {
  const { manager, chats } = await setup(t);
  await manager.receive({ ...input('one'), threadId: 'codex-parent' }); await until(() => chats.length === 1);
  manager.steerChat = async () => { throw new Error('Transport disconnected after write'); };
  const result = await manager.receive({ ...input('two'), threadId: 'codex-parent' });
  assert.equal(result.message.status, 'unknown');
  await manager.pump('codex-parent'); assert.equal(chats.length, 1);
});

test('queued workers wait for a decision on newer instructions before starting', async t => {
  const { manager } = await setup(t); await manager.receive(input('one'));
  const first = await manager.create('parent', args); const second = await manager.create('parent', args);
  const a = manager.task('parent', first.taskId); const b = manager.task('parent', second.taskId);
  await until(() => a.status === 'reviewing');
  await manager.receive(input('two'));
  await manager.control('parent', { taskId: a.id, version: 2, action: 'cancel', instruction: 'Cancel the first edit.' });
  await until(() => manager.running === null);
  assert.equal(b.status, 'queued'); assert.equal(b.attempt, 0);
  await manager.control('parent', { taskId: b.id, version: 2, action: 'revise', instruction: 'Use the updated heading.' });
  await until(() => b.status === 'reviewing');
  assert.equal(b.prompt, 'Use the updated heading.'); assert.equal(b.attempt, 1);
  await manager.review('parent', { taskId: b.id, version: 2, decision: 'reject', reason: 'End this test without application.' });
  await until(() => b.status === 'cancelled');
});

test('learning evidence includes only reviewed applied work and actual human messages', async t => {
  const { manager } = await setup(t);
  await manager.receive(input('one')); await until(() => manager.messages[0].status === 'delivered');
  await manager.wake('parent', 'Internal review instruction');
  const completed = { id: 'reviewed', threadId: 'parent', root: '/project', status: 'completed', applied: true, approvedVersion: 1, version: 1, instructionStatus: 'current', scope, outcome: { success: true, result: { changeCount: 1, conflictCount: 0 } } };
  manager.tasks.push(completed, { ...completed, id: 'unapplied', applied: false }, { ...completed, id: 'stale', approvedVersion: 0 }, { ...completed, id: 'conflicting', outcome: { success: true, result: { changeCount: 1, conflictCount: 1 } } });
  const context = manager.learningContext('parent');
  assert.deepEqual(context.originalMessages, [{ id: 'one', prompt: 'Instruction one' }]);
  assert.deepEqual(context.successfulEdits.map(edit => edit.callId), ['reviewed']);
  assert.deepEqual(context.successfulEdits[0].messageIds, ['one']);
});
