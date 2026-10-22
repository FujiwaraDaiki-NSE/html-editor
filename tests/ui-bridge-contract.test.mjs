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
  assert.match(page, /\/codex\/thread\/prepare/);
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
