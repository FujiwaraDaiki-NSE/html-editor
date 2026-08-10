import type { ItemState } from "../types";

const labels: Record<string, string> = {
  agentMessage: "Agent",
  userMessage: "You",
  plan: "Plan",
  reasoning: "Reasoning summary",
  commandExecution: "Command",
  fileChange: "File change",
  mcpToolCall: "MCP tool",
  dynamicToolCall: "Tool call",
  collabAgentToolCall: "Sub-agent",
  subAgentActivity: "Sub-agent activity",
  enteredReviewMode: "Review started",
  exitedReviewMode: "Review completed",
  webSearch: "Web search",
  imageView: "Image",
  imageGeneration: "Image generation",
  contextCompaction: "Context compaction",
  review: "Review",
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
  const label = labels[item.type] ?? "Unknown item";
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
          <summary>Details</summary>
          {item.reasoning.map((part, index) => <p key={index}>{part}</p>)}
          {item.text && <p className="codex-item-text">{item.text}</p>}
        </details>
      )}
      {item.output && (
        <details open={item.status === "running"}>
          <summary>Output{item.outputTruncated ? " (latest 100 KB)" : ""}</summary>
          <pre>{item.output}</pre>
        </details>
      )}
      {(item.diff || item.type === "fileChange") && (
        <details>
          <summary>Diff</summary>
          <pre>{item.diff || "No textual diff was provided."}</pre>
        </details>
      )}
      {!known && <code>{String(item.raw?._method ?? "item")} · {item.type}</code>}
    </article>
  );
}
