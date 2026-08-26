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
import { composeSlideHtml, extractLayoutSnapshotHtml, extractSlideSourceHtml, hasLegacyFurnitureOutsideContent } from "../shared/slide-slots.mjs";

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

const contentLayout = ({ titleClass = "text-6xl", sectionClass = "hero flex flex-1 flex-col items-start justify-center gap-6" } = {}) => `<section class="${sectionClass}" data-weave-slot="content">
      <h1 class="heading ${titleClass} font-semibold leading-none tracking-tight" data-weave-slot="title" data-weave-id="title"></h1>
    </section>`;

const templatePackage = ({ id, name, background, text, layouts, defaultFurniture = true }) => ({
  id,
  name,
  defaultLayoutId: layouts[0].id,
  masterHtml: `<main class="${templateRootClasses({ id: id === "year-end-report" ? "plain" : id, background, text })}" data-weave-slide data-weave-template="${id}" data-weave-template-name="${name}">
    ${defaultFurniture ? '<div class="brand flex items-center gap-2 text-xs font-bold tracking-widest text-slate-400">WEAVE<span class="text-amber-400">●</span></div>' : ""}
    <div data-weave-layout-slot></div>
    ${defaultFurniture ? '<div class="page-number absolute top-0 right-0 p-8 text-xs font-semibold tracking-widest text-slate-400">01 / 01</div>' : ""}
  </main>`,
  layouts,
});

const defaultTemplates = templateThemes.map((theme) => templatePackage({
  id: theme.id,
  name: theme.name,
  ...theme,
  layouts: [{ id: "content", name: "Content", html: contentLayout() }],
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

const reportLayout = ({ id, name, titleClass = "text-6xl", sectionClass } = {}) => ({ id, name, html: contentLayout({ titleClass, sectionClass }) });

const reportContentPath = "M0 0 L1280 0 C797.33 24 402.67 118 165.33 285 C76 348 24 392 0 416 Z";
const reportTitlePath = "M0 396 C232 150 757.33 22 1280 0 L1280 720 L0 720 Z";
const reportLogoAssetFilename = "9442acd1fa8abd6f7e4eeac678dad653a43d2d63663c45c1c09775bbc0dcf0ee.png";
const yearEndReportTemplate = templatePackage({
  id: "year-end-report",
  name: "年度末報告",
  background: "bg-white",
  text: "text-slate-950",
  layouts: [
    { ...reportLayout({ id: "cover", name: "表紙", titleClass: "text-6xl" }), html: `${reportFrameSvg({ id: "year-end-report-cover", path: reportTitlePath, lineStart: 280 })}<img class="report-logo" data-weave-id="year-end-report-cover-logo" src="assets/${reportLogoAssetFilename}" alt="NIPPON STEEL ENGINEERING">${contentLayout({ sectionClass: "hero flex flex-1 flex-col items-start justify-end gap-3" })}` },
    { ...reportLayout({ id: "content", name: "本文", titleClass: "text-6xl" }), html: `${reportFrameSvg({ id: "year-end-report", path: reportContentPath, lineStart: 131 })}${contentLayout({ sectionClass: "hero flex flex-1 flex-col items-start justify-center gap-6" })}` },
    { ...reportLayout({ id: "agenda", name: "目次・章区切り", titleClass: "text-6xl" }), html: `${reportFrameSvg({ id: "year-end-report-agenda", path: reportContentPath, lineStart: 186.67 })}${contentLayout({ sectionClass: "hero flex flex-1 flex-col items-start justify-center gap-6" })}` },
  ],
  defaultFurniture: false,
});

/* These are kept as distinct layout geometry in the package. The report master owns the
   common frame and each layout owns only its slot arrangement; all three share one template. */
export const builtInTemplates = [...defaultTemplates, yearEndReportTemplate];

export const agentInstructions = `You are the editing agent embedded in Weave, a visual HTML slide editor.
The truth of every slide is its own file: slides/<id>.html holds only the editable source slots.
Its .weave/deck.json entry carries templateId, layoutId, title, notes, and accent. The rendered
slide is composed at read time from templates/<template-id>/master.html, the selected
templates/<template-id>/layouts/<layout-id>.html, and the slide source. Never copy inherited
master or layout furniture into a slide source. styles/deck.css is generated and read-only. Do not
generate or hand-maintain any intermediate model; .weave/deck.json is the manifest of slide order,
template/layout references, titles, notes, and accents (Weave keeps it in sync).
Every template has template.json, one master.html, and one or more named layouts. A template is
the reusable design package; a layout is its purpose-specific arrangement (cover, content, agenda).
Every layout has data-weave-slot="title" and data-weave-slot="content"; the title slot's text is
the slide name. Master/layout files are shared and must be edited intentionally because their next
render changes every slide that references them. Ordinary slide edits may change only source
elements and slot contents. Unknown template or layout identifiers are invalid; do not invent or
silently substitute another design.
Templates supply typography by inheritance, so ordinary blocks omit color and font size unless they mean to
differ. Kind-identity sizes such as eyebrow and note, and accent colors, stay explicit.
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

/* Seed content, authored as blocks and stamped into source HTML exactly once. After seeding
   the source on disk is the truth; blocks are never consulted again at runtime. */
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

/* Build the seed/migration project with explicit Template/Layout references from block data. */
function projectFromBlockSlides(title, accent, blockSlides) {
  const total = blockSlides.length;
  return {
    title,
    defaultTemplateId: "orbit",
    slides: blockSlides.map((slide, index) => {
      const templateId = slide.templateId ?? (slide.background === "grid" ? "grid" : slide.background === "plain" ? "plain" : "orbit");
      const layoutId = slide.layoutId ?? "content";
      const slideHtml = slideFragmentFromBlocks({
        blocks: slide.blocks,
        background: slide.background ?? "orbit",
        accent: accent ?? "#f6b84b",
        total,
        position: index + 1,
      }).replace(/(<section\b)/i, '$1 data-weave-slot="content"').replace(/(<h1\b)/i, '$1 data-weave-slot="title"');
      return {
        id: slide.id,
        title: slide.title ?? `Slide ${index + 1}`,
        notes: slide.notes ?? "",
        templateId,
        layoutId,
        accent: accent ?? "#f6b84b",
        html: sourceFromRendered(slideHtml, { templateId, layoutId, accent: accent ?? "#f6b84b" }),
      };
    }),
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

export async function readTemplates(root = currentProjectRoot) {
  const entries = await readdir(templatesRoot(root), { withFileTypes: true }).catch(() => []);
  const templates = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const rootPath = join(templatesRoot(root), entry.name);
      const manifest = JSON.parse(await readFile(join(rootPath, "template.json"), "utf8"));
      const id = String(manifest.id ?? "");
      const name = String(manifest.name ?? "");
      const defaultLayoutId = String(manifest.defaultLayoutId ?? "");
      if (!id || !name || !defaultLayoutId || id !== entry.name) continue;
      const masterHtml = await readFile(join(rootPath, "master.html"), "utf8");
      const layoutEntries = await readdir(join(rootPath, "layouts"), { withFileTypes: true });
      const filesById = new Map(layoutEntries.filter((item) => item.isFile() && item.name.endsWith(".html")).map((item) => [item.name.slice(0, -".html".length), item]));
      const declaredLayouts = Array.isArray(manifest.layouts) ? manifest.layouts : [];
      const layoutIds = [...declaredLayouts.map((item) => String(item?.id ?? "")).filter(Boolean), ...[...filesById.keys()].filter((id) => !declaredLayouts.some((item) => item?.id === id)).sort()];
      const layouts = [];
      for (const layoutId of layoutIds) {
        const layoutEntry = filesById.get(layoutId);
        if (!layoutEntry) continue;
        const layoutHtml = await readFile(join(rootPath, "layouts", layoutEntry.name), "utf8");
        const layoutName = String(declaredLayouts.find((item) => item?.id === layoutId)?.name ?? layoutId);
        layouts.push({ id: layoutId, name: layoutName, html: layoutHtml });
      }
      if (!layouts.some((layout) => layout.id === defaultLayoutId)) continue;
      const policy = auditContentPolicy({ html: [masterHtml, ...layouts.map((layout) => layout.html)].join("\n") });
      if (!policy.ok) continue;
      templates.push({ id, name, defaultLayoutId, masterHtml, layouts });
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
    masterHtml: await formatSlideHtml(template.masterHtml),
    layouts: await Promise.all(template.layouts.map(async (layout) => ({ ...layout, html: await formatSlideHtml(layout.html) }))),
  })));
  const touched = [];
  for (const template of canonical) {
    const path = join(templatesRoot(root), template.id);
    await mkdir(join(path, "layouts"), { recursive: true });
    const manifest = `${JSON.stringify({ id: template.id, name: template.name, defaultLayoutId: template.defaultLayoutId, layouts: template.layouts.map(({ id, name }) => ({ id, name })) }, null, 2)}\n`;
    const files = [
      [join(path, "template.json"), manifest],
      [join(path, "master.html"), template.masterHtml],
      ...template.layouts.map((layout) => [join(path, "layouts", `${layout.id}.html`), layout.html]),
    ];
    for (const [filePath, content] of files) {
      if (existsSync(filePath)) continue;
      await writeFile(filePath, content);
      touched.push(filePath.slice(root.length + 1));
    }
  }
  const logoSource = join(repoRoot, "shared", "assets", reportLogoAssetFilename);
  const logoDestination = join(assetsRoot(root), reportLogoAssetFilename);
  const logoBytes = await readFile(logoSource);
  const existingLogo = await readFile(logoDestination).catch(() => null);
  if (!existingLogo || !existingLogo.equals(logoBytes)) {
    await mkdir(assetsRoot(root), { recursive: true });
    await writeFile(logoDestination, logoBytes);
    touched.push(`assets/${reportLogoAssetFilename}`);
  }
  return touched;
}

async function normalizeTemplatePackages(input) {
  if (!Array.isArray(input) || !input.length || input.length > 50) throw new Error("Template packages are required.");
  const normalized = [];
  for (const item of input) {
    const id = String(item?.id ?? "");
    const name = String(item?.name ?? "");
    const defaultLayoutId = String(item?.defaultLayoutId ?? "");
    const masterHtml = String(item?.masterHtml ?? "");
    const layouts = Array.isArray(item?.layouts) ? item.layouts : [];
    if (!/^[a-z0-9_-]+$/.test(id) || !name || !defaultLayoutId || !masterHtml || !layouts.length) throw new Error("Invalid template package.");
    if (!layouts.some((layout) => layout?.id === defaultLayoutId)) throw new Error(`Unknown default layout: ${id}/${defaultLayoutId}`);
    const normalizedLayouts = layouts.map((layout) => ({ id: String(layout?.id ?? ""), name: String(layout?.name ?? ""), html: String(layout?.html ?? "") }));
    if (normalizedLayouts.some((layout) => !/^[a-z0-9_-]+$/.test(layout.id) || !layout.name || !layout.html)) throw new Error(`Invalid layout package: ${id}`);
    const policy = auditContentPolicy({ html: [masterHtml, ...normalizedLayouts.map((layout) => layout.html)].join("\n") });
    if (!policy.ok) throw new Error(`Template package failed content policy: ${id}`);
    const formattedMaster = await formatSlideHtml(masterHtml);
    const formattedLayouts = await Promise.all(normalizedLayouts.map(async (layout) => ({ ...layout, html: await formatSlideHtml(layout.html) })));
    for (const layout of formattedLayouts) {
      const source = `<main data-weave-slide-source data-weave-template="${id}" data-weave-layout="${layout.id}" data-weave-accent="#fbbf24"><section data-weave-slot="content"><h1 data-weave-slot="title" data-weave-id="title"></h1></section></main>`;
      composeSlideHtml({ slideHtml: source, masterHtml: formattedMaster, layoutHtml: layout.html, templateId: id, layoutId: layout.id, position: 1, total: 1, accent: "#fbbf24", instanceId: null });
    }
    normalized.push({ id, name, defaultLayoutId, masterHtml: formattedMaster, layouts: formattedLayouts });
  }
  return normalized;
}

async function writeTemplatePackages(input, root = currentProjectRoot) {
  for (const { id, name, defaultLayoutId, masterHtml, layouts } of input) {
    const path = join(templatesRoot(root), id);
    await mkdir(join(path, "layouts"), { recursive: true });
    await Promise.all([
      writeFile(join(path, "template.json"), `${JSON.stringify({ id, name, defaultLayoutId, layouts: layouts.map(({ id: layoutId, name: layoutName }) => ({ id: layoutId, name: layoutName })) }, null, 2)}\n`),
      writeFile(join(path, "master.html"), masterHtml),
      ...layouts.map(async (layout) => writeFile(join(path, "layouts", `${layout.id}.html`), layout.html)),
    ]);
  }
}

const slugify = (value, fallback) =>
  String(value ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || fallback;

async function templateCatalog(root = currentProjectRoot) {
  const templates = await readTemplates(root);
  return new Map(templates.map((template) => [template.id, template]));
}

async function requireTemplate(templateId, root = currentProjectRoot) {
  const templates = await templateCatalog(root);
  const template = templates.get(String(templateId ?? ""));
  if (!template) throw new Error(`Unknown template: ${String(templateId ?? "")}`);
  return template;
}

async function requireLayout(templateId, layoutId, root = currentProjectRoot) {
  const template = await requireTemplate(templateId, root);
  const layout = template.layouts.find((item) => item.id === String(layoutId ?? ""));
  if (!layout) throw new Error(`Unknown layout: ${String(layoutId ?? "")} for template ${template.id}`);
  return { template, layout };
}

function composeSource(sourceHtml, template, layout, { accent, position, total, instanceId }) {
  return composeSlideHtml({ slideHtml: sourceHtml, masterHtml: template.masterHtml, layoutHtml: layout.html, templateId: template.id, layoutId: layout.id, accent, position, total, instanceId });
}

function sourceFromRendered(renderedHtml, { templateId, layoutId, accent }) {
  return extractSlideSourceHtml(renderedHtml, { templateId, layoutId, accent });
}

/** Normalize a project payload using source-only slides and explicit template/layout references. */
export function validateProject(input) {
  if (!input || typeof input !== "object") throw new Error("Project payload is required.");
  const sourceSlides = Array.isArray(input.slides) && input.slides.length ? input.slides.slice(0, 100) : [];
  if (!sourceSlides.length) throw new Error("A deck needs at least one slide.");
  const defaultTemplateId = String(input.defaultTemplateId ?? "");
  if (!defaultTemplateId) throw new Error("defaultTemplateId is required.");
  const seen = new Set();
  const slides = sourceSlides.map((slide, index) => {
    let id = slugify(slide?.id, `slide-${index + 1}`);
    while (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    const html = String(slide?.html ?? "");
    if (!html.trim()) throw new Error(`Slide ${index + 1} has empty HTML.`);
    if (html.length > 200_000) throw new Error(`Slide ${index + 1} HTML is too large.`);
    if (!String(slide?.templateId ?? "").trim()) throw new Error(`Slide ${index + 1} templateId is required.`);
    if (!String(slide?.layoutId ?? "").trim()) throw new Error(`Slide ${index + 1} layoutId is required.`);
    if (!String(slide?.accent ?? "").trim()) throw new Error(`Slide ${index + 1} accent is required.`);
    return {
      id,
      title: String(slide?.title ?? `Slide ${index + 1}`).slice(0, 200),
      notes: String(slide?.notes ?? "").slice(0, 20_000),
      templateId: String(slide?.templateId ?? ""),
      layoutId: String(slide?.layoutId ?? ""),
      accent: String(slide?.accent ?? ""),
      html,
    };
  });
  return { title: String(input.title ?? seedTitle).slice(0, 200), defaultTemplateId, slides };
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
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** The project as the editor loads it: manifest joined with each slide's HTML fragment. */
export async function readProject(root = currentProjectRoot) {
  const manifest = await readManifest(root);
  if (!manifest) throw new Error("Project manifest not found.");
  if (!Array.isArray(manifest.slides)) throw new Error("Project manifest slides are required.");
  if (manifest.schemaVersion !== 2) throw new Error("Unsupported project schema version.");
  const templates = await templateCatalog(root);
  if (!templates.has(String(manifest.defaultTemplateId ?? ""))) throw new Error(`Unknown template: ${String(manifest.defaultTemplateId ?? "")}`);
  const slides = await Promise.all(manifest.slides.map(async (slide, index) => ({
    id: slide.id,
    title: String(slide.title ?? `Slide ${index + 1}`),
    notes: String(slide.notes ?? ""),
    templateId: String(slide.templateId ?? ""),
    layoutId: String(slide.layoutId ?? ""),
    accent: String(slide.accent ?? ""),
    html: await readSlideHtml(slide.id, root),
  })));
  for (const slide of slides) {
    const template = templates.get(slide.templateId);
    if (!template) throw new Error(`Unknown template: ${slide.templateId}`);
    if (!template.layouts.some((layout) => layout.id === slide.layoutId)) throw new Error(`Unknown layout: ${slide.layoutId} for template ${slide.templateId}`);
    if (!slide.accent) throw new Error(`Slide ${slide.id} accent is required.`);
    if (!slide.html.trim()) throw new Error(`Slide ${slide.id} has empty HTML.`);
  }
  return { title: String(manifest.title ?? seedTitle), defaultTemplateId: String(manifest.defaultTemplateId), slides };
}

/** Write the project: every slide file (formatted) plus the manifest, transactionally. */
async function writeProjectUnlocked(input, expectedRevision = null, root = currentProjectRoot) {
  const project = validateProject(input);
  await requireTemplate(project.defaultTemplateId, root);
  for (const slide of project.slides) await requireLayout(slide.templateId, slide.layoutId, root);
  const slides = await Promise.all(project.slides.map(async (slide) => ({
    ...slide,
    html: await formatSlideHtml(slide.html),
  })));
  const manifest = { schemaVersion: 2, title: project.title, defaultTemplateId: project.defaultTemplateId, slides: slides.map(({ id, title, notes, templateId, layoutId, accent }) => ({ id, title, notes, templateId, layoutId, accent })) };
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

export async function saveProject(input, expectedRevision, message, templatePackages) {
  const root = currentProjectRoot;
  return await runProjectExclusive(async () => {
    let normalizedPackages = null;
    let previousDeck = null;
    let templateBackupRoot = null;
    if (templatePackages !== null) {
      assertRevision(expectedRevision, root);
      const incoming = validateProject(input);
      normalizedPackages = await normalizeTemplatePackages(templatePackages);
      const catalog = new Map(normalizedPackages.map((template) => [template.id, template]));
      for (const slide of incoming.slides) {
        const template = catalog.get(slide.templateId);
        if (!template || !template.layouts?.some((layout) => layout?.id === slide.layoutId)) throw new Error(`Imported template/layout is missing for slide ${slide.id}.`);
      }
      if (!catalog.has(incoming.defaultTemplateId)) throw new Error(`Imported default template is missing: ${incoming.defaultTemplateId}`);
      previousDeck = await readProject(root);
      templateBackupRoot = join(root, `.templates-${randomUUID()}.previous`);
      await mkdir(templateBackupRoot, { recursive: true });
      for (const template of normalizedPackages) {
        const current = join(templatesRoot(root), template.id);
        if (existsSync(current)) await cp(current, join(templateBackupRoot, template.id), { recursive: true });
      }
    }
    try {
      if (normalizedPackages) await writeTemplatePackages(normalizedPackages, root);
      const deck = await writeProjectUnlocked(input, expectedRevision, root);
      await assertCommittable(root);
      const commit = commitIfChanged(message ?? `Save: ${deck.title}`, root);
      return { deck, commit };
    } catch (error) {
      if (normalizedPackages) {
        for (const template of normalizedPackages) {
          const current = join(templatesRoot(root), template.id);
          const backup = join(templateBackupRoot, template.id);
          await rm(current, { recursive: true, force: true });
          if (existsSync(backup)) await cp(backup, current, { recursive: true });
        }
        if (previousDeck) await writeProjectUnlocked(previousDeck, null, root);
      }
      throw error;
    } finally {
      if (templateBackupRoot) await rm(templateBackupRoot, { recursive: true, force: true });
    }
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
  const templates = await readTemplates(root);
  const templateHtml = templates.flatMap((template) => [template.masterHtml, ...template.layouts.map((layout) => layout.html)]).join("\n");
  const composedHtml = await Promise.all(project.slides.map(async (slide) => {
    const template = templates.find((item) => item.id === slide.templateId);
    const layout = template?.layouts.find((item) => item.id === slide.layoutId);
    if (!template || !layout) throw new Error(`Unknown template/layout for slide ${slide.id}.`);
    return composeSource(slide.html, template, layout, { position: project.slides.indexOf(slide) + 1, total: project.slides.length, accent: slide.accent, instanceId: slide.id });
  }));
  const policy = auditContentPolicy({ css, html: [templateHtml, project.slides.map((slide) => slide.html).join("\n"), composedHtml.join("\n")].join("\n") });
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
  const pathsToAdd = managedPaths.filter((path) => existsSync(join(root, path)) || runGit(["ls-files", "--", path], { cwd: root }));
  runGit(["add", "-A", "--", ...pathsToAdd], { cwd: root });
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
  if (restored) await ensureProject();
  return getRevision();
}

export function checkoutMain() {
  if (managedStatus()) throw new Error("Save the current changes before returning to the latest version.");
  runGit(["checkout", "main"]);
}

export async function checkoutVariation(branch) {
  if (managedStatus()) throw new Error("Save current changes before switching directions.");
  const allowed = branch === "main" || getVariations().some((item) => item.branch === branch);
  if (!allowed) throw new Error("Unknown direction.");
  runGit(["checkout", branch]);
  await ensureProject();
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
  const isLegacy = raw && raw.schemaVersion !== 2 && (raw.blocks !== undefined || Array.isArray(raw.slides));
  if (!isLegacy) return false;
  await ensureTemplates();
  const available = await templateCatalog();
  const migrationAccent = raw.accent == null ? "#f6b84b" : String(raw.accent);
  let sourceSlides;
  if (raw.blocks !== undefined) {
    const blockSlides = (raw.slides ?? []).map((slide, index) => ({
      id: slide.id ?? `slide-${index + 1}`,
      title: slide.title ?? `Slide ${index + 1}`,
      notes: slide.notes ?? "",
      background: slide.background ?? "orbit",
      blocks: slide.blocks ?? [],
    }));
    sourceSlides = projectFromBlockSlides(raw.title ?? seedTitle, migrationAccent, blockSlides).slides;
  } else {
    sourceSlides = [];
    for (const [index, slide] of raw.slides.entries()) {
      sourceSlides.push(await migrateLegacySlide({
        ...slide,
        html: slide?.html == null ? await readSlideHtml(slide?.id, currentProjectRoot) : slide.html,
      }, index, available, migrationAccent));
    }
  }
  if (!sourceSlides.length) throw new Error("Legacy project has no slides.");
  const defaultTemplateId = sourceSlides[0].templateId;
  const project = { title: raw.title ?? seedTitle, defaultTemplateId, slides: sourceSlides };
  await writeProject(project);
  return true;
}

const legacyTemplateMapping = new Map([
  ["year-end-report-cover", { templateId: "year-end-report", layoutId: "cover" }],
  ["year-end-report", { templateId: "year-end-report", layoutId: "content" }],
  ["year-end-report-agenda", { templateId: "year-end-report", layoutId: "agenda" }],
  ["orbit", { templateId: "orbit", layoutId: "content" }],
  ["northstar", { templateId: "orbit", layoutId: "content" }],
  ["theme-northstar", { templateId: "orbit", layoutId: "content" }],
  ["grid", { templateId: "grid", layoutId: "content" }],
  ["plain", { templateId: "plain", layoutId: "content" }],
]);

const rootAttribute = (html, name) => html.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i"))?.slice(1).find((value) => value !== undefined) ?? "";
const layoutFingerprint = (html) => String(html)
  .replace(/\sdata-weave-id\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
  .replace(/<([a-z][\w:-]*)\b[^>]*>/gi, (opening, tagName) => opening.replace(/\bclass\s*=\s*(["'])(.*?)\1/i, (_attribute, quote, value) => {
    let classes = [...new Set(value.split(/\s+/).filter(Boolean))];
    // The legacy Tailwind migration materialized these defaults onto rendered
    // slides. They are not authored Layout changes and must not split one
    // canonical Layout into a per-slide migrated Layout.
    if (classes.includes("theme-grid") || classes.includes("theme-plain")) classes = classes.filter((name) => name !== "bg-slate-950");
    if (classes.includes("theme-plain")) classes = classes.filter((name) => name !== "text-slate-50");
    if (tagName.toLowerCase() === "h1" && /\bdata-weave-slot\s*=\s*(?:"title"|'title')/i.test(opening)) {
      classes = classes.filter((name) => name !== "text-slate-50");
    }
    return `class=${quote}${classes.sort().join(" ")}${quote}`;
  }))
  .replace(/\s+/g, " ")
  .trim();
const migrateLegacyLayoutClasses = (html) => String(html).replace(/\bclass\s*=\s*(["'])(.*?)\1/gi, (_attribute, quote, value) => {
  const classes = value.split(/\s+/).filter(Boolean).filter((name) => name !== "content" && name !== "title")
    .map((name) => name === "report-brand-placeholder" ? "report-logo" : name);
  return `class=${quote}${classes.join(" ")}${quote}`;
});

async function migrateLegacySlide(slide, index, templates, accent) {
  const html = String(slide?.html ?? "");
  if (!html.trim()) throw new Error(`Slide ${index + 1} has empty HTML.`);
  const themeId = html.match(/\bclass\s*=\s*(["'])[^"']*\btheme-(orbit|grid|plain)\b[^"']*\1/i)?.[2] ?? "";
  const legacyId = rootAttribute(html, "data-weave-template") || String(slide?.background ?? "") || themeId;
  const mapping = legacyTemplateMapping.get(legacyId);
  if (!mapping || !templates.has(mapping.templateId)) throw new Error(`Unknown legacy template: ${legacyId}`);
  const source = sourceFromRendered(html, { templateId: mapping.templateId, layoutId: mapping.layoutId, accent: slide.accent ?? accent });
  const removeMasterFurniture = mapping.templateId !== "year-end-report";
  const layoutSnapshot = migrateLegacyLayoutClasses(extractLayoutSnapshotHtml(html, { removeMasterFurniture }));
  const legacyTemplatePath = join(templatesRoot(), `${legacyId}.html`);
  const legacyTemplateHtml = await readFile(legacyTemplatePath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  const targetTemplate = templates.get(mapping.templateId);
  const targetLayout = targetTemplate?.layouts.find((layout) => layout.id === mapping.layoutId);
  if (!targetTemplate || !targetLayout) throw new Error(`Unknown migration target: ${mapping.templateId}/${mapping.layoutId}`);
  const emptySource = `<main data-weave-slide-source data-weave-template="${mapping.templateId}" data-weave-layout="${mapping.layoutId}" data-weave-accent="${slide.accent ?? accent}"><section data-weave-slot="content"><h1 data-weave-slot="title" data-weave-id="title"></h1></section></main>`;
  const canonicalRendered = composeSlideHtml({ slideHtml: emptySource, masterHtml: targetTemplate.masterHtml, layoutHtml: targetLayout.html, templateId: mapping.templateId, layoutId: mapping.layoutId, position: 1, total: 1, accent: slide.accent ?? accent, instanceId: null });
  const canonicalSnapshot = migrateLegacyLayoutClasses(extractLayoutSnapshotHtml(canonicalRendered, { removeMasterFurniture }));
  const legacyTemplateSnapshot = legacyTemplateHtml == null ? null : migrateLegacyLayoutClasses(extractLayoutSnapshotHtml(legacyTemplateHtml, { removeMasterFurniture }));
  const hasUnknownFurniture = legacyTemplateHtml == null
    ? hasLegacyFurnitureOutsideContent(html)
    : layoutFingerprint(legacyTemplateSnapshot) !== layoutFingerprint(canonicalSnapshot)
      || layoutFingerprint(layoutSnapshot) !== layoutFingerprint(legacyTemplateSnapshot);
  let layoutId = mapping.layoutId;
  if (hasUnknownFurniture) {
    const hash = createHash("sha256").update(layoutFingerprint(layoutSnapshot)).digest("hex").slice(0, 12);
    layoutId = `migrated-${hash}`;
    const templateRoot = join(templatesRoot(), mapping.templateId);
    const layoutPath = join(templateRoot, "layouts", `${layoutId}.html`);
    await mkdir(join(templateRoot, "layouts"), { recursive: true });
    const migratedLayout = layoutSnapshot.replace(/^<div\b/i, `<div data-weave-template="${mapping.templateId}" data-weave-layout="${mapping.layoutId}"`);
    if (!existsSync(layoutPath)) await writeFile(layoutPath, await formatSlideHtml(migratedLayout));
    const manifestPath = join(templateRoot, "template.json");
    const packageManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const layouts = Array.isArray(packageManifest.layouts) ? packageManifest.layouts : [];
    if (!layouts.some((item) => item?.id === layoutId)) {
      layouts.push({ id: layoutId, name: `Migrated ${slide.title ?? index + 1}` });
      await writeFile(manifestPath, `${JSON.stringify({ ...packageManifest, layouts }, null, 2)}\n`);
    }
  }
  return {
    id: slide.id ?? `slide-${index + 1}`,
    title: slide.title ?? `Slide ${index + 1}`,
    notes: slide.notes ?? "",
    templateId: mapping.templateId,
    layoutId,
    accent: slide.accent ?? accent,
    html: source,
  };
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
  const hasManifest = await access(manifestPath()).then(() => true).catch((error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
  if (hasManifest) {
    if (await migrateLegacyDeck()) {
      seededOrMigrated = true;
      migrationPaths.push(".weave/deck.json", "slides");
    }
  } else {
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

async function createProjectUnlocked({ title, templateId }) {
  const name = String(title ?? "").trim();
  if (!name) throw new Error("Title is required.");
  const selectedTemplateId = String(templateId ?? "");
  if (!selectedTemplateId) throw new Error("templateId is required.");
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
  try {
    await ensureTemplates(root);
    const selected = await requireTemplate(selectedTemplateId, root);
    const selectedLayout = selected.layouts.find((layout) => layout.id === selected.defaultLayoutId);
    if (!selectedLayout) throw new Error(`Unknown layout: ${selected.defaultLayoutId} for template ${selected.id}`);
    const cover = {
      id: "cover",
      title: name,
      notes: "",
      templateId: selected.id,
      layoutId: selected.defaultLayoutId,
      accent: "#fbbf24",
      html: `<main data-weave-slide-source data-weave-template="${selected.id}" data-weave-layout="${selected.defaultLayoutId}" data-weave-accent="#fbbf24"><section data-weave-slot="content"><h1 data-weave-slot="title" data-weave-id="title">${escapeHtml(name)}</h1></section></main>`,
    };
    gitAt(root, ["init", "-b", "main"]);
    await writeProjectUnlocked({ title: name, defaultTemplateId: selected.id, slides: [cover] }, null, root);
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
      const firstSlide = slides[0];
      const source = first ? await readFile(join(root, "slides", `${first}.html`), "utf8").catch(() => "") : "";
      let thumbnailHtml;
      if (manifest.schemaVersion === 2) {
        if (!manifest.defaultTemplateId) throw new Error("defaultTemplateId is required.");
        const templates = await readTemplates(root);
        const firstTemplate = templates.find((template) => template.id === firstSlide?.templateId);
        const firstLayout = firstTemplate?.layouts.find((layout) => layout.id === firstSlide?.layoutId);
        thumbnailHtml = firstTemplate && firstLayout && source
          ? composeSource(source, firstTemplate, firstLayout, { position: 1, total: slides.length, accent: firstSlide.accent, instanceId: firstSlide.id })
          : "";
      } else {
        thumbnailHtml = source;
      }
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
