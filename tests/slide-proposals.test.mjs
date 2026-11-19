import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const tasks = [];
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
  }, tasks);
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
async function createComparison(t, store, root, scope, taskList) {
  const group = await store.create(root, {
    threadId: "parent",
    prompt: "新しい比較",
    scope,
    directions,
  }, taskList);
  t.after(() => rm(join(project.workspacesRoot, ".proposals", group.id), {
    recursive: true,
    force: true,
  }));
  return group;
}
test("creating an overlapping comparison dismisses inactive open groups and retains their history", async (t) => {
  for (const statuses of [[], ["failed", "failed", "failed"], ["completed", "failed", "cancelled"]]) {
    await t.test(statuses.join(",") || "no tasks", async (t) => {
      const { store, root, group } = await setup(t);
      const inactiveTasks = statuses.map((status, index) => ({
        id: `${group.id}-${index}`,
        status,
      }));
      for (const [index, task] of inactiveTasks.entries())
        await store.attach(root, group.id, group.candidates[index].id, task.id);
      const previous = (await store.read(root))[0];
      const next = await createComparison(t, store, root, {
        kind: "slides", slideIds: ["cover"], elementId: null,
      }, inactiveTasks);
      const saved = await store.read(root);
      assert.deepEqual(saved[0], { ...previous, state: "dismissed" });
      assert.deepEqual(saved.filter((g) => g.state === "open").map((g) => g.id), [next.id]);
    });
  }
});
test("creating an overlapping comparison leaves groups with a running candidate open", async (t) => {
  const { store, root, group } = await setup(t);
  const activeTasks = [{ id: `${group.id}-active`, status: "running" }];
  await store.attach(root, group.id, "b", activeTasks[0].id);
  const previous = (await store.read(root))[0];
  const next = await createComparison(t, store, root, {
    kind: "slides", slideIds: ["cover"], elementId: null,
  }, activeTasks);
  const saved = await store.read(root);
  assert.deepEqual(saved[0], previous);
  assert.deepEqual(saved.filter((g) => g.state === "open").map((g) => g.id), [group.id, next.id]);
  assert.equal(activeTasks[0].status, "running");
});
test("creating a comparison leaves non-overlapping groups unchanged", async (t) => {
  const { store, root, group } = await setup(t);
  group.scope = { kind: "slides", slideIds: ["second"], elementId: null };
  await store.save(root, [group]);
  const next = await createComparison(t, store, root, {
    kind: "slides", slideIds: ["cover"], elementId: null,
  }, []);
  const saved = await store.read(root);
  assert.deepEqual(saved[0], group);
  assert.deepEqual(saved.filter((g) => g.state === "open").map((g) => g.id), [group.id, next.id]);
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
  }, tasks);
  assert.equal(checked, true);
  assert.equal(group.prepared, true);
});

test("working previews use stable snapshots and remain unadoptable until reviewed", async (t) => {
  const { store, root, group, deck } = await setup(t);
  const initial = await store.preview(root, group.id, "a", 1);
  assert.equal(initial.phase, "baseline");
  assert.equal(initial.reviewed, false);
  assert.deepEqual(initial.deck, deck);
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

test("proposal adoption is offered per slide without the bulk adoption button", async () => {
  const source = await readFile(
    new URL("../app/components/SlideProposals.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /未採用の対象すべてに採用/);
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
