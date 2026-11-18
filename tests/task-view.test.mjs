import assert from 'node:assert/strict';
import test from 'node:test';
import { taskSummary, taskDetails, taskChanges } from '../server/task-view.mjs';
const task = { id: 'task', threadId: 'parent', status: 'reviewing', prompt: 'p'.repeat(5000), latestInstruction: 'i'.repeat(5000), report: { workerOutput: 'w'.repeat(15000), sources: [{ slideId: 'one', before: 'a'.repeat(40000), after: 'b'.repeat(40000) }] } };
test('task lists remain small and large source changes are explicitly paginated', () => {
  assert.equal(taskSummary(task).prompt.length, 1200);
  assert.equal(Object.hasOwn(taskSummary(task), 'report'), false);
  const details = taskDetails(task); assert.equal(details.report.paged, true); assert.equal(details.report.sources, null); assert.deepEqual(details.report.sourceSlideIds, ['one']);
  let offset = 0; let before = ''; let after = '';
  do { const page = taskChanges(task, { slideId: 'one', offset, limit: 16000 }); before += page.before; after += page.after; offset = page.nextOffset; } while (offset !== null);
  assert.equal(before, task.report.sources[0].before); assert.equal(after, task.report.sources[0].after);
  assert.throws(() => taskChanges(task, { slideId: 'one', offset: 0, limit: 20000 }), /limit/);
  assert.throws(() => taskChanges(task, { slideId: 'other', offset: 0, limit: 100 }), /no source/);
});
test('a small report includes both exact sources without another tool call', () => {
  const details = taskDetails({ ...task, report: { workerOutput: 'Done', sources: [{ slideId: 'one', before: 'Before', after: 'After' }] } });
  assert.equal(details.report.paged, false); assert.equal(details.report.sources[0].after, 'After');
});
