"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- app-server catalog/request payloads are rendered defensively for forward compatibility. */

import { DragEvent, MouseEvent as ReactMouseEvent, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { actionFromStreamEvent } from "./codex/actions";
import { EditableText, focusEditableAt } from "./components/EditableText";
import { blockTag, defaultDeckCss, designWidth, metricParts, renderSlideDocument } from "../shared/slide-design.mjs";
import { ItemCard } from "./codex/components/ItemCard";
import { ServerRequestCard } from "./codex/components/ServerRequestCard";
import { codexReducer, initialCodexState } from "./codex/reducer";
import { selectThreadRunning, selectThreadTurns, selectTurnItems } from "./codex/selectors";

type Block = {
  id: string;
  kind: "eyebrow" | "heading" | "paragraph" | "metrics" | "note";
  label: string;
  text: string;
};

type SlideNav = "filmstrip" | "rail";

type DeckSlide = {
  id: string;
  title: string;
  background: "orbit" | "grid" | "plain";
  blocks: Block[];
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

const createMessageId = () =>
  `weave-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
};

export default function Home() {
  const [blocks, setBlocks] = useState(initialBlocks);
  const [selectedId, setSelectedId] = useState("heading");
  const [mode, setMode] = useState<"preview" | "code">("preview");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [accent, setAccent] = useState("#f6b84b");
  const [background, setBackground] = useState<"orbit" | "grid" | "plain">("orbit");
  const [activeSlide, setActiveSlide] = useState(1);
  const [deckSlides, setDeckSlides] = useState<DeckSlide[]>(initialSlides);
  const [deckCss, setDeckCss] = useState<string>(defaultDeckCss);
  const [slideScale, setSlideScale] = useState(0.68);
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [project, setProject] = useState<ServerState["project"] | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const compositionRef = useRef(false);
  const turnInFlightRef = useRef(false);
  const shouldAutoScrollRef = useRef(true);
  const eventSequenceRef = useRef(0);

  const selected = blocks.find((block) => block.id === selectedId) ?? blocks[0];
  /* The code view shows the file the next save writes, rendered by the same module. */
  const code = useMemo(
    () => renderSlideDocument(
      { title: "Q3 Strategy Deck", activeSlide, background, accent, blocks, slides: deckSlides },
      deckCss,
    ),
    [activeSlide, background, accent, blocks, deckSlides, deckCss],
  );
  const agentReady = codexState.connection.status === "connected";
  const agentRunning = selectThreadRunning(codexState, codexState.activeThreadId);
  const activeTurns = selectThreadTurns(codexState, codexState.activeThreadId);
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
    const slides = deckSlides.map((slide, index) =>
      index === activeSlide - 1 ? { ...slide, background, blocks } : slide,
    );
    return {
      title: "Q3 Strategy Deck",
      activeSlide,
      background,
      accent,
      blocks,
      slides,
    };
  };

  const applyServerState = useCallback((state: ServerState) => {
    setBlocks(state.deck.blocks);
    setDeckSlides(state.deck.slides ?? initialSlides);
    if (state.css) setDeckCss(state.css);
    setActiveSlide(state.deck.activeSlide);
    setBackground(state.deck.background);
    setAccent(state.deck.accent);
    setHistory(state.history);
    setVariations(state.variations ?? []);
    setProject(state.project);
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
        if (!state.codex.ready && attempts < 10) {
          attempts += 1;
          timer = setTimeout(() => void loadState(), 600);
        }
      } catch (error) {
        if (canceled) return;
        dispatchCodex({ type: "connection", connection: { status: "disconnected", error: "Local API offline" } });
        setApiError(error instanceof Error ? error.message : String(error));
        if (attempts < 10) {
          attempts += 1;
          timer = setTimeout(() => void loadState(), 600);
        }
      }
    };
    void loadState();
    return () => {
      canceled = true;
      if (timer) clearTimeout(timer);
    };
  }, [applyServerState]);

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
      if (!canceled) retryTimer = setTimeout(() => void connect(), 800);
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
      setSlideScale(entry.contentRect.width / designWidth);
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
    setBlocks((items) => items.map((item) => (item.id === selected.id ? { ...item, ...patch } : item)));
    setSaved(false);
  };

  const selectBlock = (id: string) => {
    setSelectedId(id);
    setMode("preview");
  };

  const editBlockText = (id: string, text: string) => {
    const target = blocks.find((block) => block.id === id);
    if (!target || target.text === text) return;
    setBlocks((items) => items.map((item) => (item.id === id ? { ...item, text } : item)));
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
    let slides = deckSlides;
    let clean = project?.clean ?? true;
    if (!saved) {
      try {
        const response = await fetch(`${apiBase}/state`);
        if (response.ok) {
          const state = (await response.json()) as ServerState;
          applyServerState(state);
          slides = state.deck.slides;
          clean = state.project.clean;
        }
      } catch {
        clean = false;
      }
    }
    const slide = slides[slideNumber - 1];
    if (!slide) return;
    setActiveSlide(slideNumber);
    setBlocks(slide.blocks);
    setBackground(slide.background);
    setSelectedId(slide.blocks[0]?.id ?? "");
    setDeckSlides(slides);
    setSaved(clean);
  };

  const addSlide = () => {
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

  const deleteSelected = () => {
    if (blocks.length <= 1) return;
    const remaining = blocks.filter((block) => block.id !== selected.id);
    setBlocks(remaining);
    setSelectedId(remaining[0].id);
    setSaved(false);
  };

  const addBlock = (kind: Block["kind"]) => {
    const id = `${kind}-${blocks.length + 1}`;
    const defaults: Record<Block["kind"], string> = {
      eyebrow: "NEW SECTION",
      heading: "A clear, compelling headline.",
      paragraph: "Add supporting detail that helps your audience understand the idea.",
      metrics: "24%|growth|8 wk|to launch",
      note: "SOURCE · INTERNAL RESEARCH",
    };
    setBlocks((items) => [...items, { id, kind, label: `New ${kind}`, text: defaults[kind] }]);
    setSelectedId(id);
    setShowAdd(false);
    setSaved(false);
  };

  const dropOn = (targetId: string) => {
    if (!draggedId || draggedId === targetId) return;
    setBlocks((items) => {
      const next = [...items];
      const from = next.findIndex((item) => item.id === draggedId);
      const to = next.findIndex((item) => item.id === targetId);
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setDraggedId(null);
    setSaved(false);
  };

  const saveProject = async () => {
    try {
      const response = await fetch(`${apiBase}/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deck: deckPayload(), message: "Q3 Strategy Deck" }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Save failed.");
      applyServerState(result as ServerState);
      setSaved(true);
      setApiError(null);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
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

  const slideNavigator = (
    <>
      {deckSlides.map((slide, index) => {
        const slideNumber = index + 1;
        return (
          <button
            key={slide.id}
            className={`slide-item ${activeSlide === slideNumber ? "active" : ""}`}
            onClick={() => void switchSlide(slideNumber)}
            disabled={agentRunning}
            title={slide.title}
          >
            <span className="slide-number">{String(slideNumber).padStart(2, "0")}</span>
            <span className={`mini-slide mini-${(index % 4) + 1}`}>
              <i />
              <b />
              <em />
            </span>
            <span className="slide-name">{slide.title}</span>
          </button>
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
          <span className={!saved ? "unsaved-dot" : ""}>Q3 Strategy Deck</span>
          <small>Slide {activeSlide} of {deckSlides.length}</small>
        </div>
        <div className="top-actions">
          <button className="icon-button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Toggle color mode">
            {theme === "dark" ? "☼" : "◐"}
          </button>
          <button className="share-button">Share</button>
          <button className="save-button" onClick={() => void saveProject()} disabled={agentRunning}>
            <span>{saved ? "✓" : "↑"}</span> {saved ? "Saved" : "Save"}
          </button>
        </div>
      </header>

      <div className="workspace" data-slide-nav={slideNav}>
        <nav className="activity-rail" aria-label="Primary navigation">
          <div className="activity-top">
            <button className="activity-button active" aria-label="Files">◇</button>
            <button className="activity-button" aria-label="Search">⌕</button>
            <button className="activity-button" aria-label="History">↶</button>
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
              {activeTurns.map((turn) => (
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
                <div className="slide-viewport" ref={viewportRef} style={{ "--slide-scale": slideScale } as React.CSSProperties}>
                  <main className={`weave-slide ${background}`} style={{ "--accent": accent } as React.CSSProperties}>
                    <div className="brand">WEAVE<span>●</span></div>
                    <section className="hero">
                      {blocks.map((block) => {
                        const chrome = `slide-block ${selectedId === block.id ? "selected" : ""} ${editingId === block.id ? "editing" : ""}`;
                        const shared = {
                          "data-weave-id": block.id,
                          "data-weave-label": block.label,
                          /* Dragging the block would hijack the mouse from the caret,
                             so the block only becomes draggable once editing stops. */
                          draggable: editingId !== block.id,
                          onDragStart: () => setDraggedId(block.id),
                          onDragOver: (event: DragEvent) => event.preventDefault(),
                          onDrop: () => dropOn(block.id),
                          onClick: (event: ReactMouseEvent<HTMLElement>) => {
                            event.stopPropagation();
                            selectBlock(block.id);
                            focusEditableAt(event.currentTarget, event.clientX, event.clientY);
                          },
                          onFocus: () => setEditingId(block.id),
                          onBlur: () => setEditingId((current) => (current === block.id ? null : current)),
                        };
                        return block.kind === "metrics" ? (
                          <div key={block.id} {...shared} className={`metrics ${chrome}`}>
                            {metricParts(block.text).map((part: string, index: number) => (
                              <EditableText
                                key={index}
                                as={index % 2 === 0 ? "strong" : "span"}
                                value={part}
                                multiline={false}
                                label={index % 2 === 0 ? `${block.label} value` : `${block.label} caption`}
                                onChange={(next) => editMetricPart(block, index, next)}
                              />
                            ))}
                          </div>
                        ) : (
                          <EditableText
                            key={block.id}
                            {...shared}
                            as={blockTag(block.kind)}
                            className={`${block.kind} ${chrome}`}
                            value={block.text}
                            multiline={block.kind === "heading" || block.kind === "paragraph"}
                            label={block.label}
                            onChange={(next) => editBlockText(block.id, next)}
                          />
                        );
                      })}
                    </section>
                    <div className="page-number">{String(activeSlide).padStart(2, "0")} / {String(deckSlides.length).padStart(2, "0")}</div>
                  </main>
                </div>
                <div className="canvas-toolbar">
                  <button onClick={() => setShowAdd(!showAdd)} className={showAdd ? "active" : ""}>＋ Add block</button>
                  <span />
                  <button aria-label="Zoom out">−</button>
                  <b>{Math.round(slideScale * 100)}%</b>
                  <button aria-label="Zoom in">＋</button>
                  <button aria-label="Fit to screen">⊡</button>
                </div>
                {showAdd && (
                  <div className="block-picker">
                    <small>INSERT BLOCK</small>
                    {(["heading", "paragraph", "metrics", "note"] as Block["kind"][]).map((kind) => (
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
                <div className="code-breadcrumb"><span>slides</span> / <span>opportunity.html</span></div>
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

        <aside className="inspector">
          <div className="inspector-heading">
            <span>INSPECTOR</span>
            <button aria-label="Close inspector">×</button>
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
              {blocks.map((block) => (
                <button key={block.id} className={selected.id === block.id ? "active" : ""} onClick={() => setSelectedId(block.id)}>
                  <i>{blockIcons[block.kind]}</i>
                  <span>{block.label}</span>
                  <small>{block.kind}</small>
                </button>
              ))}
            </div>
          </section>
          <section className="property-section">
            <div className="property-heading"><span>CONTENT</span><span>⌃</span></div>
            <label>
              <span>Text</span>
              <textarea value={selected.text} onChange={(event) => updateSelected({ text: event.target.value })} />
            </label>
          </section>
          <section className="property-section">
            <div className="property-heading"><span>TYPOGRAPHY</span><span>⌃</span></div>
            <div className="control-grid">
              <label><span>Style</span><button className="select-control">{selected.kind === "heading" ? "Display / 64" : "Body / 18"} <i>⌄</i></button></label>
              <label><span>Weight</span><button className="select-control">{selected.kind === "heading" ? "Semibold" : "Regular"} <i>⌄</i></button></label>
            </div>
            <div className="format-row">
              <button className="active"><b>B</b></button>
              <button><i>I</i></button>
              <button><u>U</u></button>
              <span />
              <button className="active">≡</button>
              <button>≣</button>
              <button>☷</button>
            </div>
          </section>
          <section className="property-section">
            <div className="property-heading"><span>COLOR</span><span>⌃</span></div>
            <div className="color-control">
              <span style={{ background: selected.kind === "eyebrow" ? accent : "#f1f2f4" }} />
              <code>{selected.kind === "eyebrow" ? accent.toUpperCase() : "#F1F2F4"}</code>
              <b>100%</b>
            </div>
          </section>
          <section className="property-section">
            <div className="property-heading"><span>SPACING</span><span>⌃</span></div>
            <div className="spacing-grid">
              <label><span>↥</span><input value="0" readOnly /><small>px</small></label>
              <label><span>↧</span><input value="24" readOnly /><small>px</small></label>
            </div>
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
        </aside>
      </div>

      <footer className="statusbar">
        <div>
          <button className="history-button" onClick={() => setShowHistory(!showHistory)}>
            <span className="history-icon">↶</span><strong>History</strong>
          </button>
          <span>{project ? `${project.branch} · ${project.commit}` : "Connecting…"}</span>
          {apiError && <span className="status-error">{apiError}</span>}
        </div>
        <div><span>HTML</span><span>UTF-8</span><span>Spaces: 2</span><span className={`connection ${agentReady ? "" : "offline"}`}><i /> {agentReady ? "Agent connected" : "Agent offline"}</span></div>
      </footer>
      {showHistory && (
        <div className="history-popover">
          <div className="history-popover-heading">
            <span>HISTORY</span>
            <button onClick={() => setShowHistory(false)}>×</button>
          </div>
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
