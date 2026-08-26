import assert from "node:assert/strict";
import test from "node:test";

import {
  advancedControlKeys,
  allControlKeys,
  applyBlockPosition,
  applySize,
  applyUtilityClass,
  auditTailwindSlideHtml,
  buildTailwindSlideCss,
  containerControlKeys,
  defaultSlideClasses,
  readBlockPosition,
  readSize,
  readUtilityClass,
  ratioOptions,
  slideControlGroups,
  textControlKeys,
} from "../shared/tailwind-slide.mjs";

const classesOf = (value) => value.split(" ").filter(Boolean);

test("the browser reset precedes utilities and root leading stays unitless", () => {
  const css = buildTailwindSlideCss();
  const base = ".weave-slide :where(h1, h2, h3, p, ul, ol) { margin: 0; font-size: inherit; font-weight: inherit; }";
  assert.ok(css.indexOf(base) > 0);
  assert.ok(css.indexOf(base) < css.indexOf(".weave-slide.text-xs,"), "the zero-specificity base layer must precede every utility");
  assert.doesNotMatch(css, /\.weave-slide\.,/, "Inherit must not emit an empty utility selector");
  assert.equal(base.includes("padding"), false, "list indentation keeps the browser default padding");
  const defaults = classesOf(defaultSlideClasses);
  assert.ok(defaults.includes("text-lg"));
  assert.ok(defaults.includes("leading-normal"));
  assert.equal(defaults.includes("w-full"), false);
  assert.equal(defaults.includes("h-full"), false);
  assert.ok(css.indexOf(".weave-slide.text-lg,") < css.indexOf(".weave-slide.leading-normal,"), "unitless leading must override text-lg's fixed line-height");
});

test("inheritable controls clear and read back without an empty class token", () => {
  for (const key of ["fontSize", "fontWeight", "lineHeight", "textAlign", "color", "listMarker"]) {
    const [inherit, explicit] = slideControlGroups[key].options;
    assert.deepEqual({ label: inherit.label, className: inherit.className }, { label: "Inherit", className: "" });
    const cleared = applyUtilityClass(["paragraph", explicit.className, "gap-4"], key, "");
    assert.equal(cleared.includes(""), false);
    assert.equal(readUtilityClass(cleared, key), "");
    assert.equal(readUtilityClass(applyUtilityClass(cleared, key, explicit.className), key), explicit.className);
  }
});

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

test("a cap decides the intent, however hard the box was told to grow", () => {
  // self-stretch and flex-1 both stop at the measure, so Fixed is what these actually render as.
  assert.equal(readSize(classesOf("self-stretch max-w-3xl"), "column"), "fixed");
  assert.equal(readSize(classesOf("flex-1 max-w-3xl"), "row"), "fixed");
  assert.equal(readSize(classesOf("w-full max-w-3xl"), "row"), "fixed");
  // max-w-none and max-w-full name a limit without imposing one, so they leave Fill alone.
  assert.equal(readSize(classesOf("flex-1 max-w-full"), "row"), "fill");
  assert.equal(readSize(classesOf("self-stretch max-w-none"), "column"), "fill");
});

test("setting an intent makes it stick — every intent survives being read back", () => {
  const starting = ["gap-4", "max-w-3xl gap-4", "flex-1 gap-4", "self-stretch max-w-2xl", "self-center max-w-sm"];
  for (const direction of ["row", "column"]) {
    for (const intent of ["fill", "hug", "fixed"]) {
      for (const start of starting) {
        const written = applySize(classesOf(start), intent, direction);
        assert.equal(readSize(written, direction), intent, `${intent} in a ${direction} from "${start}" → ${written.join(" ")}`);
      }
    }
  }
});

test("Ratio is a Row-only sizing intent and preserves its selected fraction", () => {
  for (const option of ratioOptions) {
    const written = applySize(["max-w-3xl", option.value], "ratio", "row");
    assert.equal(readSize(written, "row"), "ratio");
    assert.ok(written.includes(option.value));
    assert.equal(written.includes("max-w-3xl"), false);
  }
  assert.equal(applySize([], "ratio", "row").includes("basis-1/2"), true);
  assert.equal(applySize([], "ratio", "column").includes("basis-1/2"), false);
});

test("Fixed brings a measure with it; Fill and Hug drop the one they find", () => {
  assert.equal(applySize(classesOf("heading text-6xl"), "fixed", "column").join(" "), "heading text-6xl max-w-3xl self-start", "Fixed without a cap would be indistinguishable from Hug");
  assert.equal(applySize(classesOf("paragraph max-w-sm"), "fixed", "column").join(" "), "paragraph max-w-sm self-start", "a measure already chosen is left alone");
  assert.equal(applySize(classesOf("paragraph max-w-3xl"), "fill", "column").join(" "), "paragraph self-stretch");
  assert.equal(applySize(classesOf("paragraph max-w-3xl"), "hug", "row").join(" "), "paragraph flex-none");
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
  const emitted = ["row", "column"].flatMap((direction) => ["fill", "hug", "fixed", "ratio"].map((intent) => applySize([], intent, direction).join(" ")));
  const markup = `<main class="weave-slide">${emitted.map((className) => `<div class="${className}"></div>`).join("")}</main>`;
  assert.deepEqual(auditTailwindSlideHtml(markup), [], "unregistered classes would be rejected at save time");
  const css = buildTailwindSlideCss();
  for (const className of ["flex-1", "flex-none", "self-stretch", "self-start", "self-center", "self-end"]) {
    assert.match(css, new RegExp(`\\.${className}[ ,]`), `${className} must reach the precompiled stylesheet`);
  }
});

test("controls are filed by how widely they apply, and each tier is disjoint", () => {
  // Kind-specific basics: nothing here belongs to every block, or nothing would set it apart.
  assert.deepEqual(containerControlKeys, ["gap", "padding", "justifyContent", "alignItems"]);
  assert.equal(textControlKeys.includes("textAlign"), true, "textAlign moves the text, not the box");
  // A detail belongs to exactly one tier: the advanced one, or it would show unconditionally.
  assert.deepEqual(advancedControlKeys, ["maxWidth"]);
  for (const key of advancedControlKeys) {
    assert.equal(textControlKeys.includes(key), false, `${key} is advanced and cannot also be a basic`);
    assert.equal(containerControlKeys.includes(key), false, `${key} is advanced and cannot also be a basic`);
  }
  const tiers = [textControlKeys, containerControlKeys, advancedControlKeys];
  for (const keys of tiers) for (const key of keys) assert.ok(slideControlGroups[key], `${key} must name a real control group`);
  // The inspector reads state for every key it can render, whichever tier renders it.
  for (const key of tiers.flat()) assert.ok(allControlKeys.includes(key), `${key} is rendered but never read back`);
});

test("a grid cell is sized by its parent's template, not by a class of its own", () => {
  assert.equal(applySize(classesOf("weave-container column flex flex-col flex-1 gap-4"), "fill", "grid").join(" "), "weave-container column flex flex-col gap-4");
  assert.equal(applySize(classesOf("weave-container w-full gap-4"), "hug", "grid").join(" "), "weave-container gap-4");
});
