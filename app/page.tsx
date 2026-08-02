"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- app-server catalog/request payloads are rendered defensively for forward compatibility. */

import { DragEvent, MouseEvent as ReactMouseEvent, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { actionFromStreamEvent } from "./codex/actions";
import { EditableText, focusEditableAt } from "./components/EditableText";
import { blockTag, containerKinds, defaultDeckCss, designHeight, designWidth, metricParts, renderDeckDocument, renderSlideDocument } from "../shared/slide-design.mjs";
import { ItemCard } from "./codex/components/ItemCard";
import { ServerRequestCard } from "./codex/components/ServerRequestCard";
import { codexReducer, initialCodexState } from "./codex/reducer";
import { selectThreadRunning, selectThreadTurns, selectTurnItems } from "./codex/selectors";
import { auditDeckQuality } from "../shared/slide-audit.mjs";
import { auditCssSafety } from "../shared/content-policy.mjs";

type Block = {
  id: string;
  kind: "eyebrow" | "heading" | "paragraph" | "metrics" | "note" | "row" | "column" | "grid";
  label: string;
  text: string;
  children?: Block[];
  style?: {
    size?: "sm" | "md" | "lg";
    weight?: "regular" | "medium" | "bold";
    align?: "left" | "center" | "right";
    color?: "primary" | "muted" | "accent";
    spacing?: "tight" | "normal" | "loose";
    columns?: 2 | 3;
  };
};

type SlideNav = "filmstrip" | "rail";

type DeckSlide = {
  id: string;
  title: string;
  background: "orbit" | "grid" | "plain";
  blocks: Block[];
  notes?: string;
};

type DeckSnapshot = {
  title: string;
  activeSlide: number;
  background: DeckSlide["background"];
  accent: string;
  blocks: Block[];
  slides: DeckSlide[];
};

type HistoryEntry = {
  id: string;
  shortId: string;
  message: string;
  date: string;
};

type ServerState = {
  deck: {
    title: string;
    activeSlide: number;
    background: "orbit" | "grid" | "plain";
    accent: string;
    blocks: Block[];
    slides: DeckSlide[];
  };
  css: string;
  history: HistoryEntry[];
  variations: Array<{
    branch: string;
    label: string;
    commit: string;
    message: string;
    status: "ready" | "generating";
  }>;
  project: {
    root: string;
    branch: string;
    commit: string;
    revision?: string;
    clean: boolean;
  };
  codex: {
    ready: boolean;
    connection: string;
    version: { compatible: boolean; running: string; generated: string; message: string | null } | null;
    catalog: {
      models: any[];
      skills: any[];
      hooks: any[];
      mcpServers: any[];
      account: Record<string, any> | null;
      modelProvider: Record<string, any> | null;
    };
    activeTurns: Record<string, string>;
    pendingRequests: Array<{ id: string | number; method: string; params: Record<string, any>; createdAt: number }>;
  };
  migrationNotice: string;
};

const apiBase = "http://127.0.0.1:4317/api";

/* Slide-navigator placement lives in localStorage, read through an external store so the
   server and the first client render agree on the default before the stored value applies. */
const slideNavKey = "weave.slideNav";
const slideNavListeners = new Set<() => void>();
const slideNavStore = {
  subscribe(listener: () => void) {
    slideNavListeners.add(listener);
    return () => {
      slideNavListeners.delete(listener);
    };
  },
  read: (): SlideNav => (window.localStorage.getItem(slideNavKey) === "rail" ? "rail" : "filmstrip"),
  serverRead: (): SlideNav => "filmstrip",
  write(value: SlideNav) {
    window.localStorage.setItem(slideNavKey, value);
    slideNavListeners.forEach((listener) => listener());
  },
};

const templateKey = "weave.slideTemplates";
const emptyTemplates: DeckSlide[] = [];
let templateCacheRaw = "";
let templateCache: DeckSlide[] = [];
const templateListeners = new Set<() => void>();
const templateStore = {
  subscribe(listener: () => void) { templateListeners.add(listener); return () => templateListeners.delete(listener); },
  read(): DeckSlide[] {
    const raw = window.localStorage.getItem(templateKey) ?? "";
    if (raw === templateCacheRaw) return templateCache;
    templateCacheRaw = raw;
    try { templateCache = raw ? JSON.parse(raw) : []; } catch { templateCache = []; }
    return templateCache;
  },
  serverRead: (): DeckSlide[] => emptyTemplates,
  write(value: DeckSlide[]) {
    templateCache = value;
    templateCacheRaw = JSON.stringify(value);
    window.localStorage.setItem(templateKey, templateCacheRaw);
    templateListeners.forEach((listener) => listener());
  },
};

const createMessageId = () =>
  `weave-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const retryDelay = (attempt: number) => Math.min(10_000, 400 * (2 ** Math.min(attempt, 5))) + Math.random() * 250;
const displayThreadName = (name: string | null | undefined) =>
  name?.replace(/^Weave · /, "") || null;

const initialBlocks: Block[] = [
  { id: "eyebrow", kind: "eyebrow", label: "Eyebrow", text: "PRODUCT STRATEGY · 2026" },
  { id: "heading", kind: "heading", label: "Heading", text: "Make ideas visible,\nwhile they’re still moving." },
  {
    id: "paragraph",
    kind: "paragraph",
    label: "Body",
    text: "A shared canvas where your team and an agent shape the same story — from first thought to final slide.",
  },
  { id: "metrics", kind: "metrics", label: "Metrics row", text: "3.2×|faster iteration|42%|less rework" },
  { id: "note", kind: "note", label: "Footnote", text: "Q3 PRODUCT NARRATIVE" },
];

const initialSlides: DeckSlide[] = [
  { id: "opportunity", title: "The opportunity", background: "orbit", blocks: initialBlocks },
  { id: "market-shift", title: "Market shift", background: "grid", blocks: initialBlocks },
  { id: "approach", title: "Our approach", background: "orbit", blocks: initialBlocks },
  { id: "next-steps", title: "Next steps", background: "plain", blocks: initialBlocks },
];

const blockIcons: Record<Block["kind"], string> = {
  eyebrow: "T",
  heading: "H",
  paragraph: "¶",
  metrics: "▦",
  note: "≡",
  row: "↔",
  column: "↕",
  grid: "▦",
};

const clone = <T,>(value: T): T => structuredClone(value);
const flattenBlocks = (items: Block[]): Block[] => items.flatMap((block) => [block, ...flattenBlocks(block.children ?? [])]);
const blocksWithDepth = (items: Block[], depth = 0): Array<{ block: Block; depth: number }> => items.flatMap((block) => [
  { block, depth },
  ...blocksWithDepth(block.children ?? [], depth + 1),
]);
const findBlock = (items: Block[], id: string): Block | undefined => flattenBlocks(items).find((item) => item.id === id);
const mapBlocks = (items: Block[], id: string, patch: Partial<Block>): Block[] => items.map((item) => item.id === id
  ? { ...item, ...patch }
  : { ...item, ...(item.children ? { children: mapBlocks(item.children, id, patch) } : {}) });
const removeBlock = (items: Block[], id: string): Block[] => items
  .filter((item) => item.id !== id)
  .map((item) => ({ ...item, ...(item.children ? { children: removeBlock(item.children, id) } : {}) }));
const insertBeforeBlock = (items: Block[], targetId: string, block: Block): Block[] => items.flatMap((item) => {
  if (item.id === targetId) return [block, item];
  return [{ ...item, ...(item.children ? { children: insertBeforeBlock(item.children, targetId, block) } : {}) }];
});
const styleClass = (block: Block) => [
  block.style?.size && `size-${block.style.size}`,
  block.style?.weight && `weight-${block.style.weight}`,
  block.style?.align && `align-${block.style.align}`,
  block.style?.color && `color-${block.style.color}`,
  block.style?.spacing && `spacing-${block.style.spacing}`,
  block.kind === "grid" && `columns-${block.style?.columns ?? 2}`,
].filter(Boolean).join(" ");

export default function Home() {
  const [deckTitle, setDeckTitle] = useState("Q3 Strategy Deck");
  const [blocks, setBlocks] = useState(initialBlocks);
  const [selectedId, setSelectedId] = useState("heading");
  const [mode, setMode] = useState<"preview" | "code">("preview");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [accent, setAccent] = useState("#f6b84b");
  const [background, setBackground] = useState<"orbit" | "grid" | "plain">("orbit");
  const [activeSlide, setActiveSlide] = useState(1);
  const [deckSlides, setDeckSlides] = useState<DeckSlide[]>(initialSlides);
  const [deckCss, setDeckCss] = useState<string>(defaultDeckCss);
  const [fitScale, setFitScale] = useState(0.68);
  const [manualZoom, setManualZoom] = useState<number | null>(null);
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
  const [editingId, setEditingId] = useState<string | null>(null);
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
  const viewportRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const compositionRef = useRef(false);
  const turnInFlightRef = useRef(false);
  const shouldAutoScrollRef = useRef(true);
  const eventSequenceRef = useRef(0);
  const undoRef = useRef<DeckSnapshot[]>([]);
  const redoRef = useRef<DeckSnapshot[]>([]);

  const selected = findBlock(blocks, selectedId) ?? flattenBlocks(blocks)[0];
  const slideScale = manualZoom ?? fitScale;
  const effectiveSlides = useMemo(() => deckSlides.map((slide, index) =>
    index === activeSlide - 1 ? { ...slide, background, blocks } : slide,
  ), [deckSlides, activeSlide, background, blocks]);
  /* The code view shows the file the next save writes, rendered by the same module. */
  const code = useMemo(
    () => mode === "code" ? renderSlideDocument(
      { title: deckTitle, activeSlide, background, accent, blocks, slides: deckSlides },
      deckCss,
    ) : "",
    [mode, deckTitle, activeSlide, background, accent, blocks, deckSlides, deckCss],
  );
  const agentReady = codexState.connection.status === "connected";
  const agentRunning = selectThreadRunning(codexState, codexState.activeThreadId);
  const activeTurns = selectThreadTurns(codexState, codexState.activeThreadId);
  const visibleTurns = activeTurns.slice(-100);
  const selectedModelInfo = useMemo(
    () => codexState.catalog.models.find(
      (model: any) => (model.id ?? model.model) === selectedModel,
    ) as any,
    [codexState.catalog.models, selectedModel],
  );
  const availableEfforts = useMemo(
    () => selectedModelInfo?.supportedReasoningEfforts?.map(
      (option: any) => option.reasoningEffort,
    ) ?? ["low", "medium", "high"],
    [selectedModelInfo],
  );
  const agentActivity = !agentReady
    ? codexState.connection.error ?? "Connecting to Codex…"
    : agentRunning
      ? "Codex is working…"
      : "Ready";
  const activeThread = codexState.activeThreadId ? codexState.threads[codexState.activeThreadId] : null;
  const activeThreadName = activeThread
    ? displayThreadName(activeThread.name) || activeThread.preview || "New conversation"
    : "No conversation";
  const deckPayload = () => {
    return {
      title: deckTitle,
      activeSlide,
      background,
      accent,
      blocks,
      slides: effectiveSlides,
    };
  };

  const contextEnvelope = () => ({
    revision: serverRevision,
    activeSlide,
    selected: selected ? { id: selected.id, kind: selected.kind, label: selected.label, text: selected.text } : null,
    selectedText: typeof window === "undefined" ? "" : window.getSelection()?.toString().slice(0, 2_000) ?? "",
    deck: deckPayload(),
    css: deckCss.slice(0, 30_000),
    recentHistory: history.slice(0, 5).map(({ shortId, message }) => ({ shortId, message })),
  });

  const quality = useMemo(() => {
    const payload = deckPayload();
    const deckResult = auditDeckQuality(payload);
    const cssResult = auditCssSafety(deckCss);
    return {
      ok: deckResult.ok && cssResult.ok,
      diagnostics: [...deckResult.diagnostics, ...cssResult.diagnostics],
      errors: deckResult.summary.errors + cssResult.summary.errors,
      warnings: deckResult.summary.warnings,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deckPayload is intentionally derived from these editor states.
  }, [deckTitle, activeSlide, background, accent, blocks, deckSlides, deckCss]);

  const snapshot = (): DeckSnapshot => clone(deckPayload());
  const restoreSnapshot = (value: DeckSnapshot) => {
    setDeckTitle(value.title);
    setActiveSlide(value.activeSlide);
    setBackground(value.background);
    setAccent(value.accent);
    setBlocks(clone(value.blocks));
    setDeckSlides(clone(value.slides));
    setSelectedId(flattenBlocks(value.blocks)[0]?.id ?? "");
    setSaved(false);
  };
  const checkpoint = () => {
    undoRef.current = [...undoRef.current.slice(-79), snapshot()];
    redoRef.current = [];
    setHistoryState({ undo: undoRef.current.length, redo: 0 });
  };
  const undo = () => {
    const value = undoRef.current.pop();
    if (!value) return;
    redoRef.current.push(snapshot());
    restoreSnapshot(value);
    setHistoryState({ undo: undoRef.current.length, redo: redoRef.current.length });
    setAnnouncement("Change undone");
  };
  const redo = () => {
    const value = redoRef.current.pop();
    if (!value) return;
    undoRef.current.push(snapshot());
    restoreSnapshot(value);
    setHistoryState({ undo: undoRef.current.length, redo: redoRef.current.length });
    setAnnouncement("Change redone");
  };

  const applyServerState = useCallback((state: ServerState) => {
    setDeckTitle(state.deck.title);
    setBlocks(state.deck.blocks);
    setDeckSlides(state.deck.slides ?? initialSlides);
    if (state.css) setDeckCss(state.css);
    setActiveSlide(state.deck.activeSlide);
    setBackground(state.deck.background);
    setAccent(state.deck.accent);
    setHistory(state.history);
    setVariations(state.variations ?? []);
    setProject(state.project);
    setServerRevision(state.project.revision ?? state.project.commit);
    setActiveVariation(state.project.branch);
    dispatchCodex({
      type: "connection",
      connection: {
        status: state.codex.ready ? "connected" : state.codex.version?.compatible === false ? "incompatible" : "connecting",
        error: state.codex.version?.message ?? null,
        cliVersion: state.codex.version?.running,
      },
    });
    dispatchCodex({ type: "catalog", catalog: state.codex.catalog });
    dispatchCodex({ type: "pendingRequests", requests: state.codex.pendingRequests });
    dispatchCodex({ type: "activeTurns", activeTurns: state.codex.activeTurns });
    setSelectedModel((current) => {
      if (current) return current;
      const firstModel = state.codex.catalog.models?.[0];
      return firstModel?.id ?? firstModel?.model ?? "";
    });
    setReasoningEffort((current) => {
      const firstModel = state.codex.catalog.models?.[0];
      const supported = firstModel?.supportedReasoningEfforts?.map((option: any) => option.reasoningEffort) ?? [];
      return supported.length > 0 && !supported.includes(current)
        ? firstModel.defaultReasoningEffort ?? supported[0]
        : current;
    });
    setSaved(state.project.clean);
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
        applyServerState(state);
        if (!state.codex.ready) {
          attempts += 1;
          timer = setTimeout(() => void loadState(), retryDelay(attempts));
        }
      } catch (error) {
        if (canceled) return;
        dispatchCodex({ type: "connection", connection: { status: "disconnected", error: "Local API offline" } });
        setApiError(error instanceof Error ? error.message : String(error));
        attempts += 1;
        timer = setTimeout(() => void loadState(), retryDelay(attempts));
      }
    };
    void loadState();
    return () => {
      canceled = true;
      if (timer) clearTimeout(timer);
    };
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
        if (!canceled) {
          dispatchCodex({ type: "connection", connection: { status: "reconnecting", error: error instanceof Error ? error.message : String(error) } });
        }
      }
      if (!canceled) retryTimer = setTimeout(() => void connect(), retryDelay(1));
    };
    void connect();
    return () => {
      canceled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [applyServerState]);

  useEffect(() => {
    let canceled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const query = new URLSearchParams({
            archived: String(showArchivedThreads),
            ...(threadSearch.trim() ? { q: threadSearch.trim() } : {}),
          });
          const response = await fetch(`${apiBase}/codex/threads?${query}`);
          const result = await response.json();
          if (!response.ok) throw new Error(result.error ?? "Could not list threads.");
          if (canceled) return;
          dispatchCodex({ type: "threadsLoaded", threads: result.data ?? [], archived: showArchivedThreads });
          if (!codexState.activeThreadId && result.data?.[0]) {
            const read = await fetch(`${apiBase}/codex/thread/read`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ threadId: result.data[0].id }),
            });
            if (read.ok && !canceled) {
              const value = await read.json();
              dispatchCodex({ type: "threadLoaded", thread: value.thread, activate: true });
            }
          }
        } catch (error) {
          if (!canceled) setApiError(error instanceof Error ? error.message : String(error));
        }
      })();
    }, 180);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [showArchivedThreads, threadSearch, agentReady, codexState.activeThreadId]);

  /* Slides are authored at the design size and scaled to fit, so one stylesheet in
     absolute pixels drives the canvas, the exported file and any future thumbnail. */
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(([entry]) => {
      setFitScale(Math.min(entry.contentRect.width / designWidth, entry.contentRect.height / designHeight));
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [mode]);

  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      messagesEndRef.current?.scrollIntoView({
        behavior: agentRunning ? "smooth" : "auto",
        block: "end",
      });
    }
  }, [codexState.items, agentRunning]);

  const updateSelected = (patch: Partial<Block>) => {
    if (!selected) return;
    checkpoint();
    setBlocks((items) => mapBlocks(items, selected.id, patch));
    setSaved(false);
  };

  const selectBlock = (id: string) => {
    setSelectedId(id);
    setMode("preview");
  };

  const editBlockText = (id: string, text: string) => {
    const target = findBlock(blocks, id);
    if (!target || target.text === text) return;
    checkpoint();
    setBlocks((items) => mapBlocks(items, id, { text }));
    setSaved(false);
  };

  /* Metric blocks keep "value|caption|value|caption" in one string, so each cell
     writes back into its own slot. Separators typed by hand would split the row. */
  const editMetricPart = (block: Block, index: number, part: string) => {
    const parts = block.text.split("|");
    parts[index] = part.replace(/[|\n]/g, " ");
    editBlockText(block.id, parts.join("|"));
  };

  const switchSlide = async (slideNumber: number) => {
    const slides = deckSlides.map((slide, index) => index === activeSlide - 1 ? { ...slide, background, blocks } : slide);
    const slide = slides[slideNumber - 1];
    if (!slide) return;
    setActiveSlide(slideNumber);
    setBlocks(slide.blocks);
    setBackground(slide.background);
    setSelectedId(slide.blocks[0]?.id ?? "");
    setDeckSlides(slides);
  };

  const addSlide = () => {
    checkpoint();
    const slideNumber = deckSlides.length + 1;
    const blocks: Block[] = [
      { id: `eyebrow-${slideNumber}`, kind: "eyebrow", label: "Eyebrow", text: "NEW SLIDE" },
      { id: `heading-${slideNumber}`, kind: "heading", label: "Heading", text: "Give this idea a clear title." },
      { id: `paragraph-${slideNumber}`, kind: "paragraph", label: "Body", text: "Add the detail your audience needs to move forward." },
    ];
    const slide: DeckSlide = { id: `slide-${slideNumber}`, title: `Untitled ${slideNumber}`, background: "orbit", blocks };
    setDeckSlides((items) => [...items, slide]);
    setActiveSlide(slideNumber);
    setBlocks(blocks);
    setBackground(slide.background);
    setSelectedId(blocks[0].id);
    setSaved(false);
  };

  const duplicateSlide = () => {
    checkpoint();
    const source = { ...deckSlides[activeSlide - 1], background, blocks };
    const suffix = createMessageId().slice(6);
    const regenerate = (items: Block[]): Block[] => items.map((item) => ({
      ...clone(item),
      id: `${item.id}-${suffix}`,
      ...(item.children ? { children: regenerate(item.children) } : {}),
    }));
    const copy = { ...clone(source), id: `${source.id}-${suffix}`, title: `${source.title} copy`, blocks: regenerate(source.blocks) };
    const next = [...deckSlides];
    next.splice(activeSlide, 0, copy);
    setDeckSlides(next);
    setActiveSlide(activeSlide + 1);
    setBlocks(copy.blocks);
    setSelectedId(flattenBlocks(copy.blocks)[0]?.id ?? "");
    setSaved(false);
  };

  const deleteSlide = () => {
    if (deckSlides.length <= 1) return;
    checkpoint();
    const next = deckSlides.filter((_, index) => index !== activeSlide - 1);
    const nextNumber = Math.min(activeSlide, next.length);
    const slide = next[nextNumber - 1];
    setDeckSlides(next);
    setActiveSlide(nextNumber);
    setBlocks(slide.blocks);
    setBackground(slide.background);
    setSelectedId(flattenBlocks(slide.blocks)[0]?.id ?? "");
    setSaved(false);
  };

  const moveSlide = (direction: -1 | 1) => {
    const target = activeSlide - 1 + direction;
    if (target < 0 || target >= deckSlides.length) return;
    checkpoint();
    const next = deckSlides.map((slide, index) => index === activeSlide - 1 ? { ...slide, blocks, background } : slide);
    [next[activeSlide - 1], next[target]] = [next[target], next[activeSlide - 1]];
    setDeckSlides(next);
    setActiveSlide(target + 1);
    setSaved(false);
  };

  const renameSlide = (title: string) => {
    checkpoint();
    setDeckSlides((items) => items.map((slide, index) => index === activeSlide - 1 ? { ...slide, title } : slide));
    setSaved(false);
  };

  const saveSlideTemplate = () => {
    const slide = clone({ ...deckSlides[activeSlide - 1], blocks, background });
    const next = [...slideTemplates.filter((item) => item.title !== slide.title), slide].slice(-30);
    templateStore.write(next);
    setAnnouncement(`Saved ${slide.title} to the slide library`);
  };

  const insertTemplate = (template: DeckSlide) => {
    checkpoint();
    const suffix = createMessageId().slice(6);
    const regenerate = (items: Block[]): Block[] => items.map((item) => ({ ...clone(item), id: `${item.id}-${suffix}`, ...(item.children ? { children: regenerate(item.children) } : {}) }));
    const slide = { ...clone(template), id: `${template.id}-${suffix}`, blocks: regenerate(template.blocks) };
    const next = [...deckSlides];
    next.splice(activeSlide, 0, slide);
    setDeckSlides(next);
    setActiveSlide(activeSlide + 1);
    setBlocks(slide.blocks);
    setBackground(slide.background);
    setSelectedId(flattenBlocks(slide.blocks)[0]?.id ?? "");
    setShowTemplates(false);
    setSaved(false);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.matches("input, textarea, [contenteditable=true]")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if (event.key === "?") {
        setShowHelp(true);
      } else if (event.key === "ArrowRight" && activeSlide < deckSlides.length) {
        void switchSlide(activeSlide + 1);
      } else if (event.key === "ArrowLeft" && activeSlide > 1) {
        void switchSlide(activeSlide - 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const deleteSelected = () => {
    if (!selected || flattenBlocks(blocks).length <= 1) return;
    checkpoint();
    const remaining = removeBlock(blocks, selected.id);
    setBlocks(remaining);
    setSelectedId(flattenBlocks(remaining)[0]?.id ?? "");
    setSaved(false);
  };

  const addBlock = (kind: Block["kind"]) => {
    checkpoint();
    const id = `${kind}-${createMessageId().slice(6)}`;
    const defaults: Record<Block["kind"], string> = {
      eyebrow: "NEW SECTION",
      heading: "A clear, compelling headline.",
      paragraph: "Add supporting detail that helps your audience understand the idea.",
      metrics: "24%|growth|8 wk|to launch",
      note: "SOURCE · INTERNAL RESEARCH",
      row: "",
      column: "",
      grid: "",
    };
    const nextBlock: Block = { id, kind, label: `New ${kind}`, text: defaults[kind], ...(containerKinds.has(kind) ? { children: [] } : {}) };
    if (selected && containerKinds.has(selected.kind)) {
      setBlocks((items) => mapBlocks(items, selected.id, { children: [...(selected.children ?? []), nextBlock] }));
    } else {
      setBlocks((items) => [...items, nextBlock]);
    }
    setSelectedId(id);
    setShowAdd(false);
    setSaved(false);
  };

  const dropOn = (targetId: string) => {
    if (!draggedId || draggedId === targetId) return;
    checkpoint();
    setBlocks((items) => {
      const dragged = findBlock(items, draggedId);
      const target = findBlock(items, targetId);
      if (!dragged || !target) return items;
      if (flattenBlocks(dragged.children ?? []).some((item) => item.id === targetId)) return items;
      if (containerKinds.has(target.kind)) {
        const without = removeBlock(items, draggedId);
        return mapBlocks(without, targetId, { children: [...(target.children ?? []), dragged] });
      }
      return insertBeforeBlock(removeBlock(items, draggedId), targetId, dragged);
    });
    setDraggedId(null);
    setSaved(false);
  };

  const saveProject = async () => {
    try {
      const response = await fetch(`${apiBase}/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deck: deckPayload(), message: saveMessage || deckTitle, expectedRevision: serverRevision, idempotencyKey: createMessageId() }),
      });
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

  const exportDeck = () => {
    if (!quality.ok) {
      setShowQuality(true);
      setApiError("Resolve quality errors before exporting.");
      return;
    }
    const html = renderDeckDocument(deckPayload(), deckCss);
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
    const bundle = JSON.stringify({ format: "weave-deck", version: 1, deck: deckPayload(), css: deckCss }, null, 2);
    const url = URL.createObjectURL(new Blob([bundle], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${deckTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "deck"}.weave.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importBundle = async (file: File) => {
    try {
      if (file.size > 2_000_000) throw new Error("Deck bundle must be 2 MB or smaller.");
      const bundle = JSON.parse(await file.text());
      if (bundle.format !== "weave-deck" || bundle.version !== 1 || !bundle.deck || typeof bundle.css !== "string") throw new Error("Unsupported Weave bundle.");
      const deckCheck = auditDeckQuality(bundle.deck);
      const cssCheck = auditCssSafety(bundle.css);
      if (!deckCheck.ok || !cssCheck.ok) throw new Error(`Bundle failed validation (${deckCheck.summary.errors + cssCheck.summary.errors} errors).`);
      if (!window.confirm(`Replace the editor buffer with “${bundle.deck.title}”? You can Undo this import.`)) return;
      checkpoint();
      setDeckTitle(String(bundle.deck.title));
      setActiveSlide(bundle.deck.activeSlide);
      setBackground(bundle.deck.background);
      setAccent(bundle.deck.accent);
      setBlocks(clone(bundle.deck.blocks));
      setDeckSlides(clone(bundle.deck.slides));
      setDeckCss(bundle.css);
      setSelectedId(flattenBlocks(bundle.deck.blocks)[0]?.id ?? "");
      setSaved(false);
      setAnnouncement("Portable deck imported; save to commit it");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  };

  const openPresenter = () => {
    setPresentSlide(activeSlide);
    setShowPresenter(true);
  };

  const printDeck = () => {
    if (!quality.ok) { setShowQuality(true); return; }
    const popup = window.open("", "_blank", "noopener,noreferrer");
    if (!popup) { setApiError("Allow pop-ups to print this deck."); return; }
    popup.document.write(renderDeckDocument(deckPayload(), deckCss));
    popup.document.close();
    popup.addEventListener("load", () => popup.print(), { once: true });
  };

  const restoreHistory = async (commit?: string) => {
    try {
      const endpoint = commit ? "history/checkout" : "history/main";
      const response = await fetch(`${apiBase}/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(commit ? { commit } : {}),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not restore history.");
      applyServerState(result as ServerState);
      setSelectedId("heading");
      setShowHistory(false);
      setApiError(null);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
  };

  const checkoutVariation = async (branch: string) => {
    try {
      const response = await fetch(`${apiBase}/variations/checkout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ branch }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not switch direction.");
      applyServerState(result as ServerState);
      setSelectedId("heading");
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
      const response = await fetch(`${apiBase}/variations/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt,
          deck: deckPayload(),
          clientUserMessageId: createMessageId(),
          model: selectedModel || undefined,
          effort: reasoningEffort,
          approvalPolicy,
          contextEnvelope: contextEnvelope(),
        }),
      });
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
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
  };

  const archiveVariation = async () => {
    try {
      const response = await fetch(`${apiBase}/variations/archive`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not archive this direction.");
      applyServerState(result as ServerState);
      setApiError(null);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
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
        const startResponse = await fetch(`${apiBase}/codex/thread/start`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ approvalPolicy, model: selectedModel || undefined }),
        });
        const started = await startResponse.json();
        if (!startResponse.ok) throw new Error(started.error ?? "Could not start a Thread.");
        threadId = started.thread.id;
        dispatchCodex({ type: "threadLoaded", thread: started.thread, activate: true });
      }
      const endpoint = agentRunning ? "codex/turn/steer" : "codex/turn/start";
      const response = await fetch(`${apiBase}/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId,
          prompt: value,
          clientUserMessageId: createMessageId(),
          selectedId,
          deck: deckPayload(),
          model: selectedModel || undefined,
          effort: reasoningEffort,
          approvalPolicy,
          contextEnvelope: contextEnvelope(),
        }),
      });
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
      const response = await fetch(`${apiBase}/codex/turn/interrupt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: codexState.activeThreadId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not stop the active turn.");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
  };

  const newThread = async () => {
    try {
      const response = await fetch(`${apiBase}/codex/thread/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalPolicy, model: selectedModel || undefined }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not start a Thread.");
      dispatchCodex({ type: "threadLoaded", thread: result.thread, activate: true });
      setApiError(null);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
  };

  const openThread = async (threadId: string) => {
    try {
      const response = await fetch(`${apiBase}/codex/thread/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not resume the Thread.");
      dispatchCodex({ type: "threadLoaded", thread: result.thread, activate: true });
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
  };

  const threadAction = async (action: string, params: Record<string, unknown> = {}) => {
    const threadId = codexState.activeThreadId;
    if (!threadId) return;
    try {
      const response = await fetch(`${apiBase}/codex/thread/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, params: { threadId, ...params } }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Thread action failed.");
      if (action === "delete") dispatchCodex({ type: "activateThread", threadId: null });
      else await openThread(threadId);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
  };

  const forkThread = async () => {
    if (!codexState.activeThreadId) return;
    try {
      const response = await fetch(`${apiBase}/codex/thread/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: codexState.activeThreadId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not fork the Thread.");
      dispatchCodex({ type: "threadLoaded", thread: result.thread, activate: true });
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
  };

  const manageGoal = async () => {
    const threadId = codexState.activeThreadId;
    if (!threadId) return;
    try {
      const response = await fetch(`${apiBase}/codex/thread/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "goalGet", params: { threadId } }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not read the Thread goal.");
      const current = result.goal?.objective ?? result.objective ?? "";
      const objective = window.prompt("Thread goal (leave empty to clear)", current);
      if (objective === null) return;
      await threadAction(objective.trim() ? "goalSet" : "goalClear", objective.trim() ? { objective } : {});
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
  };

  const resolveServerRequest = async (id: string | number, result: Record<string, unknown>) => {
    try {
      const response = await fetch(`${apiBase}/codex/request/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, result }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "Could not answer app-server.");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
  };

  const rejectServerRequest = async (id: string | number) => {
    try {
      const response = await fetch(`${apiBase}/codex/request/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, message: "Declined in Weave." }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "Could not decline app-server.");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
  };

  const updateSkill = async (skill: any, enabled: boolean) => {
    try {
      const response = await fetch(`${apiBase}/codex/skill/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: skill.path ?? null, name: skill.name ?? null, enabled }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not update Skill.");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
  };

  const login = async (type: "chatgpt" | "apiKey") => {
    try {
      const response = await fetch(`${apiBase}/codex/account/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(type === "apiKey" ? { type, apiKey: apiKeyDraft } : { type }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Login could not start.");
      setApiKeyDraft("");
      const loginUrl = result.authUrl ?? result.loginUrl ?? result.url;
      if (loginUrl && window.confirm("Open the secure Codex login page in your browser?")) window.open(loginUrl, "_blank", "noopener,noreferrer");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
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
      const response = await fetch(`${apiBase}/codex/mcp/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "MCP request failed.");
      setMcpResult(JSON.stringify(result, null, 2).slice(0, 20_000));
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
  };

  const renderCanvasBlock = (block: Block): React.ReactNode => {
    const chrome = `slide-block ${selectedId === block.id ? "selected" : ""} ${editingId === block.id ? "editing" : ""}`;
    const shared = {
      "data-weave-id": block.id,
      "data-weave-label": block.label,
      draggable: editingId !== block.id,
      onDragStart: () => setDraggedId(block.id),
      onDragOver: (event: DragEvent) => event.preventDefault(),
      onDrop: () => dropOn(block.id),
      onClick: (event: ReactMouseEvent<HTMLElement>) => {
        event.stopPropagation();
        selectBlock(block.id);
        focusEditableAt(event.currentTarget, event.clientX, event.clientY);
      },
    };
    const tokens = styleClass(block);
    if (containerKinds.has(block.kind)) {
      return (
        <div key={block.id} {...shared} className={`weave-container ${block.kind} ${tokens} ${chrome}`} role="group" aria-label={block.label}>
          {(block.children ?? []).map(renderCanvasBlock)}
          {(block.children ?? []).length === 0 && <span className="empty-container">Drop or add a block here</span>}
        </div>
      );
    }
    if (block.kind === "metrics") {
      return (
        <div key={block.id} {...shared} className={`metrics ${tokens} ${chrome}`}>
          {metricParts(block.text).map((part: string, index: number) => (
            <EditableText
              key={index}
              as={index % 2 === 0 ? "strong" : "span"}
              value={part}
              multiline={false}
              label={index % 2 === 0 ? `${block.label} value` : `${block.label} caption`}
              onChange={(next) => editMetricPart(block, index, next)}
              onEditingChange={(editing) => setEditingId(editing ? block.id : null)}
            />
          ))}
        </div>
      );
    }
    return (
      <EditableText
        key={block.id}
        {...shared}
        as={blockTag(block.kind)}
        className={`${block.kind} ${tokens} ${chrome}`}
        value={block.text}
        multiline={block.kind === "heading" || block.kind === "paragraph"}
        label={block.label}
        onChange={(next) => editBlockText(block.id, next)}
        onEditingChange={(editing) => setEditingId(editing ? block.id : null)}
      />
    );
  };

  const slideNavigator = (
    <>
      {deckSlides.map((slide, index) => ({ slide, index })).filter(({ index }) =>
        deckSlides.length <= 60 || index === 0 || index === deckSlides.length - 1 || Math.abs(index - (activeSlide - 1)) <= 20,
      ).map(({ slide, index }, visibleIndex, visibleEntries) => {
        const slideNumber = index + 1;
        return (
          <div className="slide-entry" key={slide.id}>
          {visibleIndex > 0 && index - visibleEntries[visibleIndex - 1].index > 1 && <button className="slide-gap" onClick={() => void switchSlide(Math.max(1, slideNumber - 20))}>…</button>}
          <button
            className={`slide-item ${activeSlide === slideNumber ? "active" : ""}`}
            onClick={() => void switchSlide(slideNumber)}
            disabled={agentRunning}
            title={slide.title}
            draggable={!agentRunning}
            onDragStart={() => setDraggedSlide(index)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (draggedSlide == null || draggedSlide === index) return;
              checkpoint();
              const next = deckSlides.map((item, itemIndex) => itemIndex === activeSlide - 1 ? { ...item, blocks, background } : item);
              const [moved] = next.splice(draggedSlide, 1);
              next.splice(index, 0, moved);
              setDeckSlides(next);
              setActiveSlide(index + 1);
              setDraggedSlide(null);
              setSaved(false);
            }}
          >
            <span className="slide-number">{String(slideNumber).padStart(2, "0")}</span>
            <span className={`mini-slide mini-${(index % 4) + 1}`}>
              <i />
              <b />
              <em />
            </span>
            <span className="slide-name">{slide.title}</span>
          </button>
          </div>
        );
      })}
      <button className="new-slide" onClick={addSlide} disabled={agentRunning} aria-label="New slide" title="New slide">
        ＋
      </button>
    </>
  );

  return (
    <main
      className={`weave-app ${theme}`}
      style={{ "--accent": accent } as React.CSSProperties}
      data-background={background}
    >
      <header className="topbar">
        <div className="traffic-lights" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <button className="project-switcher" aria-label="Open project menu">
          <span className="project-mark">W</span>
          <span>
            <strong>Northstar narrative</strong>
            <small>weave / product-strategy</small>
          </span>
          <span className="chevron">⌄</span>
        </button>
        <div className="document-title">
          <input
            className={!saved ? "unsaved-dot" : ""}
            aria-label="Deck title"
            value={deckTitle}
            onChange={(event) => { setDeckTitle(event.target.value); setSaved(false); }}
          />
          <small>Slide {activeSlide} of {deckSlides.length}</small>
        </div>
        <div className="top-actions">
          <button className="icon-button" onClick={undo} disabled={historyState.undo === 0} aria-label="Undo">↶</button>
          <button className="icon-button" onClick={redo} disabled={historyState.redo === 0} aria-label="Redo">↷</button>
          <button className="icon-button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Toggle color mode">
            {theme === "dark" ? "☼" : "◐"}
          </button>
          <button className="share-button" onClick={openPresenter}>Present</button>
          <button className="share-button" onClick={exportDeck}>Export</button>
          <button className="share-button" onClick={printDeck}>PDF</button>
          <button className="share-button" onClick={downloadBundle}>Bundle</button>
          <button className="share-button" onClick={() => importRef.current?.click()}>Import</button>
          <input ref={importRef} className="sr-only" type="file" accept=".json,.weave.json,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importBundle(file); }} />
          <button className="save-button" onClick={() => void saveProject()} disabled={agentRunning}>
            <span>{saved ? "✓" : "↑"}</span> {saved ? "Saved" : "Save"}
          </button>
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

        {slideNav === "rail" && (
          <nav className="slide-nav slide-rail" aria-label="Slides">
            {slideNavigator}
          </nav>
        )}

        <aside className="left-panel">
          <section className="agent-panel">
            <div className="agent-heading">
              <span><i aria-hidden="true" className={`agent-status ${agentReady ? "" : "offline"}`} /> AGENT</span>
              <button
                className="thread-switcher"
                onClick={() => setShowThreads((value) => !value)}
                aria-expanded={showThreads}
                title="Switch conversation"
              >
                <span>{activeThreadName}</span>
                <em aria-hidden="true">⌄</em>
              </button>
              <button
                onClick={() => void newThread()}
                aria-label="New conversation"
                title="New conversation"
                disabled={agentRunning}
              >
                ＋
              </button>
            </div>
            {showThreads && (
              <>
                <div className="thread-popover-backdrop" role="presentation" onMouseDown={() => setShowThreads(false)} />
                <div className="thread-popover">
                  <div className="thread-controls">
                    <input
                      type="search"
                      value={threadSearch}
                      onChange={(event) => setThreadSearch(event.target.value)}
                      placeholder="Search Threads"
                      aria-label="Search Threads"
                    />
                    <button
                      className={showArchivedThreads ? "active" : ""}
                      onClick={() => setShowArchivedThreads((value) => !value)}
                    >
                      {showArchivedThreads ? "Active" : "Archive"}
                    </button>
                  </div>
                  <div className="thread-list" aria-label="Threads">
                    {codexState.threadOrder
                      .map((id) => codexState.threads[id])
                      .filter((thread) => thread && thread.archived === showArchivedThreads)
                      .slice(0, 12)
                      .map((thread) => (
                        <button
                          key={thread.id}
                          className={codexState.activeThreadId === thread.id ? "active" : ""}
                          onClick={() => {
                            setShowThreads(false);
                            void openThread(thread.id);
                          }}
                        >
                          <strong>{displayThreadName(thread.name) || thread.preview || "New conversation"}</strong>
                          <small>{thread.status}</small>
                        </button>
                      ))}
                  </div>
                  {codexState.activeThreadId && (
                    <div className="thread-actions">
                      <button onClick={() => {
                        const name = window.prompt("Thread name", displayThreadName(codexState.threads[codexState.activeThreadId!]?.name) ?? "");
                        if (name !== null) void threadAction("name", { name });
                      }}>Rename</button>
                      <button onClick={() => void forkThread()}>Fork</button>
                      <button onClick={() => void manageGoal()}>Goal</button>
                      <button onClick={() => void threadAction("compact")}>Compact</button>
                      <button onClick={() => void threadAction(showArchivedThreads ? "unarchive" : "archive")}>
                        {showArchivedThreads ? "Unarchive" : "Archive"}
                      </button>
                      <button onClick={() => {
                        if (window.confirm("Delete this Weave Thread permanently?")) void threadAction("delete");
                      }}>Delete</button>
                    </div>
                  )}
                </div>
              </>
            )}
            <div
              ref={messagesRef}
              className="messages"
              role="log"
              aria-live="polite"
              aria-relevant="additions text"
              aria-label="Conversation with Agent"
              onScroll={(event) => {
                const element = event.currentTarget;
                shouldAutoScrollRef.current =
                  element.scrollHeight - element.scrollTop - element.clientHeight < 48;
              }}
            >
              <div className="context-chip" role="status">
                <span aria-hidden="true">◎</span> Slide {activeSlide} in context · {agentActivity}
              </div>
              {!codexState.activeThreadId && <p className="empty-thread">Start or select a conversation.</p>}
              {activeTurns.length > visibleTurns.length && <p className="trimmed-log">Showing the latest {visibleTurns.length} turns.</p>}
              {visibleTurns.map((turn) => (
                <section className="turn-group" key={turn.id}>
                  {selectTurnItems(codexState, turn.id).map((item) => <ItemCard key={item.id} item={item} />)}
                  <footer>
                    <span>{turn.status}</span>
                    {turn.diff && <details><summary>Turn diff</summary><pre>{turn.diff}</pre></details>}
                  </footer>
                </section>
              ))}
              {Object.values(codexState.pendingRequests).map((pending) => (
                <ServerRequestCard
                  key={String(pending.id)}
                  request={pending}
                  onResolve={(id, result) => void resolveServerRequest(id, result)}
                  onReject={(id) => void rejectServerRequest(id)}
                />
              ))}
              <div ref={messagesEndRef} className="messages-end" />
            </div>
            <div className="chat-box">
              <textarea
                value={promptDraft}
                onChange={(event) => setPromptDraft(event.target.value)}
                onCompositionStart={() => {
                  compositionRef.current = true;
                }}
                onCompositionEnd={() => {
                  compositionRef.current = false;
                }}
                onKeyDown={(event) => {
                  const nativeEvent = event.nativeEvent as KeyboardEvent;
                  const isComposing =
                    compositionRef.current ||
                    nativeEvent.isComposing ||
                    nativeEvent.keyCode === 229;
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey) &&
                    !isComposing
                  ) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
                placeholder={agentReady ? "Ask Agent to edit this slide…" : "Waiting for local Codex…"}
                aria-label="Message Agent"
                maxLength={20000}
                disabled={!agentReady}
              />
              <div>
                <span>⌘ / Ctrl ↵</span>
                {agentRunning && (
                  <button
                    className="stop-button"
                    onClick={() => void interruptAgent()}
                    aria-label="Stop Agent"
                    title="Stop Agent"
                  >
                    ■
                  </button>
                )}
                <button
                  className="send-button"
                  onClick={() => void sendMessage()}
                  disabled={!agentReady || !promptDraft.trim() || turnSubmitting}
                  aria-label="Send message"
                >
                  ↑
                </button>
              </div>
            </div>
          </section>
        </aside>

        <section className="center-stage">
          <div className="editor-tabs">
            <div className="variation-tabs">
              <button className={activeVariation === "main" ? "active" : ""} onClick={() => void checkoutVariation("main")} disabled={agentRunning}>
                <span className="variation-dot dot-0" />
                Original
              </button>
              {variations.map((variation, index) => (
                <button
                  key={variation.branch}
                  className={activeVariation === variation.branch ? "active" : ""}
                  onClick={() => void checkoutVariation(variation.branch)}
                  disabled={agentRunning}
                >
                  <span className={`variation-dot dot-${index + 1}`} />
                  {variation.label}
                  <small>{variation.status === "ready" ? "Ready" : "Generating"}</small>
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
              <button className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")}>▣ <span>Preview</span></button>
              <button className={mode === "code" ? "active" : ""} onClick={() => setMode("code")}>‹› <span>Code</span></button>
              </div>
            </div>
          </div>

          <div className="canvas-area">
            {showVariationPrompt && (
              <div className="variation-prompt">
                <div><span>NEW DIRECTION</span><button onClick={() => setShowVariationPrompt(false)}>×</button></div>
                <label htmlFor="variation-prompt">How should this direction feel?</label>
                <textarea
                  id="variation-prompt"
                  value={variationPrompt}
                  maxLength={16000}
                  onChange={(event) => setVariationPrompt(event.target.value)}
                />
                <button onClick={() => void generateVariation()} disabled={!agentReady || agentRunning}>
                  <span>✦</span> Generate direction
                </button>
                <small>Generated sequentially from the latest saved version.</small>
              </div>
            )}
            {mode === "preview" ? (
              <div className="slide-shell">
                {/* The project stylesheet is the only thing styling the slide; the editor's
                    own chrome lives in globals.css and never overlaps these rules. */}
                <style>{deckCss}</style>
                <div className="slide-viewport" data-zoom-mode={manualZoom == null ? "fit" : "manual"} ref={viewportRef} style={{ "--slide-scale": slideScale } as React.CSSProperties}>
                  <main className={`weave-slide ${background}`} style={{ "--accent": accent } as React.CSSProperties}>
                    <div className="brand">WEAVE<span>●</span></div>
                    <section className="hero">
                      {blocks.map(renderCanvasBlock)}
                    </section>
                    <div className="page-number">{String(activeSlide).padStart(2, "0")} / {String(deckSlides.length).padStart(2, "0")}</div>
                  </main>
                </div>
                <div className="canvas-toolbar">
                  <button onClick={() => setShowAdd(!showAdd)} className={showAdd ? "active" : ""}>＋ Add block</button>
                  <button onClick={duplicateSlide} title="Duplicate slide">Duplicate</button>
                  <button onClick={saveSlideTemplate}>Save template</button>
                  <button onClick={() => setShowTemplates(true)}>Library</button>
                  <button onClick={() => moveSlide(-1)} disabled={activeSlide === 1} aria-label="Move slide left">←</button>
                  <button onClick={() => moveSlide(1)} disabled={activeSlide === deckSlides.length} aria-label="Move slide right">→</button>
                  <button onClick={deleteSlide} disabled={deckSlides.length <= 1}>Delete slide</button>
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
                    {(["heading", "paragraph", "metrics", "note", "row", "column", "grid"] as Block["kind"][]).map((kind) => (
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
                <div className="code-breadcrumb"><span>slides</span> / <span>{deckSlides[activeSlide - 1]?.id}.html</span></div>
                <pre>
                  {code.split("\n").map((line, index) => {
                    const lineBlock = blocks.find((block) => line.includes(`class="${block.kind}`));
                    return (
                      <div
                        key={index}
                        className={lineBlock?.id === selected.id ? "active-line" : lineBlock ? "selectable-line" : ""}
                        onClick={() => lineBlock && setSelectedId(lineBlock.id)}
                      >
                        <span className="line-number">{index + 1}</span>
                        <code>{line}</code>
                      </div>
                    );
                  })}
                </pre>
              </div>
            )}
          </div>

          {slideNav === "filmstrip" && (
            <nav className="slide-nav filmstrip" aria-label="Slides">
              {slideNavigator}
            </nav>
          )}
        </section>

        {inspectorOpen ? <aside className="inspector">
          <div className="inspector-heading">
            <span>INSPECTOR</span>
            <button aria-label="Close inspector" onClick={() => setInspectorOpen(false)}>×</button>
          </div>
          <div className="selection-path">
            <span>section.hero</span>
            <b>›</b>
            <strong>{selected.kind}.{selected.id}</strong>
          </div>
          <section className="layer-tree">
            <div className="property-heading"><span>OBJECT TREE</span><span>{blocks.length}</span></div>
            <div>
              <span className="tree-root">⌄ <b>section.hero</b></span>
              {blocksWithDepth(blocks).map(({ block, depth }) => (
                <button key={block.id} style={{ paddingLeft: 14 + depth * 14 }} className={selected.id === block.id ? "active" : ""} onClick={() => setSelectedId(block.id)}>
                  <i>{blockIcons[block.kind]}</i>
                  <span>{block.label}</span>
                  <small>{block.kind}</small>
                </button>
              ))}
            </div>
          </section>
          <section className="property-section">
            <div className="property-heading"><span>CONTENT</span><span>⌃</span></div>
            <label><span>Layer name</span><input value={selected.label} onChange={(event) => updateSelected({ label: event.target.value })} /></label>
            {!containerKinds.has(selected.kind) && <label>
              <span>Text</span>
              <textarea value={selected.text} onChange={(event) => updateSelected({ text: event.target.value })} />
            </label>}
          </section>
          <section className="property-section">
            <div className="property-heading"><span>TYPOGRAPHY</span><span>⌃</span></div>
            <div className="control-grid">
              <label><span>Size</span><select value={selected.style?.size ?? "md"} onChange={(event) => updateSelected({ style: { ...selected.style, size: event.target.value as "sm" | "md" | "lg" } })}><option value="sm">Small</option><option value="md">Medium</option><option value="lg">Large</option></select></label>
              <label><span>Weight</span><select value={selected.style?.weight ?? "regular"} onChange={(event) => updateSelected({ style: { ...selected.style, weight: event.target.value as "regular" | "medium" | "bold" } })}><option value="regular">Regular</option><option value="medium">Medium</option><option value="bold">Bold</option></select></label>
            </div>
            <div className="format-row">
              {(["left", "center", "right"] as const).map((align) => <button key={align} className={(selected.style?.align ?? "left") === align ? "active" : ""} onClick={() => updateSelected({ style: { ...selected.style, align } })}>{align === "left" ? "≡" : align === "center" ? "≣" : "☷"}</button>)}
            </div>
          </section>
          <section className="property-section">
            <div className="property-heading"><span>COLOR</span><span>⌃</span></div>
            <select value={selected.style?.color ?? "primary"} onChange={(event) => updateSelected({ style: { ...selected.style, color: event.target.value as "primary" | "muted" | "accent" } })}><option value="primary">Primary</option><option value="muted">Muted</option><option value="accent">Accent</option></select>
          </section>
          <section className="property-section">
            <div className="property-heading"><span>SPACING</span><span>⌃</span></div>
            <select value={selected.style?.spacing ?? "normal"} onChange={(event) => updateSelected({ style: { ...selected.style, spacing: event.target.value as "tight" | "normal" | "loose" } })}><option value="tight">Tight</option><option value="normal">Normal</option><option value="loose">Loose</option></select>
            {selected.kind === "grid" && <select value={selected.style?.columns ?? 2} onChange={(event) => updateSelected({ style: { ...selected.style, columns: Number(event.target.value) as 2 | 3 } })}><option value="2">2 columns</option><option value="3">3 columns</option></select>}
          </section>
          <section className="property-section">
            <div className="property-heading"><span>SLIDE</span><span>⌃</span></div>
            <label><span>Title</span><input value={deckSlides[activeSlide - 1]?.title ?? ""} onChange={(event) => renameSlide(event.target.value)} /></label>
            <label><span>Speaker notes</span><textarea value={deckSlides[activeSlide - 1]?.notes ?? ""} onChange={(event) => { checkpoint(); setDeckSlides((items) => items.map((slide, index) => index === activeSlide - 1 ? { ...slide, notes: event.target.value } : slide)); setSaved(false); }} /></label>
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
                {(["orbit", "grid", "plain"] as const).map((item) => (
                  <button key={item} onClick={() => { setBackground(item); setShowBackgrounds(false); setSaved(false); }}>
                    <span className={`background-preview ${item}`} />
                    {item[0].toUpperCase() + item.slice(1)}
                  </button>
                ))}
              </div>
            )}
          </section>
          <section className="accent-section">
            <span>ACCENT</span>
            <div>
              {["#f6b84b", "#4ed1c1", "#9c7cf4", "#ff7d6d", "#91b692"].map((color) => (
                <button
                  key={color}
                  style={{ background: color }}
                  className={accent === color ? "active" : ""}
                  onClick={() => { setAccent(color); setSaved(false); }}
                  aria-label={`Use accent ${color}`}
                />
              ))}
            </div>
          </section>
          <button className="delete-block" onClick={deleteSelected} disabled={blocks.length <= 1}>Delete selected block</button>
        </aside> : <button className="open-inspector" onClick={() => setInspectorOpen(true)}>Inspector</button>}
      </div>

      <footer className="statusbar">
        <div>
          <button className="history-button" onClick={() => setShowHistory(!showHistory)}>
            <span className="history-icon">↶</span><strong>History</strong>
          </button>
          <button className={`quality-button ${quality.ok ? "ok" : "error"}`} onClick={() => setShowQuality(!showQuality)}>
            Quality {quality.ok ? "✓" : `${quality.errors} errors`}{quality.warnings ? ` · ${quality.warnings} warnings` : ""}
          </button>
          <span>{project ? `${project.branch} · ${project.commit}` : "Connecting…"}</span>
          {apiError && <span className="status-error">{apiError}</span>}
        </div>
        <div><span>HTML</span><span>UTF-8</span><span>Spaces: 2</span><button className={`connection ${agentReady ? "" : "offline"}`} onClick={() => setConnectionEpoch((value) => value + 1)} title="Reconnect"><i /> {agentReady ? "Agent connected" : "Reconnect Agent"}</button></div>
      </footer>
      {showHistory && (
        <div className="history-popover">
          <div className="history-popover-heading">
            <span>HISTORY</span>
            <button onClick={() => setShowHistory(false)}>×</button>
          </div>
          <label className="save-message"><span>Next history label</span><input value={saveMessage} onChange={(event) => setSaveMessage(event.target.value)} placeholder={deckTitle} /></label>
          {project?.branch === "detached" && (
            <button className="return-latest" onClick={() => void restoreHistory()} disabled={agentRunning}>Return to latest on main</button>
          )}
          <div className="history-list">
            {history.map((entry, index) => (
              <button key={entry.id} onClick={() => void restoreHistory(entry.id)} disabled={!saved || agentRunning}>
                <i className={index === 0 ? "current" : ""} />
                <span>
                  <strong>{entry.message}</strong>
                  <small>{entry.shortId} · {new Date(entry.date).toLocaleString()}</small>
                </span>
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
            <button key={`${item.code}-${index}`} onClick={() => {
              if (Number.isInteger(item.slideIndex)) void switchSlide(item.slideIndex + 1);
              if (item.blockId) setSelectedId(item.blockId);
              setShowQuality(false);
            }}>
              <i className={item.severity} />
              <span><strong>{item.message}</strong><small>{item.code} · {item.path ?? item.source}</small></span>
            </button>
          ))}
        </aside>
      )}
      {showPresenter && (
        <div className="presenter" role="dialog" aria-modal="true" aria-label="Presentation mode" tabIndex={-1} onKeyDown={(event) => {
          if (["ArrowRight", "PageDown", " "].includes(event.key)) setPresentSlide((value) => Math.min(deckSlides.length, value + 1));
          if (["ArrowLeft", "PageUp"].includes(event.key)) setPresentSlide((value) => Math.max(1, value - 1));
          if (event.key === "Escape") setShowPresenter(false);
        }}>
          <style>{deckCss}</style>
          <div className="presenter-stage" style={{ "--slide-scale": Math.min((window.innerWidth - 80) / designWidth, (window.innerHeight - 120) / designHeight) } as React.CSSProperties}>
            <main className={`weave-slide ${effectiveSlides[presentSlide - 1].background}`} style={{ "--accent": accent } as React.CSSProperties}>
              <div className="brand">WEAVE<span>●</span></div>
              <section className="hero">{effectiveSlides[presentSlide - 1].blocks.map(renderCanvasBlock)}</section>
              <div className="page-number">{String(presentSlide).padStart(2, "0")} / {String(deckSlides.length).padStart(2, "0")}</div>
            </main>
          </div>
          <footer><button onClick={() => setPresentSlide((value) => Math.max(1, value - 1))}>← Previous</button><span>{presentSlide} / {deckSlides.length}</span><button onClick={() => setPresentSlide((value) => Math.min(deckSlides.length, value + 1))}>Next →</button><small>{effectiveSlides[presentSlide - 1].notes || "No speaker notes"}</small><button onClick={() => document.documentElement.requestFullscreen?.()}>Fullscreen</button><button onClick={() => setShowPresenter(false)}>Exit</button></footer>
        </div>
      )}
      {showHelp && (
        <div className="help-backdrop" role="presentation" onMouseDown={() => setShowHelp(false)}>
          <section className="shortcut-help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onMouseDown={(event) => event.stopPropagation()}>
            <header><strong>Keyboard shortcuts</strong><button onClick={() => setShowHelp(false)}>×</button></header>
            <dl><dt>← / →</dt><dd>Previous / next slide</dd><dt>Enter or F2</dt><dd>Edit selected text</dd><dt>Esc</dt><dd>Cancel editing or close presentation</dd><dt>⌘/Ctrl Z</dt><dd>Undo</dd><dt>⌘/Ctrl Shift Z</dt><dd>Redo</dd><dt>?</dt><dd>Open this help</dd></dl>
          </section>
        </div>
      )}
      {showTemplates && (
        <div className="help-backdrop" role="presentation" onMouseDown={() => setShowTemplates(false)}>
          <section className="shortcut-help template-library" role="dialog" aria-modal="true" aria-label="Slide library" onMouseDown={(event) => event.stopPropagation()}>
            <header><strong>Slide library</strong><button onClick={() => setShowTemplates(false)}>×</button></header>
            {slideTemplates.length === 0 ? <p>No saved templates yet. Save the current slide to reuse it.</p> : slideTemplates.map((template) => <button key={`${template.id}-${template.title}`} onClick={() => insertTemplate(template)}><span className={`background-preview ${template.background}`} /><span><strong>{template.title}</strong><small>{flattenBlocks(template.blocks).length} blocks</small></span></button>)}
          </section>
        </div>
      )}
      <div className="sr-only" aria-live="polite">{announcement}</div>
      {showCodexSettings && (
        <div className="codex-settings-backdrop" role="presentation" onMouseDown={() => setShowCodexSettings(false)}>
          <section className="codex-settings" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <strong>Settings</strong>
                <small>Codex CLI {codexState.connection.cliVersion ?? "unknown"} · {codexState.connection.status}</small>
              </div>
              <button onClick={() => setShowCodexSettings(false)}>×</button>
            </header>
            <section className="settings-first">
              <h3>Layout</h3>
              <label className="setting-row">
                <span>Slide navigator</span>
                <select value={slideNav} onChange={(event) => slideNavStore.write(event.target.value as SlideNav)}>
                  <option value="filmstrip">Filmstrip below the canvas</option>
                  <option value="rail">Rail beside the sidebar</option>
                </select>
              </label>
            </section>
            <div className="settings-grid">
              <label>
                <span>Model</span>
                <select value={selectedModel} onChange={(event) => {
                  const modelId = event.target.value;
                  setSelectedModel(modelId);
                  const model = codexState.catalog.models.find((item: any) => (item.id ?? item.model) === modelId) as any;
                  if (model?.defaultReasoningEffort) setReasoningEffort(model.defaultReasoningEffort);
                }}>
                  {codexState.catalog.models.map((model: any) => (
                    <option key={model.id ?? model.model} value={model.id ?? model.model}>
                      {model.displayName ?? model.name ?? model.id ?? model.model}
                      {model.inputModalities?.length ? ` · ${model.inputModalities.join("/")}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Reasoning effort</span>
                <select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value)}>
                  {availableEfforts.map((effort: string) => <option key={effort}>{effort}</option>)}
                </select>
              </label>
              <label>
                <span>Approvals</span>
                <select value={approvalPolicy} onChange={(event) => setApprovalPolicy(event.target.value)}>
                  <option value="never">Never (default)</option>
                  <option value="on-request">Ask when needed</option>
                  <option value="untrusted">Untrusted commands</option>
                </select>
              </label>
            </div>
            {codexState.catalog.modelProvider && (
              <section>
                <h3>Provider capabilities</h3>
                <pre className="settings-output">{JSON.stringify(codexState.catalog.modelProvider, null, 2)}</pre>
              </section>
            )}
            <section>
              <h3>Account</h3>
              {codexState.catalog.account ? (
                <div className="setting-row">
                  <span>{String(codexState.catalog.account.type ?? "Signed in")}</span>
                  <button onClick={() => {
                    void fetch(`${apiBase}/codex/account/logout`, { method: "POST" })
                      .then(async (response) => {
                        const result = await response.json();
                        if (!response.ok) throw new Error(result.error);
                      })
                      .catch((error) => setApiError(error.message));
                  }}>Log out</button>
                </div>
              ) : (
                <>
                  <button onClick={() => void login("chatgpt")}>Sign in with ChatGPT</button>
                  <div className="api-key-row">
                    <input
                      type="password"
                      value={apiKeyDraft}
                      onChange={(event) => setApiKeyDraft(event.target.value)}
                      placeholder="API key (not stored by Weave)"
                    />
                    <button disabled={!apiKeyDraft} onClick={() => void login("apiKey")}>Use key</button>
                  </div>
                </>
              )}
            </section>
            <section>
              <h3>Skills</h3>
              {codexState.catalog.skills.flatMap((entry: any) => entry.skills ?? [entry]).map((skill: any) => (
                <label className="setting-row" key={skill.path ?? skill.name}>
                  <span>{skill.name ?? skill.path}</span>
                  <input
                    type="checkbox"
                    checked={skill.enabled !== false}
                    onChange={(event) => void updateSkill(skill, event.target.checked)}
                  />
                </label>
              ))}
            </section>
            <section>
              <h3>Hooks</h3>
              {codexState.catalog.hooks.flatMap((entry: any) => entry.hooks ?? [entry]).map((hook: any, index) => (
                <div className="setting-row" key={hook.name ?? hook.event ?? index}>
                  <span>{hook.name ?? hook.event ?? "Configured hook"}</span>
                  <small>{hook.enabled === false ? "disabled" : "enabled"}</small>
                </div>
              ))}
            </section>
            <section>
              <h3>MCP servers</h3>
              {codexState.catalog.mcpServers.map((server: any) => (
                <div className="setting-row" key={server.name}>
                  <span>{server.name}</span>
                  <small>{server.status ?? server.authStatus ?? "configured"}</small>
                  {server.resources?.length > 0 && <button onClick={() => void invokeMcp(server, "resource")}>Resource</button>}
                  {Object.keys(server.tools ?? {}).length > 0 && (
                    <button disabled={!codexState.activeThreadId} onClick={() => void invokeMcp(server, "tool")}>Tool</button>
                  )}
                  <button onClick={() => {
                    void fetch(`${apiBase}/codex/mcp/oauth`, {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ name: server.name }),
                    }).then(async (response) => {
                      const result = await response.json();
                      if (!response.ok) throw new Error(result.error);
                      const url = result.authorizationUrl ?? result.url;
                      if (url && window.confirm(`Open OAuth for ${server.name}?`)) window.open(url, "_blank", "noopener,noreferrer");
                    }).catch((error) => setApiError(error.message));
                  }}>OAuth</button>
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
