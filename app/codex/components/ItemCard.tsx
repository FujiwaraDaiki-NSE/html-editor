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

export function ItemCard({ item }: { item: ItemState }) {
  const known = Object.hasOwn(labels, item.type);
  const isMessage = item.type === "agentMessage" || item.type === "userMessage";
  return (
    <article className={`codex-item codex-item-${item.type} ${isMessage ? "message" : "work-card"}`}>
      <header>
        <strong>{labels[item.type] ?? "Unknown item"}</strong>
        <span>{item.status}</span>
      </header>
      {item.reasoning.map((part, index) => <p key={index}>{part}</p>)}
      {item.text && <p className="codex-item-text">{item.text}</p>}
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
