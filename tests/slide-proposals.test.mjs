import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
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
  });
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
