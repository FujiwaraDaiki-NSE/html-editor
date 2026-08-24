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
  assert.ok(save.includes("assertCommittable"));
  assert.ok(save.indexOf("assertCommittable") < save.indexOf("commitIfChanged"));
  assert.match(turnStart, /writeProject\(payload\.deck\)/);
  assert.doesNotMatch(turnStart, /writeProject\(payload\.deck,\s*[^)]/);
  assert.doesNotMatch(steer, /writeProject/);
  assert.doesNotMatch(writeBody, /auditContentPolicy/);
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
  const chatStart = page.indexOf('<div className="chat-box">', messagesStart);
  assert.notEqual(messagesStart, -1);
  assert.notEqual(chatStart, -1);
  assert.doesNotMatch(page.slice(messagesStart, chatStart), /className="context-chip"/);
  assert.match(page.slice(chatStart), /<div className="chat-box">\s*<div className="context-chip"/);
});

test("transient lists share one dismissible popover contract", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /type OpenPopover = "project" \| "delivery" \| "threads" \| "addBlock" \| "layouts" \| "newSlide" \| "quality" \| null/);
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
  for (const group of ["history-tools", "content-tools", "slide-tools", "zoom-tools"]) {
    assert.match(page, new RegExp(`className="canvas-tool-group ${group}"`));
  }
  assert.match(page, /className="topbar-popover project-menu"/);
  assert.match(page, /className="topbar-popover delivery-menu"/);
  assert.match(page, /<h3>Appearance<\/h3>/);
  assert.doesNotMatch(page, /className="icon-button"/);
  assert.doesNotMatch(page, /className="share-button"/);
  assert.match(css, /\.canvas-tool-group \+ \.canvas-tool-group/);
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

test("the slide canvas opens at 100% zoom", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /const defaultCanvasZoom = 1;/);
  assert.match(page, /useState<number \| null>\(defaultCanvasZoom\)/);
  assert.match(page, /aria-label="Fit to screen" onClick=\{\(\) => setManualZoom\(null\)\}/);
  assert.match(page, /const \[inspectorOpen, setInspectorOpen\] = useState\(true\)/);
  assert.match(page, /data-focus=\{canvasFocused \? "canvas" : "workspace"\}/);
  assert.match(page, /aria-label=\{canvasFocused \? "Exit canvas focus" : "Focus canvas"\}/);
  assert.match(css, /\.canvas-area \{[^}]*container-type: size/);
  assert.match(css, /\.slide-shell \{[^}]*width: min\(calc\(100cqw - 24px\), calc\(160cqh - 19\.2px\), 1280px\)/);
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
  for (const behavior of ["onCanvasDragOver", "REORDER_HYSTERESIS_PX", "nearestContainerChild", "animateDomReorder", "onCanvasDragEnd", "originParent", "Moving block · release to place", "Editing text · Esc to finish"]) assert.match(page, new RegExp(behavior.replace(/[·]/g, "·")));
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
  const referenceButton = page.match(/agentReady &&[\s\S]{0,200}<button[^>]*className="canvas-reference-button"[^>]*>@[^<]*Reference<\/button>/)?.[0] ?? "";
  assert.ok(pointerReferenceHelper);
  assert.equal(buttonReferenceHelper, pointerReferenceHelper);
  assert.match(referenceButton, /onClick=\{referenceSelectedElement\}/);
  assert.match(css, /\.canvas-reference-button \{[^}]*margin: 0 4px/);
  assert.match(css, /\.canvas-reference-button \{[^}]*pointer-events: auto/);
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
  for (const wording of ["Rough mode · drag to draw a frame", "Rough mode draws frames only", "Point to an element from the message composer"]) assert.match(page, new RegExp(wording));
  /* The UI names the act; the umbrella term stays in the data vocabulary only (D10). */
  assert.doesNotMatch(page, /Annotation mode/);
  assert.match(page, /data-annotation-mode/);
  assert.match(readme, /`@`[^\n]+要素[^\n]+矩形だけ/);
});

test("rough mode shows what it can do before anything is drawn", async () => {
  const [overlay, css] = await Promise.all([
    readFile(new URL("../app/components/AnnotationOverlay.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  /* The ghost is for the empty draft only, and it must never eat the drag that starts on it. */
  assert.match(overlay, /interactive && annotations\.length === 0/);
  assert.match(overlay, /annotation-empty-state" aria-hidden="true"/);
  assert.match(css, /\.annotation-empty-state \{[^}]*pointer-events: none/);
  /* The label teaches by example rather than naming the field. */
  assert.match(overlay, /placeholder="What goes here\?/);
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
  assert.doesNotMatch(page, /\.className\.split\(/);
  assert.doesNotMatch(page, /\b(?:node|child|target|element)\.className\s*=/);
});

test("local API constrains origins and exposes reconnectable NDJSON events", async () => {
  const source = await readFile(new URL("../server/local-api.mjs", import.meta.url), "utf8");
  assert.match(source, /isAllowedWebOrigin/);
  assert.match(source, /WEAVE_WEB_PORT/);
  assert.match(source, /application\/x-ndjson/);
  assert.match(source, /codex\.events\.attach/);
  assert.doesNotMatch(source, /response.*close.*interrupt/is);
});

test("development processes share one strict loopback web port", async () => {
  const source = await readFile(new URL("../scripts/dev.mjs", import.meta.url), "utf8");
  assert.match(source, /resolveWebPort/);
  assert.match(source, /WEAVE_WEB_PORT/);
  assert.match(source, /127\.0\.0\.1/);
  assert.match(source, /--strictPort/);
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
