import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { partitionPendingRequests } from "../app/codex/selectors.ts";
import { deriveTurnPresentation, IDLE_TURN_SUBMISSION, isTerminalTurnStatus, resetTurnSubmission } from "../app/codex/turn-status.ts";
import { beginRequestResolution, finishRequestResolution } from "../app/codex/request-state.ts";

test("Agent production tasks separate messages, work logs, and blocking requests", async () => {
  const [page, itemCard, requestCard, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/codex/components/ItemCard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/codex/components/ServerRequestCard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /className="thread-actions-menu"/);
  assert.match(page, /className="thread-menu-trigger"/);
  assert.match(page, /onThreadMenuKeyDown/);
  assert.match(page, /\["ArrowDown", "ArrowUp", "Home", "End"\]/);
  assert.match(page, /className="work-details"/);
  assert.match(page, /className="work-items"/);
  assert.match(page, /className="blocking-region"/);
  assert.match(page, /activePendingServerRequests\.length > 0/);
  assert.match(page, /response\.status !== 202/);
  assert.match(page, /phase: "accepted"/);
  assert.match(page, /turnId: result\.turn\.id/);
  assert.match(page, /turnSubmission\.phase !== "idle" \|\| codexState\.activeTurnId !== null/);
  assert.match(page, /const canSubmitAgentMessage = !turnInFlightRef\.current \|\| agentRunning/);
  assert.match(page, /別タスクで実行中/);
  assert.match(page, /resyncPendingRequests/);
  assert.match(page, /result: "result_unknown"/);
  assert.match(page, /setTurnSubmission\(IDLE_TURN_SUBMISSION\)/);
  assert.match(page, /aria-label="制作タスクのやり取り" aria-busy=\{turnBusy\}/);
  assert.match(page, /role="status" aria-live="polite" aria-busy=\{turnBusy\}/);
  assert.match(page, /data-turn-state=\{turnPresentation\}/);
  assert.match(page, /thread-popover" role="dialog" aria-modal="true"/);
  assert.match(page, /onThreadDialogKeyDown/);
  assert.match(page, /input\[type="search"\]/);
  assert.match(itemCard, /item\.output/);
  assert.match(itemCard, /item\.diff/);
  assert.match(page, /isConversationMessage/);
  assert.doesNotMatch(page, /contextSummary|agentActivity/);

  const messagesStart = page.indexOf('<div ref={messagesRef} className="messages"');
  const composerStart = page.indexOf('<div className="composer-dock"', messagesStart);
  assert.ok(messagesStart >= 0 && composerStart > messagesStart);
  assert.doesNotMatch(page.slice(messagesStart, composerStart), /className="blocking-region"/);
  assert.doesNotMatch(page.slice(messagesStart, composerStart), /ServerRequestCard/);
  assert.match(page.slice(composerStart), /aria-label="確認が必要な操作"/);
  assert.match(css, /\.chat-box \{[^}]*border-radius: 12px/s);
  assert.match(css, /\.stop-button \{ visibility: hidden;/);
  assert.match(requestCard, /resolutionPhaseRef/);
  assert.match(requestCard, /beginRequestResolution/);
  assert.match(requestCard, /result_unknown/);
  assert.match(requestCard, /resolutionRetryable/);
});

test("turn submission distinguishes acceptance from progress and survives conversation switches", () => {
  const accepted = { phase: "accepted", threadId: "thread-1", turnId: "turn-1" };
  const submitting = { phase: "submitting", threadId: "thread-1", turnId: null };
  assert.equal(deriveTurnPresentation(submitting, "thread-1", false), "submission");
  assert.equal(deriveTurnPresentation(submitting, "thread-2", false), "idle");
  assert.equal(deriveTurnPresentation(accepted, "thread-1", false), "accepted");
  assert.equal(deriveTurnPresentation(accepted, "thread-1", true), "in_progress");
  assert.deepEqual(resetTurnSubmission(accepted, "thread-1", true, "connected"), IDLE_TURN_SUBMISSION);
  assert.deepEqual(resetTurnSubmission(accepted, "thread-2", false, "connected"), accepted);
  assert.deepEqual(resetTurnSubmission(submitting, "thread-2", false, "connected"), submitting);
  assert.deepEqual(resetTurnSubmission(accepted, "thread-1", false, "connected", "completed"), IDLE_TURN_SUBMISSION);
  assert.deepEqual(resetTurnSubmission(accepted, "thread-1", false, "connected", "failed"), IDLE_TURN_SUBMISSION);
  assert.equal(isTerminalTurnStatus("completed"), true);
  assert.equal(isTerminalTurnStatus("running"), false);
  assert.deepEqual(resetTurnSubmission(accepted, "thread-1", false, "disconnected"), IDLE_TURN_SUBMISSION);
});

test("pending request attribution keeps only the active thread in header scope", () => {
  const request = (id, params) => ({ id, method: "item/commandExecution/requestApproval", params, createdAt: id });
  const groups = partitionPendingRequests([
    request("active", { threadId: "thread-1" }),
    request("other", { threadId: "thread-2" }),
    request("unknown", {}),
  ], "thread-1");
  assert.deepEqual(groups.active.map(({ id }) => id), ["active"]);
  assert.deepEqual(groups.other.map(({ id }) => id), ["other"]);
  assert.deepEqual(groups.unscoped.map(({ id }) => id), ["unknown"]);
});

test("request resolution guard allows one mutation and reopens after failure", () => {
  let phase = "idle";
  let mutationCount = 0;
  const attempt = () => {
    const next = beginRequestResolution(phase);
    if (!next.started) return;
    phase = next.phase;
    mutationCount += 1;
  };
  attempt();
  attempt();
  assert.equal(mutationCount, 1);
  phase = finishRequestResolution(phase, false);
  attempt();
  assert.equal(mutationCount, 2);
  const started = beginRequestResolution("idle");
  assert.deepEqual(started, { phase: "submitting", started: true });
  assert.deepEqual(beginRequestResolution(started.phase), { phase: "submitting", started: false });
  assert.equal(finishRequestResolution(started.phase, false), "idle");
  assert.equal(finishRequestResolution(started.phase, true), "settled");
  assert.equal(finishRequestResolution(started.phase, "result_unknown"), "result_unknown");
  assert.deepEqual(beginRequestResolution("result_unknown"), { phase: "result_unknown", started: false });
  assert.deepEqual(beginRequestResolution("result_unknown", true), { phase: "submitting", started: true });
  assert.equal(finishRequestResolution("settled", false), "settled");
});
