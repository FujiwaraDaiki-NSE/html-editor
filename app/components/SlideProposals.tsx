"use client";
import { memo, useEffect, useRef, useState } from "react";
import { composeSlideHtml } from "../../shared/slide-slots.mjs";
import { rewriteAssetUrls } from "../../shared/asset-path.mjs";
import { designWidth, designHeight } from "../../shared/slide-design.mjs";

export type ProposalTarget = {
  groupId: string;
  candidateId: string;
  version: number;
  slideId: string;
};
export type ProposalCandidate = {
  targetSlideIds: string[];
  id: string;
  title: string;
  description: string | null;
  instruction: string;
  version: number;
  taskId: string | null;
  status: string;
  previewRevision: string;
  activity: string | null;
  startedAt: number | null;
  stale: boolean;
  error: string | null;
  available: {
    view: boolean;
    adopt: boolean;
    revise: boolean;
    dismiss: boolean;
  };
};
export type ProposalGroup = {
  id: string;
  threadId: string;
  prompt: string;
  state: string;
  preparationError: string | null;
  slideIds: string[];
  selections: Record<string, string>;
  scope: { kind: string; slideIds: string[] };
  candidates: ProposalCandidate[];
};
type Slide = {
  id: string;
  html: string;
  accent: string;
  templateId: string;
  layoutId: string;
};
type Preview = {
  deck: { slides: Slide[] };
  css: string;
  templates: Array<{
    id: string;
    masterHtml: string;
    layouts: Array<{ id: string; html: string }>;
  }>;
  review: string | null;
  reviewed: boolean;
  phase: "baseline" | "working" | "previous" | "reviewed";
  previewRevision: string;
  groupId: string;
  candidateId: string;
  version: number;
};
const statusLabels: Record<string, string> = {
  preparing: "準備中",
  queued: "開始待ち",
  running: "作成中",
  reviewing: "レビュー中",
  applying: "最終確認中",
  ready: "比較できます",
  failed: "失敗",
  cancelled: "中止",
  cancelling: "停止中",
  completed: "結果を保存中",
};
const SlideFrame = memo(function SlideFrame({
  preview,
  slideId,
  apiBase,
  thumbnail = false,
}: {
  preview: Preview;
  slideId: string;
  apiBase: string;
  thumbnail?: boolean;
}) {
  const frame = useRef<HTMLSpanElement>(null);
  const [scale, setScale] = useState(0.5);
  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) =>
      setScale(entries[0].contentRect.width / designWidth),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const index = preview.deck.slides.findIndex((slide) => slide.id === slideId);
  const slide = preview.deck.slides[index];
  let content = "";
  let error = "";
  try {
    if (slide) {
      const template = preview.templates.find((t) => t.id === slide.templateId);
      const layout = template?.layouts.find((l) => l.id === slide.layoutId);
      if (!template || !layout)
        throw new Error("案のテンプレートを読み込めません。");
      content = composeSlideHtml({
        slideHtml: slide.html,
        masterHtml: template.masterHtml,
        layoutHtml: layout.html,
        templateId: template.id,
        layoutId: layout.id,
        position: index + 1,
        total: preview.deck.slides.length,
        accent: slide.accent,
        instanceId: slide.id,
      });
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  if (!slide || error)
    return (
      <p role="status">{error || "この案では、このスライドを削除します。"}</p>
    );
  const src = `<!doctype html><html><head><style>${preview.css}</style><style>html,body{margin:0;width:${designWidth}px;height:${designHeight}px;overflow:hidden}body>.weave-slide{width:${designWidth}px;height:${designHeight}px}</style></head><body>${rewriteAssetUrls(content, `${apiBase}/proposals/${preview.groupId}/${preview.candidateId}`)}</body></html>`;
  return (
    <span
      className="proposal-frame"
      ref={frame}
      aria-hidden={thumbnail || undefined}
      inert={thumbnail || undefined}
      style={{ aspectRatio: `${designWidth}/${designHeight}` }}
    >
      <iframe
        sandbox=""
        title={`${preview.candidateId.toUpperCase()}案の${thumbnail ? "サムネイル" : "スライド"}`}
        tabIndex={thumbnail ? -1 : undefined}
        srcDoc={src}
        style={{
          width: designWidth,
          height: designHeight,
          transform: `scale(${scale})`,
        }}
      />
    </span>
  );
});
export function SlideProposals({
  groups,
  slideId,
  apiBase,
  onTarget,
  onAdopt,
  onDismiss,
  syncReady,
}: {
  groups: ProposalGroup[];
  slideId: string;
  apiBase: string;
  syncReady: boolean;
  onTarget: (target: ProposalTarget | null) => boolean;
  onAdopt: (
    group: ProposalGroup,
    candidate: ProposalCandidate,
    slideIds: string[],
  ) => Promise<void>;
  onDismiss: (group: ProposalGroup) => Promise<void>;
}) {
  const [selection, setSelection] = useState<{
    groupId: string;
    candidateId: string;
  } | null>(null);
  const [compare, setCompare] = useState(false);
  const [history, setHistory] = useState(false);
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const relevant = groups.filter((g) => g.slideIds.includes(slideId));
  const visible = relevant.filter(
    (g) => history || (g.state === "open" && !g.selections[slideId]),
  );
  const group = visible.find((g) => g.id === selection?.groupId);
  const selected = group?.candidates.find(
    (c) => c.id === selection?.candidateId,
  );
  const key = (g: ProposalGroup, c: ProposalCandidate) =>
    `${g.id}:${c.id}:${c.version}`;
  const reviewedPreviewVisible =
    !!group &&
    !!selected &&
    previews[key(group, selected)]?.reviewed === true &&
    previews[key(group, selected)]?.previewRevision ===
      selected.previewRevision;
  const requested = visible.flatMap((g) =>
    g.candidates
      .filter((c) => c.available.view)
      .map((c) => ({ group: g, candidate: c })),
  );
  const requestKeys = requested
    .map(({ group: g, candidate: c }) => `${key(g, c)}:${c.previewRevision}`)
    .join(",");
  useEffect(() => {
    const controller = new AbortController();
    for (const { group: g, candidate: c } of requested) {
      const id = key(g, c);
      if (previews[id]?.previewRevision === c.previewRevision) continue;
      void fetch(
        `${apiBase}/proposals/preview?groupId=${g.id}&candidateId=${c.id}&version=${c.version}`,
        { signal: controller.signal },
      )
        .then(async (r) => {
          const body = await r.json();
          if (!r.ok) throw new Error(body.error);
          setPreviews((current) => ({ ...current, [id]: body }));
        })
        .catch((cause) => {
          if (!controller.signal.aborted) setError(String(cause.message));
        });
    }
    return () => controller.abort();
    // Fetch all visible cards; refresh only when the server publishes a new candidate revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKeys, apiBase]);
  if (!relevant.length) return null;
  const choose = (g: ProposalGroup, c: ProposalCandidate) => {
    if (
      !c.available.view ||
      !onTarget(
        g.state === "open" && !g.selections[slideId]
          ? {
              groupId: g.id,
              candidateId: c.id,
              version: c.version,
              slideId,
            }
          : null,
      )
    )
      return;
    setSelection({ groupId: g.id, candidateId: c.id });
    setCompare(false);
    setError(null);
  };
  const live = () => {
    if (!onTarget(null)) return;
    setSelection(null);
    setCompare(false);
  };
  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      live();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="proposal-workspace"
      data-open={compare || !!selected}
      aria-label="このスライドの提案"
    >
      <div className="proposal-toolbar">
        <div className="proposal-toolbar-context">
          <button
            type="button"
            className={`proposal-draft-button${!selected && !compare ? " is-selected" : ""}`}
            aria-pressed={!selected && !compare}
            onClick={live}
          >
            編集中のスライド
          </button>
          {visible.map((g) => (
            <p className="proposal-progress" key={g.id} role="status">
              {g.candidates.filter((c) => c.status === "ready").length} /{" "}
              {g.candidates.length} 案がレビュー済み
            </p>
          ))}
        </div>
        <div className="proposal-toolbar-actions">
          {visible.some((g) => g.candidates.some((c) => c.available.view)) && (
            <button
              type="button"
              className={compare ? "is-selected" : ""}
              aria-pressed={compare}
              onClick={() => {
                if (onTarget(null)) {
                  setCompare((v) => !v);
                  setSelection(null);
                }
              }}
            >
              案を比較
            </button>
          )}
          <button
            type="button"
            aria-pressed={history}
            onClick={() => {
              live();
              setHistory((v) => !v);
            }}
          >
            {history ? "未採用の案だけ" : "比較履歴"}
          </button>
        </div>
      </div>
      {visible.map((g) => (
        <div
          className="proposal-choices"
          role="group"
          aria-label="3案の選択"
          key={g.id}
        >
          {g.candidates.map((c) => {
            const active = group?.id === g.id && selected?.id === c.id;
            const status = `${statusLabels[c.status] ?? c.status}${c.status === "running" && c.activity ? ` · ${c.activity}` : ""}`;
            return (
              <button
                type="button"
                key={c.id}
                className={`proposal-choice${active ? " is-selected" : ""}`}
                aria-pressed={active}
                disabled={!c.available.view}
                onClick={() => choose(g, c)}
                title={`${c.id.toUpperCase()}案：${c.title} — ${status}`}
              >
                <span className="proposal-choice-heading">
                  <span className="proposal-choice-letter">
                    {c.id.toUpperCase()}案
                  </span>
                  {active && (
                    <span className="proposal-choice-selected">表示中</span>
                  )}
                </span>
                <span className="proposal-choice-thumbnail">
                  {previews[key(g, c)] ? (
                    <SlideFrame
                      preview={previews[key(g, c)]}
                      slideId={slideId}
                      apiBase={apiBase}
                      thumbnail
                    />
                  ) : (
                    <span className="proposal-thumbnail-placeholder">
                      {c.available.view
                        ? "プレビューを読み込み中…"
                        : "プレビューを準備中…"}
                    </span>
                  )}
                  {previews[key(g, c)]?.phase === "baseline" && (
                    <span className="proposal-thumbnail-label">
                      元のスライド
                    </span>
                  )}
                  {previews[key(g, c)]?.phase === "previous" && (
                    <span className="proposal-thumbnail-label">更新前の案</span>
                  )}
                </span>
                <span className="proposal-choice-title">{c.title}</span>
                <span className="proposal-choice-status">
                  <span
                    className={`proposal-state-dot ${c.status}`}
                    aria-hidden="true"
                  />
                  {status}
                </span>
              </button>
            );
          })}
        </div>
      ))}
      {visible
        .filter((g) => g.preparationError !== null)
        .map((g) => (
          <div className="proposal-live-status" key={g.id}>
            <p role="alert">{g.preparationError}</p>
            <button
              type="button"
              className="archive-direction"
              data-ui-agent-exclude="true"
              disabled={busy || !g.candidates.every((c) => c.available.dismiss)}
              onClick={() => void perform(() => onDismiss(g))}
            >
              提案を終了
            </button>
          </div>
        ))}
      {error && <p role="alert">{error}</p>}
      {selected && group && (
        <>
          <div className="proposal-description">
            {!reviewedPreviewVisible && (
              <div className="proposal-live-status" role="status">
                <strong>
                  {selected.status === "ready"
                    ? "最終結果を読み込み中"
                    : (statusLabels[selected.status] ?? selected.status)}
                </strong>
                <span>
                  {previews[key(group, selected)]?.phase === "baseline"
                    ? "生成前の元資料を表示しています"
                    : previews[key(group, selected)]?.phase === "previous"
                      ? "更新前の案を表示しています"
                      : "レビュー前のプレビューです。完了後に採用できます"}
                </span>
              </div>
            )}
            {selected.error && <p role="alert">{selected.error}</p>}
            <strong>
              {selected.id.toUpperCase()}案：{selected.title}
            </strong>
            <p>{selected.description}</p>
            <small>
              {selected.stale
                ? "提案作成後に資料が更新されています。採用時に最新の編集と照合します。"
                : "編集中の資料は変更されていません。"}
              {group.selections[slideId] ? " このスライドは採用済みです。" : ""}
            </small>
            <div className="editor-tab-actions">
              <button
                className="use-direction"
                data-ui-agent-exclude="true"
                disabled={
                  busy ||
                  !syncReady ||
                  !selected.available.adopt ||
                  !reviewedPreviewVisible ||
                  !!group.selections[slideId]
                }
                onClick={() =>
                  void perform(() => onAdopt(group, selected, [slideId]))
                }
              >
                このスライドに採用
              </button>
              <button
                className="use-direction"
                data-ui-agent-exclude="true"
                disabled={
                  busy ||
                  !syncReady ||
                  !selected.available.adopt ||
                  !reviewedPreviewVisible ||
                  selected.targetSlideIds.every((id) => group.selections[id])
                }
                onClick={() =>
                  void perform(() =>
                    onAdopt(
                      group,
                      selected,
                      selected.targetSlideIds.filter(
                        (id) => !group.selections[id],
                      ),
                    ),
                  )
                }
              >
                未採用の対象すべてに採用
              </button>
              <button
                className="archive-direction"
                data-ui-agent-exclude="true"
                disabled={busy || !selected.available.dismiss}
                onClick={() => void perform(() => onDismiss(group))}
              >
                提案を終了
              </button>
            </div>
            {!syncReady && (
              <small>編集中の内容を同期してから採用できます。</small>
            )}
          </div>
          {previews[key(group, selected)] ? (
            <SlideFrame
              preview={previews[key(group, selected)]}
              slideId={slideId}
              apiBase={apiBase}
            />
          ) : (
            <p role="status">案を読み込み中…</p>
          )}
        </>
      )}
      {compare && (
        <section className="variation-compare" aria-label="提案の比較">
          <div className="variation-compare-grid" data-mode="side-by-side">
            {visible.flatMap((g) =>
              g.candidates
                .filter((c) => c.available.view)
                .map((c) => (
                  <article key={`${g.id}:${c.id}`}>
                    <strong>
                      {c.id.toUpperCase()} {c.title}
                    </strong>
                    {previews[key(g, c)] ? (
                      <SlideFrame
                        preview={previews[key(g, c)]}
                        slideId={slideId}
                        apiBase={apiBase}
                      />
                    ) : (
                      <p>読み込み中…</p>
                    )}
                    <p>{c.description}</p>
                    <button onClick={() => choose(g, c)}>案を開く</button>
                  </article>
                )),
            )}
          </div>
        </section>
      )}
      {!visible.length && (
        <small>このスライドの提案は採用済み、または終了しています。</small>
      )}
    </section>
  );
}
