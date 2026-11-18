import { SlideProposals, validateDirections } from "./slide-proposals.mjs";
import { taskSummary, taskDetails, taskChanges } from "./task-view.mjs";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Orchestration } from "./orchestration.mjs";
import { orchestrationInstructions } from "./orchestration-tools.mjs";
import { claudeOrchestratorTools, validateEditSlidesArguments } from "./codex/ui-tools.mjs";
import { captureSkillProposal, listSkillProposals, resetSkillProposal, resolveSkillProposal } from "./skill-proposals.mjs";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readFolderUpload } from "./reference-upload.mjs";
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
  registerReferenceFolder,
  resolveReferenceAttachments,
  importUploadedReferenceFolder,
  listFolders,
  readReferences,
  removeReference,
  syncReferenceFolder,
  projectRoot,
  workspacesRoot,
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
  readRecoverySnapshots,
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
  setEditorSkillEnabled,
  createProjectSkillSnapshot,
  deleteSkill,
  discardProjectSkillSnapshot,
  listSkills,
  restoreProjectSkillSnapshot,
  updateSkill,
  uploadSkill,
} from "./skills.mjs";
import { initializeApplicationSkills, listApplicationSkills, updateApplicationSkill, getApplicationSkillHistory, getApplicationSkillVersion, restoreApplicationSkill } from "./application-skills.mjs";
import { initializeSlidePreferenceLearning, getLearningState, setLearningEnabled, slidePreferenceLearning } from "./slide-preference-learning.mjs";
import { AgentService } from "./agent-service.mjs";
import { annotationPromptRules, canSendTurn } from "../shared/annotation.mjs";
import { contextPromptRules, editorEnvelope, isReferencePath } from "../shared/context.mjs";
import { createEditorChangeSet, htmlChangeWithinElement, mergeEditorDecks, validateWorkflowRequest } from "../shared/editor-workflow.mjs";
import { parseConfiguredPort } from "../scripts/dev-port.mjs";
import { isAllowedWebOrigin } from "./dev-origin.mjs";
import { routeMethodDecision } from "./route-methods.mjs";
import { ProjectPreviewMonitor } from "./project-preview.mjs";
import { chatInstructions, delegatedEditorContext } from "./chat-workflow.mjs";

const apiPort = Number(process.env.WEAVE_API_PORT ?? 4317);
await initializeApplicationSkills();
await initializeSlidePreferenceLearning();
await initializeCurrentProject();
const webPort = parseConfiguredPort(process.env.WEAVE_WEB_PORT);
const codex = new AgentService({ projectRoot: projectRoot(), workspaceRoot: workspacesRoot, instructions: agentInstructions, chatInstructions: `${chatInstructions}\n\n${orchestrationInstructions}`, slidePreferenceLearning });
let codexProjectRoot = projectRoot();
const toolCapabilities = new Map();
const reviewedSources = new Map();
const proposals = new SlideProposals({ workspaceRoot: workspacesRoot, publish: (type, payload) => codex.events.publish(type, payload), livePreview: taskId => {
  if (typeof taskId !== "string") return null;
  const pending = [...pendingTurns.values()].find(turn => turn.reviewTaskId === taskId);
  if (!pending?.previewSnapshot) return null;
  return { deck: pending.previewSnapshot, css: pending.preTurnCss, templates: pending.previewTemplates, revision: `${pending.threadId}:${pending.previewSequence}` };
} });
const orchestrator = new Orchestration({
  path: fileURLToPath(new URL("../.weave/orchestration.json", import.meta.url)), events: codex.events,
  chatActive: id => codex.activeTurns.has(id),
  startChat: async (payload, automatic) => {
    const root = payload.root;
    chatTurns.set(payload.threadId, { root, contextEnvelope: payload.contextEnvelope, model: payload.model, effort: payload.effort, approvalPolicy: payload.approvalPolicy });
    const instructions = `${chatInstructions}\n\n${orchestrationInstructions}${await serializeEditorContext(payload, root)}\n${payload.automaticInstructions === undefined ? "" : payload.automaticInstructions}`;
    return await codex.startTurn({ ...payload, purpose: "chat", humanPrompt: automatic ? null : payload.prompt, userPrompt: payload.prompt, cwd: root, instructions });
  },
  steerChat: async payload => await codex.steerTurn({ ...payload, humanPrompt: payload.prompt, prompt: `${payload.prompt}${await serializeEditorContext(payload, payload.root)}` }),
  interruptChat: id => codex.interruptTurn(id), interruptWorker: id => codex.codex.interruptTurn(id),
  onTaskSettled: async task => { if (task.proposal) await proposals.finish(task.root, task.proposal.groupId, task.proposal.candidateId, task); },
  execute: async task => {
    if (!task.proposal && task.root !== projectRoot()) throw new Error("The project changed before the delegated edit started. Send the request in the current project.");
    let executionRoot = task.root;
    if (task.proposal) {
      const group = proposals.group(await proposals.read(task.root), task.proposal.groupId);
      executionRoot = proposals.workspace(group, proposals.candidate(group, task.proposal.candidateId));
    }
    const deck = await readProject(executionRoot);
    const contextEnvelope = { ...task.contextEnvelope, modificationScope: task.scope, executionMode: "apply", allowSkillChanges: task.allowSkillChanges };
    const started = await startEditorTurn({ prompt: task.prompt, deck, contextEnvelope, clientUserMessageId: `task-${task.id}-${task.attempt}`, model: task.model, effort: task.effort, approvalPolicy: task.approvalPolicy, reviewTaskId: task.id }, { parentThreadId: task.threadId, variation: task.proposal ? false : task.variation, root: executionRoot, proposalOwnerRoot: task.proposal ? task.root : null });
    await orchestrator.workerStarted(task.id, started.thread.id, started.turn.id);
    await started.pending.finalization;
    if (!started.pending.outcome) throw new Error("Codex finished without a verified editor outcome.");
    return started.pending.outcome;
  },
});
await orchestrator.load();
codex.claude.toolConfiguration = (threadId, turnId) => {
  const token = randomBytes(32).toString("hex"); toolCapabilities.set(token, { threadId, turnId });
  return { url: `http://127.0.0.1:${apiPort}/api/agent/tools`, token, close: () => toolCapabilities.delete(token) };
};

// Pending work is keyed by thread but every entry carries its immutable project
// root. This allows project switching while another project's turn is settling.
const pendingTurns = new Map();
const startingRoots = new Set();
const chatTurns = new Map();
const proposalRoots = [...new Set(orchestrator.tasks.filter(task => task.proposal !== null && task.proposal !== undefined).map(task => join(workspacesRoot, ".proposals", task.proposal.groupId, task.proposal.candidateId)))];
const recoveredSnapshots = [...await readAllRecoverySnapshots(), ...(await Promise.all(proposalRoots.map(root => readRecoverySnapshots(root)))).flat()];
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
for (const root of new Set([projectRoot(), ...(await listProjects()).map(project => join(workspacesRoot, project.slug))])) await proposals.recover(root);
const migrationNotice = "Conversations use independent Codex app-server or Claude Code sessions.";

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
    project: { ...state.project, historyCapabilities: { preview: !activeProjectTurn(), returnToDraft: !activeProjectTurn() && state.project.historyPreview, createMilestone: !activePending || activePending.acceptingDrafts === true }, historyUnavailableReason: activeProjectTurn() ? "Agentの処理が終わってから履歴を開いてください。" : null, backgroundTasks: backgroundTasks[String(projectRoot()).split(/[\\/]/).filter(Boolean).pop()] ?? [] },
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
      pendingRequests: codex.pendingRequests(),
      ui: codex.uiTools.snapshot(),
      editing: activePending !== undefined || startingRoots.has(projectRoot()),
    },
    skills: await allSkills(projectRoot()),
    orchestration: orchestrator.snapshot(projectRoot()),
    proposals: await proposals.snapshot(projectRoot(), orchestrator.tasks),
    skillProposals: await listSkillProposals(projectRoot()),
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

function publishProposalPreview(pending, threadId) {
  const task = orchestrator.tasks.find(task => task.id === pending.reviewTaskId);
  if (task?.proposal && task.workerThreadId === threadId) codex.events.publish("weave/proposal-preview", { root: task.root, taskId: task.id, groupId: task.proposal.groupId, candidateId: task.proposal.candidateId, revision: `${threadId}:${pending.previewSequence}` });
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
      publishProposalPreview(pending, threadId);
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

async function allSkills(root) {
  return [...await listApplicationSkills(), ...await listSkills(root)];
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
    return { skill, skills: await allSkills(root), skillProposals: await listSkillProposals(root), project: projectState().project };
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

function assertHumanFileMutationReady(root) {
  const pending = [...pendingTurns.values()].find((turn) => turn.root === root);
  if (pending && !pending.acceptingDrafts) throw Object.assign(new Error("Agent changes are being finalized. Retry adding references after completion."), { code: "WEAVE_TURN_RUNNING" });
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
  return startingRoots.has(root) || [...pendingTurns.values()].some((turn) => turn.root === root);
}

function agentStartBlocked(root = projectRoot()) {
  return projectLifecycleBusy || startingRoots.has(root) || [...pendingTurns.values()].some(turn => turn.root === root) || codexProjectRoot !== projectRoot();
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
    allowSkillChanges: false,
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

async function serializeEditorContext(payload, root) {
  if (!payload.contextEnvelope || typeof payload.contextEnvelope !== "object") return "";
  const envelope = editorEnvelope(payload.contextEnvelope);
  if (envelope.attachments) envelope.attachments = await resolveReferenceAttachments(envelope.attachments, root);
  if (Object.keys(envelope).length === 0) return "";
  const annotations = Array.isArray(envelope.annotations) ? envelope.annotations : [];
  const annotationRules = annotations.length > 0 ? `\n\nAnnotation interpretation rules:\n${annotationPromptRules}` : "";
  return `\n\nEditor context envelope:\n${JSON.stringify(envelope)}\n\nContext rules:\n${contextPromptRules}${annotationRules}`;
}

async function startEditorTurn(payload, { variation = false, parentThreadId = null, root = projectRoot(), proposalOwnerRoot = null } = {}) {
  if (agentStartBlocked(root)) throw new Error("Another Agent task is running. Editing remains available and Agent will reconnect to this project when it finishes.");
  const prompt = requireTurnPrompt(payload);
  const workflow = workflowFromPayload(payload);
  startingRoots.add(root);
  let branch = null;
  let registeredPending = null;
  let registeredThreadId = null;
  let projectSkillSnapshot = null;
  let recoverySnapshot = null;
  let agentFileSnapshot = null;
  try {
    await clearRecoveryTask(root);
    await resetSkillProposal(root);
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
      purpose: "editor",
      cwd: root,
      parentThreadId,
    });
    registeredPending = pendingTurn({ prompt, branch, variation, workflow, deckTitle: deck.title, root, preTurnDeck: deck, baseDeck: deck, baseRevision: recoverySnapshot.baseRevision, preTurnCss, projectSkillSnapshot, recoverySnapshot, agentFileSnapshot });
    registeredPending.threadId = thread.id;
    registeredPending.reviewTaskId = payload.reviewTaskId === undefined ? null : payload.reviewTaskId;
    registeredPending.parentThreadId = parentThreadId;
    registeredPending.proposalOwnerRoot = proposalOwnerRoot;
    registeredPending.previewTemplates = await readTemplates(root);
    registeredThreadId = thread.id;
    pendingTurns.set(thread.id, registeredPending);
    startingRoots.delete(root);
    const context = `${variation ? "Create a meaningfully different, polished direction. " : ""}User request: ${prompt}

The latest editor state has been written to slides/*.html.
Inspect the current project and edit the slides/*.html files directly. Do not edit styles/deck.css.
Do not commit; Weave will commit after this turn.${await serializeEditorContext(payload, root)}`;
    const result = await codex.startTurn({
      threadId: thread.id,
      prompt: context,
      userPrompt: prompt,
      clientUserMessageId: payload.clientUserMessageId,
      model: payload.model,
      effort: payload.effort,
      approvalPolicy: payload.approvalPolicy ?? "never",
      purpose: "editor",
      cwd: root,
    });
    startProjectPreview(registeredPending, thread.id, result.turn.id);
    await updateRecoverySnapshot(recoverySnapshot, { workflow, status: "running", threadId: thread.id, turnId: result.turn.id }, root);
    return { thread, turn: result.turn, branch, pending: registeredPending };
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
    pending.acceptingDrafts = false;
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
  if (message.method === "item/started" && message.params?.item) void orchestrator.progress(message.params.threadId, message.params.item).catch(error => console.error("Could not persist Codex progress:", error.message));
  if (message.method !== "turn/completed") return;
  const threadId = message.params?.threadId;
  if (chatTurns.has(threadId)) {
    chatTurns.delete(threadId);
    for (const key of reviewedSources.keys()) if (key.startsWith(`${threadId}:`)) reviewedSources.delete(key);
    // Delegated tasks outlive individual orchestrator turns. Only an explicit stop cancels them.
  }
  void orchestrator.pump(threadId);
  const pending = pendingTurns.get(threadId);
  if (!pending) return;
  pending.previewMonitor?.stop();
  void (async () => {
    const status = message.params?.turn?.status;
    if (status !== "completed") {
      pending.outcome = { success: false, error: `Slide editing ${status}.` };
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
      if (pending.reviewTaskId) {
        const agentDeck = await readProject(pending.root);
        const checked = validateAgentResult(pending.workflow, pending.baseDeck, agentDeck);
        if (!checked.ok) throw new Error("Codex exceeded the requested scope.");
        const child = await codex.codex.readThread(threadId);
        const workerTurn = child.turns?.find(turn => turn.id === pending.turnId);
        const workerOutput = (workerTurn?.items ?? []).filter(item => item.type === "agentMessage").map(item => item.text).join("\n");
        const changedIds = new Set(checked.changeSet.changes.map(change => change.slideId).filter(Boolean));
        const sources = [...changedIds].map(id => ({ slideId: id, before: pending.baseDeck.slides.find(item => item.id === id)?.html ?? null, after: agentDeck.slides.find(item => item.id === id)?.html ?? null }));
        const metadata = deck => JSON.stringify({ ...deck, slides: deck.slides.map(slide => ({ ...slide, html: undefined })) }, null, 2);
        const beforeMetadata = metadata(pending.baseDeck); const afterMetadata = metadata(agentDeck);
        if (beforeMetadata !== afterMetadata) sources.push({ slideId: "$deck-metadata", before: beforeMetadata, after: afterMetadata });
        const report = { request: pending.prompt, scope: pending.workflow.scope, changes: checked.changeSet, workerOutput, sources };
        if (pending.proposalOwnerRoot !== null) { pending.previewSnapshot = agentDeck; pending.previewSequence++; publishProposalPreview(pending, threadId); }
        const approved = await orchestrator.workerReady(pending.reviewTaskId, report);
        if (!approved) throw new Error("The orchestrator rejected or revised this edit.");
      }
      await runProjectExclusive(async () => {
        if (pending.reviewTaskId) orchestrator.assertApply(pending.reviewTaskId);
        pending.acceptingDrafts = false;
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
        if (pending.reviewTaskId) orchestrator.task(pending.parentThreadId, pending.reviewTaskId).applied = pending.proposalOwnerRoot === null;
      }, pending.proposalOwnerRoot === null ? pending.root : pending.proposalOwnerRoot);
      let skillProposalError = null;
      try { await captureSkillProposal(pending.root, { threadId, turnId: pending.turnId }); }
      catch (error) { skillProposalError = error.message; }
      pending.previewSnapshot = await readProject(pending.root);
      pending.humanDraft = pending.previewSnapshot;
      recentAgentMerges.set(pending.root, { base: pending.baseDeck, agent: pending.previewSnapshot, expiresAt: Date.now() + 10_000 });
      recoveryTasks.delete(pending.root);
      await discardRecoverySnapshot(pending.recoverySnapshot, pending.root);
      pending.outcome = { success: true, result: { projectRoot: pending.root, title: pending.previewSnapshot.title, slideCount: pending.previewSnapshot.slides.length, execution: pending.workflow.execution, changeCount: pending.changeSet.changes.length, conflictCount: pending.conflicts.length } };
      codex.events.publish("weave/project", {
        status: "updated",
        skillProposalError,
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
      pending.outcome = { success: false, error: error.message };
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

async function delegateEdit(threadId, args) {
  validateEditSlidesArguments(args);
  if (args.execution !== "apply") throw new Error("Use execution apply. Delivery is controlled by the chosen mode; consultations are conversation responses.");
  const chat = orchestrator.context(threadId);
  const root = projectRoot(); const deck = await readProject(root);
  delegatedEditorContext(args, deck);
  if (root !== chat.root) throw new Error("The project changed. Send a new instruction before editing it.");
  const allowed = chat.contextEnvelope.modificationScope;
  if (!allowed) throw new Error("The human modification scope is required.");
  if (allowed.kind !== "deck" && (args.scope.kind === "deck" || args.scope.slideIds.some(id => !allowed.slideIds.includes(id)) || (allowed.kind === "element" && (args.scope.kind !== "element" || args.scope.elementId !== allowed.elementId)))) throw new Error("The requested edit exceeds the human scope.");
  if (args.allowSkillChanges && chat.contextEnvelope.allowSkillChanges !== true) throw new Error("Skill changes were not authorized.");
  orchestrator.assertWorker(threadId);
  const target = chat.contextEnvelope.proposalTarget;
  if (target) {
    const selected = await proposals.target(root, target);
    if (args.directions !== undefined) throw new Error("案の修正ではdirectionsを指定しないでください。");
    if (selected.group.scope.kind !== "deck" && (args.scope.kind === "deck" || args.scope.slideIds.some(id => !selected.group.scope.slideIds.includes(id)))) throw new Error("案の修正範囲が元の提案を超えています。");
    const receipt = await orchestrator.create(threadId, { ...args, variation: false, deferStart: true, proposal: { groupId: target.groupId, candidateId: target.candidateId } });
    try { await proposals.attach(root, target.groupId, target.candidateId, receipt.taskId, { revise: true, expectedVersion: target.version }); }
    catch (error) { const task = orchestrator.task(threadId, receipt.taskId); task.status = "cancelled"; task.error = error.message; await orchestrator.save(); throw error; }
    await orchestrator.activate([receipt.taskId]); return receipt;
  }
  if (chat.contextEnvelope.executionMode === "compare") {
    validateDirections(args.directions);
    const group = await proposals.create(root, { threadId, prompt: args.prompt, scope: args.scope, directions: args.directions });
    const receipts = [];
    for (const candidate of group.candidates) {
      const receipt = await orchestrator.create(threadId, { ...args, prompt: `${args.prompt}\n\n比較案${candidate.id.toUpperCase()}: ${candidate.title}\n${candidate.instruction}\n全対象スライドでこの方向を一貫させてください。他の案や元の資料は編集しないでください。`, variation: false, deferStart: true, proposal: { groupId: group.id, candidateId: candidate.id } });
      await proposals.attach(root, group.id, candidate.id, receipt.taskId); receipts.push(receipt);
    }
    await orchestrator.activate(receipts.map(receipt => receipt.taskId)); return { groupId: group.id, tasks: receipts, message: "Three candidates accepted. They do not change the live deck; human adoption is required." };
  }
  if (args.directions !== undefined || args.variation === true) throw new Error("3案の生成には3案から選ぶモードを指定してください。");
  return await orchestrator.create(threadId, args);
}
codex.onEditSlides = async (params, args) => ({ success: true, result: await delegateEdit(params.threadId, args) });
codex.onOrchestrationTool = async params => {
  if (["get_slide_learning_context", "learn_slide_preference"].includes(params.tool)) {
    const sessionId = codex.uiTools.activeThreadSession(params.threadId).sessionId;
    const assertAvailable = () => { if (codex.activeTurns.get(params.threadId) !== params.turnId || codex.uiTools.activeThreadSession(params.threadId).sessionId !== sessionId || orchestrator.context(params.threadId).paused) throw new Error("The learning request belongs to an inactive conversation or browser session."); };
    assertAvailable();
    const context = orchestrator.learningContext(params.threadId); const state = await slidePreferenceLearning.getContext(); assertAvailable();
    if (params.tool === "get_slide_learning_context") return { ...state, ...context, available: state.enabled && context.successfulEdits.length > 0, reason: !state.enabled ? "Automatic learning is disabled." : context.successfulEdits.length ? null : "No reviewed and applied edit is available." };
    const edit = context.successfulEdits.find(item => item.callId === params.arguments.editCallId); if (!edit) throw new Error("Learning requires a completed, reviewed edit in this conversation.");
    const result = await slidePreferenceLearning.learn(params.arguments, { threadId: params.threadId, turnId: params.turnId, edit, originalMessages: context.originalMessages.filter(message => edit.messageIds.includes(message.id)), assertAvailable });
    codex.events.publish("weave/learning", { ...result, threadId: params.threadId, turnId: params.turnId }); return result;
  }
  if (params.tool === "tasks") {
    if (params.arguments.taskId === null) return orchestrator.tasks.filter(task => task.threadId === params.threadId).slice(-30).map(taskSummary);
    const task = orchestrator.task(params.threadId, params.arguments.taskId); const details = taskDetails(task);
    reviewedSources.set(`${params.threadId}:${params.turnId}:${task.id}:${task.version}`, { complete: details.report !== null && !details.report.paged, offsets: {} });
    return details;
  }
  if (params.tool === "read_task_changes") {
    const task = orchestrator.task(params.threadId, params.arguments.taskId); const result = taskChanges(task, params.arguments);
    const key = `${params.threadId}:${params.turnId}:${task.id}:${task.version}`; const evidence = reviewedSources.get(key);
    if (evidence) { const previous = evidence.offsets[result.slideId] === undefined ? 0 : evidence.offsets[result.slideId]; if (previous === params.arguments.offset) evidence.offsets[result.slideId] = result.nextOffset === null ? -1 : result.nextOffset; evidence.complete = task.report.sources.every(source => evidence.offsets[source.slideId] === -1); }
    return result;
  }
  if (params.tool === "control_task") return await runProjectExclusive(() => orchestrator.control(params.threadId, params.arguments), orchestrator.task(params.threadId, params.arguments.taskId).root);
  if (params.tool === "review_edit") {
    const evidence = reviewedSources.get(`${params.threadId}:${params.turnId}:${params.arguments.taskId}:${params.arguments.version}`);
    if (!evidence?.complete) throw new Error("Read the current task and all source pages before reviewing it.");
    return await runProjectExclusive(() => orchestrator.review(params.threadId, params.arguments), orchestrator.task(params.threadId, params.arguments.taskId).root);
  }
  throw new Error("Unknown orchestration tool.");
};

const server = createServer(async (request, response) => {
  try {
    if (!hasAllowedOrigin(request)) return sendJson(request, response, 403, { error: "Origin is not allowed." });
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders(request));
      return response.end();
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    // Provider-neutral editor routes retain compatibility with existing clients.
    if (url.pathname.startsWith("/api/agent/")) url.pathname = url.pathname.replace("/api/agent/", "/api/codex/");
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
      return sendJson(request, response, 200, { skills: scope === undefined ? await allSkills(projectRoot()) : scope === "application" ? await listApplicationSkills() : await listSkills(projectRoot(), scope) });
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
    const applicationSkillRead = url.pathname.match(/^\/api\/skills\/application\/([^/]+)\/(history|version)$/);
    if (request.method === "GET" && applicationSkillRead) {
      const name = decodeSkillName(applicationSkillRead[1]);
      const result = applicationSkillRead[2] === "history"
        ? await getApplicationSkillHistory(name)
        : await getApplicationSkillVersion(name, url.searchParams.get("commit"));
      return sendJson(request, response, 200, result);
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
    if (request.method === "GET" && url.pathname === "/api/skills/learning") {
      return sendJson(request, response, 200, await getLearningState());
    }
    if (request.method === "GET" && url.pathname === "/api/ui/state") {
      return sendJson(request, response, 200, codex.uiTools.snapshot());
    }
    if (request.method === "GET" && url.pathname === "/api/codex/threads") {
      return sendJson(request, response, 200, await codex.listThreads({
        searchTerm: url.searchParams.get("q"),
        archived: url.searchParams.get("archived") === "true",
        cursor: url.searchParams.get("cursor"),
      }));
    }

    if (request.method !== "GET" && request.method !== "POST" && request.method !== "PATCH" && request.method !== "DELETE") return sendJson(request, response, 404, { error: "Not found." });
    if (url.pathname === "/api/references/folder/upload") {
      const root = requestProjectRoot;
      const files = await readFolderUpload(request);
      if (root !== projectRoot()) return sendJson(request, response, 409, { error: "The project changed while the upload was being received.", code: "WEAVE_PROJECT_CHANGED" });
      if (startingRoots.has(root)) return sendJson(request, response, 409, { error: "Agent setup is capturing the project. Retry the import.", code: "WEAVE_AGENT_STARTING" });
      const reference = await runProjectLifecycle(() => importUploadedReferenceFolder(files, root,
        (stored, entry) => recordHumanFileMutation([...pendingTurns.values()].find((turn) => turn.root === root), { path: stored.path, entry }),
        () => assertHumanFileMutationReady(root)), { allowPending: true });
      return sendJson(request, response, 201, reference);
    }
    const proposalAsset = url.pathname.match(/^\/api\/proposals\/([a-f0-9-]{36})\/([abc])\/assets\/([^/]+)$/);
    if (request.method === "GET" && proposalAsset) { const filename = decodeURIComponent(proposalAsset[3]); assertAssetFilename(filename); return await sendAsset(request, response, filename, await proposals.assetPath(projectRoot(), proposalAsset[1], proposalAsset[2], filename)); }
    if (request.method === "GET" && url.pathname === "/api/proposals") return sendJson(request, response, 200, { proposals: await proposals.snapshot(projectRoot(), orchestrator.tasks) });
    if (request.method === "GET" && url.pathname === "/api/proposals/preview") return sendJson(request, response, 200, await proposals.preview(projectRoot(), url.searchParams.get("groupId"), url.searchParams.get("candidateId"), Number(url.searchParams.get("version"))));
    const payload = await readJson(request, url.pathname === "/api/assets" ? 14_000_000 : url.pathname === "/api/references" ? 36_000_000 : ["/api/save", "/api/draft", "/api/milestones"].includes(url.pathname) ? 5_000_000 : 1_500_000);

    if (request.method === "POST" && url.pathname === "/api/proposals/adopt") {
      codex.uiTools.authenticate(payload.uiSession);
      const root = projectRoot(); if (activeProjectTurn() || startingRoots.has(root)) throw new Error("資料への反映処理が終わってから採用してください。");
      const result = await proposals.adopt(root, payload, orchestrator.tasks);
      const adoptedGroup = proposals.group(await proposals.read(root), payload.groupId);
      const adoptedCandidate = proposals.candidate(adoptedGroup, payload.candidateId);
      const adoptedTask = orchestrator.tasks.find(task => task.id === adoptedCandidate.taskId);
      if (adoptedTask) {
        adoptedTask.applied = true; adoptedTask.activity = "ユーザーが選択したスライドへ採用済み";
        adoptedTask.outcome = { success: true, result: { projectRoot: root, changeCount: createEditorChangeSet(result.baseline, result.deck, "Adopt proposal").changes.length, conflictCount: 0 } };
        await orchestrator.save();
        void orchestrator.wake(adoptedGroup.threadId, `The human adopted candidate ${payload.candidateId} from proposal ${payload.groupId} on slides ${JSON.stringify(payload.slideIds)}. Report the actual adoption and use learning tools only for verified adopted changes.`).catch(error => console.error("Could not notify adoption:", error.message));
      }
      codex.events.publish("weave/project", { status: "updated", projectRoot: root, baseline: result.baseline, changes: createEditorChangeSet(result.baseline, result.deck, "Adopt proposal"), conflicts: [], deck: result.deck });
      return sendJson(request, response, 200, await statePayload());
    }
    if (request.method === "POST" && url.pathname === "/api/proposals/dismiss") { codex.uiTools.authenticate(payload.uiSession); await proposals.dismiss(projectRoot(), payload.groupId, orchestrator.tasks); return sendJson(request, response, 200, { proposals: await proposals.snapshot(projectRoot(), orchestrator.tasks) }); }
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

    if (request.method === "PATCH" && url.pathname === "/api/skills/learning") {
      return sendJson(request, response, 200, await setLearningEnabled({ enabled: payload.enabled, expectedRevision: payload.expectedRevision }));
    }

    if (activeProjectTurn() && request.method !== "GET" && /^\/api\/(?:skills|skill-proposals)(?:\/|$)/.test(url.pathname)) {
      return sendJson(request, response, 409, { error: "Finish the running Agent turn before changing skills.", code: "WEAVE_TURN_RUNNING" });
    }

    const skillReview = url.pathname.match(/^\/api\/skill-proposals\/([a-f0-9-]+)\/(accept|dismiss)$/);
    if (request.method === "POST" && skillReview) {
      const result = await runSkillMutation((root) => resolveSkillProposal(root, skillReview[1], skillReview[2]));
      return sendJson(request, response, 200, result);
    }

    const applicationSkillMutation = url.pathname.match(/^\/api\/skills\/application\/([^/]+)(?:\/(restore))?$/);
    if (applicationSkillMutation && ((request.method === "PATCH" && !applicationSkillMutation[2]) || (request.method === "POST" && applicationSkillMutation[2] === "restore"))) {
      const name = decodeSkillName(applicationSkillMutation[1]);
      const result = await runSkillMutation(async () => {
        if (startingRoots.size || pendingTurns.size || codex.activeTurns.size) throw Object.assign(new Error("Agentの処理が終わってから共通スキルを変更してください。"), { code: "WEAVE_TURN_RUNNING" });
        return applicationSkillMutation[2] === "restore"
          ? restoreApplicationSkill({ ...payload, name })
          : updateApplicationSkill({ ...payload, name });
      });
      return sendJson(request, response, 200, result);
    }

    if (request.method === "POST" && url.pathname === "/api/skills") {
      return sendJson(request, response, 201, await runSkillMutation((root) => createSkill(root, payload)));
    }
    if (request.method === "POST" && url.pathname === "/api/skills/upload") {
      return sendJson(request, response, 201, await runSkillMutation((root) => uploadSkill(root, payload)));
    }
    const scopedSkill = url.pathname.match(/^\/api\/skills\/(editor)\/([^/]+)$/);
    if (scopedSkill) {
      const [, scope, encodedName] = scopedSkill;
      const name = decodeSkillName(encodedName);
      if (request.method === "PATCH") {
        return sendJson(request, response, 200, await runSkillMutation((root) => Object.hasOwn(payload, "enabled")
          ? setEditorSkillEnabled(root, name, payload.enabled)
          : updateSkill(root, { ...payload, scope, currentName: name })));
      }
      if (request.method === "DELETE") {
        return sendJson(request, response, 200, await runSkillMutation((root) => deleteSkill(root, scope, name)));
      }
    }

    if (url.pathname === "/api/assets") {
      const root = requestProjectRoot;
      if (root !== projectRoot()) return sendJson(request, response, 409, { error: "The project changed while the upload was being received.", code: "WEAVE_PROJECT_CHANGED" });
      if (startingRoots.has(root)) return sendJson(request, response, 409, { error: "Agent setup is capturing the project. Retry the upload.", code: "WEAVE_AGENT_STARTING" });
      const asset = await runProjectLifecycle(() => importImageAsset(payload, root, (stored) => recordHumanFileMutation([...pendingTurns.values()].find((turn) => turn.root === root), { path: stored.path }), () => assertHumanFileMutationReady(root)), { allowPending: true });
      return sendJson(request, response, 201, asset);
    }
    if (url.pathname === "/api/references") {
      const root = requestProjectRoot;
      if (root !== projectRoot()) return sendJson(request, response, 409, { error: "The project changed while the import was being received.", code: "WEAVE_PROJECT_CHANGED" });
      if (startingRoots.has(root)) return sendJson(request, response, 409, { error: "Agent setup is capturing the project. Retry the import.", code: "WEAVE_AGENT_STARTING" });
      const reference = await runProjectLifecycle(() => importReference(payload, root, (stored, entry) => recordHumanFileMutation([...pendingTurns.values()].find((turn) => turn.root === root), { path: stored.path, entry }), () => assertHumanFileMutationReady(root)), { allowPending: true });
      return sendJson(request, response, 201, reference);
    }
    if (url.pathname === "/api/references/folder") {
      const root = requestProjectRoot;
      if (root !== projectRoot()) return sendJson(request, response, 409, { error: "The project changed while the import was being received.", code: "WEAVE_PROJECT_CHANGED" });
      if (startingRoots.has(root)) return sendJson(request, response, 409, { error: "Agent setup is capturing the project. Retry the import.", code: "WEAVE_AGENT_STARTING" });
      const reference = await runProjectLifecycle(() => registerReferenceFolder(payload, root, (stored, entry) => recordHumanFileMutation([...pendingTurns.values()].find((turn) => turn.root === root), { path: stored.path, entry }), () => assertHumanFileMutationReady(root)), { allowPending: true });
      return sendJson(request, response, 201, reference);
    }
    if (url.pathname === "/api/references/folder/sync") {
      const root = requestProjectRoot;
      if (root !== projectRoot()) return sendJson(request, response, 409, { error: "The project changed while the update was being received.", code: "WEAVE_PROJECT_CHANGED" });
      if (startingRoots.has(root)) return sendJson(request, response, 409, { error: "Agent setup is capturing the project. Retry the update.", code: "WEAVE_AGENT_STARTING" });
      const result = await runProjectLifecycle(() => syncReferenceFolder(payload.path, root, (_stored, entry) => recordHumanFileMutation([...pendingTurns.values()].find((turn) => turn.root === root), { path: payload.path, entry }), () => assertHumanFileMutationReady(root)), { allowPending: true });
      return sendJson(request, response, 200, result);
    }
    if (url.pathname === "/api/references/remove") {
      const root = requestProjectRoot;
      if (root !== projectRoot()) return sendJson(request, response, 409, { error: "The project changed while the removal was being received.", code: "WEAVE_PROJECT_CHANGED" });
      if (startingRoots.has(root)) return sendJson(request, response, 409, { error: "Agent setup is capturing the project. Retry the removal.", code: "WEAVE_AGENT_STARTING" });
      const references = await runProjectLifecycle(() => removeReference(payload.path, root, () => recordHumanFileMutation([...pendingTurns.values()].find((turn) => turn.root === root), { path: payload.path, remove: true }), () => assertHumanFileMutationReady(root)), { allowPending: true });
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
      await enqueueProjectSwitch(async () => {
        if (requestProjectRoot !== projectRoot()) throw Object.assign(new Error("資料が切り替わりました。履歴を読み直してください。"), { code: "WEAVE_PROJECT_CHANGED" });
        if (activeProjectTurn()) throw Object.assign(new Error("An Agent turn is running."), { code: "WEAVE_TURN_RUNNING" });
        await checkoutHistory(requireText(payload.commit, "History commit", 40), requireText(payload.expectedRevision, "Expected revision", 40), requestProjectRoot);
      });
      return sendJson(request, response, 200, await statePayload());
    }
    if (url.pathname === "/api/history/main") {
      if (activeProjectTurn()) return sendJson(request, response, 409, { error: "An Agent turn is running." });
      await enqueueProjectSwitch(async () => {
        if (requestProjectRoot !== projectRoot()) throw Object.assign(new Error("資料が切り替わりました。履歴を読み直してください。"), { code: "WEAVE_PROJECT_CHANGED" });
        if (activeProjectTurn()) throw Object.assign(new Error("An Agent turn is running."), { code: "WEAVE_TURN_RUNNING" });
        await checkoutMain(requireText(payload.expectedRevision, "Expected revision", 40), requestProjectRoot);
      });
      return sendJson(request, response, 200, await statePayload());
    }
    if (url.pathname === "/api/variations/checkout") {
      if (activeProjectTurn()) return sendJson(request, response, 409, { error: "An Agent turn is running." });
      await checkoutVariation(String(payload.branch ?? ""));
      return sendJson(request, response, 200, await statePayload());
    }
    if (url.pathname === "/api/variations/generate") {
      if (payload.model?.startsWith("claude:")) throw new Error("Request alternative directions through the orchestrator conversation.");
      const { thread, turn, branch } = await startEditorTurn(payload, { variation: true });
      return sendJson(request, response, 202, { thread, turn, branch });
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

    if (url.pathname === "/api/codex/tools") {
      const token = String(request.headers.authorization ?? "").replace(/^Bearer /, ""); const owner = toolCapabilities.get(token);
      if (!owner || codex.claude.activeTurns.get(owner.threadId) !== owner.turnId) return sendJson(request, response, 403, { error: "Tool capability expired." });
      if (payload.method === "tools/list") return sendJson(request, response, 200, { tools: claudeOrchestratorTools() });
      if (payload.method !== "tools/call") throw new Error("Unknown tool operation.");
      const name = payload.params?.name; const args = payload.params?.arguments;
      let result;
      if (name === "edit_slides") result = await delegateEdit(owner.threadId, args);
      else if (["tasks", "read_task_changes", "control_task", "review_edit", "get_slide_learning_context", "learn_slide_preference"].includes(name)) result = await codex.codex.onOrchestrationTool({ ...owner, tool: name, arguments: args });
      else if (["inspect", "click", "fill", "select", "key"].includes(name)) {
        result = await new Promise((resolve, reject) => {
          const requestId = randomUUID();
          try { codex.uiTools.dispatch({ id: requestId, params: { ...owner, namespace: "weave_ui", tool: name, arguments: args, callId: requestId } }, (_id, value) => resolve(value)); } catch (error) { reject(error); }
        });
      } else throw new Error("Tool is not available to this orchestrator.");
      return sendJson(request, response, 200, { content: [{ type: "text", text: JSON.stringify(result) }] });
    }
    if (url.pathname === "/api/codex/thread/start") {
      return sendJson(request, response, 201, { thread: await codex.startThread({ ...payload, purpose: "chat", cwd: projectRoot() }) });
    }
    if (url.pathname === "/api/codex/thread/prepare") {
      return sendJson(request, response, 200, await codex.ensureChatThread(payload.threadId, { cwd: projectRoot(), approvalPolicy: payload.approvalPolicy, model: payload.model }));
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
      if (["delete", "archive"].includes(payload.action) && orchestrator.tasks.some(task => task.threadId === payload.params?.threadId && !["completed", "failed", "cancelled"].includes(task.status))) throw new Error("担当の作業が残っています。先に会話の停止で作業を終了してください。");
      return sendJson(request, response, 200, await codex.threadAction(payload.action, payload.params ?? {}));
    }
    if (url.pathname === "/api/codex/turn/start" || url.pathname === "/api/codex/turn/steer") {
      const prompt = requireTurnPrompt(payload); const root = projectRoot();
      if (projectLifecycleBusy || codexProjectRoot !== root) return sendJson(request, response, 409, { error: "Project is switching. Retry after it is ready." });
      if (codex.forThread(payload.threadId) !== codex.forModel(payload.model)) throw new Error("The model provider differs from this conversation.");
      await codex.readThread(payload.threadId);
      const session = codex.uiTools.authenticate(payload.uiSession);
      if (session.activeThreadId !== payload.threadId) throw new Error("The browser session is not attached to this conversation.");
      const envelope = editorEnvelope(payload.contextEnvelope);
      if (!["apply", "compare"].includes(envelope.executionMode)) throw new Error("Choose edit or confirm before editing.");
      const receipt = await runProjectExclusive(async () => {
        const pending = [...pendingTurns.values()].find(turn => turn.root === root);
        if (pending && pending.acceptingDrafts) {
          if (payload.humanEdited === true) { pending.humanDraft = structuredClone(payload.deck); await updateRecoverySnapshot(pending.recoverySnapshot, { humanDraft: pending.humanDraft }, root); }
        } else if (!pending && payload.humanEdited === true && !startingRoots.has(root)) await writeProjectUnlocked(payload.deck, null, root);
        return await orchestrator.receive({ ...payload, root, prompt, userPrompt: prompt, contextEnvelope: envelope, approvalPolicy: "never" });
      }, root);
      return sendJson(request, response, 202, receipt);
    }
    if (url.pathname === "/api/codex/tasks/cancel") {
      const session = codex.uiTools.authenticate(payload.uiSession); if (session.activeThreadId !== payload.threadId) throw new Error("The browser session is not attached to this conversation.");
      return sendJson(request, response, 200, await runProjectExclusive(() => orchestrator.control(payload.threadId, { taskId: payload.taskId, version: payload.version, action: "cancel", instruction: "User cancelled this task." }), orchestrator.task(payload.threadId, payload.taskId).root));
    }
    if (url.pathname === "/api/codex/turn/interrupt") {
      await orchestrator.cancelConversation(payload.threadId);
      await Promise.all([...pendingTurns.entries()].filter(([, pending]) => pending.parentThreadId === payload.threadId).map(([threadId]) => codex.interruptTurn(threadId)));
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
    if (url.pathname === "/api/ui/session") {
      if (request.method === "POST") return sendJson(request, response, 201, codex.uiTools.registerSession(payload));
      if (request.method === "PATCH") return sendJson(request, response, 200, codex.uiTools.touchSession(payload));
      if (request.method === "DELETE") return sendJson(request, response, 200, codex.uiTools.releaseSession(payload));
    }
    if (request.method === "POST" && url.pathname === "/api/ui/response") {
      const pending = codex.uiTools.pending.get(payload.response?.requestId);
      const result = codex.uiTools.respond(payload);
      const targetId = pending?.arguments.target?.id;
      if (payload.response.status === "completed" && pending?.tool === "click" && (targetId === "create-project" || targetId?.startsWith("project-")) && payload.editorContext !== null && payload.editorContext !== undefined) {
        const next = payload.editorContext;
        if (next.root !== projectRoot()) throw new Error("The project changed before its UI result was recorded.");
        const context = orchestrator.context(pending.threadId);
        context.root = next.root; context.contextEnvelope = editorEnvelope(next.contextEnvelope);
        await orchestrator.save();
      }
      return sendJson(request, response, 200, result);
    }
    return sendJson(request, response, 404, { error: "Not found." });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = ["WEAVE_REVISION_CONFLICT", "WEAVE_SKILL_CONFLICT", "WEAVE_PROJECT_CHANGED", "WEAVE_TURN_RUNNING", "WEAVE_UI_REPLAY", "WEAVE_UI_NOT_PENDING", "WEAVE_UI_SESSION_MISMATCH", "WEAVE_UI_OWNERSHIP_REQUIRED"].includes(error?.code) ? 409
      : ["WEAVE_UI_UNAUTHORIZED", "WEAVE_UI_SESSION_EXPIRED"].includes(error?.code) ? 401
      : error?.code === "WEAVE_SKILL_NOT_FOUND" ? 404
      : ["WEAVE_SKILL_INVALID", "WEAVE_LEARNING_INVALID"].includes(error?.code) ? 400
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
  await orchestrator.stop();
  await codex.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
