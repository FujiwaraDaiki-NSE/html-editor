import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseSkillDocument, serializeSkillDocument, validateSkillName } from "./skills.mjs";

const execute = promisify(execFile);
const templateRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "agent-skills");
export const applicationSkillNames = Object.freeze(["technical-report-slides", "author-slide-preferences"]);
const capabilities = Object.freeze({ edit: true, history: true, restore: true, delete: false, move: false });
const locks = new Map();
const maxDocumentBytes = 1_000_000;
const learningStatePath = ".weave/slide-preference-learning.json";
const markerName = "weave-application-skills.json";
const markerContent = '{"type":"weave-application-skills","version":1}\n';
const commitPattern = /^[a-f0-9]{40}$/;

function skillError(message, code = "WEAVE_SKILL_INVALID") {
  return Object.assign(new Error(message), { code });
}

export function applicationSkillsRoot() {
  const configured = process.env.WEAVE_APPLICATION_SKILLS_ROOT;
  if (configured === undefined) return join(homedir(), ".local", "state", "weave", "application-skills");
  if (typeof configured !== "string" || !configured.trim() || configured.includes("\0") || !isAbsolute(configured)) {
    throw skillError("WEAVE_APPLICATION_SKILLS_ROOT must be a nonempty absolute path.");
  }
  const root = resolve(configured);
  if (root === dirname(root) || root === homedir()) throw skillError("Application skill storage must have its own directory.");
  return root;
}

function skillName(name) {
  validateSkillName(name);
  if (!applicationSkillNames.includes(name)) throw skillError("Application skill was not found.", "WEAVE_SKILL_NOT_FOUND");
  return name;
}

function requireMessage(message) {
  if (typeof message !== "string" || !message.trim() || message.length > 4_000 || message.includes("\0")) {
    throw skillError("A nonempty history message of at most 4000 characters is required.");
  }
  return message.trim();
}

function requireRevision(revision) {
  if (typeof revision !== "string" || !commitPattern.test(revision)) throw skillError("The current application skill revision is required.");
  return revision;
}

function requireCommit(commit) {
  if (typeof commit !== "string" || !commitPattern.test(commit)) throw skillError("A full application skill commit ID is required.");
  return commit;
}

async function info(path) {
  try { return await lstat(path); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function safeDirectories(path) {
  const parent = dirname(path);
  if (path !== parent) await safeDirectories(parent);
  const entry = await info(path);
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw skillError("Application skill paths cannot contain symbolic links or files.");
}

function gitEnvironment(extra = {}) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Weave",
    GIT_AUTHOR_EMAIL: "weave@localhost",
    GIT_COMMITTER_NAME: "Weave",
    GIT_COMMITTER_EMAIL: "weave@localhost",
    ...extra,
  };
}

async function git(root, args, { environment, input, allowFailure = false, buffer = false } = {}) {
  try {
    const child = execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", root, ...args], {
      env: gitEnvironment(environment), encoding: buffer ? "buffer" : "utf8", maxBuffer: 32_000_000, timeout: 30_000,
    });
    if (input !== undefined) child.child.stdin.end(input);
    const result = await child;
    return { ...result, code: 0 };
  } catch (error) {
    if (allowFailure && typeof error?.code === "number") return { stdout: error.stdout, stderr: error.stderr, code: error.code };
    const detail = typeof error?.stderr === "string" ? error.stderr.trim() : error instanceof Error ? error.message : String(error);
    throw skillError(`Application skill Git operation failed: ${detail}`, "WEAVE_SKILL_GIT");
  }
}

async function head(root) {
  const result = await git(root, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
  if (result.code !== 0) return null;
  const revision = result.stdout.trim();
  if (!commitPattern.test(revision)) throw skillError("Application skill repository has an unsupported revision.", "WEAVE_SKILL_GIT");
  return revision;
}

async function atomicWrite(path, content, mode = 0o600) {
  await safeDirectories(dirname(path));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const current = await info(path);
  if (current && (!current.isFile() || current.isSymbolicLink())) throw skillError("Application skill files must be regular files.");
  const temporary = join(dirname(path), `.weave-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, current ? current.mode & 0o777 : mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

async function lockOwner(path) {
  const entry = await info(path);
  if (!entry) return null;
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw skillError("Application skill storage lock is invalid.");
  try {
    const ownerInfo = await info(join(path, "owner.json"));
    if (!ownerInfo?.isFile() || ownerInfo.isSymbolicLink()) return null;
    return JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; }
}

async function reclaimLock(lockPath, owner) {
  const claimPath = `${lockPath}.reclaim`;
  let claim;
  try {
    claim = await open(claimPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const current = await lockOwner(lockPath);
    if (current?.token === owner.token && !processExists(current.pid)) {
      const abandoned = `${lockPath}.abandoned-${randomUUID()}`;
      await rename(lockPath, abandoned);
      await rm(abandoned, { recursive: true, force: true });
    }
  } catch (error) {
    if (!["EEXIST", "ENOENT"].includes(error?.code)) throw error;
  } finally {
    if (claim) { await claim.close(); await rm(claimPath, { force: true }); }
  }
}

async function storageLock(root, operation) {
  const previous = locks.get(root) ?? Promise.resolve();
  let release;
  const queued = previous.then(() => new Promise((done) => { release = done; }));
  locks.set(root, queued);
  await previous;
  // Let the queued promise install its release callback before acquiring the filesystem lock.
  await Promise.resolve();
  const lockPath = `${root}.lock`;
  let acquired = false;
  const token = randomUUID();
  try {
    await safeDirectories(dirname(root));
    await mkdir(dirname(root), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 15_000;
    while (!acquired) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        acquired = true;
        await atomicWrite(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, token }));
      } catch (error) {
        if (acquired || error?.code !== "EEXIST") throw error;
        const owner = await lockOwner(lockPath);
        if (owner && !processExists(owner.pid)) {
          await reclaimLock(lockPath, owner);
          if (Date.now() >= deadline) throw skillError("Application skill storage is busy. Retry the operation.", "WEAVE_SKILL_CONFLICT");
          await delay(25);
          continue;
        }
        const lockInfo = await info(lockPath);
        if (!owner && lockInfo && Date.now() - lockInfo.mtimeMs > 30_000) {
          throw skillError("Application skill storage has an abandoned lock without an owner.", "WEAVE_SKILL_CONFLICT");
        }
        if (Date.now() >= deadline) throw skillError("Application skill storage is busy. Retry the operation.", "WEAVE_SKILL_CONFLICT");
        await delay(25);
      }
    }
    return await operation();
  } finally {
    try {
      if (acquired) {
        const owner = await lockOwner(lockPath);
        if (owner === null || owner.token === token) await rm(lockPath, { recursive: true, force: true });
      }
    } finally {
      release();
      if (locks.get(root) === queued) locks.delete(root);
    }
  }
}

async function copyMissingTree(source, destination) {
  await safeDirectories(source);
  await safeDirectories(destination);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(destination, entry.name);
    const entryInfo = await info(sourcePath);
    if (!entryInfo || entryInfo.isSymbolicLink()) throw skillError("Application skill templates cannot contain symbolic links.");
    if (entryInfo.isDirectory()) await copyMissingTree(sourcePath, targetPath);
    else if (entryInfo.isFile()) {
      const existing = await info(targetPath);
      if (existing) {
        if (!existing.isFile() || existing.isSymbolicLink()) throw skillError("Application skill files must be regular files.");
      } else await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
    } else throw skillError("Application skill templates must contain regular files and directories.");
  }
}

function taggedMessage(message, names) {
  return `${message}\n\n${names.map((name) => `Weave-Application-Skill: ${name}`).join("\n")}\n`;
}

async function commitPaths(root, paths, message, names, parent) {
  const indexPath = join(root, ".git", `.weave-index-${randomUUID()}`);
  const environment = { GIT_INDEX_FILE: indexPath };
  let revision;
  try {
    const staged = parent ? await git(root, ["diff", "--cached", "--quiet", parent, "--", ...paths], { allowFailure: true }) : { code: 0 };
    if (![0, 1].includes(staged.code)) throw skillError("Application skill index could not be inspected.", "WEAVE_SKILL_GIT");
    await git(root, parent ? ["read-tree", parent] : ["read-tree", "--empty"], { environment });
    await git(root, ["add", "-A", "--", ...paths], { environment });
    const tree = (await git(root, ["write-tree"], { environment })).stdout.trim();
    const args = ["commit-tree", tree];
    if (parent) args.push("-p", parent);
    revision = (await git(root, args, { input: taggedMessage(message, names) })).stdout.trim();
    requireCommit(revision);
    await git(root, ["update-ref", "HEAD", revision, parent === null ? "0".repeat(40) : parent]);
    try {
      // Only advance index entries that had no user-staged changes. Other staged files are preserved.
      if (staged.code === 0) await git(root, ["reset", "--quiet", revision, "--", ...paths]);
    } catch (error) {
      await git(root, parent ? ["update-ref", "HEAD", parent, revision] : ["update-ref", "-d", "HEAD", revision]);
      throw error;
    }
    return revision;
  } finally {
    await rm(indexPath, { force: true });
    await rm(`${indexPath}.lock`, { force: true });
  }
}

async function initialize(root) {
  await safeDirectories(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const gitPath = join(root, ".git");
  const gitInfo = await info(gitPath);
  if (!gitInfo) {
    if ((await readdir(root)).length) throw skillError("Application skill storage must be an empty directory or its own managed repository.");
    await git(root, ["init", "--quiet", "--object-format=sha1", "--initial-branch=main"]);
    await atomicWrite(join(gitPath, markerName), markerContent);
  } else {
    if (!gitInfo.isDirectory() || gitInfo.isSymbolicLink()) throw skillError("Application skills require an independent Git repository.");
    const marker = await info(join(gitPath, markerName));
    if (!marker?.isFile() || marker.isSymbolicLink() || await readFile(join(gitPath, markerName), "utf8") !== markerContent) {
      throw skillError("Application skill storage is not a Weave managed repository.");
    }
  }
  const actualRoot = (await git(root, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const actualGit = (await git(root, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
  const actualCommon = resolve(root, (await git(root, ["rev-parse", "--git-common-dir"])).stdout.trim());
  if (actualRoot !== root || actualGit !== gitPath || actualCommon !== gitPath) throw skillError("Application skills require an independent Git repository.");
  let revision = await head(root);
  if (revision === null) {
    for (const name of applicationSkillNames) {
      parseSkillDocument(await readFile(join(templateRoot, name, "SKILL.md"), "utf8"), name);
      await copyMissingTree(join(templateRoot, name), join(root, name));
    }
    revision = await commitPaths(root, applicationSkillNames, "Initialize shared application skills so edits survive app updates", applicationSkillNames, null);
  }
  return { root, revision };
}

export async function initializeApplicationSkills() {
  const root = applicationSkillsRoot();
  return storageLock(root, () => initialize(root));
}

async function inStorage(operation) {
  const root = applicationSkillsRoot();
  return storageLock(root, async () => {
    const { revision } = await initialize(root);
    return operation(root, revision);
  });
}

function publicSkill(root, name, content, revision, readError = null) {
  let parsed;
  let error = readError;
  try { if (!error) parsed = parseSkillDocument(content, name); } catch (parseError) { error = parseError; }
  return {
    name,
    description: parsed ? parsed.description : "This SKILL.md needs repair before Codex can use it.",
    body: parsed ? parsed.body : "",
    content,
    frontmatter: parsed ? parsed.unknownFrontmatter : null,
    scope: "application",
    location: "application",
    path: `application-skills/${name}/SKILL.md`,
    filePath: join(root, name, "SKILL.md"),
    valid: !error,
    error: error ? error instanceof Error ? error.message : String(error) : null,
    revision,
    capabilities: { ...capabilities },
  };
}

async function readCurrent(root, name, revision) {
  let content = "";
  try {
    await safeDirectories(join(root, name));
    const path = join(root, name, "SKILL.md");
    const file = await info(path);
    if (!file?.isFile() || file.isSymbolicLink()) throw skillError("Application skill file was not found.", "WEAVE_SKILL_NOT_FOUND");
    if (file.size > maxDocumentBytes) throw skillError("Application skill file is too large.");
    content = await readFile(path, "utf8");
    return publicSkill(root, name, content, revision);
  } catch (error) { return publicSkill(root, name, content, revision, error); }
}

export async function listApplicationSkills() {
  return inStorage(async (root, revision) => Promise.all(applicationSkillNames.map((name) => readCurrent(root, name, revision))));
}

export async function readApplicationSkill(name) {
  skillName(name);
  return inStorage((root, revision) => readCurrent(root, name, revision));
}

function verifyRevision(expected, actual) {
  requireRevision(expected);
  if (expected !== actual) throw skillError("Application skills changed. Reload the latest version before saving.", "WEAVE_SKILL_CONFLICT");
}

function serializedState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state) || Object.getPrototypeOf(state) !== Object.prototype) throw skillError("Application learning state must be an object.");
  let content;
  try { content = `${JSON.stringify(state, null, 2)}\n`; } catch { throw skillError("Application learning state must be JSON serializable."); }
  if (Buffer.byteLength(content) > maxDocumentBytes) throw skillError("Application learning state is too large.");
  return content;
}

async function changeFiles(root, changes, message, names, revision) {
  const originals = [];
  for (const { path } of changes) {
    await safeDirectories(dirname(join(root, path)));
    const file = await info(join(root, path));
    if (file && (!file.isFile() || file.isSymbolicLink())) throw skillError("Application skill files must be regular files.");
    originals.push({ path, content: file ? await readFile(join(root, path)) : null, mode: file ? file.mode & 0o777 : 0o600 });
  }
  try {
    for (const { path, content } of changes) await atomicWrite(join(root, path), content);
    return await commitPaths(root, changes.map(({ path }) => path), message, names, revision);
  } catch (error) {
    for (const original of originals.reverse()) {
      if (original.content === null) await rm(join(root, original.path), { force: true });
      else await atomicWrite(join(root, original.path), original.content, original.mode);
    }
    throw error;
  }
}

export async function updateApplicationSkill(input) {
  if (!input || typeof input !== "object") throw skillError("Application skill payload is required.");
  const name = skillName(input.name);
  if (!("frontmatter" in input) || input.frontmatter === undefined) throw skillError("Skill frontmatter must be provided as text or null.");
  const content = serializeSkillDocument({ name, description: input.description, body: input.body, unknownFrontmatter: input.frontmatter });
  const message = requireMessage(input.message);
  requireRevision(input.expectedRevision);
  const changes = [{ path: `${name}/SKILL.md`, content }];
  if ("evidence" in input) {
    if (typeof input.evidence !== "string" || !input.evidence.trim() || Buffer.byteLength(input.evidence) > maxDocumentBytes) throw skillError("Application skill evidence must be nonempty text of at most 1 MB.");
    changes.push({ path: `${name}/references/evidence.md`, content: input.evidence });
  }
  if ("learningState" in input) changes.push({ path: learningStatePath, content: serializedState(input.learningState) });
  return inStorage(async (root, revision) => {
    verifyRevision(input.expectedRevision, revision);
    const nextRevision = await changeFiles(root, changes, message, [name], revision);
    return publicSkill(root, name, content, nextRevision);
  });
}

export async function readApplicationSkillEvidence(name) {
  skillName(name);
  return inStorage(async (root, revision) => {
    const path = join(root, name, "references", "evidence.md");
    await safeDirectories(dirname(path));
    const file = await info(path);
    if (!file) return { revision, content: null };
    if (!file.isFile() || file.isSymbolicLink() || file.size > maxDocumentBytes) throw skillError("Application skill evidence is not a readable regular file.");
    return { revision, content: await readFile(path, "utf8") };
  });
}

export async function readApplicationLearningState() {
  return inStorage(async (root, revision) => {
    const path = join(root, learningStatePath);
    await safeDirectories(dirname(path));
    const file = await info(path);
    if (!file) return { revision, state: null };
    if (!file.isFile() || file.isSymbolicLink() || file.size > maxDocumentBytes) throw skillError("Application learning state is not a readable regular file.");
    let state;
    try { state = JSON.parse(await readFile(path, "utf8")); } catch { throw skillError("Application learning state contains invalid JSON."); }
    serializedState(state);
    return { revision, state };
  });
}

export async function updateApplicationLearningState({ expectedRevision, state, message }) {
  requireRevision(expectedRevision);
  const content = serializedState(state);
  const validatedMessage = requireMessage(message);
  return inStorage(async (root, revision) => {
    verifyRevision(expectedRevision, revision);
    const nextRevision = await changeFiles(root, [{ path: learningStatePath, content }], validatedMessage, [], revision);
    return { revision: nextRevision, state: JSON.parse(content) };
  });
}

function visibleMessage(message) {
  return message.replace(/\n\n(?:Weave-Application-Skill: [a-z0-9-]+\n?)*$/, "").trimEnd();
}

export async function getApplicationSkillHistory(name) {
  skillName(name);
  return inStorage(async (root, revision) => {
    const fields = (await git(root, ["log", "--format=%H%x00%h%x00%cI%x00%B%x00", revision])).stdout.split("\0");
    const entries = [];
    for (let index = 0; index + 3 < fields.length; index += 4) {
      const id = fields[index].trim();
      const shortId = fields[index + 1];
      const date = fields[index + 2];
      const message = fields[index + 3];
      const tagged = message.split("\n").includes(`Weave-Application-Skill: ${name}`);
      const changed = tagged || Boolean((await git(root, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", id, "--", name])).stdout.trim());
      if (changed) entries.push({ id, shortId, message: visibleMessage(message), date });
    }
    return { name, scope: "application", revision, entries };
  });
}

async function verifyHistoricalCommit(root, commit, revision) {
  requireCommit(commit);
  const type = await git(root, ["cat-file", "-t", commit], { allowFailure: true });
  const reachable = type.code === 0 && type.stdout.trim() === "commit" ? await git(root, ["merge-base", "--is-ancestor", commit, revision], { allowFailure: true }) : { code: 1 };
  if (reachable.code !== 0) throw skillError("Application skill version was not found in this repository.", "WEAVE_SKILL_NOT_FOUND");
}

async function historicalFiles(root, name, commit) {
  const listing = (await git(root, ["ls-tree", "-rz", "--full-tree", commit, "--", name])).stdout;
  const entries = [];
  for (const line of listing.split("\0").filter(Boolean)) {
    const separator = line.indexOf("\t");
    const [mode, type, object] = line.slice(0, separator).split(" ");
    const path = line.slice(separator + 1);
    const components = path.split("/");
    if (separator < 0 || !["100644", "100755"].includes(mode) || type !== "blob" || !commitPattern.test(object) || !path.startsWith(`${name}/`) || components.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
      throw skillError("Application skill history contains an unsupported file path.");
    }
    entries.push({ path, object, mode: mode === "100755" ? 0o700 : 0o600 });
  }
  if (!entries.some(({ path }) => path === `${name}/SKILL.md`)) throw skillError("Application skill version was not found.", "WEAVE_SKILL_NOT_FOUND");
  return entries;
}

export async function getApplicationSkillVersion(name, commit) {
  skillName(name);
  requireCommit(commit);
  return inStorage(async (root, revision) => {
    await verifyHistoricalCommit(root, commit, revision);
    const files = await historicalFiles(root, name, commit);
    const document = files.find(({ path }) => path === `${name}/SKILL.md`);
    const content = (await git(root, ["cat-file", "blob", document.object])).stdout;
    return { revision, commit, skill: publicSkill(root, name, content, revision) };
  });
}

export async function restoreApplicationSkill({ name, commit, expectedRevision, message }) {
  skillName(name);
  requireCommit(commit);
  requireRevision(expectedRevision);
  const validatedMessage = requireMessage(message);
  return inStorage(async (root, revision) => {
    verifyRevision(expectedRevision, revision);
    await verifyHistoricalCommit(root, commit, revision);
    const files = await historicalFiles(root, name, commit);
    const staging = join(root, `.${name}.restore-${randomUUID()}`);
    const backup = join(root, `.${name}.previous-${randomUUID()}`);
    const destination = join(root, name);
    await safeDirectories(destination);
    let movedOriginal = false;
    let movedReplacement = false;
    let committed = false;
    let content;
    try {
      await mkdir(staging, { mode: 0o700 });
      for (const file of files) {
        const data = (await git(root, ["cat-file", "blob", file.object], { buffer: true })).stdout;
        const target = join(staging, relative(name, file.path));
        const relativeTarget = relative(staging, target);
        if (!relativeTarget || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) throw skillError("Application skill history contains an invalid path.");
        await atomicWrite(target, data, file.mode);
        if (file.path === `${name}/SKILL.md`) content = data.toString("utf8");
      }
      if (await info(destination)) { await rename(destination, backup); movedOriginal = true; }
      await rename(staging, destination);
      movedReplacement = true;
      const nextRevision = await commitPaths(root, [name], validatedMessage, [name], revision);
      committed = true;
      return publicSkill(root, name, content, nextRevision);
    } catch (error) {
      if (movedReplacement) await rm(destination, { recursive: true, force: true });
      if (movedOriginal) { await rename(backup, destination); movedOriginal = false; }
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
      if (committed || !movedOriginal) await rm(backup, { recursive: true, force: true });
    }
  });
}
