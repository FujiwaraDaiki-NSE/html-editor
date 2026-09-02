import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acceptVariation,
  agentInstructions,
  assertCommittable,
  archiveVariation,
  checkoutHistory,
  checkoutMain,
  checkoutVariation,
  commitIfChanged,
  createVariationBranch,
  discardVariation,
  ensureProject,
  initializeCurrentProject,
  importImageAsset,
  assetMimeTypes,
  importReference,
  importReferenceFolder,
  listFolders,
  readReferences,
  removeReference,
  syncReferenceFolder,
  projectRoot,
  listProjects,
  createProject,
  renameProject,
  duplicateProject,
  archiveProject,
  assertSwitchable,
  switchProject,
  projectState,
  getVariationPreviews,
  readProject,
  readDeckCss,
  readTemplates,
  restoreDeckCss,
  assertAssetFilename,
  projectAssetPath,
  writeProject,
  writeProjectUnlocked,
  runProjectExclusive,
  saveProject,
  saveDraft,
  createMilestone,
  createRecoverySnapshot,
  updateRecoverySnapshot,
  readAllRecoverySnapshots,
  discardRecoverySnapshot,
  createAgentFileSnapshot,
  captureAgentFilePreservation,
  restoreAgentFileSnapshot,
  discardAgentFileSnapshot,
  getRevision,
  setVariationState,
  listVariationSessions,
  importVariationSlides,
} from "./project.mjs";
import {
  createSkill,
  createProjectSkillSnapshot,
  deleteSkill,
  demoteSkill,
  discardProjectSkillSnapshot,
  listSkills,
  promoteSkill,
  restoreProjectSkillSnapshot,
  updateSkill,
  uploadSkill,
} from "./skills.mjs";
import { CodexService } from "./codex/service.mjs";
import { annotationPromptRules, canSendTurn } from "../shared/annotation.mjs";
import { contextPromptRules, editorEnvelope, isReferencePath } from "../shared/context.mjs";
import { createEditorChangeSet, htmlChangeWithinElement, mergeEditorDecks, validateWorkflowRequest } from "../shared/editor-workflow.mjs";
import { parseConfiguredPort } from "../scripts/dev-port.mjs";
import { isAllowedWebOrigin } from "./dev-origin.mjs";
import { routeMethodDecision } from "./route-methods.mjs";
import { ProjectPreviewMonitor } from "./project-preview.mjs";

const apiPort = Number(process.env.WEAVE_API_PORT ?? 4317);
await initializeCurrentProject();
const webPort = parseConfiguredPort(process.env.WEAVE_WEB_PORT);
const codex = new CodexService({ projectRoot: projectRoot(), instructions: agentInstructions });
let codexProjectRoot = projectRoot();
// Pending work is keyed by thread but every entry carries its immutable project
// root. This allows project switching while another project's turn is settling.
const pendingTurns = new Map();
const startingRoots = new Set();
const recoveredSnapshots = await readAllRecoverySnapshots();
for (const snapshot of recoveredSnapshots) {
  if (snapshot.agentFileSnapshot) await restoreAgentManagedFiles(snapshot);
  await runProjectExclusive(async () => {
    await writeProjectUnlocked(snapshot.humanDraft ?? snapshot.baseDeck, null, snapshot.root);
    await restoreDeckCss(snapshot.baseCss, snapshot.root);
  }, snapshot.root);
}
const recoveryTasks = new Map(recoveredSnapshots.map((snapshot) => [snapshot.root, snapshot]));
const completedSaves = new Map();
const recentAgentMerges = new Map();
let projectSwitchQueue = Promise.resolve();
let projectLifecycleBusy = false;
const migrationNotice = "Legacy .weave/chat.json history was removed. Conversations now use Codex app-server Threads only.";

function pendingTurn(value) {
  let resolveFinalization;
  const finalization = new Promise((resolve) => { resolveFinalization = resolve; });
  return {
    ...value,
    turnId: null,
    previewSnapshot: null,
    previewChangedSlideIds: [],
    previewSequence: 0,
    previewMonitor: null,
    humanDraft: null,
    queuedMilestone: null,
    humanFilePaths: [],
    humanReferenceEntries: [],
    humanReferenceRemovals: [],
    acceptingDrafts: true,
    finalization,
    resolveFinalization,
  };
}

function finishPendingTurn(threadId, pending) {
  pendingTurns.delete(threadId);
  pending.resolveFinalization();
  if (pendingTurns.size === 0 && codexProjectRoot !== projectRoot()) {
    void enqueueProjectSwitch(async () => {
      const targetRoot = projectRoot();
      if (pendingTurns.size === 0 && codexProjectRoot !== targetRoot) await retargetCodex(targetRoot);
    }).catch(() => {});
  }
}

function hasAllowedOrigin(request) {
  return isAllowedWebOrigin(request.headers.origin, webPort, request.headers.host);
}

function corsHeaders(request) {
  const origin = request.headers.origin;
  const headers = {
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
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

async function sendAsset(request, response, filename, filePath) {
  try {
    assertAssetFilename(filename);
    const bytes = await readFile(filePath);
    const extension = filename.split(".").pop().toLowerCase();
    const mimeType = assetMimeTypes.get(extension);
    if (!mimeType) throw new Error("Unsupported asset type.");
    response.writeHead(200, { ...corsHeaders(request), "content-type": mimeType, "cache-control": "public, max-age=31536000, immutable" });
    response.end(bytes);
  } catch {
    sendJson(request, response, 404, { error: "Asset not found." });
  }
}

async function readJson(request, limit = 1_500_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request is too large."), { code: "WEAVE_REQUEST_TOO_LARGE" });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { code: "WEAVE_INVALID_JSON" });
  }
}

async function statePayload() {
  const state = projectState();
  const activePendingEntry = [...pendingTurns.entries()].find(([, turn]) => turn.root === projectRoot());
  const activePending = activePendingEntry?.[1];
  const generatingBranches = new Set([...pendingTurns.values()].map((turn) => turn.branch).filter(Boolean));
  const backgroundTasks = {};
  for (const task of recoveryTasks.values()) {
    const slug = String(task.root ?? "").split(/[\\/]/).filter(Boolean).pop() ?? task.root;
    (backgroundTasks[slug] ??= []).push(task);
  }
  for (const pending of pendingTurns.values()) {
    const slug = String(pending.root ?? "").split(/[\\/]/).filter(Boolean).pop() ?? pending.root;
    (backgroundTasks[slug] ??= []).push({
      threadId: pending.threadId,
      turnId: pending.turnId,
      status: pending.turnId ? "running" : "starting",
      variation: Boolean(pending.variation),
      branch: pending.branch,
      baseRevision: pending.baseRevision,
      baseDeck: pending.baseDeck,
      recoverySnapshot: pending.recoverySnapshot ? { id: pending.recoverySnapshot.id, baseRevision: pending.recoverySnapshot.baseRevision } : null,
    });
  }
  for (const project of await listProjects()) if (!backgroundTasks[project.slug]) backgroundTasks[project.slug] = [];
  return {
    deck: activePending?.humanDraft ?? activePending?.previewSnapshot ?? activePending?.preTurnDeck ?? recoveryTasks.get(projectRoot())?.humanDraft ?? recoveryTasks.get(projectRoot())?.baseDeck ?? await readProject(),
    css: await readDeckCss(),
    templates: await readTemplates(),
    references: await readReferences(),
    ...state,
    project: { ...state.project, backgroundTasks: backgroundTasks[String(projectRoot()).split(/[\\/]/).filter(Boolean).pop()] ?? [] },
    backgroundTasks,
    variations: state.variations.map((variation) => ({
      ...variation,
      status: generatingBranches.has(variation.branch) ? "generating" : variation.state ?? "ready",
    })),
    codex: {
      ready: codex.ready,
      projectReady: codexProjectRoot === projectRoot(),
      connection: codex.connection,
      version: codex.version,
      catalog: codex.catalog,
      activeTurns: Object.fromEntries(codex.activeTurns),
      pendingRequests: codex.router.list(),
    },
    skills: await listSkills(projectRoot()),
    agentPreview: activePending ? {
      threadId: activePendingEntry[0],
      turnId: activePending.turnId,
      baseline: activePending.preTurnDeck,
      changedSlideIds: activePending.previewChangedSlideIds,
      previewSequence: activePending.previewSequence,
      phase: !activePending.previewMonitor ? "checking" : activePending.previewMonitor.running ? "editing" : "finalizing",
    } : null,
    migrationNotice,
  };
}

function startProjectPreview(pending, threadId, turnId) {
  pending.turnId = turnId;
  pending.previewSnapshot = pending.preTurnDeck;
  pending.previewChangedSlideIds = [];
  pending.previewSequence = 0;
  pending.previewMonitor = new ProjectPreviewMonitor({
    baseline: pending.preTurnDeck,
    readSnapshot: async () => {
      await assertCommittable(pending.root);
      return await readProject(pending.root);
    },
    onSnapshot: (snapshot) => { pending.previewSnapshot = snapshot; },
    pollInterval: 300,
    settleMs: 400,
    minPublishInterval: 700,
    now: Date.now,
    setIntervalFn: setInterval,
    clearIntervalFn: clearInterval,
    publish: ({ changedSlideIds, previewSequence }) => {
      pending.previewChangedSlideIds = [...new Set([...pending.previewChangedSlideIds, ...changedSlideIds])];
      pending.previewSequence = previewSequence;
      codex.events.publish("weave/project", {
        status: "preview",
        projectRoot: pending.root,
        threadId,
        turnId,
        changedSlideIds,
        previewSequence,
      });
    },
  }).start();
}

async function refreshSkillCatalog() {
  if (!codex.ready || codexProjectRoot !== projectRoot()) return;
  try {
    await codex.refreshCatalog();
  } catch {
    // Skill files remain authoritative even when the optional Codex catalog is offline.
  }
}

async function runSkillMutation(operation) {
  return enqueueProjectSwitch(async () => {
    if (activeProjectTurn()) throw Object.assign(new Error("Finish the running Agent turn before changing skills."), { code: "WEAVE_TURN_RUNNING" });
    const root = projectRoot();
    const skill = await operation(root);
    await refreshSkillCatalog();
    return { skill, skills: await listSkills(root), project: projectState().project };
  });
}

async function clearRecoveryTask(root) {
  const recovery = recoveryTasks.get(root);
  recoveryTasks.delete(root);
  if (!recovery) return;
  await discardRecoverySnapshot(recovery, root);
  if (recovery.agentFileSnapshot) await discardAgentFileSnapshot(recovery.agentFileSnapshot, root);
}

function recoveryReferenceEntry(entry) {
  if (!entry || !isReferencePath(entry.path)) return null;
  const stored = { ...entry };
  delete stored.missing;
  delete stored.sourceMissing;
  return stored;
}

async function restoreAgentManagedFiles(task, { preserveSkills = false } = {}) {
  const preserve = [...new Set([...(task.humanFilePaths ?? task.humanAssetPaths ?? []), ...(preserveSkills ? [".codex/skills"] : [])])];
  await restoreAgentFileSnapshot(task.agentFileSnapshot, task.root, { preserve });
  if (!(task.humanReferenceEntries?.length || task.humanReferenceRemovals?.length)) return;
  const indexPath = join(task.root, "references", "index.json");
  const base = JSON.parse(await readFile(indexPath, "utf8").catch(() => "{\"entries\":[]}"));
  const entries = new Map((Array.isArray(base.entries) ? base.entries : []).filter((entry) => entry?.path).map((entry) => [entry.path, entry]));
  for (const path of task.humanReferenceRemovals ?? []) {
    if (!isReferencePath(path)) continue;
    entries.delete(path);
    await rm(join(task.root, path), { recursive: true, force: true });
  }
  for (const entry of task.humanReferenceEntries ?? []) {
    const stored = recoveryReferenceEntry(entry);
    if (stored) entries.set(stored.path, stored);
  }
  await mkdir(join(task.root, "references"), { recursive: true });
  await writeFile(indexPath, `${JSON.stringify({ entries: [...entries.values()] }, null, 2)}\n`);
}

async function recordHumanFileMutation(pending, { path, entry = null, remove = false }) {
  if (!pending || typeof path !== "string" || !pending.acceptingDrafts || pendingTurns.get(pending.threadId) !== pending) return;
  pending.humanFilePaths = (pending.humanFilePaths ?? []).filter((item) => item !== path);
  pending.humanReferenceEntries = (pending.humanReferenceEntries ?? []).filter((item) => item?.path !== path);
  pending.humanReferenceRemovals = (pending.humanReferenceRemovals ?? []).filter((item) => item !== path);
  if (remove) pending.humanReferenceRemovals.push(path);
  else {
    await captureAgentFilePreservation(pending.agentFileSnapshot, path, pending.root);
    pending.humanFilePaths.push(path);
    if (entry) pending.humanReferenceEntries.push(recoveryReferenceEntry(entry));
  }
  await updateRecoverySnapshot(pending.recoverySnapshot, {
    humanFilePaths: pending.humanFilePaths,
    humanReferenceEntries: pending.humanReferenceEntries,
    humanReferenceRemovals: pending.humanReferenceRemovals,
  }, pending.root);
}

async function retargetCodex(targetRoot = projectRoot()) {
  try {
    const previousRoot = codexProjectRoot;
    await codex.setProjectRoot(targetRoot);
    codexProjectRoot = targetRoot;
    if (previousRoot !== codexProjectRoot) codex.events.publish("weave/project", { status: "agent-ready", ...projectState() });
  } catch (error) {
    codex.publishIncompatible(error, "project retarget");
  }
}

function enqueueProjectSwitch(operation) {
  const next = projectSwitchQueue.then(operation, operation);
  projectSwitchQueue = next.catch(() => {});
  return next;
}

function requireText(value, name, limit = 20_000) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} is required.`);
  if (text.length > limit) throw new Error(`${name} must be ${limit.toLocaleString()} characters or fewer.`);
  return text;
}

function decodeSkillName(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw Object.assign(new Error("Skill name is invalid."), { code: "WEAVE_SKILL_INVALID" });
  }
}

function requireTurnPrompt(payload) {
  const text = String(payload.prompt ?? "");
  const annotations = Array.isArray(payload.contextEnvelope?.annotations) ? payload.contextEnvelope.annotations : [];
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  if (!canSendTurn(text, annotations) && attachments.length === 0) throw new Error("Prompt text, an annotation, or an attachment is required.");
  return text.trim() ? requireText(text, "Prompt") : annotations.length > 0 ? "Use the attached editor annotations as the request for this turn." : "Read the attached files and act on them.";
}

function activeProjectTurn() {
  const root = projectRoot();
  return startingRoots.has(root) || [...pendingTurns.values()].some((turn) => turn.root === root)
    || (pendingTurns.size === 0 && codex.activeTurns.size > 0);
}

function agentStartBlocked() {
  return projectLifecycleBusy || startingRoots.size > 0 || pendingTurns.size > 0 || codexProjectRoot !== projectRoot() || codex.activeTurns.size > 0;
}

async function runProjectLifecycle(operation, { allowPending = false } = {}) {
  if (projectLifecycleBusy || startingRoots.size > 0 || (!allowPending && (pendingTurns.size > 0 || recoveryTasks.size > 0))) {
    throw Object.assign(new Error("Project lifecycle actions are unavailable while an Agent task is starting or running."), { code: "WEAVE_TURN_RUNNING" });
  }
  projectLifecycleBusy = true;
  try { return await operation(); } finally { projectLifecycleBusy = false; }
}

function workflowFromPayload(payload) {
  const envelope = editorEnvelope(payload.contextEnvelope);
  if (!envelope.modificationScope) throw new Error("A modification scope is required.");
  if (!envelope.executionMode) throw new Error("An execution mode is required.");
  return {
    scope: envelope.modificationScope,
    execution: envelope.executionMode,
    allowSkillChanges: envelope.executionMode === "apply" && envelope.allowSkillChanges === true,
  };
}

function validateAgentResult(workflow, base, agent) {
  const changeSet = createEditorChangeSet(base, agent, "Agent turn");
  const scope = workflow.scope;
  if (scope.kind === "element") {
    const changedSlides = new Set(changeSet.changes.map((change) => change.slideId).filter(Boolean));
    const baseSlide = base.slides.find((slide) => slide.id === scope.slideIds[0]);
    const agentSlide = agent.slides.find((slide) => slide.id === scope.slideIds[0]);
    const onlyHtmlChanged = changeSet.changes.every((change) => change.slideId === scope.slideIds[0] && change.key === "html");
    const ok = changedSlides.size <= 1 && Boolean(baseSlide && agentSlide) && onlyHtmlChanged
      && htmlChangeWithinElement(baseSlide.html, agentSlide.html, scope.elementId);
    return { ok, changeSet, violations: ok ? [] : [{ reason: "change-out-of-element-scope", slideId: scope.slideIds[0], elementId: scope.elementId }] };
  }
  const checked = validateWorkflowRequest({
    scope: scope.kind,
    execution: workflow.execution,
    changes: changeSet.changes,
    ...(scope.kind === "current-slide" ? { currentSlideId: scope.slideIds[0] } : {}),
    ...(scope.kind === "selected-slides" ? { selectedSlideIds: scope.slideIds } : {}),
  });
  return { ...checked, changeSet };
}

function serializeEditorContext(payload) {
  if (!payload.contextEnvelope || typeof payload.contextEnvelope !== "object") return "";
  const envelope = editorEnvelope(payload.contextEnvelope);
  if (Object.keys(envelope).length === 0) return "";
  const annotations = Array.isArray(envelope.annotations) ? envelope.annotations : [];
  const annotationRules = annotations.length > 0 ? `\n\nAnnotation interpretation rules:\n${annotationPromptRules}` : "";
  return `\n\nEditor context envelope:\n${JSON.stringify(envelope)}\n\nContext rules:\n${contextPromptRules}${annotationRules}`;
}

async function startEditorTurn(payload, { variation = false } = {}) {
  if (agentStartBlocked()) throw new Error("Another Agent task is running. Editing remains available and Agent will reconnect to this project when it finishes.");
  const prompt = requireTurnPrompt(payload);
  const workflow = workflowFromPayload(payload);
  const root = projectRoot();
  startingRoots.add(root);
  let branch = null;
  let registeredPending = null;
  let registeredThreadId = null;
  let projectSkillSnapshot = null;
  let recoverySnapshot = null;
  let agentFileSnapshot = null;
  try {
    await clearRecoveryTask(root);
    if (variation) {
      branch = createVariationBranch();
      await setVariationState(branch, "pending", projectRoot());
    }
    const deck = await writeProject(payload.deck, null, root);
    const preTurnCss = await readDeckCss(root);
    agentFileSnapshot = await createAgentFileSnapshot(root);
    projectSkillSnapshot = await createProjectSkillSnapshot(root);
    recoverySnapshot = await createRecoverySnapshot({ baseRevision: getRevision(root), deck, css: preTurnCss, agentFileSnapshot }, root);
    const thread = await codex.startThread({
      approvalPolicy: payload.approvalPolicy ?? "never",
      model: payload.model,
    });
    registeredPending = pendingTurn({ prompt, branch, variation, workflow, deckTitle: deck.title, root, preTurnDeck: deck, baseDeck: deck, baseRevision: recoverySnapshot.baseRevision, preTurnCss, projectSkillSnapshot, recoverySnapshot, agentFileSnapshot });
    registeredPending.threadId = thread.id;
    registeredThreadId = thread.id;
    pendingTurns.set(thread.id, registeredPending);
    startingRoots.delete(root);
    const context = `${variation ? "Create a meaningfully different, polished direction. " : ""}User request: ${prompt}

The latest editor state has been written to slides/*.html.
Inspect the current project and edit the slides/*.html files directly. Do not edit styles/deck.css.
Do not commit; Weave will commit after this turn.${serializeEditorContext(payload)}`;
    const result = await codex.startTurn({
      threadId: thread.id,
      prompt: context,
      clientUserMessageId: payload.clientUserMessageId,
      model: payload.model,
      effort: payload.effort,
      approvalPolicy: payload.approvalPolicy ?? "never",
    });
    startProjectPreview(registeredPending, thread.id, result.turn.id);
    await updateRecoverySnapshot(recoverySnapshot, { workflow, status: "running", threadId: thread.id, turnId: result.turn.id }, root);
    return { thread, turn: result.turn, branch };
  } catch (error) {
    startingRoots.delete(root);
    if (registeredPending && registeredThreadId) finishPendingTurn(registeredThreadId, registeredPending);
    if (variation && branch) discardVariation(branch, root);
    if (projectSkillSnapshot) await restoreProjectSkillSnapshot(root, projectSkillSnapshot);
    await discardProjectSkillSnapshot(projectSkillSnapshot);
    if (agentFileSnapshot) {
      await restoreAgentFileSnapshot(agentFileSnapshot, root);
      await discardAgentFileSnapshot(agentFileSnapshot, root);
    }
    if (recoverySnapshot) await discardRecoverySnapshot(recoverySnapshot, root);
    if (variation && branch) {
      await writeProjectUnlocked(recoverySnapshot?.baseDeck ?? payload.deck, null, root);
      if (recoverySnapshot) await restoreDeckCss(recoverySnapshot.baseCss, root);
    }
    throw error;
  }
}

async function restoreFailedTurn(pending) {
  await runProjectExclusive(async () => {
    if (pending.variation) {
      const current = await readProject(pending.root).catch(() => null);
      if (pending.branch && current && JSON.stringify(current) === JSON.stringify(pending.baseDeck)) discardVariation(pending.branch, pending.root);
      else if (pending.branch) await setVariationState(pending.branch, "paused", pending.root);
    }
    await restoreAgentManagedFiles(pending);
    await writeProjectUnlocked(pending.humanDraft ?? pending.baseDeck, null, pending.root);
    await restoreDeckCss(pending.preTurnCss, pending.root);
    await restoreProjectSkillSnapshot(pending.root, pending.projectSkillSnapshot);
  }, pending.root);
}

codex.on("notification", (message) => {
  if (message.method !== "turn/completed") return;
  const threadId = message.params?.threadId;
  const pending = pendingTurns.get(threadId);
  if (!pending) return;
  pending.acceptingDrafts = false;
  pending.previewMonitor?.stop();
  void (async () => {
    const status = message.params?.turn?.status;
    if (status !== "completed") {
      let cleanupError;
      try {
        await restoreFailedTurn(pending);
        pending.previewSnapshot = pending.preTurnDeck;
      } catch (error) {
        cleanupError = error;
      }
      codex.events.publish("weave/project", {
        status: cleanupError ? "error" : status,
        projectRoot: pending.root,
        threadId,
        turnId: pending.turnId,
        ...(cleanupError ? { error: `Could not restore the project after the Agent turn: ${cleanupError.message}` } : {}),
        ...(cleanupError ? { cleanupError: cleanupError.message } : {}),
      });
      await updateRecoverySnapshot(pending.recoverySnapshot, { status: "failed", humanDraft: pending.humanDraft, queuedMilestone: pending.queuedMilestone }, pending.root).catch((recoveryError) => console.error("Could not persist failed Agent recovery:", recoveryError));
      recoveryTasks.set(pending.root, { ...pending.recoverySnapshot, root: pending.root, threadId, turnId: pending.turnId, status: "failed" });
      await discardProjectSkillSnapshot(pending.projectSkillSnapshot);
      finishPendingTurn(threadId, pending);
      return;
    }
    try {
      await runProjectExclusive(async () => {
        const agentDeck = await readProject(pending.root);
        const scopeCheck = validateAgentResult(pending.workflow, pending.baseDeck, agentDeck);
        if (!scopeCheck.ok) throw Object.assign(new Error("Agent result exceeded the selected modification scope."), { code: "WEAVE_SCOPE_VIOLATION", diagnostics: scopeCheck.violations });
        const currentDraft = pending.humanDraft ?? pending.baseDeck;
        const applyResult = pending.workflow.execution === "apply";
        const merged = applyResult ? mergeEditorDecks({ base: pending.baseDeck, agent: agentDeck, current: currentDraft, scope: pending.workflow.scope.kind }) : { deck: currentDraft, conflicts: [], ok: true };
        await restoreAgentManagedFiles(pending, { preserveSkills: pending.workflow.allowSkillChanges });
        await writeProjectUnlocked(merged.deck, null, pending.root);
        if (!pending.workflow.allowSkillChanges) await restoreProjectSkillSnapshot(pending.root, pending.projectSkillSnapshot);
        pending.changeSet = scopeCheck.changeSet;
        pending.conflicts = merged.conflicts;
        /* Ordinary Agent edits remain an unsaved working result. A variation needs a
           commit because its branch is the durable unit switched by the direction tabs. */
        if (pending.variation) {
          await assertCommittable(pending.root);
          commitIfChanged(`Variation: ${pending.prompt.replace(/\s+/g, " ").slice(0, 100)}`, pending.root);
          await setVariationState(pending.branch, "ready", pending.root);
        } else {
          await assertCommittable(pending.root);
        }
        if (pending.queuedMilestone) commitIfChanged(`Milestone: ${pending.queuedMilestone}`, pending.root);
      }, pending.root);
      pending.previewSnapshot = await readProject(pending.root);
      pending.humanDraft = pending.previewSnapshot;
      recentAgentMerges.set(pending.root, { base: pending.baseDeck, agent: pending.previewSnapshot, expiresAt: Date.now() + 10_000 });
      recoveryTasks.delete(pending.root);
      await discardRecoverySnapshot(pending.recoverySnapshot, pending.root);
      codex.events.publish("weave/project", {
        status: "updated",
        projectRoot: pending.root,
        threadId,
        turnId: pending.turnId,
        baseline: pending.preTurnDeck,
        changes: pending.changeSet,
        conflicts: pending.conflicts,
        executionMode: pending.workflow.execution,
        milestone: pending.queuedMilestone,
        deck: await readProject(pending.root),
      });
    } catch (error) {
      let cleanupError;
      try {
        await restoreFailedTurn(pending);
        pending.previewSnapshot = pending.preTurnDeck;
      } catch (restoreError) {
        cleanupError = restoreError;
      }
      await updateRecoverySnapshot(pending.recoverySnapshot, { status: "failed", error: error.message, humanDraft: pending.humanDraft, queuedMilestone: pending.queuedMilestone }, pending.root).catch((recoveryError) => console.error("Could not persist failed Agent recovery:", recoveryError));
      recoveryTasks.set(pending.root, { ...pending.recoverySnapshot, root: pending.root, threadId, turnId: pending.turnId, status: "failed", error: error.message });
      codex.events.publish("weave/project", {
        status: "error",
        projectRoot: pending.root,
        error: error.message,
        threadId,
        turnId: pending.turnId,
        ...(error.code ? { code: error.code } : {}),
        ...(Array.isArray(error.diagnostics) ? { diagnostics: error.diagnostics } : {}),
        ...(cleanupError ? { cleanupError: cleanupError.message } : {}),
      });
    } finally {
      await discardProjectSkillSnapshot(pending.projectSkillSnapshot);
      if (!recoveryTasks.has(pending.root)) await discardAgentFileSnapshot(pending.agentFileSnapshot, pending.root);
      finishPendingTurn(threadId, pending);
    }
  })();
});

const server = createServer(async (request, response) => {
  try {
    if (!hasAllowedOrigin(request)) return sendJson(request, response, 403, { error: "Origin is not allowed." });
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders(request));
      return response.end();
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const requestProjectRoot = projectRoot();
    const routeMethod = routeMethodDecision(url.pathname, request.method);
    if (!routeMethod.allowed) {
      response.setHeader("allow", routeMethod.allow);
      return sendJson(request, response, 405, { error: `Method ${request.method} is not allowed.` });
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      return sendJson(request, response, 200, { ok: true, codex: codex.ready });
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      return sendJson(request, response, 200, await statePayload());
    }
    if (request.method === "GET" && url.pathname === "/api/variations/compare") {
      if (activeProjectTurn()) return sendJson(request, response, 409, { error: "An Agent turn is running." });
      return sendJson(request, response, 200, { previews: getVariationPreviews() });
    }
    if (request.method === "GET" && url.pathname === "/api/variations") {
      return sendJson(request, response, 200, { variations: listVariationSessions() });
    }
    if (request.method === "GET" && url.pathname === "/api/projects") {
      return sendJson(request, response, 200, { projects: await listProjects() });
    }
    if (request.method === "GET" && url.pathname === "/api/skills") {
      const scope = url.searchParams.has("scope") ? url.searchParams.get("scope") : undefined;
      return sendJson(request, response, 200, { skills: await listSkills(projectRoot(), scope) });
    }
    if (request.method === "GET" && url.pathname === "/api/folders") {
      return sendJson(request, response, 200, await listFolders(url.searchParams.get("path") || undefined));
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/assets/")) {
      const filename = url.pathname.slice("/api/assets/".length);
      let assetPath;
      try { assertAssetFilename(filename); assetPath = join(projectRoot(), "assets", filename); } catch { return sendJson(request, response, 404, { error: "Asset not found." }); }
      return sendAsset(request, response, filename, assetPath);
    }
    const projectAssetMatch = request.method === "GET" && url.pathname.match(/^\/api\/projects\/([^/]+)\/assets\/([^/]+)$/);
    if (projectAssetMatch) {
      const [, slug, filename] = projectAssetMatch;
      let assetPath;
      try { assertAssetFilename(filename); assetPath = projectAssetPath(slug, filename); } catch { return sendJson(request, response, 404, { error: "Asset not found." }); }
      return sendAsset(request, response, filename, assetPath);
    }
    if (request.method === "GET" && url.pathname === "/api/codex/events") {
      const sequence = Number(url.searchParams.get("after") ?? 0);
      response.writeHead(200, {
        ...corsHeaders(request),
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      codex.events.attach(response, Number.isFinite(sequence) ? sequence : 0);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/codex/threads") {
      return sendJson(request, response, 200, await codex.listThreads({
        searchTerm: url.searchParams.get("q"),
        archived: url.searchParams.get("archived") === "true",
        cursor: url.searchParams.get("cursor"),
      }));
    }

    if (request.method !== "GET" && request.method !== "POST" && request.method !== "PATCH" && request.method !== "DELETE") return sendJson(request, response, 404, { error: "Not found." });
    const payload = await readJson(request, url.pathname === "/api/assets" ? 14_000_000 : url.pathname === "/api/references" ? 36_000_000 : ["/api/save", "/api/draft", "/api/milestones"].includes(url.pathname) ? 5_000_000 : 1_500_000);

    if (request.method === "POST" && url.pathname === "/api/projects") {
      if (startingRoots.size > 0) return sendJson(request, response, 409, { error: "Agent setup is capturing a project. Retry project creation.", code: "WEAVE_AGENT_STARTING" });
      const result = await enqueueProjectSwitch(async () => {
        return runProjectLifecycle(async () => {
          await assertSwitchable();
          const slug = await createProject({ title: requireText(payload.title, "Title"), templateId: requireText(payload.templateId, "templateId") });
          await switchProject(slug);
          await ensureProject();
          if (pendingTurns.size === 0) await retargetCodex();
          codex.events.publish("weave/project", { status: "switched", ...projectState() });
          return { ...(await statePayload()), slug };
        }, { allowPending: true });
      });
      return sendJson(request, response, 201, result);
    }
    if (request.method === "POST" && url.pathname === "/api/projects/current") {
      if (startingRoots.size > 0) return sendJson(request, response, 409, { error: "Agent setup is capturing a project. Retry project switching.", code: "WEAVE_AGENT_STARTING" });
      const result = await enqueueProjectSwitch(async () => {
        return runProjectLifecycle(async () => {
          if (payload.interrupt === true) {
            const finalizations = [...pendingTurns.values()].map((pending) => pending.finalization);
            await Promise.all([...codex.activeTurns.keys()].map((threadId) => codex.interruptTurn(threadId)));
            await Promise.all(finalizations);
          }
          await switchProject(requireText(payload.slug, "Project id"));
          await ensureProject();
          if (pendingTurns.size === 0) await retargetCodex();
          codex.events.publish("weave/project", { status: "switched", ...projectState() });
          return await statePayload();
        }, { allowPending: true });
      });
      return sendJson(request, response, 200, result);
    }
    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(duplicate|archive))?$/);
    if (projectMatch && (startingRoots.size > 0 || pendingTurns.size > 0 || recoveryTasks.size > 0)) {
      return sendJson(request, response, 409, { error: "Project lifecycle actions are unavailable while an Agent task is running.", code: "WEAVE_TURN_RUNNING" });
    }
    if (projectMatch && request.method === "PATCH") {
      await runProjectLifecycle(() => renameProject(projectMatch[1], requireText(payload.title, "Title")));
      return sendJson(request, response, 200, { projects: await listProjects() });
    }
    if (projectMatch && request.method === "POST" && projectMatch[2] === "duplicate") {
      const slug = await runProjectLifecycle(() => duplicateProject(projectMatch[1]));
      return sendJson(request, response, 201, { slug, projects: await listProjects() });
    }
    if (projectMatch && request.method === "POST" && projectMatch[2] === "archive") {
      await runProjectLifecycle(() => archiveProject(projectMatch[1]));
      return sendJson(request, response, 200, { projects: await listProjects() });
    }

    if (activeProjectTurn() && request.method !== "GET" && /^\/api\/skills(?:\/|$)/.test(url.pathname)) {
      return sendJson(request, response, 409, { error: "Finish the running Agent turn before changing skills.", code: "WEAVE_TURN_RUNNING" });
    }

    if (request.method === "POST" && url.pathname === "/api/skills") {
      return sendJson(request, response, 201, await runSkillMutation((root) => createSkill(root, payload)));
    }
    if (request.method === "POST" && url.pathname === "/api/skills/upload") {
      return sendJson(request, response, 201, await runSkillMutation((root) => uploadSkill(root, payload)));
    }
    if (request.method === "POST" && ["/api/skills/promote", "/api/skills/demote"].includes(url.pathname)) {
      return sendJson(request, response, 200, await runSkillMutation((root) => url.pathname.endsWith("/promote") ? promoteSkill(root, payload.name) : demoteSkill(root, payload.name)));
    }
    const scopedSkillAction = url.pathname.match(/^\/api\/skills\/(project|common)\/([^/]+)\/(promote|demote)$/);
    if (request.method === "POST" && scopedSkillAction) {
      const [, sourceScope, encodedName, action] = scopedSkillAction;
      const name = decodeSkillName(encodedName);
      if ((action === "promote" && sourceScope !== "project") || (action === "demote" && sourceScope !== "common")) throw Object.assign(new Error("Skill action does not match its scope."), { code: "WEAVE_SKILL_INVALID" });
      return sendJson(request, response, 200, await runSkillMutation((root) => action === "promote"
        ? promoteSkill(root, name)
        : demoteSkill(root, name)));
    }
    const scopedSkill = url.pathname.match(/^\/api\/skills\/(project|common)\/([^/]+)$/);
    if (scopedSkill) {
      const [, scope, encodedName] = scopedSkill;
      const name = decodeSkillName(encodedName);
      if (request.method === "PATCH") {
        return sendJson(request, response, 200, await runSkillMutation((root) => updateSkill(root, { ...payload, scope, currentName: name })));
      }
      if (request.method === "DELETE") {
        return sendJson(request, response, 200, await runSkillMutation((root) => deleteSkill(root, scope, name)));
      }
    }

    if (url.pathname === "/api/assets") {
      const root = requestProjectRoot;
      if (root !== projectRoot()) return sendJson(request, response, 409, { error: "The project changed while the upload was being received.", code: "WEAVE_PROJECT_CHANGED" });
      if (startingRoots.has(root)) return sendJson(request, response, 409, { error: "Agent setup is capturing the project. Retry the upload.", code: "WEAVE_AGENT_STARTING" });
      const asset = await runProjectLifecycle(() => importImageAsset(payload, root, (stored) => recordHumanFileMutation([...pendingTurns.values()].find((turn) => turn.root === root), { path: stored.path })), { allowPending: true });
      return sendJson(request, response, 201, asset);
    }
    if (url.pathname === "/api/references") {
      const root = requestProjectRoot;
      if (root !== projectRoot()) return sendJson(request, response, 409, { error: "The project changed while the import was being received.", code: "WEAVE_PROJECT_CHANGED" });
      if (startingRoots.has(root)) return sendJson(request, response, 409, { error: "Agent setup is capturing the project. Retry the import.", code: "WEAVE_AGENT_STARTING" });
      const reference = await runProjectLifecycle(() => importReference(payload, root, (stored, entry) => recordHumanFileMutation([...pendingTurns.values()].find((turn) => turn.root === root), { path: stored.path, entry })), { allowPending: true });
      return sendJson(request, response, 201, reference);
    }
    if (url.pathname === "/api/references/folder") {
      const root = requestProjectRoot;
      if (root !== projectRoot()) return sendJson(request, response, 409, { error: "The project changed while the import was being received.", code: "WEAVE_PROJECT_CHANGED" });
      if (startingRoots.has(root)) return sendJson(request, response, 409, { error: "Agent setup is capturing the project. Retry the import.", code: "WEAVE_AGENT_STARTING" });
      const reference = await runProjectLifecycle(() => importReferenceFolder(payload, root, (stored, entry) => recordHumanFileMutation([...pendingTurns.values()].find((turn) => turn.root === root), { path: stored.path, entry })), { allowPending: true });
      return sendJson(request, response, 201, reference);
    }
    if (url.pathname === "/api/references/folder/sync") {
      const root = requestProjectRoot;
      if (root !== projectRoot()) return sendJson(request, response, 409, { error: "The project changed while the update was being received.", code: "WEAVE_PROJECT_CHANGED" });
      if (startingRoots.has(root)) return sendJson(request, response, 409, { error: "Agent setup is capturing the project. Retry the update.", code: "WEAVE_AGENT_STARTING" });
      const result = await runProjectLifecycle(() => syncReferenceFolder(payload.path, root, (_stored, entry) => recordHumanFileMutation([...pendingTurns.values()].find((turn) => turn.root === root), { path: payload.path, entry })), { allowPending: true });
      return sendJson(request, response, 200, result);
    }
    if (url.pathname === "/api/references/remove") {
      const root = requestProjectRoot;
      if (root !== projectRoot()) return sendJson(request, response, 409, { error: "The project changed while the removal was being received.", code: "WEAVE_PROJECT_CHANGED" });
      if (startingRoots.has(root)) return sendJson(request, response, 409, { error: "Agent setup is capturing the project. Retry the removal.", code: "WEAVE_AGENT_STARTING" });
      const references = await runProjectLifecycle(() => removeReference(payload.path, root, () => recordHumanFileMutation([...pendingTurns.values()].find((turn) => turn.root === root), { path: payload.path, remove: true })), { allowPending: true });
      return sendJson(request, response, 200, { references });
    }

    if (url.pathname === "/api/save") {
      if (activeProjectTurn()) return sendJson(request, response, 409, { error: "An Agent turn is running." });
      const idempotencyKey = String(payload.idempotencyKey ?? "");
      if (idempotencyKey && completedSaves.has(idempotencyKey)) {
        return sendJson(request, response, 200, completedSaves.get(idempotencyKey));
      }
      const { commit } = await saveProject(
        payload.deck,
        payload.expectedRevision,
        `Save: ${String(payload.message ?? payload.deck?.title ?? "Deck").slice(0, 120)}`,
        payload.templates ?? null,
      );
      await clearRecoveryTask(projectRoot());
      const result = { ...(await statePayload()), commit };
      if (idempotencyKey) {
        completedSaves.set(idempotencyKey, result);
        if (completedSaves.size > 100) completedSaves.delete(completedSaves.keys().next().value);
      }
      return sendJson(request, response, 200, result);
    }
    if (url.pathname === "/api/draft") {
      const pending = [...pendingTurns.values()].find((turn) => turn.root === projectRoot());
      if (pending) {
        if (!pending.acceptingDrafts) return sendJson(request, response, 409, { error: "Agent changes are being merged. The draft remains in the editor and must be retried against the completed result.", code: "WEAVE_AGENT_FINALIZING" });
        pending.humanDraft = structuredClone(payload.deck);
        await updateRecoverySnapshot(pending.recoverySnapshot, { humanDraft: pending.humanDraft }, pending.root);
        return sendJson(request, response, 202, { ...(await statePayload()), deck: pending.humanDraft, commit: null, queued: true });
      }
      const recent = recentAgentMerges.get(projectRoot());
      let nextDraft = payload.deck;
      let conflicts = [];
      let mergedAgent = false;
      if (recent) {
        if (recent.expiresAt >= Date.now()) {
          const merged = mergeEditorDecks({ base: recent.base, agent: recent.agent, current: payload.deck });
          nextDraft = merged.deck;
          conflicts = merged.conflicts;
          mergedAgent = true;
        } else recentAgentMerges.delete(projectRoot());
      }
      const { deck } = await saveDraft(nextDraft, payload.expectedRevision, payload.templates ?? null, projectRoot());
      await clearRecoveryTask(projectRoot());
      return sendJson(request, response, 200, { ...(await statePayload()), deck, conflicts, mergedAgent, commit: null });
    }
    if (url.pathname === "/api/milestones") {
      const pending = [...pendingTurns.values()].find((turn) => turn.root === projectRoot());
      if (pending) {
        if (!pending.acceptingDrafts) return sendJson(request, response, 409, { error: "Agent changes are being finalized. Create the milestone after completion.", code: "WEAVE_AGENT_FINALIZING" });
        const name = String(payload.name ?? "").trim();
        if (!name) throw new Error("Milestone name is required.");
        pending.queuedMilestone = name;
        await updateRecoverySnapshot(pending.recoverySnapshot, { queuedMilestone: name }, pending.root);
        return sendJson(request, response, 202, { ...(await statePayload()), name, commit: null, queued: true });
      }
      const result = await createMilestone(payload.name, payload.expectedRevision, projectRoot());
      await clearRecoveryTask(projectRoot());
      return sendJson(request, response, 201, { ...(await statePayload()), ...result });
    }
    if (url.pathname === "/api/history/checkout") {
      if (activeProjectTurn()) return sendJson(request, response, 409, { error: "An Agent turn is running." });
      await checkoutHistory(String(payload.commit ?? ""));
      return sendJson(request, response, 200, await statePayload());
    }
    if (url.pathname === "/api/history/main") {
      if (activeProjectTurn()) return sendJson(request, response, 409, { error: "An Agent turn is running." });
      await checkoutMain();
      return sendJson(request, response, 200, await statePayload());
    }
    if (url.pathname === "/api/variations/checkout") {
      if (activeProjectTurn()) return sendJson(request, response, 409, { error: "An Agent turn is running." });
      await checkoutVariation(String(payload.branch ?? ""));
      return sendJson(request, response, 200, await statePayload());
    }
    if (url.pathname === "/api/variations/generate") {
      return sendJson(request, response, 202, await startEditorTurn(payload, { variation: true }));
    }
    if (url.pathname === "/api/variations/accept") {
      if (activeProjectTurn()) return sendJson(request, response, 409, { error: "An Agent turn is running." });
      acceptVariation();
      return sendJson(request, response, 200, await statePayload());
    }
    if (url.pathname === "/api/variations/archive") {
      if (activeProjectTurn()) return sendJson(request, response, 409, { error: "An Agent turn is running." });
      if (payload.branch) await setVariationState(String(payload.branch), "archived", projectRoot());
      else archiveVariation();
      return sendJson(request, response, 200, await statePayload());
    }
    if (url.pathname === "/api/variations/pause") {
      return sendJson(request, response, 200, { variation: await setVariationState(String(payload.branch ?? ""), "paused", projectRoot()) });
    }
    if (url.pathname === "/api/variations/resume") {
      return sendJson(request, response, 200, { variation: await setVariationState(String(payload.branch ?? ""), "ready", projectRoot()) });
    }
    if (url.pathname === "/api/variations/import") {
      if (activeProjectTurn()) return sendJson(request, response, 409, { error: "An Agent turn is running." });
      const deck = await importVariationSlides(String(payload.branch ?? ""), payload.slideIds, payload.expectedRevision, projectRoot());
      return sendJson(request, response, 200, { ...(await statePayload()), deck });
    }

    if (url.pathname === "/api/codex/thread/start") {
      return sendJson(request, response, 201, { thread: await codex.startThread(payload) });
    }
    if (url.pathname === "/api/codex/thread/read") {
      return sendJson(request, response, 200, { thread: await codex.readThread(payload.threadId) });
    }
    if (url.pathname === "/api/codex/thread/resume") {
      return sendJson(request, response, 200, { thread: await codex.resumeThread(payload.threadId) });
    }
    if (url.pathname === "/api/codex/thread/fork") {
      return sendJson(request, response, 201, { thread: await codex.forkThread(payload.threadId, payload.lastTurnId) });
    }
    if (url.pathname === "/api/codex/thread/action") {
      return sendJson(request, response, 200, await codex.threadAction(payload.action, payload.params ?? {}));
    }
    if (url.pathname === "/api/codex/turn/start") {
      if (agentStartBlocked()) return sendJson(request, response, 409, { error: "Another Agent task is running. Editing remains available and Agent will reconnect to this project when it finishes." });
      const prompt = requireTurnPrompt(payload);
      const workflow = workflowFromPayload(payload);
      const root = projectRoot();
      startingRoots.add(root);
      let agentFileSnapshot = null;
      let projectSkillSnapshot = null;
      let recoverySnapshot = null;
      let pending = null;
      try {
        await clearRecoveryTask(root);
        const deck = payload.deck ? await writeProject(payload.deck, null, root) : await readProject(root);
        const preTurnCss = await readDeckCss(root);
        agentFileSnapshot = await createAgentFileSnapshot(root);
        projectSkillSnapshot = await createProjectSkillSnapshot(root);
        recoverySnapshot = await createRecoverySnapshot({ baseRevision: getRevision(root), deck, css: preTurnCss, agentFileSnapshot }, root);
        pending = pendingTurn({ prompt, branch: null, variation: false, workflow, root, preTurnDeck: deck, baseDeck: deck, baseRevision: recoverySnapshot.baseRevision, preTurnCss, projectSkillSnapshot, recoverySnapshot, agentFileSnapshot, deckTitle: deck.title });
        pending.threadId = payload.threadId;
        pendingTurns.set(payload.threadId, pending);
        startingRoots.delete(root);
        const result = await codex.startTurn({ ...payload, prompt: `${prompt}${serializeEditorContext(payload)}` });
        startProjectPreview(pending, payload.threadId, result.turn.id);
        await updateRecoverySnapshot(recoverySnapshot, { workflow, status: "running", threadId: payload.threadId, turnId: result.turn.id }, root);
        return sendJson(request, response, 202, result);
      } catch (error) {
        if (pending) finishPendingTurn(payload.threadId, pending);
        if (agentFileSnapshot) {
          await restoreAgentFileSnapshot(agentFileSnapshot, root);
          await discardAgentFileSnapshot(agentFileSnapshot, root);
        }
        if (projectSkillSnapshot) await restoreProjectSkillSnapshot(root, projectSkillSnapshot);
        await discardProjectSkillSnapshot(projectSkillSnapshot);
        if (recoverySnapshot) await discardRecoverySnapshot(recoverySnapshot, root);
        throw error;
      } finally {
        startingRoots.delete(root);
      }
    }
    if (url.pathname === "/api/codex/turn/steer") {
      const prompt = requireTurnPrompt(payload);
      // Steer only tells the agent what to point at; writing the DOM here could overwrite its in-progress file edits.
      return sendJson(request, response, 202, await codex.steerTurn({ ...payload, prompt: `${prompt}${serializeEditorContext(payload)}` }));
    }
    if (url.pathname === "/api/codex/turn/interrupt") {
      return sendJson(request, response, 202, await codex.interruptTurn(payload.threadId));
    }
    if (url.pathname === "/api/codex/request/resolve") {
      codex.router.resolve(payload.id, payload.result);
      return sendJson(request, response, 200, { ok: true });
    }
    if (url.pathname === "/api/codex/request/reject") {
      codex.router.reject(payload.id, payload.message);
      return sendJson(request, response, 200, { ok: true });
    }
    if (url.pathname === "/api/codex/catalog/refresh") {
      return sendJson(request, response, 200, await codex.refreshCatalog());
    }
    if (url.pathname === "/api/codex/skill/config") {
      return sendJson(request, response, 200, await codex.setSkill(payload));
    }
    if (url.pathname === "/api/codex/account/login") {
      const login = payload.type === "apiKey"
        ? { type: "apiKey", apiKey: requireText(payload.apiKey, "API key", 20_000) }
        : { type: "chatgpt", codexStreamlinedLogin: true, useHostedLoginSuccessPage: true };
      return sendJson(request, response, 200, await codex.login(login));
    }
    if (url.pathname === "/api/codex/account/logout") {
      return sendJson(request, response, 200, await codex.logout());
    }
    if (url.pathname === "/api/codex/mcp/oauth") {
      return sendJson(request, response, 200, await codex.startMcpOAuth(requireText(payload.name, "MCP server name", 200)));
    }
    if (url.pathname === "/api/codex/mcp/resource/read") {
      return sendJson(request, response, 200, await codex.readMcpResource({
        threadId: payload.threadId ?? null,
        server: requireText(payload.server, "MCP server name", 200),
        uri: requireText(payload.uri, "Resource URI", 4_000),
      }));
    }
    if (url.pathname === "/api/codex/mcp/tool/call") {
      return sendJson(request, response, 200, await codex.callMcpTool({
        threadId: requireText(payload.threadId, "Thread id", 200),
        server: requireText(payload.server, "MCP server name", 200),
        tool: requireText(payload.tool, "Tool name", 500),
        arguments: payload.arguments && typeof payload.arguments === "object" ? payload.arguments : {},
      }));
    }
    return sendJson(request, response, 404, { error: "Not found." });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = ["WEAVE_REVISION_CONFLICT", "WEAVE_SKILL_CONFLICT", "WEAVE_TURN_RUNNING"].includes(error?.code) ? 409
      : error?.code === "WEAVE_SKILL_NOT_FOUND" ? 404
      : error?.code === "WEAVE_SKILL_INVALID" ? 400
      : error?.code === "WEAVE_REQUEST_TOO_LARGE" ? 413
      : error?.code === "WEAVE_INVALID_JSON" ? 400
      : ["WEAVE_QUALITY_FAILED", "WEAVE_CONTENT_POLICY", "WEAVE_SCOPE_VIOLATION"].includes(error?.code) ? 422
      : ["WEAVE_PROJECT_DIRTY", "WEAVE_PROJECT_BLOCKED"].includes(error?.code) ? 409
      : /required|invalid|unknown|not offered|exceeds|already exists/i.test(message) ? 400
      : /owned|running|save|proposal branch|cannot be archived/i.test(message) ? 409 : 500;
    return sendJson(request, response, status, { error: message, code: error?.code, diagnostics: error?.diagnostics });
  }
});

await ensureProject();
server.listen(apiPort, "127.0.0.1", () => {
  console.log(`Weave local API: http://127.0.0.1:${apiPort}`);
  console.log(migrationNotice);
  void codex.start().catch((error) => {
    console.error(`Codex app-server unavailable: ${error.message}`);
  });
});

async function shutdown() {
  await codex.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
