"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- app-server catalog/request payloads are rendered defensively for forward compatibility. */

import { DragEvent, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { actionFromStreamEvent } from "./codex/actions";
import { defaultDeckCss, designHeight, designWidth, renderDeckDocument } from "../shared/slide-design.mjs";
import { auditContentPolicy } from "../shared/content-policy.mjs";
import { ItemCard } from "./codex/components/ItemCard";
import { ServerRequestCard } from "./codex/components/ServerRequestCard";
import { codexReducer, initialCodexState } from "./codex/reducer";
import { selectThreadRunning, selectThreadTurns, selectTurnItems } from "./codex/selectors";

/* A slide is now a real HTML file: its `<main class="weave-slide">` fragment is the single
   truth. The editor renders that fragment as live DOM and edits it in place; nothing is
   modelled as tokens any more (concept 2.10). */
type SlideDoc = { id: string; title: string; notes: string; html: string };

type SlideNav = "filmstrip" | "rail";

type ServerState = {
  deck: { title: string; slides: SlideDoc[] };
  css: string;
  history: HistoryEntry[];
  variations: Array<{ branch: string; label: string; commit: string; message: string; status: "ready" | "generating" }>;
  project: { root: string; branch: string; commit: string; revision?: string; clean: boolean };
  codex: {
    ready: boolean;
    connection: string;
    version: { compatible: boolean; running: string; generated: string; message: string | null } | null;
    catalog: { models: any[]; skills: any[]; hooks: any[]; mcpServers: any[]; account: Record<string, any> | null; modelProvider: Record<string, any> | null };
    activeTurns: Record<string, string>;
    pendingRequests: Array<{ id: string | number; method: string; params: Record<string, any>; createdAt: number }>;
  };
  migrationNotice: string;
};

type HistoryEntry = { id: string; shortId: string; message: string; date: string };

const apiBase = "http://127.0.0.1:4317/api";

const backgrounds = ["orbit", "grid", "plain"] as const;
type Background = (typeof backgrounds)[number];
const accents = ["#f6b84b", "#4ed1c1", "#9c7cf4", "#ff7d6d", "#91b692"];

/* Slide-navigator placement lives in localStorage, read through an external store so the
   server and the first client render agree on the default before the stored value applies. */
const slideNavKey = "weave.slideNav";
const slideNavListeners = new Set<() => void>();
const slideNavStore = {
  subscribe(listener: () => void) { slideNavListeners.add(listener); return () => { slideNavListeners.delete(listener); }; },
  read: (): SlideNav => (window.localStorage.getItem(slideNavKey) === "rail" ? "rail" : "filmstrip"),
  serverRead: (): SlideNav => "filmstrip",
  write(value: SlideNav) { window.localStorage.setItem(slideNavKey, value); slideNavListeners.forEach((listener) => listener()); },
};

const templateKey = "weave.slideTemplates";
const emptyTemplates: SlideDoc[] = [];
let templateCacheRaw = "";
let templateCache: SlideDoc[] = [];
const templateListeners = new Set<() => void>();
const templateStore = {
  subscribe(listener: () => void) { templateListeners.add(listener); return () => templateListeners.delete(listener); },
  read(): SlideDoc[] {
    const raw = window.localStorage.getItem(templateKey) ?? "";
    if (raw === templateCacheRaw) return templateCache;
    templateCacheRaw = raw;
    try { templateCache = raw ? JSON.parse(raw) : []; } catch { templateCache = []; }
    return templateCache;
  },
  serverRead: (): SlideDoc[] => emptyTemplates,
  write(value: SlideDoc[]) { templateCache = value; templateCacheRaw = JSON.stringify(value); window.localStorage.setItem(templateKey, templateCacheRaw); templateListeners.forEach((listener) => listener()); },
};

const createMessageId = () => `weave-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const retryDelay = (attempt: number) => Math.min(10_000, 400 * (2 ** Math.min(attempt, 5))) + Math.random() * 250;
const displayThreadName = (name: string | null | undefined) => name?.replace(/^Weave · /, "") || null;
const cssEscape = (value: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/[^\w-]/g, "\\$&"));

/* Curated block registry: each entry is just an HTML fragment stamped into the slide.
   Adding a kind is data, not code — the natural shape once HTML is the truth. */
const blockTemplates: Record<string, (id: string) => string> = {
  heading: (id) => `<h1 class="heading" data-weave-id="${id}">A clear, compelling headline.</h1>`,
  paragraph: (id) => `<p class="paragraph" data-weave-id="${id}">Add supporting detail that helps your audience understand the idea.</p>`,
  eyebrow: (id) => `<div class="eyebrow" data-weave-id="${id}">NEW SECTION</div>`,
  note: (id) => `<div class="note" data-weave-id="${id}">SOURCE · INTERNAL RESEARCH</div>`,
  metrics: (id) => `<div class="metrics" data-weave-id="${id}"><strong>24%</strong><span>growth</span><strong>8 wk</strong><span>to launch</span></div>`,
  row: (id) => `<div class="weave-container row" data-weave-id="${id}"></div>`,
  column: (id) => `<div class="weave-container column" data-weave-id="${id}"></div>`,
  grid: (id) => `<div class="weave-container grid" data-weave-id="${id}"></div>`,
};
const blockKinds = Object.keys(blockTemplates);
const blockIcons: Record<string, string> = { eyebrow: "T", heading: "H", paragraph: "¶", metrics: "▦", note: "≡", row: "↔", column: "↕", grid: "▦" };
const containerClasses = new Set(["row", "column", "grid"]);

/* Tailwind-style constrained scales: the inspector offers steps from a scale (consistency),
   but writes the chosen value as real inline CSS onto the node (no class indirection, so no
   drift). Each control may also expose a custom field as an escape hatch (concept 2.6/2.10). */
const typeScale = [12, 14, 18, 24, 32, 48, 64, 88].map((n) => ({ label: String(n), value: `${n}px` }));
const weightScale = [{ label: "Reg", value: "400" }, { label: "Med", value: "500" }, { label: "Semi", value: "600" }, { label: "Bold", value: "700" }];
const leadingScale = [{ label: "Tight", value: "1" }, { label: "Snug", value: "1.2" }, { label: "Normal", value: "1.5" }, { label: "Loose", value: "1.7" }];
const spacingScale = [0, 4, 8, 12, 16, 24, 32, 48].map((n) => ({ label: String(n), value: `${n}px` }));
const measureScale = [{ label: "Auto", value: "" }, { label: "40%", value: "40%" }, { label: "62%", value: "62%" }, { label: "80%", value: "80%" }, { label: "Full", value: "100%" }];
const alignScale = [{ label: "≡", value: "left" }, { label: "≣", value: "center" }, { label: "☷", value: "right" }];
const justifyScale = [{ label: "Start", value: "flex-start" }, { label: "Center", value: "center" }, { label: "Between", value: "space-between" }, { label: "End", value: "flex-end" }];
const itemsScale = [{ label: "Start", value: "flex-start" }, { label: "Center", value: "center" }, { label: "Stretch", value: "stretch" }];
const colorScale = [{ label: "Default", value: "" }, { label: "Muted", value: "#969da6" }, { label: "Accent", value: "var(--accent)" }];

type Control = { label: string; prop: string; scale: Array<{ label: string; value: string }>; custom?: boolean };
const textSchema: Control[] = [
  { label: "Size", prop: "fontSize", scale: typeScale, custom: true },
  { label: "Weight", prop: "fontWeight", scale: weightScale },
  { label: "Leading", prop: "lineHeight", scale: leadingScale },
  { label: "Align", prop: "textAlign", scale: alignScale },
  { label: "Measure", prop: "maxWidth", scale: measureScale, custom: true },
  { label: "Color", prop: "color", scale: colorScale },
];
const containerSchema: Control[] = [
  { label: "Gap", prop: "gap", scale: spacingScale, custom: true },
  { label: "Padding", prop: "padding", scale: spacingScale, custom: true },
  { label: "Justify", prop: "justifyContent", scale: justifyScale },
  { label: "Align items", prop: "alignItems", scale: itemsScale },
];
const readProps = ["fontSize", "fontWeight", "lineHeight", "textAlign", "maxWidth", "color", "gap", "padding", "justifyContent", "alignItems"];

type SelState = { id: string; kind: string; container: boolean; read: Record<string, string> };

/* Read a property back for the inspector's active-step highlight: computed values for layout
   levers (they reflect deck.css defaults), inline values for per-element overrides. */
const readProp = (node: HTMLElement, cs: CSSStyleDeclaration, prop: string): string => {
  switch (prop) {
    case "fontSize": return `${Math.round(parseFloat(cs.fontSize) || 0)}px`;
    case "fontWeight": return String(cs.fontWeight);
    case "lineHeight": { const fs = parseFloat(cs.fontSize) || 16; const lh = parseFloat(cs.lineHeight); return cs.lineHeight === "normal" || !lh ? "normal" : (lh / fs).toFixed(2); }
    case "gap": return cs.gap && cs.gap !== "normal" ? `${Math.round(parseFloat(cs.gap))}px` : "0px";
    case "padding": return `${Math.round(parseFloat(cs.paddingTop) || 0)}px`;
    case "justifyContent": return cs.justifyContent || "flex-start";
    case "alignItems": return cs.alignItems || "stretch";
    case "textAlign": return node.style.textAlign || "";
    case "maxWidth": return node.style.maxWidth || "";
    case "color": return node.style.color || "";
    default: return (node.style as unknown as Record<string, string>)[prop] || "";
  }
};
const isActiveValue = (prop: string, current: string, value: string): boolean =>
  prop === "lineHeight" ? current !== "normal" && Math.abs(parseFloat(current) - parseFloat(value)) < 0.05 : current === value;

const blankSlideHtml = (background: Background = "orbit", accent = "#f6b84b") =>
  `<main class="weave-slide ${background}" style="--accent: ${accent}" data-weave-slide>
    <div class="brand">WEAVE<span>●</span></div>
    <section class="hero">
      <div class="eyebrow" data-weave-id="eyebrow-${createMessageId().slice(6)}">NEW SECTION</div>
      <h1 class="heading" data-weave-id="heading-${createMessageId().slice(6)}">Give this idea a clear title.</h1>
      <p class="paragraph" data-weave-id="body-${createMessageId().slice(6)}">Add the detail your audience needs to move forward.</p>
    </section>
    <div class="page-number">01 / 01</div>
  </main>`;

const initialSlides: SlideDoc[] = [{ id: "opportunity", title: "The opportunity", notes: "", html: blankSlideHtml() }];

type Snapshot = { title: string; slides: SlideDoc[]; activeSlide: number; selectedId: string | null };

export default function Home() {
  const [deckTitle, setDeckTitle] = useState("Q3 Strategy Deck");
  const [slides, setSlides] = useState<SlideDoc[]>(initialSlides);
  const [activeSlide, setActiveSlide] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deckCss, setDeckCss] = useState<string>(defaultDeckCss);
  const [mode, setMode] = useState<"preview" | "code">("preview");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [background, setBackground] = useState<Background>("orbit");
  const [accent, setAccent] = useState("#f6b84b");
  const [fitScale, setFitScale] = useState(0.68);
  const [manualZoom, setManualZoom] = useState<number | null>(null);
  const [injectKey, setInjectKey] = useState(0);
  const [activeVariation, setActiveVariation] = useState("main");
  const [variations, setVariations] = useState<ServerState["variations"]>([]);
  const [showVariationPrompt, setShowVariationPrompt] = useState(false);
  const [variationPrompt, setVariationPrompt] = useState("Explore a bolder editorial hierarchy with a concise headline and stronger metric emphasis.");
  const [showBackgrounds, setShowBackgrounds] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [saved, setSaved] = useState(true);
  const [promptDraft, setPromptDraft] = useState("");
  const [codexState, dispatchCodex] = useReducer(codexReducer, initialCodexState);
  const slideNav = useSyncExternalStore(slideNavStore.subscribe, slideNavStore.read, slideNavStore.serverRead);
  const [threadSearch, setThreadSearch] = useState("");
  const [showThreads, setShowThreads] = useState(false);
  const [showArchivedThreads, setShowArchivedThreads] = useState(false);
  const [showCodexSettings, setShowCodexSettings] = useState(false);
  const [selectedModel, setSelectedModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("medium");
  const [approvalPolicy, setApprovalPolicy] = useState("never");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [mcpResult, setMcpResult] = useState("");
  const [turnSubmitting, setTurnSubmitting] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [draggedSlide, setDraggedSlide] = useState<number | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [project, setProject] = useState<ServerState["project"] | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [showPresenter, setShowPresenter] = useState(false);
  const [showQuality, setShowQuality] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const slideTemplates = useSyncExternalStore(templateStore.subscribe, templateStore.read, templateStore.serverRead);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [announcement, setAnnouncement] = useState("Editor ready");
  const [saveMessage, setSaveMessage] = useState("");
  const [presentSlide, setPresentSlide] = useState(1);
  const [serverRevision, setServerRevision] = useState("");
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [historyState, setHistoryState] = useState({ undo: 0, redo: 0 });
  const [outline, setOutline] = useState<Array<{ id: string; label: string; kind: string; depth: number }>>([]);
  const [sel, setSel] = useState<SelState | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const presenterRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const compositionRef = useRef(false);
  const turnInFlightRef = useRef(false);
  const shouldAutoScrollRef = useRef(true);
  const eventSequenceRef = useRef(0);
  const undoRef = useRef<Snapshot[]>([]);
  const deckLoadedRef = useRef(false);
  const redoRef = useRef<Snapshot[]>([]);
  const slidesRef = useRef(slides);
  const activeRef = useRef(activeSlide);
  const selectedRef = useRef(selectedId);

  const agentReady = codexState.connection.status === "connected";
  const agentRunning = selectThreadRunning(codexState, codexState.activeThreadId);
  const activeTurns = selectThreadTurns(codexState, codexState.activeThreadId);
  const visibleTurns = activeTurns.slice(-100);
  const slideScale = manualZoom ?? fitScale;

  const setSlidesSynced = (next: SlideDoc[]) => { slidesRef.current = next; setSlides(next); };
  const reinject = () => setInjectKey((value) => value + 1);
  const slideRoot = () => canvasRef.current?.querySelector<HTMLElement>(".weave-slide") ?? null;
  const selectedNode = () => (selectedId ? canvasRef.current?.querySelector<HTMLElement>(`[data-weave-id="${cssEscape(selectedId)}"]`) ?? null : null);

  const readSelection = (node: HTMLElement): SelState => {
    const cs = getComputedStyle(node);
    const kind = node.className.split(" ").find((cls) => cls && cls !== "weave-container" && cls !== "weave-selected") ?? node.tagName.toLowerCase();
    const read: Record<string, string> = {};
    for (const prop of readProps) read[prop] = readProp(node, cs, prop);
    read.direction = node.classList.contains("column") ? "column" : "row";
    return { id: node.getAttribute("data-weave-id") ?? "", kind, container: node.classList.contains("weave-container"), read };
  };

  /* Serialize the live slide DOM back to an HTML string, stripping only the editor's transient
     chrome. data-weave-id stays — it is the slide's stable identity, cleaned off only at export. */
  const serializeCanvas = (): string | null => {
    const root = slideRoot();
    if (!root) return null;
    const clone = root.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("[contenteditable]").forEach((node) => node.removeAttribute("contenteditable"));
    clone.querySelectorAll("[data-editing]").forEach((node) => node.removeAttribute("data-editing"));
    clone.querySelectorAll(".weave-selected").forEach((node) => node.classList.remove("weave-selected"));
    clone.querySelectorAll("[draggable]").forEach((node) => node.removeAttribute("draggable"));
    return clone.outerHTML;
  };

  const captureActive = (list: SlideDoc[] = slidesRef.current): SlideDoc[] => {
    const html = serializeCanvas();
    if (html == null) return list;
    return list.map((slide, index) => (index === activeRef.current - 1 ? { ...slide, html } : slide));
  };

  const syncFromDom = () => { setSlidesSynced(captureActive()); setSaved(false); };

  const snapshot = (): Snapshot => ({ title: deckTitle, slides: captureActive().map((slide) => ({ ...slide })), activeSlide: activeRef.current, selectedId: selectedRef.current });
  const restoreSnapshot = (value: Snapshot) => {
    setDeckTitle(value.title);
    setSlidesSynced(value.slides.map((slide) => ({ ...slide })));
    activeRef.current = value.activeSlide;
    setActiveSlide(value.activeSlide);
    selectedRef.current = value.selectedId;
    setSelectedId(value.selectedId);
    setSaved(false);
    reinject();
  };
  const checkpoint = () => { undoRef.current = [...undoRef.current.slice(-79), snapshot()]; redoRef.current = []; setHistoryState({ undo: undoRef.current.length, redo: 0 }); };
  const undo = () => { const value = undoRef.current.pop(); if (!value) return; redoRef.current.push(snapshot()); restoreSnapshot(value); setHistoryState({ undo: undoRef.current.length, redo: redoRef.current.length }); setAnnouncement("Change undone"); };
  const redo = () => { const value = redoRef.current.pop(); if (!value) return; undoRef.current.push(snapshot()); restoreSnapshot(value); setHistoryState({ undo: undoRef.current.length, redo: redoRef.current.length }); setAnnouncement("Change redone"); };

  const deckPayload = () => ({ title: deckTitle, slides: captureActive() });

  const contextEnvelope = () => ({
    revision: serverRevision,
    activeSlide,
    selected: selectedId ? { id: selectedId, kind: sel?.kind ?? "", label: sel?.kind ?? "" } : null,
    selectedText: typeof window === "undefined" ? "" : window.getSelection()?.toString().slice(0, 2_000) ?? "",
    activeSlideHtml: (serializeCanvas() ?? slides[activeSlide - 1]?.html ?? "").slice(0, 30_000),
    css: deckCss.slice(0, 30_000),
    recentHistory: history.slice(0, 5).map(({ shortId, message }) => ({ shortId, message })),
  });

  const quality = useMemo(() => {
    const html = slides.map((slide) => slide.html).join("\n");
    const result = auditContentPolicy({ css: deckCss, html });
    return { ok: result.ok, diagnostics: result.diagnostics, errors: result.summary.errors, warnings: 0 };
  }, [slides, deckCss]);

  const activeThread = codexState.activeThreadId ? codexState.threads[codexState.activeThreadId] : null;
  const activeThreadName = activeThread ? displayThreadName(activeThread.name) || activeThread.preview || "New conversation" : "No conversation";
  const selectedModelInfo = useMemo(() => codexState.catalog.models.find((model: any) => (model.id ?? model.model) === selectedModel) as any, [codexState.catalog.models, selectedModel]);
  const availableEfforts = useMemo(() => selectedModelInfo?.supportedReasoningEfforts?.map((option: any) => option.reasoningEffort) ?? ["low", "medium", "high"], [selectedModelInfo]);
  const agentActivity = !agentReady ? codexState.connection.error ?? "Connecting to Codex…" : agentRunning ? "Codex is working…" : "Ready";

  /* `applyDeck` controls whether the on-disk deck replaces the editor buffer. Status-only polls
     (retrying while Codex connects) pass false so they never clobber unsaved edits — the local
     buffer stays authoritative until a real project change (save, history/variation, agent turn). */
  const applyServerState = useCallback((state: ServerState, applyDeck = true) => {
    if (applyDeck) {
      setDeckTitle(state.deck.title);
      const nextSlides = state.deck.slides?.length ? state.deck.slides : initialSlides;
      slidesRef.current = nextSlides;
      setSlides(nextSlides);
      if (state.css) setDeckCss(state.css);
      setHistory(state.history);
      setVariations(state.variations ?? []);
      setProject(state.project);
      setServerRevision(state.project.revision ?? state.project.commit);
      setActiveVariation(state.project.branch);
      setSaved(state.project.clean);
      reinject();
    }
    dispatchCodex({ type: "connection", connection: { status: state.codex.ready ? "connected" : state.codex.version?.compatible === false ? "incompatible" : "connecting", error: state.codex.version?.message ?? null, cliVersion: state.codex.version?.running } });
    dispatchCodex({ type: "catalog", catalog: state.codex.catalog });
    dispatchCodex({ type: "pendingRequests", requests: state.codex.pendingRequests });
    dispatchCodex({ type: "activeTurns", activeTurns: state.codex.activeTurns });
    setSelectedModel((current) => { if (current) return current; const firstModel = state.codex.catalog.models?.[0]; return firstModel?.id ?? firstModel?.model ?? ""; });
    setReasoningEffort((current) => { const firstModel = state.codex.catalog.models?.[0]; const supported = firstModel?.supportedReasoningEfforts?.map((option: any) => option.reasoningEffort) ?? []; return supported.length > 0 && !supported.includes(current) ? firstModel.defaultReasoningEffort ?? supported[0] : current; });
  }, []);

  useEffect(() => {
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const loadState = async () => {
      try {
        const response = await fetch(`${apiBase}/state`);
        if (!response.ok) throw new Error("Local API is unavailable.");
        const state = (await response.json()) as ServerState;
        if (canceled) return;
        /* Load the deck once; later readiness retries only refresh Codex status so they
           cannot overwrite unsaved edits made while Codex is still connecting. */
        applyServerState(state, !deckLoadedRef.current);
        deckLoadedRef.current = true;
        if (!state.codex.ready) { attempts += 1; timer = setTimeout(() => void loadState(), retryDelay(attempts)); }
      } catch (error) {
        if (canceled) return;
        dispatchCodex({ type: "connection", connection: { status: "disconnected", error: "Local API offline" } });
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
        if (!response.ok || !response.body) throw new Error("Codex event stream is unavailable.");
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
            eventSequenceRef.current = Math.max(eventSequenceRef.current, envelope.sequence ?? 0);
            if (envelope.type === "weave/project") {
              const stateResponse = await fetch(`${apiBase}/state`);
              if (stateResponse.ok) applyServerState(await stateResponse.json());
              continue;
            }
            const action = actionFromStreamEvent(envelope);
            if (action) dispatchCodex(action);
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
    let canceled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const query = new URLSearchParams({ archived: String(showArchivedThreads), ...(threadSearch.trim() ? { q: threadSearch.trim() } : {}) });
          const response = await fetch(`${apiBase}/codex/threads?${query}`);
          const result = await response.json();
          if (!response.ok) throw new Error(result.error ?? "Could not list threads.");
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
     without React wiping the caret. Slide switches, undo, and server updates bump the counter. */
  useLayoutEffect(() => {
    const host = canvasRef.current;
    if (!host || mode !== "preview") return;
    host.innerHTML = slidesRef.current[activeSlide - 1]?.html ?? "";
    host.querySelectorAll<HTMLElement>("[data-weave-id]").forEach((node) => { node.draggable = !agentRunning; });
    const root = host.querySelector<HTMLElement>(".weave-slide");
    if (root) {
      const bg = backgrounds.find((item) => root.classList.contains(item)) ?? "orbit";
      setBackground(bg);
      setAccent(root.style.getPropertyValue("--accent").trim() || "#f6b84b");
    }
  }, [activeSlide, injectKey, mode, agentRunning]);

  /* Selection outline + inspector read-out follow the selected node without re-injecting. */
  useLayoutEffect(() => {
    const host = canvasRef.current;
    if (!host || mode !== "preview") return;
    host.querySelectorAll(".weave-selected").forEach((node) => node.classList.remove("weave-selected"));
    const node = selectedId ? host.querySelector<HTMLElement>(`[data-weave-id="${cssEscape(selectedId)}"]`) : null;
    node?.classList.add("weave-selected");
    setSel(node ? readSelection(node) : null);
    // Rebuild the object tree from the live DOM.
    const hero = host.querySelector(".hero");
    const list: Array<{ id: string; label: string; kind: string; depth: number }> = [];
    if (hero) {
      const walk = (element: Element, depth: number) => {
        for (const child of Array.from(element.children)) {
          const id = child.getAttribute("data-weave-id");
          if (id) {
            const kind = child.className.split(" ").find((cls) => cls && cls !== "weave-container" && cls !== "weave-selected") ?? child.tagName.toLowerCase();
            list.push({ id, label: kind, kind, depth });
            walk(child, depth + 1);
          }
        }
      };
      walk(hero, 0);
    }
    setOutline(list);
  }, [selectedId, injectKey, activeSlide, mode]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(([entry]) => setFitScale(Math.min(entry.contentRect.width / designWidth, entry.contentRect.height / designHeight)));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [mode]);

  useEffect(() => { slidesRef.current = slides; }, [slides]);
  useEffect(() => { activeRef.current = activeSlide; }, [activeSlide]);
  useEffect(() => { selectedRef.current = selectedId; }, [selectedId]);

  useEffect(() => {
    if (shouldAutoScrollRef.current) messagesEndRef.current?.scrollIntoView({ behavior: agentRunning ? "smooth" : "auto", block: "end" });
  }, [codexState.items, agentRunning]);

  useEffect(() => { if (showPresenter) presenterRef.current?.focus(); }, [showPresenter]);

  /* --- Live-DOM editing on the canvas -------------------------------------------------- */

  const onCanvasPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-weave-id]");
    if (!target || !canvasRef.current?.contains(target)) { setSelectedId(null); return; }
    if (target.getAttribute("contenteditable") === "true") return;
    setSelectedId(target.getAttribute("data-weave-id"));
  };

  const beginEdit = (node: HTMLElement) => {
    if (containerClasses.has(node.className.split(" ").find((cls) => containerClasses.has(cls)) ?? "")) return;
    checkpoint();
    node.setAttribute("contenteditable", "true");
    node.setAttribute("data-editing", "true");
    requestAnimationFrame(() => node.focus());
  };

  const onCanvasDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-weave-id]");
    if (target) beginEdit(target);
  };

  const onCanvasBlurCapture = (event: React.FocusEvent<HTMLDivElement>) => {
    const node = event.target as HTMLElement;
    if (node.getAttribute?.("contenteditable") === "true") {
      node.removeAttribute("contenteditable");
      node.removeAttribute("data-editing");
      syncFromDom();
    }
  };

  const onCanvasKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const node = selectedNode();
    if (!node) return;
    if ((event.key === "Enter" || event.key === "F2") && node.getAttribute("contenteditable") !== "true") {
      event.preventDefault();
      beginEdit(node);
    } else if (event.key === "Escape" && node.getAttribute("contenteditable") === "true") {
      node.blur();
    }
  };

  const onCanvasDragStart = (event: DragEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-weave-id]");
    if (target) setDraggedId(target.getAttribute("data-weave-id"));
  };
  const onCanvasDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const host = canvasRef.current;
    if (!host || !draggedId) return;
    const dragged = host.querySelector<HTMLElement>(`[data-weave-id="${cssEscape(draggedId)}"]`);
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-weave-id]");
    setDraggedId(null);
    if (!dragged || !target || target === dragged || dragged.contains(target)) return;
    checkpoint();
    if (target.classList.contains("weave-container")) target.appendChild(dragged);
    else target.parentElement?.insertBefore(dragged, target);
    syncFromDom();
  };

  const addBlock = (kind: string) => {
    const host = canvasRef.current;
    const hero = host?.querySelector(".hero");
    if (!hero) return;
    checkpoint();
    const id = `${kind}-${createMessageId().slice(6)}`;
    const node = selectedNode();
    const container = node?.classList.contains("weave-container") ? node : hero;
    container.insertAdjacentHTML("beforeend", blockTemplates[kind](id));
    container.querySelector<HTMLElement>(`[data-weave-id="${cssEscape(id)}"]`)?.setAttribute("draggable", "true");
    setSelectedId(id);
    setShowAdd(false);
    syncFromDom();
  };

  const deleteSelected = () => {
    const node = selectedNode();
    if (!node || outline.length <= 1) return;
    checkpoint();
    node.remove();
    setSelectedId(null);
    syncFromDom();
  };

  /* Inline-style edits: the inspector writes real CSS straight onto the selected node. */
  const applyStyle = (mutate: (node: HTMLElement) => void) => {
    const node = selectedNode();
    if (!node) return;
    checkpoint();
    mutate(node);
    syncFromDom();
    setSel(readSelection(node));
  };
  const setProp = (prop: string, value: string) => applyStyle((node) => { (node.style as unknown as Record<string, string>)[prop] = value; });
  const setDirection = (value: string) => applyStyle((node) => { node.classList.remove("row", "column"); node.classList.add(value); });

  const setSlideBackground = (value: Background) => {
    const root = slideRoot();
    if (!root) return;
    checkpoint();
    backgrounds.forEach((item) => root.classList.remove(item));
    root.classList.add(value);
    setBackground(value);
    setShowBackgrounds(false);
    syncFromDom();
  };
  const setSlideAccent = (value: string) => {
    const root = slideRoot();
    if (!root) return;
    checkpoint();
    root.style.setProperty("--accent", value);
    setAccent(value);
    syncFromDom();
  };

  /* --- Slide operations ---------------------------------------------------------------- */

  const switchSlide = (slideNumber: number) => {
    const captured = captureActive();
    if (slideNumber < 1 || slideNumber > captured.length) return;
    setSlidesSynced(captured);
    activeRef.current = slideNumber;
    setActiveSlide(slideNumber);
    setSelectedId(null);
    reinject();
  };

  const renameSlide = (title: string) => {
    checkpoint();
    setSlidesSynced(slidesRef.current.map((slide, index) => (index === activeRef.current - 1 ? { ...slide, title } : slide)));
    setSaved(false);
  };
  const setSlideNotes = (notes: string) => {
    checkpoint();
    setSlidesSynced(captureActive().map((slide, index) => (index === activeRef.current - 1 ? { ...slide, notes } : slide)));
    setSaved(false);
  };

  const addSlide = () => {
    checkpoint();
    const captured = captureActive();
    const slide: SlideDoc = { id: `slide-${createMessageId().slice(6)}`, title: `Untitled ${captured.length + 1}`, notes: "", html: blankSlideHtml(background, accent) };
    const next = [...captured, slide];
    setSlidesSynced(next);
    activeRef.current = next.length;
    setActiveSlide(next.length);
    setSelectedId(null);
    setSaved(false);
    reinject();
  };

  const duplicateSlide = () => {
    checkpoint();
    const captured = captureActive();
    const source = captured[activeRef.current - 1];
    const copy: SlideDoc = { ...source, id: `${source.id}-${createMessageId().slice(6)}`, title: `${source.title} copy` };
    const next = [...captured];
    next.splice(activeRef.current, 0, copy);
    setSlidesSynced(next);
    activeRef.current += 1;
    setActiveSlide(activeRef.current);
    setSelectedId(null);
    setSaved(false);
    reinject();
  };

  const deleteSlide = () => {
    if (slidesRef.current.length <= 1) return;
    checkpoint();
    const captured = captureActive().filter((_, index) => index !== activeRef.current - 1);
    const nextNumber = Math.min(activeRef.current, captured.length);
    setSlidesSynced(captured);
    activeRef.current = nextNumber;
    setActiveSlide(nextNumber);
    setSelectedId(null);
    setSaved(false);
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
    setActiveSlide(target + 1);
    setSaved(false);
    reinject();
  };

  const saveSlideTemplate = () => {
    const slide = captureActive()[activeRef.current - 1];
    const next = [...slideTemplates.filter((item) => item.title !== slide.title), slide].slice(-30);
    templateStore.write(next);
    setAnnouncement(`Saved ${slide.title} to the slide library`);
  };
  const insertTemplate = (template: SlideDoc) => {
    checkpoint();
    const captured = captureActive();
    const slide: SlideDoc = { ...template, id: `${template.id}-${createMessageId().slice(6)}` };
    const next = [...captured];
    next.splice(activeRef.current, 0, slide);
    setSlidesSynced(next);
    activeRef.current += 1;
    setActiveSlide(activeRef.current);
    setSelectedId(null);
    setShowTemplates(false);
    setSaved(false);
    reinject();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.matches("input, textarea, [contenteditable=true]")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
      else if (event.key === "?") setShowHelp(true);
      else if (event.key === "ArrowRight" && activeSlide < slides.length) switchSlide(activeSlide + 1);
      else if (event.key === "ArrowLeft" && activeSlide > 1) switchSlide(activeSlide - 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  /* --- Persistence, export, agent ------------------------------------------------------ */

  const saveProject = async () => {
    try {
      const response = await fetch(`${apiBase}/save`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deck: deckPayload(), message: saveMessage || deckTitle, expectedRevision: serverRevision, idempotencyKey: createMessageId() }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Save failed.");
      applyServerState(result as ServerState);
      setSaved(true);
      setSaveMessage("");
      setAnnouncement("Deck saved to history");
      setApiError(null);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
  };

  const exportFragments = () => captureActive().map((slide) => slide.html);

  const exportDeck = () => {
    if (!quality.ok) { setShowQuality(true); setApiError("Resolve quality errors before exporting."); return; }
    const html = renderDeckDocument(exportFragments(), deckCss, deckTitle);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${deckTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "weave-deck"}.html`;
    anchor.click();
    URL.revokeObjectURL(url);
    setAnnouncement("Offline presentation downloaded");
  };

  const downloadBundle = () => {
    const bundle = JSON.stringify({ format: "weave-deck", version: 2, deck: deckPayload(), css: deckCss }, null, 2);
    const url = URL.createObjectURL(new Blob([bundle], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${deckTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "deck"}.weave.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importBundle = async (file: File) => {
    try {
      if (file.size > 4_000_000) throw new Error("Deck bundle must be 4 MB or smaller.");
      const bundle = JSON.parse(await file.text());
      if (bundle.format !== "weave-deck" || bundle.version !== 2 || !bundle.deck || !Array.isArray(bundle.deck.slides) || typeof bundle.css !== "string") throw new Error("Unsupported Weave bundle.");
      if (!window.confirm(`Replace the editor buffer with “${bundle.deck.title}”? You can Undo this import.`)) return;
      checkpoint();
      setDeckTitle(String(bundle.deck.title));
      setSlidesSynced(bundle.deck.slides);
      setDeckCss(bundle.css);
      activeRef.current = 1;
      setActiveSlide(1);
      setSelectedId(null);
      setSaved(false);
      reinject();
      setAnnouncement("Portable deck imported; save to commit it");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  };

  const openPresenter = () => { setSlidesSynced(captureActive()); setPresentSlide(activeSlide); setShowPresenter(true); };

  const printDeck = () => {
    if (!quality.ok) { setShowQuality(true); return; }
    const popup = window.open("", "_blank", "noopener,noreferrer");
    if (!popup) { setApiError("Allow pop-ups to print this deck."); return; }
    popup.document.write(renderDeckDocument(exportFragments(), deckCss, deckTitle));
    popup.document.close();
    popup.addEventListener("load", () => popup.print(), { once: true });
  };

  const restoreHistory = async (commit?: string) => {
    try {
      const endpoint = commit ? "history/checkout" : "history/main";
      const response = await fetch(`${apiBase}/${endpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(commit ? { commit } : {}) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not restore history.");
      applyServerState(result as ServerState);
      setSelectedId(null);
      setShowHistory(false);
      setApiError(null);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
  };

  const checkoutVariation = async (branch: string) => {
    try {
      const response = await fetch(`${apiBase}/variations/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ branch }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not switch direction.");
      applyServerState(result as ServerState);
      setSelectedId(null);
      setApiError(null);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
  };

  const generateVariation = async () => {
    const prompt = variationPrompt.trim();
    if (!prompt || turnInFlightRef.current) return;
    turnInFlightRef.current = true;
    setTurnSubmitting(true);
    setShowVariationPrompt(false);
    setApiError(null);
    try {
      const response = await fetch(`${apiBase}/variations/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, deck: deckPayload(), clientUserMessageId: createMessageId(), model: selectedModel || undefined, effort: reasoningEffort, approvalPolicy, contextEnvelope: contextEnvelope() }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not generate direction.");
      setActiveVariation(result.branch);
      dispatchCodex({ type: "threadLoaded", thread: result.thread, activate: true });
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    } finally {
      turnInFlightRef.current = false;
      setTurnSubmitting(false);
    }
  };

  const acceptVariation = async () => {
    try {
      const response = await fetch(`${apiBase}/variations/accept`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not use this direction.");
      applyServerState(result as ServerState);
      setApiError(null);
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  const archiveVariation = async () => {
    try {
      const response = await fetch(`${apiBase}/variations/archive`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not archive this direction.");
      applyServerState(result as ServerState);
      setApiError(null);
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  const sendMessage = async () => {
    const value = promptDraft.trim();
    if (!value || turnInFlightRef.current) return;
    turnInFlightRef.current = true;
    setTurnSubmitting(true);
    shouldAutoScrollRef.current = true;
    setApiError(null);
    try {
      let threadId = codexState.activeThreadId;
      if (!threadId) {
        const startResponse = await fetch(`${apiBase}/codex/thread/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approvalPolicy, model: selectedModel || undefined }) });
        const started = await startResponse.json();
        if (!startResponse.ok) throw new Error(started.error ?? "Could not start a Thread.");
        threadId = started.thread.id;
        dispatchCodex({ type: "threadLoaded", thread: started.thread, activate: true });
      }
      const endpoint = agentRunning ? "codex/turn/steer" : "codex/turn/start";
      const response = await fetch(`${apiBase}/${endpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId, prompt: value, clientUserMessageId: createMessageId(), selectedId, deck: deckPayload(), model: selectedModel || undefined, effort: reasoningEffort, approvalPolicy, contextEnvelope: contextEnvelope() }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Agent turn failed.");
      setPromptDraft("");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    } finally {
      turnInFlightRef.current = false;
      setTurnSubmitting(false);
    }
  };

  const interruptAgent = async () => {
    try {
      const response = await fetch(`${apiBase}/codex/turn/interrupt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: codexState.activeThreadId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not stop the active turn.");
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  const newThread = async () => {
    try {
      const response = await fetch(`${apiBase}/codex/thread/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approvalPolicy, model: selectedModel || undefined }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not start a Thread.");
      dispatchCodex({ type: "threadLoaded", thread: result.thread, activate: true });
      setApiError(null);
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  const openThread = async (threadId: string) => {
    try {
      const response = await fetch(`${apiBase}/codex/thread/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not resume the Thread.");
      dispatchCodex({ type: "threadLoaded", thread: result.thread, activate: true });
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  const threadAction = async (action: string, params: Record<string, unknown> = {}) => {
    const threadId = codexState.activeThreadId;
    if (!threadId) return;
    try {
      const response = await fetch(`${apiBase}/codex/thread/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, params: { threadId, ...params } }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Thread action failed.");
      if (action === "delete") dispatchCodex({ type: "activateThread", threadId: null });
      else await openThread(threadId);
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  const forkThread = async () => {
    if (!codexState.activeThreadId) return;
    try {
      const response = await fetch(`${apiBase}/codex/thread/fork`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: codexState.activeThreadId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not fork the Thread.");
      dispatchCodex({ type: "threadLoaded", thread: result.thread, activate: true });
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  const manageGoal = async () => {
    const threadId = codexState.activeThreadId;
    if (!threadId) return;
    try {
      const response = await fetch(`${apiBase}/codex/thread/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "goalGet", params: { threadId } }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not read the Thread goal.");
      const current = result.goal?.objective ?? result.objective ?? "";
      const objective = window.prompt("Thread goal (leave empty to clear)", current);
      if (objective === null) return;
      await threadAction(objective.trim() ? "goalSet" : "goalClear", objective.trim() ? { objective } : {});
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  const resolveServerRequest = async (id: string | number, result: Record<string, unknown>) => {
    try {
      const response = await fetch(`${apiBase}/codex/request/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, result }) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "Could not answer app-server.");
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };
  const rejectServerRequest = async (id: string | number) => {
    try {
      const response = await fetch(`${apiBase}/codex/request/reject`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, message: "Declined in Weave." }) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "Could not decline app-server.");
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  const updateSkill = async (skill: any, enabled: boolean) => {
    try {
      const response = await fetch(`${apiBase}/codex/skill/config`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: skill.path ?? null, name: skill.name ?? null, enabled }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not update Skill.");
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  const login = async (type: "chatgpt" | "apiKey") => {
    try {
      const response = await fetch(`${apiBase}/codex/account/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(type === "apiKey" ? { type, apiKey: apiKeyDraft } : { type }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Login could not start.");
      setApiKeyDraft("");
      const loginUrl = result.authUrl ?? result.loginUrl ?? result.url;
      if (loginUrl && window.confirm("Open the secure Codex login page in your browser?")) window.open(loginUrl, "_blank", "noopener,noreferrer");
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  const invokeMcp = async (server: any, kind: "resource" | "tool") => {
    try {
      let path: string;
      let body: Record<string, unknown>;
      if (kind === "resource") {
        const uri = window.prompt("MCP resource URI", server.resources?.[0]?.uri ?? "");
        if (!uri) return;
        path = "resource/read";
        body = { server: server.name, uri, threadId: codexState.activeThreadId };
      } else {
        if (!codexState.activeThreadId) throw new Error("Select a Weave Thread before calling an MCP tool.");
        const tool = window.prompt("MCP tool name", Object.keys(server.tools ?? {})[0] ?? "");
        if (!tool) return;
        const raw = window.prompt("Tool arguments as JSON", "{}");
        if (raw === null) return;
        path = "tool/call";
        body = { server: server.name, tool, arguments: JSON.parse(raw), threadId: codexState.activeThreadId };
      }
      const response = await fetch(`${apiBase}/codex/mcp/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "MCP request failed.");
      setMcpResult(JSON.stringify(result, null, 2).slice(0, 20_000));
    } catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
  };

  /* Switching to Code mode captures the live DOM into `slides` first, so the code view can
     read the fresh HTML straight from state without touching a ref during render. */
  const codeView = mode === "code" ? slides[activeSlide - 1]?.html ?? "" : "";

  const slideNavigator = (
    <>
      {slides.map((slide, index) => ({ slide, index })).filter(({ index }) => slides.length <= 60 || index === 0 || index === slides.length - 1 || Math.abs(index - (activeSlide - 1)) <= 20).map(({ slide, index }, visibleIndex, visibleEntries) => {
        const slideNumber = index + 1;
        return (
          <div className="slide-entry" key={slide.id}>
            {visibleIndex > 0 && index - visibleEntries[visibleIndex - 1].index > 1 && <button className="slide-gap" onClick={() => switchSlide(Math.max(1, slideNumber - 20))}>…</button>}
            <button
              className={`slide-item ${activeSlide === slideNumber ? "active" : ""}`}
              onClick={() => switchSlide(slideNumber)}
              disabled={agentRunning}
              title={slide.title}
              draggable={!agentRunning}
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
                setActiveSlide(index + 1);
                setDraggedSlide(null);
                setSaved(false);
                reinject();
              }}
            >
              <span className="slide-number">{String(slideNumber).padStart(2, "0")}</span>
              <span className={`mini-slide mini-${(index % 4) + 1}`}><i /><b /><em /></span>
              <span className="slide-name">{slide.title}</span>
            </button>
          </div>
        );
      })}
      <button className="new-slide" onClick={addSlide} disabled={agentRunning} aria-label="New slide" title="New slide">＋</button>
    </>
  );

  const presenterScale = typeof window === "undefined" ? 1 : Math.min((window.innerWidth - 80) / designWidth, (window.innerHeight - 120) / designHeight);
  const containerLike = !!sel && (sel.container || sel.kind === "metrics");
  const inspectorSchema = containerLike ? containerSchema : textSchema;

  return (
    <main className={`weave-app ${theme}`} style={{ "--accent": accent } as React.CSSProperties} data-background={background}>
      <header className="topbar">
        <div className="traffic-lights" aria-hidden="true"><span /><span /><span /></div>
        <button className="project-switcher" aria-label="Open project menu">
          <span className="project-mark">W</span>
          <span><strong>Northstar narrative</strong><small>weave / product-strategy</small></span>
          <span className="chevron">⌄</span>
        </button>
        <div className="document-title">
          <input className={!saved ? "unsaved-dot" : ""} aria-label="Deck title" value={deckTitle} onChange={(event) => { setDeckTitle(event.target.value); setSaved(false); }} />
          <small>Slide {activeSlide} of {slides.length}</small>
        </div>
        <div className="top-actions">
          <button className="icon-button" onClick={undo} disabled={historyState.undo === 0} aria-label="Undo">↶</button>
          <button className="icon-button" onClick={redo} disabled={historyState.redo === 0} aria-label="Redo">↷</button>
          <button className="icon-button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Toggle color mode">{theme === "dark" ? "☼" : "◐"}</button>
          <button className="share-button" onClick={openPresenter}>Present</button>
          <button className="share-button" onClick={exportDeck}>Export</button>
          <button className="share-button" onClick={printDeck}>PDF</button>
          <button className="share-button" onClick={downloadBundle}>Bundle</button>
          <button className="share-button" onClick={() => importRef.current?.click()}>Import</button>
          <input ref={importRef} className="sr-only" type="file" accept=".json,.weave.json,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importBundle(file); }} />
          <button className="save-button" onClick={() => void saveProject()} disabled={agentRunning}><span>{saved ? "✓" : "↑"}</span> {saved ? "Saved" : "Save"}</button>
        </div>
      </header>

      <div className="workspace" data-slide-nav={slideNav} data-inspector={inspectorOpen ? "open" : "closed"}>
        <nav className="activity-rail" aria-label="Primary navigation">
          <div className="activity-top">
            <button className="activity-button active" aria-label="Files">◇</button>
            <button className="activity-button" aria-label="Keyboard shortcuts" onClick={() => setShowHelp(true)}>⌨</button>
            <button className="activity-button" aria-label="History" onClick={() => setShowHistory(true)}>↶</button>
            <button className="activity-button" aria-label="Skills">✣</button>
          </div>
          <div className="activity-bottom">
            <div className="avatar">FK</div>
            <button className="activity-button" aria-label="Settings" onClick={() => setShowCodexSettings(true)}>⚙</button>
          </div>
        </nav>

        {slideNav === "rail" && <nav className="slide-nav slide-rail" aria-label="Slides">{slideNavigator}</nav>}

        <aside className="left-panel">
          <section className="agent-panel">
            <div className="agent-heading">
              <span><i aria-hidden="true" className={`agent-status ${agentReady ? "" : "offline"}`} /> AGENT</span>
              <button className="thread-switcher" onClick={() => setShowThreads((value) => !value)} aria-expanded={showThreads} title="Switch conversation"><span>{activeThreadName}</span><em aria-hidden="true">⌄</em></button>
              <button onClick={() => void newThread()} aria-label="New conversation" title="New conversation" disabled={agentRunning}>＋</button>
            </div>
            {showThreads && (
              <>
                <div className="thread-popover-backdrop" role="presentation" onMouseDown={() => setShowThreads(false)} />
                <div className="thread-popover">
                  <div className="thread-controls">
                    <input type="search" value={threadSearch} onChange={(event) => setThreadSearch(event.target.value)} placeholder="Search Threads" aria-label="Search Threads" />
                    <button className={showArchivedThreads ? "active" : ""} onClick={() => setShowArchivedThreads((value) => !value)}>{showArchivedThreads ? "Active" : "Archive"}</button>
                  </div>
                  <div className="thread-list" aria-label="Threads">
                    {codexState.threadOrder.map((id) => codexState.threads[id]).filter((thread) => thread && thread.archived === showArchivedThreads).slice(0, 12).map((thread) => (
                      <button key={thread.id} className={codexState.activeThreadId === thread.id ? "active" : ""} onClick={() => { setShowThreads(false); void openThread(thread.id); }}>
                        <strong>{displayThreadName(thread.name) || thread.preview || "New conversation"}</strong>
                        <small>{thread.status}</small>
                      </button>
                    ))}
                  </div>
                  {codexState.activeThreadId && (
                    <div className="thread-actions">
                      <button onClick={() => { const name = window.prompt("Thread name", displayThreadName(codexState.threads[codexState.activeThreadId!]?.name) ?? ""); if (name !== null) void threadAction("name", { name }); }}>Rename</button>
                      <button onClick={() => void forkThread()}>Fork</button>
                      <button onClick={() => void manageGoal()}>Goal</button>
                      <button onClick={() => void threadAction("compact")}>Compact</button>
                      <button onClick={() => void threadAction(showArchivedThreads ? "unarchive" : "archive")}>{showArchivedThreads ? "Unarchive" : "Archive"}</button>
                      <button onClick={() => { if (window.confirm("Delete this Weave Thread permanently?")) void threadAction("delete"); }}>Delete</button>
                    </div>
                  )}
                </div>
              </>
            )}
            <div ref={messagesRef} className="messages" role="log" aria-live="polite" aria-relevant="additions text" aria-label="Conversation with Agent" onScroll={(event) => { const element = event.currentTarget; shouldAutoScrollRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48; }}>
              <div className="context-chip" role="status"><span aria-hidden="true">◎</span> Slide {activeSlide} in context · {agentActivity}</div>
              {!codexState.activeThreadId && <p className="empty-thread">Start or select a conversation.</p>}
              {activeTurns.length > visibleTurns.length && <p className="trimmed-log">Showing the latest {visibleTurns.length} turns.</p>}
              {visibleTurns.map((turn) => (
                <section className="turn-group" key={turn.id}>
                  {selectTurnItems(codexState, turn.id).map((item) => <ItemCard key={item.id} item={item} />)}
                  <footer><span>{turn.status}</span>{turn.diff && <details><summary>Turn diff</summary><pre>{turn.diff}</pre></details>}</footer>
                </section>
              ))}
              {Object.values(codexState.pendingRequests).map((pending) => (
                <ServerRequestCard key={String(pending.id)} request={pending} onResolve={(id, result) => void resolveServerRequest(id, result)} onReject={(id) => void rejectServerRequest(id)} />
              ))}
              <div ref={messagesEndRef} className="messages-end" />
            </div>
            <div className="chat-box">
              <textarea value={promptDraft} onChange={(event) => setPromptDraft(event.target.value)} onCompositionStart={() => { compositionRef.current = true; }} onCompositionEnd={() => { compositionRef.current = false; }} onKeyDown={(event) => { const nativeEvent = event.nativeEvent as KeyboardEvent; const isComposing = compositionRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229; if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !isComposing) { event.preventDefault(); void sendMessage(); } }} placeholder={agentReady ? "Ask Agent to edit this slide…" : "Waiting for local Codex…"} aria-label="Message Agent" maxLength={20000} disabled={!agentReady} />
              <div>
                <span>⌘ / Ctrl ↵</span>
                {agentRunning && <button className="stop-button" onClick={() => void interruptAgent()} aria-label="Stop Agent" title="Stop Agent">■</button>}
                <button className="send-button" onClick={() => void sendMessage()} disabled={!agentReady || !promptDraft.trim() || turnSubmitting} aria-label="Send message">↑</button>
              </div>
            </div>
          </section>
        </aside>

        <section className="center-stage">
          <div className="editor-tabs">
            <div className="variation-tabs">
              <button className={activeVariation === "main" ? "active" : ""} onClick={() => void checkoutVariation("main")} disabled={agentRunning}><span className="variation-dot dot-0" />Original</button>
              {variations.map((variation, index) => (
                <button key={variation.branch} className={activeVariation === variation.branch ? "active" : ""} onClick={() => void checkoutVariation(variation.branch)} disabled={agentRunning}>
                  <span className={`variation-dot dot-${index + 1}`} />{variation.label}<small>{variation.status === "ready" ? "Ready" : "Generating"}</small>
                </button>
              ))}
              <button className="add-variation" onClick={() => setShowVariationPrompt(!showVariationPrompt)} aria-label="Add direction" disabled={agentRunning}>＋</button>
            </div>
            <div className="editor-tab-actions">
              {activeVariation.startsWith("weave/variation/") && (
                <>
                  <button className="archive-direction" onClick={() => void archiveVariation()} disabled={agentRunning}>Send to history</button>
                  <button className="use-direction" onClick={() => void acceptVariation()} disabled={agentRunning}>Use this direction</button>
                </>
              )}
              <div className="view-toggle" role="group" aria-label="Editor view">
                <button className={mode === "preview" ? "active" : ""} onClick={() => { if (mode === "code") reinject(); setMode("preview"); }}>▣ <span>Preview</span></button>
                <button className={mode === "code" ? "active" : ""} onClick={() => { setSlidesSynced(captureActive()); setMode("code"); }}>‹› <span>Code</span></button>
              </div>
            </div>
          </div>

          <div className="canvas-area">
            {showVariationPrompt && (
              <div className="variation-prompt">
                <div><span>NEW DIRECTION</span><button onClick={() => setShowVariationPrompt(false)}>×</button></div>
                <label htmlFor="variation-prompt">How should this direction feel?</label>
                <textarea id="variation-prompt" value={variationPrompt} maxLength={16000} onChange={(event) => setVariationPrompt(event.target.value)} />
                <button onClick={() => void generateVariation()} disabled={!agentReady || agentRunning}><span>✦</span> Generate direction</button>
                <small>Generated sequentially from the latest saved version.</small>
              </div>
            )}
            {mode === "preview" ? (
              <div className="slide-shell">
                {/* The project stylesheet is the only thing styling the slide; the editor's
                    own chrome lives in globals.css and never overlaps these rules. */}
                <style>{deckCss}</style>
                <div
                  className="slide-viewport"
                  data-zoom-mode={manualZoom == null ? "fit" : "manual"}
                  ref={(node) => { viewportRef.current = node; canvasRef.current = node; }}
                  style={{ "--slide-scale": slideScale } as React.CSSProperties}
                  onPointerDown={onCanvasPointerDown}
                  onDoubleClick={onCanvasDoubleClick}
                  onBlurCapture={onCanvasBlurCapture}
                  onKeyDown={onCanvasKeyDown}
                  onDragStart={onCanvasDragStart}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={onCanvasDrop}
                />
                <div className="canvas-toolbar">
                  <button onClick={() => setShowAdd(!showAdd)} className={showAdd ? "active" : ""}>＋ Add block</button>
                  <button onClick={duplicateSlide} title="Duplicate slide">Duplicate</button>
                  <button onClick={saveSlideTemplate}>Save template</button>
                  <button onClick={() => setShowTemplates(true)}>Library</button>
                  <button onClick={() => moveSlide(-1)} disabled={activeSlide === 1} aria-label="Move slide left">←</button>
                  <button onClick={() => moveSlide(1)} disabled={activeSlide === slides.length} aria-label="Move slide right">→</button>
                  <button onClick={deleteSlide} disabled={slides.length <= 1}>Delete slide</button>
                  <span />
                  <button aria-label="Zoom out" onClick={() => setManualZoom(Math.max(.25, (manualZoom ?? fitScale) - .1))}>−</button>
                  <b>{Math.round(slideScale * 100)}%</b>
                  <button aria-label="Zoom in" onClick={() => setManualZoom(Math.min(4, (manualZoom ?? fitScale) + .1))}>＋</button>
                  <button aria-label="Actual size" onClick={() => setManualZoom(1)}>100</button>
                  <button aria-label="Fit to screen" onClick={() => setManualZoom(null)}>⊡</button>
                </div>
                {showAdd && (
                  <div className="block-picker">
                    <small>INSERT BLOCK</small>
                    {blockKinds.map((kind) => (
                      <button key={kind} onClick={() => addBlock(kind)}>
                        <i>{blockIcons[kind]}</i>
                        <span><strong>{kind === "paragraph" ? "Body text" : kind[0].toUpperCase() + kind.slice(1)}</strong><small>Add to slide flow</small></span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="code-editor">
                <div className="code-breadcrumb"><span>slides</span> / <span>{slides[activeSlide - 1]?.id}.html</span></div>
                <pre>
                  {codeView.split("\n").map((line, index) => (
                    <div key={index}><span className="line-number">{index + 1}</span><code>{line}</code></div>
                  ))}
                </pre>
              </div>
            )}
          </div>

          {slideNav === "filmstrip" && <nav className="slide-nav filmstrip" aria-label="Slides">{slideNavigator}</nav>}
        </section>

        {inspectorOpen ? <aside className="inspector">
          <div className="inspector-heading"><span>INSPECTOR</span><button aria-label="Close inspector" onClick={() => setInspectorOpen(false)}>×</button></div>
          <div className="selection-path"><span>section.hero</span><b>›</b><strong>{sel ? `${sel.kind}.${sel.id}` : "no selection"}</strong></div>
          <section className="layer-tree">
            <div className="property-heading"><span>OBJECT TREE</span><span>{outline.length}</span></div>
            <div>
              <span className="tree-root">⌄ <b>section.hero</b></span>
              {outline.map((item) => (
                <button key={item.id} style={{ paddingLeft: 14 + item.depth * 14 }} className={selectedId === item.id ? "active" : ""} onClick={() => setSelectedId(item.id)}>
                  <i>{blockIcons[item.kind] ?? "▦"}</i><span>{item.label}</span><small>{item.kind}</small>
                </button>
              ))}
            </div>
          </section>
          {sel && (
            <section className="property-section">
              <div className="property-heading"><span>{containerLike ? "LAYOUT" : "TEXT"}</span><span>{sel.kind}</span></div>
              {containerLike && (
                <div className="property-row">
                  <span>Direction</span>
                  <div className="scale-options">
                    {[{ label: "Row", value: "row" }, { label: "Column", value: "column" }].map((opt) => (
                      <button key={opt.value} className={(sel.read.direction || "row") === opt.value ? "active" : ""} onClick={() => setDirection(opt.value)}>{opt.label}</button>
                    ))}
                  </div>
                </div>
              )}
              {inspectorSchema.map((ctl) => {
                const current = sel.read[ctl.prop] ?? "";
                const inScale = ctl.scale.some((opt) => isActiveValue(ctl.prop, current, opt.value));
                return (
                  <div className="property-row" key={ctl.prop}>
                    <span>{ctl.label}</span>
                    <div className="scale-options">
                      {ctl.scale.map((opt) => (
                        <button key={`${ctl.prop}-${opt.label}`} className={isActiveValue(ctl.prop, current, opt.value) ? "active" : ""} onClick={() => setProp(ctl.prop, opt.value)}>{opt.label}</button>
                      ))}
                      {ctl.custom && (
                        <input
                          className="scale-custom"
                          key={`${ctl.prop}-${sel.id}`}
                          defaultValue={inScale ? "" : current}
                          placeholder="css"
                          aria-label={`${ctl.label} custom value`}
                          onKeyDown={(event) => { if (event.key === "Enter") setProp(ctl.prop, (event.target as HTMLInputElement).value.trim()); }}
                          onBlur={(event) => { const next = event.target.value.trim(); if (next !== (inScale ? "" : current)) setProp(ctl.prop, next); }}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          )}
          <section className="property-section">
            <div className="property-heading"><span>SLIDE</span><span>⌃</span></div>
            <label><span>Title</span><input value={slides[activeSlide - 1]?.title ?? ""} onChange={(event) => renameSlide(event.target.value)} /></label>
            <label><span>Speaker notes</span><textarea value={slides[activeSlide - 1]?.notes ?? ""} onChange={(event) => setSlideNotes(event.target.value)} /></label>
          </section>
          <section className="property-section background-section">
            <div className="property-heading"><span>SLIDE BACKGROUND</span><span>⌃</span></div>
            <button className="background-select" onClick={() => setShowBackgrounds(!showBackgrounds)}>
              <span className={`background-preview ${background}`} />
              <span><strong>{background === "orbit" ? "Orbit / Dark" : background === "grid" ? "Grid / Graphite" : "Plain / Ink"}</strong><small>Project theme</small></span>
              <b>⌄</b>
            </button>
            {showBackgrounds && (
              <div className="background-options">
                {backgrounds.map((item) => (
                  <button key={item} onClick={() => setSlideBackground(item)}><span className={`background-preview ${item}`} />{item[0].toUpperCase() + item.slice(1)}</button>
                ))}
              </div>
            )}
          </section>
          <section className="accent-section">
            <span>ACCENT</span>
            <div>{accents.map((color) => <button key={color} style={{ background: color }} className={accent === color ? "active" : ""} onClick={() => setSlideAccent(color)} aria-label={`Use accent ${color}`} />)}</div>
          </section>
          <button className="delete-block" onClick={deleteSelected} disabled={!sel || outline.length <= 1}>Delete selected block</button>
        </aside> : <button className="open-inspector" onClick={() => setInspectorOpen(true)}>Inspector</button>}
      </div>

      <footer className="statusbar">
        <div>
          <button className="history-button" onClick={() => setShowHistory(!showHistory)}><span className="history-icon">↶</span><strong>History</strong></button>
          <button className={`quality-button ${quality.ok ? "ok" : "error"}`} onClick={() => setShowQuality(!showQuality)}>Quality {quality.ok ? "✓" : `${quality.errors} errors`}</button>
          <span>{project ? `${project.branch} · ${project.commit}` : "Connecting…"}</span>
          {apiError && <span className="status-error">{apiError}</span>}
        </div>
        <div><span>HTML</span><span>UTF-8</span><span>Spaces: 2</span><button className={`connection ${agentReady ? "" : "offline"}`} onClick={() => setConnectionEpoch((value) => value + 1)} title="Reconnect"><i /> {agentReady ? "Agent connected" : "Reconnect Agent"}</button></div>
      </footer>

      {showHistory && (
        <div className="history-popover">
          <div className="history-popover-heading"><span>HISTORY</span><button onClick={() => setShowHistory(false)}>×</button></div>
          <label className="save-message"><span>Next history label</span><input value={saveMessage} onChange={(event) => setSaveMessage(event.target.value)} placeholder={deckTitle} /></label>
          {project?.branch === "detached" && <button className="return-latest" onClick={() => void restoreHistory()} disabled={agentRunning}>Return to latest on main</button>}
          <div className="history-list">
            {history.map((entry, index) => (
              <button key={entry.id} onClick={() => void restoreHistory(entry.id)} disabled={!saved || agentRunning}>
                <i className={index === 0 ? "current" : ""} /><span><strong>{entry.message}</strong><small>{entry.shortId} · {new Date(entry.date).toLocaleString()}</small></span>
              </button>
            ))}
          </div>
          {!saved && <p>Save the current edit before restoring history.</p>}
        </div>
      )}
      {showQuality && (
        <aside className="quality-popover" aria-label="Deck quality report">
          <header><strong>Deck quality</strong><button onClick={() => setShowQuality(false)}>×</button></header>
          {quality.ok && <p className="quality-empty">No blocking quality issues.</p>}
          {quality.diagnostics.map((item: any, index: number) => (
            <div key={`${item.code}-${index}`} className="quality-row"><i className="error" /><span><strong>{item.message}</strong><small>{item.code} · {item.source}</small></span></div>
          ))}
        </aside>
      )}
      {showPresenter && (
        <div className="presenter" role="dialog" aria-modal="true" aria-label="Presentation mode" tabIndex={-1} ref={presenterRef} onKeyDown={(event) => {
          if (["ArrowRight", "PageDown", " "].includes(event.key)) setPresentSlide((value) => Math.min(slides.length, value + 1));
          if (["ArrowLeft", "PageUp"].includes(event.key)) setPresentSlide((value) => Math.max(1, value - 1));
          if (event.key === "Escape") setShowPresenter(false);
        }}>
          <style>{deckCss}</style>
          <div className="presenter-stage" style={{ "--slide-scale": presenterScale } as React.CSSProperties} dangerouslySetInnerHTML={{ __html: slides[presentSlide - 1]?.html ?? "" }} />
          <footer>
            <button onClick={() => setPresentSlide((value) => Math.max(1, value - 1))}>← Previous</button>
            <span>{presentSlide} / {slides.length}</span>
            <button onClick={() => setPresentSlide((value) => Math.min(slides.length, value + 1))}>Next →</button>
            <small>{slides[presentSlide - 1]?.notes || "No speaker notes"}</small>
            <button onClick={() => document.documentElement.requestFullscreen?.()}>Fullscreen</button>
            <button onClick={() => setShowPresenter(false)}>Exit</button>
          </footer>
        </div>
      )}
      {showHelp && (
        <div className="help-backdrop" role="presentation" onMouseDown={() => setShowHelp(false)}>
          <section className="shortcut-help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onMouseDown={(event) => event.stopPropagation()}>
            <header><strong>Keyboard shortcuts</strong><button onClick={() => setShowHelp(false)}>×</button></header>
            <dl><dt>← / →</dt><dd>Previous / next slide</dd><dt>Double-click or Enter</dt><dd>Edit selected text</dd><dt>Esc</dt><dd>Finish editing or close presentation</dd><dt>⌘/Ctrl Z</dt><dd>Undo</dd><dt>⌘/Ctrl Shift Z</dt><dd>Redo</dd><dt>?</dt><dd>Open this help</dd></dl>
          </section>
        </div>
      )}
      {showTemplates && (
        <div className="help-backdrop" role="presentation" onMouseDown={() => setShowTemplates(false)}>
          <section className="shortcut-help template-library" role="dialog" aria-modal="true" aria-label="Slide library" onMouseDown={(event) => event.stopPropagation()}>
            <header><strong>Slide library</strong><button onClick={() => setShowTemplates(false)}>×</button></header>
            {slideTemplates.length === 0 ? <p>No saved templates yet. Save the current slide to reuse it.</p> : slideTemplates.map((template) => (
              <button key={`${template.id}-${template.title}`} onClick={() => insertTemplate(template)}><span className="background-preview orbit" /><span><strong>{template.title}</strong><small>Saved slide</small></span></button>
            ))}
          </section>
        </div>
      )}
      <div className="sr-only" aria-live="polite">{announcement}</div>
      {showCodexSettings && (
        <div className="codex-settings-backdrop" role="presentation" onMouseDown={() => setShowCodexSettings(false)}>
          <section className="codex-settings" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div><strong>Settings</strong><small>Codex CLI {codexState.connection.cliVersion ?? "unknown"} · {codexState.connection.status}</small></div>
              <button onClick={() => setShowCodexSettings(false)}>×</button>
            </header>
            <section className="settings-first">
              <h3>Layout</h3>
              <label className="setting-row"><span>Slide navigator</span>
                <select value={slideNav} onChange={(event) => slideNavStore.write(event.target.value as SlideNav)}>
                  <option value="filmstrip">Filmstrip below the canvas</option>
                  <option value="rail">Rail beside the sidebar</option>
                </select>
              </label>
            </section>
            <div className="settings-grid">
              <label><span>Model</span>
                <select value={selectedModel} onChange={(event) => { const modelId = event.target.value; setSelectedModel(modelId); const model = codexState.catalog.models.find((item: any) => (item.id ?? item.model) === modelId) as any; if (model?.defaultReasoningEffort) setReasoningEffort(model.defaultReasoningEffort); }}>
                  {codexState.catalog.models.map((model: any) => (
                    <option key={model.id ?? model.model} value={model.id ?? model.model}>{model.displayName ?? model.name ?? model.id ?? model.model}{model.inputModalities?.length ? ` · ${model.inputModalities.join("/")}` : ""}</option>
                  ))}
                </select>
              </label>
              <label><span>Reasoning effort</span><select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value)}>{availableEfforts.map((effort: string) => <option key={effort}>{effort}</option>)}</select></label>
              <label><span>Approvals</span><select value={approvalPolicy} onChange={(event) => setApprovalPolicy(event.target.value)}><option value="never">Never (default)</option><option value="on-request">Ask when needed</option><option value="untrusted">Untrusted commands</option></select></label>
            </div>
            {codexState.catalog.modelProvider && <section><h3>Provider capabilities</h3><pre className="settings-output">{JSON.stringify(codexState.catalog.modelProvider, null, 2)}</pre></section>}
            <section>
              <h3>Account</h3>
              {codexState.catalog.account ? (
                <div className="setting-row"><span>{String(codexState.catalog.account.type ?? "Signed in")}</span><button onClick={() => { void fetch(`${apiBase}/codex/account/logout`, { method: "POST" }).then(async (response) => { const result = await response.json(); if (!response.ok) throw new Error(result.error); }).catch((error) => setApiError(error.message)); }}>Log out</button></div>
              ) : (
                <>
                  <button onClick={() => void login("chatgpt")}>Sign in with ChatGPT</button>
                  <div className="api-key-row"><input type="password" value={apiKeyDraft} onChange={(event) => setApiKeyDraft(event.target.value)} placeholder="API key (not stored by Weave)" /><button disabled={!apiKeyDraft} onClick={() => void login("apiKey")}>Use key</button></div>
                </>
              )}
            </section>
            <section>
              <h3>Skills</h3>
              {codexState.catalog.skills.flatMap((entry: any) => entry.skills ?? [entry]).map((skill: any) => (
                <label className="setting-row" key={skill.path ?? skill.name}><span>{skill.name ?? skill.path}</span><input type="checkbox" checked={skill.enabled !== false} onChange={(event) => void updateSkill(skill, event.target.checked)} /></label>
              ))}
            </section>
            <section>
              <h3>Hooks</h3>
              {codexState.catalog.hooks.flatMap((entry: any) => entry.hooks ?? [entry]).map((hook: any, index: number) => (
                <div className="setting-row" key={hook.name ?? hook.event ?? index}><span>{hook.name ?? hook.event ?? "Configured hook"}</span><small>{hook.enabled === false ? "disabled" : "enabled"}</small></div>
              ))}
            </section>
            <section>
              <h3>MCP servers</h3>
              {codexState.catalog.mcpServers.map((server: any) => (
                <div className="setting-row" key={server.name}>
                  <span>{server.name}</span><small>{server.status ?? server.authStatus ?? "configured"}</small>
                  {server.resources?.length > 0 && <button onClick={() => void invokeMcp(server, "resource")}>Resource</button>}
                  {Object.keys(server.tools ?? {}).length > 0 && <button disabled={!codexState.activeThreadId} onClick={() => void invokeMcp(server, "tool")}>Tool</button>}
                  <button onClick={() => { void fetch(`${apiBase}/codex/mcp/oauth`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: server.name }) }).then(async (response) => { const result = await response.json(); if (!response.ok) throw new Error(result.error); const url = result.authorizationUrl ?? result.url; if (url && window.confirm(`Open OAuth for ${server.name}?`)) window.open(url, "_blank", "noopener,noreferrer"); }).catch((error) => setApiError(error.message)); }}>OAuth</button>
                </div>
              ))}
              {mcpResult && <pre className="settings-output">{mcpResult}</pre>}
            </section>
          </section>
        </div>
      )}
    </main>
  );
}
