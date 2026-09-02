"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- app-server catalog/request payloads are rendered defensively for forward compatibility. */
/* eslint-disable react-hooks/refs -- the editor intentionally treats the live canvas DOM as its source of truth. */

import { DragEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { actionFromStreamEvent } from "./codex/actions";
import { defaultDeckCss, designHeight, designWidth, escapeHtml, renderDeckDocument } from "../shared/slide-design.mjs";
import { embedAssetReferences, isAssetPath, rewriteAssetUrls } from "../shared/asset-path.mjs";
import { projectSlug } from "../shared/project-slug.mjs";
import { auditContentPolicy } from "../shared/content-policy.mjs";
import { composeSlideHtml, contentSlotSelector, extractSlideSourceHtml, titleFromSlideHtml, titleSlotSelector, withUniqueFragmentIds } from "../shared/slide-slots.mjs";
import { advancedControlKeys, allControlKeys, applyBlockPosition, applySize, applyUtilityClass, blockPositionOptions, containerControlKeys, decorationControlKeys, imageControlKeys, listControlKeys, migrateSlideHtmlToTailwind, ratioOptions, readBlockPosition, readSize, readUtilityClass, sizeIntents, slideControlGroups, textControlKeys } from "../shared/tailwind-slide.mjs";
import { canSendTurn, insertReferenceAt, nextOrder, rectFromClientBox, rectFromPoints, refreshAnnotations, resizeRect, resolveReferences, toSlidePoint, translateRect } from "../shared/annotation.mjs";
import { editorEnvelope, overflowingIds } from "../shared/context.mjs";
import { applyEditorChange, applyEditorHistory, mergeEditorDecks } from "../shared/editor-workflow.mjs";
import { AnnotationAttachment } from "./components/AnnotationAttachment";
import { AnnotationLegend } from "./components/AnnotationLegend";
import { AnnotationOverlay } from "./components/AnnotationOverlay";
import type { Annotation, AnnotationGestureKind, AnnotationRect, PointerCandidate, ResizeHandle } from "./components/AnnotationOverlay";
import { textExcerptOfNode } from "./components/editable-text-utils";
import { sourceElementIdAtOffset, sourceOffsetForElement, validateEditableSlideSource } from "./editor-source";
import { ItemCard } from "./codex/components/ItemCard";
import { ServerRequestCard } from "./codex/components/ServerRequestCard";
import { codexReducer, initialCodexState } from "./codex/reducer";
import type { RequestResolutionOutcome } from "./codex/request-state";
import { isConversationMessage, partitionPendingRequests, pendingRequestScope, selectThreadRunning, selectThreadTurns, selectTurnItems } from "./codex/selectors";
import { deriveTurnPresentation, IDLE_TURN_SUBMISSION, isTerminalTurnStatus, resetTurnSubmission, type TurnPresentationState, type TurnSubmissionState } from "./codex/turn-status";
import { preservedSlideNumber, projectEventDecision, projectEventMatchesActivePreview, viewedSlideIdForHydration } from "./project-events";

/* A slide is now a real HTML file: its `<main class="weave-slide">` fragment is the single
   truth. The editor renders that fragment as live DOM and edits it in place; nothing is
   modelled as tokens any more (concept 2.10). */
type SlideDoc = { id: string; title: string; notes: string; templateId: string; layoutId: string; accent: string; html: string };
type TemplateLayout = { id: string; name: string; html: string };
type TemplateDoc = { id: string; name: string; defaultLayoutId: string; masterHtml: string; layouts: TemplateLayout[] };
type PortableBundle = { format: "weave-deck"; version: 2; deck: { title: string; defaultTemplateId: string; slides: SlideDoc[] }; templates: TemplateDoc[]; css: string };
type ReferenceAttachment = { path: string; name: string; mimeType?: string; size: number; kind?: "file" | "folder"; files?: number };
type ReferenceShelfEntry = ReferenceAttachment & { hash?: string; addedAt?: string; source?: string; sourceMissing?: boolean; missing: boolean; kind: "file" | "folder" };
type FolderBrowser = { path: string; parent: string | null; breadcrumbs: Array<{ name: string; path: string }>; folders: Array<{ name: string; path: string }>; folderCount: number; fileCount: number };

type SlideNav = "filmstrip" | "rail";
type SkillScope = "project" | "common";
type SkillEntry = { name: string; description: string; body: string; content: string; frontmatter: string | null; scope: SkillScope; location: SkillScope; path: string; filePath: string; valid: boolean; error: string | null };
type SkillDraft = { scope: SkillScope; name: string; description: string; body: string; frontmatter: string };
type SkillDialog = { mode: "create" | "edit"; source: SkillEntry | null };
type SkillStatus = { state: "idle" | "busy" | "success" | "error"; message: string };
type ActivityView = "agent" | "history" | "shortcuts" | "skills" | "settings";
type MobileView = "canvas" | "agent" | "history" | "shortcuts" | "skills" | "slides" | "inspector" | "settings" | "more";
type InspectorView = "layers" | "design";
type OpenPopover = "delivery" | "threads" | "addBlock" | "layouts" | "newSlide" | "slideMenu" | "quality" | "agentModel" | "references" | null;
type VariationPreview = { branch: string; label: string; css: string; deck: ServerState["deck"] };
type ChangedTarget = { slideId: string; elementId: string };
type ChangeScope = "element" | "current-slide" | "selected-slides" | "deck";
type ExecutionMode = "apply" | "propose" | "plan";
type DraftSyncState = "synced" | "saving" | "offline" | "error";
type Density = "comfortable" | "compact";
type SourceDiagnostic = { message: string; line: number; column: number };
type SelectionToolbarPosition = { left: number; top: number; placement: "above" | "below" | "dock" };
type QualityDiagnostic = { id: string; code: string; severity: "error" | "warning" | "suggestion"; message: string; explanation: string; fixSuggestion: string; slideId: string | null; elementId: string | null; source: string };
type MergeConflict = { path: string; unit: "deck" | "slide" | "element"; slideId?: string; elementId?: string; base: unknown; current: unknown; agent: unknown; explanation: string };

function reviewChangeMatches(deck: { title: string; defaultTemplateId: string; slides: SlideDoc[] }, change: any, direction: "undo" | "redo") {
  const expected = direction === "undo" ? change.after : change.before;
  const expectedPresent = direction === "undo" ? change.afterPresent !== false : change.beforePresent !== false;
  if (change.type === "slide-move") return JSON.stringify(deck.slides.map((slide) => slide.id)) === JSON.stringify(expected);
  if (change.type === "slide-add" || change.type === "slide-delete") {
    const current = deck.slides.find((slide) => slide.id === change.slideId);
    return expectedPresent ? current !== undefined && JSON.stringify(current) === JSON.stringify(expected) : current === undefined;
  }
  if (change.elementId) return false;
  const owner: any = change.slideId ? deck.slides.find((slide) => slide.id === change.slideId) : change.path?.[0] === "settings" ? (deck as any).settings : deck;
  if (!owner || !change.key) return false;
  const currentPresent = Object.prototype.hasOwnProperty.call(owner, change.key);
  return expectedPresent ? currentPresent && JSON.stringify(owner[change.key]) === JSON.stringify(expected) : !currentPresent;
}

type ServerState = {
  deck: { title: string; defaultTemplateId: string; slides: SlideDoc[] };
  css: string;
  templates: TemplateDoc[];
  references: ReferenceShelfEntry[];
  history: HistoryEntry[];
  variations: Array<{ branch: string; label: string; commit: string; message: string; status: "ready" | "generating" | "paused" | "archived"; state?: "pending" | "ready" | "paused" | "archived" }>;
  project: { root: string; slug?: string; branch: string; commit: string; revision?: string; clean: boolean; historyPreview?: boolean; backgroundTasks?: Array<{ threadId?: string; turnId?: string; status: string; variation?: boolean; branch?: string }> };
  backgroundTasks?: Record<string, Array<{ threadId?: string; turnId?: string; status: string; variation?: boolean; branch?: string }>>;
  codex: {
    ready: boolean;
    projectReady: boolean;
    connection: { status: "connecting" | "connected" | "reconnecting" | "disconnected" | "incompatible"; error: string | null; cliVersion?: string | null };
    version: { matches: boolean; running: string; generated: string; warning: string | null } | null;
    catalog: { models: any[]; skills: any[]; hooks: any[]; mcpServers: any[]; account: Record<string, any> | null; modelProvider: Record<string, any> | null };
    activeTurns: Record<string, string>;
    pendingRequests: Array<{ id: string | number; method: string; params: Record<string, any>; createdAt: number }>;
  };
  skills: SkillEntry[];
  agentPreview: null | {
    threadId: string;
    turnId: string | null;
    baseline: { title: string; defaultTemplateId: string; slides: SlideDoc[] };
    changedSlideIds: string[];
    previewSequence: number;
    phase: "checking" | "editing" | "finalizing";
  };
  migrationNotice: string;
};

type HistoryEntry = { id: string; shortId: string; message: string; date: string };
type ProjectSummary = { slug: string; title: string; slideCount: number; updatedAt: string | null; current: boolean; blocked: boolean; blockedCount: number; thumbnailHtml: string; css: string };
type GalleryDialog = { kind: "rename"; slug: string; title: string } | { kind: "archive"; slug: string; title: string };

const apiBase = "/api";
const defaultCanvasZoom = 1;

const accents = [
  { color: "#fbbf24", className: "text-amber-400" }, { color: "#2dd4bf", className: "text-teal-400" },
  { color: "#a78bfa", className: "text-violet-400" }, { color: "#fb7185", className: "text-rose-400" },
  { color: "#34d399", className: "text-emerald-400" },
];

const parsePortableBundle = (value: unknown): PortableBundle => {
  const bundle = value as Partial<PortableBundle>;
  if (bundle?.format !== "weave-deck" || bundle.version !== 2 || typeof bundle.css !== "string" || !bundle.deck || typeof bundle.deck.title !== "string" || typeof bundle.deck.defaultTemplateId !== "string" || !bundle.deck.defaultTemplateId || !Array.isArray(bundle.deck.slides) || !bundle.deck.slides.length || !Array.isArray(bundle.templates) || !bundle.templates.length) throw new Error("このWeave編集用データには対応していません。");
  const ids = new Set<string>();
  const templates = bundle.templates.map((template) => {
    if (!template || typeof template.id !== "string" || !/^[a-z0-9_-]+$/.test(template.id) || ids.has(template.id) || typeof template.name !== "string" || !template.name || typeof template.defaultLayoutId !== "string" || !template.defaultLayoutId || typeof template.masterHtml !== "string" || !template.masterHtml || !Array.isArray(template.layouts) || !template.layouts.length) throw new Error("このWeaveテンプレートには対応していません。");
    ids.add(template.id);
    const layoutIds = new Set<string>();
    const layouts = template.layouts.map((layout) => {
      if (!layout || typeof layout.id !== "string" || !/^[a-z0-9_-]+$/.test(layout.id) || layoutIds.has(layout.id) || typeof layout.name !== "string" || !layout.name || typeof layout.html !== "string" || !layout.html) throw new Error(`対応していないレイアウトです: ${template.id}`);
      layoutIds.add(layout.id);
      return { id: layout.id, name: layout.name, html: layout.html };
    });
    if (!layoutIds.has(template.defaultLayoutId)) throw new Error(`既定のレイアウトが見つかりません: ${template.id}/${template.defaultLayoutId}`);
    return { id: template.id, name: template.name, defaultLayoutId: template.defaultLayoutId, masterHtml: template.masterHtml, layouts };
  });
  const catalog = new Map(templates.map((template) => [template.id, template]));
  if (!catalog.has(bundle.deck.defaultTemplateId)) throw new Error(`既定のテンプレートが見つかりません: ${bundle.deck.defaultTemplateId}`);
  const slideIds = new Set<string>();
  const slides = bundle.deck.slides.map((slide, index) => {
    if (!slide || typeof slide.id !== "string" || !slide.id || slideIds.has(slide.id) || typeof slide.title !== "string" || typeof slide.notes !== "string" || typeof slide.templateId !== "string" || typeof slide.layoutId !== "string" || typeof slide.accent !== "string" || !slide.accent || typeof slide.html !== "string" || !slide.html) throw new Error("このスライドデータには対応していません。");
    slideIds.add(slide.id);
    const template = catalog.get(slide.templateId);
    const layout = template?.layouts.find((item) => item.id === slide.layoutId);
    if (!template || !layout) throw new Error(`スライド${slide.id}のテンプレートまたはレイアウトが見つかりません。`);
    composeSlideHtml({ slideHtml: slide.html, masterHtml: template.masterHtml, layoutHtml: layout.html, templateId: slide.templateId, layoutId: slide.layoutId, position: index + 1, total: bundle.deck!.slides.length, accent: slide.accent, instanceId: slide.id });
    return { id: slide.id, title: slide.title, notes: slide.notes, templateId: slide.templateId, layoutId: slide.layoutId, accent: slide.accent, html: slide.html };
  });
  return { format: "weave-deck", version: 2, deck: { title: bundle.deck.title, defaultTemplateId: bundle.deck.defaultTemplateId, slides }, templates, css: bundle.css };
};

/* Slide-navigator placement lives in localStorage, read through an external store so the
   server and the first client render agree on the default before the stored value applies. */
const slideNavKey = "weave.slideNav";
const slideNavListeners = new Set<() => void>();
const slideNavStore = {
  subscribe(listener: () => void) { slideNavListeners.add(listener); return () => { slideNavListeners.delete(listener); }; },
  read: (): SlideNav => "rail",
  serverRead: (): SlideNav => "rail",
  write(value: SlideNav) { window.localStorage.setItem(slideNavKey, value); slideNavListeners.forEach((listener) => listener()); },
};

const sidebarWidthKey = "weave.sidebarWidth";
const sidebarWidthListeners = new Set<() => void>();
const clampSidebarWidth = (value: number) => Math.min(560, Math.max(280, value));
const sidebarWidthStore = {
  subscribe(listener: () => void) { sidebarWidthListeners.add(listener); return () => { sidebarWidthListeners.delete(listener); }; },
  read: () => clampSidebarWidth(Number(window.localStorage.getItem(sidebarWidthKey)) || 340),
  serverRead: () => 340,
  write(value: number) { window.localStorage.setItem(sidebarWidthKey, String(clampSidebarWidth(value))); sidebarWidthListeners.forEach((listener) => listener()); },
};

const densityKey = "weave.density";
const densityListeners = new Set<() => void>();
const densityStore = {
  subscribe(listener: () => void) { densityListeners.add(listener); return () => { densityListeners.delete(listener); }; },
  read: (): Density => window.localStorage.getItem(densityKey) === "compact" ? "compact" : "comfortable",
  serverRead: (): Density => "comfortable",
  write(value: Density) { window.localStorage.setItem(densityKey, value); densityListeners.forEach((listener) => listener()); },
};

type AgentModel = { model: string; effort: string };
const agentModelKeys = { model: "weave.agent.model", effort: "weave.agent.effort" };
const agentModelListeners = new Set<() => void>();
let agentModelSnapshot: AgentModel = { model: "", effort: "medium" };
const serverAgentModel: AgentModel = { model: "", effort: "medium" };
let agentModelRead = false;
const agentModelStore = {
  subscribe(listener: () => void) { agentModelListeners.add(listener); return () => { agentModelListeners.delete(listener); }; },
  read: (): AgentModel => {
    if (!agentModelRead) {
      agentModelSnapshot = { model: window.localStorage.getItem(agentModelKeys.model) ?? "", effort: window.localStorage.getItem(agentModelKeys.effort) ?? "medium" };
      agentModelRead = true;
    }
    return agentModelSnapshot;
  },
  serverRead: (): AgentModel => serverAgentModel,
  write(value: AgentModel) { agentModelSnapshot = value; agentModelRead = true; window.localStorage.setItem(agentModelKeys.model, value.model); window.localStorage.setItem(agentModelKeys.effort, value.effort); agentModelListeners.forEach((listener) => listener()); },
};

const createMessageId = () => `weave-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const formatBytes = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const retryDelay = (attempt: number) => Math.min(10_000, 400 * (2 ** Math.min(attempt, 5))) + Math.random() * 250;
const displayThreadName = (name: string | null | undefined) => name?.replace(/^Weave · /, "") || null;
const cssEscape = (value: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/[^\w-]/g, "\\$&"));

/* Curated block registry: each entry is just an HTML fragment stamped into the slide.
   Adding a kind is data, not code — the natural shape once HTML is the truth. */
const blockTemplates: Record<string, (id: string) => string> = {
  heading: (id) => `<h1 class="heading font-semibold leading-none tracking-tight" data-weave-id="${id}">内容が伝わる、明快な見出し</h1>`,
  paragraph: (id) => `<p class="paragraph max-w-3xl leading-normal" data-weave-id="${id}">アイデアを理解するために役立つ補足を入力してください。</p>`,
  eyebrow: (id) => `<div class="eyebrow text-sm font-bold uppercase tracking-widest text-amber-400" data-weave-id="${id}">新しいセクション</div>`,
  note: (id) => `<div class="note mt-6 text-xs font-semibold uppercase tracking-widest text-slate-400" data-weave-id="${id}">出典 · 社内調査</div>`,
  metrics: (id) => `<div class="metrics grid grid-cols-4 items-center gap-x-5 mt-2" data-weave-id="${id}"><strong class="text-3xl font-semibold tracking-tight text-amber-400">24%</strong><span class="text-xs text-slate-400">成長率</span><strong class="text-3xl font-semibold tracking-tight text-amber-400">8週</strong><span class="text-xs text-slate-400">公開まで</span></div>`,
  row: (id) => `<div class="weave-container row flex flex-row gap-4" data-weave-id="${id}"></div>`,
  column: (id) => `<div class="weave-container column flex flex-col gap-4" data-weave-id="${id}"></div>`,
  grid: (id) => `<div class="weave-container grid grid-cols-2 gap-4" data-weave-id="${id}"></div>`,
  image: (id) => `<img class="image w-full object-cover object-center aspect-video rounded-lg" src="" alt="" data-weave-id="${id}">`,
  list: (id) => `<ul class="list list-disc pl-6 text-lg leading-normal text-slate-300" data-weave-id="${id}"><li>1つ目の要点</li><li>2つ目の要点</li><li>3つ目の要点</li></ul>`,
  table: (id) => `<table class="table w-full border-collapse text-sm" data-weave-id="${id}"><thead><tr><th class="p-2 border-b border-slate-300 text-left">項目</th><th class="p-2 border-b border-slate-300 text-left">項目</th></tr></thead><tbody><tr><td class="p-2 border-b border-slate-700">値</td><td class="p-2 border-b border-slate-700">値</td></tr><tr><td class="p-2 border-b border-slate-700">値</td><td class="p-2 border-b border-slate-700">値</td></tr></tbody></table>`,
};
const blockKinds = Object.keys(blockTemplates);
const blockIcons: Record<string, string> = { eyebrow: "T", heading: "H", paragraph: "¶", metrics: "▦", note: "≡", row: "↔", column: "↕", grid: "▦", image: "▧", list: "•", table: "▤" };
const blockLabels: Record<string, string> = { eyebrow: "小見出し", heading: "見出し", paragraph: "本文", metrics: "指標", note: "注記", row: "横並び", column: "縦並び", grid: "グリッド", image: "画像", list: "リスト", table: "表" };
const containerClasses = new Set(["row", "column", "grid"]);

/* Which axis a parent lays its children out on — the context every sizing decision resolves against. */
const layoutOf = (node: Element | null): string => !node ? "column" : node.classList.contains("grid") ? "grid" : node.classList.contains("flex-row") ? "row" : "column";
const writeClasses = (node: Element, classes: string[]) => { node.setAttribute("class", classes.join(" ")); };
const sizeOf = (node: Element): string => readSize([...node.classList], layoutOf(node.parentElement), [...(node.parentElement?.classList ?? [])]);
const applySizeTo = (node: Element, intent: string) => writeClasses(node, applySize([...node.classList], intent, layoutOf(node.parentElement)));
/* Only a move that crosses into a different axis needs new classes — reordering within one parent
   leaves the markup alone, so dragging never churns the saved HTML. */
const relayoutForParent = (node: Element, intent: string, fromLayout: string): string => {
  const layout = layoutOf(node.parentElement);
  if (layout !== fromLayout) applySizeTo(node, intent);
  return layout;
};

type Control = { key: string; label: string; options: Array<{ label: string; className: string }> };
const controlGroups = slideControlGroups as Record<string, { label: string; options: Array<{ label: string; className: string }> }>;
const controlLabels: Record<string, string> = { Size: "文字サイズ", Weight: "太さ", Leading: "行間", Align: "文字揃え", Measure: "最大幅", Color: "文字色", Gap: "間隔", Padding: "内側余白", Justify: "横方向", "Align items": "縦方向", Marker: "マーカー", Fit: "表示方法", Aspect: "縦横比", Background: "背景", Border: "枠線", "Border color": "枠線色", Radius: "角丸", Shadow: "影", "Space above": "上の余白" };
const optionLabels: Record<string, string> = { Inherit: "継承", Normal: "標準", Medium: "中", Semibold: "やや太い", Bold: "太字", Extrabold: "極太", None: "なし", Tight: "狭い", Snug: "やや狭い", Relaxed: "やや広い", Loose: "広い", Full: "最大", Amber: "アンバー", Teal: "ティール", Violet: "バイオレット", Rose: "ローズ", Emerald: "エメラルド", Start: "先頭", Center: "中央", Between: "両端", End: "末尾", Stretch: "伸ばす", Bullet: "箇条書き", Number: "番号", Cover: "切り抜く", Contain: "全体表示", Auto: "自動", White: "白", Transparent: "透明", All: "四辺", Top: "上", Bottom: "下", Large: "大" };
const controlsFor = (keys: string[]): Control[] => keys.map((key) => ({ key, label: controlLabels[controlGroups[key].label] ?? controlGroups[key].label, options: controlGroups[key].options.map((option) => ({ ...option, label: optionLabels[option.label] ?? option.label })) }));
const textSchema = controlsFor(textControlKeys);
const containerSchema = controlsFor(containerControlKeys);
const advancedSchema = controlsFor(advancedControlKeys);
const listSchema = controlsFor(listControlKeys);
const imageSchema = controlsFor(imageControlKeys);
const decorationSchema = controlsFor(decorationControlKeys);
const marginSchema = controlsFor(["marginTop"]);

type SelState = { id: string; kind: string; container: boolean; read: Record<string, string> };

const blankSlideHtml = (title = "A clear, compelling headline.") =>
  `<main class="weave-slide" data-weave-slide>
    <section class="hero" data-weave-slot="content">
      ${blockTemplates.eyebrow(`eyebrow-${createMessageId().slice(6)}`)}
      <h1 class="heading" data-weave-slot="title" data-weave-id="heading-${createMessageId().slice(6)}">${escapeHtml(title)}</h1>
      ${blockTemplates.paragraph(`body-${createMessageId().slice(6)}`)}
    </section>
  </main>`;

const slideFromHtml = (slide: SlideDoc): SlideDoc => {
  const html = migrateSlideHtmlToTailwind(slide.html);
  return { ...slide, title: titleFromSlideHtml(html) ?? slide.title, html };
};
/* Slide numbering belongs to the rendered frame. Reordering therefore never mutates source HTML. */
const renumberSlides = (slides: SlideDoc[]) => slides.map((slide) => ({ ...slide }));
const initialSlides: SlideDoc[] = [slideFromHtml({ id: "opportunity", title: "", notes: "", templateId: "orbit", layoutId: "content", accent: "#f6b84b", html: blankSlideHtml("新しい機会") })];

type OutlineItem = { id: string; label: string; kind: string; depth: number; container: boolean; locked: boolean };
/* Where a tree row drop lands: beside the target, or as the last child when the target is a container. */
type TreeDrop = { id: string | null; position: "before" | "after" | "inside" };

type Snapshot = { title: string; defaultTemplateId: string; templates: TemplateDoc[]; importedTemplates: TemplateDoc[] | null; slides: SlideDoc[]; activeSlide: number; selectedId: string | null; annotations: Annotation[] };
type AgentPreviewState = {
  phase: "checking" | "editing" | "finalizing";
  changedSlideIds: string[];
  sequence: number;
};
type BlockDragSession = {
  id: string;
  node: HTMLElement;
  sizeIntent: string;
  sizeLayout: string;
  originParent: Node;
  originNext: ChildNode | null;
  before: Snapshot;
  committed: boolean;
  lastReorderAt: number;
  lastReorderX: number;
  lastReorderY: number;
};
type AnnotationGesture = {
  pointerId: number;
  startClient: { x: number; y: number };
  startPoint: { x: number; y: number };
} & (
  | { kind: "draw"; slideId: string }
  | { kind: "move"; annotationId: string; slideId: string; origin: AnnotationRect }
  | { kind: "resize"; annotationId: string; slideId: string; origin: AnnotationRect; handle: ResizeHandle }
);
type AnnotationBox = { id: string; rect: AnnotationRect; html: string; elementKind: string; textExcerpt: string };
type SentAnnotationAttachment = {
  id: string;
  threadId: string;
  turnId: string | null;
  slideId: string;
  slideLabel: string;
  annotations: Annotation[];
};

const cloneAnnotation = (annotation: Annotation): Annotation => ({
  ...annotation,
  target: annotation.target.kind === "element" ? { ...annotation.target } : { kind: "region" },
  rect: { ...annotation.rect },
  intersects: [...annotation.intersects],
});

const cloneMatches = (root: HTMLElement, selector: string): HTMLElement[] => [
  ...(root.matches(selector) ? [root] : []),
  ...Array.from(root.querySelectorAll<HTMLElement>(selector)),
];

const serializeEditorNode = (node: HTMLElement): string => {
  const clone = node.cloneNode(true) as HTMLElement;
  cloneMatches(clone, "[contenteditable], [data-editing], [draggable]").forEach((item) => {
    item.removeAttribute("contenteditable");
    item.removeAttribute("data-editing");
    item.removeAttribute("draggable");
  });
  cloneMatches(clone, ".weave-selected, .weave-dragging, .weave-drop-before, .weave-drop-after, .weave-drop-horizontal").forEach((item) => {
    item.classList.remove("weave-selected", "weave-dragging", "weave-drop-before", "weave-drop-after", "weave-drop-horizontal");
  });
  cloneMatches(clone, "img[data-asset-path]").forEach((item) => {
    const path = item.getAttribute("data-asset-path") ?? item.getAttribute("src") ?? "";
    item.setAttribute("src", path);
    item.removeAttribute("data-asset-path");
  });
  cloneMatches(clone, "image[data-asset-path]").forEach((item) => {
    const path = item.getAttribute("data-asset-path") ?? "";
    if (item.dataset.assetAttribute === "xlink:href") item.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", path);
    else item.setAttribute("href", path);
    delete item.dataset.assetPath;
    delete item.dataset.assetAttribute;
  });
  return clone.outerHTML;
};

const sanitizePreviewHtml = (input: string): string => {
  if (typeof DOMParser === "undefined") return input;
  const document = new DOMParser().parseFromString(`<body>${input}</body>`, "text/html");
  document.body.querySelectorAll("script, iframe, object, embed, style, link, base, meta, form").forEach((node) => node.remove());
  document.body.querySelectorAll("*").forEach((node) => {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name === "style" || name === "srcdoc" || name.startsWith("on")) {
        node.removeAttribute(attribute.name);
        continue;
      }
      if (["href", "src", "action", "formaction", "poster", "xlink:href"].includes(name)) {
        const value = attribute.value.replace(/[\u0000-\u0020\u007f]+/g, "").toLowerCase();
        if (value.startsWith("javascript:") || /^(?:https?:)?\/\//.test(value)) node.removeAttribute(attribute.name);
      }
    }
  });
  return document.body.innerHTML;
};

const displayAssetHtml = (input: string): string => rewriteAssetUrls(sanitizePreviewHtml(input), apiBase);

const changedTargets = (before: SlideDoc[], after: SlideDoc[]): ChangedTarget[] => {
  if (typeof DOMParser === "undefined") return [];
  const parser = new DOMParser();
  const beforeBySlide = new Map(before.map((slide) => [slide.id, slide]));
  return after.flatMap((slide) => {
    const previous = beforeBySlide.get(slide.id);
    if (!previous) return [];
    const oldDocument = parser.parseFromString(previous.html, "text/html");
    const newDocument = parser.parseFromString(slide.html, "text/html");
    return Array.from(newDocument.querySelectorAll<HTMLElement>("[data-weave-id]"))
      .filter((node) => {
        const id = node.dataset.weaveId;
        const oldNode = id ? oldDocument.querySelector<HTMLElement>(`[data-weave-id="${CSS.escape(id)}"]`) : null;
        return !!id && oldNode?.outerHTML !== node.outerHTML;
      })
      .map((node) => ({ slideId: slide.id, elementId: node.dataset.weaveId! }));
  });
};

const changedSlideCount = (before: SlideDoc[], after: SlideDoc[]) => {
  const beforeById = new Map(before.map((slide) => [slide.id, JSON.stringify(slide)]));
  const afterIds = new Set(after.map((slide) => slide.id));
  return after.filter((slide) => beforeById.get(slide.id) !== JSON.stringify(slide)).length
    + before.filter((slide) => !afterIds.has(slide.id)).length;
};

const kindOfNode = (node: HTMLElement): string => blockKinds.find((cls) => node.classList.contains(cls)) ?? node.tagName.toLowerCase();
const refreshSlideAnnotations = (annotations: Annotation[], slideId: string, boxes: AnnotationBox[]) => {
  const refreshed = new Map<string, Annotation>(refreshAnnotations(annotations.filter((annotation) => annotation.slideId === slideId), boxes).map((annotation: Annotation): [string, Annotation] => [annotation.id, annotation]));
  return annotations.map((annotation) => refreshed.get(annotation.id) ?? annotation);
};

/* Live reordering rewrites the DOM under the cursor, so every move changes the geometry that
   decided it. Require the pointer to travel before re-deciding: without this, a container that
   reflows around the dropped block flips the answer back and the block oscillates in place. */
const REORDER_HYSTERESIS_PX = 9;
const markReorder = (session: BlockDragSession, event: { timeStamp: number; clientX: number; clientY: number }) => {
  session.lastReorderAt = event.timeStamp;
  session.lastReorderX = event.clientX;
  session.lastReorderY = event.clientY;
};

export default function Home() {
  const [deckTitle, setDeckTitle] = useState("第3四半期 戦略デッキ");
  const [slides, setSlides] = useState<SlideDoc[]>(initialSlides);
  const [templates, setTemplates] = useState<TemplateDoc[]>([]);
  const [activeSlide, setActiveSlide] = useState(1);
  const [selectedSlideIds, setSelectedSlideIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedIdState] = useState<string | null>(null);
  const [deckCss, setDeckCss] = useState<string>(defaultDeckCss);
  const [mode, setMode] = useState<"preview" | "source" | "split">("preview");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [accent, setAccent] = useState("#f6b84b");
  const [fitScale, setFitScale] = useState(0.68);
  const [manualZoom, setManualZoom] = useState<number | null>(null);
  const [injectKey, setInjectKey] = useState(0);
  const [activeVariation, setActiveVariation] = useState("main");
  const [variations, setVariations] = useState<ServerState["variations"]>([]);
  const [showVariationPrompt, setShowVariationPrompt] = useState(false);
  const [variationPreviews, setVariationPreviews] = useState<VariationPreview[] | null>(null);
  const [variationCompareLoading, setVariationCompareLoading] = useState(false);
  const [variationPrompt, setVariationPrompt] = useState("見出しを簡潔にし、重要な数値を強調した大胆な構成にしてください。");
  const [variationComparisonMode, setVariationComparisonMode] = useState<"side-by-side" | "overlay">("side-by-side");
  const [variationDiffOnly, setVariationDiffOnly] = useState(true);
  const [openPopover, setOpenPopover] = useState<OpenPopover>(null);
  const [saved, setSaved] = useState(true);
  const [promptDraft, setPromptDraft] = useState("");
  const [pointerPicking, setPointerPicking] = useState(false);
  const [pointerCandidates, setPointerCandidates] = useState<PointerCandidate[]>([]);
  const [codexState, dispatchCodex] = useReducer(codexReducer, initialCodexState);
  const slideNav = useSyncExternalStore(slideNavStore.subscribe, slideNavStore.read, slideNavStore.serverRead);
  const sidebarWidth = useSyncExternalStore(sidebarWidthStore.subscribe, sidebarWidthStore.read, sidebarWidthStore.serverRead);
  const density = useSyncExternalStore(densityStore.subscribe, densityStore.read, densityStore.serverRead);
  const [threadSearch, setThreadSearch] = useState("");
  const [showArchivedThreads, setShowArchivedThreads] = useState(false);
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const [activityView, setActivityView] = useState<ActivityView>("agent");
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [skillScope, setSkillScope] = useState<SkillScope>("project");
  const [skillSearch, setSkillSearch] = useState("");
  const [skillDialog, setSkillDialog] = useState<SkillDialog | null>(null);
  const [skillDraft, setSkillDraft] = useState<SkillDraft>({ scope: "project", name: "", description: "", body: "", frontmatter: "" });
  const [skillStatus, setSkillStatus] = useState<SkillStatus>({ state: "idle", message: "" });
  const [skillBusyKey, setSkillBusyKey] = useState<string | null>(null);
  const agentModel = useSyncExternalStore(agentModelStore.subscribe, agentModelStore.read, agentModelStore.serverRead);
  const selectedModel = agentModel.model;
  const reasoningEffort = agentModel.effort;
  const [approvalPolicy, setApprovalPolicy] = useState("never");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [mcpResult, setMcpResult] = useState("");
  const [turnSubmission, setTurnSubmission] = useState<TurnSubmissionState>(IDLE_TURN_SUBMISSION);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draggedSlide, setDraggedSlide] = useState<number | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [project, setProject] = useState<ServerState["project"] | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [projectEventDiagnostics, setProjectEventDiagnostics] = useState<Array<{ code?: string; message?: string; severity?: string; source?: string }>>([]);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryView, setGalleryView] = useState<"list" | "new">("list");
  const [galleryProjects, setGalleryProjects] = useState<ProjectSummary[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [galleryNow, setGalleryNow] = useState(0);
  const [gallerySwitching, setGallerySwitching] = useState<string | null>(null);
  const [galleryMenu, setGalleryMenu] = useState<string | null>(null);
  const [galleryDialog, setGalleryDialog] = useState<GalleryDialog | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [newProjectTemplate, setNewProjectTemplate] = useState("orbit");
  const [newProjectCreating, setNewProjectCreating] = useState(false);
  const [showPresenter, setShowPresenter] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [mobileView, setMobileView] = useState<MobileView>("canvas");
  const [inspectorView, setInspectorView] = useState<InspectorView>("layers");
  const [objectTreeOpen, setObjectTreeOpen] = useState(true);
  const [canvasFocused, setCanvasFocused] = useState(false);
  const [announcement, setAnnouncement] = useState("エディターの準備ができました");
  const [saveMessage, setSaveMessage] = useState("");
  const [defaultTemplateId, setDefaultTemplateId] = useState("");
  const [importedTemplates, setImportedTemplates] = useState<TemplateDoc[] | null>(null);
  const [presentSlide, setPresentSlide] = useState(1);
  const [serverRevision, setServerRevision] = useState("");
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [historyState, setHistoryState] = useState({ undo: 0, redo: 0 });
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [treeDragId, setTreeDragId] = useState<string | null>(null);
  const [treeDrop, setTreeDrop] = useState<TreeDrop | null>(null);
  const [sel, setSel] = useState<SelState | null>(null);
  const [currentTemplateId, setCurrentTemplateId] = useState("");
  // Keep raw input while focused because the derived title trims whitespace after every DOM sync.
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [annotationMode, setAnnotationMode] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [draftAnnotationRect, setDraftAnnotationRect] = useState<AnnotationRect | null>(null);
  const [focusAnnotationId, setFocusAnnotationId] = useState<string | null>(null);
  const [includeRegionAnnotations, setIncludeRegionAnnotations] = useState(true);
  const [annotationAttachments, setAnnotationAttachments] = useState<SentAnnotationAttachment[]>([]);
  const [activeOverlayAttachmentId, setActiveOverlayAttachmentId] = useState<string | null>(null);
  const [referenceAttachments, setReferenceAttachments] = useState<ReferenceAttachment[]>([]);
  const [referenceShelf, setReferenceShelf] = useState<ReferenceShelfEntry[]>([]);
  const [referenceView, setReferenceView] = useState<"shelf" | "browse">("shelf");
  const [folderBrowser, setFolderBrowser] = useState<FolderBrowser | null>(null);
  const [folderImporting, setFolderImporting] = useState(false);
  const [changedReview, setChangedReview] = useState<ChangedTarget[]>([]);
  const [structuredChanges, setStructuredChanges] = useState<any[]>([]);
  const [mergeConflicts, setMergeConflicts] = useState<MergeConflict[]>([]);
  const [revertedChangeIds, setRevertedChangeIds] = useState<Set<string>>(new Set());
  const [changedReviewIndex, setChangedReviewIndex] = useState(0);
  const [agentPreview, setAgentPreview] = useState<AgentPreviewState | null>(null);
  const [agentCompletion, setAgentCompletion] = useState<number | null>(null);
  const [previewHighlightSlideId, setPreviewHighlightSlideId] = useState<string | null>(null);
  const [changeScope, setChangeScope] = useState<ChangeScope>("current-slide");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("apply");
  const [allowSkillChanges, setAllowSkillChanges] = useState(false);
  const [draftSync, setDraftSync] = useState<DraftSyncState>("synced");
  const [agentProjectReady, setAgentProjectReady] = useState(true);
  const [sourceBuffer, setSourceBuffer] = useState("");
  const [sourceDiagnostics, setSourceDiagnostics] = useState<SourceDiagnostic[]>([]);
  const [sourceSearch, setSourceSearch] = useState("");
  const [sourceReplace, setSourceReplace] = useState("");
  const [selectionToolbarPosition, setSelectionToolbarPosition] = useState<SelectionToolbarPosition>({ left: 0, top: 0, placement: "dock" });
  const [styleClipboard, setStyleClipboard] = useState<string | null>(null);
  const [ignoredDiagnostics, setIgnoredDiagnostics] = useState<Set<string>>(new Set());
  const setSelectedId = (id: string | null) => {
    setSelectedIdState(id);
  };

  const canvasRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const annotationScrollRef = useRef<HTMLDivElement>(null);
  const presenterRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const skillInputRef = useRef<HTMLInputElement>(null);
  const skillDialogRef = useRef<HTMLFormElement>(null);
  const skillDialogTriggerRef = useRef<HTMLElement | null>(null);
  const replacingImageRef = useRef(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const sourceEditorRef = useRef<HTMLTextAreaElement>(null);
  const compositionRef = useRef(false);
  const compositionCommitRef = useRef(false);
  const pointerCaretRef = useRef(0);
  const turnInFlightRef = useRef(false);
  const shouldAutoScrollRef = useRef(true);
  const eventSequenceRef = useRef(0);
  const editGenerationRef = useRef(0);
  const browserDirtyRef = useRef(false);
  const lastDraftFingerprintRef = useRef("");
  const undoRef = useRef<Snapshot[]>([]);
  const deckLoadedRef = useRef(false);
  const redoRef = useRef<Snapshot[]>([]);
  const agentPreviewBaselineRef = useRef<SlideDoc[] | null>(null);
  const agentViewedSlideIdRef = useRef<string | null>(null);
  const slidesRef = useRef(slides);
  const deckTitleRef = useRef(deckTitle);
  const defaultTemplateIdRef = useRef(defaultTemplateId);
  const activeRef = useRef(activeSlide);
  const selectedRef = useRef(selectedId);
  const blockDragRef = useRef<BlockDragSession | null>(null);
  const annotationGestureRef = useRef<AnnotationGesture | null>(null);
  const popoverTriggerRef = useRef<HTMLButtonElement | null>(null);
  const threadMenuRef = useRef<HTMLDivElement>(null);
  const threadDialogRef = useRef<HTMLDivElement>(null);
  const galleryRef = useRef<HTMLDivElement>(null);
  const projectSwitcherRef = useRef<HTMLButtonElement>(null);
  // Preview stays outside slide state so save, sync, and undo cannot observe a candidate frame.
  const templatePreviewHtmlRef = useRef<string | null>(null);
  const templatePreviewSourceHtmlRef = useRef<string | null>(null);
  const markDirty = () => { editGenerationRef.current += 1; browserDirtyRef.current = true; setSaved(false); setDraftSync("saving"); };

  const agentReady = codexState.connection.status === "connected" && agentProjectReady;
  const agentRunning = selectThreadRunning(codexState, codexState.activeThreadId);
  const activeTurns = selectThreadTurns(codexState, codexState.activeThreadId);
  const visibleTurns = activeTurns.slice(-100);
  const pendingServerRequests = Object.values(codexState.pendingRequests);
  const pendingRequestGroups = partitionPendingRequests(pendingServerRequests, codexState.activeThreadId);
  const activePendingServerRequests = pendingRequestGroups.active;
  const blockingPendingRequests = [...pendingRequestGroups.active, ...pendingRequestGroups.unscoped];
  const turnPresentation = deriveTurnPresentation(turnSubmission, codexState.activeThreadId, agentRunning);
  const turnBusy = turnSubmission.phase !== "idle" || codexState.activeTurnId !== null;
  const canSubmitAgentMessage = !turnInFlightRef.current || agentRunning;
  const slideScale = manualZoom ?? fitScale;
  const zoomMode = manualZoom === null ? "fit" : "manual";
  const activeSlideId = slides[activeSlide - 1]?.id;
  const liveChangedSlideIds = new Set(agentPreview?.changedSlideIds ?? []);
  const activeAnnotations = annotations.filter((annotation) => annotation.slideId === activeSlideId);
  const activeRegionAnnotations = activeAnnotations.filter((annotation) => annotation.target.kind === "region");
  const activeElementAnnotations = activeAnnotations.filter((annotation) => annotation.target.kind === "element");
  const referencedRegions = resolveReferences(promptDraft, activeRegionAnnotations);
  const regionsWillSend = includeRegionAnnotations || referencedRegions.length > 0;
  const sendableAnnotations = activeAnnotations.filter((annotation) => annotation.target.kind === "element" || regionsWillSend);
  const activeThreadAttachments = annotationAttachments.filter((attachment) => attachment.threadId === codexState.activeThreadId);
  const visibleTurnIds = new Set(visibleTurns.map((turn) => turn.id));
  const unmatchedAttachments = activeThreadAttachments.filter((attachment) => !attachment.turnId || !visibleTurnIds.has(attachment.turnId));
  const activeOverlayAttachment = annotationAttachments.find((attachment) => attachment.id === activeOverlayAttachmentId) ?? null;
  const activeOverlayTurnIds = activeOverlayAttachment ? codexState.threads[activeOverlayAttachment.threadId]?.turnIds ?? [] : [];
  const activeOverlayTurnIndex = activeOverlayAttachment?.turnId ? activeOverlayTurnIds.indexOf(activeOverlayAttachment.turnId) : -1;
  const activeOverlayLabel = activeOverlayAttachment
    ? `${activeOverlayTurnIndex >= 0 ? `ターン ${activeOverlayTurnIndex + 1}` : "送信済みターン"} · ${activeOverlayAttachment.slideLabel}`
    : "";
  const recalledAnnotations = activeOverlayAttachment?.slideId === activeSlideId ? activeOverlayAttachment.annotations : [];
  const loadSkills = useCallback(async () => {
    setSkillStatus({ state: "busy", message: "スキルを読み込み中…" });
    try {
      const response = await fetch(`${apiBase}/skills`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "スキルを読み込めませんでした。");
      if (!Array.isArray(result?.skills)) throw new Error("スキルの応答が不正です。");
      setSkills(result.skills);
      setSkillStatus({ state: "idle", message: "" });
    } catch (error) {
      setSkillStatus({ state: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const showActivity = (view: ActivityView) => {
    setActivityView(view);
    setLeftPanelOpen(true);
    if (view === "agent") setInspectorOpen(false);
    setMobileView(view);
    if (view === "skills") void loadSkills();
  };

  useEffect(() => { document.documentElement.style.setProperty("--weave-sidebar-width", `${sidebarWidth}px`); }, [sidebarWidth]);
  useEffect(() => {
    document.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
      const authoredTitle = button.dataset.autoHelp === "true" ? "" : button.title.trim();
      const help = button.dataset.help?.trim() || authoredTitle || button.getAttribute("aria-label")?.trim() || button.textContent?.replace(/\s+/g, " ").trim();
      if (!help) return;
      button.title = help;
      if (!authoredTitle && !button.dataset.help) button.dataset.autoHelp = "true";
    });
  });
  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let finalWidth = startWidth;
    const move = (moveEvent: PointerEvent) => {
      finalWidth = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
      document.documentElement.style.setProperty("--weave-sidebar-width", `${finalWidth}px`);
    };
    const end = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", end);
      sidebarWidthStore.write(finalWidth);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);
  };
  const adjustSidebarWidth = (delta: number) => sidebarWidthStore.write(sidebarWidth + delta);

  const setSlidesSynced = (next: SlideDoc[]) => {
    const numbered = renumberSlides(next);
    slidesRef.current = numbered;
    setSlides(numbered);
  };
  const setActiveSlideSynced = (next: number) => { templatePreviewHtmlRef.current = null; templatePreviewSourceHtmlRef.current = null; setTitleDraft(null); setPointerPicking(false); setActiveSlide(next); };
  const reinject = useCallback(() => setInjectKey((value) => value + 1), []);
  const cancelTemplatePreview = useCallback(() => {
    if (templatePreviewHtmlRef.current == null && templatePreviewSourceHtmlRef.current == null) return;
    templatePreviewHtmlRef.current = null;
    reinject();
  }, [reinject]);
  const dismissPopover = useCallback((restoreFocus = true) => {
    cancelTemplatePreview();
    setOpenPopover(null);
    setThreadMenuOpen(false);
    setReferenceView("shelf");
    if (restoreFocus) requestAnimationFrame(() => popoverTriggerRef.current?.focus());
  }, [cancelTemplatePreview]);
  const togglePopover = (value: Exclude<OpenPopover, null>, trigger: HTMLButtonElement) => {
    cancelTemplatePreview();
    popoverTriggerRef.current = trigger;
    setThreadMenuOpen(false);
    setOpenPopover((current) => {
      if (current === value) {
        if (value === "references") setReferenceView("shelf");
        return null;
      }
      return value;
    });
  };
  const toggleThreadMenu = (trigger: HTMLButtonElement) => {
    cancelTemplatePreview();
    popoverTriggerRef.current = trigger;
    setOpenPopover(null);
    setReferenceView("shelf");
    setThreadMenuOpen((current) => !current);
  };
  const onThreadMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const menu = event.currentTarget;
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismissPopover();
      return;
    }
    if (!items.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : currentIndex < 0
          ? event.key === "ArrowUp" ? items.length - 1 : 0
          : (currentIndex + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
    items[nextIndex]?.focus();
  };
  const onThreadDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismissPopover();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex=\"-1\"])"));
    if (focusable.length === 0) {
      event.preventDefault();
      event.currentTarget.focus();
      return;
    }
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.shiftKey
      ? currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1
      : currentIndex < 0 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1;
    if ((event.shiftKey && currentIndex <= 0) || (!event.shiftKey && (currentIndex < 0 || currentIndex === focusable.length - 1))) {
      event.preventDefault();
      focusable[nextIndex]?.focus();
    }
  };
  const slideRoot = () => canvasRef.current?.querySelector<HTMLElement>(".weave-slide") ?? null;
  const contentSlot = () => canvasRef.current?.querySelector<HTMLElement>(contentSlotSelector) ?? null;
  const isEditableSlideNode = (node: Element | null) => {
    const content = node?.closest(contentSlotSelector);
    return !!content && content !== node;
  };
  const isTitleSlot = (node: Element) => node.matches(titleSlotSelector);
  const destroysTitleSlot = (node: Element) => isTitleSlot(node) || !!node.querySelector(titleSlotSelector);
  const selectedNode = () => (selectedId ? canvasRef.current?.querySelector<HTMLElement>(`[data-weave-id="${cssEscape(selectedId)}"]`) ?? null : null);
  const copySelectedStyle = () => {
    const node = selectedNode();
    if (!node) return;
    setStyleClipboard(node.className);
    setAnnouncement("選択要素のスタイルをコピーしました");
  };
  const pasteSelectedStyle = () => {
    const node = selectedNode();
    if (!node || styleClipboard === null) return;
    checkpoint();
    node.setAttribute("class", styleClipboard);
    syncFromDom();
    markDirty();
    setAnnouncement("コピーしたスタイルを適用しました");
  };
  const resetSelectedOverrides = () => {
    const node = selectedNode();
    if (!node) return;
    const removable = new Set(allControlKeys.flatMap((key: string) => controlGroups[key]?.options.flatMap((option) => option.className.split(/\s+/).filter(Boolean)) ?? []));
    checkpoint();
    node.classList.remove(...[...removable]);
    syncFromDom();
    markDirty();
    setAnnouncement("個別指定を解除し、テーマと親の設定へ戻しました");
  };

  /* A slide file contains only editable slot content. Everything users see in the canvas is
     derived from its Template master + selected Layout, including frame furniture and numbering. */
  const layoutFor = useCallback((slide: SlideDoc, templateOverride?: TemplateDoc, layoutOverride?: TemplateLayout) => {
    const template = templateOverride ?? templates.find((item) => item.id === slide.templateId);
    if (!template) throw new Error(`テンプレートが見つかりません: ${slide.templateId}`);
    const layout = layoutOverride ?? template.layouts.find((item) => item.id === slide.layoutId);
    if (!layout) throw new Error(`レイアウトが見つかりません: ${slide.templateId}/${slide.layoutId}`);
    return { template, layout };
  }, [templates]);
  const composeFor = useCallback((slide: SlideDoc, position: number, total: number, templateOverride?: TemplateDoc, layoutOverride?: TemplateLayout) => {
    const { template, layout } = layoutFor(slide, templateOverride, layoutOverride);
    return composeSlideHtml({
      slideHtml: slide.html,
      masterHtml: template.masterHtml,
      layoutHtml: layout.html,
      templateId: template.id,
      layoutId: layout.id,
      position,
      total,
      accent: slide.accent,
      instanceId: slide.id,
    });
  }, [layoutFor]);
  const composedSlides = useCallback((source: SlideDoc[]) => source.map((slide, index) => composeFor(slide, index + 1, source.length)), [composeFor]);

  const readSelection = (node: HTMLElement): SelState => {
    const kind = kindOfNode(node);
    const read: Record<string, string> = {};
    for (const key of allControlKeys) {
      read[key] = readUtilityClass([...node.classList], key);
    }
    read.direction = node.classList.contains("grid") ? "grid" : node.classList.contains("column") ? "column" : "row";
    read.columns = ["grid-cols-2", "grid-cols-3", "grid-cols-4"].find((name) => node.classList.contains(name)) ?? "grid-cols-2";
    read.span = ["col-span-2", "col-span-3", "row-span-2"].find((name) => node.classList.contains(name)) ?? "";
    read.ratio = ratioOptions.find((item: { value: string }) => node.classList.contains(item.value))?.value ?? "basis-1/2";
    read.alt = node.getAttribute("alt") ?? "";
    read.parentLayout = layoutOf(node.parentElement);
    read.size = sizeOf(node);
    read.blockPosition = readBlockPosition([...node.classList]);
    return { id: node.getAttribute("data-weave-id") ?? "", kind, container: node.classList.contains("weave-container"), read };
  };

  /* Serialize the live slide DOM back to an HTML string, stripping only the editor's transient
     chrome. data-weave-id stays — it is the slide's stable identity, cleaned off only at export. */
  const serializeCanvas = (): string | null => {
    const root = slideRoot();
    if (!root) return null;
    return serializeEditorNode(root);
  };

  const captureActive = (list: SlideDoc[] = slidesRef.current): SlideDoc[] => {
    if (templatePreviewHtmlRef.current != null) {
      const html = templatePreviewSourceHtmlRef.current;
      if (html == null) return list;
      const title = titleFromSlideHtml(html);
      const current = list[activeRef.current - 1];
      if (!current) return list;
      const source = extractSlideSourceHtml(html, { templateId: current.templateId, layoutId: current.layoutId, accent: current.accent });
      return list.map((slide, index) => index === activeRef.current - 1 ? { ...slide, title: title ?? slide.title, html: source } : slide);
    }
    const html = serializeCanvas();
    if (html == null) return list;
    templatePreviewSourceHtmlRef.current = null;
    const current = list[activeRef.current - 1];
    if (!current) return list;
    const source = extractSlideSourceHtml(html, { templateId: current.templateId, layoutId: current.layoutId, accent: current.accent });
    const title = titleFromSlideHtml(source);
    return list.map((slide, index) => (index === activeRef.current - 1 ? { ...slide, title: title ?? slide.title, html: source } : slide));
  };

  const syncFromDom = () => {
    setSlidesSynced(captureActive());
    markDirty();
    requestAnimationFrame(() => {
      const slide = slidesRef.current[activeRef.current - 1];
      if (slide && viewportRef.current) setAnnotations((current) => refreshSlideAnnotations(current, slide.id, liveAnnotationBoxes()));
    });
  };

  const snapshot = (): Snapshot => ({ title: deckTitle, defaultTemplateId, templates, importedTemplates, slides: captureActive().map((slide) => ({ ...slide })), activeSlide: activeRef.current, selectedId: selectedRef.current, annotations: annotations.map(cloneAnnotation) });
  const restoreSnapshot = (value: Snapshot) => {
    setDeckTitle(value.title);
    setDefaultTemplateId(value.defaultTemplateId);
    setTemplates(value.templates);
    setImportedTemplates(value.importedTemplates);
    setSlidesSynced(value.slides.map((slide) => ({ ...slide })));
    activeRef.current = value.activeSlide;
    setActiveSlideSynced(value.activeSlide);
    selectedRef.current = value.selectedId;
    setSelectedId(value.selectedId);
    setAnnotations(value.annotations.map(cloneAnnotation));
    markDirty();
    reinject();
  };
  const checkpoint = () => { undoRef.current = [...undoRef.current.slice(-79), snapshot()]; redoRef.current = []; setHistoryState({ undo: undoRef.current.length, redo: 0 }); };
  const undo = () => { const value = undoRef.current.pop(); if (!value) return; redoRef.current.push(snapshot()); restoreSnapshot(value); setHistoryState({ undo: undoRef.current.length, redo: redoRef.current.length }); setAnnouncement("変更を元に戻しました"); };
  const redo = () => { const value = redoRef.current.pop(); if (!value) return; undoRef.current.push(snapshot()); restoreSnapshot(value); setHistoryState({ undo: undoRef.current.length, redo: redoRef.current.length }); setAnnouncement("変更をやり直しました"); };

  const deckPayload = () => ({ title: deckTitle, defaultTemplateId, slides: captureActive() });

  const openSourceEditor = (nextMode: "source" | "split") => {
    const captured = captureActive();
    setSlidesSynced(captured);
    const source = captured[activeRef.current - 1]?.html;
    if (typeof source !== "string") return;
    setSourceBuffer(source);
    setSourceDiagnostics(validateEditableSlideSource(source));
    setSelectedAnnotationId(null);
    setPointerPicking(false);
    if (annotationMode) setAnnouncement("Mark for Agentを終了しました");
    setAnnotationMode(false);
    setMode(nextMode);
  };

  const applySourceBuffer = () => {
    const problems = validateEditableSlideSource(sourceBuffer);
    setSourceDiagnostics(problems);
    if (problems.length > 0) {
      setAnnouncement("HTMLのエラーを修正してから反映してください");
      return;
    }
    checkpoint();
    const current = slidesRef.current[activeRef.current - 1];
    if (!current) return;
    const title = titleFromSlideHtml(sourceBuffer) ?? current.title;
    setSlidesSynced(slidesRef.current.map((slide, index) => index === activeRef.current - 1 ? { ...slide, title, html: sourceBuffer } : slide));
    markDirty();
    reinject();
    setAnnouncement("HTMLを検証してキャンバスへ反映しました");
  };

  const replaceSourceMatches = () => {
    if (!sourceSearch) return;
    setSourceBuffer((current) => current.split(sourceSearch).join(sourceReplace));
  };

  useEffect(() => {
    if (mode === "preview") return;
    const source = slides[activeSlide - 1]?.html;
    if (typeof source !== "string") return;
    const timer = window.setTimeout(() => {
      setSourceBuffer(source);
      setSourceDiagnostics(validateEditableSlideSource(source));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeSlide, mode, slides]);

  useEffect(() => {
    if (mode === "preview" || !selectedId) return;
    const editor = sourceEditorRef.current;
    if (!editor) return;
    const offset = sourceOffsetForElement(editor.value, selectedId);
    editor.setSelectionRange(offset, offset);
    editor.focus();
  }, [mode, selectedId]);

  useEffect(() => {
    if (!deckLoadedRef.current || !browserDirtyRef.current) return;
    const draft = { title: deckTitle, defaultTemplateId, slides };
    const fingerprint = JSON.stringify(draft);
    if (fingerprint === lastDraftFingerprintRef.current) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setDraftSync("saving");
      try {
        const response = await fetch(`${apiBase}/draft`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deck: draft, expectedRevision: serverRevision, templates: importedTemplates }),
          signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "作業中ドラフトを同期できませんでした。");
        if (result.mergedAgent && result.deck) {
          setDeckTitle(result.deck.title);
          setDefaultTemplateId(result.deck.defaultTemplateId);
          setSlidesSynced(result.deck.slides.map(slideFromHtml));
          setMergeConflicts(Array.isArray(result.conflicts) ? result.conflicts : []);
          setAnnouncement(result.conflicts?.length ? "Agent完了と同時の編集に競合があります。変更レビューで選択してください" : "Agentの変更と作業中ドラフトを統合しました");
        }
        lastDraftFingerprintRef.current = fingerprint;
        if (typeof result.project?.revision === "string") setServerRevision(result.project.revision);
        setDraftSync("synced");
        setApiError(null);
      } catch (error) {
        if (controller.signal.aborted) return;
        setDraftSync(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "error");
        setApiError(error instanceof Error ? error.message : String(error));
      }
    }, 700);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [deckTitle, defaultTemplateId, importedTemplates, serverRevision, slides]);

  const contextEnvelope = (annotationContext: Annotation[] = [], overflowing: string[] = [], attachments: ReferenceAttachment[] = []) => editorEnvelope({
    slide: activeSlideId,
    modificationScope: {
      kind: changeScope,
      slideIds: changeScope === "selected-slides" ? selectedSlideIds.size > 0 ? [...selectedSlideIds] : activeSlideId ? [activeSlideId] : [] : activeSlideId ? [activeSlideId] : [],
      elementId: changeScope === "element" ? selectedId : null,
    },
    executionMode,
    allowSkillChanges,
    selected: selectedId ? {
      id: selectedId,
      kind: sel?.kind ?? "",
      text: (() => {
        const node = selectedNode();
        return node ? textExcerptOfNode(node, 200) : "";
      })(),
    } : undefined,
    annotations: annotationContext,
    overflowing,
    attachments: attachments.map(({ path, name, size, kind, files }) => ({ path, name, bytes: size, kind, files })),
  });

  const quality = useMemo(() => {
    let html = "";
    try { html = composedSlides(slides).join("\n"); } catch (error) { return { ok: false, diagnostics: [{ id: "template-reference", code: "template-reference", source: "slides", severity: "error" as const, message: error instanceof Error ? error.message : String(error), explanation: "テンプレート参照を解決できません。", fixSuggestion: "テンプレートとレイアウトの参照を確認してください。", slideId: null, elementId: null }], errors: 1, warnings: 0, suggestions: 0 }; }
    const result = auditContentPolicy({ css: deckCss, html });
    const authored: QualityDiagnostic[] = slides.flatMap((slide) => {
      const items: QualityDiagnostic[] = [];
      for (const match of slide.html.matchAll(/<img\b([^>]*)>/gi)) {
        const id = /data-weave-id=["']([^"']+)["']/i.exec(match[1])?.[1] ?? null;
        if (!/\balt=["'][^"']+["']/i.test(match[1])) items.push({ id: `${slide.id}:image-alt:${id ?? match.index}`, code: "image.alt", severity: "warning", message: "画像の代替テキストがありません", explanation: "読み上げ利用者へ画像の意味が伝わりません。", fixSuggestion: "画像の目的を短い文章で入力してください。", slideId: slide.id, elementId: id, source: "html" });
      }
      const title = titleFromSlideHtml(slide.html) ?? "";
      if (title.length > 42) items.push({ id: `${slide.id}:title-length`, code: "title.length", severity: "suggestion", message: "タイトルが長く、要点を見つけにくい可能性があります", explanation: `${title.length}文字のタイトルです。`, fixSuggestion: "主張を一つに絞り、42文字以内を目安に簡潔にします。", slideId: slide.id, elementId: /data-weave-slot=["']title["'][^>]*data-weave-id=["']([^"']+)/i.exec(slide.html)?.[1] ?? null, source: "html" });
      if (/\btext-(?:xs|\[\d+(?:\.\d+)?px\])\b/.test(slide.html)) items.push({ id: `${slide.id}:small-text`, code: "text.small", severity: "warning", message: "小さい文字が含まれています", explanation: "投影時や小さな画面で読みにくくなる可能性があります。", fixSuggestion: "本文を14px相当以上へ調整します。", slideId: slide.id, elementId: null, source: "html" });
      return items;
    });
    const policyDiagnostics: QualityDiagnostic[] = result.diagnostics.map((item: any, index: number) => ({ id: `policy:${item.code}:${index}`, code: item.code, severity: item.severity === "warning" ? "warning" : "error", message: item.message, explanation: item.message, fixSuggestion: "問題のHTMLまたはスタイルを安全な表現へ修正してください。", slideId: null, elementId: null, source: item.source }));
    const diagnostics = [...policyDiagnostics, ...authored].filter((item) => item.severity === "error" || !ignoredDiagnostics.has(item.id));
    const errors = diagnostics.filter((item) => item.severity === "error").length;
    const warnings = diagnostics.filter((item) => item.severity === "warning").length;
    const suggestions = diagnostics.filter((item) => item.severity === "suggestion").length;
    return { ok: errors === 0, diagnostics, errors, warnings, suggestions };
  }, [slides, deckCss, composedSlides, ignoredDiagnostics]);
  const qualityReport = useMemo(() => {
    const rejectedErrors = projectEventDiagnostics.filter((item) => item.severity !== "warning").length;
    const rejectedWarnings = projectEventDiagnostics.length - rejectedErrors;
    return {
      ok: quality.ok && rejectedErrors === 0,
      errors: quality.errors + rejectedErrors,
      warnings: quality.warnings + rejectedWarnings,
      suggestions: quality.suggestions,
    };
  }, [quality, projectEventDiagnostics]);

  const activeThread = codexState.activeThreadId ? codexState.threads[codexState.activeThreadId] : null;
  const activeThreadName = activeThread ? displayThreadName(activeThread.name) || activeThread.preview || "新しい制作タスク" : "タスク未選択";
  const selectedModelInfo = useMemo(() => codexState.catalog.models.find((model: any) => (model.id ?? model.model) === selectedModel) as any, [codexState.catalog.models, selectedModel]);
  /* Display-only fallback: a model that declares no supported efforts still gets the three
     standard choices in the picker, while `applyServerState` leaves such a model's effort alone. */
  const availableEfforts = useMemo(() => selectedModelInfo?.supportedReasoningEfforts?.map((option: any) => option.reasoningEffort) ?? ["low", "medium", "high"], [selectedModelInfo]);
  const connectionStatus = codexState.connection.status;
  const connectionError = codexState.connection.error;
  const agentHeaderState = (() => {
    const connectionLabels: Record<typeof connectionStatus, string> = {
      connecting: "Codexへ接続中…",
      connected: "",
      reconnecting: "Codexへ再接続中…",
      disconnected: "接続できません",
      incompatible: "互換性を確認できません",
    };
    if (connectionStatus !== "connected") {
      return {
        kind: connectionStatus,
        label: connectionError ?? connectionLabels[connectionStatus],
      };
    }
    if (activePendingServerRequests.length > 0) return { kind: "waiting", label: `確認待ち（${activePendingServerRequests.length}件）` };
    if (agentPreview?.phase === "finalizing") return { kind: "running", label: "最終確認中…" };
    if (agentPreview?.phase === "editing") {
      const count = agentPreview.changedSlideIds.length;
      return { kind: "running", label: count > 0 ? `${count}枚のスライドを編集中` : "スライドを編集中…" };
    }
    if (agentCompletion !== null) return { kind: "completed", label: `${agentCompletion}枚のスライドを更新` };
    const turnLabels: Record<Exclude<TurnPresentationState, "idle">, { kind: string; label: string }> = {
      submission: { kind: "submission", label: "依頼を確認中…" },
      accepted: { kind: "accepted", label: "依頼を確認中" },
      in_progress: { kind: "running", label: "スライドを編集中…" },
    };
    if (turnPresentation !== "idle") return turnLabels[turnPresentation];
    if (turnSubmission.phase === "submitting") return { kind: "submission", label: "別タスクへ送信中…" };
    if (turnSubmission.phase === "accepted") return { kind: "accepted", label: "別タスクで開始待ち" };
    if (codexState.activeTurnId) return { kind: "running", label: "別タスクで実行中…" };
    return null;
  })();
  const catalogSkills = useMemo(() => codexState.catalog.skills.flatMap((entry: any) => entry?.skills ?? [entry]).filter(Boolean), [codexState.catalog.skills]);
  const catalogSkillFor = (skill: SkillEntry) => {
    const pathMatch = catalogSkills.find((entry: any) => typeof entry.path === "string" && entry.path === skill.filePath);
    if (pathMatch) return pathMatch;
    const nameMatches = catalogSkills.filter((entry: any) => entry.name === skill.name && (typeof entry.path !== "string" || !entry.path.trim()));
    return nameMatches.length === 1 ? nameMatches[0] : undefined;
  };
  const visibleSkills = useMemo(() => skills.filter((skill) => skill.scope === skillScope && (!skillSearch.trim() || `${skill.name} ${skill.description}`.toLowerCase().includes(skillSearch.trim().toLowerCase()))), [skillScope, skillSearch, skills]);
  const activityLabel = activityView === "history" ? "バージョン履歴" : activityView === "shortcuts" ? "ショートカット" : activityView === "skills" ? "スキル" : activityView === "settings" ? "設定" : "Agent";

  /* `applyDeck` controls whether the on-disk deck replaces the editor buffer. Status-only polls
     (retrying while Codex connects) pass false so they never clobber unsaved edits — the local
     buffer stays authoritative until a real project change (save, history/variation, agent turn). */
  const applyServerState = useCallback((state: ServerState, applyDeck = true, preserveActiveSlide = false, preferredSlideId: string | null = null) => {
    if (applyDeck) {
      const previousSlides = slidesRef.current;
      templatePreviewHtmlRef.current = null;
      templatePreviewSourceHtmlRef.current = null;
      setDeckTitle(state.deck.title);
      setDefaultTemplateId(state.deck.defaultTemplateId);
      const sourceSlides = state.deck.slides?.length ? state.deck.slides : initialSlides;
      const nextSlides = renumberSlides(sourceSlides.map(slideFromHtml));
      setSelectedSlideIds((current) => new Set([...current].filter((id) => nextSlides.some((slide) => slide.id === id))));
      if (state.agentPreview && !agentViewedSlideIdRef.current) {
        agentViewedSlideIdRef.current = viewedSlideIdForHydration(previousSlides, nextSlides, activeRef.current, deckLoadedRef.current);
      }
      slidesRef.current = nextSlides;
      setSlides(nextSlides);
      if (preserveActiveSlide) {
        const nextActiveSlide = preservedSlideNumber(previousSlides, nextSlides, activeRef.current, preferredSlideId);
        activeRef.current = nextActiveSlide;
        setActiveSlideSynced(nextActiveSlide);
      }
      setDeckCss(defaultDeckCss);
      setTemplates(state.templates ?? []);
      setImportedTemplates(null);
      browserDirtyRef.current = false;
      setSaved(state.project.clean);
      reinject();
    }
    setHistory(state.history);
    setReferenceShelf(state.references ?? []);
    setSkills(state.skills ?? []);
    setVariations(state.variations ?? []);
    setProject(state.project);
    setServerRevision(state.project.revision ?? state.project.commit);
    setActiveVariation(state.project.branch);
    dispatchCodex({ type: "connection", connection: state.codex.connection });
    setAgentProjectReady(state.codex.projectReady);
    dispatchCodex({ type: "catalog", catalog: state.codex.catalog });
    dispatchCodex({ type: "pendingRequests", requests: state.codex.pendingRequests });
    dispatchCodex({ type: "activeTurns", activeTurns: state.codex.activeTurns });
    if (state.agentPreview) {
      agentPreviewBaselineRef.current = state.agentPreview.baseline.slides.map((slide) => ({ ...slide }));
      setAgentPreview({
        phase: state.agentPreview.phase,
        changedSlideIds: [...state.agentPreview.changedSlideIds],
        sequence: state.agentPreview.previewSequence,
      });
    } else if (Object.keys(state.codex.activeTurns).length === 0) {
      agentPreviewBaselineRef.current = null;
      agentViewedSlideIdRef.current = null;
      setAgentPreview(null);
      setPreviewHighlightSlideId(null);
    }
    const models = state.codex.catalog.models ?? [];
    const firstModel = models[0] as any;
    const current = agentModelStore.read();
    const selected = models.find((model: any) => (model.id ?? model.model) === current.model) as any;
    const nextModel = selected ? current.model : firstModel?.id ?? firstModel?.model ?? "";
    const selectedModelForEffort = selected ?? firstModel;
    const supported = selectedModelForEffort?.supportedReasoningEfforts?.map((option: any) => option.reasoningEffort) ?? [];
    const nextEffort = supported.length > 0 && !supported.includes(current.effort) ? selectedModelForEffort.defaultReasoningEffort ?? supported[0] : current.effort;
    if (nextModel !== current.model || nextEffort !== current.effort) agentModelStore.write({ model: nextModel, effort: nextEffort });
  }, [reinject]);

  useEffect(() => {
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const loadState = async () => {
      try {
        const response = await fetch(`${apiBase}/state`);
        if (!response.ok) throw new Error("ローカルAPIを利用できません。");
        const state = (await response.json()) as ServerState;
        if (canceled) return;
        /* Load the deck once; later readiness retries only refresh Codex status so they
           cannot overwrite unsaved edits made while Codex is still connecting. */
        applyServerState(state, !deckLoadedRef.current);
        deckLoadedRef.current = true;
        if (!state.codex.ready) { attempts += 1; timer = setTimeout(() => void loadState(), retryDelay(attempts)); }
      } catch (error) {
        if (canceled) return;
        dispatchCodex({ type: "connection", connection: { status: "disconnected", error: "ローカルAPIはオフラインです" } });
        setApiError(error instanceof Error ? error.message : String(error));
        attempts += 1;
        timer = setTimeout(() => void loadState(), retryDelay(attempts));
      }
    };
    void loadState();
    return () => { canceled = true; if (timer) clearTimeout(timer); };
  }, [applyServerState, connectionEpoch]);

  useEffect(() => {
    let canceled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        const response = await fetch(`${apiBase}/codex/events?after=${eventSequenceRef.current}`);
        if (!response.ok || !response.body) throw new Error("Codexのイベント接続を利用できません。");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        while (!canceled) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const envelope = JSON.parse(line);
            const envelopeSequence = Number(envelope.sequence ?? 0);
            if (envelope.type === "weave/project" || envelope.type === "codex/gap") {
              const projectEvent = envelope.type === "weave/project" ? projectEventDecision(envelope.payload) : null;
              const generation = editGenerationRef.current;
              const stateResponse = await fetch(`${apiBase}/state`);
              if (!stateResponse.ok) throw new Error("プロジェクトの最新状態を取得できませんでした。");
              const state = await stateResponse.json();
              const unchanged = generation === editGenerationRef.current;
              const projectStatus = envelope.type === "weave/project" ? envelope.payload?.status : null;
              if (projectStatus === "updated" && envelope.payload?.deck?.slides) state.deck = envelope.payload.deck;
              if (envelope.type === "weave/project" && typeof envelope.payload?.projectRoot === "string" && envelope.payload.projectRoot !== state.project?.root) {
                eventSequenceRef.current = Math.max(eventSequenceRef.current, envelopeSequence);
                continue;
              }
              if (envelope.type === "weave/project" && !projectEventMatchesActivePreview(envelope.payload, state.agentPreview)) {
                eventSequenceRef.current = Math.max(eventSequenceRef.current, envelopeSequence);
                continue;
              }
              if (projectEvent) {
                setProjectEventDiagnostics(projectEvent.diagnostics);
                if (projectEvent.error) setApiError(projectEvent.error);
              }
              if (projectEvent && !projectEvent.refreshState) {
                agentPreviewBaselineRef.current = null;
                agentViewedSlideIdRef.current = null;
                setAgentPreview(null);
                setPreviewHighlightSlideId(null);
                eventSequenceRef.current = Math.max(eventSequenceRef.current, envelopeSequence);
                continue;
              }
              if (projectStatus === "preview" && unchanged) {
                  const changedIds = Array.isArray(envelope.payload?.changedSlideIds)
                    ? envelope.payload.changedSlideIds.filter((id: unknown): id is string => typeof id === "string")
                    : [];
                  if (!agentPreviewBaselineRef.current && state.agentPreview) {
                    agentPreviewBaselineRef.current = state.agentPreview.baseline.slides.map((slide: SlideDoc) => ({ ...slide }));
                  }
                  setAgentPreview((current) => ({
                    phase: "editing",
                    changedSlideIds: [...new Set([...(current?.changedSlideIds ?? []), ...changedIds])],
                    sequence: Number(envelope.payload?.previewSequence ?? current?.sequence ?? 0),
                  }));
                  const viewedSlideId = slidesRef.current[activeRef.current - 1]?.id;
                  if (viewedSlideId && changedIds.includes(viewedSlideId)) setPreviewHighlightSlideId(viewedSlideId);
              }
              if (projectStatus === "updated") {
                if (typeof envelope.payload?.milestone === "string" && envelope.payload.milestone) setAnnouncement(`マイルストーン「${envelope.payload.milestone}」を作成しました`);
                const eventBaseline = Array.isArray(envelope.payload?.baseline?.slides)
                  ? envelope.payload.baseline.slides as SlideDoc[]
                  : null;
                const baseline = eventBaseline ?? state.agentPreview?.baseline.slides ?? agentPreviewBaselineRef.current ?? slidesRef.current;
                const serverConflicts = Array.isArray(envelope.payload?.conflicts) ? envelope.payload.conflicts : [];
                if (!unchanged && envelope.payload?.baseline) {
                  const localMerge = mergeEditorDecks({ base: envelope.payload.baseline, agent: state.deck, current: { title: deckTitleRef.current, defaultTemplateId: defaultTemplateIdRef.current, slides: slidesRef.current } });
                  setDeckTitle(localMerge.deck.title);
                  setDefaultTemplateId(localMerge.deck.defaultTemplateId);
                  setSlidesSynced(localMerge.deck.slides.map(slideFromHtml));
                  setMergeConflicts([...serverConflicts, ...localMerge.conflicts]);
                } else setMergeConflicts(serverConflicts);
                const agentChanges = Array.isArray(envelope.payload?.changes?.changes) ? envelope.payload.changes.changes : [];
                const agentSlideIds = new Set(agentChanges.map((change: any) => change.slideId).filter(Boolean));
                const targets = changedTargets(baseline, state.deck?.slides ?? []).filter((target) => agentSlideIds.has(target.slideId));
                setChangedReview(targets);
                setStructuredChanges(agentChanges);
                setRevertedChangeIds(new Set());
                setChangedReviewIndex(0);
                setAgentCompletion(changedSlideCount(baseline, state.deck?.slides ?? []));
              }
              const preserveViewingSlide = envelope.type === "codex/gap"
                || ["preview", "updated", "error", "failed", "interrupted", "canceled"].includes(projectStatus);
              const preferredSlideId = projectStatus && projectStatus !== "preview" ? agentViewedSlideIdRef.current : null;
              applyServerState(state, unchanged, preserveViewingSlide, preferredSlideId);
              if (projectStatus && projectStatus !== "preview") {
                agentPreviewBaselineRef.current = null;
                agentViewedSlideIdRef.current = null;
                setAgentPreview(null);
                setPreviewHighlightSlideId(null);
              }
              if (!unchanged) {
                markDirty();
                setApiError("Agent完了時の編集を三者マージしました。競合がある場合は変更レビューで選択してください。");
              }
              eventSequenceRef.current = Math.max(eventSequenceRef.current, envelopeSequence);
              continue;
            }
            if (envelope.type === "codex/notification" && envelope.payload?.method === "turn/started") {
              setAgentPreview((current) => current ? { ...current, phase: "editing" } : current);
            }
            if (envelope.type === "codex/notification" && envelope.payload?.method === "turn/completed") {
              setAgentPreview((current) => current ? { ...current, phase: "finalizing" } : current);
            }
            const action = actionFromStreamEvent(envelope);
            if (action) dispatchCodex(action);
            eventSequenceRef.current = Math.max(eventSequenceRef.current, envelopeSequence);
          }
        }
      } catch (error) {
        if (!canceled) dispatchCodex({ type: "connection", connection: { status: "reconnecting", error: error instanceof Error ? error.message : String(error) } });
      }
      if (!canceled) retryTimer = setTimeout(() => void connect(), retryDelay(1));
    };
    void connect();
    return () => { canceled = true; if (retryTimer) clearTimeout(retryTimer); };
  }, [applyServerState]);

  useEffect(() => {
    if (!previewHighlightSlideId) return;
    const timer = window.setTimeout(() => setPreviewHighlightSlideId(null), 260);
    return () => window.clearTimeout(timer);
  }, [previewHighlightSlideId, agentPreview?.sequence]);

  useEffect(() => {
    if (agentCompletion === null) return;
    const timer = window.setTimeout(() => setAgentCompletion(null), 3_000);
    return () => window.clearTimeout(timer);
  }, [agentCompletion]);

  useEffect(() => {
    let canceled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const query = new URLSearchParams({ archived: String(showArchivedThreads), ...(threadSearch.trim() ? { q: threadSearch.trim() } : {}) });
          const response = await fetch(`${apiBase}/codex/threads?${query}`);
          const result = await response.json();
          if (!response.ok) throw new Error(result.error ?? "制作タスク一覧を取得できませんでした。");
          if (canceled) return;
          dispatchCodex({ type: "threadsLoaded", threads: result.data ?? [], archived: showArchivedThreads });
          if (!codexState.activeThreadId && result.data?.[0]) {
            const read = await fetch(`${apiBase}/codex/thread/read`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: result.data[0].id }) });
            if (read.ok && !canceled) { const value = await read.json(); dispatchCodex({ type: "threadLoaded", thread: value.thread, activate: true }); }
          }
        } catch (error) {
          if (!canceled) setApiError(error instanceof Error ? error.message : String(error));
        }
      })();
    }, 180);
    return () => { canceled = true; clearTimeout(timer); };
  }, [showArchivedThreads, threadSearch, agentReady, codexState.activeThreadId]);

  /* Inject the active slide's HTML as live DOM. Keyed on the slide index and an explicit
     inject counter — never on the slide's html — so ordinary edits mutate the DOM in place
     without React wiping the caret. A template preview wins here without entering slide state. */
  useLayoutEffect(() => {
    const host = canvasRef.current;
    if (!host || mode !== "preview") return;
    blockDragRef.current = null;
    setDraggedId(null);
    setEditingId(null);
    const previewHtml = templatePreviewHtmlRef.current;
    const active = slidesRef.current[activeSlide - 1];
    let rendered = previewHtml;
    if (rendered == null && active) {
      try { rendered = composeFor(active, activeSlide, slidesRef.current.length); }
      catch (error) { rendered = `<main class="weave-slide"><section data-weave-slot="content"><h1 data-weave-slot="title">${escapeHtml(error instanceof Error ? error.message : String(error))}</h1></section></main>`; }
    }
    host.innerHTML = sanitizePreviewHtml(rendered ?? "");
    host.querySelectorAll<HTMLImageElement>('img[src^="assets/"]').forEach((node) => { const path = node.getAttribute("src") ?? ""; if (!isAssetPath(path)) return; node.dataset.assetPath = path; node.src = `${apiBase}/${path}`; });
    host.querySelectorAll<SVGImageElement>("image").forEach((node) => {
      const xlinkPath = node.getAttributeNS("http://www.w3.org/1999/xlink", "href");
      const attribute = isAssetPath(xlinkPath) ? "xlink:href" : "href";
      const path = (attribute === "xlink:href" ? xlinkPath : node.getAttribute("href")) ?? "";
      if (!isAssetPath(path)) return;
      node.dataset.assetPath = path;
      node.dataset.assetAttribute = attribute;
      if (attribute === "xlink:href") node.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", `${apiBase}/${path}`);
      else node.setAttribute("href", `${apiBase}/${path}`);
    });
    host.querySelectorAll<HTMLElement>("[data-weave-id]").forEach((node) => { node.draggable = !annotationMode && isEditableSlideNode(node) && !isTitleSlot(node); });
    const root = host.querySelector<HTMLElement>(".weave-slide");
    if (root) {
      setCurrentTemplateId(active?.templateId ?? "");
      const activeAccent = accents.find((item) => item.color === active?.accent) ?? accents.find((item) => root.querySelector(`.${item.className}`));
      setAccent(activeAccent?.color ?? accents[0].color);
    }
  // composeFor is intentionally omitted: injecting on every render would reset the live DOM caret.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSlide, injectKey, mode, annotationMode]);

  /* Selection outline + inspector read-out follow the selected node without re-injecting. */
  useLayoutEffect(() => {
    const host = canvasRef.current;
    if (!host || mode !== "preview") return;
    host.querySelectorAll(".weave-selected").forEach((node) => node.classList.remove("weave-selected"));
    const node = selectedId ? host.querySelector<HTMLElement>(`[data-weave-id="${cssEscape(selectedId)}"]`) : null;
    node?.classList.add("weave-selected");
    setSel(node ? readSelection(node) : null);
    // Rebuild the object tree from the live DOM.
    const content = host.querySelector(contentSlotSelector);
    const list: OutlineItem[] = [];
    const itemFrom = (child: Element, depth: number): OutlineItem | null => {
      const id = child.getAttribute("data-weave-id");
      if (!id) return null;
      const kind = [...child.classList].find((cls) => cls !== "weave-container" && cls !== "weave-selected") ?? child.tagName.toLowerCase();
      const locked = isTitleSlot(child);
      return { id, label: locked ? "タイトル" : blockLabels[kind] ?? kind, kind, depth, container: child.classList.contains("weave-container"), locked };
    };
    if (content) {
      const walk = (element: Element, depth: number) => {
        for (const child of Array.from(element.children)) {
          const item = itemFrom(child, depth);
          if (item) {
            list.push(item);
            walk(child, depth + 1);
          }
        }
      };
      walk(content, 0);
    }
    setOutline(list);
    // `slides` is a dependency because every DOM edit flows back through it: without it the tree
    // keeps showing the pre-move order after a canvas or tree drag.
  }, [selectedId, injectKey, activeSlide, mode, slides, annotationMode]);

  useLayoutEffect(() => {
    const host = canvasRef.current;
    if (!host || mode !== "preview") return;
    host.querySelectorAll<HTMLElement>("[data-agent-changed]").forEach((node) => delete node.dataset.agentChanged);
    const active = slidesRef.current[activeRef.current - 1];
    if (!active) return;
    changedReview.filter((target) => target.slideId === active.id).forEach((target) => {
      host.querySelector<HTMLElement>(`[data-weave-id="${cssEscape(target.elementId)}"]`)?.setAttribute("data-agent-changed", "true");
    });
    const current = changedReview[changedReviewIndex];
    if (current?.slideId === active.id) setSelectedId(current.elementId);
  }, [changedReview, changedReviewIndex, activeSlide, injectKey, mode]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(([entry]) => setFitScale(Math.min(entry.contentRect.width / designWidth, entry.contentRect.height / designHeight)));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [mode]);

  useLayoutEffect(() => {
    if (!selectedId || mode !== "preview") return;
    const viewport = viewportRef.current;
    const shell = viewport?.closest<HTMLElement>(".slide-shell");
    const node = viewport?.querySelector<HTMLElement>(`[data-weave-id="${cssEscape(selectedId)}"]`);
    if (!viewport || !shell || !node) return;
    const update = () => {
      const shellBox = shell.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      const toolbarWidth = Math.min(360, shellBox.width - 16);
      const centered = box.left - shellBox.left + box.width / 2;
      const left = Math.min(shellBox.width - toolbarWidth / 2 - 8, Math.max(toolbarWidth / 2 + 8, centered));
      const above = box.top - shellBox.top - 44;
      const below = box.bottom - shellBox.top + 8;
      if (above >= 8) setSelectionToolbarPosition({ left, top: above, placement: "above" });
      else if (below <= shellBox.height - 44) setSelectionToolbarPosition({ left, top: below, placement: "below" });
      else setSelectionToolbarPosition({ left: shellBox.width / 2, top: shellBox.height - 44, placement: "dock" });
    };
    update();
    viewport.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    observer.observe(node);
    return () => { viewport.removeEventListener("scroll", update); observer.disconnect(); };
  }, [activeSlide, injectKey, mode, selectedId, slideScale]);

  useLayoutEffect(() => {
    const host = canvasRef.current;
    const slide = slidesRef.current[activeRef.current - 1];
    if (!host || !slide || mode !== "preview") return;
    host.querySelectorAll<HTMLElement>("[data-quality-severity]").forEach((node) => { delete node.dataset.qualitySeverity; delete node.dataset.qualityLabel; });
    quality.diagnostics.filter((item) => item.slideId === slide.id && item.elementId).forEach((item) => {
      const node = host.querySelector<HTMLElement>(`[data-weave-id="${cssEscape(String(item.elementId))}"]`);
      if (node) { node.dataset.qualitySeverity = item.severity; node.dataset.qualityLabel = item.message; }
    });
  }, [activeSlide, injectKey, mode, quality.diagnostics]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const scrollLayer = annotationScrollRef.current;
    if (!viewport || !scrollLayer) return;
    const syncScroll = () => {
      scrollLayer.style.transform = `translate(${-viewport.scrollLeft}px, ${-viewport.scrollTop}px)`;
    };
    syncScroll();
    viewport.addEventListener("scroll", syncScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", syncScroll);
  }, [mode]);

  useEffect(() => { slidesRef.current = slides; }, [slides]);
  useEffect(() => { activeRef.current = activeSlide; }, [activeSlide]);
  useEffect(() => { deckTitleRef.current = deckTitle; }, [deckTitle]);
  useEffect(() => { defaultTemplateIdRef.current = defaultTemplateId; }, [defaultTemplateId]);
  useEffect(() => { selectedRef.current = selectedId; }, [selectedId]);

  useEffect(() => {
    if (shouldAutoScrollRef.current) messagesEndRef.current?.scrollIntoView({ behavior: agentRunning ? "smooth" : "auto", block: "end" });
  }, [codexState.items, agentRunning]);

  useEffect(() => {
    const submittedTurnStatus = turnSubmission.turnId ? codexState.turns[turnSubmission.turnId]?.status : null;
    const next = resetTurnSubmission(turnSubmission, codexState.activeThreadId, agentRunning, connectionStatus, submittedTurnStatus);
    if (next === turnSubmission) return;
    window.setTimeout(() => {
      setTurnSubmission((current) => {
        if (current.phase !== turnSubmission.phase || current.threadId !== turnSubmission.threadId || current.turnId !== turnSubmission.turnId) return current;
        if (next.phase === "idle") turnInFlightRef.current = false;
        return next;
      });
    });
  }, [agentRunning, codexState.activeThreadId, codexState.turns, connectionStatus, turnSubmission]);

  useEffect(() => { if (showPresenter) presenterRef.current?.focus(); }, [showPresenter]);

  useEffect(() => {
    if (!openPopover && !threadMenuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismissPopover();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dismissPopover, openPopover, threadMenuOpen]);

  useEffect(() => {
    if (!threadMenuOpen) return;
    const firstItem = threadMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
    if (firstItem) firstItem.focus();
    else threadMenuRef.current?.focus();
  }, [threadMenuOpen]);

  useEffect(() => {
    if (openPopover !== "threads") return;
    const search = threadDialogRef.current?.querySelector<HTMLInputElement>('input[type="search"]:not(:disabled)');
    const first = search ?? threadDialogRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    if (first) first.focus();
    else threadDialogRef.current?.focus();
  }, [openPopover]);

  const skillDialogOpen = skillDialog !== null;
  useEffect(() => {
    if (!skillDialogOpen) return;
    const trigger = skillDialogTriggerRef.current;
    return () => trigger?.focus();
  }, [skillDialogOpen]);

  /* --- Live-DOM editing on the canvas -------------------------------------------------- */

  const annotationPoint = (event: { clientX: number; clientY: number }) => {
    const viewport = viewportRef.current;
    if (!viewport) return null;
    return toSlidePoint(event, viewport.getBoundingClientRect(), slideScale, { left: viewport.scrollLeft, top: viewport.scrollTop });
  };

  const liveAnnotationBoxes = (): AnnotationBox[] => {
    const viewport = viewportRef.current;
    if (!viewport) return [];
    const viewportBox = viewport.getBoundingClientRect();
    const scroll = { left: viewport.scrollLeft, top: viewport.scrollTop };
    return Array.from(viewport.querySelectorAll<HTMLElement>("[data-weave-id]")).filter(isEditableSlideNode).flatMap((node) => {
      const id = node.getAttribute("data-weave-id");
      return id ? [{
        id,
        rect: rectFromClientBox(node.getBoundingClientRect(), viewportBox, slideScale, scroll),
        html: serializeEditorNode(node),
        elementKind: kindOfNode(node),
        textExcerpt: textExcerptOfNode(node),
      }] : [];
    });
  };

  const collectTurnAnnotations = (prompt: string, boxes: AnnotationBox[] | null = viewportRef.current ? liveAnnotationBoxes() : null) => {
    const slide = slidesRef.current[activeRef.current - 1];
    const slideAnnotations = slide ? annotations.filter((annotation) => annotation.slideId === slide.id) : [];
    const refreshed = (boxes ? refreshAnnotations(slideAnnotations, boxes) : slideAnnotations.map(cloneAnnotation)) as Annotation[];
    const regionAnnotations = slideAnnotations.filter((annotation) => annotation.target.kind === "region");
    const includeRegions = includeRegionAnnotations || resolveReferences(prompt, regionAnnotations).length > 0;
    return refreshed
      .filter((annotation) => annotation.target.kind === "element" || includeRegions)
      .sort((a, b) => a.order - b.order);
  };

  /* Measured against the slide root rather than the viewport: the viewport scrolls under manual zoom,
     and the annotation rects cannot serve here because clampRect trims them to the frame. Layout reads
     stay out of the annotation and pointer frames — overflow is measured once, at send time. */
  const liveOverflowMeasurements = () => {
    const slide = slideRoot();
    if (!slide) return [];
    const slideBox = slide.getBoundingClientRect();
    return Array.from(slide.querySelectorAll<HTMLElement>("[data-weave-id]")).filter(isEditableSlideNode).flatMap((node) => {
      const id = node.getAttribute("data-weave-id");
      if (!id) return [];
      const box = node.getBoundingClientRect();
      return [{
        id,
        box: {
          left: (box.left - slideBox.left) / slideScale,
          top: (box.top - slideBox.top) / slideScale,
          right: (box.right - slideBox.left) / slideScale,
          bottom: (box.bottom - slideBox.top) / slideScale,
        },
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
      }];
    });
  };

  const livePointerCandidates = useCallback((): PointerCandidate[] => {
    const viewport = viewportRef.current;
    if (!viewport) return [];
    const viewportBox = viewport.getBoundingClientRect();
    const scroll = { left: viewport.scrollLeft, top: viewport.scrollTop };
    return Array.from(viewport.querySelectorAll<HTMLElement>("[data-weave-id]")).filter(isEditableSlideNode).flatMap((node) => {
      const id = node.getAttribute("data-weave-id");
      return id ? [{
        id,
        rect: rectFromClientBox(node.getBoundingClientRect(), viewportBox, slideScale, scroll),
        elementKind: kindOfNode(node),
        textExcerpt: textExcerptOfNode(node),
        containsCandidate: node.querySelector("[data-weave-id]") !== null,
      }] : [];
    });
  }, [slideScale]);

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => setPointerCandidates(pointerPicking ? livePointerCandidates() : []));
    return () => cancelAnimationFrame(frame);
  }, [livePointerCandidates, pointerPicking]);

  const toggleAnnotationMode = () => {
    setPointerPicking(false);
    if (!annotationMode) canvasRef.current?.querySelector<HTMLElement>('[contenteditable="true"]')?.blur();
    if (mode !== "preview") { reinject(); setMode("preview"); }
    annotationGestureRef.current = null;
    setDraftAnnotationRect(null);
    setTreeDragId(null);
    setTreeDrop(null);
    setOpenPopover(null);
    if (annotationMode) setSelectedAnnotationId(null);
    setAnnotationMode(!annotationMode);
    setAnnouncement(annotationMode ? "Mark for Agentを終了しました" : "Mark for Agentを開始しました。変更したい範囲をドラッグしてください。");
  };

  const updateAnnotationGesture = (event: { clientX: number; clientY: number }) => {
    const gesture = annotationGestureRef.current;
    const point = annotationPoint(event);
    if (!gesture || !point) return;
    if (gesture.kind === "draw") {
      setDraftAnnotationRect(rectFromPoints(gesture.startPoint, point));
      return;
    }
    setAnnotations((current) => current.map((annotation) => {
      if (annotation.id !== gesture.annotationId) return annotation;
      const rect = gesture.kind === "move"
        ? translateRect(gesture.origin, point.x - gesture.startPoint.x, point.y - gesture.startPoint.y)
        : resizeRect(gesture.origin, gesture.handle, point);
      return { ...annotation, rect };
    }));
  };

  const onAnnotationGestureStart = (event: React.PointerEvent<HTMLElement>, annotationId: string, kind: AnnotationGestureKind) => {
    if (!annotationMode || event.button !== 0) return;
    const annotation = annotations.find((item) => item.id === annotationId);
    const point = annotationPoint(event);
    if (!annotation || !point) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    annotationGestureRef.current = kind === "move"
      ? { kind, pointerId: event.pointerId, annotationId, slideId: annotation.slideId, origin: annotation.rect, startPoint: point, startClient: { x: event.clientX, y: event.clientY } }
      : { kind: "resize", handle: kind, pointerId: event.pointerId, annotationId, slideId: annotation.slideId, origin: annotation.rect, startPoint: point, startClient: { x: event.clientX, y: event.clientY } };
    setSelectedAnnotationId(annotationId);
  };

  const onAnnotationGestureMove = (event: React.PointerEvent<HTMLElement>) => {
    if (annotationGestureRef.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    updateAnnotationGesture(event);
  };

  const onAnnotationGestureEnd = (event: React.PointerEvent<HTMLElement>) => {
    const gesture = annotationGestureRef.current;
    if (!gesture || gesture.kind === "draw" || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.type !== "pointercancel") updateAnnotationGesture(event);
    const boxes = liveAnnotationBoxes();
    setAnnotations((current) => refreshSlideAnnotations(current, gesture.slideId, boxes));
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    annotationGestureRef.current = null;
  };

  const deleteAnnotation = (id: string) => {
    const annotation = annotations.find((item) => item.id === id);
    setAnnotations((current) => current.filter((annotation) => annotation.id !== id));
    setSelectedAnnotationId((current) => current === id ? null : current);
    setFocusAnnotationId((current) => current === id ? null : current);
    if (annotation) setAnnouncement(`指示 ${annotation.order} を削除しました`);
  };

  const pointElement = (slideId: string, elementId: string): { annotation: Annotation; created: boolean } | null => {
    const existing = annotations.find((annotation) => annotation.slideId === slideId && annotation.target.kind === "element" && annotation.target.weaveId === elementId);
    if (existing) {
      setSelectedAnnotationId(existing.id);
      return { annotation: existing, created: false };
    }
    const boxes = liveAnnotationBoxes();
    const elementBox = boxes.find((box) => box.id === elementId);
    if (!elementBox) return null;
    const id = createMessageId();
    const order = nextOrder(annotations.filter((annotation) => annotation.slideId === slideId));
    const created: Annotation = {
      id,
      order,
      slideId,
      target: {
        kind: "element",
        weaveId: elementId,
        html: elementBox.html,
        elementKind: elementBox.elementKind,
        textExcerpt: elementBox.textExcerpt,
      },
      rect: elementBox.rect,
      label: "",
      intersects: [],
    };
    setAnnotations((current) => refreshSlideAnnotations([...current, created], slideId, boxes));
    setSelectedAnnotationId(id);
    return { annotation: created, created: true };
  };

  const insertPromptReference = (annotation: Annotation, caret: number, afterAtSign: boolean) => {
    const inserted = insertReferenceAt(promptDraft, caret, annotation.order, { afterAtSign });
    setPromptDraft(inserted.text);
    requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(inserted.caret, inserted.caret);
    });
  };

  const referenceElement = (elementId: string, caret: number, afterAtSign: boolean) => {
    const slideId = slidesRef.current[activeRef.current - 1]?.id;
    if (!slideId) return;
    const pointed = pointElement(slideId, elementId);
    if (!pointed) return;
    insertPromptReference(pointed.annotation, caret, afterAtSign);
    setAnnouncement(pointed.created
      ? `要素への指示 ${pointed.annotation.order} を作成して参照しました`
      : `要素への指示 ${pointed.annotation.order} を再利用しました`);
  };

  const pickPointerElement = (elementId: string) => {
    if (!pointerPicking) return;
    referenceElement(elementId, pointerCaretRef.current, true);
    setPointerPicking(false);
  };

  const referenceSelectedElement = () => {
    if (!agentReady || annotationMode || pointerPicking || !selectedId) return;
    referenceElement(selectedId, promptDraft.length, false);
  };

  const restoreAnnotationAttachment = (attachment: SentAnnotationAttachment) => {
    if (!slidesRef.current.some((slide) => slide.id === attachment.slideId)) {
      setApiError("この指示を付けたスライドはもう存在しません。");
      return;
    }
    const restoredIds = attachment.annotations.map(() => createMessageId());
    setAnnotations((current) => {
      let order = nextOrder(current.filter((annotation) => annotation.slideId === attachment.slideId));
      const restored = attachment.annotations.map((annotation, index) => ({
        ...cloneAnnotation(annotation),
        id: restoredIds[index],
        order: order++,
        slideId: attachment.slideId,
      }));
      return [...current, ...restored];
    });
    if (attachment.annotations.some((annotation) => annotation.target.kind === "region")) setIncludeRegionAnnotations(true);
    setApiError(null);
    setAnnouncement("Agentへの指示を下書きに戻しました");
  };

  const onCanvasPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointerPicking) { event.preventDefault(); event.stopPropagation(); setPointerPicking(false); return; }
    if (annotationMode) {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      setSelectedAnnotationId(null);
      const point = annotationPoint(event);
      const slideId = slidesRef.current[activeRef.current - 1]?.id;
      if (!point || !slideId) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      annotationGestureRef.current = { kind: "draw", pointerId: event.pointerId, slideId, startPoint: point, startClient: { x: event.clientX, y: event.clientY } };
      setDraftAnnotationRect(rectFromPoints(point, point));
      return;
    }
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-weave-id]");
    if (!target || !canvasRef.current?.contains(target) || !isEditableSlideNode(target)) { setSelectedId(null); return; }
    if (target.getAttribute("contenteditable") === "true") return;
    setSelectedId(target.getAttribute("data-weave-id"));
  };

  const onCanvasPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = annotationGestureRef.current;
    if (gesture?.kind !== "draw" || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    updateAnnotationGesture(event);
  };

  const onCanvasPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = annotationGestureRef.current;
    if (gesture?.kind !== "draw" || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const point = annotationPoint(event);
    const canceled = event.type === "pointercancel";
    const draggedArea = Math.abs(event.clientX - gesture.startClient.x) >= 4 && Math.abs(event.clientY - gesture.startClient.y) >= 4;
    if (!canceled && point && draggedArea) {
      const rect = rectFromPoints(gesture.startPoint, point);
      const id = createMessageId();
      const boxes = liveAnnotationBoxes();
      const order = nextOrder(annotations.filter((annotation) => annotation.slideId === gesture.slideId));
      const created: Annotation = { id, order, slideId: gesture.slideId, target: { kind: "region" }, rect, label: "", intersects: [] };
      setAnnotations((current) => refreshSlideAnnotations([...current, created], gesture.slideId, boxes));
      setSelectedAnnotationId(id);
      setFocusAnnotationId(id);
      setIncludeRegionAnnotations(true);
      setAnnouncement(`範囲への指示 ${order} を作成しました`);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    annotationGestureRef.current = null;
    setDraftAnnotationRect(null);
  };

  const beginEdit = (node: HTMLElement) => {
    if (annotationMode || !isEditableSlideNode(node)) return;
    if (node instanceof HTMLImageElement || [...node.classList].some((cls) => containerClasses.has(cls))) return;
    checkpoint();
    node.draggable = false;
    node.setAttribute("contenteditable", "true");
    node.setAttribute("data-editing", "true");
    setEditingId(node.getAttribute("data-weave-id"));
    requestAnimationFrame(() => node.focus());
  };

  const onCanvasDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (annotationMode || pointerPicking) { event.preventDefault(); event.stopPropagation(); return; }
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-weave-id]");
    if (target) beginEdit(target);
  };

  const onCanvasBlurCapture = (event: React.FocusEvent<HTMLDivElement>) => {
    const node = event.target as HTMLElement;
    if (node.getAttribute?.("contenteditable") === "true") {
      node.removeAttribute("contenteditable");
      node.removeAttribute("data-editing");
      node.draggable = !annotationMode && !isTitleSlot(node);
      setEditingId(null);
      syncFromDom();
    }
  };

  const onCanvasKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (annotationMode || pointerPicking) return;
    const node = selectedNode();
    if (!node) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b" && node.getAttribute("contenteditable") === "true") {
      event.preventDefault();
      formatSelection("strong");
    } else if ((event.key === "Enter" || event.key === "F2") && node.getAttribute("contenteditable") !== "true") {
      event.preventDefault();
      beginEdit(node);
    } else if (event.key === "Escape" && node.getAttribute("contenteditable") === "true") {
      node.blur();
    }
  };

  const clearDropMarkers = () => canvasRef.current?.querySelectorAll(".weave-drop-before, .weave-drop-after, .weave-drop-horizontal").forEach((node) => node.classList.remove("weave-drop-before", "weave-drop-after", "weave-drop-horizontal"));
  const nearestContainerChild = (container: HTMLElement, dragged: HTMLElement, clientX: number, clientY: number) => {
    const children = Array.from(container.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child !== dragged && child.hasAttribute("data-weave-id"));
    const horizontal = container.classList.contains("flex-row");
    const grid = container.classList.contains("grid");
    return children.reduce<HTMLElement | null>((nearest, child) => {
      if (!nearest) return child;
      const childRect = child.getBoundingClientRect();
      const nearestRect = nearest.getBoundingClientRect();
      const childX = clientX - (childRect.left + childRect.width / 2);
      const childY = clientY - (childRect.top + childRect.height / 2);
      const nearestX = clientX - (nearestRect.left + nearestRect.width / 2);
      const nearestY = clientY - (nearestRect.top + nearestRect.height / 2);
      const childDistance = grid ? childX ** 2 + childY ** 2 : Math.abs(horizontal ? childX : childY);
      const nearestDistance = grid ? nearestX ** 2 + nearestY ** 2 : Math.abs(horizontal ? nearestX : nearestY);
      return childDistance < nearestDistance ? child : nearest;
    }, null);
  };
  const animateDomReorder = (mutate: () => void) => {
    const host = canvasRef.current;
    if (!host) return mutate();
    const nodes = Array.from(host.querySelectorAll<HTMLElement>("[data-weave-id]"));
    const before = new Map(nodes.map((node) => [node, node.getBoundingClientRect()]));
    mutate();
    const scale = Math.max(slideScale, 0.01);
    for (const node of nodes) {
      if (node.classList.contains("weave-dragging")) continue;
      const first = before.get(node);
      if (!first || !node.isConnected) continue;
      const last = node.getBoundingClientRect();
      const x = (first.left - last.left) / scale;
      const y = (first.top - last.top) / scale;
      if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) continue;
      node.animate?.([{ transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0, 0)" }], { duration: 170, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
  };

  const onCanvasDragStart = (event: DragEvent<HTMLDivElement>) => {
    if (annotationMode) { event.preventDefault(); event.stopPropagation(); return; }
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-weave-id]");
    const id = target?.getAttribute("data-weave-id");
    if (!target || !id || !isEditableSlideNode(target) || isTitleSlot(target) || target.getAttribute("contenteditable") === "true" || !target.parentNode) {
      event.preventDefault();
      return;
    }
    setSelectedId(id);
    setEditingId(null);
    setDraggedId(id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
    // A block's sizing intent survives the move; the class expressing it is rewritten whenever the
    // block lands on a parent that runs the other way.
    blockDragRef.current = { id, node: target, sizeIntent: sizeOf(target), sizeLayout: layoutOf(target.parentElement), originParent: target.parentNode, originNext: target.nextSibling, before: snapshot(), committed: false, lastReorderAt: 0, lastReorderX: event.clientX, lastReorderY: event.clientY };
    requestAnimationFrame(() => target.classList.add("weave-dragging"));
  };

  const onCanvasDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (annotationMode) { event.preventDefault(); event.stopPropagation(); return; }
    if (Array.from(event.dataTransfer.items).some((item) => item.kind === "file")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      return;
    }
    const session = blockDragRef.current;
    const host = canvasRef.current;
    if (!session || !host) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const now = event.timeStamp;
    if (now - session.lastReorderAt < 110) return;
    if (Math.hypot(event.clientX - session.lastReorderX, event.clientY - session.lastReorderY) < REORDER_HYSTERESIS_PX) return;
    host.querySelectorAll<HTMLElement>("[data-weave-id]").forEach((node) => node.getAnimations().forEach((animation) => animation.finish()));
    const hit = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    // The dragged block and its whole subtree are pointer-events: none, so a hit is never inside
    // it; the contains() guard only catches the frame before .weave-dragging lands.
    let target = hit?.closest<HTMLElement>("[data-weave-id]") ?? null;
    if (!target || !isEditableSlideNode(target) || target === session.node || session.node.contains(target)) return;
    clearDropMarkers();

    // Containers nest: a Row carrying its children can be dropped into another Row, Column or Grid.
    if (target.classList.contains("weave-container")) {
      const container = target;
      const nearestChild = nearestContainerChild(container, session.node, event.clientX, event.clientY);
      if (nearestChild) {
        target = nearestChild;
      } else {
        container.classList.add("weave-drop-after");
        if (session.node.parentNode !== container || session.node.nextSibling) {
          animateDomReorder(() => { container.appendChild(session.node); session.sizeLayout = relayoutForParent(session.node, session.sizeIntent, session.sizeLayout); });
          markReorder(session, event);
        }
        return;
      }
    }

    if (target === session.node || session.node.contains(target)) return;
    const parent = target.parentElement;
    if (!parent) return;
    const rect = target.getBoundingClientRect();
    // A grid cell can be approached from any side, so compare on the axis the pointer is
    // actually crossing: below the cell means "after", not "before the cell to its left".
    const horizontal = parent.classList.contains("grid")
      ? event.clientY >= rect.top && event.clientY <= rect.bottom
      : parent.classList.contains("flex-row");
    const siblings = Array.from(parent.children);
    const draggedIndex = siblings.indexOf(session.node);
    const targetIndex = siblings.indexOf(target);
    const pointer = horizontal ? event.clientX : event.clientY;
    const start = horizontal ? rect.left : rect.top;
    const size = horizontal ? rect.width : rect.height;
    const threshold = session.node.parentElement === parent && draggedIndex < targetIndex ? 0.7 : session.node.parentElement === parent && draggedIndex > targetIndex ? 0.3 : 0.5;
    const after = pointer > start + size * threshold;
    target.classList.add(after ? "weave-drop-after" : "weave-drop-before");
    if (horizontal) target.classList.add("weave-drop-horizontal");
    const reference = after ? target.nextSibling : target;
    if (reference === session.node || (!after && session.node.nextSibling === target) || (after && target.nextSibling === session.node)) return;
    animateDomReorder(() => { parent.insertBefore(session.node, reference); session.sizeLayout = relayoutForParent(session.node, session.sizeIntent, session.sizeLayout); });
    markReorder(session, event);
  };

  const onCanvasDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (annotationMode) { event.stopPropagation(); return; }
    const image = Array.from(event.dataTransfer.files).find((file) => file.type.startsWith("image/"));
    if (image) {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-weave-id]");
      let placement: { id: string; after: boolean } | undefined;
      if (target && isEditableSlideNode(target)) {
        const rect = target.getBoundingClientRect();
        const horizontal = target.parentElement?.classList.contains("flex-row");
        placement = { id: target.dataset.weaveId ?? "", after: horizontal ? event.clientX > rect.left + rect.width / 2 : event.clientY > rect.top + rect.height / 2 };
      }
      void uploadImage(image, placement); return;
    }
    const session = blockDragRef.current;
    if (!session) return;
    session.committed = true;
    const changed = session.node.parentNode !== session.originParent || session.node.nextSibling !== session.originNext;
    session.node.classList.remove("weave-dragging");
    clearDropMarkers();
    blockDragRef.current = null;
    setDraggedId(null);
    if (!changed) return;
    undoRef.current = [...undoRef.current.slice(-79), session.before];
    redoRef.current = [];
    setHistoryState({ undo: undoRef.current.length, redo: 0 });
    syncFromDom();
    setAnnouncement("ブロックを移動しました");
  };

  const onCanvasPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const image = Array.from(event.clipboardData.files).find((file) => file.type.startsWith("image/"));
    if (!image) return;
    event.preventDefault();
    if (annotationMode) { event.stopPropagation(); return; }
    void uploadImage(image);
  };

  const onCanvasDragEnd = () => {
    const session = blockDragRef.current;
    if (!session) return;
    if (!session.committed) animateDomReorder(() => session.originParent.insertBefore(session.node, session.originNext));
    session.node.classList.remove("weave-dragging");
    clearDropMarkers();
    blockDragRef.current = null;
    setDraggedId(null);
  };

  /* --- Reordering from the object tree ------------------------------------------------- */

  const canDropInTree = (dragId: string, targetId: string | null) => {
    const host = canvasRef.current;
    if (!host || !dragId) return false;
    const node = host.querySelector<HTMLElement>(`[data-weave-id="${cssEscape(dragId)}"]`);
    if (!node || isTitleSlot(node)) return false;
    if (targetId == null) return true;
    if (targetId === dragId) return false;
    const target = host.querySelector<HTMLElement>(`[data-weave-id="${cssEscape(targetId)}"]`);
    // A block can never be dropped inside itself, so its own subtree is not a valid target.
    return !!target && !node.contains(target);
  };

  const onTreeDragOver = (event: DragEvent<HTMLElement>, item: OutlineItem | null) => {
    if (annotationMode) return;
    if (!treeDragId || !canDropInTree(treeDragId, item?.id ?? null)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (!item) { setTreeDrop({ id: null, position: "inside" }); return; }
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / rect.height;
    // Containers keep a middle band that means "put it in me"; leaf rows split top/bottom.
    const position = item.container ? (ratio < 0.3 ? "before" : ratio > 0.7 ? "after" : "inside") : ratio < 0.5 ? "before" : "after";
    setTreeDrop((current) => (current?.id === item.id && current.position === position ? current : { id: item.id, position }));
  };

  const onTreeDrop = (event: DragEvent<HTMLElement>, item: OutlineItem | null) => {
    event.preventDefault();
    if (annotationMode) { event.stopPropagation(); return; }
    const host = canvasRef.current;
    const drop = treeDrop;
    const dragId = treeDragId;
    setTreeDragId(null);
    setTreeDrop(null);
    if (!host || !dragId || !drop || drop.id !== (item?.id ?? null)) return;
    if (!canDropInTree(dragId, drop.id)) return;
    const node = host.querySelector<HTMLElement>(`[data-weave-id="${cssEscape(dragId)}"]`);
    const target = drop.id ? host.querySelector<HTMLElement>(`[data-weave-id="${cssEscape(drop.id)}"]`) : contentSlot();
    if (!node || !target || isTitleSlot(node) || (drop.position === "inside" && isTitleSlot(target))) return;
    const parent = drop.position === "inside" ? target : target.parentElement;
    const reference = drop.position === "inside" ? null : drop.position === "after" ? target.nextSibling : target;
    if (!parent || reference === node) return;
    if (parent === node.parentNode && (reference ?? null) === node.nextSibling) return;
    checkpoint();
    const treeIntent = sizeOf(node);
    const treeLayout = layoutOf(node.parentElement);
    animateDomReorder(() => { parent.insertBefore(node, reference); relayoutForParent(node, treeIntent, treeLayout); });
    setSelectedId(dragId);
    syncFromDom();
    setAnnouncement("ブロックを移動しました");
  };

  const addBlock = (kind: string, assetPath = "", placement?: { id: string; after: boolean }) => {
    if (kind === "image" && !assetPath) { replacingImageRef.current = false; imageInputRef.current?.click(); return; }
    const host = canvasRef.current;
    const content = contentSlot();
    if (!host || !content) return;
    checkpoint();
    const id = `${kind}-${createMessageId().slice(6)}`;
    const node = selectedNode();
    const target = placement?.id ? host.querySelector<HTMLElement>(`[data-weave-id="${cssEscape(placement.id)}"]`) : null;
    const container = target?.parentElement ?? (node?.classList.contains("weave-container") ? node : content);
    if (target) target.insertAdjacentHTML(placement?.after ? "afterend" : "beforebegin", blockTemplates[kind](id));
    else container.insertAdjacentHTML("beforeend", blockTemplates[kind](id));
    const inserted = host.querySelector<HTMLElement>(`[data-weave-id="${cssEscape(id)}"]`);
    if (kind === "image" && inserted instanceof HTMLImageElement) {
      inserted.dataset.assetPath = assetPath;
      inserted.src = `${apiBase}/${assetPath}`;
    }
    inserted?.setAttribute("draggable", "true");
    // A new container starts as Fill: hugging content would make an empty one zero-width.
    if (inserted?.classList.contains("weave-container")) applySizeTo(inserted, "fill");
    setSelectedId(id);
    dismissPopover(false);
    syncFromDom();
  };

  const uploadImage = async (file: File, placement?: { id: string; after: boolean }) => {
    const targetSlideId = slidesRef.current[activeRef.current - 1]?.id;
    const replacing = replacingImageRef.current;
    const targetElementId = selectedRef.current;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("画像は10 MB以下にしてください。");
      const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
      const response = await fetch(`${apiBase}/assets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mimeType: file.type, data: dataUrl.slice(dataUrl.indexOf(",") + 1) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "画像を読み込めませんでした。");
      if (slidesRef.current[activeRef.current - 1]?.id !== targetSlideId) throw new Error("画像の読み込み中に対象スライドが切り替わりました。");
      const selected = targetElementId ? canvasRef.current?.querySelector<HTMLElement>(`[data-weave-id="${cssEscape(targetElementId)}"]`) ?? null : null;
      if (replacing && selected instanceof HTMLImageElement && selectedRef.current === targetElementId) {
        checkpoint(); selected.dataset.assetPath = result.path; selected.src = `${apiBase}/${result.path}`; syncFromDom(); setSel(readSelection(selected));
      } else if (replacing) throw new Error("画像の読み込み中に、置き換え対象の画像が変更されました。");
      else addBlock("image", result.path, placement);
      setAnnouncement("画像を読み込みました");
      setApiError(null);
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
    finally { replacingImageRef.current = false; if (imageInputRef.current) imageInputRef.current.value = ""; }
  };

  const uploadReferences = useCallback(async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      try {
        if (file.size > 25 * 1024 * 1024) throw new Error("参照資料は25 MB以下にしてください。");
        const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
        const response = await fetch(`${apiBase}/references`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: file.name, mimeType: file.type, data: dataUrl.slice(dataUrl.indexOf(",") + 1) }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "参照資料を読み込めませんでした。");
        setReferenceAttachments((current) => current.some((attachment) => attachment.path === result.path) ? current : [...current, result]);
        setReferenceShelf((current) => current.some((reference) => reference.path === result.path) ? current : [...current, { ...result, missing: false }]);
        setApiError(null);
      } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
    }
    if (referenceInputRef.current) referenceInputRef.current.value = "";
  }, []);

  const removeShelfReference = useCallback(async (path: string) => {
    try {
      const response = await fetch(`${apiBase}/references/remove`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "参照資料を削除できませんでした。");
      setReferenceShelf(result.references ?? []);
      setReferenceAttachments((current) => current.filter((attachment) => attachment.path !== path));
      setApiError(null);
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  }, []);

  const browseFolders = useCallback(async (path?: string) => {
    try {
      const response = await fetch(`${apiBase}/folders${path ? `?path=${encodeURIComponent(path)}` : ""}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "フォルダーを開けませんでした。");
      setFolderBrowser(result); setReferenceView("browse"); setApiError(null);
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  }, []);

  const importFolder = useCallback(async () => {
    if (!folderBrowser || folderImporting) return;
    setFolderImporting(true);
    try {
      const response = await fetch(`${apiBase}/references/folder`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: folderBrowser.path }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "フォルダーを読み込めませんでした。");
      setReferenceShelf((current) => [...current, { ...result, missing: false, sourceMissing: false }]);
      setReferenceView("shelf"); setApiError(null);
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
    finally { setFolderImporting(false); }
  }, [folderBrowser, folderImporting]);

  const syncFolder = useCallback(async (path: string) => {
    try {
      const response = await fetch(`${apiBase}/references/folder/sync`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error ?? "フォルダーを更新できませんでした。");
      setReferenceShelf(result.references ?? []); setApiError(null);
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  }, []);

  const deleteSelected = () => {
    const node = selectedNode();
    if (!node || !isEditableSlideNode(node) || destroysTitleSlot(node) || outline.length <= 1) return;
    checkpoint();
    node.remove();
    setSelectedId(null);
    syncFromDom();
  };

  const duplicateSelected = () => {
    const node = selectedNode();
    if (!node || !isEditableSlideNode(node) || isTitleSlot(node)) return;
    checkpoint();
    const clone = node.cloneNode(true) as HTMLElement;
    [clone, ...Array.from(clone.querySelectorAll<HTMLElement>("[data-weave-id]"))].forEach((element) => {
      element.dataset.weaveId = `block-${createMessageId().slice(6)}`;
      element.classList.remove("weave-selected");
      element.removeAttribute("data-editing");
      element.removeAttribute("contenteditable");
    });
    node.after(clone);
    setSelectedId(clone.dataset.weaveId ?? null);
    syncFromDom();
  };

  const beginEditSelected = () => {
    const node = selectedNode();
    if (node) beginEdit(node);
  };

  /* The inspector and Agent share Tailwind classes as the only style representation. */
  const applyClasses = (mutate: (node: HTMLElement) => void) => {
    const node = selectedNode();
    if (!node) return;
    checkpoint();
    mutate(node);
    syncFromDom();
    setSel(readSelection(node));
  };
  const setUtility = (key: string, className: string) => applyClasses((node) => {
    node.setAttribute("class", applyUtilityClass([...node.classList], key, className).join(" "));
  });
  /* Flipping a container's direction swaps which axis its children are sized on, so their intents
     are read under the old axis and re-expressed under the new one. */
  const setDirection = (value: string) => applyClasses((node) => {
    if (node.classList.contains("metrics")) return;
    const children = Array.from(node.children);
    const intents = children.map(sizeOf);
    node.classList.remove("row", "column", "grid", "flex", "flex-row", "flex-col", "grid-cols-2", "grid-cols-3", "grid-cols-4");
    if (value === "grid") node.classList.add("grid", "grid-cols-2");
    else node.classList.add("weave-container", value, "flex", value === "column" ? "flex-col" : "flex-row");
    children.forEach((child, index) => writeClasses(child, applySize([...child.classList], intents[index], value)));
  });
  const setSize = (intent: string) => applyClasses((node) => applySizeTo(node, intent));
  const setRatio = (className: string) => applyClasses((node) => { node.classList.remove(...ratioOptions.map((item: { value: string }) => item.value)); node.classList.add("flex-none", className); });
  const setColumns = (className: string) => applyClasses((node) => { node.classList.remove("grid-cols-2", "grid-cols-3", "grid-cols-4"); node.classList.add(className); });
  const setSpan = (className: string) => applyClasses((node) => { node.classList.remove("col-span-2", "col-span-3", "row-span-2"); if (className) node.classList.add(className); });
  const setAlt = (value: string) => applyClasses((node) => node.setAttribute("alt", value));
  const editTable = (operation: "add-row" | "remove-row" | "add-column" | "remove-column") => applyClasses((node) => {
    if (!(node instanceof HTMLTableElement)) return;
    const rows = Array.from(node.rows);
    if (operation === "add-row") { const row = node.tBodies[0]?.insertRow(); for (let i = 0; row && i < (rows[0]?.cells.length ?? 2); i += 1) { const cell = row.insertCell(); cell.className = "p-2 border-b border-slate-700"; cell.textContent = "値"; } }
    if (operation === "remove-row" && node.tBodies[0]?.rows.length) node.tBodies[0].deleteRow(-1);
    if (operation === "add-column") rows.forEach((row, index) => { const cell = index === 0 ? document.createElement("th") : document.createElement("td"); cell.className = `p-2 border-b ${index === 0 ? "border-slate-300 text-left" : "border-slate-700"}`; cell.textContent = index === 0 ? "項目" : "値"; row.appendChild(cell); });
    if (operation === "remove-column" && (rows[0]?.cells.length ?? 0) > 1) rows.forEach((row) => row.deleteCell(-1));
  });
  const formatSelection = (tag: "strong" | "span") => {
    const node = selectedNode(); const selection = window.getSelection();
    if (!node || !selection || selection.rangeCount === 0 || selection.isCollapsed || !node.contains(selection.anchorNode)) return;
    checkpoint();
    const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
    const existing = anchor?.closest(tag);
    if (existing && node.contains(existing) && (tag === "strong" || existing.classList.contains("text-amber-400"))) {
      existing.replaceWith(...Array.from(existing.childNodes));
      selection.removeAllRanges(); syncFromDom(); return;
    }
    const range = selection.getRangeAt(0); const wrapper = document.createElement(tag);
    if (tag === "span") wrapper.className = "text-amber-400";
    try { range.surroundContents(wrapper); } catch { const fragment = range.extractContents(); wrapper.appendChild(fragment); range.insertNode(wrapper); }
    selection.removeAllRanges(); const next = document.createRange(); next.selectNodeContents(wrapper); selection.addRange(next); syncFromDom();
  };
  const setBlockPosition = (className: string) => applyClasses((node) => writeClasses(node, applyBlockPosition([...node.classList], className)));

  const previewTemplate = (templateId: string, layoutId: string) => {
    const template = templates.find((item) => item.id === templateId);
    const index = activeRef.current - 1;
    templatePreviewHtmlRef.current = null;
    if (templatePreviewSourceHtmlRef.current && canvasRef.current) canvasRef.current.innerHTML = sanitizePreviewHtml(templatePreviewSourceHtmlRef.current);
    const captured = captureActive();
    const slide = captured[index];
    if (!template || !slide) return;
    templatePreviewSourceHtmlRef.current = slide.html;
    const layout = template.layouts.find((item) => item.id === layoutId);
    if (!layout) { setApiError(`レイアウトが見つかりません: ${template.id}/${layoutId}`); return; }
    templatePreviewHtmlRef.current = composeFor({ ...slide, templateId: template.id, layoutId: layout.id }, activeRef.current, captured.length, template, layout);
    reinject();
  };
  const applyTemplate = (templateId: string, layoutId: string) => {
    const template = templates.find((item) => item.id === templateId);
    const index = activeRef.current - 1;
    if (!template) return;
    templatePreviewHtmlRef.current = null;
    if (templatePreviewSourceHtmlRef.current && canvasRef.current) canvasRef.current.innerHTML = sanitizePreviewHtml(templatePreviewSourceHtmlRef.current);
    const captured = captureActive();
    templatePreviewSourceHtmlRef.current = null;
    const slide = captured[index];
    if (!slide) return;
    checkpoint();
    const selectedLayout = template.layouts.find((item) => item.id === layoutId);
    if (!selectedLayout) { setApiError(`レイアウトが見つかりません: ${template.id}/${layoutId}`); return; }
    setSlidesSynced(captured.map((item, itemIndex) => itemIndex === index ? { ...item, templateId: template.id, layoutId: selectedLayout.id } : item));
    markDirty();
    dismissPopover(false);
    reinject();
  };
  const setSlideAccent = (value: string) => {
    const root = slideRoot();
    if (!root) return;
    checkpoint();
    const next = accents.find((item) => item.color === value);
    if (!next) { setApiError(`対応していないアクセントカラーです: ${value}`); return; }
    const accentClasses = accents.map((item) => item.className);
    root.querySelectorAll<HTMLElement>(accentClasses.map((item) => `.${item}`).join(",")).forEach((node) => {
      node.classList.remove(...accentClasses);
      node.classList.add(next.className);
    });
    setAccent(value);
    const captured = captureActive();
    setSlidesSynced(captured.map((slide, index) => index === activeRef.current - 1 ? { ...slide, accent: value } : slide));
    markDirty();
  };

  /* --- Slide operations ---------------------------------------------------------------- */

  const switchSlide = (slideNumber: number) => {
    const captured = captureActive();
    if (slideNumber < 1 || slideNumber > captured.length) return;
    setSlidesSynced(captured);
    activeRef.current = slideNumber;
    setActiveSlideSynced(slideNumber);
    setSelectedId(null);
    setSelectedAnnotationId(null);
    reinject();
  };

  const toggleAttachmentOverlay = (attachment: SentAnnotationAttachment) => {
    if (activeOverlayAttachmentId === attachment.id) {
      setActiveOverlayAttachmentId(null);
      setAnnouncement("Agentへの指示を非表示にしました");
      return;
    }
    const slideIndex = slidesRef.current.findIndex((slide) => slide.id === attachment.slideId);
    if (slideIndex < 0) return;
    if (mode !== "preview") setMode("preview");
    if (activeRef.current !== slideIndex + 1) switchSlide(slideIndex + 1);
    setActiveOverlayAttachmentId(attachment.id);
    setAnnouncement("Agentへの指示を表示しました");
  };

  const setSlideTitle = (title: string) => {
    const node = slideRoot()?.querySelector<HTMLElement>(titleSlotSelector);
    if (!node) return;
    checkpoint();
    node.textContent = title;
    syncFromDom();
  };
  const setSlideNotes = (notes: string) => {
    checkpoint();
    setSlidesSynced(captureActive().map((slide, index) => (index === activeRef.current - 1 ? { ...slide, notes } : slide)));
    markDirty();
  };

  const addSlide = (templateId: string, layoutId: string) => {
    checkpoint();
    const captured = captureActive();
    const template = templates.find((item) => item.id === templateId);
    const selectedLayout = template?.layouts.find((item) => item.id === layoutId);
    if (!template || !selectedLayout) { setApiError(`テンプレートまたはレイアウトが見つかりません: ${templateId}/${layoutId}`); return; }
    const empty = '<main class="weave-slide"><section data-weave-slot="content"><h1 data-weave-slot="title" data-weave-id="title"></h1></section></main>';
    const slideId = `slide-${createMessageId().slice(6)}`;
    const html = empty.replace(/\bdata-weave-id\s*=\s*(["'])(.*?)\1/gi, (_: string, quote: string) => `data-weave-id=${quote}block-${createMessageId().slice(6)}${quote}`);
    const slide = slideFromHtml({ id: slideId, title: "", notes: "", templateId: template.id, layoutId: selectedLayout.id, accent, html });
    const next = [...captured, slide];
    setSlidesSynced(next);
    activeRef.current = next.length;
    setActiveSlideSynced(next.length);
    setSelectedId(null);
    markDirty();
    dismissPopover(false);
    reinject();
  };

  const duplicateSlide = () => {
    checkpoint();
    const captured = captureActive();
    const source = captured[activeRef.current - 1];
    const copyId = `${source.id}-${createMessageId().slice(6)}`;
    const copy: SlideDoc = { ...source, id: copyId, html: withUniqueFragmentIds(source.html, copyId) };
    const next = [...captured];
    next.splice(activeRef.current, 0, copy);
    setSlidesSynced(next);
    activeRef.current += 1;
    setActiveSlideSynced(activeRef.current);
    setSelectedId(null);
    markDirty();
    reinject();
  };

  const deleteSlide = () => {
    if (slidesRef.current.length <= 1) return;
    const deletedSlideId = slidesRef.current[activeRef.current - 1]?.id;
    checkpoint();
    const captured = captureActive().filter((_, index) => index !== activeRef.current - 1);
    const nextNumber = Math.min(activeRef.current, captured.length);
    setSlidesSynced(captured);
    activeRef.current = nextNumber;
    setActiveSlideSynced(nextNumber);
    setSelectedId(null);
    setSelectedAnnotationId(null);
    if (deletedSlideId) setAnnotations((current) => current.filter((annotation) => annotation.slideId !== deletedSlideId));
    markDirty();
    reinject();
  };

  const moveSlide = (direction: -1 | 1) => {
    const target = activeRef.current - 1 + direction;
    if (target < 0 || target >= slidesRef.current.length) return;
    checkpoint();
    const next = captureActive();
    [next[activeRef.current - 1], next[target]] = [next[target], next[activeRef.current - 1]];
    setSlidesSynced(next);
    activeRef.current = target + 1;
    setActiveSlideSynced(target + 1);
    markDirty();
    reinject();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (galleryOpen) return;
      if (pointerPicking && event.key === "Escape") { event.preventDefault(); setPointerPicking(false); setAnnouncement("要素の指定をキャンセルしました"); return; }
      if (target.matches("input, textarea, [contenteditable=true]")) return;
      if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a") { event.preventDefault(); toggleAnnotationMode(); }
      else if (annotationMode && selectedAnnotationId && (event.key === "Delete" || event.key === "Backspace")) { event.preventDefault(); deleteAnnotation(selectedAnnotationId); }
      else if (!annotationMode && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
      else if (event.key === "?") showActivity("shortcuts");
      else if (event.key === "ArrowRight" && activeSlide < slides.length) switchSlide(activeSlide + 1);
      else if (event.key === "ArrowLeft" && activeSlide > 1) switchSlide(activeSlide - 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  /* --- Persistence, export, agent ------------------------------------------------------ */

  const clearEditorHistory = () => {
    undoRef.current = [];
    redoRef.current = [];
    setHistoryState({ undo: 0, redo: 0 });
  };

  const resetProjectEditor = () => {
    activeRef.current = 1;
    setActiveSlide(1);
    setSelectedId(null);
    selectedRef.current = null;
    setSel(null);
    setAnnotations([]);
    setSelectedAnnotationId(null);
    setAnnotationAttachments([]);
    setActiveOverlayAttachmentId(null);
    clearEditorHistory();
    templatePreviewHtmlRef.current = null;
    templatePreviewSourceHtmlRef.current = null;
    setActiveVariation("main");
    dispatchCodex({ type: "activateThread", threadId: null });
    reinject();
  };

  const closeGallery = () => {
    setGalleryOpen(false);
    setGalleryView("list");
    setGalleryMenu(null);
    setGalleryDialog(null);
    requestAnimationFrame(() => projectSwitcherRef.current?.focus());
  };

  const loadGallery = async () => {
    setGalleryLoading(true);
    try {
      const response = await fetch(`${apiBase}/projects`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "プロジェクト一覧を取得できませんでした。");
      setGalleryProjects(result.projects ?? []);
      setApiError(null);
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
    finally { setGalleryLoading(false); }
  };

  const openGallery = () => {
    setGalleryOpen(true);
    setGalleryNow(Date.now());
    setGalleryView("list");
    setGalleryMenu(null);
    void loadGallery();
    requestAnimationFrame(() => galleryRef.current?.focus());
  };

  useEffect(() => {
    if (!galleryOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (galleryDialog) { setGalleryDialog(null); return; }
      if (galleryMenu) { setGalleryMenu(null); return; }
      closeGallery();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [galleryOpen, galleryDialog, galleryMenu]);

  const switchProject = async (target: ProjectSummary, interrupt = false) => {
    if (target.current) { closeGallery(); return; }
    setGallerySwitching(target.slug);
    try {
      const response = await fetch(`${apiBase}/projects/current`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: target.slug, ...(interrupt ? { interrupt: true } : {}) }) });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error ?? "プロジェクトを切り替えられませんでした。");
      }
      applyServerState(result as ServerState);
      resetProjectEditor();
      closeGallery();
      setApiError(null);
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
    finally { setGallerySwitching(null); }
  };

  const galleryMutation = async (slug: string, action: "rename" | "duplicate" | "archive", title = "") => {
    try {
      const method = action === "rename" ? "PATCH" : "POST";
      const response = await fetch(`${apiBase}/projects/${slug}${action === "rename" ? "" : `/${action}`}`, { method, headers: { "content-type": "application/json" }, body: action === "rename" ? JSON.stringify({ title }) : "{}" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "プロジェクトを更新できませんでした。");
      setGalleryProjects(result.projects ?? []);
      setGalleryDialog(null);
      setGalleryMenu(null);
      setApiError(null);
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  const createProject = async () => {
    const title = newProjectTitle.trim();
    if (!title) return;
    setNewProjectCreating(true);
    try {
      const response = await fetch(`${apiBase}/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, templateId: newProjectTemplate }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "プロジェクトを作成できませんでした。");
      applyServerState(result as ServerState);
      resetProjectEditor();
      closeGallery();
      setNewProjectTitle("");
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
    finally { setNewProjectCreating(false); }
  };

  const relativeProjectTime = (value: string | null) => {
    if (!value) return "保存日時不明";
    const days = Math.max(0, Math.floor((galleryNow - new Date(value).getTime()) / 86_400_000));
    const minutes = Math.max(0, Math.floor((galleryNow - new Date(value).getTime()) / 60_000));
    if (minutes < 1) return "たった今保存";
    if (minutes < 60) return `${minutes}分前に保存`;
    if (days === 0) return `${Math.floor(minutes / 60)}時間前に保存`;
    if (days === 1) return "昨日保存";
    if (days < 7) return `${days}日前に保存`;
    return new Date(value).toLocaleDateString("ja-JP", { year: "numeric", month: "numeric", day: "numeric" });
  };

  const thumbHtml = (html: string, css: string, title: string) => html ? <iframe className="project-live" sandbox="" title={title} loading="lazy" srcDoc={`<!doctype html><html><head><style>${css}</style><style>html,body{width:${designWidth}px;height:${designHeight}px;margin:0;overflow:hidden;background:#0d1017}body > .weave-slide{width:${designWidth}px;height:${designHeight}px}</style></head><body>${html}</body></html>`} /> : null;

  const saveProject = async () => {
    const requestedName = saveMessage.trim() || window.prompt("マイルストーン名", `${deckTitle} レビュー版`)?.trim();
    if (!requestedName) return false;
    try {
      const generation = editGenerationRef.current;
      if (draftSync !== "synced") {
        const draftResponse = await fetch(`${apiBase}/draft`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deck: deckPayload(), expectedRevision: serverRevision, templates: importedTemplates }) });
        const draftResult = await draftResponse.json();
        if (!draftResponse.ok) throw new Error(draftResult.error ?? "作業中ドラフトを同期できませんでした。");
      }
      const response = await fetch(`${apiBase}/milestones`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: requestedName, expectedRevision: serverRevision }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "マイルストーンを作成できませんでした。");
      const unchanged = generation === editGenerationRef.current;
      applyServerState(result as ServerState, unchanged);
      if (result.queued) {
        if (unchanged) browserDirtyRef.current = false;
        setSaved(false);
        setDraftSync("synced");
        setSaveMessage("");
        setAnnouncement(`マイルストーン「${requestedName}」をAgent完了後に作成します`);
        setApiError(null);
        return false;
      }
      if (unchanged) setImportedTemplates(null);
      if (unchanged) browserDirtyRef.current = false;
      setSaved(unchanged);
      setDraftSync("synced");
      setSaveMessage("");
      setAnnouncement(unchanged ? `マイルストーン「${requestedName}」を作成しました` : "マイルストーンを作成しました。以降の編集は作業中ドラフトへ同期します");
      setApiError(null);
      return unchanged;
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const exportFragments = () => {
    const captured = captureActive();
    return composedSlides(captured);
  };

  const focusDiagnostic = (diagnostic: QualityDiagnostic) => {
    if (diagnostic.slideId) {
      const index = slidesRef.current.findIndex((slide) => slide.id === diagnostic.slideId);
      if (index >= 0 && index + 1 !== activeRef.current) switchSlide(index + 1);
    }
    if (diagnostic.elementId) setSelectedId(diagnostic.elementId);
    setAnnouncement(`${diagnostic.message}の対象を表示しました`);
  };

  const askAgentToFixDiagnostic = (diagnostic: QualityDiagnostic) => {
    focusDiagnostic(diagnostic);
    setChangeScope(diagnostic.elementId ? "element" : diagnostic.slideId ? "current-slide" : "deck");
    setExecutionMode("apply");
    setPromptDraft(`${diagnostic.message}。${diagnostic.fixSuggestion}`);
    setInspectorOpen(false);
    setActivityView("agent");
    setLeftPanelOpen(true);
    requestAnimationFrame(() => promptRef.current?.focus());
  };

  const exportDeck = async () => {
    if (!quality.ok) { popoverTriggerRef.current = null; setOpenPopover("quality"); setApiError("書き出す前に品質エラーを解決してください。"); return; }
    try {
      const fragments = await embedAssetReferences(exportFragments(), apiBase);
      const html = renderDeckDocument(fragments, deckCss, deckTitle);
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${deckTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "weave-deck"}.html`;
      anchor.click();
      URL.revokeObjectURL(url);
      setAnnouncement("オフライン用プレゼンをダウンロードしました");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
  };

  const downloadBundle = () => {
    const bundle = JSON.stringify({ format: "weave-deck", version: 2, deck: deckPayload(), templates, css: deckCss }, null, 2);
    const url = URL.createObjectURL(new Blob([bundle], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${deckTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "deck"}.weave.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importBundle = async (file: File) => {
    try {
      if (file.size > 4_000_000) throw new Error("編集用データは4 MB以下にしてください。");
      const bundle = parsePortableBundle(JSON.parse(await file.text()));
      if (!window.confirm(`編集中の内容を「${bundle.deck.title}」に置き換えますか？読み込み後も元に戻せます。`)) return;
      checkpoint();
      setDeckTitle(String(bundle.deck.title));
      setDefaultTemplateId(bundle.deck.defaultTemplateId);
      setTemplates(bundle.templates);
      setImportedTemplates(bundle.templates);
      setSlidesSynced(bundle.deck.slides.map(slideFromHtml));
      setDeckCss(defaultDeckCss);
      activeRef.current = 1;
      setActiveSlideSynced(1);
      setSelectedId(null);
      markDirty();
      reinject();
      setAnnouncement("編集用データを読み込みました。保存すると確定します");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  };

  const openPresenter = () => { setSlidesSynced(captureActive()); setPresentSlide(activeSlide); setShowPresenter(true); };

  const printDeck = async () => {
    if (!quality.ok) { popoverTriggerRef.current = null; setOpenPopover("quality"); return; }
    const popup = window.open("", "_blank");
    if (!popup) { setApiError("このデッキを印刷するにはポップアップを許可してください。"); return; }
    popup.opener = null;
    try {
      const fragments = await embedAssetReferences(exportFragments(), apiBase);
      popup.document.write(renderDeckDocument(fragments, deckCss, deckTitle));
      popup.document.close();
      popup.addEventListener("load", () => popup.print(), { once: true });
    } catch (error) {
      popup.close();
      setApiError(error instanceof Error ? error.message : String(error));
    }
  };

  const restoreHistory = async (commit?: string) => {
    try {
      const endpoint = commit ? "history/checkout" : "history/main";
      const response = await fetch(`${apiBase}/${endpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(commit ? { commit } : {}) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "履歴を復元できませんでした。");
      clearEditorHistory();
      applyServerState(result as ServerState);
      setSelectedId(null);
      setApiError(null);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
  };

  const checkoutVariation = async (branch: string) => {
    try {
      const response = await fetch(`${apiBase}/variations/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ branch }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "デザイン案を切り替えられませんでした。");
      clearEditorHistory();
      applyServerState(result as ServerState);
      setSelectedId(null);
      setApiError(null);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
  };

  const openVariationCompare = async () => {
    if (variationCompareLoading || variations.length === 0) return;
    setVariationCompareLoading(true);
    try {
      const response = await fetch(`${apiBase}/variations/compare`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "デザイン案の比較を読み込めませんでした。");
      setVariationPreviews(result.previews ?? []);
      setApiError(null);
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
    finally { setVariationCompareLoading(false); }
  };

  const applyReviewChange = (change: any) => {
    const reverted = revertedChangeIds.has(change.id);
    const direction = reverted ? "redo" : "undo";
    if (!reviewChangeMatches(deckPayload(), change, direction)) {
      setApiError("この変更の後に対象が編集されたため、安全に切り替えられません。現在の編集を保持しました。");
      return;
    }
    checkpoint();
    const next = applyEditorChange(deckPayload(), change, direction);
    setDeckTitle(next.title);
    setDefaultTemplateId(next.defaultTemplateId);
    setSlidesSynced(next.slides.map(slideFromHtml));
    setRevertedChangeIds((current) => { const copy = new Set(current); if (reverted) copy.delete(change.id); else copy.add(change.id); return copy; });
    markDirty();
    reinject();
  };

  const applyReviewGroup = (target: { kind: "slide"; slideId: string } | { kind: "all" }) => {
    const selectedChanges = structuredChanges.filter((change) => target.kind === "all" || change.slideId === target.slideId);
    const currentDeck = deckPayload();
    const stale = selectedChanges.some((change) => !reviewChangeMatches(currentDeck, change, "undo"));
    if (stale) { setApiError("対象に完了後の編集があるため、一括では戻せません。変更を個別に確認してください。"); return; }
    checkpoint();
    const next = applyEditorHistory(deckPayload(), structuredChanges, "undo", target);
    setDeckTitle(next.title);
    setDefaultTemplateId(next.defaultTemplateId);
    setSlidesSynced(next.slides.map(slideFromHtml));
    const affected = structuredChanges.filter((change) => target.kind === "all" || change.slideId === target.slideId).map((change) => change.id);
    setRevertedChangeIds((current) => new Set([...current, ...affected]));
    markDirty();
    reinject();
  };

  const resolveMergeConflict = (conflict: MergeConflict, choice: "current" | "agent") => {
    if (choice === "agent") {
      checkpoint();
      const slidePath = /^deck\.slides\[([^\]]+)\](?:\.([A-Za-z0-9_-]+))?$/.exec(conflict.path);
      if (slidePath) {
        const [, slideId, field] = slidePath;
        const current = slidesRef.current;
        const next = !field
          ? conflict.agent === null
            ? current.filter((slide) => slide.id !== slideId)
            : current.map((slide) => slide.id === slideId ? slideFromHtml(conflict.agent as SlideDoc) : slide)
          : current.map((slide) => slide.id === slideId ? { ...slide, [field]: conflict.agent } as SlideDoc : slide);
        setSlidesSynced(next);
      } else if (conflict.path === "deck.title") setDeckTitle(String(conflict.agent));
      else if (conflict.path === "deck.defaultTemplateId") setDefaultTemplateId(String(conflict.agent));
      markDirty();
      reinject();
    }
    setMergeConflicts((current) => current.filter((item) => item.path !== conflict.path));
    setAnnouncement(choice === "agent" ? "競合箇所へAgentの変更を採用しました" : "競合箇所は現在の編集を保持しました");
  };

  const reviewChangedTarget = (index: number) => {
    if (changedReview.length === 0) return;
    const normalized = (index + changedReview.length) % changedReview.length;
    const target = changedReview[normalized];
    const slideIndex = slidesRef.current.findIndex((slide) => slide.id === target.slideId);
    setChangedReviewIndex(normalized);
    if (slideIndex >= 0 && slideIndex + 1 !== activeRef.current) switchSlide(slideIndex + 1);
    else setSelectedId(target.elementId);
  };

  const generateVariation = async () => {
    if (turnBusy) return;
    const prompt = variationPrompt.trim();
    const boxes = liveAnnotationBoxes();
    const variationAnnotations = collectTurnAnnotations(prompt, boxes);
    if (!canSendTurn(prompt, variationAnnotations) || turnInFlightRef.current || turnSubmission.phase !== "idle") return;
    turnInFlightRef.current = true;
    setTurnSubmission({ phase: "submitting", threadId: codexState.activeThreadId, turnId: null });
    setShowVariationPrompt(false);
    setApiError(null);
    setAgentCompletion(null);
    let accepted = false;
    const requestDeck = deckPayload();
    agentPreviewBaselineRef.current = requestDeck.slides.map((item) => ({ ...item }));
    agentViewedSlideIdRef.current = requestDeck.slides[activeRef.current - 1]?.id ?? null;
    setAgentPreview({ phase: "checking", changedSlideIds: [], sequence: 0 });
    try {
      // Variations are branch trials, so annotations stay on the canvas instead of being consumed.
      const response = await fetch(`${apiBase}/variations/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, deck: requestDeck, clientUserMessageId: createMessageId(), model: selectedModel || undefined, effort: reasoningEffort, approvalPolicy, contextEnvelope: contextEnvelope(variationAnnotations, overflowingIds(liveOverflowMeasurements())) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "デザイン案を生成できませんでした。");
      if (response.status !== 202 || typeof result.thread?.id !== "string" || typeof result.turn?.id !== "string") throw new Error("デザイン案の受付状態を確認できませんでした。");
      accepted = true;
      if (isTerminalTurnStatus(result.turn.status)) {
        turnInFlightRef.current = false;
        setTurnSubmission(IDLE_TURN_SUBMISSION);
      } else setTurnSubmission({ phase: "accepted", threadId: result.thread.id, turnId: result.turn.id });
      setActiveVariation(result.branch);
      setAllowSkillChanges(false);
      dispatchCodex({ type: "threadLoaded", thread: result.thread, activate: true });
    } catch (error) {
      if (!accepted) setTurnSubmission(IDLE_TURN_SUBMISSION);
      if (!accepted) {
        agentPreviewBaselineRef.current = null;
        agentViewedSlideIdRef.current = null;
        setAgentPreview(null);
      }
      setApiError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!accepted) turnInFlightRef.current = false;
    }
  };

  const acceptVariation = async () => {
    try {
      const response = await fetch(`${apiBase}/variations/accept`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "このデザイン案を採用できませんでした。");
      clearEditorHistory();
      applyServerState(result as ServerState);
      setApiError(null);
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  const archiveVariation = async () => {
    try {
      const response = await fetch(`${apiBase}/variations/archive`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "このデザイン案を履歴へ送れませんでした。");
      clearEditorHistory();
      applyServerState(result as ServerState);
      setApiError(null);
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  const setExplorationState = async (branch: string, state: "paused" | "ready" | "archived") => {
    const endpoint = state === "ready" ? "resume" : state === "paused" ? "pause" : "archive";
    try {
      const response = await fetch(`${apiBase}/variations/${endpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ branch }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "探索セッションを更新できませんでした。");
      setVariations((current) => current.map((variation) => variation.branch === branch ? { ...variation, state, status: state } : variation));
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  const importExplorationSlide = async (branch: string, slideId: string) => {
    try {
      const response = await fetch(`${apiBase}/variations/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ branch, slideIds: [slideId], expectedRevision: serverRevision }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "探索案のスライドを取り込めませんでした。");
      applyServerState(result as ServerState);
      markDirty();
      setVariationPreviews(null);
      setAnnouncement("探索案から現在のスライドだけを取り込みました");
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  const onPromptChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nativeEvent = event.nativeEvent as InputEvent & { keyCode?: number };
    const next = event.target.value;
    const caret = event.target.selectionStart ?? next.length;
    const isComposing = compositionRef.current || compositionCommitRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229;
    setPromptDraft(next);
    if (pointerPicking) {
      if (next[caret - 1] === "@") pointerCaretRef.current = caret;
      else {
        setPointerPicking(false);
        setAnnouncement("要素の指定をキャンセルしました");
      }
      return;
    }
    if (mode !== "preview" || annotationMode || isComposing || nativeEvent.data !== "@") return;
    pointerCaretRef.current = caret;
    setPointerPicking(true);
    setAnnouncement("参照する要素を選んでください");
  };

  const onPromptCompositionEnd = () => {
    compositionRef.current = false;
    compositionCommitRef.current = true;
    window.setTimeout(() => { compositionCommitRef.current = false; }, 0);
  };

  const onPromptKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const nativeEvent = event.nativeEvent as KeyboardEvent;
    const isComposing = compositionRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !isComposing) { event.preventDefault(); void sendMessage(); }
  };

  const clearTurnSubmission = () => {
    turnInFlightRef.current = false;
    setTurnSubmission(IDLE_TURN_SUBMISSION);
  };

  const sendMessage = async () => {
    const value = promptDraft.trim();
    const slide = slidesRef.current[activeRef.current - 1];
    const slideNumber = activeRef.current;
    const overflowing = overflowingIds(liveOverflowMeasurements());
    const boxes = viewportRef.current ? liveAnnotationBoxes() : null;
    const turnAnnotations = collectTurnAnnotations(value, boxes);
    if (!(canSendTurn(value, turnAnnotations) || referenceAttachments.length > 0) || turnInFlightRef.current || turnSubmission.phase !== "idle" || !canSubmitAgentMessage) return;
    if (slide && boxes) setAnnotations((current) => refreshSlideAnnotations(current, slide.id, boxes));
    const requestDeck = deckPayload();
    const requestEnvelope = contextEnvelope(turnAnnotations, overflowing, referenceAttachments);
    turnInFlightRef.current = true;
    setTurnSubmission({ phase: "submitting", threadId: codexState.activeThreadId, turnId: null });
    shouldAutoScrollRef.current = true;
    setApiError(null);
    setAgentCompletion(null);
    let accepted = false;
    let steering = false;
    try {
      let threadId = codexState.activeThreadId;
      if (!threadId) {
        const startResponse = await fetch(`${apiBase}/codex/thread/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approvalPolicy, model: selectedModel || undefined }) });
        const started = await startResponse.json();
        if (!startResponse.ok) throw new Error(started.error ?? "会話を開始できませんでした。");
        threadId = started.thread.id;
        dispatchCodex({ type: "threadLoaded", thread: started.thread, activate: true });
        setTurnSubmission({ phase: "submitting", threadId, turnId: null });
      }
      if (!threadId) throw new Error("操作対象の制作タスクを特定できませんでした。");
      steering = agentRunning;
      if (!steering) {
        agentPreviewBaselineRef.current = requestDeck.slides.map((item) => ({ ...item }));
        agentViewedSlideIdRef.current = requestDeck.slides[activeRef.current - 1]?.id ?? null;
        setAgentPreview({ phase: "checking", changedSlideIds: [], sequence: 0 });
      }
      const runningTurnId = codexState.activeTurnId;
      const endpoint = steering ? "codex/turn/steer" : "codex/turn/start";
      const response = await fetch(`${apiBase}/${endpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId, prompt: value, clientUserMessageId: createMessageId(), selectedId, deck: requestDeck, model: selectedModel || undefined, effort: reasoningEffort, approvalPolicy, contextEnvelope: requestEnvelope, attachments: referenceAttachments }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Agentへの依頼を開始できませんでした。");
      if (response.status !== 202 || (!steering && typeof result.turn?.id !== "string") || (steering && typeof result.turnId !== "string")) throw new Error("Agentへの依頼受付状態を確認できませんでした。");
      if (!steering) {
        accepted = true;
        if (isTerminalTurnStatus(result.turn.status)) {
          turnInFlightRef.current = false;
          setTurnSubmission(IDLE_TURN_SUBMISSION);
        } else setTurnSubmission({ phase: "accepted", threadId, turnId: result.turn.id });
      } else setTurnSubmission(IDLE_TURN_SUBMISSION);
      if (turnAnnotations.length > 0 && slide) {
        const turnId = steering ? runningTurnId ?? result.turn?.id ?? result.turnId ?? null : result.turn?.id ?? result.turnId ?? null;
        setAnnotationAttachments((current) => [...current, {
          id: createMessageId(),
          threadId,
          turnId,
          slideId: slide.id,
          slideLabel: `スライド ${slideNumber}${slide.title ? ` · ${slide.title}` : ""}`,
          annotations: turnAnnotations.map(cloneAnnotation),
        }]);
        const sentIds = new Set(turnAnnotations.map((annotation) => annotation.id));
        setAnnotations((current) => current.filter((annotation) => !sentIds.has(annotation.id)));
        setSelectedAnnotationId((current) => current && sentIds.has(current) ? null : current);
        setAnnouncement("Agentへの指示を送信しました");
      }
      setPromptDraft("");
      if (!steering) setAllowSkillChanges(false);
      setReferenceAttachments([]);
      setIncludeRegionAnnotations(true);
    } catch (error) {
      if (!accepted) setTurnSubmission(IDLE_TURN_SUBMISSION);
      if (!accepted && !steering) {
        agentPreviewBaselineRef.current = null;
        agentViewedSlideIdRef.current = null;
        setAgentPreview(null);
      }
      setApiError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!accepted) turnInFlightRef.current = false;
    }
  };

  const interruptAgent = async () => {
    try {
      const response = await fetch(`${apiBase}/codex/turn/interrupt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: codexState.activeThreadId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "進行中のAgentを停止できませんでした。");
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  const newThread = async () => {
    clearTurnSubmission();
    try {
      const response = await fetch(`${apiBase}/codex/thread/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approvalPolicy, model: selectedModel || undefined }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "制作タスクを開始できませんでした。");
      dispatchCodex({ type: "threadLoaded", thread: result.thread, activate: true });
      setApiError(null);
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  const openThread = async (threadId: string) => {
    try {
      const response = await fetch(`${apiBase}/codex/thread/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "制作タスクを再開できませんでした。");
      dispatchCodex({ type: "threadLoaded", thread: result.thread, activate: true });
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  const threadAction = async (action: string, params: Record<string, unknown> = {}) => {
    const threadId = codexState.activeThreadId;
    if (!threadId) return;
    try {
      const response = await fetch(`${apiBase}/codex/thread/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, params: { threadId, ...params } }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "制作タスクを操作できませんでした。");
      if (action === "delete") dispatchCodex({ type: "activateThread", threadId: null });
      else await openThread(threadId);
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  const forkThread = async () => {
    if (!codexState.activeThreadId) return;
    clearTurnSubmission();
    try {
      const response = await fetch(`${apiBase}/codex/thread/fork`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: codexState.activeThreadId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "制作タスクを複製できませんでした。");
      dispatchCodex({ type: "threadLoaded", thread: result.thread, activate: true });
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  const manageGoal = async () => {
    const threadId = codexState.activeThreadId;
    if (!threadId) return;
    try {
      const response = await fetch(`${apiBase}/codex/thread/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "goalGet", params: { threadId } }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "制作タスクの目標を取得できませんでした。");
      const current = result.goal?.objective ?? result.objective ?? "";
      const objective = window.prompt("制作タスクの目標（空欄にすると解除します）", current);
      if (objective === null) return;
      await threadAction(objective.trim() ? "goalSet" : "goalClear", objective.trim() ? { objective } : {});
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  const resyncPendingRequests = async (id: string | number): Promise<boolean | null> => {
    try {
      const response = await fetch(`${apiBase}/state`);
      const state = await response.json();
      const requests = state?.codex?.pendingRequests;
      if (!response.ok || !Array.isArray(requests)) throw new Error("確認要求の状態を再同期できませんでした。");
      dispatchCodex({ type: "pendingRequests", requests });
      return requests.some((request: { id?: string | number }) => String(request.id) === String(id));
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
      return null;
    }
  };
  const unknownRequestResolution = async (id: string | number, error: unknown): Promise<RequestResolutionOutcome> => {
    const message = error instanceof Error ? error.message : String(error);
    setApiError(message);
    const stillPending = await resyncPendingRequests(id);
    return {
      result: "result_unknown",
      retryable: stillPending === true,
      message: stillPending === true
        ? "回答の結果を確認できませんでした。要求はまだ保留中のため再試行できます。"
        : "回答の結果を確認できません。要求の状態を確認してから再試行してください。",
    };
  };
  const resolveServerRequest = async (id: string | number, result: Record<string, unknown>): Promise<RequestResolutionOutcome> => {
    try {
      const response = await fetch(`${apiBase}/codex/request/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, result }) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "Codexへ回答を送れませんでした。");
      return { result: "settled" };
    } catch (error) {
      return unknownRequestResolution(id, error);
    }
  };
  const rejectServerRequest = async (id: string | number): Promise<RequestResolutionOutcome> => {
    try {
      const response = await fetch(`${apiBase}/codex/request/reject`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, message: "Declined in Weave." }) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "Codexへ拒否の回答を送れませんでした。");
      return { result: "settled" };
    } catch (error) {
      return unknownRequestResolution(id, error);
    }
  };

  const updateSkill = async (skill: any, enabled: boolean) => {
    const path = typeof skill?.path === "string" ? skill.path : null;
    const name = typeof skill?.name === "string" ? skill.name : null;
    if (path === null && name === null) {
      setSkillStatus({ state: "error", message: "This catalog entry cannot be configured." });
      return;
    }
    setSkillBusyKey(`catalog:${path ?? name}`);
    setSkillStatus({ state: "busy", message: "Updating Codex skill…" });
    try {
      const response = await fetch(`${apiBase}/codex/skill/config`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, name, enabled }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "スキルを更新できませんでした。");
      setSkillStatus({ state: "success", message: "Codexでのスキル設定を更新しました。" });
    } catch (error) {
      setSkillStatus({ state: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setSkillBusyKey(null);
    }
  };

  const setSkillMutationStateFromResponse = (result: any) => {
    if (!Array.isArray(result?.skills)) throw new Error("スキルの応答が不正です。");
    if (!result?.project || typeof result.project.clean !== "boolean") throw new Error("スキルの応答にプロジェクト状態がありません。");
    setSkills(result.skills);
    setProject(result.project);
    setSaved(!browserDirtyRef.current && result.project.clean);
    setServerRevision(result.project.revision ?? result.project.commit);
  };

  const runSkillMutation = async (key: string, operation: () => Promise<Response>, successMessage: string) => {
    setSkillBusyKey(key);
    setSkillStatus({ state: "busy", message: "スキルを保存中…" });
    try {
      const response = await operation();
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "スキルの変更を保存できませんでした。");
      setSkillMutationStateFromResponse(result);
      setSkillStatus({ state: "success", message: successMessage });
      return true;
    } catch (error) {
      setSkillStatus({ state: "error", message: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      setSkillBusyKey(null);
    }
  };

  const openNewSkillDialog = () => {
    skillDialogTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSkillDraft({ scope: skillScope, name: "", description: "", body: "", frontmatter: "" });
    setSkillDialog({ mode: "create", source: null });
    setSkillStatus({ state: "idle", message: "" });
  };

  const openEditSkillDialog = (skill: SkillEntry) => {
    skillDialogTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSkillDraft({ scope: skill.scope, name: skill.name, description: skill.valid ? skill.description : "", body: skill.valid ? skill.body : skill.content, frontmatter: skill.frontmatter ?? "" });
    setSkillDialog({ mode: "edit", source: skill });
    setSkillStatus({ state: "idle", message: "" });
  };

  const saveSkill = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!skillDialog) return;
    const { scope, name, description, body, frontmatter } = skillDraft;
    const source = skillDialog.source;
    const effectiveScope = source ? source.scope : scope;
    const payload: Record<string, unknown> = { scope: effectiveScope, name, description, body, frontmatter: frontmatter.trim() ? frontmatter : null };
    const key = `${effectiveScope}:${source ? source.name : name}`;
    const ok = await runSkillMutation(key, () => source
      ? fetch(`${apiBase}/skills/${effectiveScope}/${encodeURIComponent(source.name)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
      : fetch(`${apiBase}/skills`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }), source ? "スキルを更新しました。" : "スキルを作成しました。");
    if (ok) {
      setSkillDialog(null);
    }
  };

  const deleteManagedSkill = async (skill: SkillEntry) => {
    if (!window.confirm(`スキル「${skill.name}」を削除しますか？`)) return;
    await runSkillMutation(`${skill.scope}:${skill.name}`, () => fetch(`${apiBase}/skills/${skill.scope}/${encodeURIComponent(skill.name)}`, { method: "DELETE" }), "スキルを削除しました。");
  };

  const moveManagedSkill = async (skill: SkillEntry) => {
    const action = skill.scope === "project" ? "promote" : "demote";
    await runSkillMutation(`${skill.scope}:${skill.name}`, () => fetch(`${apiBase}/skills/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: skill.name }) }), skill.scope === "project" ? "共通スキルに格上げしました。" : "プロジェクト固有へ格下げしました。");
  };

  const uploadManagedSkill = async (file: File) => {
    const scope = skillScope;
    setSkillBusyKey(`upload:${scope}`);
    setSkillStatus({ state: "busy", message: "SKILL.mdをアップロード中…" });
    try {
      const content = await file.text();
      const response = await fetch(`${apiBase}/skills/upload`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope, filename: file.name, content }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "SKILL.mdをアップロードできませんでした。");
      setSkillMutationStateFromResponse(result);
      setSkillStatus({ state: "success", message: "SKILL.mdをアップロードしました。" });
    } catch (error) {
      setSkillStatus({ state: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setSkillBusyKey(null);
      if (skillInputRef.current) skillInputRef.current.value = "";
    }
  };

  const login = async (type: "chatgpt" | "apiKey") => {
    try {
      const response = await fetch(`${apiBase}/codex/account/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(type === "apiKey" ? { type, apiKey: apiKeyDraft } : { type }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "ログインを開始できませんでした。");
      setApiKeyDraft("");
      const loginUrl = result.authUrl ?? result.loginUrl ?? result.url;
      if (loginUrl && window.confirm("安全なCodexログインページをブラウザーで開きますか？")) window.open(loginUrl, "_blank", "noopener,noreferrer");
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  const invokeMcp = async (server: any, kind: "resource" | "tool") => {
    try {
      let path: string;
      let body: Record<string, unknown>;
      if (kind === "resource") {
        const uri = window.prompt("MCPリソースのURI", server.resources?.[0]?.uri ?? "");
        if (!uri) return;
        path = "resource/read";
        body = { server: server.name, uri, threadId: codexState.activeThreadId };
      } else {
        if (!codexState.activeThreadId) throw new Error("MCPツールを呼び出す前にWeave会話を選択してください。");
        const tool = window.prompt("MCPツール名", Object.keys(server.tools ?? {})[0] ?? "");
        if (!tool) return;
        const raw = window.prompt("ツールの引数（JSON）", "{}");
        if (raw === null) return;
        path = "tool/call";
        body = { server: server.name, tool, arguments: JSON.parse(raw), threadId: codexState.activeThreadId };
      }
      const response = await fetch(`${apiBase}/codex/mcp/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "MCPへのリクエストに失敗しました。");
      setMcpResult(JSON.stringify(result, null, 2).slice(0, 20_000));
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  const sourcePreviewHtml = mode === "split" ? (() => {
    const current = slides[activeSlide - 1];
    if (!current || sourceDiagnostics.length > 0) return "";
    try { return composeFor({ ...current, html: sourceBuffer }, activeSlide, slides.length); } catch { return ""; }
  })() : "";
  const templatePreview = (template: TemplateDoc, instanceId: string, layoutId = template.defaultLayoutId) => {
    const source = blankSlideHtml("");
    const layout = template.layouts.find((item) => item.id === layoutId);
    if (!layout) return <span className="template-preview template-preview-empty" aria-label={`レイアウトが見つかりません: ${template.id}/${layoutId}`} />;
    let html = "";
    try { html = composeSlideHtml({ slideHtml: source, masterHtml: template.masterHtml, layoutHtml: layout.html, templateId: template.id, layoutId: layout.id, position: 1, total: 1, accent: "#f6b84b", instanceId: `${template.id}-${instanceId}` }); }
    catch { return <span className="template-preview template-preview-empty" />; }
    return <span className="template-preview" aria-hidden="true" dangerouslySetInnerHTML={{ __html: displayAssetHtml(html) }} />;
  };
  const templateThumbnail = (template: TemplateDoc, title: string) => {
    const layout = template.layouts.find((item) => item.id === template.defaultLayoutId);
    if (!layout) return null;
    try {
      const html = composeSlideHtml({ slideHtml: blankSlideHtml(""), masterHtml: template.masterHtml, layoutHtml: layout.html, templateId: template.id, layoutId: layout.id, position: 1, total: 1, accent: "#f6b84b", instanceId: `${template.id}-${title}` });
      return thumbHtml(displayAssetHtml(html), deckCss, title);
    } catch { return null; }
  };
  const currentSlide = slides[activeSlide - 1];
  const currentTemplate = templates.find((template) => template.id === (currentSlide?.templateId ?? currentTemplateId));
  const currentLayout = currentTemplate?.layouts.find((layout) => layout.id === currentSlide?.layoutId);
  const slideThumbnail = (slide: SlideDoc, index: number) => {
    try {
      return <span className="slide-thumbnail" aria-hidden="true" dangerouslySetInnerHTML={{ __html: displayAssetHtml(composeFor(slide, index + 1, slides.length)) }} />;
    } catch {
      return <span className="slide-thumbnail slide-thumbnail-empty" aria-hidden="true" />;
    }
  };

  const slideNavigator = (
    <>
      {slides.map((slide, index) => ({ slide, index })).filter(({ index }) => slides.length <= 60 || index === 0 || index === slides.length - 1 || Math.abs(index - (activeSlide - 1)) <= 20).map(({ slide, index }, visibleIndex, visibleEntries) => {
        const slideNumber = index + 1;
        const slideDiagnostics = quality.diagnostics.filter((item) => item.slideId === slide.id);
        const slideSeverity = slideDiagnostics.some((item) => item.severity === "error") ? "error" : slideDiagnostics.some((item) => item.severity === "warning") ? "warning" : slideDiagnostics.length > 0 ? "suggestion" : null;
        return (
          <div className="slide-entry" key={slide.id}>
            {visibleIndex > 0 && index - visibleEntries[visibleIndex - 1].index > 1 && <button className="slide-gap" aria-label="前のスライドを表示" onClick={() => switchSlide(Math.max(1, slideNumber - 20))}>…</button>}
            <button
              className={`slide-item ${activeSlide === slideNumber ? "active" : ""} ${selectedSlideIds.has(slide.id) ? "selected" : ""} ${liveChangedSlideIds.has(slide.id) ? "agent-updated" : ""}`}
              aria-pressed={selectedSlideIds.has(slide.id)}
              onClick={(event) => { setSelectedSlideIds((current) => { if (!(event.metaKey || event.ctrlKey || event.shiftKey)) return new Set([slide.id]); const next = new Set(current); if (next.has(slide.id) && next.size > 1) next.delete(slide.id); else next.add(slide.id); return next; }); switchSlide(slideNumber); }}
              title={`${slideNumber}枚目を開く: ${slide.title || "無題"}`}
              draggable
              onDragStart={() => setDraggedSlide(index)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (draggedSlide == null || draggedSlide === index) return;
                checkpoint();
                const next = captureActive();
                const [moved] = next.splice(draggedSlide, 1);
                next.splice(index, 0, moved);
                setSlidesSynced(next);
                activeRef.current = index + 1;
                setActiveSlideSynced(index + 1);
                setDraggedSlide(null);
                markDirty();
                reinject();
              }}
            >
              <span className="slide-number">{String(slideNumber).padStart(2, "0")}</span>
              {slideThumbnail(slide, index)}
              <span className="slide-name">{slide.title || "無題"}</span>
              {slideSeverity && <span className={`slide-diagnostic-badge ${slideSeverity}`} aria-label={`${slideSeverity === "error" ? "エラー" : slideSeverity === "warning" ? "警告" : "提案"} ${slideDiagnostics.length}件`}>{slideSeverity === "error" ? "!" : slideSeverity === "warning" ? "△" : "○"} {slideDiagnostics.length}</span>}
              {liveChangedSlideIds.has(slide.id) && <span className="slide-live-marker">更新中</span>}
            </button>
            <button
              className="slide-menu-trigger"
              aria-label={`スライド${slideNumber}の操作`}
              aria-haspopup="menu"
              aria-expanded={openPopover === "slideMenu" && activeSlide === slideNumber}
              onClick={(event) => { if (activeSlide !== slideNumber) switchSlide(slideNumber); togglePopover("slideMenu", event.currentTarget); }}
            >⋯</button>
            {openPopover === "slideMenu" && activeSlide === slideNumber && <div className="slide-actions-menu" role="menu">
              <button role="menuitem" onClick={() => { dismissPopover(false); duplicateSlide(); }}>スライドを複製</button>
              <button role="menuitem" onClick={() => { dismissPopover(false); moveSlide(-1); }} disabled={activeSlide === 1}>左へ移動</button>
              <button role="menuitem" onClick={() => { dismissPopover(false); moveSlide(1); }} disabled={activeSlide === slides.length}>右へ移動</button>
              <button role="menuitem" className="danger" onClick={() => { dismissPopover(false); deleteSlide(); }} disabled={slides.length <= 1}>スライドを削除</button>
            </div>}
          </div>
        );
      })}
      <span className="new-slide-wrap">
        <button className="new-slide" onClick={(event) => togglePopover("newSlide", event.currentTarget)} disabled={!templates.length} aria-label="新しいスライド" title="新しいスライドを追加します">＋</button>
        {openPopover === "newSlide" && (
          <>
            <div className="popover-backdrop" role="presentation" onPointerDown={() => dismissPopover()} />
            <div className="template-options new-slide-options" role="listbox" aria-label="新しいスライドのレイアウト">
              {templates.map((template) => (
                <div className="template-group" key={template.id}>
                  <strong className="template-group-name">{template.name}</strong>
                  {template.layouts.map((layout) => <button key={`${template.id}-${layout.id}`} role="option" aria-selected="false" onClick={() => addSlide(template.id, layout.id)}>{templatePreview(template, `new-slide-${layout.id}`, layout.id)}<span>{layout.name}</span></button>)}
                </div>
              ))}
            </div>
          </>
        )}
      </span>
    </>
  );

  const presenterScale = typeof window === "undefined" ? 1 : Math.min((window.innerWidth - 80) / designWidth, (window.innerHeight - 120) / designHeight);
  const containerLike = !!sel && sel.container && sel.kind !== "metrics";
  const propertyRows = (schema: Control[]) => schema.map((ctl) => {
    const current = sel?.read[ctl.key] ?? "";
    return (
      <div className="property-row" key={ctl.key}>
        <span>{ctl.label}</span>
        <div className="scale-options">
          {ctl.options.map((opt) => (
            <button key={`${ctl.key}-${opt.label}`} className={current === opt.className ? "active" : ""} onClick={() => setUtility(ctl.key, opt.className)}>{opt.label}</button>
          ))}
        </div>
      </div>
    );
  });

  const historySidebar = (
    <section className="activity-panel history-panel" aria-label="バージョン履歴">
      <header className="activity-panel-heading"><span>バージョン履歴</span><button className="panel-close" aria-label="バージョン履歴を閉じる" onClick={() => setLeftPanelOpen(false)}>×</button></header>
      <div className="activity-panel-body">
        {(project?.backgroundTasks?.length ?? 0) > 0 && <section className="background-task-list" aria-label="このプロジェクトのバックグラウンドタスク"><strong>バックグラウンド</strong>{project!.backgroundTasks!.map((task, index) => <p key={`${task.threadId ?? "recovery"}-${index}`}><span>{task.variation ? "探索案" : "Agentタスク"}</span><small>{task.status === "running" ? "実行中" : task.status === "starting" ? "開始中" : task.status === "interrupted" ? "復旧可能" : task.status}</small></p>)}</section>}
        <div className="repository-summary">
          <span><i className={draftSync === "synced" ? "clean" : "dirty"} />{draftSync === "synced" ? "作業中ドラフトは同期済みです" : "作業中ドラフトを同期しています"}</span>
          {project && <details className="version-details"><summary>技術情報</summary><small>{project.branch} · {project.commit}</small></details>}
        </div>
        <label className="save-message"><span>マイルストーン名</span><input value={saveMessage} onChange={(event) => setSaveMessage(event.target.value)} placeholder={`${deckTitle} レビュー版`} /></label>
        <button className="sidebar-primary-action" onClick={() => void saveProject()}>マイルストーンを作成</button>
        {project?.historyPreview && <button className="return-latest" onClick={() => void restoreHistory()}>履歴を開く前のドラフトへ戻る</button>}
        <div className="activity-section-label">マイルストーン</div>
        <div className="history-list">
          {history.map((entry, index) => (
            <div className="history-entry" key={entry.id}>
              <button onClick={() => void restoreHistory(entry.id)}>
                <i className={index === 0 ? "current" : ""} /><span><strong>{entry.message}</strong><small>{new Date(entry.date).toLocaleString()}</small></span>
              </button>
              <details className="version-details"><summary>詳細</summary><small>{entry.shortId}</small></details>
            </div>
          ))}
        </div>
        <p className="activity-warning">過去の状態は既存履歴を上書きせず、新しい作業中ドラフトとして開きます。</p>
      </div>
    </section>
  );

  const skillsSidebar = (
    <section className="activity-panel skills-panel" aria-label="スキルライブラリ">
      <header className="activity-panel-heading"><span>スキル</span><small>{skills.length}件</small><button className="panel-close" aria-label="スキルを閉じる" onClick={() => setLeftPanelOpen(false)}>×</button></header>
      <div className="activity-panel-body skills-sidebar">
        <div className="skills-intro"><strong>再利用できる指示</strong><p>Codexが使うプロジェクト固有・共通スキルを管理します。</p></div>
        <div className="skills-actions">
          <button className="sidebar-primary-action" type="button" onClick={openNewSkillDialog} disabled={skillBusyKey !== null || agentRunning}>新しいスキル</button>
          <input ref={skillInputRef} className="sr-only" type="file" accept="SKILL.md,.md,text/markdown" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadManagedSkill(file); }} />
          <button className="skills-upload-button" type="button" onClick={() => skillInputRef.current?.click()} disabled={skillBusyKey !== null || agentRunning}>SKILL.mdをアップロード</button>
        </div>
        {agentRunning && <p className="activity-warning">Agentの処理が完了してからスキルを変更してください。</p>}
        <div className="skills-tabs" role="tablist" aria-label="スキルの適用範囲">
          {(["project", "common"] as SkillScope[]).map((scope) => <button key={scope} type="button" role="tab" aria-selected={skillScope === scope} className={skillScope === scope ? "active" : ""} onClick={() => { setSkillScope(scope); setSkillDraft((current) => ({ ...current, scope })); }}>{scope === "project" ? "プロジェクト固有" : "共通"}<small>{skills.filter((skill) => skill.scope === scope).length}</small></button>)}
        </div>
        <label className="skills-search"><span className="sr-only">スキルを絞り込む</span><input type="search" value={skillSearch} onChange={(event) => setSkillSearch(event.target.value)} placeholder="スキルを検索" aria-label="スキルを絞り込む" /></label>
        {skillStatus.state !== "idle" && <div className={`skill-status ${skillStatus.state}`} role={skillStatus.state === "error" ? "alert" : "status"} aria-live="polite" aria-busy={skillStatus.state === "busy"}>{skillStatus.message}</div>}
        <div className="skill-card-list">
          {visibleSkills.map((skill) => {
            const catalogSkill = catalogSkillFor(skill);
            const supportsToggle = skill.valid && typeof catalogSkill?.enabled === "boolean";
            const key = `${skill.scope}:${skill.name}`;
            return <article className="skill-card" key={key} aria-busy={skillBusyKey === key}>
              <div className="skill-card-head"><div><strong>{skill.name}</strong><span className={`skill-scope-badge ${skill.scope}`}>{skill.scope === "project" ? "固有" : "共通"}</span>{!skill.valid && <span className="skill-invalid-badge">要修復</span>}</div><button type="button" aria-label={`${skill.name}を編集`} onClick={() => openEditSkillDialog(skill)} disabled={skillBusyKey !== null || agentRunning}>{skill.valid ? "編集" : "修復"}</button></div>
              <p>{skill.valid ? skill.description : skill.error}</p>
              <code title={skill.path}>{skill.path}</code>
              {supportsToggle && <label className="skill-enable-toggle"><span>Codexで有効</span><input type="checkbox" checked={catalogSkill.enabled} onChange={(event) => void updateSkill(catalogSkill, event.target.checked)} disabled={skillBusyKey !== null || agentRunning} /></label>}
              <footer><button type="button" onClick={() => void moveManagedSkill(skill)} disabled={!skill.valid || skillBusyKey !== null || agentRunning}>{skill.scope === "project" ? "共通に格上げ" : "プロジェクト固有へ格下げ"}</button><button type="button" className="danger" onClick={() => void deleteManagedSkill(skill)} disabled={skillBusyKey !== null || agentRunning}>削除</button></footer>
            </article>;
          })}
          {visibleSkills.length === 0 && <p className="skills-empty">{skillSearch.trim() ? "条件に一致するスキルはありません。" : skillScope === "project" ? "プロジェクト固有のスキルはまだありません。" : "共通スキルはまだありません。"}</p>}
        </div>
      </div>
    </section>
  );

  const shortcutsSidebar = (
    <section className="activity-panel shortcuts-panel" aria-label="キーボードショートカット">
      <header className="activity-panel-heading"><span>キーボードショートカット</span><button className="panel-close" aria-label="ショートカットを閉じる" onClick={() => setLeftPanelOpen(false)}>×</button></header>
      <div className="activity-panel-body"><dl><dt>← / →</dt><dd>前／次のスライド</dd><dt>ダブルクリック／Enter</dt><dd>選択したテキストを編集</dd><dt>@</dt><dd>メッセージ欄から要素をAgentへ示す</dd><dt>A</dt><dd>Mark for Agentを切り替え</dd><dt>Esc</dt><dd>編集や範囲指定、プレゼンを終了</dd><dt>⌘/Ctrl Z</dt><dd>元に戻す</dd><dt>⌘/Ctrl Shift Z</dt><dd>やり直す</dd><dt>?</dt><dd>この画面を開く</dd></dl></div>
    </section>
  );

  const settingsSidebar = (
    <section className="activity-panel settings-panel" aria-label="設定">
      <header className="activity-panel-heading"><span>設定</span><button className="panel-close" aria-label="設定を閉じる" onClick={() => setLeftPanelOpen(false)}>×</button></header>
      <div className="activity-panel-body settings-sidebar">
        <nav className="more-navigation" aria-label="その他の機能"><button onClick={() => { setActivityView("history"); setMobileView("history"); }}>履歴とマイルストーン</button><button onClick={(event) => togglePopover("quality", event.currentTarget)}>品質チェック</button><button onClick={() => showActivity("skills")}>スキル</button><button onClick={() => showActivity("shortcuts")}>ヘルプとショートカット</button></nav>
        <section><h3>表示</h3><label><span>カラーモード</span><select value={theme} onChange={(event) => setTheme(event.target.value as "dark" | "light")}><option value="dark">ダーク</option><option value="light">ライト</option></select></label><label><span>表示密度</span><select value={density} onChange={(event) => densityStore.write(event.target.value as Density)}><option value="comfortable">通常</option><option value="compact">コンパクト</option></select></label><p>スライド一覧は左、デザイン・Agent・変更レビューは右の単一コンテキストパネルに表示します。</p></section>
        <section><h3>Agent</h3>
          <label><span>承認方法</span><select value={approvalPolicy} onChange={(event) => setApprovalPolicy(event.target.value)}><option value="never">確認しない</option><option value="on-request">必要なとき確認</option><option value="untrusted">未確認コマンドのみ</option></select></label>
          {codexState.catalog.modelProvider && <pre className="settings-output">{JSON.stringify(codexState.catalog.modelProvider, null, 2)}</pre>}
        </section>
        <section><h3>アカウント</h3>{codexState.catalog.account ? <div className="setting-row"><span>{String(codexState.catalog.account.type ?? "サインイン済み")}</span><button onClick={() => { void fetch(`${apiBase}/codex/account/logout`, { method: "POST" }).catch((error) => setApiError(error.message)); }}>ログアウト</button></div> : <><button onClick={() => void login("chatgpt")}>ChatGPTでサインイン</button><div className="api-key-row"><input type="password" value={apiKeyDraft} onChange={(event) => setApiKeyDraft(event.target.value)} placeholder="APIキー" /><button disabled={!apiKeyDraft} onClick={() => void login("apiKey")}>キーを使用</button></div></>}</section>
        <section><h3>フック</h3>{codexState.catalog.hooks.flatMap((entry: any) => entry.hooks ?? [entry]).map((hook: any, index: number) => <div className="setting-row" key={hook.name ?? hook.event ?? index}><span>{hook.name ?? hook.event ?? "設定済みフック"}</span><small>{hook.enabled === false ? "無効" : "有効"}</small></div>)}</section>
        <section><h3>MCPサーバー</h3>{codexState.catalog.mcpServers.map((server: any) => <div className="setting-row" key={server.name}><span>{server.name}</span><small>{server.status ?? server.authStatus ?? "設定済み"}</small>{server.resources?.length > 0 && <button onClick={() => void invokeMcp(server, "resource")}>リソース</button>}{Object.keys(server.tools ?? {}).length > 0 && <button disabled={!codexState.activeThreadId} onClick={() => void invokeMcp(server, "tool")}>ツール</button>}<button onClick={() => { void fetch(`${apiBase}/codex/mcp/oauth`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: server.name }) }).then(async (response) => { const result = await response.json(); if (!response.ok) throw new Error(result.error); const url = result.authorizationUrl ?? result.url; if (url && window.confirm(`${server.name}のOAuth認証ページを開きますか？`)) window.open(url, "_blank", "noopener,noreferrer"); }).catch((error) => setApiError(error.message)); }}>OAuth</button></div>)}</section>
        {mcpResult && <pre className="settings-output">{mcpResult}</pre>}
      </div>
    </section>
  );

  return (
    <main className={`weave-app ${theme}`} data-density={density} style={{ "--accent": accent } as React.CSSProperties}>
      <header className="topbar">
        <button ref={projectSwitcherRef} className="project-switcher" aria-label="プロジェクトを開く" aria-expanded={galleryOpen} aria-haspopup="dialog" onClick={openGallery} data-help="プロジェクトの作成・切り替え・管理を開きます">
          <span className="project-mark">W</span>
          <span><strong>{deckTitle}</strong><small>{project?.root.split("/").pop() ?? "ローカルプロジェクト"}</small></span>
          <span className="chevron">⌄</span>
        </button>
        <div className="document-title">
          <span className="document-title-field" data-unsaved={!saved ? "true" : undefined}>
            <input aria-label="資料タイトル" value={deckTitle} onChange={(event) => { setDeckTitle(event.target.value); markDirty(); }} />
            {!saved && <i className="unsaved-dot" aria-hidden="true" />}
            {!saved && <span className="sr-only">マイルストーン未作成の変更あり</span>}
          </span>
          <small>{activeSlide} / {slides.length} 枚目</small>
        </div>
        <div className="top-actions">
          <button className="delivery-button" onClick={(event) => togglePopover("delivery", event.currentTarget)} aria-expanded={openPopover === "delivery"} aria-haspopup="menu" data-help="プレゼン表示、書き出し、印刷を選びます">プレゼン・書き出し <span aria-hidden="true">⌄</span></button>
          <input ref={importRef} className="sr-only" type="file" accept=".json,.weave.json,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importBundle(file); }} />
          <button className="save-button" onClick={() => void saveProject()} data-help="現在のドラフトへ名前を付け、長期履歴として残します"><span>◇</span> マイルストーン</button>
        </div>
      </header>

      {openPopover === "delivery" && (
        <>
          <div className="popover-backdrop" role="presentation" onPointerDown={() => dismissPopover()} />
          <div className="topbar-popover delivery-menu" role="menu" aria-label="プレゼンと書き出し">
            <button role="menuitem" onClick={() => { dismissPopover(false); openPresenter(); }}><span>プレゼンを開始</span><small>全画面のプレゼン画面を開きます</small></button>
            <button role="menuitem" onClick={() => { dismissPopover(false); exportDeck(); }}><span>HTMLを書き出す</span><small>オフラインで使える資料を保存します</small></button>
            <button role="menuitem" onClick={() => { dismissPopover(false); printDeck(); }}><span>印刷／PDF</span><small>システムの印刷画面を開きます</small></button>
            <button role="menuitem" onClick={() => { dismissPopover(false); downloadBundle(); }}><span>編集用データを保存</span><small>編集可能なWeaveプロジェクトを保存します</small></button>
          </div>
        </>
      )}

      <div className="workspace" data-slide-nav={slideNav} data-inspector={inspectorOpen ? "open" : "closed"} data-agent={leftPanelOpen ? "open" : "closed"} data-mobile-view={mobileView} data-focus={canvasFocused ? "canvas" : "workspace"}>
        <nav className="activity-rail" aria-label="メインナビゲーション">
          <div className="activity-top">
            <button className={`activity-button ${activityView === "agent" ? "active" : ""}`} aria-label="Agent" aria-pressed={activityView === "agent"} onClick={() => showActivity("agent")}>◇</button>
            <button className={`activity-button ${activityView === "history" ? "active" : ""}`} aria-label="バージョン履歴" aria-pressed={activityView === "history"} onClick={() => showActivity("history")}>↶</button>
            <button className={`activity-button ${activityView === "shortcuts" ? "active" : ""}`} aria-label="キーボードショートカット" aria-pressed={activityView === "shortcuts"} onClick={() => showActivity("shortcuts")}>⌨</button>
            <button className={`activity-button ${activityView === "skills" ? "active" : ""}`} aria-label="スキル" aria-pressed={activityView === "skills"} onClick={() => showActivity("skills")}>✦</button>
          </div>
          <div className="activity-bottom">
            <div className="avatar">FK</div>
            <button className={`activity-button ${activityView === "settings" ? "active" : ""}`} aria-label="設定" aria-pressed={activityView === "settings"} onClick={() => showActivity("settings")}>⚙</button>
          </div>
        </nav>

        {slideNav === "rail" && <nav className="slide-nav slide-rail" aria-label="スライド一覧">{slideNavigator}</nav>}

        {leftPanelOpen ? <aside className="left-panel">
          <div className="panel-resizer" role="separator" aria-orientation="vertical" aria-label="サイドバーの幅を変更" aria-valuenow={sidebarWidth} aria-valuemin={280} aria-valuemax={560} tabIndex={0} onPointerDown={startSidebarResize} onKeyDown={(event) => { if (event.key === "ArrowLeft") { event.preventDefault(); adjustSidebarWidth(-16); } if (event.key === "ArrowRight") { event.preventDefault(); adjustSidebarWidth(16); } }} />
          {activityView === "agent" ? <section className="agent-panel" aria-label="Agent制作タスク" aria-busy={turnBusy}>
            <div className="context-panel-switcher" role="tablist" aria-label="コンテキストパネル"><button role="tab" aria-selected="false" onClick={() => { setLeftPanelOpen(false); setInspectorOpen(true); setInspectorView("design"); }}>デザイン</button><button role="tab" aria-selected="true">Agent</button><button role="tab" aria-selected="false" onClick={() => { setChangedReviewIndex(0); setLeftPanelOpen(false); }}>変更レビュー{changedReview.length > 0 ? ` ${changedReview.length}` : ""}</button></div>
            <div className="agent-heading">
              <div className="agent-heading-main">
                <h2 className="agent-heading-title">
                  <button className="thread-switcher" onClick={(event) => togglePopover("threads", event.currentTarget)} aria-expanded={openPopover === "threads"} aria-haspopup="dialog" title="制作タスクを切り替えます"><span>{activeThreadName}</span><em aria-hidden="true">⌄</em></button>
                </h2>
                <span className={`agent-state agent-state-${agentHeaderState?.kind ?? "idle"}`} role="status" aria-live="polite" aria-busy={turnBusy} data-turn-state={turnPresentation} data-status={agentHeaderState?.kind ?? "idle"}>{agentHeaderState?.label ?? ""}</span>
              </div>
              <div className="agent-heading-actions">
                <button className="new-thread-button" onClick={() => void newThread()} aria-label="新しい制作タスク" title="新しい制作タスクを開始します">＋</button>
                <button className="thread-menu-trigger" onClick={(event) => toggleThreadMenu(event.currentTarget)} aria-expanded={threadMenuOpen} aria-haspopup="menu" aria-label="制作タスクの操作" title="制作タスクの名前変更、別の方向、アーカイブ、削除">…</button>
                <button className="panel-close" onClick={() => setLeftPanelOpen(false)} aria-label="Agentパネルを閉じる" title="Agentパネルを閉じます">×</button>
              </div>
            </div>
            {openPopover === "threads" && (
              <>
                <div className="popover-backdrop" role="presentation" onPointerDown={() => dismissPopover()} />
                <div ref={threadDialogRef} className="thread-popover" role="dialog" aria-modal="true" aria-label="制作タスクを切り替え" tabIndex={-1} onKeyDown={onThreadDialogKeyDown}>
                  <div className="thread-popover-heading">
                    <strong>制作タスク</strong>
                    <button type="button" onClick={() => { dismissPopover(); void newThread(); }}>＋ 新しいタスク</button>
                  </div>
                  <div className="thread-controls">
                    <input type="search" value={threadSearch} onChange={(event) => setThreadSearch(event.target.value)} placeholder="タスク名・対象スライドを検索" aria-label="制作タスクを検索" />
                    <button className={showArchivedThreads ? "active" : ""} onClick={() => setShowArchivedThreads((value) => !value)}>{showArchivedThreads ? "使用中" : "アーカイブ"}</button>
                  </div>
                  <div className="thread-list" aria-label="制作タスク一覧">
                    {codexState.threadOrder.map((id) => codexState.threads[id]).filter((thread) => thread && thread.archived === showArchivedThreads).slice(0, 12).map((thread) => (
                      <button key={thread.id} className={codexState.activeThreadId === thread.id ? "active" : ""} onClick={() => { dismissPopover(); void openThread(thread.id); }}>
                        <strong>{displayThreadName(thread.name) || thread.preview || "新しい制作タスク"}</strong>
                        <small>{thread.status}</small>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
            {threadMenuOpen && (
              <>
                <div className="popover-backdrop" role="presentation" onPointerDown={() => dismissPopover()} />
                <div ref={threadMenuRef} className="thread-actions-menu" role="menu" tabIndex={-1} aria-label={`${activeThreadName}の操作`} onKeyDown={onThreadMenuKeyDown}>
                  <strong>制作タスクの操作</strong>
                  <button role="menuitem" disabled={!codexState.activeThreadId} onClick={() => { const name = window.prompt("タスク名", displayThreadName(codexState.threads[codexState.activeThreadId!]?.name) ?? ""); if (name !== null) { dismissPopover(); void threadAction("name", { name }); } }}>タスク名を変更</button>
                  <button role="menuitem" disabled={!codexState.activeThreadId} onClick={() => { dismissPopover(); void forkThread(); }}>別の方向で試す</button>
                  <button role="menuitem" disabled={!codexState.activeThreadId} onClick={() => { dismissPopover(); void threadAction(activeThread?.archived ? "unarchive" : "archive"); }}>{activeThread?.archived ? "アーカイブから戻す" : "アーカイブ"}</button>
                  <details className="advanced-task-actions"><summary>詳細操作</summary><button role="menuitem" disabled={!codexState.activeThreadId} onClick={() => { dismissPopover(); void manageGoal(); }}>内部ゴール</button><button role="menuitem" disabled={!codexState.activeThreadId} onClick={() => { dismissPopover(); void threadAction("compact"); }}>履歴を整理</button></details>
                  <button role="menuitem" className="danger" disabled={!codexState.activeThreadId} onClick={() => { if (window.confirm("この制作タスクを完全に削除しますか？")) { dismissPopover(); void threadAction("delete"); } }}>削除</button>
                </div>
              </>
            )}
            <div ref={messagesRef} className="messages" role="log" aria-live="polite" aria-relevant="additions text" aria-label="制作タスクのやり取り" aria-busy={turnBusy} onScroll={(event) => { const element = event.currentTarget; shouldAutoScrollRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48; }}>
              {!codexState.activeThreadId && <p className="empty-thread">依頼を書いて新しい制作タスクを始めるか、過去のタスクを選んでください。</p>}
              {activeTurns.length > visibleTurns.length && <p className="trimmed-log">最新{visibleTurns.length}ターンを表示しています。</p>}
              {visibleTurns.map((turn, turnIndex) => {
                const turnItems = selectTurnItems(codexState, turn.id);
                const messageItems = turnItems.filter(isConversationMessage);
                const workItems = turnItems.filter((item) => !isConversationMessage(item));
                const turnInProgress = ["starting", "running", "inProgress"].includes(turn.status);
                return <section className="turn-group" key={turn.id} aria-label={`ターン ${turnIndex + 1}`}>
                  {messageItems.map((item) => <ItemCard key={item.id} item={item} />)}
                  {workItems.length > 0 && <details className="work-details" open={turnInProgress}>
                    <summary><span>作業ログ</span><span>{workItems.length}件</span></summary>
                    <div className="work-items" aria-label={`作業ログ ${workItems.length}件`}>{workItems.map((item) => <ItemCard key={item.id} item={item} />)}</div>
                  </details>}
                  {activeThreadAttachments.filter((attachment) => attachment.turnId === turn.id).map((attachment) => <AnnotationAttachment
                    key={attachment.id}
                    slideLabel={attachment.slideLabel}
                    annotations={attachment.annotations}
                    canRestore={slides.some((slide) => slide.id === attachment.slideId)}
                    canOverlay={slides.some((slide) => slide.id === attachment.slideId)}
                    overlayActive={activeOverlayAttachmentId === attachment.id && slides.some((slide) => slide.id === attachment.slideId)}
                    onRestore={() => restoreAnnotationAttachment(attachment)}
                    onToggleOverlay={() => toggleAttachmentOverlay(attachment)}
                  />)}
                  {(turn.status !== "completed" || turn.diff) && <footer className="turn-status"><span role="status">{turn.status}</span>{turn.diff && <details><summary>ターンの差分</summary><pre>{turn.diff}</pre></details>}</footer>}
                </section>;
              })}
              {unmatchedAttachments.map((attachment) => <AnnotationAttachment
                key={attachment.id}
                slideLabel={attachment.slideLabel}
                annotations={attachment.annotations}
                canRestore={slides.some((slide) => slide.id === attachment.slideId)}
                canOverlay={slides.some((slide) => slide.id === attachment.slideId)}
                overlayActive={activeOverlayAttachmentId === attachment.id && slides.some((slide) => slide.id === attachment.slideId)}
                onRestore={() => restoreAnnotationAttachment(attachment)}
                onToggleOverlay={() => toggleAttachmentOverlay(attachment)}
              />)}
              <div ref={messagesEndRef} className="messages-end" />
            </div>
            <div className="composer-dock" data-turn-state={turnPresentation} aria-busy={turnBusy}>
              {pendingServerRequests.length > 0 && <section className="blocking-region" role="region" aria-live="assertive" aria-label="確認が必要な操作" data-pending-count={pendingServerRequests.length}>
                <div className="blocking-heading"><strong>{activePendingServerRequests.length > 0 ? "確認が必要です" : "確認が必要な要求があります"}</strong><span>{pendingServerRequests.length}件</span></div>
                {pendingRequestGroups.unscoped.length > 0 && <p className="blocking-notice" role="status">会話を特定できない確認が {pendingRequestGroups.unscoped.length}件あります。</p>}
                {pendingRequestGroups.other.length > 0 && <p className="blocking-notice" role="status">別の会話に属する確認が {pendingRequestGroups.other.length}件あります。対象の会話を選ぶと操作できます。</p>}
                {blockingPendingRequests.map((pending) => {
                  const scope = pendingRequestScope(pending, codexState.activeThreadId);
                  return <div className={`blocking-request blocking-request-${scope}`} key={String(pending.id)} data-request-scope={scope}>
                    {scope === "unscoped" && <span className="blocking-request-label">会話を特定できない確認</span>}
                    <ServerRequestCard request={pending} onResolve={resolveServerRequest} onReject={rejectServerRequest} />
                  </div>;
                })}
              </section>}
              <div className="chat-box"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => { event.preventDefault(); void uploadReferences(event.dataTransfer.files); }}
              onPaste={(event) => { const files = event.clipboardData.files; if (files.length > 0) { event.preventDefault(); void uploadReferences(files); } }}
            >
              {openPopover === "references" && <>
                <div className="popover-backdrop" role="presentation" onPointerDown={() => dismissPopover()} />
                <aside className="reference-popover" aria-label="参照資料">
                  <header><strong>{referenceView === "browse" ? "フォルダーを追加" : "参照資料"}</strong><button type="button" aria-label="参照資料を閉じる" onClick={() => dismissPopover()}>×</button></header>
                  {referenceView === "browse" && folderBrowser ? <>
                    <div className="reference-breadcrumbs">{folderBrowser.breadcrumbs.map((crumb, index) => <span key={crumb.path}>{index > 0 && " / "}<button type="button" onClick={() => void browseFolders(crumb.path)}>{crumb.name}</button></span>)}</div>
                    <div className="reference-folder-list">{folderBrowser.parent && <button type="button" onClick={() => void browseFolders(folderBrowser.parent ?? undefined)}>↑ 親フォルダー</button>}{folderBrowser.folders.map((folder) => <button type="button" key={folder.path} onClick={() => void browseFolders(folder.path)}>📁 {folder.name}</button>)}</div>
                    <footer className="reference-browser-footer"><span>フォルダー {folderBrowser.folderCount.toLocaleString()}件 · この場所のファイル {folderBrowser.fileCount.toLocaleString()}件</span><button type="button" onClick={() => void importFolder()} disabled={folderImporting}>{folderImporting ? "読み込み中…" : "フォルダーを追加"}</button></footer>
                  </> : <>
                  <section className="reference-shelf-section" aria-labelledby="reference-folders-heading">
                    <h4 id="reference-folders-heading">フォルダー</h4>
                    <div className="reference-shelf-list">
                    {referenceShelf.filter((reference) => reference.kind === "folder").map((reference) => {
                      const attached = referenceAttachments.some((attachment) => attachment.path === reference.path);
                      return <div className={`reference-shelf-item${reference.missing ? " missing" : ""}`} key={reference.path}>
                        <label title={`${reference.path}\n参照元: ${reference.source ?? "不明"}`}>
                          <input type="checkbox" checked={attached} disabled={reference.missing} onChange={() => setReferenceAttachments((current) => attached ? current.filter((item) => item.path !== reference.path) : [...current, reference])} />
                          <span className="reference-shelf-name">{reference.name}</span>
                          <small>{reference.missing ? "見つかりません" : `${reference.files ?? 0}ファイル · ${formatBytes(reference.size)}`}</small>
                        </label>
                        <button type="button" aria-label={`${reference.name}を更新`} disabled={reference.sourceMissing} onClick={() => void syncFolder(reference.path)}>↻</button>
                        <button type="button" aria-label={`${reference.name}を参照資料から削除`} onClick={() => void removeShelfReference(reference.path)}>×</button>
                      </div>;
                    })}
                    </div>
                    <button className="reference-add" type="button" onClick={() => void browseFolders()}>＋ フォルダーを追加</button>
                  </section>
                  <section className="reference-shelf-section" aria-labelledby="reference-files-heading">
                    <h4 id="reference-files-heading">ファイル</h4>
                    <div className="reference-shelf-list">
                    {referenceShelf.filter((reference) => reference.kind === "file").map((reference) => {
                      const attached = referenceAttachments.some((attachment) => attachment.path === reference.path);
                      return <div className={`reference-shelf-item${reference.missing ? " missing" : ""}`} key={reference.path}>
                        <label title={reference.path}>
                          <input type="checkbox" checked={attached} disabled={reference.missing} onChange={() => setReferenceAttachments((current) => attached ? current.filter((item) => item.path !== reference.path) : [...current, reference])} />
                          <span className="reference-shelf-name">{reference.name}</span>
                          <small>{reference.missing ? "見つかりません" : formatBytes(reference.size)}</small>
                        </label>
                        <button type="button" aria-label={`${reference.name}を参照資料から削除`} onClick={() => void removeShelfReference(reference.path)}>×</button>
                      </div>;
                    })}
                    </div>
                    <button className="reference-add" type="button" onClick={() => referenceInputRef.current?.click()}>＋ ファイルを追加</button>
                  </section>
                  </>}
                </aside>
              </>}
              <div className="agent-boundary-controls" role="group" aria-label="Agentの変更範囲と実行方法">
                <label><span>変更範囲</span><select value={changeScope} onChange={(event) => setChangeScope(event.target.value as ChangeScope)}><option value="element" disabled={!selectedId}>この要素だけ</option><option value="current-slide">現在のスライド</option><option value="selected-slides">選択したスライド</option><option value="deck">デッキ全体</option></select></label>
                <label><span>実行</span><select value={executionMode} onChange={(event) => { const mode = event.target.value as ExecutionMode; setExecutionMode(mode); if (mode !== "apply") setAllowSkillChanges(false); }}><option value="apply">直接反映</option><option value="propose">提案だけ作成</option><option value="plan">先に計画を提示</option></select></label>
                <label className="agent-skill-permission"><input type="checkbox" checked={allowSkillChanges} disabled={executionMode !== "apply"} onChange={(event) => setAllowSkillChanges(event.target.checked)} /><span>この1回だけプロジェクトスキルの変更を許可</span></label>
                <p>Agentは{changeScope === "element" ? `「${blockLabels[sel?.kind ?? ""] ?? "選択要素"}」だけ` : changeScope === "current-slide" ? `スライド${activeSlide}だけ` : changeScope === "selected-slides" ? `選択した${selectedSlideIds.size || 1}枚のスライド` : "デッキ全体"}を変更できます。</p>
              </div>
              <div className="context-chip" role="group" aria-label="参照対象">
                <span className="context-chip-heading">参照</span>
                <span className="context-target-chip" title={slides[activeSlide - 1]?.title || "無題"}><span className="context-icon" aria-hidden="true">▧</span>スライド {activeSlide} · {slides[activeSlide - 1]?.title || "無題"}</span>
                {selectedId && <span className="context-target-chip"><span className="context-icon" aria-hidden="true">⌖</span>選択要素 · {blockLabels[sel?.kind ?? ""] ?? "要素"}</span>}
                {activeElementAnnotations.length > 0 && <span className="context-target-chip"><span className="context-icon" aria-hidden="true">⌑</span>指示要素 {activeElementAnnotations.length}件</span>}
                {activeRegionAnnotations.length > 0 && <button
                  type="button"
                  className={regionsWillSend ? "active" : "held"}
                  aria-pressed={regionsWillSend}
                  disabled={referencedRegions.length > 0}
                  title={referencedRegions.length > 0 ? "本文から参照している範囲は送信対象から外せません" : "次の送信に指示範囲を含めるか切り替えます"}
                  onClick={() => setIncludeRegionAnnotations((current) => !current)}
                >指示範囲 {activeRegionAnnotations.length}件 · {regionsWillSend ? "送信する" : "保留"}</button>}
                {referenceAttachments.length > 0 && <span className="context-target-chip"><span className="context-icon" aria-hidden="true">📎</span>参照資料 {referenceAttachments.length}件</span>}
                {activeAnnotations.length > 0 && <AnnotationLegend annotations={activeAnnotations} />}
              </div>
              {referenceAttachments.length > 0 && <div className="reference-attachments" role="list" aria-label="添付ファイル">
                {referenceAttachments.map((attachment) => <div className="context-chip reference-attachment" role="listitem" key={attachment.path}>
                  <span className="context-icon" aria-hidden="true">📎</span>
                  <span className="reference-attachment-name" title={attachment.name}>{attachment.name}</span>
                  <span>{formatBytes(attachment.size)}</span>
                  <button type="button" aria-label={`${attachment.name}を添付から外す`} onClick={() => setReferenceAttachments((current) => current.filter((item) => item.path !== attachment.path))}>×</button>
                </div>)}
              </div>}
              <textarea ref={promptRef} value={promptDraft} onChange={onPromptChange} onCompositionStart={() => { compositionRef.current = true; }} onCompositionEnd={onPromptCompositionEnd} onKeyDown={onPromptKeyDown} placeholder={agentReady ? "Agentにこのスライドの編集を依頼…" : "Codexへの接続を待っています…"} aria-label="Agentへのメッセージ" aria-busy={turnBusy} maxLength={20000} disabled={!agentReady} />
              <div className="chat-actions">
                <input ref={referenceInputRef} className="sr-only" type="file" multiple onChange={(event) => { if (event.target.files) void uploadReferences(event.target.files); }} />
                <button className={`attach-button${openPopover === "references" ? " active" : ""}`} type="button" onClick={(event) => togglePopover("references", event.currentTarget)} disabled={!agentReady} aria-expanded={openPopover === "references"} aria-haspopup="dialog" aria-label="参照資料" title="Agentへ渡すファイルやフォルダーを選びます">📎</button>
                {codexState.catalog.models.length > 0 && selectedModelInfo && (
                  <div className="agent-model-control">
                    <button className="agent-model-button" type="button" onClick={(event) => togglePopover("agentModel", event.currentTarget)} disabled={turnBusy} aria-expanded={openPopover === "agentModel"} aria-haspopup="menu" title="Agentのモデルと推論レベルを選びます"><span className="agent-model-name">{selectedModelInfo.displayName ?? selectedModelInfo.name ?? selectedModelInfo.id ?? selectedModelInfo.model}</span><span className="agent-effort-value">{reasoningEffort}</span><b aria-hidden="true">⌄</b></button>
                    {openPopover === "agentModel" && (
                      <>
                        <div className="popover-backdrop" role="presentation" onPointerDown={() => dismissPopover()} />
                        <div className="agent-model-popover" role="menu" aria-label="Agentのモデルと推論レベル">
                          <section role="group" aria-label="モデル"><strong>モデル</strong>{codexState.catalog.models.map((model: any) => { const modelId = model.id ?? model.model; return <button key={modelId} role="menuitemradio" aria-checked={selectedModel === modelId} className={selectedModel === modelId ? "active" : ""} disabled={turnBusy} onClick={() => { const nextEffort = model.supportedReasoningEfforts?.map((option: any) => option.reasoningEffort).includes(reasoningEffort) ? reasoningEffort : model.defaultReasoningEffort ?? model.supportedReasoningEfforts?.[0]?.reasoningEffort ?? reasoningEffort; agentModelStore.write({ model: modelId, effort: nextEffort }); dismissPopover(false); }}><span>{model.displayName ?? model.name ?? model.id ?? model.model}</span>{selectedModel === modelId && <b aria-hidden="true">✓</b>}</button>; })}</section>
                          <section role="group" aria-label="推論レベル"><strong>推論レベル</strong>{availableEfforts.map((effort: string) => <button key={effort} role="menuitemradio" aria-checked={reasoningEffort === effort} className={reasoningEffort === effort ? "active" : ""} disabled={turnBusy} onClick={() => { agentModelStore.write({ model: selectedModel, effort }); dismissPopover(false); }}><span>{effort}</span>{reasoningEffort === effort && <b aria-hidden="true">✓</b>}</button>)}</section>
                        </div>
                      </>
                    )}
                  </div>
                )}
                <span className="chat-shortcut">⌘ / Ctrl ↵</span>
                <span className="chat-actions-spacer" aria-hidden="true" />
                <button className={`stop-button${agentRunning ? " active" : ""}`} onClick={() => { if (agentRunning) void interruptAgent(); }} disabled={!agentRunning} aria-hidden={!agentRunning} tabIndex={agentRunning ? 0 : -1} aria-label="Agentを停止" title="実行中のAgentを停止します">■</button>
                <button className="send-button" onClick={() => void sendMessage()} disabled={!agentReady || !(canSendTurn(promptDraft, sendableAnnotations) || referenceAttachments.length > 0) || turnSubmission.phase !== "idle" || !canSubmitAgentMessage} aria-label="メッセージを送信" data-help="入力内容と選択中の編集コンテキストをAgentへ送信します">↑</button>
              </div>
            </div>
            </div>
          </section> : activityView === "history" ? historySidebar : activityView === "shortcuts" ? shortcutsSidebar : activityView === "skills" ? skillsSidebar : settingsSidebar}
        </aside> : <button className="open-agent-panel" onClick={() => setLeftPanelOpen(true)}>{activityLabel}を開く</button>}

        <section className="center-stage">
          <div className="editor-tabs">
            <div className="variation-tabs">
              {variations.length > 0 && <button className={activeVariation === "main" ? "active" : ""} onClick={() => void checkoutVariation("main")}><span className="variation-dot dot-0" />通常編集</button>}
              {variations.map((variation, index) => (
                <button key={variation.branch} className={activeVariation === variation.branch ? "active" : ""} onClick={() => void checkoutVariation(variation.branch)}>
                  <span className={`variation-dot dot-${index + 1}`} />探索 {String.fromCharCode(65 + index)}<small>{variation.status === "ready" ? "比較できます" : variation.status === "paused" ? "保留中" : variation.status === "archived" ? "終了" : "生成中"}</small>
                </button>
              ))}
              <button className="add-variation" onClick={() => setShowVariationPrompt(!showVariationPrompt)} aria-label="探索セッションを追加">＋</button>
              {variations.length > 0 && <button className="compare-variations" onClick={() => void openVariationCompare()} disabled={variationCompareLoading}>{variationCompareLoading ? "読み込み中…" : "探索案を比較"}</button>}
            </div>
            <div className="editor-tab-actions">
              {activeVariation.startsWith("weave/variation/") && (
                <>
                  <button className="archive-direction" onClick={() => void setExplorationState(activeVariation, "paused")}>保留</button>
                  <button className="archive-direction" onClick={() => void archiveVariation()}>探索を終了</button>
                  <button className="use-direction" onClick={() => void acceptVariation()}>案全体を採用</button>
                </>
              )}
              <div className="view-toggle" role="group" aria-label="編集表示">
                <button className={mode === "preview" ? "active" : ""} onClick={() => { if (mode !== "preview") reinject(); setMode("preview"); }}>▣ <span>ビジュアル</span></button>
                <button className={mode === "split" ? "active" : ""} onClick={() => openSourceEditor("split")}>◫ <span>分割</span></button>
                <button className={mode === "source" ? "active" : ""} onClick={() => openSourceEditor("source")}>‹› <span>HTML編集</span></button>
              </div>
            </div>
          </div>

          <div className="canvas-area">
            {showVariationPrompt && (
              <div className="variation-prompt">
                <div><span>新しい探索セッション</span><button aria-label="探索セッションの作成を閉じる" onClick={() => setShowVariationPrompt(false)}>×</button></div>
                <label htmlFor="variation-prompt">どのような雰囲気にしますか？</label>
                <textarea id="variation-prompt" value={variationPrompt} maxLength={16000} onChange={(event) => setVariationPrompt(event.target.value)} />
                <button onClick={() => void generateVariation()} disabled={!agentReady || turnSubmission.phase !== "idle"}><span>✦</span> 探索案を生成</button>
                <small>生成中も通常編集や別のプロジェクトへ移動できます。</small>
              </div>
            )}
            {variationPreviews ? (
              <section className="variation-compare" aria-label="デザイン案の比較">
                <header><span><strong>探索案を比較</strong><small>差分のあるスライドと取り込む範囲を選べます</small></span><div className="variation-compare-controls"><button className={variationDiffOnly ? "active" : ""} aria-pressed={variationDiffOnly} onClick={() => setVariationDiffOnly((value) => !value)}>差分だけ</button><button className={variationComparisonMode === "side-by-side" ? "active" : ""} onClick={() => setVariationComparisonMode("side-by-side")}>左右比較</button><button className={variationComparisonMode === "overlay" ? "active" : ""} onClick={() => setVariationComparisonMode("overlay")}>重ねて比較</button><button onClick={() => setVariationPreviews(null)}>比較を閉じる</button></div></header>
                <div className="variation-compare-grid" data-mode={variationComparisonMode}>
                  {variationPreviews.filter((preview) => !variationDiffOnly || preview.branch === "main" || preview.deck.slides[activeSlide - 1]?.html !== variationPreviews.find((item) => item.branch === "main")?.deck.slides[activeSlide - 1]?.html).map((preview) => {
                    const previewSlide = preview.deck.slides[Math.min(activeSlide - 1, preview.deck.slides.length - 1)];
                    let html = "";
                    try { html = previewSlide ? composeFor(previewSlide, Math.min(activeSlide, preview.deck.slides.length), preview.deck.slides.length) : ""; } catch { html = ""; }
                    return <article key={preview.branch} className={preview.branch === activeVariation ? "active" : ""}>
                      <div className="variation-card-preview"><style>{preview.css}</style><div dangerouslySetInnerHTML={{ __html: displayAssetHtml(html) }} /></div>
                      <footer><span><strong>{preview.branch === "main" ? "通常編集" : preview.label}</strong><small>{previewSlide?.title || "無題"}</small><small>{preview.branch === "main" ? "比較の基準" : "Agent要約: 構成・表現・配色の変更を含む案"}</small></span>{preview.branch !== "main" && previewSlide && <button onClick={() => void importExplorationSlide(preview.branch, previewSlide.id)}>このスライドだけ取り込む</button>}<button onClick={async () => { setVariationPreviews(null); await checkoutVariation(preview.branch); }}>案を開く</button></footer>
                    </article>;
                  })}
                </div>
              </section>
            ) : mode === "preview" ? (
              <div className={`slide-shell ${previewHighlightSlideId === activeSlideId ? "agent-preview-highlight" : ""}`}>
                {/* The project stylesheet is the only thing styling the slide; the editor's
                    own chrome lives in globals.css and never overlaps these rules. */}
                <style>{deckCss}</style>
                <div className={`canvas-interaction-status ${agentPreview || agentCompletion !== null ? "agent-preview" : pointerPicking ? "picking" : annotationMode ? "annotating" : recalledAnnotations.length > 0 ? "recalling" : draggedId ? "dragging" : editingId ? "editing" : selectedId ? "selected" : ""}`} role={agentPreview || agentCompletion !== null ? undefined : "status"} aria-live={agentPreview || agentCompletion !== null ? undefined : "polite"} aria-busy={agentPreview !== null}>
                  {agentPreview
                    ? agentPreview.phase === "finalizing"
                      ? "● Agentが最終確認中"
                      : agentPreview.changedSlideIds.length > 0
                        ? `● Agentが編集中 · ${agentPreview.changedSlideIds.length}枚を変更`
                        : agentPreview.phase === "checking" ? "● Agentが依頼を確認中" : "● Agentがスライドを編集中"
                    : agentCompletion !== null
                    ? `● ${agentCompletion}枚のスライドを更新`
                    : pointerPicking
                    ? "要素を指定中 · Agentへ示す要素をクリック · Escでキャンセル"
                    : annotationMode
                    ? `Mark for Agent · 変更したい範囲をドラッグ${recalledAnnotations.length > 0 ? ` · ${activeOverlayLabel}と比較中` : ""}`
                    : recalledAnnotations.length > 0
                      ? `送信済みの指示と比較中 · ${activeOverlayLabel}`
                      : draggedId ? "ブロックを移動中 · 離して配置" : editingId ? "テキストを編集中 · Escで終了" : selectedId ? "選択中 · ドラッグで並べ替え" : "ブロックをクリックして選択"}
                </div>
                <div
                  className="slide-viewport"
                  data-zoom-mode={zoomMode}
                  data-annotation-mode={annotationMode ? "true" : undefined}
                  data-pointer-picking={pointerPicking ? "true" : undefined}
                  ref={(node) => { viewportRef.current = node; canvasRef.current = node; }}
                  style={{ "--slide-scale": slideScale } as React.CSSProperties}
                  onPointerDown={onCanvasPointerDown}
                  onPointerMove={onCanvasPointerMove}
                  onPointerUp={onCanvasPointerEnd}
                  onPointerCancel={onCanvasPointerEnd}
                  onDoubleClick={onCanvasDoubleClick}
                  onBlurCapture={onCanvasBlurCapture}
                  onKeyDown={onCanvasKeyDown}
                  onDragStart={onCanvasDragStart}
                  onDragOver={onCanvasDragOver}
                  onDrop={onCanvasDrop}
                  onPaste={onCanvasPaste}
                  onDragEnd={onCanvasDragEnd}
                />
                <div
                  className="annotation-overlay"
                  style={{ "--slide-scale": slideScale } as React.CSSProperties}
                >
                  <AnnotationOverlay
                    interactive={annotationMode}
                    pointerPicking={pointerPicking}
                    pointerCandidates={pointerCandidates}
                    annotations={activeAnnotations}
                    recalledAnnotations={recalledAnnotations}
                    selectedId={selectedAnnotationId}
                    draftRect={draftAnnotationRect}
                    focusAnnotationId={focusAnnotationId}
                    scrollRef={annotationScrollRef}
                    onFocusHandled={() => setFocusAnnotationId(null)}
                    onPointerPick={pickPointerElement}
                    onPointerPickCancel={() => { setPointerPicking(false); setAnnouncement("要素の指定をキャンセルしました"); }}
                    onSelect={setSelectedAnnotationId}
                    onLabelChange={(id, label) => setAnnotations((current) => current.map((annotation) => annotation.id === id ? { ...annotation, label } : annotation))}
                    onDelete={deleteAnnotation}
                    onGestureStart={onAnnotationGestureStart}
                    onGestureMove={onAnnotationGestureMove}
                    onGestureEnd={onAnnotationGestureEnd}
                  />
                </div>
                {changedReview.length > 0 && <div className="changed-review" role="status">
                  <span><strong>Agentの変更</strong><small>{changedReviewIndex + 1} / {changedReview.length}</small></span>
                  <button onClick={() => reviewChangedTarget(changedReviewIndex - 1)} aria-label="前の変更箇所">←</button>
                  <button onClick={() => reviewChangedTarget(changedReviewIndex + 1)} aria-label="次の変更箇所">→</button>
                  <button onClick={() => { setChangedReview([]); setSelectedId(null); }}>確認完了</button>
                </div>}
                {(structuredChanges.length > 0 || mergeConflicts.length > 0) && <details className="change-review-panel">
                  <summary>変更レビュー <strong>{structuredChanges.length + mergeConflicts.length}件</strong></summary>
                  {mergeConflicts.length > 0 && <section className="merge-conflicts" aria-label="競合の解決"><header><strong>同じ箇所の競合</strong><small>箇所ごとに残す内容を選んでください</small></header>{mergeConflicts.map((conflict) => <article key={conflict.path}>
                    <strong>{conflict.slideId ? `スライド ${conflict.slideId}` : "デッキ全体"}{conflict.elementId ? ` · ${conflict.elementId}` : ""}</strong>
                    <p>{conflict.explanation}</p>
                    <div className="change-before-after"><span><small>現在の編集</small><code>{typeof conflict.current === "string" ? conflict.current.slice(0, 180) : JSON.stringify(conflict.current)?.slice(0, 180)}</code></span><span><small>Agentの変更</small><code>{typeof conflict.agent === "string" ? conflict.agent.slice(0, 180) : JSON.stringify(conflict.agent)?.slice(0, 180)}</code></span></div>
                    <footer><button onClick={() => resolveMergeConflict(conflict, "current")}>現在の編集を保持</button><button onClick={() => resolveMergeConflict(conflict, "agent")}>Agentの変更を採用</button></footer>
                  </article>)}</section>}
                  <header><span>意味単位の変更セット</span><button onClick={() => applyReviewGroup({ kind: "all" })}>すべて戻す</button></header>
                  <div className="change-review-list">{structuredChanges.map((change) => <article key={change.id} data-reverted={revertedChangeIds.has(change.id) ? "true" : undefined}>
                    <button className="change-target" onClick={() => { const index = slidesRef.current.findIndex((slide) => slide.id === change.slideId); if (index >= 0) switchSlide(index + 1); if (change.elementId) setSelectedId(change.elementId); }}><strong>{change.slideId ? `スライド ${change.slideId}` : "デッキ全体"}</strong><span>{change.type === "text" ? "テキスト変更" : change.type === "style" ? "スタイル変更" : change.type === "layout" ? "レイアウト変更" : change.type}</span></button>
                    <p>{change.reason}</p>
                    <div className="change-before-after"><span><small>変更前</small><code>{typeof change.before === "string" ? change.before.slice(0, 180) : JSON.stringify(change.before)?.slice(0, 180)}</code></span><span><small>変更後</small><code>{typeof change.after === "string" ? change.after.slice(0, 180) : JSON.stringify(change.after)?.slice(0, 180)}</code></span></div>
                    <footer><button onClick={() => applyReviewChange(change)}>{revertedChangeIds.has(change.id) ? "この変更を再適用" : "この変更だけ戻す"}</button>{change.slideId && <button onClick={() => applyReviewGroup({ kind: "slide", slideId: change.slideId })}>このスライドを戻す</button>}</footer>
                  </article>)}</div>
                </details>}
                {selectedId && sel && !annotationMode && <div className="selection-toolbar" data-placement={selectionToolbarPosition.placement} style={{ left: selectionToolbarPosition.left, top: selectionToolbarPosition.top }} role="toolbar" aria-label="選択した要素の簡易操作">
                  {!sel.container && sel.kind !== "image" && <button onClick={beginEditSelected}>編集</button>}
                  {!sel.container && sel.kind !== "image" && <button aria-label="太字を切り替える" onClick={() => { const node = selectedNode(); if (!node) return; checkpoint(); node.classList.toggle("font-bold"); syncFromDom(); markDirty(); }}>太字</button>}
                  {agentReady && <button onClick={referenceSelectedElement}>Agentへ指示</button>}
                  <button className="mobile-detail-action" onClick={() => { setLeftPanelOpen(false); setInspectorOpen(true); setMobileView("inspector"); }}>詳細</button>
                  <button onClick={copySelectedStyle}>スタイルをコピー</button>
                  <button onClick={pasteSelectedStyle} disabled={styleClipboard === null}>貼り付け</button>
                  {!outline.some((item) => item.id === selectedId && item.locked) && <button onClick={duplicateSelected}>複製</button>}
                  {outline.length > 1 && !outline.some((item) => item.id === selectedId && item.locked) && <button className="danger" onClick={deleteSelected}>削除</button>}
                </div>}
                <div className="canvas-toolbar">
                  <div className="canvas-tool-group history-tools" role="group" aria-label="編集履歴">
                    <button onClick={undo} disabled={annotationMode || historyState.undo === 0} aria-label="元に戻す" title="直前の編集を元に戻します">↶</button>
                    <button onClick={redo} disabled={annotationMode || historyState.redo === 0} aria-label="やり直す" title="元に戻した編集をやり直します">↷</button>
                  </div>
                  <div className="canvas-tool-group content-tools" role="group" aria-label="スライド内容">
                    <button onClick={(event) => togglePopover("addBlock", event.currentTarget)} className={openPopover === "addBlock" ? "active" : ""} aria-expanded={openPopover === "addBlock"} aria-haspopup="menu" disabled={annotationMode}>＋ ブロックを追加</button>
                    <input ref={imageInputRef} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadImage(file); }} />
                  </div>
                  <div className="canvas-tool-group zoom-tools" role="group" aria-label="キャンバスの拡大率">
                    <button aria-label="縮小" aria-keyshortcuts="Control+- Meta+-" onClick={() => setManualZoom(Math.max(.25, slideScale - .1))}>−</button>
                    <b aria-live="polite">{Math.round(slideScale * 100)}%</b>
                    <button aria-label="拡大" aria-keyshortcuts="Control++ Meta++" onClick={() => setManualZoom(Math.min(4, slideScale + .1))}>＋</button>
                    <button aria-label="実寸で表示" onClick={() => setManualZoom(defaultCanvasZoom)}>実寸</button>
                    <button className={zoomMode === "fit" ? "active" : ""} aria-label={`画面に合わせる・現在${Math.round(slideScale * 100)}%`} onClick={() => setManualZoom(null)}>画面に合わせる</button>
                    <button
                      className={canvasFocused ? "active" : ""}
                      aria-label={canvasFocused ? "集中表示を終了" : "キャンバスに集中"}
                      aria-pressed={canvasFocused}
                      title={canvasFocused ? "編集パネルを表示します" : "パネルを隠してキャンバスを広く表示します"}
                      onClick={() => setCanvasFocused((value) => !value)}
                    >⛶</button>
                  </div>
                  <div className="canvas-tool-group annotation-tools" role="group" aria-label="Agentへの範囲指定">
                    <button
                      className={annotationMode ? "active" : ""}
                      aria-pressed={annotationMode}
                      aria-keyshortcuts="A"
                      title="変更したい範囲を囲んでAgentへ指示します（A）"
                      onClick={toggleAnnotationMode}
                    >▱ <span>Mark for Agent</span></button>
                  </div>
                </div>
                {openPopover === "addBlock" && (
                  <>
                    <div className="popover-backdrop" role="presentation" onPointerDown={() => dismissPopover()} />
                    <div className="block-picker" role="menu">
                      <small>{sel?.container ? `${blockLabels[sel.kind] ?? sel.kind}の中に追加` : "ブロックを追加"}</small>
                      {blockKinds.map((kind) => (
                        <button key={kind} role="menuitem" onClick={() => addBlock(kind)}>
                          <i>{blockIcons[kind]}</i>
                          <span><strong>{blockLabels[kind]}</strong><small>{sel?.container ? "選択中のコンテナ内へ追加" : "スライドの流れへ追加"}</small></span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className={`source-workspace ${mode === "split" ? "split" : "source-only"}`}>
                {mode === "split" && <div className="source-preview" aria-label="HTML編集のプレビュー"><style>{deckCss}</style><div dangerouslySetInnerHTML={{ __html: displayAssetHtml(sourcePreviewHtml) }} /></div>}
                <section className="code-editor" aria-label="HTMLソース編集">
                  <div className="code-breadcrumb"><span>スライドHTML</span><strong>{slides[activeSlide - 1]?.id}.html</strong><span>未確定のHTMLはキャンバスへ反映されません</span></div>
                  <div className="source-search" role="search"><input value={sourceSearch} onChange={(event) => setSourceSearch(event.target.value)} placeholder="検索" aria-label="HTMLを検索" /><input value={sourceReplace} onChange={(event) => setSourceReplace(event.target.value)} placeholder="置換" aria-label="置換後の文字" /><button onClick={replaceSourceMatches} disabled={!sourceSearch}>すべて置換</button></div>
                  <div className="source-buffer-wrap">
                    <pre aria-hidden="true">{sourceBuffer}</pre>
                    <textarea ref={sourceEditorRef} value={sourceBuffer} spellCheck={false} aria-label="スライドHTML" onChange={(event) => { setSourceBuffer(event.target.value); setSourceDiagnostics(validateEditableSlideSource(event.target.value)); }} onSelect={(event) => { const id = sourceElementIdAtOffset(sourceBuffer, event.currentTarget.selectionStart); if (id) setSelectedId(id); }} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); applySourceBuffer(); } if (event.key === "Tab") { event.preventDefault(); const target = event.currentTarget; const start = target.selectionStart; const next = `${sourceBuffer.slice(0, start)}  ${sourceBuffer.slice(target.selectionEnd)}`; setSourceBuffer(next); requestAnimationFrame(() => target.setSelectionRange(start + 2, start + 2)); } }} />
                  </div>
                  <footer className="source-actions"><span role="status" className={sourceDiagnostics.length ? "source-invalid" : "source-valid"}>{sourceDiagnostics.length ? `${sourceDiagnostics.length}件のエラー` : "HTMLは有効です"}</span><button onClick={applySourceBuffer} disabled={sourceDiagnostics.length > 0}>検証して反映</button></footer>
                  {sourceDiagnostics.length > 0 && <ol className="source-diagnostics" aria-label="HTML検証エラー">{sourceDiagnostics.map((problem, index) => <li key={`${problem.line}-${problem.column}-${index}`}><button onClick={() => { const lines = sourceBuffer.split("\n"); const offset = lines.slice(0, problem.line - 1).reduce((sum, line) => sum + line.length + 1, 0) + problem.column - 1; sourceEditorRef.current?.focus(); sourceEditorRef.current?.setSelectionRange(offset, offset); }}><strong>{problem.message}</strong><span>行 {problem.line}, 列 {problem.column}</span></button></li>)}</ol>}
                </section>
              </div>
            )}
          </div>

          {slideNav === "filmstrip" && <nav className="slide-nav filmstrip" aria-label="スライド一覧">{slideNavigator}</nav>}
        </section>

        {inspectorOpen ? <aside className="inspector">
          <div className="context-panel-switcher" role="tablist" aria-label="コンテキストパネル"><button role="tab" aria-selected="true">デザイン</button><button role="tab" aria-selected="false" onClick={() => { setInspectorOpen(false); setActivityView("agent"); setLeftPanelOpen(true); }}>Agent</button><button role="tab" aria-selected="false" onClick={() => { setInspectorOpen(false); setChangedReviewIndex(0); }}>変更レビュー{changedReview.length > 0 ? ` ${changedReview.length}` : ""}</button></div>
          <div className="inspector-heading"><span>詳細インスペクター</span><button aria-label="インスペクターを閉じる" onClick={() => setInspectorOpen(false)}>×</button></div>
          <div className="inspector-tabs" role="tablist" aria-label="インスペクターの表示">
            <button role="tab" aria-selected={inspectorView === "layers"} className={inspectorView === "layers" ? "active" : ""} onClick={() => setInspectorView("layers")}>レイヤー</button>
            <button role="tab" aria-selected={inspectorView === "design"} className={inspectorView === "design" ? "active" : ""} onClick={() => setInspectorView("design")}>デザイン</button>
          </div>
          {inspectorView === "layers" && <><div className="selection-path"><span>コンテンツ</span><b>›</b><strong>{sel ? `${blockLabels[sel.kind] ?? sel.kind}.${sel.id}` : "未選択"}</strong></div>
          <section className="layer-tree">
            <button type="button" className="property-heading" aria-expanded={objectTreeOpen} onClick={() => setObjectTreeOpen((open) => !open)}>
              <span>オブジェクト一覧</span><span className="tree-heading-summary"><span>{outline.length}</span><span className="tree-toggle-glyph" aria-hidden="true">⌃</span></span>
            </button>
            {objectTreeOpen && <div className={`layer-tree-body ${treeDragId ? "dragging-tree" : ""}`} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTreeDrop(null); }}>
              <span
                className={`tree-root ${treeDrop && treeDrop.id === null ? "drop-inside" : ""}`}
                onDragOver={(event) => onTreeDragOver(event, null)}
                onDrop={(event) => onTreeDrop(event, null)}
              >⌄ <b>content</b></span>
              {outline.map((item) => (
                <button
                  key={item.id}
                  style={{ paddingLeft: 14 + item.depth * 14 }}
                  className={[selectedId === item.id ? "active" : "", treeDragId === item.id ? "dragging" : "", treeDrop?.id === item.id ? `drop-${treeDrop.position}` : ""].filter(Boolean).join(" ")}
                  draggable={!annotationMode && !item.locked}
                  onClick={() => setSelectedId(item.id)}
                  onDragStart={(event) => { if (annotationMode || item.locked) { event.preventDefault(); return; } event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.id); setTreeDragId(item.id); setSelectedId(item.id); }}
                  onDragOver={(event) => onTreeDragOver(event, item)}
                  onDrop={(event) => onTreeDrop(event, item)}
                  onDragEnd={() => { setTreeDragId(null); setTreeDrop(null); }}
                >
                  <i>{blockIcons[item.kind] ?? "▦"}</i><span>{item.label}</span>{quality.diagnostics.some((diagnostic) => diagnostic.elementId === item.id) && <b className="layer-diagnostic" aria-label="品質上の指摘あり">!</b>}<small>{item.locked ? "固定" : item.container ? "コンテナ" : "ブロック"}</small>
                </button>
              ))}
            </div>}
          </section></>}
          {inspectorView === "design" && <>
          <div className="selection-path"><span>コンテンツ</span><b>›</b><strong>{sel ? `${blockLabels[sel.kind] ?? sel.kind}.${sel.id}` : "スライド"}</strong></div>
          {annotationMode && <div className="annotation-inspector-notice" role="status">Mark for Agentでは範囲だけを指定できます。指定中は通常編集が無効になります。</div>}
          <fieldset className="inspector-editing" disabled={annotationMode}>
          {sel && (
            <>
              {/* What every block has, whatever it is. A block is a flex child before it is a
                  heading or a row, so its width and its place in the parent come first. Details a
                  choice here calls for follow it inline, where the choice is still in view. */}
              <section className="property-section">
                <div className="property-heading"><span>ブロック</span><span>{blockLabels[sel.kind] ?? sel.kind}</span></div>
                <div className="property-origin"><span>値の由来</span><strong>{selectedNode()?.className ? "この要素で個別指定" : "テーマ／親から継承"}</strong><button type="button" onClick={resetSelectedOverrides}>継承へ戻す</button></div>
                {sel.kind === "metrics" && <p className="property-constraint" role="note"><strong>変更できる範囲が限定されています</strong>Metricsは固定列構造のため、方向変更は利用できません。子要素の配置競合を防ぎます。</p>}
                {sel.read.parentLayout !== "column" && <p className="property-impact" role="note">この要素のサイズ変更は、同じ親にある兄弟要素の利用可能領域にも影響します。</p>}
                {sel.read.parentLayout !== "grid" && (
                  <div className="property-row">
                    <span>幅</span>
                    <div className="scale-options">
                      {sizeIntents.filter((opt: { value: string }) => opt.value !== "ratio" || sel.read.parentLayout === "row").map((opt: { value: string; label: string }) => (
                        <button key={opt.value} className={sel.read.size === opt.value ? "active" : ""} onClick={() => setSize(opt.value)}>{({ Fill: "広げる", Hug: "内容に合わせる", Fixed: "固定", Ratio: "比率" } as Record<string, string>)[opt.label]}</button>
                      ))}
                    </div>
                  </div>
                )}
                {sel.read.size === "ratio" && sel.read.parentLayout === "row" && (
                  <div className="property-row"><span>比率</span><div className="scale-options">{ratioOptions.map((opt: { value: string; label: string }) => <button key={opt.value} className={sel.read.ratio === opt.value ? "active" : ""} onClick={() => setRatio(opt.value)}>{opt.label}</button>)}</div></div>
                )}
                {sel.read.parentLayout === "grid" && (
                  <div className="property-row"><span>占有範囲</span><div className="scale-options">{[{ value: "", label: "1" }, { value: "col-span-2", label: "列 2" }, { value: "col-span-3", label: "列 3" }, { value: "row-span-2", label: "行 2" }].map((opt) => <button key={opt.value || "one"} className={sel.read.span === opt.value ? "active" : ""} onClick={() => setSpan(opt.value)}>{opt.label}</button>)}</div></div>
                )}
                {/* Measure is the number Fixed stops at, so it belongs directly under the choice
                    that calls for it — not filed away somewhere the trigger cannot be seen. */}
                {propertyRows(sel.read.size === "fixed" ? advancedSchema : [])}
                {/* Placing the block is its own business only when it stacks in a column; inside a
                    Row that is the parent's Justify, which lives under the parent's own heading. */}
                {sel.read.parentLayout === "column" && sel.read.size !== "fill" && (
                  <div className="property-row">
                    <span>位置</span>
                    <div className="scale-options">
                      {blockPositionOptions.map((opt: { value: string; label: string }) => (
                        <button key={opt.value} className={sel.read.blockPosition === opt.value ? "active" : ""} onClick={() => setBlockPosition(opt.value)}>{optionLabels[opt.label]}</button>
                      ))}
                    </div>
                  </div>
                )}
                {propertyRows(marginSchema)}
              </section>
              {/* What this kind of block can do that others cannot — arrange children, or set type.
                  Position and Align items stay under separate headings, as they must. */}
              <section className="property-section">
                <div className="property-heading"><span>{containerLike ? "コンテナ" : sel.kind === "image" ? "画像サイズ" : "テキスト"}</span></div>
                {containerLike && (
                  <div className="property-row">
                    <span>方向</span>
                    <div className="scale-options">
                      {[{ label: "横並び", value: "row" }, { label: "縦並び", value: "column" }, { label: "グリッド", value: "grid" }].map((opt) => (
                        <button key={opt.value} className={(sel.read.direction || "row") === opt.value ? "active" : ""} onClick={() => setDirection(opt.value)}>{opt.label}</button>
                      ))}
                    </div>
                  </div>
                )}
                {containerLike && sel.read.direction === "grid" && <div className="property-row"><span>列数</span><div className="scale-options">{[2, 3, 4].map((count) => <button key={count} className={sel.read.columns === `grid-cols-${count}` ? "active" : ""} onClick={() => setColumns(`grid-cols-${count}`)}>{count}</button>)}</div></div>}
                {propertyRows(containerLike ? containerSchema : sel.kind === "image" ? [] : textSchema)}
                {sel.kind === "list" && propertyRows(listSchema)}
                {!containerLike && sel.kind !== "image" && <div className="property-row"><span>選択範囲</span><div className="scale-options"><button onMouseDown={(event) => event.preventDefault()} onClick={() => formatSelection("strong")}>太字</button><button onMouseDown={(event) => event.preventDefault()} onClick={() => formatSelection("span")}>アクセント</button></div></div>}
              </section>
              {sel.kind === "image" && <section className="property-section"><div className="property-heading"><span>画像</span></div>{propertyRows(imageSchema)}<label><span>代替テキスト</span><input value={sel.read.alt} onChange={(event) => setAlt(event.target.value)} /></label><button className="inspector-action" onClick={() => { replacingImageRef.current = true; imageInputRef.current?.click(); }}>画像を置き換え</button></section>}
              {containerLike && <section className="property-section"><div className="property-heading"><span>装飾</span></div>{propertyRows(decorationSchema)}</section>}
              {sel.kind === "table" && <section className="property-section"><div className="property-heading"><span>表</span></div><div className="table-actions"><button onClick={() => editTable("add-row")}>＋ 行</button><button onClick={() => editTable("remove-row")}>− 行</button><button onClick={() => editTable("add-column")}>＋ 列</button><button onClick={() => editTable("remove-column")}>− 列</button></div></section>}
            </>
          )}
          <section className="property-section">
            <div className="property-heading"><span>スライド</span><span>⌃</span></div>
            <label><span>タイトル</span><input value={titleDraft ?? slides[activeSlide - 1]?.title ?? ""} onFocus={(event) => setTitleDraft(event.currentTarget.value)} onChange={(event) => { setTitleDraft(event.target.value); setSlideTitle(event.target.value); }} onBlur={() => setTitleDraft(null)} /></label>
            <label><span>発表者ノート</span><textarea value={slides[activeSlide - 1]?.notes ?? ""} onChange={(event) => setSlideNotes(event.target.value)} /></label>
          </section>
          <section className="property-section layout-section">
            <div className="property-heading"><span>スライドレイアウト</span><span>⌃</span></div>
            <button className="layout-select" onClick={(event) => togglePopover("layouts", event.currentTarget)} aria-expanded={openPopover === "layouts"} aria-haspopup="listbox">
              {currentTemplate && currentLayout ? templatePreview(currentTemplate, "current-layout", currentLayout.id) : <span className="template-preview template-preview-empty" />}
              <span><strong>{currentLayout?.name ?? currentTemplate?.name ?? "カスタム"}</strong><small>{currentTemplate ? currentTemplate.name : "一致するテンプレートなし"}</small></span>
              <b>⌄</b>
            </button>
            {openPopover === "layouts" && (
              <>
                <div className="popover-backdrop" role="presentation" onPointerDown={() => dismissPopover()} />
                <div className="template-options layout-options" role="listbox" aria-label="スライドレイアウト">
                  {templates.map((template) => (
                    <div className="template-group" key={template.id}>
                      <strong className="template-group-name">{template.name}</strong>
                      {template.layouts.map((layout) => <button
                        key={`${template.id}-${layout.id}`}
                        role="option"
                        aria-selected={currentSlide?.templateId === template.id && currentSlide.layoutId === layout.id}
                        onPointerEnter={() => previewTemplate(template.id, layout.id)}
                        onPointerLeave={cancelTemplatePreview}
                        onFocus={() => previewTemplate(template.id, layout.id)}
                        onBlur={cancelTemplatePreview}
                        onClick={() => applyTemplate(template.id, layout.id)}
                      >{templatePreview(template, `layout-list-${layout.id}`, layout.id)}<span>{layout.name}</span></button>)}
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
          <section className="accent-section">
            <span>アクセントカラー</span>
            <div>{accents.map((item) => <button key={item.color} style={{ background: item.color }} className={accent === item.color ? "active" : ""} onClick={() => setSlideAccent(item.color)} aria-label={`アクセントカラーを${item.color}に変更`} />)}</div>
          </section>
          {sel && outline.length > 1 && !outline.some((item) => item.id === selectedId && item.locked) && <button className="delete-block" onClick={deleteSelected}>選択中のブロックを削除</button>}
          </fieldset>
          </>}
        </aside> : <button className="open-inspector" onClick={() => { setLeftPanelOpen(false); setInspectorOpen(true); }}>デザイン</button>}
        <nav className="mobile-tabs" aria-label="作業画面">
          <button className={mobileView === "canvas" ? "active" : ""} aria-pressed={mobileView === "canvas"} onClick={() => setMobileView("canvas")}>キャンバス</button>
          <button className={mobileView === "slides" ? "active" : ""} aria-pressed={mobileView === "slides"} onClick={() => setMobileView("slides")}>スライド</button>
          <button className={mobileView === "agent" ? "active" : ""} aria-pressed={mobileView === "agent"} onClick={() => { setActivityView("agent"); setLeftPanelOpen(true); setMobileView("agent"); }}>Agent</button>
          <button className={mobileView === "more" ? "active" : ""} aria-pressed={mobileView === "more"} onClick={() => { setActivityView("settings"); setLeftPanelOpen(true); setMobileView("more"); }}>その他{qualityReport.errors + qualityReport.warnings > 0 ? ` · ${qualityReport.errors + qualityReport.warnings}` : ""}</button>
        </nav>
        <nav className="mobile-slide-panel slide-nav" aria-label="スライド一覧">{slideNavigator}</nav>
      </div>

      {galleryOpen && (
        <div ref={galleryRef} className="gallery" role="dialog" aria-modal="true" aria-labelledby="gallery-title" tabIndex={-1} onPointerDown={() => setGalleryMenu(null)}>
          <header className="gallery-head">
            {galleryView === "new" ? <button className="back-link" onClick={() => setGalleryView("list")}>← プロジェクト</button> : <h3 id="gallery-title">プロジェクト <span className="count">{galleryLoading ? "読み込み中…" : galleryProjects.length}</span></h3>}
            {galleryView === "new" && <h3 id="gallery-title">新しいプロジェクト</h3>}
            {galleryView === "list" && <button className="ghost-button" onClick={() => importRef.current?.click()}>編集用データを読み込む</button>}
            {apiError && <span className="gallery-error">{apiError}</span>}
            <button className="close-x" aria-label="プロジェクト一覧を閉じる" onClick={closeGallery}>×</button>
          </header>
          {galleryView === "new" ? (
            <div className="new-flow">
              <div className="template-row">
                {templates.map((template) => <div className={`project-card ${newProjectTemplate === template.id ? "selected" : ""}`} key={template.id}>
                  <button className="project-thumb" onClick={() => setNewProjectTemplate(template.id)} aria-label={`${template.name}テンプレートを選択`}>{templateThumbnail(template, template.name)}</button>
                  <div className="card-meta"><strong>{template.name}</strong><small>レイアウト {template.layouts.length}件</small></div>
                </div>)}
              </div>
              <div className="name-row">
                <label htmlFor="new-project-title">名前</label>
                <input id="new-project-title" className="name-field" value={newProjectTitle} onChange={(event) => setNewProjectTitle(event.target.value)} autoFocus />
                <code>workspaces/{projectSlug(newProjectTitle)}</code>
                <button className="ghost-button" onClick={() => setGalleryView("list")}>キャンセル</button>
                <button className="primary-button" disabled={!newProjectTitle.trim() || newProjectCreating} onClick={() => void createProject()}>{newProjectCreating ? "作成中…" : "作成して開く"}</button>
              </div>
            </div>
          ) : (
            <div className="gallery-body" onPointerDown={(event) => { if (event.target === event.currentTarget) setGalleryMenu(null); }}>
              {galleryLoading ? <p className="gallery-empty">読み込み中…</p> : <>
                {galleryProjects.length === 0 && <div className="gallery-empty"><strong>プロジェクトがありません</strong><span>新しいプロジェクトを作成してください。</span></div>}
                <div className="gallery-grid">
                  <button className="new-project-card" onClick={() => { setGalleryView("new"); setGalleryMenu(null); }}><b>＋</b><span>新しいプロジェクト</span></button>
                  {galleryProjects.map((item) => <div key={item.slug} className="project-card-wrap">
                    <button className={`project-card ${item.current ? "current" : ""}`} onClick={() => void switchProject(item)} disabled={!!gallerySwitching} aria-label={`${item.title}を開く`}>
                      <span className="project-thumb">
                        {gallerySwitching === item.slug ? <span className="thumb-loading">読み込み中…</span> : thumbHtml(item.thumbnailHtml, item.css, item.title)}
                        {item.current && <span className="card-pill">開いています</span>}
                      </span>
                      <span className="card-meta"><strong>{item.title}</strong><small>{item.current && !saved ? "ドラフト同期済み · マイルストーン未作成" : `${item.slideCount}枚 · ${relativeProjectTime(item.updatedAt)}`}</small></span>
                    </button>
                    <button className="kebab" aria-label={`${item.title}のメニュー`} aria-haspopup="menu" aria-expanded={galleryMenu === item.slug} onPointerDown={(event) => event.stopPropagation()} onClick={() => setGalleryMenu((current) => current === item.slug ? null : item.slug)}>⋯</button>
                    {galleryMenu === item.slug && <div className="card-menu" role="menu" onPointerDown={(event) => event.stopPropagation()}>
                      <button role="menuitem" onClick={() => { setRenameDraft(item.title); setGalleryDialog({ kind: "rename", slug: item.slug, title: item.title }); setGalleryMenu(null); }}><span>名前を変更</span><small>表示名を変更します</small></button>
                      <button role="menuitem" onClick={() => void galleryMutation(item.slug, "duplicate")}><span>複製</span><small>新しいプロジェクトとして保存します</small></button>
                      {!item.current && <button className="danger" role="menuitem" onClick={() => { setGalleryDialog({ kind: "archive", slug: item.slug, title: item.title }); setGalleryMenu(null); }}><span>アーカイブ</span><small>この一覧から移動します</small></button>}
                    </div>}
                  </div>)}
                </div>
              </>}
            </div>
          )}
          {galleryDialog && <><div className="scrim" onClick={() => setGalleryDialog(null)} />
            <div className="dialog" role="alertdialog" aria-modal="true">
              {galleryDialog.kind === "rename" && <><div className="dialog-body"><strong>プロジェクト名を変更</strong><input className="name-field" autoFocus value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void galleryMutation(galleryDialog.slug, "rename", renameDraft); }} /></div><div className="dialog-actions"><button className="ghost-button" onClick={() => setGalleryDialog(null)}>キャンセル</button><button className="primary-button" onClick={() => void galleryMutation(galleryDialog.slug, "rename", renameDraft)}>保存</button></div></>}
              {galleryDialog.kind === "archive" && <><div className="dialog-body"><strong>「{galleryDialog.title}」をアーカイブしますか？</strong><p>プロジェクトは削除されず、この一覧から移動します。</p></div><div className="dialog-actions"><button className="ghost-button" onClick={() => setGalleryDialog(null)}>キャンセル</button><button className="primary-button" onClick={() => void galleryMutation(galleryDialog.slug, "archive")}>アーカイブ</button></div></>}
            </div>
          </>}
        </div>
      )}

      {skillDialog && (
        <div className="skill-dialog-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget && skillBusyKey === null) setSkillDialog(null); }}>
          <form ref={skillDialogRef} className="skill-dialog" role="dialog" aria-modal="true" aria-labelledby="skill-dialog-title" onSubmit={(event) => void saveSkill(event)} onKeyDown={(event) => {
            if (event.key === "Escape" && skillBusyKey === null) {
              event.preventDefault();
              setSkillDialog(null);
              return;
            }
            if (event.key !== "Tab") return;
            const focusable = Array.from(skillDialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? []);
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
          }}>
            <header><strong id="skill-dialog-title">{skillDialog.mode === "create" ? "新しいスキル" : `${skillDialog.source?.name ?? "スキル"}を編集`}</strong><button type="button" aria-label="スキル編集を閉じる" onClick={() => { if (skillBusyKey === null) setSkillDialog(null); }}>×</button></header>
            <div className="skill-dialog-body">
              <label className="skill-dialog-field"><span>適用範囲</span><select value={skillDraft.scope} disabled={skillDialog.mode === "edit" || skillBusyKey !== null || agentRunning} onChange={(event) => setSkillDraft((current) => ({ ...current, scope: event.target.value as SkillScope }))}><option value="project">プロジェクト固有 · このデッキ</option><option value="common">共通 · すべてのプロジェクト</option></select></label>
              <label className="skill-dialog-field"><span>名前</span><input autoFocus className="skill-name-input" value={skillDraft.name} required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={63} disabled={skillBusyKey !== null || agentRunning} onChange={(event) => setSkillDraft((current) => ({ ...current, name: event.target.value }))} /><small className="skill-dialog-help">英小文字のkebab-case、63文字以内。</small></label>
              <label className="skill-dialog-field"><span>説明</span><input value={skillDraft.description} required maxLength={20000} disabled={skillBusyKey !== null || agentRunning} onChange={(event) => setSkillDraft((current) => ({ ...current, description: event.target.value }))} /></label>
              <label className="skill-dialog-field"><span>指示内容</span><textarea value={skillDraft.body} required maxLength={900000} disabled={skillBusyKey !== null || agentRunning} onChange={(event) => setSkillDraft((current) => ({ ...current, body: event.target.value }))} /></label>
              <label className="skill-dialog-field"><span>その他のYAML frontmatter <small>（任意）</small></span><textarea value={skillDraft.frontmatter} disabled={skillBusyKey !== null || agentRunning} onChange={(event) => setSkillDraft((current) => ({ ...current, frontmatter: event.target.value }))} placeholder={'license: MIT\nmetadata:\n  short-description: 例'} /></label>
              {skillStatus.state !== "idle" && <div className={`skill-status ${skillStatus.state}`} role={skillStatus.state === "error" ? "alert" : "status"} aria-live="polite" aria-busy={skillStatus.state === "busy"}>{skillStatus.message}</div>}
            </div>
            <footer className="skill-dialog-actions"><button type="button" onClick={() => setSkillDialog(null)} disabled={skillBusyKey !== null}>キャンセル</button><button className="primary-button" type="submit" disabled={skillBusyKey !== null || agentRunning || !skillDraft.name.trim() || !skillDraft.description.trim() || !skillDraft.body.trim()}>{skillBusyKey !== null ? "保存中…" : skillDialog.mode === "create" ? "スキルを作成" : "変更を保存"}</button></footer>
          </form>
        </div>
      )}

      <footer className="statusbar">
        <div>
          <button className={`quality-button ${qualityReport.ok ? "ok" : "error"}`} onClick={(event) => togglePopover("quality", event.currentTarget)} aria-expanded={openPopover === "quality"}>品質 {qualityReport.errors ? `エラー ${qualityReport.errors}` : qualityReport.warnings ? `警告 ${qualityReport.warnings}` : qualityReport.suggestions ? `提案 ${qualityReport.suggestions}` : "✓"}</button>
          {draftSync === "error" ? <button className="draft-retry" onClick={() => { lastDraftFingerprintRef.current = ""; setDraftSync("saving"); setSlides((current) => [...current]); }}>同期できていません — 再試行</button> : <span role="status">{draftSync === "saving" ? "保存中…" : draftSync === "offline" ? "オフライン — 端末内に保存済み" : "同期済み"}</span>}
          {apiError && <span className="status-error">{apiError}</span>}
        </div>
        <div><span>HTML</span><span>UTF-8</span><span>スペース: 2</span>{!agentReady && <button className="connection offline" onClick={() => setConnectionEpoch((value) => value + 1)} title="Agentへの接続をやり直す"><i /> Agentへ再接続</button>}</div>
      </footer>

      {openPopover === "quality" && (
        <>
          <div className="popover-backdrop" role="presentation" onPointerDown={() => dismissPopover()} />
          <aside className="quality-popover" aria-label="デッキの品質レポート">
            <header><strong>デッキの品質</strong><button aria-label="品質レポートを閉じる" onClick={() => dismissPopover()}>×</button></header>
            {qualityReport.ok && quality.diagnostics.length === 0 && <p className="quality-empty">作業を妨げる品質上の問題はありません。</p>}
            {quality.diagnostics.map((item: any, index: number) => (
              <div key={item.id ?? `${item.code}-${index}`} className="quality-row" data-severity={item.severity}><i className={item.severity} aria-hidden="true" /><span><strong>{item.severity === "error" ? "エラー" : item.severity === "warning" ? "警告" : "提案"} · {item.message}</strong><small>{item.explanation}</small><small>{item.slideId ? `スライド ${item.slideId}` : "デッキ全体"}{item.elementId ? ` · 要素 ${item.elementId}` : ""}</small><span className="quality-actions"><button onClick={() => focusDiagnostic(item)}>対象を見る</button><button onClick={() => askAgentToFixDiagnostic(item)}>Agentで修正</button>{item.severity !== "error" && <button onClick={() => setIgnoredDiagnostics((current) => new Set([...current, item.id]))}>今回は無視</button>}</span></span></div>
            ))}
            {projectEventDiagnostics.length > 0 && <>
              <div className="quality-report-heading">直前のAgent出力は反映されませんでした</div>
              {projectEventDiagnostics.map((item, index) => (
                <div key={`agent-${item.code ?? "diagnostic"}-${index}`} className="quality-row"><i className={item.severity === "warning" ? "warning" : "error"} /><span><strong>{item.message}</strong><small>{item.code ?? "agent quality gate"} · {item.source ?? "html"}</small></span></div>
              ))}
            </>}
          </aside>
        </>
      )}
      {showPresenter && (
        <div className="presenter" role="dialog" aria-modal="true" aria-label="プレゼンモード" tabIndex={-1} ref={presenterRef} onKeyDown={(event) => {
          if (["ArrowRight", "PageDown", " "].includes(event.key)) setPresentSlide((value) => Math.min(slides.length, value + 1));
          if (["ArrowLeft", "PageUp"].includes(event.key)) setPresentSlide((value) => Math.max(1, value - 1));
          if (event.key === "Escape") setShowPresenter(false);
        }}>
          <style>{deckCss}</style>
          <div className="presenter-stage" style={{ "--slide-scale": presenterScale } as React.CSSProperties} dangerouslySetInnerHTML={{ __html: displayAssetHtml((() => { const slide = slides[presentSlide - 1]; if (!slide) return ""; try { return composeFor(slide, presentSlide, slides.length); } catch (error) { return error instanceof Error ? error.message : String(error); } })()) }} />
          <footer>
            <button onClick={() => setPresentSlide((value) => Math.max(1, value - 1))}>← 前へ</button>
            <span>{presentSlide} / {slides.length}</span>
            <button onClick={() => setPresentSlide((value) => Math.min(slides.length, value + 1))}>次へ →</button>
            <small>{slides[presentSlide - 1]?.notes || "発表者ノートはありません"}</small>
            <button onClick={() => document.documentElement.requestFullscreen?.()}>全画面</button>
            <button onClick={() => setShowPresenter(false)}>終了</button>
          </footer>
        </div>
      )}
      <div className="sr-only" aria-live="polite">{announcement}</div>
    </main>
  );
}
