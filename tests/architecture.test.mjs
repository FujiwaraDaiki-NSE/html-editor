import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const files = [
  "../server/local-api.mjs",
  "../server/project.mjs",
  "../server/codex/client.mjs",
  "../server/codex/service.mjs",
  "../app/page.tsx",
];

test("clean-break architecture has no legacy chat persistence, RPC client, or endpoints", async () => {
  const source = (await Promise.all(files.map((file) => readFile(new URL(file, import.meta.url), "utf8")))).join("\n");
  for (const legacy of [
    "chatPath",
    "readChat",
    "writeChat",
    "appendChat",
    "/api/chat/",
    "/api/agent/",
    "class CodexAppServer ",
    "handleAgentTurn",
    "setMessages(",
    "current-buffer",
  ]) {
    assert.equal(source.includes(legacy), false, `legacy symbol remains: ${legacy}`);
  }
  await assert.rejects(access(new URL("../workspaces/northstar/.weave/chat.json", import.meta.url)));
});

test("generated protocol and required architecture modules exist", async () => {
  for (const file of [
    "../generated/codex-app-server/ClientRequest.ts",
    "../generated/codex-app-server/ServerRequest.ts",
    "../generated/codex-app-server/version.json",
    "../server/codex/protocol.mjs",
    "../server/codex/request-router.mjs",
    "../server/codex/event-stream.mjs",
    "../app/codex/actions.ts",
    "../app/codex/selectors.ts",
    "../app/codex/components/ItemCard.tsx",
  ]) {
    await access(new URL(file, import.meta.url));
  }
});

test("policy gates protect commits while turn writes stay available", async () => {
  const [localApi, project] = await Promise.all([
    readFile(new URL("../server/local-api.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server/project.mjs", import.meta.url), "utf8"),
  ]);
  const save = localApi.slice(localApi.indexOf('url.pathname === "/api/save"'), localApi.indexOf('url.pathname === "/api/history/checkout"'));
  const turnStart = localApi.slice(localApi.indexOf('url.pathname === "/api/codex/turn/start"'), localApi.indexOf('url.pathname === "/api/codex/turn/steer"'));
  const steer = localApi.slice(localApi.indexOf('url.pathname === "/api/codex/turn/steer"'), localApi.indexOf('url.pathname === "/api/codex/turn/interrupt"'));
  const writeBody = project.slice(project.indexOf("export async function writeProject"), project.indexOf("export async function assertCommittable"));
  const atomicSave = project.slice(project.indexOf("export async function saveProject"), project.indexOf("export async function assertCommittable"));
  assert.ok(save.includes("saveProject"));
  assert.ok(atomicSave.includes("assertCommittable"));
  assert.ok(atomicSave.indexOf("assertCommittable") < atomicSave.indexOf("commitIfChanged"));
  assert.match(turnStart, /const root = projectRoot\(\)/);
  assert.match(turnStart, /writeProject\(payload\.deck, null, root\)/);
  assert.doesNotMatch(steer, /writeProject/);
  assert.doesNotMatch(writeBody, /auditContentPolicy/);
});

test("completed Agent turns enforce scope and merge concurrent drafts before publishing", async () => {
  const [source, page] = await Promise.all([
    readFile(new URL("../server/local-api.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  const completion = source.slice(source.indexOf('codex.on("notification"'), source.indexOf("const server = createServer"));
  const write = completion.indexOf("await writeProjectUnlocked(merged.deck, null, pending.root)");
  const ordinaryGate = completion.indexOf("} else {\n          await assertCommittable(pending.root);\n        }");
  const updated = completion.indexOf('status: "updated"');
  assert.ok(write >= 0 && write < ordinaryGate, "merged output must be written before auditing");
  assert.ok(ordinaryGate >= 0, "ordinary completion must run the committable audit");
  assert.ok(ordinaryGate < updated, "ordinary audit must run before the updated event");
  assert.match(completion, /status: "error",\n\s+projectRoot: pending\.root,\n\s+error: error\.message/);
  assert.match(completion, /status: "updated",[\s\S]*?baseline: pending\.preTurnDeck/);
  assert.match(completion, /\.\.\.\(error\.code \? \{ code: error\.code \} : \{\}\)/);
  assert.match(completion, /\.\.\.\(Array\.isArray\(error\.diagnostics\) \? \{ diagnostics: error\.diagnostics \} : \{\}\)/);
  assert.match(completion, /if \(pending\.variation\) \{[\s\S]*?commitIfChanged\([^\n]+pending\.root\)/);
  assert.match(completion, /await restoreFailedTurn\(pending\)/);
  assert.match(completion, /await restoreProjectSkillSnapshot\(pending\.root, pending\.projectSkillSnapshot\)/);
  assert.match(completion, /projectRoot: pending\.root/);
  assert.match(source, /pendingTurn\(\{[^\n]+workflow[^\n]+preTurnDeck: deck/);
  assert.match(completion, /validateAgentResult\(pending\.workflow, pending\.baseDeck, agentDeck\)/);
  assert.match(completion, /mergeEditorDecks\(\{ base: pending\.baseDeck, agent: agentDeck, current: currentDraft/);
  assert.match(source, /pending\.humanDraft = structuredClone\(payload\.deck\)/);
  assert.match(source, /recentAgentMerges\.set\(pending\.root/);
  assert.match(source, /mergeEditorDecks\(\{ base: recent\.base, agent: recent\.agent, current: payload\.deck \}\)/);
  assert.match(source, /restoreAgentManagedFiles\(pending/);
  assert.match(source, /await restoreDeckCss\(pending\.preTurnCss, pending\.root\)/);
  assert.match(source, /discardVariation\(pending\.branch, pending\.root\)/);
  assert.match(source, /some\(\(turn\) => turn\.root === root\)/);
  assert.match(source, /const finalizations = \[\.\.\.pendingTurns\.values\(\)\]\.map\(\(pending\) => pending\.finalization\)/);
  assert.match(source, /await Promise\.all\(finalizations\)/);
  assert.match(page, /projectEventDecision\(envelope\.payload\)/);
  assert.match(page, /setProjectEventDiagnostics\(projectEvent\.diagnostics\)/);
  assert.match(page, /const serverConflicts = Array\.isArray\(envelope\.payload\?\.conflicts\)/);
  assert.match(page, /mergeEditorDecks\(\{ base: envelope\.payload\.baseline, agent: state\.deck/);
  assert.match(page, />現在の編集を保持<\/button>/);
  assert.match(page, />Agentの変更を採用<\/button>/);
  assert.match(page, /if \(projectEvent\.error\) setApiError\(projectEvent\.error\)/);
  assert.match(
    page,
    /if \(projectEvent && !projectEvent\.refreshState\) \{[\s\S]*?setAgentPreview\(null\);[\s\S]*?eventSequenceRef\.current = Math\.max\([\s\S]*?continue;\n\s+\}/,
  );
});

test("variation turns share prompt validation and editor annotation context", async () => {
  const [localApi, page] = await Promise.all([
    readFile(new URL("../server/local-api.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  const startEditorTurn = localApi.slice(localApi.indexOf("async function startEditorTurn"), localApi.indexOf("codex.client.on"));
  assert.match(startEditorTurn, /const prompt = requireTurnPrompt\(payload\)/);
  const variation = page.slice(page.indexOf("const generateVariation"), page.indexOf("const acceptVariation"));
  assert.match(variation, /collectTurnAnnotations\(prompt/);
  assert.match(variation, /contextEnvelope\(variationAnnotations/);
});

test("UI uses Thread APIs, reducer, item cards, steering, interrupt, approvals, and catalogs", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  for (const surface of [
    "useReducer(codexReducer",
    "/codex/threads",
    "/codex/thread/start",
    "/codex/thread/resume",
    "/codex/thread/fork",
    "codex/turn/steer",
    "/codex/turn/interrupt",
    "pendingRequests",
    "catalog.skills",
    "catalog.hooks",
    "catalog.mcpServers",
    "ItemCard",
  ]) {
    assert.equal(page.includes(surface), true, `missing UI surface: ${surface}`);
  }
  assert.match(page, /connection: state\.codex\.connection/);
  assert.doesNotMatch(page, /version\?\.compatible/);
});

test("offline export and print embed local assets through the shared helper", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /import \{ embedAssetReferences, isAssetPath, rewriteAssetUrls \} from "\.\.\/shared\/asset-path\.mjs"/);
  const exportStart = page.indexOf("const exportDeck = async");
  const printStart = page.indexOf("const printDeck = async");
  const downloadStart = page.indexOf("const downloadBundle", exportStart);
  const restoreStart = page.indexOf("const restoreHistory", printStart);
  const exportBody = page.slice(exportStart, downloadStart);
  const printBody = page.slice(printStart, restoreStart);
  assert.match(exportBody, /const fragments = await embedAssetReferences\(exportFragments\(\), apiBase\)/);
  assert.match(printBody, /const fragments = await embedAssetReferences\(exportFragments\(\), apiBase\)/);
  assert.ok(printBody.indexOf("window.open") < printBody.indexOf("await embedAssetReferences"));
  assert.match(printBody, /const popup = window\.open\("", "_blank"\);\n\s+if \(!popup\)/);
  assert.ok(printBody.indexOf("popup.opener = null") < printBody.indexOf("await embedAssetReferences"));
  assert.doesNotMatch(printBody, /window\.open\([^\n]+noopener/);
  assert.match(printBody, /popup\.document\.write\(renderDeckDocument\(fragments/);
  assert.match(printBody, /popup\.document\.close\(\)/);
  assert.match(printBody, /popup\.addEventListener\("load", \(\) => popup\.print\(\)/);
  assert.match(printBody, /catch \(error\) \{\n\s+popup\.close\(\);\n\s+setApiError/);
});

test("activity rail destinations render their details in the left sidebar", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  for (const view of ['"agent"', '"history"', '"shortcuts"', '"settings"']) assert.match(page, new RegExp(`activityView === ${view}`));
  assert.match(page, /className="activity-panel history-panel"/);
  assert.match(page, /className="activity-panel settings-panel"/);
  assert.match(css, /\.activity-panel \{/);
  assert.doesNotMatch(page, /showHistory|history-popover|showCodexSettings|showHelp/);
});

test("the editor context stays with the composer instead of scrolling with the message log", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const messagesStart = page.indexOf('<div ref={messagesRef} className="messages"');
  const chatStart = page.indexOf('<div className="chat-box"', messagesStart);
  assert.notEqual(messagesStart, -1);
  assert.notEqual(chatStart, -1);
  assert.doesNotMatch(page.slice(messagesStart, chatStart), /className="context-chip"/);
  assert.match(page.slice(chatStart), /onDragOver=\{.*onDrop=\{.*onPaste=\{/s);
  assert.match(page.slice(chatStart), /<div className="context-chip"/);
});

test("transient lists share one dismissible popover contract", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /type OpenPopover = "delivery" \| "threads" \| "addBlock" \| "layouts" \| "newSlide" \| "slideMenu" \| "quality" \| "agentModel" \| "references" \| null/);
  assert.doesNotMatch(page, /OpenPopover[^\n]*"project"/);
  assert.match(page, /const \[openPopover, setOpenPopover\]/);
  assert.match(page, /event\.key !== "Escape"/);
  assert.match(page, /onPointerDown=\{\(\) => dismissPopover\(\)\}/);
  assert.match(page, /requestAnimationFrame\(\(\) => popoverTriggerRef\.current\?\.focus\(\)\)/);
  assert.match(css, /\.popover-backdrop \{ position: fixed;/);
  for (const retiredState of ["showThreads", "showAdd", "showBackgrounds", "showQuality"]) {
    assert.equal(page.includes(retiredState), false, `${retiredState} should use the shared popover state`);
  }
});

test("commands are grouped by editing, project, and delivery intent", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  for (const group of ["history-tools", "content-tools", "zoom-tools"]) {
    assert.match(page, new RegExp(`className="canvas-tool-group ${group}"`));
  }
  assert.doesNotMatch(page, /className="canvas-tool-group slide-tools"/);
  assert.match(page, /className="slide-actions-menu" role="menu"/);
  assert.doesNotMatch(page, /className="topbar-popover project-menu"/);
  assert.match(page, /className="project-switcher"[^>]*aria-haspopup="dialog"/);
  assert.match(page, /className="gallery" role="dialog"/);
  assert.match(page, /className="topbar-popover delivery-menu"/);
  assert.match(page, /<h3>表示<\/h3>/);
  assert.doesNotMatch(page, /className="icon-button"/);
  assert.doesNotMatch(page, /className="share-button"/);
  assert.match(css, /\.canvas-tool-group \+ \.canvas-tool-group/);
});

test("project changes autosave drafts and switching never requires a save gate", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const switchProject = page.slice(page.indexOf("const switchProject = async"), page.indexOf("const galleryMutation"));
  const createProject = page.slice(page.indexOf("const createProject = async"), page.indexOf("const relativeProjectTime"));
  assert.doesNotMatch(switchProject, /!saved|turnBusy|blocked/);
  assert.doesNotMatch(createProject, /!saved|turnBusy|blocked/);
  assert.match(page, /fetch\(`\$\{apiBase\}\/draft`/);
  assert.match(page, /setDraftSync\("synced"\)/);
  assert.doesNotMatch(page, /galleryDialog\.kind === "(?:dirty|create|turn)"/);
});

test("project writes bind to an explicit root across asynchronous work", async () => {
  const project = await readFile(new URL("../server/project.mjs", import.meta.url), "utf8");
  const writeProject = project.slice(project.indexOf("export async function writeProject"), project.indexOf("export async function assertCommittable"));
  const createProject = project.slice(project.indexOf("async function createProjectUnlocked"), project.indexOf("export async function createProject"));
  assert.match(writeProject, /writeProjectUnlocked\(input, expectedRevision, root\)/);
  assert.match(createProject, /writeProjectUnlocked\([^;]+, null, root\)/);
  assert.doesNotMatch(project, /function withProjectRoot/);
});

test("the content-bearing local slide library is removed", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  for (const legacy of ["weave.slideTemplates", "templateStore", "slideTemplates", "showTemplates", "saveSlideTemplate", "insertTemplate", "Save template", "template-library"]) {
    assert.equal(`${page}\n${css}`.includes(legacy), false, `legacy slide library remains: ${legacy}`);
  }
});

test("the slide canvas reports the actual rendered zoom and supports fit and 100%", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /const defaultCanvasZoom = 1;/);
  assert.match(page, /useState<number \| null>\(null\)/);
  assert.match(page, /const slideScale = manualZoom \?\? fitScale;/);
  assert.match(page, /const zoomMode = manualZoom === null \? "fit" : "manual";/);
  assert.match(page, /Math\.round\(slideScale \* 100\)/);
  assert.match(page, /aria-label="実寸で表示" onClick=\{\(\) => setManualZoom\(defaultCanvasZoom\)\}/);
  assert.match(page, /aria-label=\{`画面に合わせる・現在\$\{Math\.round\(slideScale \* 100\)\}%`\}/);
  assert.match(page, /const \[inspectorOpen, setInspectorOpen\] = useState\(false\)/);
  assert.match(page, /data-focus=\{canvasFocused \? "canvas" : "workspace"\}/);
  assert.match(page, /aria-label=\{canvasFocused \? "集中表示を終了" : "キャンバスに集中"\}/);
  assert.match(css, /\.canvas-area \{[^}]*container-type: size/);
  assert.match(css, /\.slide-shell \{[^}]*width: min\(calc\(100cqw - 24px\), calc\(177\.7778cqh - 131\.5556px\), 1280px\)/);
  assert.match(css, /\.canvas-interaction-status \{[^}]*bottom: calc\(95% \+ 1px\)/);
  assert.match(css, /\.canvas-toolbar \{[^}]*top: calc\(95% \+ 1px\)/);
  assert.match(css, /\.workspace\[data-focus="canvas"\] \{ grid-template-columns: minmax\(540px, 1fr\); \}/);
  assert.match(css, /\.workspace\[data-focus="canvas"\] \.filmstrip \{ display: none; \}/);
  assert.match(css, /\.workspace\[data-slide-nav\]\[data-focus="canvas"\] \.center-stage \{ grid-template-rows: 38px minmax\(0, 1fr\); \}/);
  assert.doesNotMatch(css, /\.slide-shell \{[^}]*83%|\.slide-shell \{[^}]*880px/);
});

test("block dragging previews reordering and separates move from text editing", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  for (const behavior of ["onCanvasDragOver", "REORDER_HYSTERESIS_PX", "nearestContainerChild", "animateDomReorder", "onCanvasDragEnd", "originParent", "ブロックを移動中 · 離して配置", "テキストを編集中 · Escで終了"]) assert.match(page, new RegExp(behavior.replace(/[·]/g, "·")));
  for (const affordance of [".canvas-interaction-status", ".weave-dragging", ".weave-drop-before", ".weave-drop-after"]) assert.equal(css.includes(affordance), true, `missing drag affordance: ${affordance}`);
  assert.match(css, /\.weave-dragging[^}]*pointer-events: none/);
  // Containers nest: nothing may exclude a dragged container from a container drop target.
  assert.doesNotMatch(page, /!session\.node\.classList\.contains\("weave-container"\)/);
  // A dropped block must not bounce: the container keeps its placeholder box around the ghost.
  assert.match(css, /:has\(> \.weave-dragging:only-child\)/);
});

test("a selected element can be referenced without knowing the pointing shortcut", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const pointerReferenceHelper = page.match(/const pickPointerElement[\s\S]{0,200}?\n\s+(\w+)\([^;\n]*\);/)?.[1];
  const buttonReferenceHelper = page.match(/const referenceSelectedElement[\s\S]{0,200}?\n\s+(\w+)\([^;\n]*\);/)?.[1];
  const referenceButton = page.match(/agentReady &&[\s\S]{0,200}<button[^>]*onClick=\{referenceSelectedElement\}[^>]*>Agentへ指示<\/button>/)?.[0] ?? "";
  assert.ok(pointerReferenceHelper);
  assert.equal(buttonReferenceHelper, pointerReferenceHelper);
  assert.match(referenceButton, /onClick=\{referenceSelectedElement\}/);
  assert.match(css, /\.selection-toolbar \{[^}]*position: absolute/);
  assert.match(css, /\.selection-toolbar button \{[^}]*cursor: pointer/);
});

test("issue 3 keeps every primary surface reachable and removes implementation-facing chrome", async () => {
  const [page, css, layout] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);
  for (const view of ["キャンバス", "スライド", "Agent"]) assert.match(page, new RegExp(`>${view}<\\/button>`));
  assert.match(page, />その他\{/);
  assert.match(page, />履歴とマイルストーン<\/button>/);
  assert.match(page, />スキル<\/button>/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.mobile-tabs/);
  assert.match(page, /className="slide-thumbnail"[\s\S]*dangerouslySetInnerHTML/);
  assert.doesNotMatch(page, /mini-[1-4]|Working tree clean|Unsaved editor changes|Commit label|Return to latest on main|>Code</);
  assert.match(page, /className="document-title-field" data-unsaved=/);
  assert.doesNotMatch(css, /unsaved-dot::after/);
  assert.match(page, /sel\.container && sel\.kind !== "metrics"/);
  assert.match(page, /探索案を比較/);
  assert.match(page, /Agentの変更/);
  assert.match(layout, /<html lang="ja">/);
  assert.match(css, /font-family: var\(--font-geist-sans\)/);
});

test("the primary interface is Japanese and every button receives hover help", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  for (const label of ["プレゼン・書き出し", "履歴とマイルストーン", "キーボードショートカット", "デザイン", "同期済み"]) {
    assert.match(page, new RegExp(label));
  }
  assert.match(page, /document\.querySelectorAll<HTMLButtonElement>\("button"\)/);
  assert.match(page, /button\.dataset\.help/);
  assert.match(page, /button\.getAttribute\("aria-label"\)/);
  assert.match(page, /button\.title = help/);
  assert.match(page, /data-help="プロジェクトの作成・切り替え・管理を開きます"/);
});

test("pointer tabs stay persistent only when a frame needs an outside target", async () => {
  const [page, overlay] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/AnnotationOverlay.tsx", import.meta.url), "utf8"),
  ]);
  const frames = overlay.slice(overlay.indexOf("{candidates.map"), overlay.indexOf("{candidates.map", overlay.indexOf("{candidates.map") + 1));
  const tabs = overlay.slice(overlay.indexOf("{candidates.map", overlay.indexOf("{candidates.map") + 1));
  assert.match(page, /containsCandidate: node\.querySelector\("\[data-weave-id\]"\) !== null/);
  assert.doesNotMatch(frames, /containsCandidate/);
  assert.match(tabs, /!existing && !candidate\.containsCandidate && hoveredId !== candidate\.id/);
  assert.match(tabs, /tabIndex=\{-1\}/);
  assert.match(tabs, /aria-hidden="true"/);
});

test("annotation mode draws regions without selecting or pointing at elements", async () => {
  const [page, readme] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
  ]);
  const gestureType = page.slice(page.indexOf("type AnnotationGesture"), page.indexOf("type AnnotationBox"));
  const annotationPointerDown = page.slice(page.indexOf("if (annotationMode) {", page.indexOf("const onCanvasPointerDown")), page.indexOf("const target =", page.indexOf("const onCanvasPointerDown")));
  const annotationPointerEnd = page.slice(page.indexOf("const onCanvasPointerEnd"), page.indexOf("const beginEdit"));
  assert.doesNotMatch(gestureType, /elementId/);
  assert.doesNotMatch(annotationPointerDown, /readSelection|setSelectedId/);
  assert.doesNotMatch(annotationPointerEnd, /pointElement|target: \{ kind: "element" \}/);
  for (const wording of ["Mark for Agent · 変更したい範囲をドラッグ", "Mark for Agentでは範囲だけを指定できます", "メッセージ欄から要素をAgentへ示す"]) assert.match(page, new RegExp(wording));
  assert.doesNotMatch(page, /Rough/);
  /* The UI names the act; the umbrella term stays in the data vocabulary only (D10). */
  assert.doesNotMatch(page, /Annotation mode/);
  assert.match(page, /data-annotation-mode/);
  assert.match(readme, /`@`[^\n]+要素[^\n]+矩形だけ/);
});

test("Mark for Agent shows what it can do before anything is drawn", async () => {
  const [overlay, css] = await Promise.all([
    readFile(new URL("../app/components/AnnotationOverlay.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  /* The ghost is for the empty draft only, and it must never eat the drag that starts on it. */
  assert.match(overlay, /interactive && annotations\.length === 0/);
  assert.match(overlay, /annotation-empty-state" aria-hidden="true"/);
  assert.match(css, /\.annotation-empty-state \{[^}]*pointer-events: none/);
  /* The label teaches by example rather than naming the field. */
  assert.match(overlay, /placeholder="Agentへの変更指示を入力"/);
  /* The paper belongs to the drafting layer: recall reads the result, so it is never veiled. */
  assert.match(css, /\.annotation-overlay-layer\.interactive \{[^}]*backdrop-filter/);
  assert.doesNotMatch(css, /\.annotation-recall-layer[^\n]*backdrop-filter/);
});

test("the object tree is an accessible collapsible section with stable body styling", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /const \[objectTreeOpen, setObjectTreeOpen\] = useState\(true\)/);
  assert.match(page, /className="property-heading" aria-expanded=\{objectTreeOpen\}/);
  assert.match(page, /className=\{`layer-tree-body /);
  assert.match(css, /\.layer-tree-body \{/);
  assert.doesNotMatch(css, /\.layer-tree > div:last-child/);
});

test("canvas class operations support SVG blocks", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  // SVG blocks expose className as SVGAnimatedString, so canvas nodes must use classList/setAttribute.
  assert.doesNotMatch(page, /\b(?:node|child|target|element)\.className\.split\(/);
  assert.doesNotMatch(page, /\b(?:node|child|target|element)\.className\s*=/);
});

test("local API constrains origins and exposes reconnectable NDJSON events", async () => {
  const source = await readFile(new URL("../server/local-api.mjs", import.meta.url), "utf8");
  assert.match(source, /isAllowedWebOrigin/);
  assert.match(source, /WEAVE_WEB_PORT/);
  assert.match(source, /routeMethodDecision/);
  assert.match(source, /application\/x-ndjson/);
  assert.match(source, /codex\.events\.attach/);
  assert.doesNotMatch(source, /response.*close.*interrupt/is);
});

test("project retarget failures keep Codex connection state consistent", async () => {
  const source = await readFile(new URL("../server/local-api.mjs", import.meta.url), "utf8");
  const retarget = source.slice(source.indexOf("async function retargetCodex"), source.indexOf("function requireText"));
  assert.match(retarget, /codex\.publishIncompatible\(error, "project retarget"\)/);
  assert.doesNotMatch(retarget, /events\.publish\("codex\/connection"/);
});

test("project switching serializes root changes through ensure and Codex retargeting", async () => {
  const source = await readFile(new URL("../server/local-api.mjs", import.meta.url), "utf8");
  assert.match(source, /let projectSwitchQueue = Promise\.resolve\(\);/);
  assert.match(source, /const next = projectSwitchQueue\.then\(operation, operation\);/);
  assert.match(source, /projectSwitchQueue = next\.catch\(\(\) => \{\}\);/);
  for (const route of [
    source.slice(source.indexOf('if (request.method === "POST" && url.pathname === "/api/projects")'), source.indexOf('if (request.method === "POST" && url.pathname === "/api/projects/current")')),
    source.slice(source.indexOf('if (request.method === "POST" && url.pathname === "/api/projects/current")'), source.indexOf('const projectMatch')),
  ]) {
    assert.match(route, /await enqueueProjectSwitch\(async \(\) => \{/);
    assert.ok(route.indexOf("await switchProject") < route.indexOf("await ensureProject"));
    assert.ok(route.indexOf("await ensureProject") < route.indexOf("await retargetCodex"));
    assert.match(route, /if \(pendingTurns\.size === 0\) await retargetCodex\(\)/);
  }
  assert.match(source, /finishPendingTurn[\s\S]*enqueueProjectSwitch[\s\S]*retargetCodex\(targetRoot\)/);
  assert.match(source, /async function retargetCodex\(targetRoot = projectRoot\(\)\)[\s\S]*codexProjectRoot = targetRoot/);
  assert.match(source, /projectReady: codexProjectRoot === projectRoot\(\)/);
});

test("development processes share one strict loopback web port", async () => {
  const source = await readFile(new URL("../scripts/dev.mjs", import.meta.url), "utf8");
  assert.match(source, /resolveWebPort/);
  assert.match(source, /WEAVE_WEB_PORT/);
  assert.match(source, /127\.0\.0\.1/);
  assert.match(source, /--strictPort/);
});

test("async editor updates preserve newer local edits", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /editGenerationRef/);
  assert.match(page, /generation === editGenerationRef\.current/);
  assert.match(page, /applyServerState\(result as ServerState, unchanged\)/);
  assert.match(page, /targetSlideId/);
  assert.match(page, /targetElementId/);
  assert.match(page, /annotations: annotations\.map\(cloneAnnotation\)/);
  assert.match(page, /embedAssetReferences/);
});

test("production code does not call excluded or experimental app-server APIs", async () => {
  const source = (await Promise.all([
    readFile(new URL("../server/local-api.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server/codex/service.mjs", import.meta.url), "utf8"),
  ])).join("\n");
  for (const method of [
    "thread/rollback",
    "thread/inject_items",
    "thread/shellCommand",
    "process/spawn",
    "process/writeStdin",
    "process/resizePty",
    "process/kill",
    "experimentalFeature/enablement/set",
    "plugin/install",
    "plugin/uninstall",
    "marketplace/add",
    "config/value/write",
    "config/batchWrite",
    "externalAgentConfig/import",
  ]) {
    assert.equal(source.includes(`"${method}"`), false, `excluded method is called: ${method}`);
  }
});
