import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestration } from '../server/orchestration.mjs';
import { chatTurnPrompt } from '../server/chat-workflow.mjs';
import { editorEnvelope } from '../shared/context.mjs';
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
      if (options.beforeReady) await options.beforeReady(task);
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

test('compare mode starts immediately without human editing permission, but still requires review', async t => {
  const { manager, applied } = await setup(t); await manager.receive(input('one', 'compare'));
  const { taskId } = await manager.create('parent', { ...args, proposal: { groupId: 'group', candidateId: 'a' } }); const task = manager.task('parent', taskId);
  await until(() => task.status === 'reviewing'); assert.equal(task.attempt, 1); assert.deepEqual(applied, []);
  await manager.review('parent', { taskId, version: 1, decision: 'reject', reason: 'Candidate needs a clearer hierarchy.' });
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
  const count = chats.length; await manager.wake('parent', 'Late result', '【作業通知】完了通知'); assert.equal(chats.length, count);
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
  await manager.wake('parent', 'Internal review instruction', '【作業通知】レビュー通知');
  const completed = { id: 'reviewed', threadId: 'parent', root: '/project', status: 'completed', applied: true, approvedVersion: 1, version: 1, instructionStatus: 'current', scope, outcome: { success: true, result: { changeCount: 1, conflictCount: 0 } } };
  manager.tasks.push(completed, { ...completed, id: 'unapplied', applied: false }, { ...completed, id: 'stale', approvedVersion: 0 }, { ...completed, id: 'conflicting', outcome: { success: true, result: { changeCount: 1, conflictCount: 1 } } });
  const context = manager.learningContext('parent');
  assert.deepEqual(context.originalMessages, [{ id: 'one', prompt: 'Instruction one' }]);
  assert.deepEqual(context.successfulEdits.map(edit => edit.callId), ['reviewed']);
  assert.deepEqual(context.successfulEdits[0].messageIds, ['one']);
});

test('unattached proposal tasks cannot start when another worker finishes', async t => {
  const { manager } = await setup(t); await manager.receive(input('one'));
  const first = await manager.create('parent', args); const next = await manager.create('parent', { ...args, deferStart: true });
  const a = manager.task('parent', first.taskId); const b = manager.task('parent', next.taskId);
  await until(() => a.status === 'reviewing');
  await manager.review('parent', { taskId: a.id, version: 1, decision: 'reject', reason: 'Finish without adopting.' });
  await until(() => manager.running === null);
  assert.equal(b.status, 'preparing'); assert.equal(b.attempt, 0);
  await manager.activate([b.id]); await until(() => b.status === 'reviewing');
  await manager.review('parent', { taskId: b.id, version: 1, decision: 'reject', reason: 'Finish this test.' });
  await until(() => b.status === 'cancelled');
});

test('three candidate subagents run concurrently and each can finish before its peers', async t => {
  const { manager, applied } = await setup(t); await manager.receive(input('one', 'compare'));
  const receipts = await Promise.all(['a','b','c'].map(candidateId => manager.create('parent', { ...args, deferStart: true, proposal: { groupId: 'group', candidateId } })));
  await manager.activate(receipts.map(r => r.taskId));
  const tasks = receipts.map(r => manager.task('parent', r.taskId));
  await until(() => tasks.every(task => task.status === 'reviewing'));
  assert.equal(manager.runningTasks.size, 3);
  assert.equal(new Set(tasks.map(task => task.workerThreadId)).size, 3);
  const second = tasks[1];
  await manager.review('parent', { taskId: second.id, version: 1, decision: 'approve', reason: 'This candidate is ready independently.' });
  await until(() => second.status === 'completed' && manager.runningTasks.size === 2);
  assert.deepEqual(applied, [second.id]);
  assert.equal(tasks[0].status, 'reviewing'); assert.equal(tasks[2].status, 'reviewing');
  for (const task of [tasks[0],tasks[2]]) await manager.review('parent', {taskId:task.id,version:1,decision:'reject',reason:'End the remaining test work.'});
  await until(() => manager.running === null);
});

test('the same candidate workspace never overlaps and at most three workers run', async t => {
  const { manager } = await setup(t); await manager.receive(input('one'));
  const entries = ['a','a','b','c','d'];
  const receipts = await Promise.all(entries.map(candidateId => manager.create('parent', { ...args, deferStart: true, proposal: {groupId:'group',candidateId} })));
  await manager.activate(receipts.map(r=>r.taskId));
  const tasks = receipts.map(r=>manager.task('parent',r.taskId));
  await until(()=>[tasks[0],tasks[2],tasks[3]].every(task=>task.status==='reviewing'));
  assert.equal(tasks[1].status,'queued'); assert.equal(tasks[4].status,'queued'); assert.equal(manager.runningTasks.size,3);
  await manager.control('parent',{taskId:tasks[0].id,version:1,action:'cancel',instruction:'Cancel only the first candidate attempt.'});
  await until(()=>tasks[1].status==='reviewing'); assert.equal(tasks[0].status,'cancelled'); assert.equal(tasks[2].status,'reviewing'); assert.equal(manager.runningTasks.size,3);
  await manager.cancelConversation('parent'); await until(()=>manager.running===null);
});

test('failure of one parallel candidate does not cancel or hold another candidate', async t => {
  const { manager } = await setup(t,{beforeReady: task=>{if(task.proposal.candidateId==='b')throw new Error('Candidate B failed');}});
  await manager.receive(input('one'));
  const receipts=await Promise.all(['a','b','c'].map(candidateId=>manager.create('parent',{...args,deferStart:true,proposal:{groupId:'group',candidateId}})));
  await manager.activate(receipts.map(r=>r.taskId)); const tasks=receipts.map(r=>manager.task('parent',r.taskId));
  await until(()=>tasks[0].status==='reviewing'&&tasks[1].status==='failed'&&tasks[2].status==='reviewing');
  assert.match(tasks[1].error,/Candidate B failed/);
  await manager.review('parent',{taskId:tasks[0].id,version:1,decision:'approve',reason:'A is valid despite the unrelated failure.'});
  await until(()=>tasks[0].status==='completed'); assert.equal(tasks[2].status,'reviewing');
  await manager.cancelConversation('parent'); await until(()=>manager.running===null);
});

test('each running candidate publishes its own real activity', async t => {
  let release; const hold=new Promise(resolve=>{release=resolve;});
  const { manager }=await setup(t,{beforeReady:()=>hold}); await manager.receive(input('one'));
  const receipts=await Promise.all(['a','b','c'].map(candidateId=>manager.create('parent',{...args,deferStart:true,proposal:{groupId:'group',candidateId}})));
  await manager.activate(receipts.map(r=>r.taskId));const tasks=receipts.map(r=>manager.task('parent',r.taskId));
  await until(()=>tasks.every(task=>task.workerThreadId));
  await manager.progress(tasks[1].workerThreadId,{type:'fileChange'});
  assert.equal(tasks[1].activity,'ファイルを編集中'); assert.notEqual(tasks[0].activity,tasks[1].activity); assert.ok(tasks[1].activityAt>=tasks[1].startedAt);
  release();await until(()=>tasks.every(task=>task.status==='reviewing'));
  await manager.cancelConversation('parent');await until(()=>manager.running===null);
});

test('execution selection updates the current turn before delegation, persists, and rejects invalid or foreign changes', async t => {
  const { manager, chats, params, active } = await setup(t);
  await manager.receive(input('mode'));
  await until(() => chats.length === 1);
  const session = { activeThreadId: 'parent' };
  const create = async () => {
    await manager.assertExecutionModeSelected('parent', manager.messages.find(message => message.id === 'mode').turnId);
    const receipt = await manager.create('parent', { ...args, deferStart: true });
    return manager.task('parent', receipt.taskId);
  };
  await assert.rejects(create(), /app has displayed[\s\S]*No edit has started[\s\S]*end your turn/);
  assert.equal(manager.tasks.length, 0);
  assert.equal(manager.context('parent').executionModePending, true);
  assert.deepEqual(manager.snapshot('/project').executionModeChoices, [{ threadId: 'parent', root: '/project' }]);
  const pendingRestored = new Orchestration(params);
  await pendingRestored.load();
  assert.equal(pendingRestored.context('parent').executionModePending, true);
  await manager.selectExecutionMode('parent', 'compare', session);
  assert.equal(manager.context('parent').contextEnvelope.executionMode, 'compare');
  assert.equal(manager.context('parent').contextEnvelope.executionModeSelected, false);
  await assert.rejects(create(), /app has displayed/);
  await manager.confirmExecutionMode('parent', 'apply', session);
  assert.equal(manager.context('parent').executionModePending, false);
  assert.deepEqual(manager.snapshot('/project').executionModeChoices, []);
  const chosen = manager.messages.findLast(message => message.automatic);
  assert.match(manager.payloads.get(`parent:${chosen.id}`).automaticInstructions, /The user chose 編集をまかせる \(apply\) as the delivery method/);
  assert.equal(chosen.text, '【作業通知】実行方法：編集をまかせる を選択しました。');
  active.delete('parent');
  await manager.pump('parent');
  const resumed = chats.find(payload => payload.clientUserMessageId === chosen.id);
  assert.deepEqual(editorEnvelope(resumed.contextEnvelope), { modificationScope: scope, executionMode: 'apply', executionModeSelected: true, executionModePending: false });
  const actualPrompt = chatTurnPrompt(resumed, true, `\nEditor context envelope:\n${JSON.stringify(editorEnvelope(resumed.contextEnvelope))}`);
  assert.match(actualPrompt, /The user chose 編集をまかせる \(apply\)/);
  assert.match(actualPrompt, /Continue the user's immediately preceding edit request with edit_slides/);
  assert.match(actualPrompt, /"executionModeSelected":true/);
  assert.match(actualPrompt, /"executionModePending":false/);
  await assert.doesNotReject(() => manager.assertExecutionModeSelected('parent', 'not-a-notification-turn'));
  await manager.confirmExecutionMode('parent', 'apply', session);
  assert.equal(manager.messages.filter(message => message.automatic).length, 1);
  const original = await create();
  await manager.selectExecutionMode('parent', 'compare', session);
  const compared = await create();
  assert.equal(compared.contextEnvelope.executionMode, 'compare');
  assert.equal(compared.contextEnvelope.executionModeSelected, true);
  assert.equal(original.contextEnvelope.executionMode, 'apply');
  await manager.selectExecutionMode('parent', 'apply', session);
  assert.equal((await create()).contextEnvelope.executionMode, 'apply');
  assert.equal(compared.contextEnvelope.executionMode, 'compare');
  await assert.rejects(manager.selectExecutionMode('parent', 'invalid', session), /valid execution mode/);
  await assert.rejects(manager.selectExecutionMode('parent', 'compare', { activeThreadId: 'other' }), /not attached/);
  await manager.selectExecutionMode('parent', 'apply', session);
  assert.equal(manager.context('parent').contextEnvelope.executionModeSelected, true);
  await manager.receive(input('next'));
  assert.equal(manager.context('parent').contextEnvelope.executionModeSelected, true);
  const restored = new Orchestration(params);
  await restored.load();
  assert.equal(restored.context('parent').contextEnvelope.executionModeSelected, true);
  assert.equal(restored.context('parent').contextEnvelope.executionMode, 'apply');

  await manager.receive({ ...input('unselected', 'compare'), threadId: 'unselected' });
  await assert.rejects(() => manager.assertExecutionModeSelected('unselected', 'user-turn'), /app has displayed/);
  manager.context('unselected').contextEnvelope.proposalTarget = { groupId: 'group', candidateId: 'a', version: 1 };
  await assert.doesNotReject(() => manager.assertExecutionModeSelected('unselected', 'user-turn'));
  delete manager.context('unselected').contextEnvelope.proposalTarget;
  await until(() => active.has('unselected'));
  await manager.confirmExecutionMode('unselected', 'compare', { activeThreadId: 'unselected' });
  const comparedChoice = manager.messages.findLast(message => message.threadId === 'unselected' && message.automatic);
  active.delete('unselected');
  await manager.pump('unselected');
  const comparedResume = chats.find(payload => payload.clientUserMessageId === comparedChoice.id);
  assert.equal(comparedChoice.text, '【作業通知】実行方法：3案から選ぶ を選択しました。');
  assert.equal(comparedResume.contextEnvelope.executionMode, 'compare');
  assert.equal(comparedResume.contextEnvelope.executionModeSelected, true);
  assert.equal(comparedResume.contextEnvelope.executionModePending, false);
  assert.match(chatTurnPrompt(comparedResume, true, ''), /The user chose 3案から選ぶ \(compare\)[\s\S]*directions must contain exactly three distinct candidates/);
  await assert.doesNotReject(() => manager.assertExecutionModeSelected('unselected', 'not-a-notification-turn'));

  const page = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
  const comparisonPrompt = '別の探索案を作成してください。variation:trueで別ブランチにしてください。\n';
  assert.ok(page.includes(comparisonPrompt.replace('\n', '\\n')));
  await manager.receive({ ...input('button', 'compare'), threadId: 'button', prompt: comparisonPrompt + '見出しを簡潔に' });
  await assert.doesNotReject(() => manager.assertExecutionModeSelected('button', 'button-turn'));
  assert.equal(manager.context('button').contextEnvelope.executionModeSelected, false);

  await manager.receive({ ...input('notice'), threadId: 'notice' });
  await until(() => active.has('notice'));
  await manager.wake('notice', 'Review the finished work.', '【作業通知】レビュー通知');
  await assert.rejects(() => manager.assertExecutionModeSelected('notice', 'user-turn'), /app has displayed/);
  active.delete('notice');
  await manager.pump('notice');
  const notification = manager.messages.findLast(message => message.threadId === 'notice' && message.automatic);
  assert.equal(notification.status, 'delivered');
  await assert.doesNotReject(() => manager.assertExecutionModeSelected('notice', notification.turnId));
  await assert.rejects(() => manager.assertExecutionModeSelected('notice', 'other-turn'), /app has displayed/);
  await manager.receive({ ...input('after-notice'), threadId: 'notice' });
  await assert.rejects(() => manager.assertExecutionModeSelected('notice', notification.turnId), /app has displayed/);

  const api = await readFile(new URL('../server/local-api.mjs', import.meta.url), 'utf8');
  assert.match(api, /async function delegateEdit\(threadId, args, turnId\) \{\s*await orchestrator.assertExecutionModeSelected\(threadId, turnId\);\s*validateEditSlidesArguments/);
  assert.match(api, /delegateEdit\(params.threadId, args, params.turnId\)/);
  assert.match(api, /delegateEdit\(owner.threadId, args, owner.turnId\)/);
  assert.match(api, /prompt: chatTurnPrompt\(payload, automatic, editorContext\)/);
  const toolEndpoint = api.slice(api.indexOf('if (url.pathname === "/api/codex/tools")'), api.indexOf('if (url.pathname === "/api/codex/thread/start")'));
  assert.doesNotMatch(toolEndpoint, /confirmExecutionMode|execution-mode\/confirm/);
  assert.match(api, /url.pathname === "\/api\/codex\/execution-mode\/confirm"\s*\? await orchestrator.confirmExecutionMode/);
  assert.doesNotMatch(api, /payload\.(?:human|executionModeSelected)\b/);
});


test('delegated tasks retain the originating chat turn in storage and snapshots', async t => {
  const { manager, params, events } = await setup(t);
  await manager.receive(input('origin'));
  const { taskId } = await manager.create('parent', { ...args, deferStart: true }, 'chat-turn');
  assert.equal(manager.task('parent', taskId).originTurnId, 'chat-turn');
  assert.equal(manager.snapshot('/project').tasks.find(task => task.id === taskId).originTurnId, 'chat-turn');
  assert.equal(JSON.parse(await readFile(params.path, 'utf8')).tasks.find(task => task.id === taskId).originTurnId, 'chat-turn');
  assert.equal(events.at(-1).value.tasks.find(task => task.id === taskId).originTurnId, 'chat-turn');
  const api = await readFile(new URL('../server/local-api.mjs', import.meta.url), 'utf8');
  assert.match(api, /delegateEdit\(owner.threadId, args, owner.turnId\)/);
  assert.match(api, /delegateEdit\(params.threadId, args, params.turnId\)/);
  const creationCalls = api.match(/orchestrator.create\(threadId, .*$/gm);
  assert.equal(creationCalls.length, 3);
  for (const call of creationCalls) assert.match(call, /, turnId\);$/);
});

test('task cards render at their origin turn with legacy cards first and receipts last', async () => {
  const page = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
  const cards = await readFile(new URL('../app/components/AgentTasks.tsx', import.meta.url), 'utf8');
  const legacy = page.indexOf('turnId={null} onAction={handleAgentTaskAction}');
  const turns = page.indexOf('{visibleTurns.map((turn, turnIndex) => {');
  const logs = page.indexOf('className="work-details"', turns);
  const inline = page.indexOf('turnId={turn.id} onAction={handleAgentTaskAction}', turns);
  const end = page.indexOf('</section>;', inline);
  const receipts = page.indexOf('<OrchestratorReceipts snapshot={orchestration}');
  assert.ok(legacy < turns && turns < logs && logs < inline && inline < end && end < receipts);
  assert.ok(cards.includes('task.originTurnId === undefined || task.originTurnId === null : task.originTurnId === turnId'));
  assert.ok(!cards.includes('.reverse()') && !cards.includes('.slice(-30)'));
  assert.ok(!cards.includes('Codex担当の作業') && !cards.includes('件進行中'));
  assert.ok(cards.includes('key={task.id}') && cards.includes("onAction(task, 'cancel')"));
  assert.ok(page.includes('}, [codexState.items, agentRunning]);'));
});
