import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("browser UI bridge exposes the semantic, observable operation contract", async () => {
  const [bridge, page, css] = await Promise.all([
    readFile(new URL("../app/ui-bridge.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  for (const operation of ["inspect", "click", "fill", "select", "key"]) {
    assert.match(bridge, new RegExp(`export type UiOperation = [\\s\\S]*"${operation}"`));
  }
  assert.match(bridge, /target: UiTarget \| null/);
  assert.match(bridge, /button, input, select, textarea/);
  assert.match(bridge, /data-ui-agent-exclude/);
  assert.match(bridge, /dataset\.uiAgentId/);
  assert.match(bridge, /agentControlSequence/);
  assert.match(bridge, /POINTER_WAIT_MS = 600/);
  assert.match(bridge, /status: "completed" \| "rejected" \| "error"/);
  assert.doesNotMatch(bridge, /\beval\s*\(|new\s+Function\s*\(/);

  assert.match(page, /\/ui\/session/);
  assert.match(page, /\/ui\/response/);
  assert.match(page, /setInterval\(sync, 60_000\)/);
  assert.match(page, /uiSessionLeaseRef/);
  assert.match(page, /WEAVE_UI_REPLACED/);
  assert.match(page, /WEAVE_UI_OWNERSHIP_REQUIRED/);
  assert.match(page, /threadId, claim: allowReclaim/);
  assert.match(page, /revision !== uiSessionRevisionRef\.current && uiActiveThreadRef\.current !== threadId/);
  const ensureSessionStart = page.indexOf("const ensureUiSessionForThread = useCallback");
  const ensureSessionEnd = page.indexOf("useEffect(() => {", ensureSessionStart);
  assert.ok(ensureSessionStart >= 0 && ensureSessionEnd > ensureSessionStart);
  assert.match(page.slice(ensureSessionStart, ensureSessionEnd), /await enqueueUiSessionSync\(threadId, true\)/);
  assert.doesNotMatch(page.slice(ensureSessionStart, ensureSessionEnd), /return current/);
  assert.match(page, /payload\.threadId/);
  assert.match(page, /\/agent\/thread\/prepare/);
  assert.match(page, /editing: state\.codex\.editing/);
  assert.match(page, /envelope\.type === "weave\/ui"/);
  assert.match(page, /data-ui-root="weave"/);
  assert.match(page, /\{editorDialog\}/);
  assert.match(page, /data-ui-id="project-switcher"/);
  assert.match(page, /data-ui-id="create-project"/);
  assert.match(page, /data-ui-id=\{`project-\$\{item\.slug\}`\}/);
  assert.match(page, /data-ui-id="tab-agent"/);

  assert.match(css, /\.ui-operation-target/);
  assert.match(css, /\.ui-operation-pointer/);
  assert.match(css, /\.editor-dialog:not\(\[open\]\) \{ display: none; \}/);
});

test("agent controls are opened individually while self-control, approvals, credentials and file choosers stay excluded", async () => {
  const [bridge, page, tasks, proposals] = await Promise.all([
    "../app/ui-bridge.ts", "../app/page.tsx", "../app/components/AgentTasks.tsx", "../app/components/SlideProposals.tsx",
  ].map(path => readFile(new URL(path, import.meta.url), "utf8")));
  const excluded = bridge.slice(bridge.indexOf("const EXCLUDED_SELECTOR"), bridge.indexOf("const SECRET_NAME"));
  for (const selector of [".composer-dock", ".thread-popover", ".thread-actions-menu"]) assert.ok(!excluded.includes(selector));
  for (const selector of [".blocking-region", ".server-request", "password", "file"]) assert.ok(excluded.includes(selector));
  assert.match(bridge, /textarea, summary,/);
  assert.match(bridge, /await selectControl\(element, request.value\)/);
  for (const text of ["promptRef", "stop-button", "send-button", "キーを使用", "PCのフォルダーをアップロード", "＋ ファイルを追加", "SKILL.mdをアップロード", "画像を置き換え", "編集用データを読み込む"]) {
    const tag = page.match(new RegExp(`<[^>]*${text}[^>]*>`))?.[0];
    if (tag) assert.match(tag, /data-ui-agent-exclude="true"/, text);
    else {
      const index = page.indexOf(`>${text}<`);
      assert.ok(index > 0, text);
      assert.match(page.slice(page.lastIndexOf("<button", index), index), /data-ui-agent-exclude="true"/, text);
    }
  }
  assert.match(page, /className="blocking-region" data-ui-agent-exclude="true"/);
  for (const text of ["ログアウト", "ChatGPTでサインイン", "OAuth"]) {
    const index = page.indexOf(`>${text}<`);
    assert.match(page.slice(page.lastIndexOf("<button", index), index), /data-ui-agent-exclude="true"/);
  }
  assert.match(page, /data-ui-agent-exclude=\{kind === "image" \? "true" : undefined\}/);
  assert.doesNotMatch(page, /className="(?:chat-box|thread-switcher|new-thread-button|thread-menu-trigger|thread-actions-menu)" data-ui-agent-exclude/);
  assert.doesNotMatch(tasks + proposals, /data-ui-agent-exclude/);
  assert.match(page, /await changeExecutionMode\(value, false\)/);
  assert.match(page, /if \(event.nativeEvent.isTrusted\) void changeExecutionMode\(event.target.value, true\)/);
  for (const mode of ["apply", "compare"]) assert.ok(page.includes(`if (event.nativeEvent.isTrusted) void changeExecutionMode("${mode}", true)`));
  const card = page.slice(page.indexOf('{executionModePending &&'), page.indexOf('{pendingServerRequests.length > 0 &&'));
  assert.match(card, /className="blocking-region" data-ui-agent-exclude="true"/);
  assert.match(card, /実行方法を選んでください/);
  assert.match(card, /編集をまかせる（1案を作成して反映）/);
  assert.match(card, /3案から選ぶ（3案を作成して比較）/);
});
