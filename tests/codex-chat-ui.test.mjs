import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Codex chat separates conversation, turn work logs, and blocking requests", async () => {
  const [page, itemCard, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/codex/components/ItemCard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /className="thread-actions-menu"/);
  assert.match(page, /className="thread-menu-trigger"/);
  assert.match(page, /className="work-details"/);
  assert.match(page, /className="work-items"/);
  assert.match(page, /className="blocking-region"/);
  assert.match(page, /aria-label="Agentとの会話" aria-busy=\{agentRunning\}/);
  assert.match(page, /role="status" aria-live="polite" aria-busy=\{agentRunning\}/);
  assert.match(itemCard, /item\.output/);
  assert.match(itemCard, /item\.diff/);
  assert.match(page, /isConversationMessage/);
  assert.doesNotMatch(page, /contextSummary|agentActivity/);

  const messagesStart = page.indexOf('<div ref={messagesRef} className="messages"');
  const composerStart = page.indexOf('<div className="composer-dock">', messagesStart);
  assert.ok(messagesStart >= 0 && composerStart > messagesStart);
  assert.doesNotMatch(page.slice(messagesStart, composerStart), /className="blocking-region"/);
  assert.doesNotMatch(page.slice(messagesStart, composerStart), /ServerRequestCard/);
  assert.match(page.slice(composerStart), /aria-label="確認が必要な操作"/);
  assert.match(css, /\.chat-box \{[^}]*border-radius: 12px/s);
  assert.match(css, /\.stop-button \{ visibility: hidden;/);
});
