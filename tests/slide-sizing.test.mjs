import assert from "node:assert/strict";
import test from "node:test";

import {
  allControlKeys,
  applyBlockPosition,
  applySize,
  auditTailwindSlideHtml,
  blockControlKeys,
  buildTailwindSlideCss,
  containerBlockKeys,
  containerChildKeys,
  contentControlKeys,
  readBlockPosition,
  readSize,
  slideControlGroups,
} from "../shared/tailwind-slide.mjs";

const classesOf = (value) => value.split(" ").filter(Boolean);

test("width is the main axis in a Row, so intents map to flex utilities", () => {
  assert.equal(applySize(classesOf("weave-container column flex flex-col gap-4"), "fill", "row").join(" "), "weave-container column flex flex-col gap-4 flex-1");
  assert.equal(applySize(classesOf("weave-container column flex flex-col gap-4"), "hug", "row").join(" "), "weave-container column flex flex-col gap-4 flex-none");
  assert.equal(readSize(classesOf("flex-1 gap-4"), "row"), "fill");
  assert.equal(readSize(classesOf("flex-none gap-4"), "row"), "hug");
  assert.equal(readSize(classesOf("flex-none max-w-3xl"), "row"), "fixed", "a real measure is what separates Fixed from Hug");
  assert.equal(readSize(classesOf("gap-4"), "row"), "hug", "content-sized is the CSS default inside a Row");
});

test("width is the cross axis in a Column, so the same intents map to align-self", () => {
  assert.equal(applySize(classesOf("weave-container row flex flex-row gap-4"), "fill", "column").join(" "), "weave-container row flex flex-row gap-4 self-stretch");
  assert.equal(applySize(classesOf("weave-container row flex flex-row gap-4"), "hug", "column").join(" "), "weave-container row flex flex-row gap-4 self-start");
  assert.equal(readSize(classesOf("self-stretch"), "column"), "fill");
  assert.equal(readSize(classesOf("gap-4"), "column"), "fill", "align-items: stretch already fills the width");
  // .hero carries items-start, so an unaligned block there hugs its content rather than filling.
  assert.equal(readSize(classesOf("gap-4"), "column", classesOf("hero flex flex-1 flex-col items-start justify-center gap-6")), "hug");
  assert.equal(readSize(classesOf("self-stretch"), "column", classesOf("hero flex flex-col items-start")), "fill", "the block's own align-self overrides the parent");
  assert.equal(readSize(classesOf("self-center"), "column"), "hug");
  assert.equal(readSize(classesOf("self-center max-w-3xl"), "column"), "fixed");
});

test("a text block sizes the same way a container does", () => {
  const hero = classesOf("hero flex flex-1 flex-col items-start justify-center gap-6");
  const paragraph = classesOf("paragraph max-w-3xl text-lg leading-normal text-slate-300");
  assert.equal(readSize(paragraph, "column", hero), "fixed", "the seeded measure already makes it Fixed");
  assert.equal(readSize(classesOf("heading text-6xl font-semibold"), "column", hero), "hug");
  // Centring the paragraph is the case text-align could never reach: the box itself moves.
  const centred = applyBlockPosition(paragraph, "self-center");
  assert.equal(centred.join(" "), "paragraph max-w-3xl text-lg leading-normal text-slate-300 self-center");
  assert.equal(readSize(centred, "column", hero), "fixed");
  assert.deepEqual(auditTailwindSlideHtml(`<main class="weave-slide"><p class="${centred.join(" ")}"></p></main>`), []);
});

test("sizing a centred block keeps it centred", () => {
  const centred = classesOf("weave-container column flex flex-col self-center max-w-3xl gap-4");
  assert.equal(readSize(centred, "column"), "fixed");
  assert.equal(applySize(centred, "hug", "column").includes("self-center"), true, "changing the intent must not silently re-align the block");
  assert.equal(applySize(centred, "fill", "column").includes("self-center"), false, "filling the width leaves nothing to align");
});

test("legacy w-full reads as Fill and is dropped the moment sizing is set", () => {
  assert.equal(readSize(classesOf("weave-container row flex flex-row w-full gap-4"), "row"), "fill");
  assert.equal(readSize(classesOf("weave-container row flex flex-row w-full gap-4"), "column"), "fill");
  assert.equal(applySize(classesOf("weave-container flex w-full gap-4"), "hug", "row").join(" "), "weave-container flex gap-4 flex-none");
});

test("alignment replaces whichever align-self is already there", () => {
  assert.equal(applyBlockPosition(classesOf("weave-container self-stretch gap-4"), "self-center").join(" "), "weave-container gap-4 self-center");
  assert.equal(applyBlockPosition(classesOf("weave-container self-start gap-4"), "self-end").join(" "), "weave-container gap-4 self-end");
  assert.equal(readBlockPosition(classesOf("weave-container self-center")), "self-center");
  assert.equal(readBlockPosition(classesOf("weave-container self-stretch")), "", "stretching is not a horizontal placement");
  assert.equal(readBlockPosition(classesOf("weave-container gap-4")), "");
});

test("every class the sizing model emits is a registered utility", () => {
  const emitted = ["row", "column"].flatMap((direction) => ["fill", "hug", "fixed"].map((intent) => applySize([], intent, direction).join(" ")));
  const markup = `<main class="weave-slide">${emitted.map((className) => `<div class="${className}"></div>`).join("")}</main>`;
  assert.deepEqual(auditTailwindSlideHtml(markup), [], "unregistered classes would be rejected at save time");
  const css = buildTailwindSlideCss();
  for (const className of ["flex-1", "flex-none", "self-stretch", "self-start", "self-center", "self-end"]) {
    assert.match(css, new RegExp(`\\.${className}[ ,]`), `${className} must reach the precompiled stylesheet`);
  }
});

test("every control is filed under the thing it actually moves", () => {
  // Fixed is only reachable if a block can set its own measure, container or not.
  assert.equal(blockControlKeys.includes("maxWidth"), true);
  assert.equal(containerBlockKeys.includes("maxWidth"), true);
  // Padding sizes the block's own box; gap and the alignments arrange what sits inside it.
  assert.equal(containerBlockKeys.includes("padding"), true);
  assert.deepEqual(containerChildKeys, ["gap", "justifyContent", "alignItems"]);
  assert.equal(contentControlKeys.includes("textAlign"), true, "textAlign moves the text, not the box");
  for (const keys of [blockControlKeys, contentControlKeys, containerBlockKeys, containerChildKeys]) {
    for (const key of keys) assert.ok(slideControlGroups[key], `${key} must name a real control group`);
  }
  // The inspector reads state for every key it can render, whichever section renders it.
  for (const key of [...blockControlKeys, ...contentControlKeys, ...containerBlockKeys, ...containerChildKeys]) {
    assert.ok(allControlKeys.includes(key), `${key} is rendered but never read back`);
  }
});

test("a grid cell is sized by its parent's template, not by a class of its own", () => {
  assert.equal(applySize(classesOf("weave-container column flex flex-col flex-1 gap-4"), "fill", "grid").join(" "), "weave-container column flex flex-col gap-4");
  assert.equal(applySize(classesOf("weave-container w-full gap-4"), "hug", "grid").join(" "), "weave-container gap-4");
});
