import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { JSON_SCHEMA, load as loadYaml } from "js-yaml";

export const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const skillScopes = ["project", "common"];

const maxSkillBytes = 1_000_000;
const maxSkillDescription = 20_000;
const maxSkillBody = 900_000;
const skillFileName = "SKILL.md";
const skillLocks = new Map();

function skillError(message, code) {
  return Object.assign(new Error(message), { code });
}

function requireProjectRoot(root) {
  if (typeof root !== "string" || !root.trim()) throw skillError("Project root is required.", "WEAVE_SKILL_INVALID");
  return resolve(root);
}

export function validateSkillScope(scope) {
  if (!skillScopes.includes(scope)) throw skillError("Skill scope must be project or common.", "WEAVE_SKILL_INVALID");
  return scope;
}

export function validateSkillName(value) {
  if (typeof value !== "string" || !value || value.length >= 64 || !skillNamePattern.test(value)) {
    throw skillError("Skill name must be lowercase kebab-case and under 64 characters.", "WEAVE_SKILL_INVALID");
  }
  return value;
}

function requireSkillDescription(value) {
  if (typeof value !== "string" || !value.trim()) throw skillError("Skill description is required.", "WEAVE_SKILL_INVALID");
  if (value.length > maxSkillDescription) throw skillError("Skill description is too long.", "WEAVE_SKILL_INVALID");
  return value.trim();
}

function requireSkillBody(value) {
  if (typeof value !== "string" || !value.trim()) throw skillError("Skill body is required.", "WEAVE_SKILL_INVALID");
  if (value.length > maxSkillBody) throw skillError("Skill body is too large.", "WEAVE_SKILL_INVALID");
  return value.trim();
}

function skillRoot(root, scope) {
  const projectRoot = requireProjectRoot(root);
  validateSkillScope(scope);
  const configuredCodexHome = process.env.CODEX_HOME;
  const codexHome = typeof configuredCodexHome === "string" && configuredCodexHome.trim() ? resolve(configuredCodexHome) : join(homedir(), ".codex");
  return scope === "project" ? join(projectRoot, ".codex", "skills") : join(codexHome, "skills");
}

export function skillFilePath(root, scope, name) {
  const validatedName = validateSkillName(name);
  return join(skillRoot(root, scope), validatedName, skillFileName);
}

function skillRelativePath(scope, name) {
  if (scope === "project") return `.codex/skills/${name}/${skillFileName}`;
  return typeof process.env.CODEX_HOME === "string" && process.env.CODEX_HOME.trim()
    ? `$CODEX_HOME/skills/${name}/${skillFileName}`
    : `~/.codex/skills/${name}/${skillFileName}`;
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

async function entryInfo(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function assertSafeDirectoryChain(path) {
  const resolvedPath = resolve(path);
  const parentPath = dirname(resolvedPath);
  if (resolvedPath !== parentPath) await assertSafeDirectoryChain(parentPath);
  const info = await entryInfo(resolvedPath);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw skillError("Skill path cannot contain symbolic links or files.", "WEAVE_SKILL_INVALID");
}

async function assertRegularSkillFile(path, { enforceSize = true } = {}) {
  const info = await entryInfo(path);
  if (!info || !info.isFile() || info.isSymbolicLink()) throw skillError("Skill file was not found.", "WEAVE_SKILL_NOT_FOUND");
  if (enforceSize && info.size > maxSkillBytes) throw skillError("Skill file is too large.", "WEAVE_SKILL_INVALID");
  return info;
}

async function assertSafeSkillDirectory(path, { allowMissing = false } = {}) {
  const info = await entryInfo(path);
  if (!info) {
    if (allowMissing) return null;
    throw skillError("Skill was not found.", "WEAVE_SKILL_NOT_FOUND");
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw skillError("Skill path is not a directory.", "WEAVE_SKILL_INVALID");
  return info;
}

async function assertSafeSkillTree(path) {
  await assertSafeSkillDirectory(path);
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = join(path, entry.name);
    const childInfo = await entryInfo(childPath);
    if (!childInfo || childInfo.isSymbolicLink()) throw skillError("Skill folders cannot contain symbolic links.", "WEAVE_SKILL_INVALID");
    if (childInfo.isDirectory()) {
      await assertSafeSkillTree(childPath);
    } else if (!childInfo.isFile()) {
      throw skillError("Skill folders can only contain regular files and directories.", "WEAVE_SKILL_INVALID");
    }
  }
}

function parseYamlScalar(value) {
  const text = value.trim();
  if (!text) return "";
  if (text.startsWith("\"") && text.endsWith("\"")) {
    try {
      return JSON.parse(text);
    } catch {
      throw skillError("Skill frontmatter contains invalid quoted text.", "WEAVE_SKILL_INVALID");
    }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  if (/^[\[\{]/.test(text) || /^(?:true|false|null|~)$/i.test(text)) return null;
  return text;
}

function validateFrontmatterLines(lines) {
  if (lines.join("\n").length > 80_000) throw skillError("Skill frontmatter is too large.", "WEAVE_SKILL_INVALID");
  for (const line of lines) {
    if (line.includes("\u0000")) throw skillError("Skill frontmatter contains an invalid character.", "WEAVE_SKILL_INVALID");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^(?:%|---|\.\.\.)/.test(trimmed) || /(^|[\s:])(?:!!|!<|&[A-Za-z0-9_-]+|\*[A-Za-z0-9_-]+)/.test(trimmed)) {
      throw skillError("Skill frontmatter contains an unsupported YAML construct.", "WEAVE_SKILL_INVALID");
    }
    if (!/^\s/.test(line) && !/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(line)) {
      throw skillError("Skill frontmatter contains an invalid field.", "WEAVE_SKILL_INVALID");
    }
  }
}

function frontmatterFields(lines) {
  const fields = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (fields.has(key)) throw skillError(`Skill frontmatter repeats ${key}.`, "WEAVE_SKILL_INVALID");
    const blockStyle = rawValue.trim().match(/^([|>])(?:[1-9][+-]?|[+-][1-9]?)?$/)?.[1];
    if (blockStyle) {
      const content = [];
      let end = index;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const continuation = lines[cursor];
        if (continuation && !/^\s/.test(continuation)) break;
        content.push(continuation);
        end = cursor;
      }
      const nonEmpty = content.filter((item) => item.trim());
      const indent = nonEmpty.length ? Math.min(...nonEmpty.map((item) => item.match(/^\s*/)?.[0].length ?? 0)) : 0;
      const unindented = content.map((item) => item.slice(Math.min(indent, item.length)));
      const value = blockStyle === ">" ? unindented.join(" ").replace(/\s+/g, " ").trim() : unindented.join("\n").trim();
      fields.set(key, { rawValue, value, start: index, end });
      index = end;
      continue;
    }
    fields.set(key, { rawValue, value: parseYamlScalar(rawValue), start: index, end: index });
  }
  return fields;
}

function splitSkillDocument(content) {
  if (typeof content !== "string") throw skillError("Skill content is required.", "WEAVE_SKILL_INVALID");
  if (Buffer.byteLength(content, "utf8") > maxSkillBytes) throw skillError("Skill file is too large.", "WEAVE_SKILL_INVALID");
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") throw skillError("SKILL.md must start with YAML frontmatter.", "WEAVE_SKILL_INVALID");
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) throw skillError("SKILL.md frontmatter is not closed.", "WEAVE_SKILL_INVALID");
  const frontmatterLines = lines.slice(1, end);
  validateFrontmatterLines(frontmatterLines);
  let yamlDocument;
  try {
    yamlDocument = loadYaml(frontmatterLines.join("\n"), { schema: JSON_SCHEMA });
  } catch (error) {
    throw skillError(`Skill frontmatter is invalid YAML: ${error instanceof Error ? error.message : String(error)}`, "WEAVE_SKILL_INVALID");
  }
  if (!yamlDocument || typeof yamlDocument !== "object" || Array.isArray(yamlDocument)) throw skillError("Skill frontmatter must be a YAML mapping.", "WEAVE_SKILL_INVALID");
  const body = lines.slice(end + 1).join("\n");
  if (!body.trim()) throw skillError("Skill body is required.", "WEAVE_SKILL_INVALID");
  return { frontmatterLines, body, yamlDocument };
}

export function parseSkillDocument(content, expectedName = undefined) {
  const { frontmatterLines, body, yamlDocument } = splitSkillDocument(content);
  const fields = frontmatterFields(frontmatterLines);
  const nameField = fields.get("name");
  const descriptionField = fields.get("description");
  if (!nameField || typeof yamlDocument.name !== "string" || !yamlDocument.name.trim()) throw skillError("Skill frontmatter name is required.", "WEAVE_SKILL_INVALID");
  if (!descriptionField || typeof yamlDocument.description !== "string" || !yamlDocument.description.trim()) throw skillError("Skill frontmatter description is required.", "WEAVE_SKILL_INVALID");
  const name = validateSkillName(yamlDocument.name.trim());
  if (expectedName !== undefined && name !== expectedName) throw skillError("Skill name does not match its path.", "WEAVE_SKILL_INVALID");
  const description = requireSkillDescription(yamlDocument.description);
  const reservedIndexes = new Set();
  for (const key of ["name", "description"]) {
    const field = fields.get(key);
    if (!field) continue;
    for (let index = field.start; index <= field.end; index += 1) reservedIndexes.add(index);
  }
  const unknownLines = frontmatterLines.filter((_, index) => !reservedIndexes.has(index));
  const unknownFrontmatter = unknownLines.join("\n").trim() || null;
  return { name, description, body: requireSkillBody(body), unknownFrontmatter, frontmatterLines };
}

function yamlKey(key) {
  if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) || ["name", "description"].includes(key)) {
    throw skillError("Skill frontmatter contains an invalid key.", "WEAVE_SKILL_INVALID");
  }
  return key;
}

function yamlValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => yamlValue(item)).join(", ")}]`;
  throw skillError("Skill frontmatter only supports safe scalar values and arrays.", "WEAVE_SKILL_INVALID");
}

function frontmatterFromValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const lines = value.replace(/\r\n?/g, "\n").split("\n");
    validateFrontmatterLines(lines);
    frontmatterFields(lines);
    try {
      const document = loadYaml(lines.join("\n"), { schema: JSON_SCHEMA });
      if (document !== null && (typeof document !== "object" || Array.isArray(document))) throw new Error("must be a YAML mapping");
    } catch (error) {
      throw skillError(`Skill frontmatter is invalid YAML: ${error instanceof Error ? error.message : String(error)}`, "WEAVE_SKILL_INVALID");
    }
    for (const line of lines) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:/);
      if (match && ["name", "description"].includes(match[1])) throw skillError("Skill frontmatter cannot replace name or description.", "WEAVE_SKILL_INVALID");
    }
    return lines.join("\n").trim() || null;
  }
  if (typeof value !== "object" || Array.isArray(value)) throw skillError("Skill frontmatter must be text or an object.", "WEAVE_SKILL_INVALID");
  const lines = [];
  for (const [key, item] of Object.entries(value)) lines.push(`${yamlKey(key)}: ${yamlValue(item)}`);
  return lines.join("\n") || null;
}

export function serializeSkillDocument({ name, description, body, unknownFrontmatter = undefined }) {
  const validatedName = validateSkillName(name);
  const validatedDescription = requireSkillDescription(description);
  const validatedBody = requireSkillBody(body);
  const unknown = frontmatterFromValue(unknownFrontmatter);
  const lines = [`---`, `name: ${validatedName}`, `description: ${JSON.stringify(validatedDescription)}`];
  if (unknown) lines.push(unknown);
  lines.push("---", validatedBody, "");
  return lines.join("\n");
}

async function readSkillDocument(root, scope, name) {
  const path = skillFilePath(root, scope, name);
  await assertSafeDirectoryChain(dirname(dirname(path)));
  await assertSafeSkillDirectory(dirname(path));
  await assertRegularSkillFile(path);
  const content = await readFile(path, "utf8");
  const parsed = parseSkillDocument(content, name);
  return { ...parsed, content, path, scope, relativePath: skillRelativePath(scope, name) };
}

function publicSkill(document) {
  return {
    name: document.name,
    description: document.description,
    body: document.body,
    content: document.content,
    frontmatter: document.unknownFrontmatter,
    scope: document.scope,
    location: document.scope,
    path: document.relativePath,
    filePath: document.path,
    valid: true,
    error: null,
  };
}

async function invalidPublicSkill(root, scope, name, error) {
  const path = skillFilePath(root, scope, name);
  let info = null;
  let content = "";
  let detail = error instanceof Error ? error.message : String(error);
  try {
    info = await entryInfo(path);
    if (info?.isFile() && !info.isSymbolicLink() && info.size <= maxSkillBytes) content = await readFile(path, "utf8");
  } catch (readError) {
    detail = `${detail} ${readError instanceof Error ? readError.message : String(readError)}`.trim();
  }
  return {
    name,
    description: "This SKILL.md needs repair before Codex can use it.",
    body: "",
    content,
    frontmatter: null,
    scope,
    location: scope,
    path: skillRelativePath(scope, name),
    filePath: path,
    valid: false,
    error: detail,
  };
}

async function withSkillLocks(root, names, operation) {
  const projectRoot = requireProjectRoot(root);
  const keys = [...new Set(names.map((name) => `${projectRoot}\u0000${name}`))].sort();
  const releases = [];
  try {
    for (const key of keys) {
      const previous = skillLocks.get(key) ?? Promise.resolve();
      let release;
      const current = new Promise((resolvePromise) => { release = resolvePromise; });
      const queued = previous.then(() => current);
      skillLocks.set(key, queued);
      await previous;
      releases.push(() => {
        release();
        if (skillLocks.get(key) === queued) skillLocks.delete(key);
      });
    }
    return await operation();
  } finally {
    for (const release of releases.reverse()) release();
  }
}

async function withSkillLock(root, name, operation) {
  return withSkillLocks(root, [name], operation);
}

async function existingPath(root, scope, name) {
  const path = skillFilePath(root, scope, name);
  await assertSafeDirectoryChain(dirname(dirname(path)));
  return { path, directory: dirname(path), exists: Boolean(await entryInfo(dirname(path))) };
}

async function assertNoSkillEntry(root, scope, name) {
  const target = await existingPath(root, scope, name);
  if (target.exists) throw skillError(`Skill ${name} already exists in ${scope}.`, "WEAVE_SKILL_CONFLICT");
}

async function assertNoNameConflict(root, scope, name) {
  await assertNoSkillEntry(root, scope, name);
  const otherScope = scope === "project" ? "common" : "project";
  await assertNoSkillEntry(root, otherScope, name);
}

async function writeNewSkillFile(path, content) {
  const directory = dirname(path);
  await assertSafeDirectoryChain(dirname(directory));
  await mkdir(dirname(directory), { recursive: true });
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") throw skillError("Skill destination already exists.", "WEAVE_SKILL_CONFLICT");
    throw error;
  }
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(content, "utf8");
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await handle?.close();
  }
}

async function replaceSkillFile(path, content) {
  const info = await entryInfo(path);
  if (info && (!info.isFile() || info.isSymbolicLink())) throw skillError("Skill file path is not a regular file.", "WEAVE_SKILL_INVALID");
  const tempPath = join(dirname(path), `.${skillFileName}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, info ? info.mode & 0o7777 : 0o600);
    await handle.writeFile(content, "utf8");
    await handle.close();
    handle = null;
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await handle?.close();
  }
}

async function copySkillTree(sourcePath, targetPath) {
  await assertSafeDirectoryChain(dirname(sourcePath));
  await assertSafeDirectoryChain(dirname(targetPath));
  await assertSafeSkillTree(sourcePath);
  const sourceInfo = await lstat(sourcePath);
  await mkdir(dirname(targetPath), { recursive: true });
  await mkdir(targetPath, { mode: sourceInfo.mode & 0o7777 });
  const entries = await readdir(sourcePath, { withFileTypes: true });
  for (const entry of entries) {
    const sourceEntry = join(sourcePath, entry.name);
    const targetEntry = join(targetPath, entry.name);
    const entryInfoValue = await entryInfo(sourceEntry);
    if (!entryInfoValue || entryInfoValue.isSymbolicLink()) throw skillError("Skill folders cannot contain symbolic links.", "WEAVE_SKILL_INVALID");
    if (entryInfoValue.isDirectory()) {
      await copySkillTree(sourceEntry, targetEntry);
    } else if (entryInfoValue.isFile()) {
      await copyFile(sourceEntry, targetEntry);
      await chmod(targetEntry, entryInfoValue.mode & 0o7777);
    } else {
      throw skillError("Skill folders can only contain regular files and directories.", "WEAVE_SKILL_INVALID");
    }
  }
}

async function moveSkillTree(sourcePath, targetPath) {
  await assertSafeDirectoryChain(dirname(sourcePath));
  await assertSafeDirectoryChain(dirname(targetPath));
  await assertSafeSkillTree(sourcePath);
  if (await entryInfo(targetPath)) throw skillError("Skill destination already exists.", "WEAVE_SKILL_CONFLICT");
  await mkdir(dirname(targetPath), { recursive: true });
  try {
    await rename(sourcePath, targetPath);
    return;
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
  }

  const stagingPath = join(dirname(targetPath), `.${basename(targetPath)}.move-${randomUUID()}`);
  try {
    await copySkillTree(sourcePath, stagingPath);
    await rename(stagingPath, targetPath);
    try {
      await rm(sourcePath, { recursive: true, force: false });
    } catch (error) {
      await rm(targetPath, { recursive: true, force: false }).catch(() => {});
      throw error;
    }
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function removeSkillTree(path) {
  await assertSafeDirectoryChain(dirname(path));
  await assertSafeSkillDirectory(path);
  await rm(path, { recursive: true, force: false });
}

export async function createProjectSkillSnapshot(root) {
  const projectRoot = requireProjectRoot(root);
  const sourcePath = skillRoot(projectRoot, "project");
  const snapshotRoot = await mkdtemp(join(tmpdir(), "weave-project-skills-"));
  const sourceInfo = await entryInfo(sourcePath);
  if (!sourceInfo) return { snapshotRoot, hadSkills: false };
  try {
    await assertSafeSkillTree(sourcePath);
    await copySkillTree(sourcePath, join(snapshotRoot, "skills"));
    return { snapshotRoot, hadSkills: true };
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function restoreProjectSkillSnapshot(root, snapshot) {
  const projectRoot = requireProjectRoot(root);
  if (!snapshot || typeof snapshot.snapshotRoot !== "string" || typeof snapshot.hadSkills !== "boolean") throw skillError("Project skill snapshot is invalid.", "WEAVE_SKILL_INVALID");
  const targetPath = skillRoot(projectRoot, "project");
  const codexDirectory = dirname(targetPath);
  await assertSafeDirectoryChain(dirname(codexDirectory));
  const codexInfo = await entryInfo(codexDirectory);
  if (codexInfo && (!codexInfo.isDirectory() || codexInfo.isSymbolicLink())) await rm(codexDirectory, { recursive: true, force: false });
  await mkdir(codexDirectory, { recursive: true });
  const targetInfo = await entryInfo(targetPath);
  if (targetInfo) await rm(targetPath, { recursive: true, force: false });
  if (snapshot.hadSkills) await copySkillTree(join(snapshot.snapshotRoot, "skills"), targetPath);
  await rm(snapshot.snapshotRoot, { recursive: true, force: true });
}

export async function discardProjectSkillSnapshot(snapshot) {
  if (!snapshot || typeof snapshot.snapshotRoot !== "string") return;
  await rm(snapshot.snapshotRoot, { recursive: true, force: true });
}

export async function listSkills(root, scope = undefined) {
  const projectRoot = requireProjectRoot(root);
  const scopes = scope === undefined ? skillScopes : [validateSkillScope(scope)];
  const result = [];
  for (const currentScope of scopes) {
    const directory = skillRoot(projectRoot, currentScope);
    await assertSafeDirectoryChain(directory);
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (isMissing(error)) return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !skillNamePattern.test(entry.name) || entry.name.length >= 64) continue;
      try {
        const document = await readSkillDocument(projectRoot, currentScope, entry.name);
        result.push(publicSkill(document));
      } catch (error) {
        result.push(await invalidPublicSkill(projectRoot, currentScope, entry.name, error));
      }
    }
  }
  return result.sort((left, right) => left.scope.localeCompare(right.scope) || left.name.localeCompare(right.name));
}

export async function createSkill(root, input) {
  const projectRoot = requireProjectRoot(root);
  if (!input || typeof input !== "object") throw skillError("Skill payload is required.", "WEAVE_SKILL_INVALID");
  const scope = validateSkillScope(input.scope);
  const name = validateSkillName(input.name);
  const description = requireSkillDescription(input.description);
  const body = requireSkillBody(input.body);
  const content = serializeSkillDocument({ name, description, body, unknownFrontmatter: input.frontmatter });
  return withSkillLock(projectRoot, name, async () => {
    await assertNoNameConflict(projectRoot, scope, name);
    await writeNewSkillFile(skillFilePath(projectRoot, scope, name), content);
    return publicSkill(await readSkillDocument(projectRoot, scope, name));
  });
}

export async function updateSkill(root, input) {
  const projectRoot = requireProjectRoot(root);
  if (!input || typeof input !== "object") throw skillError("Skill payload is required.", "WEAVE_SKILL_INVALID");
  const scope = validateSkillScope(input.scope);
  if (typeof input.currentName !== "string") throw skillError("Current skill name is required.", "WEAVE_SKILL_INVALID");
  const currentName = validateSkillName(input.currentName);
  if (typeof input.name !== "string") throw skillError("Skill name is required.", "WEAVE_SKILL_INVALID");
  const nextName = validateSkillName(input.name);
  const description = requireSkillDescription(input.description);
  const body = requireSkillBody(input.body);
  if (!("frontmatter" in input)) throw skillError("Skill frontmatter must be provided as text or null.", "WEAVE_SKILL_INVALID");
  return withSkillLocks(projectRoot, [currentName, nextName], async () => {
    const currentPath = skillFilePath(projectRoot, scope, currentName);
    await assertSafeSkillDirectory(dirname(currentPath));
    const currentInfo = await entryInfo(currentPath);
    if (currentInfo && (!currentInfo.isFile() || currentInfo.isSymbolicLink())) throw skillError("Skill file path is not a regular file.", "WEAVE_SKILL_INVALID");
    const content = serializeSkillDocument({ name: nextName, description, body, unknownFrontmatter: input.frontmatter });
    if (nextName !== currentName) {
      await assertNoNameConflict(projectRoot, scope, nextName);
      const targetPath = skillFilePath(projectRoot, scope, nextName);
      await moveSkillTree(dirname(currentPath), dirname(targetPath));
      try {
        await replaceSkillFile(targetPath, content);
      } catch (error) {
        await moveSkillTree(dirname(targetPath), dirname(currentPath)).catch(() => {});
        throw error;
      }
    } else {
      await replaceSkillFile(currentPath, content);
    }
    return publicSkill(await readSkillDocument(projectRoot, scope, nextName));
  });
}

export async function deleteSkill(root, scope, name) {
  const projectRoot = requireProjectRoot(root);
  const validatedScope = validateSkillScope(scope);
  const validatedName = validateSkillName(name);
  return withSkillLock(projectRoot, validatedName, async () => {
    const path = skillFilePath(projectRoot, validatedScope, validatedName);
    await assertSafeSkillDirectory(dirname(path));
    await removeSkillTree(dirname(path));
    return { name: validatedName, scope: validatedScope, deleted: true };
  });
}

async function moveSkill(root, sourceScope, targetScope, name) {
  const projectRoot = requireProjectRoot(root);
  const validatedSource = validateSkillScope(sourceScope);
  const validatedTarget = validateSkillScope(targetScope);
  const validatedName = validateSkillName(name);
  return withSkillLock(projectRoot, validatedName, async () => {
    const current = await readSkillDocument(projectRoot, validatedSource, validatedName);
    await assertNoSkillEntry(projectRoot, validatedTarget, validatedName);
    const targetPath = skillFilePath(projectRoot, validatedTarget, validatedName);
    await moveSkillTree(dirname(current.path), dirname(targetPath));
    return publicSkill(await readSkillDocument(projectRoot, validatedTarget, validatedName));
  });
}

export async function promoteSkill(root, name) {
  return moveSkill(root, "project", "common", name);
}

export async function demoteSkill(root, name) {
  return moveSkill(root, "common", "project", name);
}

export async function uploadSkill(root, input) {
  const projectRoot = requireProjectRoot(root);
  if (!input || typeof input !== "object") throw skillError("Skill upload payload is required.", "WEAVE_SKILL_INVALID");
  const scope = validateSkillScope(input.scope);
  if (input.filename !== skillFileName) throw skillError("Upload a file named SKILL.md.", "WEAVE_SKILL_INVALID");
  if (typeof input.content !== "string") throw skillError("Skill upload content is required.", "WEAVE_SKILL_INVALID");
  const parsed = parseSkillDocument(input.content);
  const content = serializeSkillDocument({ name: parsed.name, description: parsed.description, body: parsed.body, unknownFrontmatter: parsed.unknownFrontmatter });
  return withSkillLock(projectRoot, parsed.name, async () => {
    await assertNoNameConflict(projectRoot, scope, parsed.name);
    await writeNewSkillFile(skillFilePath(projectRoot, scope, parsed.name), content);
    return publicSkill(await readSkillDocument(projectRoot, scope, parsed.name));
  });
}
