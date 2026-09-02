import assert from "node:assert/strict";
import test from "node:test";

import { changedSlideIds, ProjectPreviewMonitor } from "../server/project-preview.mjs";

const slide = (id, html = `<main>${id}</main>`) => ({ id, title: id, notes: "", templateId: "orbit", layoutId: "content", accent: "#fff", html });
const deck = (...slides) => ({ title: "Deck", defaultTemplateId: "orbit", slides });

function harness({ baseline = deck(slide("one")), snapshots = [] } = {}) {
  let now = 0;
  let tick = null;
  const events = [];
  const accepted = [];
  const queue = [...snapshots];
  const monitor = new ProjectPreviewMonitor({
    baseline,
    readSnapshot: async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next ?? baseline;
    },
    publish: (event) => events.push(event),
    onSnapshot: (snapshot) => accepted.push(snapshot),
    pollInterval: 300,
    settleMs: 400,
    minPublishInterval: 700,
    now: () => now,
    setIntervalFn: (callback) => { tick = callback; return { unref() {} }; },
    clearIntervalFn: () => { tick = null; },
  }).start();
  return {
    monitor,
    events,
    accepted,
    advance(milliseconds) { now += milliseconds; },
    async sample() { await monitor.sample(); },
    async tick() { await tick?.(); },
  };
}

test("publishes a changed snapshot only after it remains settled", async () => {
  const updated = deck(slide("one", "<main>updated</main>"));
  const run = harness({ snapshots: [updated, updated, updated] });
  await run.sample();
  run.advance(399);
  await run.sample();
  assert.deepEqual(run.events, []);
  run.advance(1);
  await run.sample();
  assert.deepEqual(run.events, [{ changedSlideIds: ["one"], previewSequence: 1 }]);
  assert.deepEqual(run.accepted, [updated]);
});

test("deduplicates snapshots, recovers from read errors, and stops idempotently", async () => {
  const updated = deck(slide("one", "<main>updated</main>"));
  const run = harness({ snapshots: [new Error("partial write"), updated, updated, updated] });
  await run.sample();
  await run.sample();
  run.advance(400);
  await run.sample();
  await run.sample();
  assert.equal(run.events.length, 1);
  run.monitor.stop();
  run.monitor.stop();
  run.advance(1_000);
  await run.sample();
  assert.equal(run.events.length, 1);
});

test("a transient read error restarts the candidate settle window", async () => {
  const updated = deck(slide("one", "<main>updated</main>"));
  const run = harness({ snapshots: [updated, new Error("partial write"), updated, updated] });
  await run.sample();
  run.advance(200);
  await run.sample();
  run.advance(200);
  await run.sample();
  assert.equal(run.events.length, 0);
  run.advance(400);
  await run.sample();
  assert.equal(run.events.length, 1);
});

test("enforces the minimum publish interval between stable checkpoints", async () => {
  const first = deck(slide("one", "<main>first</main>"));
  const second = deck(slide("one", "<main>second</main>"));
  const run = harness({ snapshots: [first, first, second, second, second] });
  await run.sample();
  run.advance(400);
  await run.sample();
  run.advance(1);
  await run.sample();
  run.advance(400);
  await run.sample();
  assert.equal(run.events.length, 1);
  run.advance(299);
  await run.sample();
  assert.equal(run.events.length, 2);
});

test("reports changed, added, and removed slide ids in project order", () => {
  const before = deck(slide("one"), slide("removed"));
  const after = deck(slide("one", "<main>changed</main>"), slide("added"));
  assert.deepEqual(changedSlideIds(before, after), ["one", "added", "removed"]);
});
