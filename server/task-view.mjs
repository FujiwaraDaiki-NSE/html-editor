/** Bounded tool views keep old worker output out of every coordinator request. */
export function taskSummary(task) {
  return { id: task.id, status: task.status, model: task.model, scope: task.scope, version: task.version, attempt: task.attempt,
    prompt: task.prompt.slice(0, 1200), latestInstruction: task.latestInstruction?.slice(0, 1200), instructionStatus: task.instructionStatus,
    activity: task.activity, error: task.error, requiresReview: task.status === 'reviewing' };
}
export function taskDetails(task) {
  const report = task.report;
  const size = report?.sources.reduce((sum, source) => sum + (source.before?.length ?? 0) + (source.after?.length ?? 0), 0) ?? 0;
  return { ...taskSummary(task), prompt: task.prompt, latestInstruction: task.latestInstruction, review: task.review,
    report: report === null ? null : { scope: report.scope, workerOutput: report.workerOutput.slice(0, 12000), sources: size <= 60000 ? report.sources : null, sourceSlideIds: report.sources.map(source => source.slideId), paged: size > 60000 } };
}
export function taskChanges(task, { slideId, offset, limit }) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16000) throw new Error('Use a nonnegative offset and limit from 1 to 16000.');
  const source = task.report?.sources.find(item => item.slideId === slideId); if (!source) throw new Error('This task has no source change for that slide.');
  const total = Math.max(source.before?.length ?? 0, source.after?.length ?? 0);
  return { taskId: task.id, version: task.version, slideId, before: source.before === null ? null : source.before.slice(offset, offset + limit), after: source.after === null ? null : source.after.slice(offset, offset + limit), nextOffset: offset + limit < total ? offset + limit : null, total };
}
