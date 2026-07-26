import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = join(repoRoot, "workspaces", "northstar");
const deckPath = join(projectRoot, ".weave", "deck.json");
const chatPath = join(projectRoot, ".weave", "chat.json");
const slidePath = join(projectRoot, "slides", "opportunity.html");
const apiPort = Number(process.env.WEAVE_API_PORT ?? 4317);

const defaultSlides = [
  {
    id: "opportunity",
    title: "The opportunity",
    background: "orbit",
    blocks: [
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
    ],
  },
  {
    id: "market-shift",
    title: "Market shift",
    background: "grid",
    blocks: [
      { id: "eyebrow-2", kind: "eyebrow", label: "Eyebrow", text: "THE SHIFT" },
      { id: "heading-2", kind: "heading", label: "Heading", text: "The interface is becoming\na collaborator." },
      { id: "paragraph-2", kind: "paragraph", label: "Body", text: "Teams no longer choose between visual tools and code. The strongest workflows bring both into one continuous loop." },
      { id: "metrics-2", kind: "metrics", label: "Metrics row", text: "68%|use AI weekly|2.4×|more variants" },
      { id: "note-2", kind: "note", label: "Footnote", text: "WORKFLOW RESEARCH · 2026" },
    ],
  },
  {
    id: "approach",
    title: "Our approach",
    background: "orbit",
    blocks: [
      { id: "eyebrow-3", kind: "eyebrow", label: "Eyebrow", text: "OUR APPROACH" },
      { id: "heading-3", kind: "heading", label: "Heading", text: "One canvas.\nTwo ways to create." },
      { id: "paragraph-3", kind: "paragraph", label: "Body", text: "People shape the story visually. Agents work directly in the same HTML project. Selection, code, and properties stay aligned." },
      { id: "metrics-3", kind: "metrics", label: "Metrics row", text: "1|shared history|0|handoff gaps" },
      { id: "note-3", kind: "note", label: "Footnote", text: "WEAVE PRODUCT PRINCIPLE" },
    ],
  },
  {
    id: "next-steps",
    title: "Next steps",
    background: "plain",
    blocks: [
      { id: "eyebrow-4", kind: "eyebrow", label: "Eyebrow", text: "FROM IDEA TO DECK" },
      { id: "heading-4", kind: "heading", label: "Heading", text: "Start with the story.\nRefine in the flow." },
      { id: "paragraph-4", kind: "paragraph", label: "Body", text: "Build the first narrative, generate focused directions, and commit the version your audience should remember." },
      { id: "metrics-4", kind: "metrics", label: "Metrics row", text: "4|slides to align|1|direction to ship" },
      { id: "note-4", kind: "note", label: "Footnote", text: "NEXT · PILOT WITH PRODUCT TEAMS" },
    ],
  },
];

const defaultDeck = {
  title: "Q3 Strategy Deck",
  activeSlide: 1,
  background: defaultSlides[0].background,
  accent: "#f6b84b",
  blocks: defaultSlides[0].blocks,
  slides: defaultSlides,
};

const defaultChat = [
  {
    id: "welcome",
    role: "agent",
    text: "I’ve reviewed the current slide. What would you like to shape next?",
    createdAt: new Date(0).toISOString(),
  },
];

const agentInstructions = `You are the editing agent embedded in Weave, a visual HTML slide editor.
The project uses .weave/deck.json as the canonical editor state and one HTML file per slide under slides/.
The top-level blocks and background mirror the active slide. Keep them synchronized with slides[activeSlide - 1].
Before editing, inspect .weave/deck.json and .weave/current-buffer.json when present.
The current buffer is authoritative even when it differs from the last commit.
Make focused changes that answer the user. Preserve valid JSON, all slides, and the existing block schema.
Use flow layout (flex or grid with gap); do not introduce free-positioned content blocks.
Do not run git commands or commit changes. Weave commits the completed turn atomically.
If no file change is needed, respond with a concise explanation.`;

function runGit(args, options = {}) {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderSlide(deck) {
  const blocks = deck.blocks
    .map((block) => {
      if (block.kind === "metrics") {
        const parts = block.text.split("|");
        return `      <div class="metrics" data-weave-id="${escapeHtml(block.id)}">
        <strong>${escapeHtml(parts[0] ?? "")}</strong><span>${escapeHtml(parts[1] ?? "")}</span>
        <strong>${escapeHtml(parts[2] ?? "")}</strong><span>${escapeHtml(parts[3] ?? "")}</span>
      </div>`;
      }
      const tag = block.kind === "heading" ? "h1" : block.kind === "paragraph" ? "p" : "div";
      return `      <${tag} class="${escapeHtml(block.kind)}" data-weave-id="${escapeHtml(block.id)}">${escapeHtml(block.text).replaceAll("\n", "<br>")}</${tag}>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(deck.title)}</title>
  <style>
    :root { --accent: ${escapeHtml(deck.accent)}; --bg: #171a20; --text: #f3f4f6; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0c0e11; color: var(--text); font-family: Inter, Arial, sans-serif; }
    .slide { position: relative; width: min(90vw, 1280px); aspect-ratio: 16/9; overflow: hidden; background: var(--bg); }
    .slide::after { content: ""; position: absolute; width: 38%; aspect-ratio: 1; right: -17%; bottom: -31%; border: 34px solid var(--accent); border-radius: 50%; opacity: .65; }
    .hero { position: absolute; left: 11%; top: 22%; width: 68%; display: flex; flex-direction: column; gap: 18px; }
    .eyebrow { color: var(--accent); font-size: 14px; font-weight: 700; letter-spacing: .16em; }
    h1 { margin: 0; font-size: clamp(42px, 6vw, 82px); line-height: .96; letter-spacing: -.055em; }
    p { max-width: 58%; margin: 0; color: #aeb4bd; font-size: 18px; line-height: 1.5; }
    .metrics { display: grid; grid-template-columns: auto auto auto auto; align-items: baseline; gap: 16px; margin-top: 10px; }
    .metrics strong { color: var(--accent); font-size: 34px; }
    .metrics span { max-width: 70px; color: #969da6; font-size: 12px; }
    .note { margin-top: 22px; color: #676e77; font: 600 10px/1 monospace; letter-spacing: .14em; }
  </style>
</head>
<body>
  <main class="slide ${escapeHtml(deck.background)}">
    <section class="hero">
${blocks}
    </section>
  </main>
</body>
</html>
`;
}

function validateDeck(input) {
  if (!input || typeof input !== "object") throw new Error("Deck payload is required.");
  const allowedKinds = new Set(["eyebrow", "heading", "paragraph", "metrics", "note"]);
  const cleanBlockList = (blocks, slideIndex) => {
    if (!Array.isArray(blocks) || blocks.length === 0 || blocks.length > 100) {
      throw new Error(`Slide ${slideIndex + 1} must contain 1–100 blocks.`);
    }
    return blocks.map((block, blockIndex) => {
      if (!block || typeof block !== "object") throw new Error(`Block ${blockIndex + 1} is invalid.`);
      if (!allowedKinds.has(block.kind)) throw new Error(`Block ${blockIndex + 1} has an unsupported kind.`);
      const id = String(block.id ?? "").slice(0, 80);
      const text = String(block.text ?? "").slice(0, 12000);
      if (!id) throw new Error(`Block ${blockIndex + 1} needs an id.`);
      return { id, kind: block.kind, label: String(block.label ?? block.kind).slice(0, 80), text };
    });
  };
  const sourceSlides = Array.isArray(input.slides) && input.slides.length > 0
    ? input.slides.slice(0, 100)
    : defaultSlides.map((slide, index) => ({
        ...slide,
        blocks: index === 0 && Array.isArray(input.blocks) ? input.blocks : slide.blocks,
        background: index === 0 && input.background ? input.background : slide.background,
      }));
  const slides = sourceSlides.map((slide, index) => ({
    id: String(slide?.id ?? `slide-${index + 1}`).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || `slide-${index + 1}`,
    title: String(slide?.title ?? `Slide ${index + 1}`).slice(0, 200),
    background: ["orbit", "grid", "plain"].includes(slide?.background) ? slide.background : "orbit",
    blocks: cleanBlockList(slide?.blocks, index),
  }));
  const activeSlide = Math.max(1, Math.min(slides.length, Number.isInteger(input.activeSlide) ? input.activeSlide : 1));
  const activeIndex = activeSlide - 1;
  if (Array.isArray(input.blocks)) slides[activeIndex].blocks = cleanBlockList(input.blocks, activeIndex);
  if (["orbit", "grid", "plain"].includes(input.background)) slides[activeIndex].background = input.background;
  return {
    title: String(input.title ?? defaultDeck.title).slice(0, 200),
    activeSlide,
    background: slides[activeIndex].background,
    accent: /^#[0-9a-f]{6}$/i.test(input.accent ?? "") ? input.accent : defaultDeck.accent,
    blocks: slides[activeIndex].blocks,
    slides,
  };
}

async function writeDeck(input, bufferOnly = false) {
  const deck = validateDeck(input);
  await mkdir(join(projectRoot, ".weave"), { recursive: true });
  await mkdir(join(projectRoot, "slides"), { recursive: true });
  const json = `${JSON.stringify(deck, null, 2)}\n`;
  if (bufferOnly) {
    await writeFile(join(projectRoot, ".weave", "current-buffer.json"), json);
  } else {
    const slideWrites = deck.slides.map((slide, index) =>
      writeFile(
        join(projectRoot, "slides", `${slide.id}.html`),
        renderSlide({ ...deck, activeSlide: index + 1, background: slide.background, blocks: slide.blocks }),
      ),
    );
    await Promise.all([
      writeFile(deckPath, json),
      writeFile(slidePath, renderSlide(deck)),
      writeFile(join(projectRoot, ".weave", "current-buffer.json"), json),
      ...slideWrites,
    ]);
  }
  return deck;
}

async function readDeck() {
  return validateDeck(JSON.parse(await readFile(deckPath, "utf8")));
}

function validateChat(input) {
  if (!Array.isArray(input)) return defaultChat;
  return input.slice(-200).flatMap((message, index) => {
    if (!message || (message.role !== "user" && message.role !== "agent")) return [];
    const text = String(message.text ?? "").slice(0, 50000);
    if (!text) return [];
    return [{
      id: String(message.id ?? `message-${index}`).slice(0, 100),
      role: message.role,
      text,
      createdAt: typeof message.createdAt === "string" ? message.createdAt : new Date().toISOString(),
    }];
  });
}

async function readChat() {
  try {
    return validateChat(JSON.parse(await readFile(chatPath, "utf8")));
  } catch {
    return defaultChat;
  }
}

async function writeChat(messages) {
  const chat = validateChat(messages);
  await mkdir(dirname(chatPath), { recursive: true });
  await writeFile(chatPath, `${JSON.stringify(chat, null, 2)}\n`);
  return chat;
}

async function appendChat(role, text) {
  const messages = await readChat();
  messages.push({
    id: `${role}-${Date.now().toString(36)}`,
    role,
    text: String(text).slice(0, 50000),
    createdAt: new Date().toISOString(),
  });
  return await writeChat(messages);
}

async function excludeLocalChatFromGit() {
  const excludePath = join(projectRoot, ".git", "info", "exclude");
  let current = "";
  try {
    current = await readFile(excludePath, "utf8");
  } catch {
    await mkdir(dirname(excludePath), { recursive: true });
  }
  const rule = ".weave/chat.json";
  if (!current.split("\n").includes(rule)) {
    const prefix = current && !current.endsWith("\n") ? `${current}\n` : current;
    await writeFile(excludePath, `${prefix}${rule}\n`);
  }
}

function commitIfChanged(message) {
  const status = runGit(["status", "--porcelain"]);
  if (!status) return null;
  runGit(["add", "."]);
  runGit([
    "-c",
    "user.name=Weave",
    "-c",
    "user.email=weave@localhost",
    "commit",
    "-m",
    message.slice(0, 180),
  ]);
  return runGit(["rev-parse", "HEAD"]);
}

function getHistory() {
  const output = runGit(["log", "--all", "-30", "--pretty=format:%H%x1f%h%x1f%s%x1f%aI"]);
  if (!output) return [];
  return output.split("\n").map((line) => {
    const [id, shortId, message, date] = line.split("\x1f");
    return { id, shortId, message, date };
  });
}

function getVariations() {
  const output = runGit([
    "for-each-ref",
    "--sort=creatordate",
    "--format=%(refname:short)%09%(objectname:short)%09%(subject)",
    "refs/heads/weave/variation",
  ]);
  if (!output) return [];
  return output.split("\n").map((line, index) => {
    const [branch, commit, message] = line.split("\t");
    return {
      branch,
      label: `Direction ${String.fromCharCode(65 + index)}`,
      commit,
      message,
      status: "ready",
    };
  });
}

async function ensureProject() {
  await mkdir(projectRoot, { recursive: true });
  try {
    await access(deckPath);
  } catch {
    await writeDeck(defaultDeck);
  }
  try {
    await access(chatPath);
  } catch {
    await writeChat(defaultChat);
  }
  try {
    await access(join(projectRoot, "AGENTS.md"));
  } catch {
    await writeFile(join(projectRoot, "AGENTS.md"), `${agentInstructions}\n`);
  }
  let createdRepository = false;
  try {
    await access(join(projectRoot, ".git"));
  } catch {
    runGit(["init", "-b", "main"]);
    createdRepository = true;
  }
  await excludeLocalChatFromGit();
  if (createdRepository) commitIfChanged("Create Northstar deck");
  if (runGit(["status", "--porcelain"])) commitIfChanged("Initialize Weave project");
}

class CodexAppServer extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.pending = new Map();
    this.nextId = 1;
    this.threadId = null;
    this.ready = false;
    this.account = null;
    this.error = null;
  }

  async start() {
    if (this.process) return;
    const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.process = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) this.emit("log", message);
    });
    const fail = (error) => {
      if (this.process !== child) return;
      this.ready = false;
      this.process = null;
      this.error = error instanceof Error ? error.message : String(error);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(this.error));
      }
      this.pending.clear();
      activeTurn?.fail?.(new Error(this.error));
      this.emit("status");
    };
    child.once("error", (error) => fail(new Error(`Could not start Codex app-server: ${error.message}`)));
    child.once("exit", (code) => fail(new Error(`Codex app-server exited (${code ?? "unknown"}).`)));

    try {
      await this.request("initialize", {
        clientInfo: { name: "weave_local", title: "Weave Local Editor", version: "0.1.0" },
        capabilities: { experimentalApi: false },
      });
      this.notify("initialized", {});
      const auth = await this.request("account/read", { refreshToken: false });
      this.account = auth.account;
      this.ready = true;
      this.error = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.emit("status");
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Codex request failed."));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) this.emit("notification", message);
  }

  request(method, params, timeoutMs = 30000) {
    if (!this.process?.stdin.writable) return Promise.reject(new Error("Codex app-server is not running."));
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.process.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method, params) {
    this.process?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async ensureThread() {
    if (this.threadId) return this.threadId;
    this.threadId = await this.createThread();
    return this.threadId;
  }

  async createThread() {
    const result = await this.request("thread/start", {
      cwd: projectRoot,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      baseInstructions: agentInstructions,
      serviceName: "Weave",
      ephemeral: false,
    });
    return result.thread.id;
  }

  async interrupt(threadId, turnId) {
    if (!threadId || !turnId) return;
    await this.request("turn/interrupt", { threadId, turnId });
  }

  newConversation() {
    this.threadId = null;
  }

  async stop() {
    if (!this.process) return;
    this.process.kill("SIGTERM");
  }
}

const codex = new CodexAppServer();
let activeTurn = null;

function reserveActiveTurn(kind) {
  if (activeTurn) return null;
  const turn = {
    kind,
    status: "starting",
    threadId: null,
    turnId: null,
    interruptRequested: false,
    fail: null,
  };
  activeTurn = turn;
  return turn;
}

function releaseActiveTurn(turn) {
  if (activeTurn === turn) activeTurn = null;
}

function hasAllowedOrigin(request) {
  const origin = request.headers.origin;
  return !origin || origin === "http://localhost:3000" || origin === "http://127.0.0.1:3000";
}

function corsHeaders(request) {
  const origin = request.headers.origin;
  const headers = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin",
  };
  if (origin && hasAllowedOrigin(request)) headers["access-control-allow-origin"] = origin;
  return headers;
}

function sendJson(request, response, status, value) {
  response.writeHead(status, { ...corsHeaders(request), "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_500_000) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function statePayload() {
  return {
    deck: await readDeck(),
    chat: await readChat(),
    history: getHistory(),
    variations: getVariations(),
    project: {
      root: projectRoot,
      branch: runGit(["branch", "--show-current"]) || "detached",
      commit: runGit(["rev-parse", "--short", "HEAD"]),
      clean: runGit(["status", "--porcelain"]) === "",
    },
    agent: {
      ready: codex.ready,
      account: codex.account
        ? { type: codex.account.type, planType: codex.account.planType ?? null }
        : null,
      error: codex.error,
      active: Boolean(activeTurn),
    },
  };
}

function rejectWhileAgentActive(request, response) {
  if (!activeTurn) return false;
  sendJson(request, response, 409, { error: "An Agent turn is already running." });
  return true;
}

function emitStream(response, event) {
  if (response.destroyed || response.writableEnded) return false;
  return response.write(`${JSON.stringify(event)}\n`);
}

function forwardTurnNotification(message, emit, itemPhases, appendText) {
  const params = message.params ?? {};
  if (message.method === "item/started") {
    const item = params.item ?? {};
    if (item.id && item.type === "agentMessage") itemPhases.set(item.id, item.phase ?? null);
    if (item.type === "commandExecution") emit({ type: "activity", text: "Running a project command…" });
    if (item.type === "fileChange") emit({ type: "activity", text: "Editing project files…" });
    if (item.type === "reasoning") emit({ type: "activity", text: "Reviewing the current slide…" });
    return true;
  }
  if (message.method === "item/agentMessage/delta") {
    appendText(params.delta ?? "");
    emit({
      type: "delta",
      text: params.delta ?? "",
      itemId: params.itemId ?? null,
      phase: itemPhases.get(params.itemId) ?? null,
    });
    return true;
  }
  if (message.method === "item/reasoning/summaryPartAdded") {
    emit({
      type: "reasoning",
      event: "summaryPartAdded",
      itemId: params.itemId ?? null,
      summaryIndex: params.summaryIndex ?? null,
    });
    return true;
  }
  if (message.method === "item/reasoning/summaryTextDelta") {
    emit({
      type: "reasoning",
      event: "summaryTextDelta",
      itemId: params.itemId ?? null,
      summaryIndex: params.summaryIndex ?? null,
      text: params.delta ?? "",
    });
    return true;
  }
  return false;
}

async function handleAgentTurn(request, response, payload) {
  if (activeTurn) return sendJson(request, response, 409, { error: "An Agent turn is already running." });
  if (!codex.ready) return sendJson(request, response, 503, { error: codex.error ?? "Codex is not connected." });
  const rawPrompt = String(payload.prompt ?? "");
  if (rawPrompt.length > 20000) return sendJson(request, response, 400, { error: "Prompt must be 20,000 characters or fewer." });
  const prompt = rawPrompt.trim();
  if (!prompt) return sendJson(request, response, 400, { error: "Prompt is required." });
  const currentBranch = runGit(["branch", "--show-current"]);
  if (!currentBranch) {
    return sendJson(request, response, 409, { error: "Return to a branch before starting an Agent turn." });
  }
  if (currentBranch === "main" && getVariations().length > 0) {
    return sendJson(request, response, 409, { error: "Choose or accept the active directions before editing Original." });
  }

  const buffer = validateDeck(payload.deck);
  const active = reserveActiveTurn("agent");
  if (!active) return sendJson(request, response, 409, { error: "An Agent turn is already running." });

  response.writeHead(200, {
    ...corsHeaders(request),
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const emit = (event) => emitStream(response, event);
  emit({ type: "status", status: "starting" });

  let finalText = "";
  let finalizing = false;
  let finished = false;
  let clientClosed = false;
  let completionTimer = null;
  const itemPhases = new Map();

  const cleanup = () => {
    if (finished) return;
    finished = true;
    if (completionTimer) clearTimeout(completionTimer);
    codex.off("notification", onNotification);
    response.off("close", onResponseClose);
    active.fail = null;
    releaseActiveTurn(active);
    if (!response.destroyed && !response.writableEnded) response.end();
  };
  const beginFinalize = () => {
    if (finished || finalizing) return false;
    finalizing = true;
    active.status = "finalizing";
    if (completionTimer) clearTimeout(completionTimer);
    codex.off("notification", onNotification);
    response.off("close", onResponseClose);
    return true;
  };
  const interruptActive = async () => {
    active.interruptRequested = true;
    if (!active.threadId || !active.turnId) return false;
    await codex.interrupt(active.threadId, active.turnId);
    return true;
  };
  const failTurn = async (error, { persist = true } = {}) => {
    if (!beginFinalize()) return;
    const message = error instanceof Error ? error.message : String(error);
    if (persist) {
      try {
        await appendChat("agent", `Couldn’t complete the turn: ${message}`);
      } catch {
        // Preserve the original Agent error.
      }
    }
    emit({ type: "error", error: message });
    cleanup();
  };
  const cancelForClosedResponse = async () => {
    if (!beginFinalize()) return;
    try {
      await interruptActive();
    } catch {
      // The client is gone; cleanup must still complete.
    }
    cleanup();
  };
  function onResponseClose() {
    if (finished || response.writableEnded) return;
    clientClosed = true;
    active.interruptRequested = true;
    if (active.turnId) void cancelForClosedResponse();
  }

  const onNotification = async (message) => {
    const params = message.params ?? {};
    if (active.threadId && params.threadId && params.threadId !== active.threadId) return;
    if (active.turnId && params.turnId && params.turnId !== active.turnId) return;

    if (message.method === "turn/started") {
      active.threadId = params.threadId ?? active.threadId;
      active.turnId = params.turn?.id ?? params.turnId ?? active.turnId;
      active.status = "running";
      if (active.interruptRequested && active.turnId) {
        if (clientClosed) {
          await cancelForClosedResponse();
          return;
        }
        try {
          await interruptActive();
        } catch (error) {
          await failTurn(error);
        }
      }
    } else if (forwardTurnNotification(message, emit, itemPhases, (delta) => {
      finalText += delta;
    })) {
      return;
    } else if (message.method === "item/completed" && params.item?.type === "agentMessage") {
      if (!finalText) finalText = params.item.text ?? "";
    } else if (message.method === "turn/completed") {
      if (!beginFinalize()) return;
      const status = params.turn?.status;
      try {
        if (status === "interrupted") {
          emit({ type: "canceled", state: await statePayload(), turn: params.turn });
          return;
        }
        if (status === "failed") {
          const messageText = params.turn?.error?.message ?? "The Agent turn failed.";
          await appendChat("agent", `Couldn’t complete the turn: ${messageText}`);
          emit({ type: "error", error: messageText, state: await statePayload(), turn: params.turn });
          return;
        }
        if (status !== "completed") {
          const messageText = params.turn?.error?.message ?? `The Agent turn ended with status ${status ?? "unknown"}.`;
          await appendChat("agent", `Couldn’t complete the turn: ${messageText}`);
          emit({ type: "error", error: messageText, state: await statePayload(), turn: params.turn });
          return;
        }
        if (!finalText) {
          const messages = params.turn?.items?.filter((item) => item.type === "agentMessage") ?? [];
          finalText = messages.at(-1)?.text ?? "The Agent completed the turn without a text response.";
        }
        await appendChat("agent", finalText);
        const canonical = await readDeck();
        await writeDeck(canonical);
        commitIfChanged(`Agent: ${prompt.replace(/\s+/g, " ").slice(0, 110)}`);
        emit({ type: "done", text: finalText, state: await statePayload(), turn: params.turn });
      } catch (error) {
        emit({ type: "error", error: error instanceof Error ? error.message : String(error) });
      } finally {
        cleanup();
      }
    } else if (message.method === "error") {
      const messageText = params.error?.message ?? params.message ?? "Agent error";
      if (params.willRetry) {
        emit({ type: "status", status: "retrying", message: messageText });
      } else {
        await failTurn(new Error(messageText));
      }
    }
  };

  codex.on("notification", onNotification);
  response.on("close", onResponseClose);
  active.fail = (error) => void failTurn(error);
  try {
    await writeDeck(buffer, true);
    await writeDeck(buffer);
    await appendChat("user", prompt);
    if (clientClosed) {
      cleanup();
      return;
    }
    active.threadId = await codex.ensureThread();
    if (clientClosed) {
      cleanup();
      return;
    }
    const context = `User request: ${prompt}

Current editor selection: ${String(payload.selectedId ?? "none")}
The latest unsaved editor state has been written to .weave/current-buffer.json and mirrored to .weave/deck.json.
Inspect the current project, make the requested change in .weave/deck.json, and keep the matching file under slides/ consistent.
Do not commit; Weave will commit after this turn.`;
    const result = await codex.request(
      "turn/start",
      {
        threadId: active.threadId,
        input: [{ type: "text", text: context, text_elements: [] }],
        cwd: projectRoot,
        approvalPolicy: "never",
        summary: "auto",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [projectRoot],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      },
      60000,
    );
    active.turnId = result.turn.id;
    active.status = "running";
    completionTimer = setTimeout(() => {
      void (async () => {
        try {
          await interruptActive();
        } catch {
          // Report the timeout even if interruption cannot be confirmed.
        }
        await failTurn(new Error("Agent turn timed out."));
      })();
    }, 10 * 60 * 1000);
    if (clientClosed) {
      await cancelForClosedResponse();
      return;
    }
    if (active.interruptRequested) {
      await interruptActive();
      return;
    }
    emit({ type: "status", status: "running", turnId: active.turnId });
  } catch (error) {
    if (clientClosed) await cancelForClosedResponse();
    else await failTurn(error);
  }
}

async function runVariationTurn({ prompt, threadId, emit, active, response }) {
  return await new Promise((resolvePromise, reject) => {
    let finalText = "";
    let settled = false;
    const itemPhases = new Map();
    const cleanup = () => {
      clearTimeout(timer);
      codex.off("notification", onNotification);
      response.off("close", onResponseClose);
      active.fail = null;
    };
    const rejectTurn = async (error, interrupt = false) => {
      if (settled) return;
      settled = true;
      if (interrupt && active.threadId && active.turnId) {
        try {
          await codex.interrupt(active.threadId, active.turnId);
        } catch {
          // Preserve the original failure.
        }
      }
      cleanup();
      reject(error);
    };
    function onResponseClose() {
      if (settled || response.writableEnded) return;
      active.interruptRequested = true;
      void rejectTurn(new Error("The client disconnected during variation generation."), true);
    }
    const onNotification = async (message) => {
      const params = message.params ?? {};
      if (params.threadId && params.threadId !== threadId) return;
      if (active.turnId && params.turnId && params.turnId !== active.turnId) return;
      if (message.method === "turn/started") {
        active.turnId = params.turn?.id ?? params.turnId ?? active.turnId;
        active.status = "running";
        if (active.interruptRequested && active.turnId) {
          try {
            await codex.interrupt(active.threadId, active.turnId);
          } catch (error) {
            await rejectTurn(error);
          }
        }
      } else if (forwardTurnNotification(message, emit, itemPhases, (delta) => {
        finalText += delta;
      })) {
        return;
      } else if (message.method === "turn/completed") {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise({ turn: params.turn, finalText });
      } else if (message.method === "error") {
        const messageText = params.error?.message ?? params.message ?? "Agent error";
        if (params.willRetry) emit({ type: "status", status: "retrying", message: messageText });
        else await rejectTurn(new Error(messageText));
      }
    };
    const timer = setTimeout(() => {
      void rejectTurn(new Error("Variation generation timed out."), true);
    }, 10 * 60 * 1000);
    codex.on("notification", onNotification);
    response.on("close", onResponseClose);
    active.fail = (error) => void rejectTurn(error);
    void (async () => {
      try {
        const result = await codex.request(
          "turn/start",
          {
            threadId,
            input: [{ type: "text", text: prompt, text_elements: [] }],
            cwd: projectRoot,
            approvalPolicy: "never",
            summary: "auto",
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: [projectRoot],
              networkAccess: false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            },
          },
          60000,
        );
        active.turnId = result.turn.id;
        active.status = "running";
        if (active.interruptRequested) await codex.interrupt(active.threadId, active.turnId);
        emit({ type: "status", status: "running", turnId: active.turnId });
      } catch (error) {
        await rejectTurn(error);
      }
    })();
  });
}

function discardVariationBranch(branch) {
  if (!branch.startsWith("weave/variation/")) return;
  if (runGit(["branch", "--show-current"]) === branch) runGit(["checkout", "-f", "main"]);
  const exists = runGit(["branch", "--list", branch]);
  if (exists) runGit(["branch", "-D", branch]);
}

async function handleGenerateVariation(request, response, payload) {
  if (activeTurn) return sendJson(request, response, 409, { error: "An Agent turn is already running." });
  if (!codex.ready) return sendJson(request, response, 503, { error: codex.error ?? "Codex is not connected." });
  if (runGit(["branch", "--show-current"]) !== "main") {
    return sendJson(request, response, 409, { error: "Return to Original before generating another direction." });
  }
  if (runGit(["status", "--porcelain"])) {
    return sendJson(request, response, 409, { error: "Save current changes before generating a direction." });
  }
  const rawPrompt = String(payload.prompt ?? "");
  if (rawPrompt.length > 16000) return sendJson(request, response, 400, { error: "Direction prompt must be 16,000 characters or fewer." });
  const userPrompt = rawPrompt.trim();
  if (!userPrompt) return sendJson(request, response, 400, { error: "A direction prompt is required." });
  const deck = validateDeck(payload.deck);
  const active = reserveActiveTurn("variation");
  if (!active) return sendJson(request, response, 409, { error: "An Agent turn is already running." });

  const existing = getVariations();
  const suffix = String.fromCharCode(97 + existing.length);
  const branch = `weave/variation/${suffix}-${Date.now().toString(36)}`;
  response.writeHead(200, {
    ...corsHeaders(request),
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const emit = (event) => emitStream(response, event);
  emit({ type: "variation", status: "generating", branch, label: `Direction ${suffix.toUpperCase()}` });

  let branchCreated = false;
  try {
    runGit(["checkout", "-b", branch, "main"]);
    branchCreated = true;
    await writeDeck(deck);
    active.threadId = await codex.createThread();
    const prompt = `Create a distinct slide direction from the current project.
User direction: ${userPrompt}

Read .weave/deck.json and .weave/current-buffer.json. Edit the canonical deck JSON and keep the matching files under slides/ consistent.
Preserve the block schema and use flow layout principles. Make a meaningfully different but polished direction.
Do not run git commands or commit. Weave owns the branch lifecycle and commit.`;
    const result = await runVariationTurn({ prompt, threadId: active.threadId, emit, active, response });
    if (result.turn?.status === "interrupted") {
      discardVariationBranch(branch);
      emit({ type: "canceled", state: await statePayload(), branch });
      return;
    }
    if (result.turn?.status !== "completed") {
      const message = result.turn?.error?.message ?? "Variation generation failed.";
      discardVariationBranch(branch);
      emit({ type: "error", error: message, state: await statePayload(), branch });
      return;
    }
    const canonical = await readDeck();
    await writeDeck(canonical);
    commitIfChanged(`Variation ${suffix.toUpperCase()}: ${userPrompt.replace(/\s+/g, " ").slice(0, 100)}`);
    emit({ type: "done", text: result.finalText, state: await statePayload(), branch });
  } catch (error) {
    if (branchCreated) discardVariationBranch(branch);
    emit({ type: "error", error: error instanceof Error ? error.message : String(error), branch });
  } finally {
    active.fail = null;
    releaseActiveTurn(active);
    if (!response.destroyed && !response.writableEnded) response.end();
  }
}

const server = createServer(async (request, response) => {
  try {
    if (!hasAllowedOrigin(request)) {
      return sendJson(request, response, 403, { error: "Origin is not allowed." });
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders(request));
      return response.end();
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return sendJson(request, response, 200, { ok: true, agent: codex.ready });
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      return sendJson(request, response, 200, await statePayload());
    }
    if (request.method === "POST" && url.pathname === "/api/save") {
      if (rejectWhileAgentActive(request, response)) return;
      const payload = await readJson(request);
      const currentBranch = runGit(["branch", "--show-current"]);
      if (!currentBranch) {
        return sendJson(request, response, 409, { error: "Return to the latest branch before saving." });
      }
      if (currentBranch === "main" && getVariations().length > 0) {
        return sendJson(request, response, 409, { error: "Choose or accept the active directions before editing Original." });
      }
      const deck = await writeDeck(payload.deck);
      const commit = commitIfChanged(`Save: ${String(payload.message ?? deck.title).slice(0, 120)}`);
      return sendJson(request, response, 200, { ...(await statePayload()), commit });
    }
    if (request.method === "POST" && url.pathname === "/api/history/checkout") {
      if (rejectWhileAgentActive(request, response)) return;
      const payload = await readJson(request);
      const commit = String(payload.commit ?? "");
      if (!/^[0-9a-f]{7,40}$/i.test(commit)) return sendJson(request, response, 400, { error: "Invalid history id." });
      if (runGit(["status", "--porcelain"])) return sendJson(request, response, 409, { error: "Save the current changes before restoring history." });
      runGit(["checkout", "--detach", commit]);
      return sendJson(request, response, 200, await statePayload());
    }
    if (request.method === "POST" && url.pathname === "/api/history/main") {
      if (rejectWhileAgentActive(request, response)) return;
      if (runGit(["status", "--porcelain"])) return sendJson(request, response, 409, { error: "Save the current changes before returning to the latest version." });
      runGit(["checkout", "main"]);
      return sendJson(request, response, 200, await statePayload());
    }
    if (request.method === "POST" && url.pathname === "/api/variations/checkout") {
      if (rejectWhileAgentActive(request, response)) return;
      if (runGit(["status", "--porcelain"])) return sendJson(request, response, 409, { error: "Save current changes before switching directions." });
      const payload = await readJson(request);
      const branch = String(payload.branch ?? "");
      const allowed = branch === "main" || getVariations().some((variation) => variation.branch === branch);
      if (!allowed) return sendJson(request, response, 400, { error: "Unknown direction." });
      runGit(["checkout", branch]);
      return sendJson(request, response, 200, await statePayload());
    }
    if (request.method === "POST" && url.pathname === "/api/variations/generate") {
      if (rejectWhileAgentActive(request, response)) return;
      return await handleGenerateVariation(request, response, await readJson(request));
    }
    if (request.method === "POST" && url.pathname === "/api/variations/accept") {
      if (rejectWhileAgentActive(request, response)) return;
      if (runGit(["status", "--porcelain"])) return sendJson(request, response, 409, { error: "The current direction has uncommitted changes." });
      const selected = runGit(["branch", "--show-current"]);
      if (!selected.startsWith("weave/variation/")) return sendJson(request, response, 400, { error: "Select a generated direction first." });
      const variations = getVariations();
      runGit(["checkout", "main"]);
      runGit(["merge", "--ff-only", selected]);
      for (const variation of variations) {
        if (variation.branch === selected) {
          runGit(["branch", "-d", variation.branch]);
        } else {
          runGit(["branch", "-m", variation.branch, variation.branch.replace("weave/variation/", "weave/history/")]);
        }
      }
      return sendJson(request, response, 200, await statePayload());
    }
    if (request.method === "POST" && url.pathname === "/api/variations/archive") {
      if (rejectWhileAgentActive(request, response)) return;
      if (runGit(["status", "--porcelain"])) return sendJson(request, response, 409, { error: "The current direction has uncommitted changes." });
      const selected = runGit(["branch", "--show-current"]);
      if (!selected.startsWith("weave/variation/")) return sendJson(request, response, 400, { error: "Select a generated direction first." });
      runGit(["checkout", "main"]);
      runGit(["branch", "-m", selected, selected.replace("weave/variation/", "weave/history/")]);
      return sendJson(request, response, 200, await statePayload());
    }
    if (request.method === "POST" && url.pathname === "/api/agent/turn") {
      return await handleAgentTurn(request, response, await readJson(request));
    }
    if (request.method === "POST" && url.pathname === "/api/chat/clear") {
      if (rejectWhileAgentActive(request, response)) return;
      await writeChat(defaultChat);
      codex.newConversation();
      return sendJson(request, response, 200, await statePayload());
    }
    if (request.method === "POST" && url.pathname === "/api/agent/interrupt") {
      if (!activeTurn) return sendJson(request, response, 409, { ok: false, status: "idle", error: "No Agent turn is running." });
      if (activeTurn.status === "finalizing") {
        return sendJson(request, response, 409, { ok: false, status: "finalizing", error: "The Agent turn is already finishing." });
      }
      activeTurn.interruptRequested = true;
      if (!activeTurn.threadId || !activeTurn.turnId) {
        return sendJson(request, response, 202, { ok: true, status: "queued" });
      }
      try {
        await codex.interrupt(activeTurn.threadId, activeTurn.turnId);
        activeTurn.status = "stopping";
        return sendJson(request, response, 200, {
          ok: true,
          status: "interrupting",
          threadId: activeTurn.threadId,
          turnId: activeTurn.turnId,
        });
      } catch (error) {
        return sendJson(request, response, 502, {
          ok: false,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return sendJson(request, response, 404, { error: "Not found." });
  } catch (error) {
    return sendJson(request, response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

await ensureProject();
server.listen(apiPort, "127.0.0.1", () => {
  console.log(`Weave local API: http://127.0.0.1:${apiPort}`);
  void codex.start();
});

async function shutdown() {
  await codex.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
