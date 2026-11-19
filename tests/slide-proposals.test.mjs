import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const temporary = await mkdtemp(join(tmpdir(), "weave-slide-proposals-"));
process.env.WEAVE_WORKSPACES_ROOT = join(temporary, "workspaces");
process.env.WEAVE_PROJECT_ROOT = join(temporary, "initial");
const project = await import("../server/project.mjs");
const { SlideProposals, validateDirections } =
  await import("../server/slide-proposals.mjs");
const directions = [
  {
    title: "結論を先に",
    description: "結論と根拠を同時に伝える。",
    instruction: "結論と根拠を並べる。",
  },
  {
    title: "数値を強調",
    description: "数値を第一に強調する。",
    instruction: "数値を大きく見せる。",
  },
  {
    title: "図で説明",
    description: "業務の変化を見せる。",
    instruction: "業務の流れを図解する。",
  },
];
const { Orchestration } = await import("../server/orchestration.mjs");
const tasks = [];
const noTasksRunning = async (tasks) => { assert.ok(tasks.every(task => ["completed", "failed", "cancelled"].includes(task.status))); };
async function setup(t) {
  const slug = await project.createProject({
    title: "Original",
    templateId: "grid",
  });
  const root = join(project.workspacesRoot, slug);
  const deck = await project.readProject(root);
  deck.slides.push({
    ...deck.slides[0],
    id: "second",
    title: "Second",
    html: deck.slides[0].html.replace("Original", "Second"),
  });
  await project.writeProject(deck, null, root);
  const store = new SlideProposals({
    workspaceRoot: project.workspacesRoot,
    publish: () => {},
  });
  const group = await store.create(root, {
    threadId: "parent",
    prompt: "比較する",
    scope: { kind: "deck", slideIds: [], elementId: null },
    directions,
  }, tasks, noTasksRunning);
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(join(project.workspacesRoot, ".proposals", group.id), {
      recursive: true,
      force: true,
    });
  });
  return { store, root, group, deck: await project.readProject(root) };
}
async function complete(store, root, group, id) {
  const task = {
    id: `${group.id}-${id}`,
    status: "completed",
    version: 1,
    approvedVersion: 1,
    review: "変更範囲と内容を確認済み。",
    error: null,
  };
  tasks.push(task);
  await store.attach(root, group.id, id, task.id);
  const candidate = store.candidate(group, id);
  const work = store.workspace(group, candidate);
  const deck = await project.readProject(work);
  deck.slides = deck.slides.map((s) => ({
    ...s,
    html: s.html.replace(/Original|Second/g, `Candidate ${id}`),
  }));
  await project.writeProject(deck, null, work);
  await store.finish(root, group.id, id, task);
  return task;
}
async function createComparison(t, store, root, scope, taskList, cancelAndWait) {
  const group = await store.create(root, {
    threadId: "parent", prompt: "新しい比較", scope, directions,
  }, taskList, cancelAndWait);
  t.after(() => rm(join(project.workspacesRoot, ".proposals", group.id), {
    recursive: true, force: true,
  }));
  return group;
}
test("new comparisons remove overlapping open groups and their workspaces, including history", async (t) => {
  const { store, root, group } = await setup(t);
  const task = await complete(store, root, group, "a");
  const next = await createComparison(t, store, root, {
    kind: "current-slide", slideIds: ["cover"], elementId: null,
  }, tasks, noTasksRunning);
  assert.deepEqual((await store.snapshot(root, tasks)).map(g => g.id), [next.id]);
  await assert.rejects(access(join(project.workspacesRoot, ".proposals", group.id)), { code: "ENOENT" });
  await assert.doesNotReject(store.finish(root, group.id, "a", task));
  const deletedTask = { root, proposal: { groupId: group.id, candidateId: "a" } };
  assert.deepEqual(await store.recoveryRoots([deletedTask]), []);
});
test("replacing a running comparison waits for cancellation and settlement before deleting its workspace", async (t) => {
  const { store, root, group } = await setup(t);
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let releaseStartup;
  const startup = new Promise(resolve => { releaseStartup = resolve; });
  let releaseWorker;
  const stopped = new Promise(resolve => { releaseWorker = resolve; });
  const folder = join(project.workspacesRoot, ".proposals", group.id);
  let manager;
  manager = new Orchestration({
    path: join(root, ".weave", "orchestration-test.json"),
    events: { publish() {} },
    interruptWorker: async () => {
      assert.equal(manager.tasks[0].status, "cancelling");
      await access(folder);
      assert.equal((await store.read(root))[0].id, group.id);
      releaseWorker();
    },
    execute: async task => {
      started();
      await startup;
      await manager.workerStarted(task.id, "worker", "turn");
      await stopped;
      await writeFile(join(folder, "last-write.txt"), "stopped");
      return { success: false, error: "cancelled" };
    },
    onTaskSettled: async task => {
      await access(folder);
      await store.finish(root, group.id, "b", task);
    },
  });
  const task = { id: "old-worker", root, threadId: "parent", version: 1, status: "queued", instructionStatus: "current", attempt: 0, proposal: { groupId: group.id, candidateId: "b" } };
  manager.tasks.push(task);
  await store.attach(root, group.id, "b", task.id);
  await manager.run();
  await ready;
  const next = await createComparison(t, store, root, {
    kind: "deck", slideIds: [], elementId: null,
  }, manager.tasks, async tasks => {
    const cancellation = manager.cancelAndWait(tasks);
    releaseStartup();
    await cancellation;
  });
  assert.equal(task.status, "cancelled");
  assert.equal(manager.runningTasks.size, 0);
  assert.deepEqual((await store.read(root)).map(g => g.id), [next.id]);
  await assert.rejects(access(folder), { code: "ENOENT" });
  await assert.doesNotReject(store.finish(root, group.id, "b", task));
  assert.equal(task.status, "cancelled");
});
test("non-overlapping open groups and adopted or dismissed history remain unchanged", async (t) => {
  const { store, root, group } = await setup(t);
  group.scope = { kind: "current-slide", slideIds: ["second"], elementId: null };
  await store.save(root, [group]);
  const adopted = await createComparison(t, store, root, {
    kind: "current-slide", slideIds: ["cover"], elementId: null,
  }, [], noTasksRunning);
  adopted.state = "adopted";
  await store.save(root, [group, adopted]);
  const dismissed = await createComparison(t, store, root, adopted.scope, [], noTasksRunning);
  await store.dismiss(root, dismissed.id, []);
  const previous = await store.read(root);
  const next = await createComparison(t, store, root, adopted.scope, [], noTasksRunning);
  const saved = await store.read(root);
  assert.deepEqual(saved.slice(0, -1), previous);
  assert.equal(saved.at(-1).id, next.id);
  for (const existing of previous)
    await access(join(project.workspacesRoot, ".proposals", existing.id));
  assert.deepEqual(await store.recoveryRoots([{ root, proposal: { groupId: dismissed.id, candidateId: "a" } }]), [store.workspace(dismissed, dismissed.candidates[0])]);
});
test("exactly three distinct directions are required, with no inferred direction fallback", () => {
  assert.throws(() => validateDirections(undefined), /3方向/);
  assert.throws(() => validateDirections(directions.slice(1)), /3方向/);
  assert.throws(
    () => validateDirections([directions[0], directions[0], directions[2]]),
    /異なる/,
  );
  validateDirections(directions);
});
test("candidates have independent identical baselines and remain discoverable after reloading without changing the live deck", async (t) => {
  const { store, root, group, deck } = await setup(t);
  for (const c of group.candidates)
    assert.deepEqual(
      await project.readProject(store.workspace(group, c)),
      deck,
    );
  await complete(store, root, group, "a");
  assert.deepEqual(await project.readProject(root), deck);
  const reloaded = new SlideProposals({
    workspaceRoot: project.workspacesRoot,
    publish: () => {},
  });
  const snapshot = await reloaded.snapshot(root, tasks);
  assert.deepEqual(snapshot[0].slideIds, ["cover", "second"]);
  assert.equal(snapshot[0].candidates[0].available.adopt, true);
  assert.deepEqual(
    await project.readProject(store.workspace(group, group.candidates[1])),
    deck,
  );
});
test("adoption copies a referenced extracted image retained in the candidate workspace", async (t) => {
  const { store, root, group } = await setup(t);
  const task = await complete(store, root, group, "a");
  const work = store.workspace(group, store.candidate(group, "a"));
  const deck = await project.readProject(work);
  const snapshot = await project.createAgentFileSnapshot(work);
  const bytes = Buffer.from("original extracted image");
  const asset = `assets/${createHash("sha256").update(bytes).digest("hex")}.png`;
  try {
    await writeFile(join(work, asset), bytes);
    deck.slides[0].html += `<img src="${asset}" data-weave-id="extracted-image">`;
    await project.restoreAgentFileSnapshot(snapshot, work, { deck });
    await project.writeProject(deck, null, work);
    await store.finish(root, group.id, "a", task);
    await store.adopt(root, {
      groupId: group.id, candidateId: "a", version: 1,
      slideIds: [deck.slides[0].id], expectedRevision: project.getRevision(root),
    }, tasks);
    assert.deepEqual(await readFile(join(root, asset)), bytes);
    assert.ok((await project.readProject(root)).slides[0].html.includes(asset));
  } finally { await project.discardAgentFileSnapshot(snapshot, work); }
});

test("partial adoption preserves concurrent edits and keeps remaining slide proposals selectable", async (t) => {
  const { store, root, group, deck } = await setup(t);
  await complete(store, root, group, "a");
  await complete(store, root, group, "b");
  const current = structuredClone(deck);
  current.slides[1].notes = "Human note";
  await project.writeProject(current, null, root);
  await store.adopt(
    root,
    {
      groupId: group.id,
      candidateId: "a",
      version: 1,
      slideIds: ["cover"],
      expectedRevision: project.getRevision(root),
    },
    tasks,
  );
  const after = await project.readProject(root);
  assert.match(after.slides[0].html, /Candidate a/);
  assert.match(after.slides[1].html, /Second/);
  assert.equal(after.slides[1].notes, "Human note");
  let snapshot = (await store.snapshot(root, tasks))[0];
  assert.equal(snapshot.state, "open");
  assert.deepEqual(snapshot.selections, { cover: "a" });
  await store.adopt(
    root,
    {
      groupId: group.id,
      candidateId: "b",
      version: 1,
      slideIds: ["second"],
      expectedRevision: project.getRevision(root),
    },
    tasks,
  );
  snapshot = (await store.snapshot(root, tasks))[0];
  assert.equal(snapshot.state, "adopted");
  assert.deepEqual(snapshot.selections, { cover: "a", second: "b" });
  assert.equal((await project.readProject(root)).slides[1].notes, "Human note");
});
test("conflicting human edits, stale previews, unreviewed candidates and duplicate adoption are rejected", async (t) => {
  const { store, root, group, deck } = await setup(t);
  await assert.rejects(
    store.adopt(
      root,
      {
        groupId: group.id,
        candidateId: "a",
        version: 1,
        slideIds: ["cover"],
        expectedRevision: project.getRevision(root),
      },
      tasks,
    ),
    /レビュー/,
  );
  await complete(store, root, group, "a");
  await assert.rejects(store.preview(root, group.id, "a", 0), /最新/);
  const changed = structuredClone(deck);
  changed.slides[0].html = changed.slides[0].html.replace("Original", "Human");
  await project.writeProject(changed, null, root);
  await assert.rejects(
    store.adopt(
      root,
      {
        groupId: group.id,
        candidateId: "a",
        version: 1,
        slideIds: ["cover"],
        expectedRevision: project.getRevision(root),
      },
      tasks,
    ),
    /競合/,
  );
  assert.match((await project.readProject(root)).slides[0].html, /Human/);
  await project.writeProject(deck, null, root);
  await store.adopt(
    root,
    {
      groupId: group.id,
      candidateId: "a",
      version: 1,
      slideIds: ["cover"],
      expectedRevision: project.getRevision(root),
    },
    tasks,
  );
  await assert.rejects(
    store.adopt(
      root,
      {
        groupId: group.id,
        candidateId: "a",
        version: 1,
        slideIds: ["cover"],
        expectedRevision: project.getRevision(root),
      },
      tasks,
    ),
    /採用済み/,
  );
});
test("revising one candidate invalidates old selection and does not alter peer candidates", async (t) => {
  const { store, root, group } = await setup(t);
  await complete(store, root, group, "a");
  await store.attach(root, group.id, "a", "new-worker", { revise: true });
  await assert.rejects(
    store.target(root, { groupId: group.id, candidateId: "a", version: 1 }),
    /更新/,
  );
  const saved = (await store.read(root))[0];
  assert.equal(saved.candidates[0].version, 2);
  assert.equal(saved.candidates[0].ready, false);
  assert.equal(saved.candidates[1].version, 1);
});
test("ending proposals is explicit and retained as history rather than deleting generated alternatives", async (t) => {
  const { store, root, group } = await setup(t);
  await complete(store, root, group, "a");
  await store.dismiss(root, group.id, tasks);
  assert.equal((await store.snapshot(root, tasks))[0].state, "dismissed");
  assert.ok((await store.preview(root, group.id, "a", 1)).deck);
});
test.after(async () => {
  await rm(temporary, { recursive: true, force: true });
});

test("duplicated projects do not share mutable candidate workspaces with the source", async (t) => {
  const { store, root, group } = await setup(t);
  await complete(store, root, group, "a");
  const slug = root.split("/").at(-1);
  const duplicate = await project.duplicateProject(slug);
  const duplicatedRoot = join(project.workspacesRoot, duplicate);
  t.after(() => rm(duplicatedRoot, { recursive: true, force: true }));
  assert.deepEqual(await store.read(duplicatedRoot), []);
  assert.equal((await store.read(root)).length, 1);
});

test("a reviewed candidate is adoptable while the other two subagents remain preview-only", async (t) => {
  const { store, root, group } = await setup(t);
  const peers = ["b", "c"].map((id) => ({
    id: `${group.id}-${id}`,
    status: "running",
    activity: id === "b" ? "ファイルを編集中" : "実装方法を検討中",
    startedAt: 100,
    workerStartedAt: 120,
    approvedVersion: null,
    version: 1,
  }));
  tasks.push(...peers);
  await store.attach(root, group.id, "b", peers[0].id);
  await store.attach(root, group.id, "c", peers[1].id);
  await complete(store, root, group, "a");
  const snapshot = (await store.snapshot(root, tasks))[0];
  assert.deepEqual(
    snapshot.candidates.map((candidate) => candidate.available.view),
    [true, true, true],
  );
  assert.deepEqual(
    snapshot.candidates.map((candidate) => candidate.status),
    ["ready", "running", "running"],
  );
  assert.equal(snapshot.candidates[1].activity, "ファイルを編集中");
  assert.equal(snapshot.candidates[2].activity, "実装方法を検討中");
  assert.equal(snapshot.candidates[1].workerStartedAt, 120);
  assert.ok((await store.preview(root, group.id, "a", 1)).deck);
  assert.equal(snapshot.candidates[0].available.adopt, true);
});

test("proposal choices are published before workspace copying starts", async (t) => {
  const { store, root } = await setup(t);
  const originalCopy = store.copyWorkspace.bind(store);
  let checked = false;
  let newId;
  store.copyWorkspace = async (source, destination) => {
    if (!checked) {
      const saved = await store.read(root);
      const pending = saved.at(-1);
      newId = pending.id;
      assert.equal(pending.prepared, false);
      assert.equal(pending.candidates.length, 3);
      const snapshot = (await store.snapshot(root, tasks)).at(-1);
      assert.deepEqual(
        snapshot.candidates.map((c) => c.status),
        ["preparing", "preparing", "preparing"],
      );
      assert.equal(
        snapshot.candidates.some((c) => c.available.adopt),
        false,
      );
      checked = true;
    }
    return originalCopy(source, destination);
  };
  t.after(async () => {
    if (newId)
      await rm(join(project.workspacesRoot, ".proposals", newId), {
        recursive: true,
        force: true,
      });
  });
  const group = await store.create(root, {
    threadId: "parent",
    prompt: "Create another comparison",
    scope: { kind: "deck", slideIds: [], elementId: null },
    directions,
  }, tasks, noTasksRunning);
  assert.equal(checked, true);
  assert.equal(group.prepared, true);
});

test("working previews use stable snapshots and remain unadoptable until reviewed", async (t) => {
  const { store, root, group, deck } = await setup(t);
  const initial = await store.preview(root, group.id, "a", 1);
  assert.equal(initial.phase, "baseline");
  assert.equal(initial.reviewed, false);
  assert.deepEqual(initial.deck, deck);
  assert.equal((await store.snapshot(root, tasks))[0].candidates[0].addedSlideCount, 0);
  let live = null;
  const reader = new SlideProposals({
    workspaceRoot: project.workspacesRoot,
    publish: () => {},
    livePreview: () => live,
  });
  const task = {
    id: `${group.id}-live`,
    status: "running",
    version: 1,
    attempt: 1,
    approvedVersion: null,
    activity: "ファイルを編集中",
  };
  tasks.push(task);
  await reader.attach(root, group.id, "a", task.id);
  const changed = structuredClone(deck);
  changed.slides[0].html = changed.slides[0].html.replace(
    "Original",
    "Work in progress",
  );
  changed.slides.push(
    { ...changed.slides[0], id: "pptx-02" },
    { ...changed.slides[0], id: "pptx-03" },
  );
  live = {
    deck: changed,
    css: initial.css,
    templates: initial.templates,
    revision: "worker:1",
  };
  await writeFile(
    join(reader.workspace(group, group.candidates[0]), "slides", "cover.html"),
    "<partial markup",
  );
  const preview = await reader.preview(root, group.id, "a", 1);
  assert.equal(preview.phase, "working");
  assert.equal(preview.reviewed, false);
  assert.deepEqual(preview.deck, changed);
  const candidate = (await reader.snapshot(root, tasks))[0].candidates[0];
  assert.equal(candidate.available.view, true);
  assert.equal(candidate.available.adopt, false);
  assert.equal(candidate.previewRevision, preview.previewRevision);
  assert.equal(candidate.addedSlideCount, 2);
  assert.deepEqual(candidate.addedSlideIds, ["pptx-02", "pptx-03"]);
  assert.deepEqual(candidate.slideOrder, changed.slides.map(slide => slide.id));
  // Replacing a base slide must count the new ID, rather than the net deck growth.
  live = { ...live, deck: { ...changed, slides: changed.slides.filter((s) => s.id !== "second") } };
  assert.equal((await reader.snapshot(root, tasks))[0].candidates[0].addedSlideCount, 2);
  live = { ...live, revision: "worker:2" };
  assert.notEqual(
    (await reader.preview(root, group.id, "a", 1)).previewRevision,
    preview.previewRevision,
  );
  await assert.rejects(
    reader.adopt(
      root,
      {
        groupId: group.id,
        candidateId: "a",
        version: 1,
        slideIds: ["cover"],
        expectedRevision: project.getRevision(root),
      },
      tasks,
    ),
    /レビュー/,
  );
  assert.deepEqual(await project.readProject(root), deck);
});

test("a restart marks interrupted preparation as failed without resuming or editing the deck", async (t) => {
  const { store, root, deck } = await setup(t);
  const groups = await store.read(root);
  groups[0].prepared = false;
  groups[0].preparationError = null;
  await store.save(root, groups);
  const restored = new SlideProposals({
    workspaceRoot: project.workspacesRoot,
    publish: () => {},
  });
  await restored.recover(root);
  const group = (await restored.snapshot(root, tasks))[0];
  assert.match(group.preparationError, /自動再開/);
  assert.deepEqual(
    group.candidates.map((c) => c.status),
    ["failed", "failed", "failed"],
  );
  assert.equal(
    group.candidates.some((c) => c.available.view || c.available.adopt),
    false,
  );
  assert.deepEqual(await project.readProject(root), deck);
});

test("proposal targets are cleared on project changes or missing groups, including while drafting", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /if \(activeProjectRootRef\.current !== state\.project\.root\) setProposalTarget\(null\);\s*setProject\(state\.project\);\s*activeProjectRootRef\.current = state\.project\.root;/);
  assert.match(page, /if \(!proposalTarget\) return;\s*if \(!proposalGroups\.some\(group => group\.id === proposalTarget\.groupId\)\) \{ const timer = window\.setTimeout\(\(\) => setProposalTarget\(null\), 0\); return \(\) => window\.clearTimeout\(timer\); \}\s*if \(promptDraft\.trim\(\)\) return;/);
  assert.match(page, /\}, \[proposalGroups, proposalTarget, promptDraft, activeSlideId\]\);/);
});

test("proposal adoption is offered per slide without the bulk adoption button", async () => {
  const source = await readFile(
    new URL("../app/components/SlideProposals.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /未採用の対象すべてに採用/);
  assert.match(source, /onAdopt\(group, selected, \[previewSlideId\]\)/);
});

test("proposal descriptions are shown in an accessible overlay outside the action bar flow", async () => {
  const source = await readFile(
    new URL("../app/components/SlideProposals.tsx", import.meta.url),
    "utf8",
  );
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /<button[\s\S]*?aria-expanded=\{descriptionOpen\}[\s\S]*?aria-controls=\{descriptionId\}[\s\S]*?>\s*説明\s*<\/button>/,
  );
  assert.match(
    source,
    /id=\{descriptionId\}\s*className="proposal-description-popover"\s*hidden=\{!descriptionOpen\}[\s\S]*?selected.description !== null && <p>\{selected.description\}<\/p>/,
  );
  assert.equal(source.match(/<p>\{selected.description\}<\/p>/g)?.length, 1);
  assert.match(css, /\.proposal-description-popover \{ position: absolute; bottom:/);
  assert.match(source, /className="canvas-toolbar proposal-action-bar"/);
  assert.doesNotMatch(source, /proposal-selected-details|proposal-description-title/);
  assert.match(source, /event.key === "Escape"/);
  assert.match(source, /setDescriptionOpen\(false\);\s*setSelection\(/);
});


test("selecting one proposal keeps the compact strip and canvas mounted", async () => {
  const source = await readFile(
    new URL("../app/components/SlideProposals.tsx", import.meta.url),
    "utf8",
  );
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const open = source.match(/data-open=\{([\s\S]*?)\}/)?.[1];
  assert.match(open, /compare/);
  assert.match(open, /compare \|\|\s*\(history && !selected\) \|\|\s*visible.some/);
  assert.match(source, /selected &&\s*group &&\s*previewContainer &&\s*createPortal\(/);
  assert.match(page, /className="proposal-preview-container" ref=\{setProposalPreviewContainer\}/);
  assert.match(css, /\.proposal-preview-container \{ position: absolute; inset: 0;/);
  assert.match(css, /\.proposal-preview \{ position: absolute; inset: 0;/);
  assert.match(source, /className="proposal-tabs"/);
  assert.match(source, /className=\{`proposal-state-dot \$\{c.status\}`\}\s*aria-hidden="true"/);
  assert.match(css, /\.proposal-state-dot \{ flex: 0 0 10px; width: 10px; height: 10px;/);
  assert.match(css, /\.proposal-state-dot:is\(\.preparing, \.queued, \.running, \.reviewing, \.applying, \.completed, \.cancelling\) \{ border:/);
  assert.match(css, /\.proposal-state-dot:is\(\.failed, \.cancelled\) \{ background-color: var\(--danger\);/);
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{ \.proposal-state-dot:is\([^)]*\) \{ animation: proposal-state-spin/);

  assert.doesNotMatch(source, /proposal-choice-selected|proposal-progress/);
  assert.match(css, /\.proposal-workspace\[data-open="false"\] \{[^}]*height: 56px;/);
  assert.match(source, /className="proposal-choice-title"/);
  assert.match(css, /\.proposal-toolbar \.proposal-choice \{[^}]*flex: 1 1 0; min-width: 0;/);
  assert.doesNotMatch(source, /proposal-name-label/);
  assert.match(source, /className="proposal-description-name"/);
  assert.doesNotMatch(css, /proposal-name-label/);
  assert.match(css, /@container proposal-panel \(max-width: 420px\) \{ \.proposal-choice-status-text \{ display: none;/);

});

test("resumed tasks use the same proposal workspace and publish readiness, while replaced candidates cannot run", async t => {
  const { store, root, group } = await setup(t);
  const task = { id: 'resumed-task', root, proposal: { groupId: group.id, candidateId: 'a' }, status: 'failed', error: 'Editor restarted', applied: false };
  await store.attach(root, group.id, 'a', task.id);
  const work = await store.executionWorkspace(task);
  assert.equal(work, store.workspace(group, group.candidates[0]));
  assert.deepEqual(await project.readProject(work), group.baseDeck);
  task.status = 'running'; task.error = null;
  assert.equal((await store.snapshot(root, [task]))[0].candidates[0].status, 'running');
  task.status = 'completed';
  await store.finish(root, group.id, 'a', task);
  assert.equal((await store.snapshot(root, [task]))[0].candidates[0].status, 'ready');
  await createComparison(t, store, root, group.scope, [task], noTasksRunning);
  await assert.rejects(store.executionWorkspace(task), /提案が見つかりません/);
  await assert.rejects(access(work));
});

test("deck proposals share the displayed slide ID across candidates and comparison", async () => {
  const source = await readFile(
    new URL("../app/components/SlideProposals.tsx", import.meta.url), "utf8",
  );
  assert.doesNotMatch(source, /setPreviewSlide\(null\)/);
  const comparison = source.slice(source.indexOf('{compare && ('));
  assert.ok(
    /<SlideFrame\b[^>]*slideId=\{displayedSlideId\(g\)\}/.test(comparison) &&
    /slideNavigation\(/.test(comparison),
    "比較画面は表示中のスライドを各案で表示し、スライド移動を提供する",
  );
});


test("new deck slides are adopted between existing slides in candidate order", async (t) => {
  const { store, root, group, deck } = await setup(t);
  const task = { id: `${group.id}-insert`, status: "completed", version: 1, approvedVersion: 1, review: "確認済み", error: null };
  tasks.push(task);
  await store.attach(root, group.id, "a", task.id);
  const work = store.workspace(group, group.candidates[0]);
  const proposal = structuredClone(deck);
  proposal.slides.splice(1, 0, { ...deck.slides[0], id: "pptx-02" }, { ...deck.slides[0], id: "pptx-03" });
  await project.writeProject(proposal, null, work);
  await store.finish(root, group.id, "a", task);
  const snapshot = (await store.snapshot(root, tasks))[0];
  assert.deepEqual(snapshot.candidates[0].addedSlideIds, ["pptx-02", "pptx-03"]);
  assert.deepEqual(snapshot.candidates[0].slideOrder, proposal.slides.map(s => s.id));
  assert.deepEqual((await project.readProject(root)).slides.map(s => s.id), deck.slides.map(s => s.id));
  for (const id of ["pptx-03", "pptx-02"]) {
    await store.adopt(root, { groupId: group.id, candidateId: "a", version: 1, slideIds: [id], expectedRevision: project.getRevision(root) }, tasks);
  }
  assert.deepEqual((await project.readProject(root)).slides.map(s => s.id), proposal.slides.map(s => s.id));
  assert.deepEqual((await store.snapshot(root, tasks))[0].candidates[0].addedSlideIds, []);
});
