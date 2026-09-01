import type { ItemState } from "../types";

const labels: Record<string, string> = {
  agentMessage: "Agent",
  userMessage: "あなた",
  plan: "計画",
  reasoning: "推論の要約",
  commandExecution: "コマンド",
  fileChange: "ファイル変更",
  mcpToolCall: "MCPツール",
  dynamicToolCall: "ツール実行",
  collabAgentToolCall: "サブAgent",
  subAgentActivity: "サブAgentの作業",
  enteredReviewMode: "レビュー開始",
  exitedReviewMode: "レビュー完了",
  webSearch: "Web検索",
  imageView: "画像",
  imageGeneration: "画像生成",
  contextCompaction: "コンテキスト整理",
  review: "レビュー",
};
const glyphs: Record<string, string> = {
  plan: "◇",
  reasoning: "∴",
  commandExecution: "›",
  fileChange: "✎",
  mcpToolCall: "◇",
  dynamicToolCall: "›",
  collabAgentToolCall: "◇",
  subAgentActivity: "◇",
  enteredReviewMode: "◎",
  exitedReviewMode: "◎",
  webSearch: "⌕",
  imageView: "▧",
  imageGeneration: "✦",
  contextCompaction: "≡",
  review: "◎",
};

export function ItemCard({ item }: { item: ItemState }) {
  const known = Object.hasOwn(labels, item.type);
  const isMessage = item.type === "agentMessage" || item.type === "userMessage";
  const label = labels[item.type] ?? "不明な項目";
  const summary = item.text || item.reasoning[0] || item.output.split("\n")[0] || item.diff.split("\n")[0];
  const hasWorkBody = !isMessage && Boolean(item.text || item.reasoning.length);
  const longUserMessage = item.type === "userMessage" && item.text.length > 600;
  const userMessagePreview = item.text.split(/\r?\n/).slice(0, 3).join(" ").slice(0, 240).trim();
  return (
    <article className={`codex-item codex-item-${item.type} ${isMessage ? "message" : "work-card"}`}>
      {isMessage ? (
        <div className="message-content">
          <span className="message-label">{label}{item.status !== "completed" && <span className="message-status">{item.status}</span>}</span>
          {item.reasoning.map((part, index) => <p key={index}>{part}</p>)}
          {item.text && (longUserMessage ? (
            <details>
              <summary>{userMessagePreview}…</summary>
              <p className="codex-item-text">{item.text}</p>
            </details>
          ) : <p className="codex-item-text">{item.text}</p>)}
        </div>
      ) : (
        <div className="work-summary"><span className="work-glyph" aria-hidden="true">{glyphs[item.type] ?? "·"}</span><strong>{label}</strong>{summary && <span className="work-summary-text">· {summary}</span>}</div>
      )}
      {hasWorkBody && (
        <details>
          <summary>詳細</summary>
          {item.reasoning.map((part, index) => <p key={index}>{part}</p>)}
          {item.text && <p className="codex-item-text">{item.text}</p>}
        </details>
      )}
      {item.output && (
        <details open={item.status === "running"}>
          <summary>出力{item.outputTruncated ? "（最新100 KB）" : ""}</summary>
          <pre>{item.output}</pre>
        </details>
      )}
      {(item.diff || item.type === "fileChange") && (
        <details>
          <summary>差分</summary>
          <pre>{item.diff || "テキスト差分はありません。"}</pre>
        </details>
      )}
      {!known && <code>{String(item.raw?._method ?? "item")} · {item.type}</code>}
    </article>
  );
}
