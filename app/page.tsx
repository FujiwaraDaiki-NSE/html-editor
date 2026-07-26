"use client";

import { DragEvent, useEffect, useMemo, useRef, useState } from "react";

type Block = {
  id: string;
  kind: "eyebrow" | "heading" | "paragraph" | "metrics" | "note";
  label: string;
  text: string;
};

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
  history: HistoryEntry[];
  chat: ChatMessage[];
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
  agent: {
    ready: boolean;
    account: { type: string; planType?: string } | null;
    error: string | null;
    active: boolean;
  };
};

type ChatMessage = {
  id: string;
  role: "agent" | "user";
  text: string;
  reasoning?: string[];
  activity?: string[];
  status?: string;
};

const apiBase = "http://127.0.0.1:4317/api";
const createMessageId = (role: ChatMessage["role"]) =>
  `${role}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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

const codeFor = (blocks: Block[]) =>
  `<main class="slide">
  <section class="hero">
${blocks
  .map((block) => {
    if (block.kind === "metrics") {
      return `    <div class="metrics">
      <strong>3.2×</strong><span>faster iteration</span>
      <strong>42%</strong><span>less rework</span>
    </div>`;
    }
    const tag = block.kind === "heading" ? "h1" : block.kind === "paragraph" ? "p" : "div";
    return `    <${tag} class="${block.kind}">${block.text.replace("\n", "<br />")}</${tag}>`;
  })
  .join("\n")}
  </section>
</main>`;

export default function Home() {
  const [blocks, setBlocks] = useState(initialBlocks);
  const [selectedId, setSelectedId] = useState("heading");
  const [mode, setMode] = useState<"preview" | "code">("preview");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [accent, setAccent] = useState("#f6b84b");
  const [background, setBackground] = useState<"orbit" | "grid" | "plain">("orbit");
  const [activeSlide, setActiveSlide] = useState(1);
  const [deckSlides, setDeckSlides] = useState<DeckSlide[]>(initialSlides);
  const [activeVariation, setActiveVariation] = useState("main");
  const [variations, setVariations] = useState<ServerState["variations"]>([]);
  const [showVariationPrompt, setShowVariationPrompt] = useState(false);
  const [variationPrompt, setVariationPrompt] = useState("Explore a bolder editorial hierarchy with a concise headline and stronger metric emphasis.");
  const [showBackgrounds, setShowBackgrounds] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [saved, setSaved] = useState(true);
  const [chat, setChat] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "initial-agent-message",
      role: "agent",
      text: "I’ve reviewed the current slide. What would you like to shape next?",
    },
  ]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [project, setProject] = useState<ServerState["project"] | null>(null);
  const [agentReady, setAgentReady] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentActivity, setAgentActivity] = useState("Connecting to Codex…");
  const [apiError, setApiError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const compositionRef = useRef(false);
  const turnInFlightRef = useRef(false);
  const shouldAutoScrollRef = useRef(true);

  const selected = blocks.find((block) => block.id === selectedId) ?? blocks[0];
  const code = useMemo(() => codeFor(blocks), [blocks]);

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

  const applyServerState = (state: ServerState) => {
    setBlocks(state.deck.blocks);
    setDeckSlides(state.deck.slides ?? initialSlides);
    setActiveSlide(state.deck.activeSlide);
    setBackground(state.deck.background);
    setAccent(state.deck.accent);
    setHistory(state.history);
    setMessages((current) =>
      (state.chat ?? []).map((message, index) => {
        const normalized = {
          ...message,
          id: message.id || `${message.role}-server-${index}`,
        };
        const existing =
          current.find((item) => item.id === normalized.id) ??
          [...current].reverse().find(
            (item) => item.role === normalized.role && item.text === normalized.text,
          );
        return existing
          ? {
              ...normalized,
              reasoning: existing.reasoning,
              activity: existing.activity,
              status: existing.status,
            }
          : normalized;
      }),
    );
    setVariations(state.variations ?? []);
    setProject(state.project);
    setActiveVariation(state.project.branch);
    setAgentReady(state.agent.ready);
    setAgentRunning(state.agent.active);
    setAgentActivity(
      state.agent.ready
        ? state.agent.account?.type === "chatgpt"
          ? "Connected with ChatGPT"
          : "Connected with API key"
        : state.agent.error ?? "Codex is unavailable",
    );
    setApiError(state.agent.ready ? null : state.agent.error);
    setSaved(state.project.clean);
  };

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
        if ((!state.agent.ready || state.agent.active) && attempts < 10) {
          attempts += 1;
          timer = setTimeout(() => void loadState(), 600);
        }
      } catch (error) {
        if (canceled) return;
        setAgentReady(false);
        setAgentActivity("Local API offline");
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
  }, []);

  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      messagesEndRef.current?.scrollIntoView({
        behavior: agentRunning ? "smooth" : "auto",
        block: "end",
      });
    }
  }, [messages, agentRunning]);

  const updateSelected = (patch: Partial<Block>) => {
    setBlocks((items) => items.map((item) => (item.id === selected.id ? { ...item, ...patch } : item)));
    setSaved(false);
  };

  const selectBlock = (id: string) => {
    setSelectedId(id);
    setMode("preview");
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
    setAgentRunning(true);
    setAgentActivity("Creating a new direction…");
    setShowVariationPrompt(false);
    setApiError(null);
    try {
      const response = await fetch(`${apiBase}/variations/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, deck: deckPayload() }),
      });
      if (!response.ok || !response.body) {
        const result = await response.json();
        throw new Error(result.error ?? "Could not generate direction.");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (true) {
        const { value: chunk, done } = await reader.read();
        pending += decoder.decode(chunk ?? new Uint8Array(), { stream: !done });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "variation") {
            setActiveVariation(event.branch);
            setAgentActivity(`${event.label} is generating…`);
          } else if (event.type === "activity") {
            setAgentActivity(event.text);
          } else if (event.type === "done") {
            applyServerState(event.state as ServerState);
            setAgentActivity("Direction ready");
          } else if (event.type === "canceled") {
            applyServerState(event.state as ServerState);
            setAgentActivity("Incomplete direction discarded");
          } else if (event.type === "error") {
            throw new Error(event.error);
          }
        }
        if (done) break;
      }
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
      setAgentActivity("Direction generation failed");
    } finally {
      turnInFlightRef.current = false;
      setAgentRunning(false);
    }
  };

  const acceptVariation = async () => {
    try {
      const response = await fetch(`${apiBase}/variations/accept`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not use this direction.");
      applyServerState(result as ServerState);
      setAgentActivity("Direction added to history");
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
      setAgentActivity("Direction moved to history");
      setApiError(null);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
  };

  const sendMessage = async () => {
    const value = chat.trim();
    if (!value || turnInFlightRef.current) return;
    turnInFlightRef.current = true;
    const userMessageId = createMessageId("user");
    const replyMessageId = createMessageId("agent");
    shouldAutoScrollRef.current = true;
    setMessages((items) => [
      ...items,
      { id: userMessageId, role: "user", text: value },
      {
        id: replyMessageId,
        role: "agent",
        text: "",
        activity: ["Starting turn…"],
        status: "starting",
      },
    ]);
    setChat("");
    setAgentRunning(true);
    setAgentActivity("Starting turn…");
    setApiError(null);

    const reasoningDetails: string[] = [];
    const activityDetails = ["Starting turn…"];
    let restoreDraftOnError = false;
    const updateReply = (patch: Partial<ChatMessage>) => {
      setMessages((items) =>
        items.map((item) => (item.id === replyMessageId ? { ...item, ...patch } : item)),
      );
    };
    const appendReplyDetail = (field: "reasoning" | "activity", text: string) => {
      if (!text) return;
      if (field === "reasoning") reasoningDetails.push(text);
      else activityDetails.push(text);
      setMessages((items) =>
        items.map((item) =>
          item.id === replyMessageId
            ? { ...item, [field]: [...(item[field] ?? []), text] }
            : item,
        ),
      );
    };
    const appendReplyReasoning = (text: string, summaryIndex?: number) => {
      if (!text) return;
      const detailIndex =
        typeof summaryIndex === "number" && summaryIndex >= 0
          ? summaryIndex
          : Math.max(reasoningDetails.length - 1, 0);
      reasoningDetails[detailIndex] = `${reasoningDetails[detailIndex] ?? ""}${text}`;
      setMessages((items) =>
        items.map((item) => {
          if (item.id !== replyMessageId) return item;
          const reasoning = [...(item.reasoning ?? [])];
          reasoning[detailIndex] = `${reasoning[detailIndex] ?? ""}${text}`;
          return { ...item, reasoning };
        }),
      );
    };

    try {
      const response = await fetch(`${apiBase}/agent/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: value, selectedId, deck: deckPayload() }),
      });
      if (!response.ok || !response.body) {
        const result = await response.json().catch(() => null);
        restoreDraftOnError = true;
        throw new Error(result?.error ?? "Agent turn failed.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let streamed = "";
      while (true) {
        const { value: chunk, done } = await reader.read();
        pending += decoder.decode(chunk ?? new Uint8Array(), { stream: !done });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "delta") {
            streamed += event.text;
            updateReply({ text: streamed });
          } else if (event.type === "reasoning") {
            const detail = event.text ?? event.summary ?? event.delta ?? "";
            if (event.event === "summaryTextDelta") {
              appendReplyReasoning(detail, event.summaryIndex);
            } else {
              appendReplyDetail("reasoning", detail);
            }
            setAgentActivity("Reviewing the request…");
          } else if (event.type === "activity") {
            setAgentActivity(event.text);
            appendReplyDetail("activity", event.text);
          } else if (event.type === "status") {
            const status =
              event.status === "running"
                ? "Editing with Codex…"
                : event.status === "retrying"
                  ? "Retrying with Codex…"
                  : event.status === "stopping"
                    ? "Stopping Agent…"
                    : "Preparing context…";
            setAgentActivity(status);
            updateReply({ status });
          } else if (event.type === "done") {
            updateReply({
              text: streamed || event.text || "The Agent completed without a text response.",
              status: "completed",
            });
            if (event.state) applyServerState(event.state as ServerState);
            setAgentActivity("Turn completed");
          } else if (event.type === "canceled") {
            if (event.state) applyServerState(event.state as ServerState);
            setMessages((items) => {
              const canceledReply = {
                id: replyMessageId,
                role: "agent" as const,
                text: streamed || "Turn stopped.",
                reasoning: reasoningDetails,
                activity: activityDetails,
                status: "interrupted",
              };
              return items.some((item) => item.id === replyMessageId)
                ? items.map((item) =>
                    item.id === replyMessageId ? { ...item, ...canceledReply } : item,
                  )
                : [...items, canceledReply];
            });
            setAgentActivity("Turn stopped");
          } else if (event.type === "error") {
            throw new Error(event.error);
          }
        }
        if (done) break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (restoreDraftOnError) setChat((current) => current || value);
      setApiError(message);
      updateReply({
        text: `Couldn’t complete the turn: ${message}`,
        status: "failed",
      });
      setAgentActivity("Agent turn failed");
    } finally {
      turnInFlightRef.current = false;
      setAgentRunning(false);
    }
  };

  const interruptAgent = async () => {
    try {
      const response = await fetch(`${apiBase}/agent/interrupt`, { method: "POST" });
      if (!response.ok) throw new Error("Could not stop the active turn.");
      setAgentActivity("Stopping Agent…");
      if (!turnInFlightRef.current) {
        for (let attempt = 0; attempt < 6; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          const stateResponse = await fetch(`${apiBase}/state`);
          if (!stateResponse.ok) continue;
          const state = (await stateResponse.json()) as ServerState;
          applyServerState(state);
          if (!state.agent.active) break;
        }
      }
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
  };

  const clearChat = async () => {
    if (turnInFlightRef.current) return;
    try {
      const response = await fetch(`${apiBase}/chat/clear`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not start a new conversation.");
      applyServerState(result as ServerState);
      setApiError(null);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
  };

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

      <div className="workspace">
        <nav className="activity-rail" aria-label="Primary navigation">
          <div className="activity-top">
            <button className="activity-button active" aria-label="Files">◇</button>
            <button className="activity-button" aria-label="Search">⌕</button>
            <button className="activity-button" aria-label="History">↶</button>
            <button className="activity-button" aria-label="Skills">✣</button>
          </div>
          <div className="activity-bottom">
            <div className="avatar">FK</div>
            <button className="activity-button" aria-label="Settings">⚙</button>
          </div>
        </nav>

        <aside className="left-panel">
          <section className="outline-panel">
            <div className="panel-heading">
              <span>OUTLINE</span>
              <button aria-label="More outline options">•••</button>
            </div>
            <div className="deck-label"><span>⌄</span> Q3 STRATEGY DECK</div>
            <div className="slides-list">
              {deckSlides.map((slide, index) => {
                const slideNumber = index + 1;
                return (
                <button
                  key={slide.id}
                  className={`slide-row ${activeSlide === slideNumber ? "active" : ""}`}
                  onClick={() => void switchSlide(slideNumber)}
                  disabled={agentRunning}
                >
                  <span className="slide-number">{String(slideNumber).padStart(2, "0")}</span>
                  <span className={`mini-slide mini-${(index % 4) + 1}`}>
                    <i />
                    <b />
                    <em />
                  </span>
                  <span className="slide-name">
                    <strong>{slide.title}</strong>
                    <small>{slideNumber === 1 ? "Title slide" : slide.background === "grid" ? "Grid background" : "Content slide"}</small>
                  </span>
                </button>
                );
              })}
            </div>
            <button className="new-slide" onClick={addSlide} disabled={agentRunning}><span>＋</span> New slide</button>
          </section>

          <section className="agent-panel">
            <div className="agent-heading">
              <span><i aria-hidden="true" className={`agent-status ${agentReady ? "" : "offline"}`} /> AGENT</span>
              <button
                onClick={() => void clearChat()}
                aria-label="New conversation"
                title="New conversation"
                disabled={agentRunning}
              >
                ＋
              </button>
            </div>
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
              {messages.map((message) => (
                <div key={message.id} className={`message ${message.role}`}>
                  {message.role === "agent" && <span aria-hidden="true" className="agent-glyph">✦</span>}
                  <div className="message-content">
                    {(message.reasoning?.length || message.activity?.length || message.status) && (
                      <details className="work-details">
                        <summary>
                          作業内容
                          {message.status && <span>{message.status}</span>}
                        </summary>
                        {message.reasoning?.map((detail, index) => (
                          <p key={`reasoning-${index}`}>{detail}</p>
                        ))}
                        {message.activity?.map((detail, index) => (
                          <p key={`activity-${index}`}>{detail}</p>
                        ))}
                      </details>
                    )}
                    <p>{message.text || (agentRunning ? "Thinking…" : "No response.")}</p>
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} className="messages-end" />
            </div>
            <div className="chat-box">
              <textarea
                value={chat}
                onChange={(event) => setChat(event.target.value)}
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
                  disabled={!agentReady || agentRunning || !chat.trim()}
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
                <div className={`slide-canvas ${background}`}>
                  <div className="slide-brand">WEAVE<span>●</span></div>
                  {background !== "plain" && <div className="decor decor-one" />}
                  {background === "orbit" && <div className="decor decor-two" />}
                  <div className="slide-content">
                    {blocks.map((block) => (
                      <div
                        key={block.id}
                        draggable
                        onDragStart={() => setDraggedId(block.id)}
                        onDragOver={(event: DragEvent) => event.preventDefault()}
                        onDrop={() => dropOn(block.id)}
                        onClick={(event) => {
                          event.stopPropagation();
                          selectBlock(block.id);
                        }}
                        className={`slide-block block-${block.kind} ${selectedId === block.id ? "selected" : ""}`}
                      >
                        {selectedId === block.id && <span className="selection-label">{block.label}</span>}
                        {block.kind === "metrics" ? (
                          <div className="metric-grid">
                            {block.text.split("|").map((part, index) =>
                              index % 2 === 0 ? <strong key={index}>{part}</strong> : <span key={index}>{part}</span>,
                            )}
                          </div>
                        ) : (
                          <span>{block.text}</span>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="slide-index">{String(activeSlide).padStart(2, "0")} / {String(deckSlides.length).padStart(2, "0")}</div>
                </div>
                <div className="canvas-toolbar">
                  <button onClick={() => setShowAdd(!showAdd)} className={showAdd ? "active" : ""}>＋ Add block</button>
                  <span />
                  <button aria-label="Zoom out">−</button>
                  <b>72%</b>
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
    </main>
  );
}
