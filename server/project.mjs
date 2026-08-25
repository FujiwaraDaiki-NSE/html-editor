import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDeckCss, slideFragmentFromBlocks } from "../shared/slide-design.mjs";
import { formatDeckCss, formatSlideHtml } from "../shared/html-format.mjs";
import { auditContentPolicy, auditHtmlSafety } from "../shared/content-policy.mjs";
import { defaultSlideClasses, migrateSlideHtmlToTailwind } from "../shared/tailwind-slide.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const projectRoot = process.env.WEAVE_PROJECT_ROOT
  ? resolve(process.env.WEAVE_PROJECT_ROOT)
  : join(repoRoot, "workspaces", "northstar");
const manifestPath = join(projectRoot, ".weave", "deck.json");
const slidesRoot = join(projectRoot, "slides");
const stylesRoot = join(projectRoot, "styles");
const assetsRoot = join(projectRoot, "assets");
export const templatesRoot = join(projectRoot, "templates");
const deckCssPath = join(stylesRoot, "deck.css");

const templateThemes = [
  { id: "orbit", name: "Orbit / Dark", background: "bg-slate-950", text: "text-slate-50" },
  { id: "grid", name: "Grid / Graphite", background: "bg-slate-900", text: "text-slate-50" },
  { id: "plain", name: "Plain / Ink", background: "bg-white", text: "text-slate-950" },
];
const templateRootClasses = ({ id, background, text }) => [
  ...defaultSlideClasses.split(" ").filter((name) => name !== "bg-slate-950" && name !== "text-slate-50"),
  `theme-${id}`,
  background,
  text,
].join(" ");

const defaultTemplates = templateThemes.map((theme) => ({
  id: theme.id,
  name: theme.name,
  filename: `${theme.id}.html`,
  html: `<main class="${templateRootClasses(theme)}" data-weave-slide data-weave-template="${theme.id}" data-weave-template-name="${theme.name}">
    <div class="brand flex items-center gap-2 text-xs font-bold tracking-widest text-slate-400">WEAVE<span class="text-amber-400">●</span></div>
    <section class="hero flex flex-1 flex-col items-start justify-center gap-6" data-weave-slot="content">
      <h1 class="heading text-6xl font-semibold leading-none tracking-tight" data-weave-slot="title" data-weave-id="title"></h1>
    </section>
    <div class="page-number absolute top-0 right-0 p-8 text-xs font-semibold tracking-widest text-slate-400">01 / 01</div>
  </main>`,
}));

const yearEndReportTemplate = {
  id: "year-end-report",
  name: "年度末報告 / Red & Blue",
  filename: "year-end-report.html",
  html: `<main class="${templateRootClasses({ id: "plain", background: "bg-white", text: "text-slate-950" })}" data-weave-slide data-weave-template="year-end-report" data-weave-template-name="年度末報告 / Red & Blue">
    <svg class="report-frame absolute inset-0 h-full w-full" data-weave-id="year-end-report-frame" viewBox="0 0 1280 720" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="year-end-report-gradient" x1="0%" x2="100%" y1="0%" y2="0%">
          <stop offset="0%" stop-color="#c2c2c2"></stop>
          <stop offset="55%" stop-color="#dcdcdc"></stop>
          <stop offset="100%" stop-color="#f3f3f3"></stop>
        </linearGradient>
      </defs>
      <path d="M0 0 L1280 0 C797.33 24 402.67 118 165.33 285 C76 348 24 392 0 416 Z" fill="url(#year-end-report-gradient)"></path>
      <line x1="131" y1="69" x2="1280" y2="69" stroke="#e00000" stroke-width="2"></line>
      <line x1="131" y1="662" x2="1280" y2="662" stroke="#004dff" stroke-width="2"></line>
    </svg>
    <div class="report-organization brand flex items-center gap-2 text-xs font-bold tracking-widest text-slate-400" data-weave-id="year-end-report-organization">Organization Name</div>
    <section class="hero flex flex-1 flex-col items-start justify-center gap-6" data-weave-slot="content">
      <h1 class="heading text-6xl font-semibold leading-none tracking-tight" data-weave-slot="title" data-weave-id="title"></h1>
    </section>
    <div class="report-copyright brand flex items-center gap-2 text-xs font-bold tracking-widest text-slate-400" data-weave-id="year-end-report-copyright">© Organization Name</div>
    <div class="page-number absolute top-0 right-0 p-8 text-xs font-semibold tracking-widest text-slate-400" data-weave-id="year-end-report-page-number">01 / 01</div>
  </main>`,
};

export const builtInTemplates = [...defaultTemplates, yearEndReportTemplate];

export const agentInstructions = `You are the editing agent embedded in Weave, a visual HTML slide editor.
The truth of every slide is its own file: slides/<id>.html holds a <main class="weave-slide"> fragment.
Edit those HTML files directly. styles/deck.css is generated and read-only. Do not
generate or hand-maintain any intermediate model; .weave/deck.json is only a manifest of slide order,
titles, and speaker notes (Weave keeps it in sync — you rarely touch it, except to reorder slides).
templates/<id>.html holds an empty frame whose root carries data-weave-template and
data-weave-template-name. Every slide has data-weave-slot="title" and data-weave-slot="content";
the title slot's text is the slide name, and .weave/deck.json's title is derived from it. Templates
supply typography by inheritance, so ordinary blocks omit color and font size unless they mean to
differ. Kind-identity sizes such as eyebrow and note, and accent colors, stay explicit. To change a
slide's layout, move the title slot's inner content and the remaining content children into the new
frame's slots; do not edit the shared template frame in place.
Slide styling is expressed only with the precompiled Tailwind utility classes already used in the
project. Use standard Tailwind scale values and existing classes; never use inline style attributes,
arbitrary-value classes such as [...], or edit styles/deck.css — read that file when you need the
registry of classes the project supports. Prefer flex/grid flow layout. Keep a
data-weave-id on every element the human can select. Represent line breaks as <br>, not literal newlines.
Reference imported images with relative assets/<hash>.<ext> paths. Lists use ul.list with li children;
tables use table.table and keep data-weave-id on the table rather than individual cells. Graphs and
decorative diagrams are static inline SVG: use fill="currentColor" with text-* classes instead of raw
hex colors, size the SVG with w-full and aspect-* classes, and put data-weave-id on the SVG root.
Make focused changes that answer the user. Read-only git (log, show, diff) is fine when you need the
history; never commit, checkout, or otherwise change the repository — Weave formats and commits the turn.
If no file change is needed, respond with a concise explanation.`;

const assetTypes = new Map([
  ["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"],
  ["image/svg+xml", "svg"], ["image/gif", "gif"],
]);
const maxAssetBytes = 10 * 1024 * 1024;

export async function importImageAsset({ data, mimeType }) {
  const extension = assetTypes.get(String(mimeType ?? "").toLowerCase());
  if (!extension) throw new Error("Unsupported image type. Use PNG, JPEG, WebP, SVG, or GIF.");
  const bytes = Buffer.from(String(data ?? ""), "base64");
  if (!bytes.length) throw new Error("Image data is required.");
  if (bytes.length > maxAssetBytes) throw new Error("Image must be 10 MB or smaller.");
  if (extension === "svg") {
    const safety = auditHtmlSafety(bytes.toString("utf8"));
    if (!safety.ok) {
      const error = new Error("SVG failed the content safety check.");
      error.code = "WEAVE_ASSET_POLICY";
      error.diagnostics = safety.diagnostics;
      throw error;
    }
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  const filename = `${hash}.${extension}`;
  await mkdir(assetsRoot, { recursive: true });
  await writeFile(join(assetsRoot, filename), bytes);
  return { path: `assets/${filename}`, mimeType, size: bytes.length };
}

/* Seed content, authored as blocks and stamped into HTML fragments exactly once. After seeding
   the fragment on disk is the truth; blocks are never consulted again at runtime. */
const seedSlides = [
  {
    id: "opportunity", title: "The opportunity", background: "orbit", notes: "",
    blocks: [
      { id: "eyebrow", kind: "eyebrow", text: "PRODUCT STRATEGY · 2026" },
      { id: "heading", kind: "heading", text: "Make ideas visible,\nwhile they’re still moving." },
      { id: "paragraph", kind: "paragraph", text: "A shared canvas where your team and an agent shape the same story — from first thought to final slide." },
      { id: "metrics", kind: "metrics", text: "3.2×|faster iteration|42%|less rework" },
      { id: "note", kind: "note", text: "Q3 PRODUCT NARRATIVE" },
    ],
  },
  {
    id: "market-shift", title: "Market shift", background: "grid", notes: "",
    blocks: [
      { id: "eyebrow-2", kind: "eyebrow", text: "THE SHIFT" },
      { id: "heading-2", kind: "heading", text: "The interface is becoming\na collaborator." },
      { id: "paragraph-2", kind: "paragraph", text: "Teams no longer choose between visual tools and code. The strongest workflows bring both into one continuous loop." },
      { id: "metrics-2", kind: "metrics", text: "68%|use AI weekly|2.4×|more variants" },
      { id: "note-2", kind: "note", text: "WORKFLOW RESEARCH · 2026" },
    ],
  },
  {
    id: "approach", title: "Our approach", background: "orbit", notes: "",
    blocks: [
      { id: "eyebrow-3", kind: "eyebrow", text: "OUR APPROACH" },
      { id: "heading-3", kind: "heading", text: "One canvas.\nTwo ways to create." },
      { id: "paragraph-3", kind: "paragraph", text: "People shape the story visually. Agents work directly in the same HTML project. Selection, code, and properties stay aligned." },
      { id: "metrics-3", kind: "metrics", text: "1|shared history|0|handoff gaps" },
      { id: "note-3", kind: "note", text: "WEAVE PRODUCT PRINCIPLE" },
    ],
  },
  {
    id: "next-steps", title: "Next steps", background: "plain", notes: "",
    blocks: [
      { id: "eyebrow-4", kind: "eyebrow", text: "FROM IDEA TO DECK" },
      { id: "heading-4", kind: "heading", text: "Start with the story.\nRefine in the flow." },
      { id: "paragraph-4", kind: "paragraph", text: "Build the first narrative, generate focused directions, and commit the version your audience should remember." },
      { id: "metrics-4", kind: "metrics", text: "4|slides to align|1|direction to ship" },
      { id: "note-4", kind: "note", text: "NEXT · PILOT WITH PRODUCT TEAMS" },
    ],
  },
];

const seedTitle = "Q3 Strategy Deck";

/* Build the seed/migration project { title, slides:[{id,title,notes,html}] } from block data. */
function projectFromBlockSlides(title, accent, blockSlides) {
  const total = blockSlides.length;
  return {
    title,
    slides: blockSlides.map((slide, index) => ({
      id: slide.id,
      title: slide.title ?? `Slide ${index + 1}`,
      notes: slide.notes ?? "",
      html: slideFragmentFromBlocks({
        blocks: slide.blocks,
        background: slide.background ?? "orbit",
        accent: accent ?? "#f6b84b",
        total,
        position: index + 1,
      }),
    })),
  };
}

const seedProject = () => projectFromBlockSlides(seedTitle, "#f6b84b", seedSlides);

function runGit(args, options = {}) {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

export function getRevision() {
  try {
    return runGit(["rev-parse", "HEAD"]);
  } catch {
    return null;
  }
}

export function assertRevision(expectedRevision) {
  if (expectedRevision == null) return;
  const actualRevision = getRevision();
  if (expectedRevision !== actualRevision) {
    const error = new Error("The deck changed after it was loaded. Refresh before saving again.");
    error.code = "WEAVE_REVISION_CONFLICT";
    error.expectedRevision = expectedRevision;
    error.actualRevision = actualRevision;
    throw error;
  }
}

/* deck.css is authored directly (human via inspector overrides, agent via this file). It is never
   regenerated — read it as-is, falling back to the shipped default only when absent. */
export async function readDeckCss() {
  try {
    return await readFile(deckCssPath, "utf8");
  } catch {
    return defaultDeckCss;
  }
}

const templateAttribute = (opening, name) => opening.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i"))?.slice(1).find((value) => value !== undefined)?.trim() ?? "";

export async function readTemplates() {
  const entries = await readdir(templatesRoot, { withFileTypes: true }).catch(() => []);
  const templates = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".html")).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const html = await readFile(join(templatesRoot, entry.name), "utf8");
      const policy = auditContentPolicy({ html });
      if (!policy.ok) continue;
      const opening = html.match(/<main\b[^>]*>/i)?.[0] ?? "";
      const fallback = entry.name.slice(0, -".html".length);
      const id = templateAttribute(opening, "data-weave-template") || fallback;
      const name = templateAttribute(opening, "data-weave-template-name") || id;
      templates.push({ id, name, html });
    } catch {
      // A broken template must not prevent the rest of the project from loading.
    }
  }
  return templates;
}

export async function ensureTemplates() {
  await mkdir(templatesRoot, { recursive: true });
  const canonical = await Promise.all(builtInTemplates.map(async (template) => ({
    ...template,
    html: await formatSlideHtml(template.html),
  })));
  const touched = [];
  for (const template of canonical) {
    const path = join(templatesRoot, template.filename);
    if (await readFile(path, "utf8").catch(() => "") === template.html) continue;
    await writeFile(path, template.html);
    touched.push(`templates/${template.filename}`);
  }
  return touched;
}

const slugify = (value, fallback) =>
  String(value ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || fallback;

/** Normalize a project payload { title, slides:[{id,title,notes,html}] } coming from a client. */
export function validateProject(input) {
  if (!input || typeof input !== "object") throw new Error("Project payload is required.");
  const sourceSlides = Array.isArray(input.slides) && input.slides.length ? input.slides.slice(0, 100) : [];
  if (!sourceSlides.length) throw new Error("A deck needs at least one slide.");
  const seen = new Set();
  const slides = sourceSlides.map((slide, index) => {
    let id = slugify(slide?.id, `slide-${index + 1}`);
    while (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    const html = String(slide?.html ?? "");
    if (!html.trim()) throw new Error(`Slide ${index + 1} has empty HTML.`);
    if (html.length > 200_000) throw new Error(`Slide ${index + 1} HTML is too large.`);
    return {
      id,
      title: String(slide?.title ?? `Slide ${index + 1}`).slice(0, 200),
      notes: String(slide?.notes ?? "").slice(0, 20_000),
      html,
    };
  });
  return { title: String(input.title ?? seedTitle).slice(0, 200), slides };
}

async function readSlideHtml(id) {
  try {
    return await readFile(join(slidesRoot, `${id}.html`), "utf8");
  } catch {
    return "";
  }
}

async function readManifest() {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

/** The project as the editor loads it: manifest joined with each slide's HTML fragment. */
export async function readProject() {
  const manifest = await readManifest();
  if (!manifest || !Array.isArray(manifest.slides)) return seedProject();
  const slides = await Promise.all(manifest.slides.map(async (slide, index) => ({
    id: slide.id,
    title: String(slide.title ?? `Slide ${index + 1}`),
    notes: String(slide.notes ?? ""),
    html: await readSlideHtml(slide.id),
  })));
  return { title: String(manifest.title ?? seedTitle), slides };
}

/** Write the project: every slide file (formatted) plus the manifest, transactionally. */
export async function writeProject(input, expectedRevision = null) {
  const project = validateProject(input);
  const slides = await Promise.all(project.slides.map(async (slide) => ({
    ...slide,
    html: await formatSlideHtml(slide.html),
  })));
  const manifest = { title: project.title, slides: slides.map(({ id, title, notes }) => ({ id, title, notes })) };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;

  await mkdir(join(projectRoot, ".weave"), { recursive: true });
  assertRevision(expectedRevision);

  const transactionId = randomUUID();
  const stagedSlidesRoot = join(projectRoot, `.slides-${transactionId}.staged`);
  const previousSlidesRoot = join(projectRoot, `.slides-${transactionId}.previous`);
  const stagedManifestPath = join(projectRoot, ".weave", `.deck-${transactionId}.staged`);
  const previousManifestPath = join(projectRoot, ".weave", `.deck-${transactionId}.previous`);
  let movedPreviousSlides = false;
  let installedSlides = false;
  let movedPreviousManifest = false;
  let installedManifest = false;
  try {
    await mkdir(stagedSlidesRoot, { recursive: true });
    await Promise.all([
      writeFile(stagedManifestPath, manifestJson),
      ...slides.map((slide) => writeFile(join(stagedSlidesRoot, `${slide.id}.html`), slide.html)),
    ]);

    // Re-check just before publishing so a concurrent commit is not silently overwritten.
    assertRevision(expectedRevision);
    try {
      await rename(slidesRoot, previousSlidesRoot);
      movedPreviousSlides = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rename(stagedSlidesRoot, slidesRoot);
    installedSlides = true;
    try {
      await rename(manifestPath, previousManifestPath);
      movedPreviousManifest = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rename(stagedManifestPath, manifestPath);
    installedManifest = true;
    await Promise.all([
      rm(previousSlidesRoot, { recursive: true, force: true }),
      rm(previousManifestPath, { force: true }),
    ]);
  } catch (error) {
    if (installedManifest) await rm(manifestPath, { force: true });
    if (movedPreviousManifest) await rename(previousManifestPath, manifestPath).catch(() => {});
    if (installedSlides) await rm(slidesRoot, { recursive: true, force: true });
    if (movedPreviousSlides) await rename(previousSlidesRoot, slidesRoot).catch(() => {});
    throw error;
  } finally {
    await Promise.all([
      rm(stagedSlidesRoot, { recursive: true, force: true }),
      rm(previousSlidesRoot, { recursive: true, force: true }),
      rm(stagedManifestPath, { force: true }),
      rm(previousManifestPath, { force: true }),
    ]);
  }
  return { title: project.title, slides };
}

/* The commit gate checks disk because that is what commitIfChanged will persist; writes stay inspectable. */
export async function assertCommittable() {
  const css = await readDeckCss();
  const canonicalCss = await formatDeckCss(defaultDeckCss);
  if (await formatDeckCss(css) !== canonicalCss) {
    const error = new Error("styles/deck.css is generated from the supported Tailwind utility registry and cannot be edited.");
    error.code = "WEAVE_TAILWIND_STYLESHEET";
    throw error;
  }
  const project = await readProject();
  const policy = auditContentPolicy({ css, html: project.slides.map((slide) => slide.html).join("\n") });
  if (!policy.ok) {
    const error = new Error(`Content policy gate failed: ${policy.summary.errors} error(s).`);
    error.code = "WEAVE_CONTENT_POLICY";
    error.diagnostics = policy.diagnostics;
    throw error;
  }
}

export function commitIfChanged(message) {
  runGit(["add", ".weave/deck.json", "slides", "styles", "AGENTS.md", ...(existsSync(assetsRoot) ? ["assets"] : []), ...(existsSync(templatesRoot) ? ["templates"] : [])]);
  if (!runGit(["diff", "--cached", "--name-only"])) return null;
  runGit(["-c", "user.name=Weave", "-c", "user.email=weave@localhost", "commit", "-m", message.slice(0, 180)]);
  return runGit(["rev-parse", "HEAD"]);
}

function commitPathsIfChanged(message, paths) {
  if (!paths.length) return null;
  runGit(["add", "--", ...paths]);
  const changed = runGit(["diff", "--cached", "--name-only", "--", ...paths]);
  if (!changed) return null;
  runGit(["-c", "user.name=Weave", "-c", "user.email=weave@localhost", "commit", "--only", "-m", message, "--", ...paths]);
  return getRevision();
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
      revision: getRevision(),
      clean: runGit(["status", "--porcelain"]) === "",
    },
  };
}

export async function checkoutHistory(commit) {
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error("Invalid history id.");
  if (runGit(["status", "--porcelain"])) throw new Error("Save the current changes before restoring history.");
  runGit(["cat-file", "-e", `${commit}^{commit}`]);
  if (runGit(["branch", "--show-current"]) !== "main") runGit(["checkout", "main"]);
  runGit(["restore", "--source", commit, "--staged", "--worktree", "--", ".weave/deck.json", "slides", "styles", "AGENTS.md"]);
  if (runGit(["ls-tree", "-d", "--name-only", commit, "assets"])) runGit(["restore", "--source", commit, "--staged", "--worktree", "--", "assets"]);
  if (runGit(["ls-tree", "-d", "--name-only", commit, "templates"])) runGit(["restore", "--source", commit, "--staged", "--worktree", "--", "templates"]);
  const restored = commitIfChanged(`Restore history ${commit.slice(0, 12)}`);
  return restored ?? getRevision();
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

export function discardVariation(branch) {
  if (!/^weave\/variation\/[a-z]+$/.test(branch)) return;
  if (runGit(["branch", "--show-current"]) === branch) {
    runGit(["restore", "--staged", "--worktree", "."]);
    runGit(["clean", "-fd", "--", ".weave", "slides", "styles"]);
    runGit(["checkout", "main"]);
  }
  if (getVariations().some((item) => item.branch === branch)) runGit(["branch", "-D", branch]);
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

async function recoverInterruptedTransactions() {
  const rootEntries = await readdir(projectRoot).catch(() => []);
  const previousSlides = rootEntries.filter((name) => /^\.slides-[\w-]+\.previous$/.test(name));
  const stagedSlides = rootEntries.filter((name) => /^\.slides-[\w-]+\.staged$/.test(name));
  const slidesExist = await access(slidesRoot).then(() => true).catch(() => false);
  if (!slidesExist && previousSlides[0]) await rename(join(projectRoot, previousSlides[0]), slidesRoot);
  await Promise.all([...previousSlides.slice(slidesExist ? 0 : 1), ...stagedSlides].map((name) =>
    rm(join(projectRoot, name), { recursive: true, force: true })));

  const weaveRoot = join(projectRoot, ".weave");
  const weaveEntries = await readdir(weaveRoot).catch(() => []);
  const previousDecks = weaveEntries.filter((name) => /^\.deck-[\w-]+\.previous$/.test(name));
  const stagedDecks = weaveEntries.filter((name) => /^\.deck-[\w-]+\.staged$/.test(name));
  const manifestExists = await access(manifestPath).then(() => true).catch(() => false);
  if (!manifestExists && previousDecks[0]) await rename(join(weaveRoot, previousDecks[0]), manifestPath);
  await Promise.all([...previousDecks.slice(manifestExists ? 0 : 1), ...stagedDecks].map((name) =>
    rm(join(weaveRoot, name), { force: true })));
}

/* One-time migration from the old token model: deck.json used to hold blocks + style tokens and
   slides/*.html were generated documents. Rebuild each slide as a `<main>` fragment (block text's
   literal newlines become <br>) and slim deck.json to a manifest. */
async function migrateLegacyDeck() {
  const raw = await readManifest();
  const isLegacy = raw && (raw.blocks !== undefined || (Array.isArray(raw.slides) && raw.slides.some((slide) => slide?.blocks !== undefined)));
  if (!isLegacy) return false;
  const blockSlides = (raw.slides ?? []).map((slide, index) => ({
    id: slide.id ?? `slide-${index + 1}`,
    title: slide.title ?? `Slide ${index + 1}`,
    notes: slide.notes ?? "",
    background: slide.background ?? "orbit",
    blocks: slide.blocks ?? [],
  }));
  const project = projectFromBlockSlides(raw.title ?? seedTitle, raw.accent ?? "#f6b84b", blockSlides);
  await writeProject(project);
  return true;
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
  await recoverInterruptedTransactions();
  await removeLegacyChatData();
  const migrationPaths = [];

  await mkdir(stylesRoot, { recursive: true });
  const canonicalCss = await formatDeckCss(defaultDeckCss);
  const existingCss = await readFile(deckCssPath, "utf8").catch(() => "");
  if (existingCss !== canonicalCss) {
    await writeFile(deckCssPath, canonicalCss);
    migrationPaths.push("styles/deck.css");
  }
  migrationPaths.push(...await ensureTemplates());

  let seededOrMigrated = false;
  try {
    await access(manifestPath);
    if (await migrateLegacyDeck()) {
      seededOrMigrated = true;
      migrationPaths.push(".weave/deck.json", "slides");
    }
  } catch {
    await writeProject(seedProject());
    seededOrMigrated = true;
    migrationPaths.push(".weave/deck.json", "slides");
  }

  const currentProject = await readProject();
  const tailwindProject = {
    ...currentProject,
    slides: currentProject.slides.map((slide) => ({ ...slide, html: migrateSlideHtmlToTailwind(slide.html) })),
  };
  if (tailwindProject.slides.some((slide, index) => slide.html !== currentProject.slides[index].html)) {
    await writeProject(tailwindProject);
    seededOrMigrated = true;
    migrationPaths.push("slides");
  }

  const instructions = `${agentInstructions}\n`;
  if (await readFile(join(projectRoot, "AGENTS.md"), "utf8").catch(() => null) !== instructions) {
    await writeFile(join(projectRoot, "AGENTS.md"), instructions);
    migrationPaths.push("AGENTS.md");
  }
  if (createdRepository) commitIfChanged("Create Northstar deck");
  else if (seededOrMigrated) commitIfChanged("Migrate Weave project to HTML source of truth");
  else commitPathsIfChanged("Migrate Weave project metadata", migrationPaths);
}
