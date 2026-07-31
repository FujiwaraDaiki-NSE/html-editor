import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDeckCss, renderSlideDocument } from "../shared/slide-design.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const projectRoot = join(repoRoot, "workspaces", "northstar");
const deckPath = join(projectRoot, ".weave", "deck.json");
const bufferPath = join(projectRoot, ".weave", "current-buffer.json");
const slidesRoot = join(projectRoot, "slides");
const stylesRoot = join(projectRoot, "styles");
const deckCssPath = join(stylesRoot, "deck.css");

export const agentInstructions = `You are the editing agent embedded in Weave, a visual HTML slide editor.
The project uses .weave/deck.json as the canonical editor state and one HTML file per slide under slides/.
Slide styling lives in styles/deck.css. Edit that file to change how slides look; slides/*.html is generated from deck.json and deck.css, so never edit it directly.
Slides are authored at a fixed 1280x720 design size: write plain pixel values, no responsive units, and keep every selector under .weave-slide.
The top-level blocks and background mirror the active slide. Keep them synchronized with slides[activeSlide - 1].
Before editing, inspect .weave/deck.json and .weave/current-buffer.json when present.
The current buffer is authoritative even when it differs from the last commit.
Make focused changes that answer the user. Preserve valid JSON, all slides, and the existing block schema.
Use flow layout (flex or grid with gap); do not introduce free-positioned content blocks.
Do not run git commands or commit changes. Weave commits the completed turn atomically.
If no file change is needed, respond with a concise explanation.`;

const defaultSlides = [
  {
    id: "opportunity",
    title: "The opportunity",
    background: "orbit",
    blocks: [
      { id: "eyebrow", kind: "eyebrow", label: "Eyebrow", text: "PRODUCT STRATEGY · 2026" },
      { id: "heading", kind: "heading", label: "Heading", text: "Make ideas visible,\nwhile they’re still moving." },
      { id: "paragraph", kind: "paragraph", label: "Body", text: "A shared canvas where your team and an agent shape the same story — from first thought to final slide." },
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

function runGit(args, options = {}) {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

/* Slide files are generated from deck.json plus the project stylesheet. deck.css itself is
   never regenerated — it is hand/agent-authored content that has to survive every save. */
export async function readDeckCss() {
  try {
    return await readFile(deckCssPath, "utf8");
  } catch {
    return defaultDeckCss;
  }
}

export function validateDeck(input) {
  if (!input || typeof input !== "object") throw new Error("Deck payload is required.");
  const allowedKinds = new Set(["eyebrow", "heading", "paragraph", "metrics", "note"]);
  const cleanBlocks = (blocks, slideIndex) => {
    if (!Array.isArray(blocks) || blocks.length === 0 || blocks.length > 100) {
      throw new Error(`Slide ${slideIndex + 1} must contain 1–100 blocks.`);
    }
    return blocks.map((block, index) => {
      if (!block || typeof block !== "object" || !allowedKinds.has(block.kind)) {
        throw new Error(`Block ${index + 1} is invalid.`);
      }
      const id = String(block.id ?? "").slice(0, 80);
      if (!id) throw new Error(`Block ${index + 1} needs an id.`);
      return {
        id,
        kind: block.kind,
        label: String(block.label ?? block.kind).slice(0, 80),
        text: String(block.text ?? "").slice(0, 12_000),
      };
    });
  };
  const sourceSlides = Array.isArray(input.slides) && input.slides.length
    ? input.slides.slice(0, 100)
    : defaultSlides;
  const slides = sourceSlides.map((slide, index) => ({
    id: String(slide?.id ?? `slide-${index + 1}`).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || `slide-${index + 1}`,
    title: String(slide?.title ?? `Slide ${index + 1}`).slice(0, 200),
    background: ["orbit", "grid", "plain"].includes(slide?.background) ? slide.background : "orbit",
    blocks: cleanBlocks(slide?.blocks, index),
  }));
  const activeSlide = Math.max(1, Math.min(slides.length, Number.isInteger(input.activeSlide) ? input.activeSlide : 1));
  const activeIndex = activeSlide - 1;
  if (Array.isArray(input.blocks)) slides[activeIndex].blocks = cleanBlocks(input.blocks, activeIndex);
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

export async function writeDeck(input, bufferOnly = false) {
  const deck = validateDeck(input);
  await mkdir(join(projectRoot, ".weave"), { recursive: true });
  await mkdir(slidesRoot, { recursive: true });
  const json = `${JSON.stringify(deck, null, 2)}\n`;
  if (bufferOnly) {
    await writeFile(bufferPath, json);
    return deck;
  }
  const css = await readDeckCss();
  await Promise.all([
    writeFile(deckPath, json),
    writeFile(bufferPath, json),
    ...deck.slides.map((slide, index) =>
      writeFile(
        join(slidesRoot, `${slide.id}.html`),
        renderSlideDocument({ ...deck, activeSlide: index + 1, background: slide.background, blocks: slide.blocks }, css),
      )),
  ]);
  return deck;
}

export async function readDeck() {
  return validateDeck(JSON.parse(await readFile(deckPath, "utf8")));
}

export function commitIfChanged(message) {
  if (!runGit(["status", "--porcelain"])) return null;
  runGit(["add", ".weave/deck.json", ".weave/current-buffer.json", "slides", "styles", "AGENTS.md"]);
  if (!runGit(["diff", "--cached", "--name-only"])) return null;
  runGit(["-c", "user.name=Weave", "-c", "user.email=weave@localhost", "commit", "-m", message.slice(0, 180)]);
  return runGit(["rev-parse", "HEAD"]);
}

export function getHistory() {
  const output = runGit(["log", "--all", "-30", "--pretty=format:%H%x1f%h%x1f%s%x1f%aI"]);
  return output ? output.split("\n").map((line) => {
    const [id, shortId, message, date] = line.split("\x1f");
    return { id, shortId, message, date };
  }) : [];
}

export function getVariations() {
  const output = runGit(["for-each-ref", "--sort=creatordate", "--format=%(refname:short)%09%(objectname:short)%09%(subject)", "refs/heads/weave/variation"]);
  return output ? output.split("\n").map((line, index) => {
    const [branch, commit, message] = line.split("\t");
    return { branch, label: `Direction ${String.fromCharCode(65 + index)}`, commit, message, status: "ready" };
  }) : [];
}

export function projectState() {
  return {
    history: getHistory(),
    variations: getVariations(),
    project: {
      root: projectRoot,
      branch: runGit(["branch", "--show-current"]) || "detached",
      commit: runGit(["rev-parse", "--short", "HEAD"]),
      clean: runGit(["status", "--porcelain"]) === "",
    },
  };
}

export function checkoutHistory(commit) {
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error("Invalid history id.");
  if (runGit(["status", "--porcelain"])) throw new Error("Save the current changes before restoring history.");
  runGit(["checkout", "--detach", commit]);
}

export function checkoutMain() {
  if (runGit(["status", "--porcelain"])) throw new Error("Save the current changes before returning to the latest version.");
  runGit(["checkout", "main"]);
}

export function checkoutVariation(branch) {
  if (runGit(["status", "--porcelain"])) throw new Error("Save current changes before switching directions.");
  const allowed = branch === "main" || getVariations().some((item) => item.branch === branch);
  if (!allowed) throw new Error("Unknown direction.");
  runGit(["checkout", branch]);
}

export function createVariationBranch() {
  if (runGit(["status", "--porcelain"])) throw new Error("Save current changes before creating a direction.");
  if (runGit(["branch", "--show-current"]) !== "main") runGit(["checkout", "main"]);
  const existing = new Set(getVariations().map((item) => item.branch));
  let index = 0;
  let branch;
  do {
    branch = `weave/variation/${String.fromCharCode(97 + index)}`;
    index += 1;
  } while (existing.has(branch));
  runGit(["checkout", "-b", branch]);
  return branch;
}

export function acceptVariation() {
  if (runGit(["status", "--porcelain"])) throw new Error("The current direction has uncommitted changes.");
  const selected = runGit(["branch", "--show-current"]);
  if (!selected.startsWith("weave/variation/")) throw new Error("Select a generated direction first.");
  const variations = getVariations();
  runGit(["checkout", "main"]);
  runGit(["merge", "--ff-only", selected]);
  for (const variation of variations) {
    if (variation.branch === selected) runGit(["branch", "-d", variation.branch]);
    else runGit(["branch", "-m", variation.branch, variation.branch.replace("weave/variation/", "weave/history/")]);
  }
}

export function archiveVariation() {
  if (runGit(["status", "--porcelain"])) throw new Error("The current direction has uncommitted changes.");
  const selected = runGit(["branch", "--show-current"]);
  if (!selected.startsWith("weave/variation/")) throw new Error("Select a generated direction first.");
  runGit(["checkout", "main"]);
  runGit(["branch", "-m", selected, selected.replace("weave/variation/", "weave/history/")]);
}

async function removeLegacyChatData() {
  await rm(join(projectRoot, ".weave", "chat.json"), { force: true });
  const excludePath = join(projectRoot, ".git", "info", "exclude");
  try {
    const current = await readFile(excludePath, "utf8");
    const next = current.split("\n").filter((line) => line.trim() !== ".weave/chat.json").join("\n");
    if (next !== current) await writeFile(excludePath, next);
  } catch {
    // A repository created below has no exclude file yet.
  }
}

export async function ensureProject() {
  await mkdir(projectRoot, { recursive: true });
  let createdRepository = false;
  try {
    await access(join(projectRoot, ".git"));
  } catch {
    runGit(["init", "-b", "main"]);
    createdRepository = true;
  }
  await removeLegacyChatData();
  try {
    await access(deckPath);
  } catch {
    await writeDeck(defaultDeck);
  }
  await mkdir(stylesRoot, { recursive: true });
  try {
    await access(deckCssPath);
  } catch {
    await writeFile(deckCssPath, defaultDeckCss);
  }
  /* AGENTS.md is generated, so it follows the instructions in this file. */
  const instructions = `${agentInstructions}\n`;
  if (await readFile(join(projectRoot, "AGENTS.md"), "utf8").catch(() => null) !== instructions) {
    await writeFile(join(projectRoot, "AGENTS.md"), instructions);
  }
  if (createdRepository) commitIfChanged("Create Northstar deck");
}
