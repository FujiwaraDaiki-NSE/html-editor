import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDeckCss, escapeHtml, slideFragmentFromBlocks } from "../shared/slide-design.mjs";
import { formatDeckCss, formatSlideHtml } from "../shared/html-format.mjs";
import { auditContentPolicy, auditHtmlSafety } from "../shared/content-policy.mjs";
import { defaultSlideClasses, migrateSlideHtmlToTailwind } from "../shared/tailwind-slide.mjs";
import { projectSlug } from "../shared/project-slug.mjs";
import { isReferencePath } from "../shared/context.mjs";
import { assetFilenamePattern, replaceAssetReferences } from "../shared/asset-path.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspacesRoot = process.env.WEAVE_WORKSPACES_ROOT ? resolve(process.env.WEAVE_WORKSPACES_ROOT) : join(repoRoot, "workspaces");
const archiveRoot = join(workspacesRoot, ".archive");
const currentPath = process.env.WEAVE_WORKSPACES_ROOT ? join(dirname(workspacesRoot), ".weave", "current.json") : join(repoRoot, ".weave", "current.json");
const assetApiBase = `http://127.0.0.1:${process.env.WEAVE_API_PORT ?? 4317}/api`;
let currentProjectRoot = process.env.WEAVE_PROJECT_ROOT ? resolve(process.env.WEAVE_PROJECT_ROOT) : join(workspacesRoot, "northstar");
export const projectRoot = () => currentProjectRoot;
const manifestPath = (root = currentProjectRoot) => join(root, ".weave", "deck.json");
const slidesRoot = (root = currentProjectRoot) => join(root, "slides");
const stylesRoot = (root = currentProjectRoot) => join(root, "styles");
const assetsRoot = (root = currentProjectRoot) => join(root, "assets");
export const referencesRoot = (root = currentProjectRoot) => join(root, "references");
export const templatesRoot = (root = currentProjectRoot) => join(root, "templates");
const deckCssPath = (root = currentProjectRoot) => join(stylesRoot(root), "deck.css");
const projectWriteQueues = new Map();

export async function runProjectExclusive(task, root = currentProjectRoot) {
  const previous = projectWriteQueues.get(root) ?? Promise.resolve();
  let release;
  const current = new Promise((resolvePromise) => { release = resolvePromise; });
  const queued = previous.then(() => current);
  projectWriteQueues.set(root, queued);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (projectWriteQueues.get(root) === queued) projectWriteQueues.delete(root);
  }
}

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

const reportFrameSvg = ({ id, path, lineStart }) => `<svg class="report-frame absolute inset-0 h-full w-full" data-weave-id="${id}-frame" viewBox="0 0 1280 720" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="${id}-gradient" x1="0%" x2="100%" y1="0%" y2="0%">
          <stop offset="0%" stop-color="#c2c2c2"></stop>
          <stop offset="55%" stop-color="#dcdcdc"></stop>
          <stop offset="100%" stop-color="#f3f3f3"></stop>
        </linearGradient>
      </defs>
      <path d="${path}" fill="url(#${id}-gradient)"></path>
      <line x1="${lineStart}" y1="69" x2="1280" y2="69" stroke="#e00000" stroke-width="2"></line>
      <line x1="${lineStart}" y1="662" x2="1280" y2="662" stroke="#004dff" stroke-width="2"></line>
    </svg>`;

const reportTemplate = ({ id, name, path, lineStart }) => ({
  id,
  name,
  filename: `${id}.html`,
  html: `<main class="${templateRootClasses({ id: "plain", background: "bg-white", text: "text-slate-950" })}" data-weave-slide data-weave-template="${id}" data-weave-template-name="${name}">
    ${reportFrameSvg({ id, path, lineStart })}
    <section class="hero flex flex-1 flex-col items-start justify-center gap-6" data-weave-slot="content">
      <h1 class="heading text-6xl font-semibold leading-none tracking-tight" data-weave-slot="title" data-weave-id="title"></h1>
    </section>
  </main>`,
});

const reportContentPath = "M0 0 L1280 0 C797.33 24 402.67 118 165.33 285 C76 348 24 392 0 416 Z";
const reportTitlePath = "M0 396 C232 150 757.33 22 1280 0 L1280 720 L0 720 Z";
const yearEndReportTemplate = reportTemplate({
  id: "year-end-report",
  name: "年度末報告 / 本文",
  path: reportContentPath,
  lineStart: 131,
});
const yearEndReportCoverTemplate = reportTemplate({
  id: "year-end-report-cover",
  name: "年度末報告 / 表紙",
  path: reportTitlePath,
  lineStart: 280,
});
const yearEndReportAgendaTemplate = reportTemplate({
  id: "year-end-report-agenda",
  name: "年度末報告 / 目次・章区切り",
  path: reportContentPath,
  lineStart: 186.67,
});

export const builtInTemplates = [...defaultTemplates, yearEndReportTemplate, yearEndReportCoverTemplate, yearEndReportAgendaTemplate];

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
If no file change is needed, respond with a concise explanation.

Files under references/ are materials brought in by a human through chat. Open and read the paths
provided in the envelope's attachments yourself. pptx, docx, and xlsx files are zip archives, so
extract them to read their XML. The references/index.json file is the catalogue of materials in the
project shelf; read it when you need to know what is available beyond this turn's attachments. If a
format cannot be read with the available tools, tell the human.`;

const assetTypes = new Map([
  ["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"],
  ["image/svg+xml", "svg"], ["image/gif", "gif"],
]);
export const assetMimeTypes = new Map([
  ["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"],
  ["webp", "image/webp"], ["svg", "image/svg+xml"], ["gif", "image/gif"],
]);
const maxAssetBytes = 10 * 1024 * 1024;
const maxReferenceBytes = 25 * 1024 * 1024;

function normalizeReferenceName(value) {
  const original = String(value ?? "");
  const extensionStart = original.lastIndexOf(".");
  const base = extensionStart > 0 ? original.slice(0, extensionStart) : original;
  const extension = extensionStart > 0 ? original.slice(extensionStart) : "";
  const normalizePart = (part) => part
    .replace(/[\\/]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/["']/g, "_")
    .replace(/\s/g, "_")
    .replace(/\.\./g, "_");
  const normalizedBase = normalizePart(base).replace(/\.+$/, "_");
  return `${normalizedBase || "file"}${normalizePart(extension)}`;
}

export async function importImageAsset({ data, mimeType }) {
  const root = currentProjectRoot;
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
  await mkdir(assetsRoot(root), { recursive: true });
  await writeFile(join(assetsRoot(root), filename), bytes);
  return { path: `assets/${filename}`, mimeType, size: bytes.length };
}

export async function importReference({ data, mimeType, name }) {
  return runProjectExclusive(async () => {
    const bytes = Buffer.from(String(data ?? ""), "base64");
    if (!bytes.length) throw new Error("Reference data is required.");
    if (bytes.length > maxReferenceBytes) throw new Error("Reference must be 25 MB or smaller.");
    const normalizedName = normalizeReferenceName(name);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const filename = `${hash.slice(0, 12)}-${normalizedName}`;
    const root = currentProjectRoot;
    const directory = referencesRoot(root);
    await mkdir(directory, { recursive: true });
    const filePath = join(directory, filename);
    if (!existsSync(filePath)) await writeFile(filePath, bytes);
    const indexPath = join(directory, "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8").catch(() => "{\"entries\":[]}"));
    const entries = Array.isArray(index?.entries) ? index.entries : [];
    const relativePath = `references/${filename}`;
    if (!entries.some((entry) => entry?.path === relativePath)) {
      entries.push({ path: relativePath, name: normalizedName, kind: "file", hash, size: bytes.length, mimeType, addedAt: new Date().toISOString() });
      await writeFile(indexPath, `${JSON.stringify({ entries }, null, 2)}\n`);
    }
    return { path: relativePath, name: normalizedName, kind: "file", mimeType, size: bytes.length };
  });
}

function pathInside(root, target) {
  const value = relative(root, target);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

const homePath = () => realpath(homedir());

export async function walkReferenceFolder(source, timeBudgetMs = 5_000) {
  const result = { files: 0, bytes: 0, capped: false };
  const startedAt = performance.now();
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (performance.now() - startedAt > timeBudgetMs) {
        result.capped = true;
        return;
      }
      if (entry.name.startsWith(".")) continue;
      const entryPath = join(directory, entry.name);
      const info = await lstat(entryPath);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await walk(entryPath);
        if (result.capped) return;
        continue;
      }
      if (!info.isFile()) continue;
      if (result.files + 1 > 2_000 || result.bytes + info.size > 500 * 1024 * 1024) {
        result.capped = true;
        return;
      }
      result.files += 1;
      result.bytes += info.size;
    }
  };
  await walk(source);
  return result;
}

async function referenceFolderSource(source) {
  const requested = resolve(String(source ?? ""));
  let originalInfo;
  try {
    originalInfo = await lstat(requested);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Invalid folder: it does not exist.");
    throw error;
  }
  if (originalInfo.isSymbolicLink()) throw new Error("Invalid reference folder: it must be a real directory.");
  const home = await homePath();
  let resolved;
  try {
    resolved = await realpath(requested);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Invalid folder: it does not exist.");
    throw error;
  }
  if (!pathInside(home, resolved)) throw new Error("Invalid folder: it must be inside the home directory.");
  if (!originalInfo.isDirectory()) throw new Error("Invalid reference folder: it must be a directory.");
  return resolved;
}

export async function listFolders(path = homedir()) {
  const source = await referenceFolderSource(path);
  const home = await homePath();
  const relativePath = relative(home, source);
  const parts = relativePath ? relativePath.split("/") : [];
  const breadcrumbs = [{ name: "Home", path: home }];
  parts.forEach((part, index) => breadcrumbs.push({ name: part, path: join(home, ...parts.slice(0, index + 1)) }));
  const directEntries = await readdir(source, { withFileTypes: true });
  const visibleEntries = directEntries.filter((entry) => !entry.name.startsWith(".") && !entry.isSymbolicLink());
  const folders = visibleEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: join(source, entry.name) }));
  return {
    path: source,
    parent: source === home ? null : dirname(source),
    breadcrumbs,
    folders,
    folderCount: folders.length,
    fileCount: visibleEntries.filter((entry) => entry.isFile()).length,
  };
}

export async function importReferenceFolder({ source }) {
  return runProjectExclusive(async () => {
    const resolved = await referenceFolderSource(source);
    const summary = await walkReferenceFolder(resolved);
    if (summary.capped) throw new Error("Reference folder is too large or too slow to read and exceeds the limit (2,000 files / 500 MB).");
    const directory = referencesRoot();
    await mkdir(directory, { recursive: true });
    const indexPath = join(directory, "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8").catch(() => "{\"entries\":[]}"));
    const entries = Array.isArray(index.entries) ? index.entries : [];
    if (entries.some((entry) => entry?.kind === "folder" && entry.source === resolved)) {
      throw new Error("Reference folder already exists; use Update to refresh it.");
    }
    const baseName = normalizeReferenceName(basename(resolved));
    let name = baseName;
    let number = 2;
    while (existsSync(join(directory, name))) name = `${baseName}-${number++}`;
    await copyReferenceFolder(resolved, join(directory, name));
    const entry = { path: `references/${name}`, name, kind: "folder", source: resolved, size: summary.bytes, files: summary.files, addedAt: new Date().toISOString() };
    entries.push(entry);
    await writeFile(indexPath, `${JSON.stringify({ entries }, null, 2)}\n`);
    return entry;
  });
}

async function copyReferenceFolder(source, destination) {
  await cp(source, destination, {
    recursive: true,
    filter: async (entryPath) => {
      const entryName = basename(entryPath);
      if (entryName.startsWith(".")) return false;
      return !(await lstat(entryPath)).isSymbolicLink();
    },
  });
}

export async function syncReferenceFolder(path) {
  return runProjectExclusive(async () => {
    if (!isReferencePath(path)) throw new Error("Invalid reference path.");
    const indexPath = join(referencesRoot(), "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    const entry = index.entries?.find((item) => item?.path === path && item.kind === "folder");
    if (!entry) throw new Error("Reference folder not found.");
    if (!existsSync(entry.source)) return { references: await readReferences(), sourceMissing: true };
    const source = await referenceFolderSource(entry.source);
    const summary = await walkReferenceFolder(source);
    if (summary.capped) throw new Error("Reference folder is too large or too slow to read and exceeds the limit (2,000 files / 500 MB).");
    const destination = join(projectRoot(), path);
    const staged = `${destination}.${randomUUID()}.staged`;
    const previous = `${destination}.${randomUUID()}.previous`;
    try {
      await copyReferenceFolder(source, staged);
      if (existsSync(destination)) await rename(destination, previous);
      await rename(staged, destination);
      await rm(previous, { recursive: true, force: true });
    } catch (error) {
      await rm(staged, { recursive: true, force: true });
      if (existsSync(previous) && !existsSync(destination)) await rename(previous, destination);
      throw error;
    }
    entry.size = summary.bytes;
    entry.files = summary.files;
    await writeFile(indexPath, `${JSON.stringify({ entries: index.entries }, null, 2)}\n`);
    return { references: await readReferences(), sourceMissing: false };
  });
}

export async function readReferences() {
  const indexPath = join(referencesRoot(), "index.json");
  let index;
  try {
    index = JSON.parse(await readFile(indexPath, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(index?.entries)) return [];
  return index.entries
    .filter((entry) => entry && typeof entry.path === "string")
    .map((entry) => ({ ...entry, kind: entry.kind === "folder" ? "folder" : "file", missing: !existsSync(join(projectRoot(), entry.path)), ...(entry.kind === "folder" && entry.source ? { sourceMissing: !existsSync(entry.source) } : {}) }));
}

export async function removeReference(path) {
  if (!isReferencePath(path)) throw new Error("Invalid reference path.");
  return runProjectExclusive(async () => {
    const indexPath = join(referencesRoot(), "index.json");
    let index;
    try {
      index = JSON.parse(await readFile(indexPath, "utf8"));
    } catch {
      return [];
    }
    if (!Array.isArray(index?.entries)) return [];
    const entries = index.entries.filter((entry) => entry?.path !== path);
    if (entries.length !== index.entries.length) await writeFile(indexPath, `${JSON.stringify({ entries }, null, 2)}\n`);
    await rm(join(projectRoot(), path), { recursive: true, force: true });
    return readReferences();
  });
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
    cwd: currentProjectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

export function getRevision(root = currentProjectRoot) {
  try {
    return runGit(["rev-parse", "HEAD"], { cwd: root });
  } catch {
    return null;
  }
}

export function assertRevision(expectedRevision, root = currentProjectRoot) {
  if (expectedRevision == null) return;
  const actualRevision = getRevision(root);
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
export async function readDeckCss(root = currentProjectRoot) {
  try {
    return await readFile(deckCssPath(root), "utf8");
  } catch {
    return defaultDeckCss;
  }
}

const templateAttribute = (opening, name) => opening.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i"))?.slice(1).find((value) => value !== undefined)?.trim() ?? "";

export async function readTemplates(root = currentProjectRoot) {
  const entries = await readdir(templatesRoot(root), { withFileTypes: true }).catch(() => []);
  const templates = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".html")).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const html = await readFile(join(templatesRoot(root), entry.name), "utf8");
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

export async function ensureTemplates(root = currentProjectRoot) {
  await mkdir(templatesRoot(root), { recursive: true });
  const canonical = await Promise.all(builtInTemplates.map(async (template) => ({
    ...template,
    html: await formatSlideHtml(template.html),
  })));
  const touched = [];
  for (const template of canonical) {
    const path = join(templatesRoot(root), template.filename);
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

async function readSlideHtml(id, root = currentProjectRoot) {
  try {
    return await readFile(join(slidesRoot(root), `${id}.html`), "utf8");
  } catch {
    return "";
  }
}

async function readManifest(root = currentProjectRoot) {
  try {
    return JSON.parse(await readFile(manifestPath(root), "utf8"));
  } catch {
    return null;
  }
}

/** The project as the editor loads it: manifest joined with each slide's HTML fragment. */
export async function readProject(root = currentProjectRoot) {
  const manifest = await readManifest(root);
  if (!manifest || !Array.isArray(manifest.slides)) return seedProject();
  const slides = await Promise.all(manifest.slides.map(async (slide, index) => ({
    id: slide.id,
    title: String(slide.title ?? `Slide ${index + 1}`),
    notes: String(slide.notes ?? ""),
    html: await readSlideHtml(slide.id, root),
  })));
  return { title: String(manifest.title ?? seedTitle), slides };
}

/** Write the project: every slide file (formatted) plus the manifest, transactionally. */
async function writeProjectUnlocked(input, expectedRevision = null, root = currentProjectRoot) {
  const project = validateProject(input);
  const slides = await Promise.all(project.slides.map(async (slide) => ({
    ...slide,
    html: await formatSlideHtml(slide.html),
  })));
  const manifest = { title: project.title, slides: slides.map(({ id, title, notes }) => ({ id, title, notes })) };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;

  await mkdir(join(root, ".weave"), { recursive: true });
  assertRevision(expectedRevision, root);

  const transactionId = randomUUID();
  const stagedSlidesRoot = join(root, `.slides-${transactionId}.staged`);
  const previousSlidesRoot = join(root, `.slides-${transactionId}.previous`);
  const stagedManifestPath = join(root, ".weave", `.deck-${transactionId}.staged`);
  const previousManifestPath = join(root, ".weave", `.deck-${transactionId}.previous`);
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
    assertRevision(expectedRevision, root);
    try {
      await rename(slidesRoot(root), previousSlidesRoot);
      movedPreviousSlides = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rename(stagedSlidesRoot, slidesRoot(root));
    installedSlides = true;
    try {
      await rename(manifestPath(root), previousManifestPath);
      movedPreviousManifest = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rename(stagedManifestPath, manifestPath(root));
    installedManifest = true;
    await Promise.all([
      rm(previousSlidesRoot, { recursive: true, force: true }),
      rm(previousManifestPath, { force: true }),
    ]);
  } catch (error) {
    if (installedManifest) await rm(manifestPath(root), { force: true });
    if (movedPreviousManifest) await rename(previousManifestPath, manifestPath(root)).catch(() => {});
    if (installedSlides) await rm(slidesRoot(root), { recursive: true, force: true });
    if (movedPreviousSlides) await rename(previousSlidesRoot, slidesRoot(root)).catch(() => {});
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

export async function writeProject(input, expectedRevision = null) {
  const root = currentProjectRoot;
  return await runProjectExclusive(
    () => writeProjectUnlocked(input, expectedRevision, root),
    root,
  );
}

export async function saveProject(input, expectedRevision, message) {
  const root = currentProjectRoot;
  return await runProjectExclusive(async () => {
    const deck = await writeProjectUnlocked(input, expectedRevision, root);
    await assertCommittable(root);
    const commit = commitIfChanged(message ?? `Save: ${deck.title}`, root);
    return { deck, commit };
  }, root);
}

/* The commit gate checks disk because that is what commitIfChanged will persist; writes stay inspectable. */
export async function assertCommittable(root = currentProjectRoot) {
  const css = await readDeckCss(root);
  const canonicalCss = await formatDeckCss(defaultDeckCss);
  if (await formatDeckCss(css) !== canonicalCss) {
    const error = new Error("styles/deck.css is generated from the supported Tailwind utility registry and cannot be edited.");
    error.code = "WEAVE_TAILWIND_STYLESHEET";
    throw error;
  }
  const project = await readProject(root);
  const policy = auditContentPolicy({ css, html: project.slides.map((slide) => slide.html).join("\n") });
  if (!policy.ok) {
    const error = new Error(`Content policy gate failed: ${policy.summary.errors} error(s).`);
    error.code = "WEAVE_CONTENT_POLICY";
    error.diagnostics = policy.diagnostics;
    throw error;
  }
}

/* Clean checks cover only what Weave commits; status accepts missing pathspecs, while add does not. */
/* Keep optional paths in status so a tracked-but-deleted assets or templates directory remains dirty. */
const managedPaths = [".weave/deck.json", "slides", "styles", "AGENTS.md", "assets", "templates", "references/index.json"];

function managedStatus(root = currentProjectRoot) {
  return runGit(["status", "--porcelain", "--", ...managedPaths], { cwd: root });
}

export function commitIfChanged(message, root = currentProjectRoot) {
  const pathsToAdd = managedPaths
    .filter((path) => path !== "assets" && path !== "templates" && path !== "references/index.json")
    .concat(existsSync(assetsRoot(root)) ? ["assets"] : [], existsSync(templatesRoot(root)) ? ["templates"] : [], existsSync(join(referencesRoot(root), "index.json")) ? ["references/index.json"] : []);
  runGit(["add", ...pathsToAdd], { cwd: root });
  if (!runGit(["diff", "--cached", "--name-only"], { cwd: root })) return null;
  runGit(["-c", "user.name=Weave", "-c", "user.email=weave@localhost", "commit", "-m", message.slice(0, 180)], { cwd: root });
  return runGit(["rev-parse", "HEAD"], { cwd: root });
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
      root: currentProjectRoot,
      slug: currentProjectRoot.startsWith(`${workspacesRoot}/`) ? currentProjectRoot.slice(workspacesRoot.length + 1) : null,
      branch: runGit(["branch", "--show-current"]) || "detached",
      commit: runGit(["rev-parse", "--short", "HEAD"]),
      revision: getRevision(),
      clean: managedStatus() === "",
    },
  };
}

export async function checkoutHistory(commit) {
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error("Invalid history id.");
  if (managedStatus()) throw new Error("Save the current changes before restoring history.");
  runGit(["cat-file", "-e", `${commit}^{commit}`]);
  if (runGit(["branch", "--show-current"]) !== "main") runGit(["checkout", "main"]);
  runGit(["restore", "--source", commit, "--staged", "--worktree", "--", ".weave/deck.json", "slides", "styles", "AGENTS.md"]);
  for (const path of ["assets", "templates"]) {
    if (runGit(["ls-tree", "-d", "--name-only", commit, path])) {
      runGit(["restore", "--source", commit, "--staged", "--worktree", "--", path]);
    } else {
      await rm(join(currentProjectRoot, path), { recursive: true, force: true });
      if (runGit(["ls-files", "--", path])) runGit(["add", "-A", "--", path]);
    }
  }
  const restored = commitIfChanged(`Restore history ${commit.slice(0, 12)}`);
  return restored ?? getRevision();
}

export function checkoutMain() {
  if (managedStatus()) throw new Error("Save the current changes before returning to the latest version.");
  runGit(["checkout", "main"]);
}

export function checkoutVariation(branch) {
  if (managedStatus()) throw new Error("Save current changes before switching directions.");
  const allowed = branch === "main" || getVariations().some((item) => item.branch === branch);
  if (!allowed) throw new Error("Unknown direction.");
  runGit(["checkout", branch]);
}

export function createVariationBranch() {
  if (managedStatus()) throw new Error("Save current changes before creating a direction.");
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
  if (managedStatus()) throw new Error("The current direction has uncommitted changes.");
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
  if (managedStatus()) throw new Error("The current direction has uncommitted changes.");
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
  await rm(join(currentProjectRoot, ".weave", "chat.json"), { force: true });
  const excludePath = join(currentProjectRoot, ".git", "info", "exclude");
  try {
    const current = await readFile(excludePath, "utf8");
    const next = current.split("\n").filter((line) => line.trim() !== ".weave/chat.json").join("\n");
    if (next !== current) await writeFile(excludePath, next);
  } catch {
    // A repository created below has no exclude file yet.
  }
}

async function recoverInterruptedTransactions() {
  const rootEntries = await readdir(currentProjectRoot).catch(() => []);
  const previousSlides = rootEntries.filter((name) => /^\.slides-[\w-]+\.previous$/.test(name));
  const stagedSlides = rootEntries.filter((name) => /^\.slides-[\w-]+\.staged$/.test(name));
  const slidesExist = await access(slidesRoot()).then(() => true).catch(() => false);
  if (!slidesExist && previousSlides[0]) await rename(join(currentProjectRoot, previousSlides[0]), slidesRoot());
  await Promise.all([...previousSlides.slice(slidesExist ? 0 : 1), ...stagedSlides].map((name) =>
    rm(join(currentProjectRoot, name), { recursive: true, force: true })));

  const weaveRoot = join(currentProjectRoot, ".weave");
  const weaveEntries = await readdir(weaveRoot).catch(() => []);
  const previousDecks = weaveEntries.filter((name) => /^\.deck-[\w-]+\.previous$/.test(name));
  const stagedDecks = weaveEntries.filter((name) => /^\.deck-[\w-]+\.staged$/.test(name));
  const manifestExists = await access(manifestPath()).then(() => true).catch(() => false);
  if (!manifestExists && previousDecks[0]) await rename(join(weaveRoot, previousDecks[0]), manifestPath());
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

async function ensureProjectScaffolding(root = currentProjectRoot) {
  const migrationPaths = [];
  await mkdir(stylesRoot(root), { recursive: true });
  const canonicalCss = await formatDeckCss(defaultDeckCss);
  const existingCss = await readFile(deckCssPath(root), "utf8").catch(() => "");
  if (existingCss !== canonicalCss) {
    await writeFile(deckCssPath(root), canonicalCss);
    migrationPaths.push("styles/deck.css");
  }
  migrationPaths.push(...await ensureTemplates(root));
  const instructions = `${agentInstructions}\n`;
  if (await readFile(join(root, "AGENTS.md"), "utf8").catch(() => null) !== instructions) {
    await writeFile(join(root, "AGENTS.md"), instructions);
    migrationPaths.push("AGENTS.md");
  }
  return migrationPaths;
}

export async function ensureProject() {
  await mkdir(currentProjectRoot, { recursive: true });
  let createdRepository = false;
  try {
    await access(join(currentProjectRoot, ".git"));
  } catch {
    runGit(["init", "-b", "main"]);
    createdRepository = true;
  }
  await recoverInterruptedTransactions();
  await removeLegacyChatData();
  const migrationPaths = await ensureProjectScaffolding();
  let seededOrMigrated = false;
  try {
    await access(manifestPath());
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

  if (createdRepository) commitIfChanged("Create Northstar deck");
  else if (seededOrMigrated) commitIfChanged("Migrate Weave project to HTML source of truth");
  else commitPathsIfChanged("Migrate Weave project metadata", migrationPaths);
}

const slugPattern = /^[a-z0-9-]+$/;
function assertSlug(slug) {
  if (!slugPattern.test(String(slug ?? ""))) throw new Error("Invalid project id.");
  return slug;
}

export function assertAssetFilename(filename) {
  if (!assetFilenamePattern.test(String(filename ?? ""))) throw new Error("Asset not found.");
  return filename;
}

export function projectAssetPath(slug, filename) {
  return join(workspacesRoot, assertSlug(slug), "assets", assertAssetFilename(filename));
}

const rewriteThumbnailAssets = (html, slug) => replaceAssetReferences(html, (path) => `${assetApiBase}/projects/${slug}/${path}`);

function generatedSlug(title) {
  return projectSlug(title);
}

async function projectExists(slug, root = workspacesRoot) {
  return await access(join(root, slug, ".weave", "deck.json")).then(() => true).catch(() => false);
}

async function uniqueSlug(title) {
  const base = generatedSlug(title);
  let slug = base;
  let index = 2;
  while (await access(join(workspacesRoot, slug)).then(() => true).catch(() => false) || await access(join(archiveRoot, slug)).then(() => true).catch(() => false)) slug = `${base}-${index++}`;
  return slug;
}

function gitAt(root, args) {
  return runGit(args, { cwd: root });
}

function slugOf(root) {
  return root.startsWith(`${workspacesRoot}/`) ? root.slice(workspacesRoot.length + 1) : null;
}

async function persistCurrentProject() {
  if (process.env.WEAVE_PROJECT_ROOT) return;
  await mkdir(dirname(currentPath), { recursive: true });
  await writeFile(currentPath, `${JSON.stringify({ slug: slugOf(currentProjectRoot) }, null, 2)}\n`);
}

export async function assertSwitchable(targetSlug = null) {
  if (managedStatus()) throw Object.assign(new Error("The current project has uncommitted changes."), { code: "WEAVE_PROJECT_DIRTY" });
  if (getVariations().length) throw Object.assign(new Error("Current project has open proposal branches."), { code: "WEAVE_PROJECT_BLOCKED" });
  if (targetSlug) {
    const target = join(workspacesRoot, assertSlug(targetSlug));
    if (await projectExists(targetSlug)) {
      let targetVariations = [];
      try { targetVariations = gitAt(target, ["for-each-ref", "--format=%(refname:short)", "refs/heads/weave/variation"]).split("\n").filter(Boolean); } catch {}
      if (targetVariations.length) throw Object.assign(new Error(`Target project has ${targetVariations.length} open proposal branches.`), { code: "WEAVE_PROJECT_BLOCKED" });
    }
  }
  if (runGit(["branch", "--show-current"]) === "") checkoutMain();
}

async function createProjectUnlocked({ title, template = "orbit" }) {
  const name = String(title ?? "").trim();
  if (!name) throw new Error("Title is required.");
  await mkdir(workspacesRoot, { recursive: true });
  const base = generatedSlug(name);
  let slug = base;
  let root;
  for (let index = 2; ; index += 1) {
    root = join(workspacesRoot, slug);
    try {
      await mkdir(root);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      slug = `${base}-${index}`;
    }
  }
  const selected = builtInTemplates.find((item) => item.id === template) ?? builtInTemplates[0];
  const cover = {
    id: "cover",
    title: name,
    notes: "",
    html: selected.html.replace(
      /(<h1\b[^>]*>)[\s\S]*?(<\/h1>)/i,
      (_match, opening, closing) => `${opening}${escapeHtml(name)}${closing}`,
    ),
  };
  try {
    gitAt(root, ["init", "-b", "main"]);
    await writeProjectUnlocked({ title: name, slides: [cover] }, null, root);
    await ensureProjectScaffolding(root);
    commitIfChanged("Create project", root);
    return slug;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function createProject(options) {
  return await runProjectExclusive(() => createProjectUnlocked(options), workspacesRoot);
}

export async function initializeCurrentProject() {
  if (process.env.WEAVE_PROJECT_ROOT) return;
  let recorded = null;
  try { recorded = JSON.parse(await readFile(currentPath, "utf8")).slug; } catch {}
  if (recorded && slugPattern.test(recorded) && await projectExists(recorded)) currentProjectRoot = join(workspacesRoot, recorded);
  else {
    const projects = await listProjects();
    if (projects[0]) currentProjectRoot = join(workspacesRoot, projects[0].slug);
  }
}

export async function listProjects() {
  const entries = await readdir(workspacesRoot, { withFileTypes: true }).catch(() => []);
  const projects = await Promise.all(entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map(async (entry) => {
    const root = join(workspacesRoot, entry.name);
    try {
      const manifest = JSON.parse(await readFile(join(root, ".weave", "deck.json"), "utf8"));
      const slides = Array.isArray(manifest.slides) ? manifest.slides : [];
      const first = slides[0]?.id;
      let variations = [];
      let updatedAt = null;
      try {
        variations = gitAt(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/weave/variation"]).split("\n").filter(Boolean);
        updatedAt = gitAt(root, ["log", "-1", "--pretty=%cI"]) || null;
      } catch {}
      const thumbnailHtml = first ? await readFile(join(root, "slides", `${first}.html`), "utf8").catch(() => "") : "";
      return { slug: entry.name, title: String(manifest.title ?? ""), slideCount: slides.length, updatedAt, current: root === currentProjectRoot, blocked: variations.length > 0, blockedCount: variations.length, thumbnailHtml: rewriteThumbnailAssets(thumbnailHtml, entry.name), css: await readFile(join(root, "styles", "deck.css"), "utf8").catch(() => defaultDeckCss) };
    } catch { return null; }
  }));
  return projects.filter(Boolean).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

export async function renameProject(slug, title) {
  assertSlug(slug);
  const root = join(workspacesRoot, slug);
  if (!await projectExists(slug)) throw new Error("Project not found.");
  const path = join(root, ".weave", "deck.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.title = String(title ?? "").trim();
  if (!manifest.title) throw new Error("Title is required.");
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  gitAt(root, ["add", "--", ".weave/deck.json"]);
  if (!gitAt(root, ["diff", "--cached", "--name-only", "--", ".weave/deck.json"])) return null;
  gitAt(root, ["-c", "user.name=Weave", "-c", "user.email=weave@localhost", "commit", "--only", "-m", "Rename project", "--", ".weave/deck.json"]);
  return gitAt(root, ["rev-parse", "HEAD"]);
}

export async function duplicateProject(slug) {
  assertSlug(slug);
  const source = join(workspacesRoot, slug);
  if (!await projectExists(slug)) throw new Error("Project not found.");
  const sourceManifest = JSON.parse(await readFile(join(source, ".weave", "deck.json"), "utf8"));
  const next = await uniqueSlug(`${sourceManifest.title} のコピー`);
  const target = join(workspacesRoot, next);
  const sourceReferences = resolve(referencesRoot(source));
  const sourceReferencesIndex = join(sourceReferences, "index.json");
  await cp(source, target, { recursive: true, filter: (path) => {
    if (path.split("/").includes(".git") || /\.slides-[^/]+\.(staged|previous)$/.test(path)) return false;
    const absolutePath = resolve(path);
    if (absolutePath === sourceReferences || !absolutePath.startsWith(`${sourceReferences}/`)) return true;
    return absolutePath === sourceReferencesIndex;
  } });
  const manifestPathCopy = join(target, ".weave", "deck.json");
  sourceManifest.title = `${sourceManifest.title} のコピー`;
  await writeFile(manifestPathCopy, `${JSON.stringify(sourceManifest, null, 2)}\n`);
  gitAt(target, ["init", "-b", "main"]);
  gitAt(target, ["add", "."]);
  gitAt(target, ["-c", "user.name=Weave", "-c", "user.email=weave@localhost", "commit", "-m", "Create project"]);
  return next;
}

export async function archiveProject(slug) {
  assertSlug(slug);
  if (join(workspacesRoot, slug) === currentProjectRoot) throw new Error("The current project cannot be archived.");
  const source = join(workspacesRoot, slug);
  if (!await projectExists(slug)) throw new Error("Project not found.");
  await mkdir(archiveRoot, { recursive: true });
  let target = join(archiveRoot, slug);
  let index = 2;
  while (await access(target).then(() => true).catch(() => false)) target = join(archiveRoot, `${slug}-${index++}`);
  await rename(source, target);
}

export async function switchProject(slug) {
  assertSlug(slug);
  const target = join(workspacesRoot, slug);
  if (!await projectExists(slug)) throw new Error("Project not found.");
  await assertSwitchable(slug);
  currentProjectRoot = target;
  await persistCurrentProject();
  return target;
}
