export type AgentTask = {
  id: string; threadId: string; root: string; model: string; prompt: string; version: number;
  status: string; activity: string; scope: { kind: string; slideIds: string[]; elementId: string | null };
  instructionStatus: string; latestInstruction: string | null; attempt: number; review: string | null; error: string | null;
  report: null | { workerOutput: string; sources: Array<{ slideId: string; before: string | null; after: string | null }> };
};
export type MessageReceipt = { id: string; threadId: string; root: string; text: string; automatic: boolean; status: string; error: string | null };
export type OrchestrationSnapshot = { tasks: AgentTask[]; messages: MessageReceipt[] };
const labels: Record<string, string> = { queued: '開始待ち', awaiting_approval: '編集前の確認待ち', running: 'Codexが作業中', reviewing: 'オーケストレータがレビュー中', applying: 'レビュー合格・反映中', cancelling: '停止処理中', completed: '反映済み', cancelled: '中止', failed: '失敗' };
const finished = new Set(['completed', 'cancelled', 'failed']);
export function AgentTasks({ snapshot, threadId, onAction }: { snapshot: OrchestrationSnapshot; threadId: string | null; onAction: (task: AgentTask, action: 'approve' | 'cancel') => void }) {
  const tasks = snapshot.tasks.filter(task => task.threadId === threadId).slice(-30).reverse();
  const messages = snapshot.messages.filter(message => message.threadId === threadId && !message.automatic && ['queued', 'failed', 'unknown'].includes(message.status));
  return <>
    {messages.map(message => <article className="orchestrator-receipt" key={message.id} role={['failed', 'unknown'].includes(message.status) ? 'alert' : 'status'}><strong>{['failed', 'unknown'].includes(message.status) ? '送信を確認してください' : '受付済み・オーケストレータへの引き渡し待ち'}</strong><p>{message.text}</p>{message.error && <p>{message.error}</p>}</article>)}
    {tasks.length > 0 && <section className="agent-task-list" aria-label="Codex担当の作業一覧">
      <header><strong>Codex担当の作業</strong><small>{tasks.filter(task => !finished.has(task.status)).length}件進行中</small></header>
      {tasks.map(task => <article className={`agent-task-card ${task.status}`} key={task.id} aria-label={`担当作業 ${task.id.slice(0, 8)}`}>
        <header><strong>{labels[task.status] ?? task.status}</strong><small>{task.model} · {task.attempt}回目</small></header>
        <p className="agent-task-request">{task.prompt}</p>
        <p>対象：{task.scope.kind === 'deck' ? 'デッキ全体' : task.scope.slideIds.join(' / ')}{task.scope.elementId ? ` · ${task.scope.elementId}` : ''}</p>
        <p role="status">{task.activity}</p>
        {task.instructionStatus === 'pending' && <p className="activity-warning">追加指示を受付済み・継続／変更／停止を判断待ち</p>}
        {task.status === 'awaiting_approval' && <button type="button" data-ui-agent-exclude="true" disabled={task.instructionStatus !== 'current'} onClick={() => onAction(task, 'approve')}>この内容で編集</button>}
        {!finished.has(task.status) && <button type="button" data-ui-agent-exclude="true" onClick={() => onAction(task, 'cancel')}>この作業を中止</button>}
        {task.error && <p role="alert">{task.error}</p>}
        <details><summary>指示・レビュー・作業結果</summary>
          <p>担当への指示：{task.prompt}</p>
          {task.latestInstruction && <p>追加指示：{task.latestInstruction}</p>}
          {task.review && <p>判断・レビュー：{task.review}</p>}
          {task.report && <><pre>{task.report.workerOutput}</pre>{task.report.sources.map(source => <details key={source.slideId}><summary>{source.slideId}の変更前後</summary><strong>変更前</strong><pre>{source.before}</pre><strong>変更後</strong><pre>{source.after}</pre></details>)}</>}
        </details>
      </article>)}
    </section>}
  </>;
}
