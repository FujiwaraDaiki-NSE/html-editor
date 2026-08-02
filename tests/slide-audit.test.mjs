import assert from "node:assert/strict";
import test from "node:test";

import { auditDeckQuality } from "../shared/slide-audit.mjs";

const validDeck = () => ({
  title: "Quality",
  slides: [{
    id: "intro",
    blocks: [
      { id: "heading", kind: "heading", text: "A clear story" },
      { id: "metrics", kind: "metrics", text: "42%|less rework|3.2x|faster" },
    ],
  }],
});
test("a structurally sound deck passes the data quality gate", () => {
  assert.deepEqual(auditDeckQuality(validDeck()), {
    ok: true,
    diagnostics: [],
    summary: { errors: 0, warnings: 0 },
  });
});

test("missing slides and slide content are blocking diagnostics", () => {
  const missingDeck = auditDeckQuality({ slides: [] });
  assert.equal(missingDeck.ok, false);
  assert.deepEqual(missingDeck.diagnostics.map((item) => item.code), ["deck.slides.missing"]);

  const missingBlocks = auditDeckQuality({ slides: [{ id: "empty", blocks: [] }] });
  assert.deepEqual(missingBlocks.diagnostics.map((item) => item.code), ["slide.blocks.missing"]);
});

test("empty headings, duplicate ids, and malformed metrics carry precise locations", () => {
  const deck = validDeck();
  deck.slides[0].blocks = [
    { id: "same", kind: "heading", text: "   " },
    { id: "same", kind: "metrics", text: "42%|growth|orphan" },
  ];
  const result = auditDeckQuality(deck);
  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics.map((item) => item.code), [
    "heading.empty",
    "block.id.duplicate",
    "metrics.invalid",
  ]);
  assert.equal(result.diagnostics[1].path, "slides[0].blocks[1].id");
  assert.equal(result.diagnostics[1].slideId, "intro");
  assert.equal(result.diagnostics[1].blockId, "same");
});

test("overlong text is a configurable warning and does not block save", () => {
  const deck = validDeck();
  deck.slides[0].blocks[0].text = "123456";
  const result = auditDeckQuality(deck, { textLimits: { heading: 5 } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.summary, { errors: 0, warnings: 1 });
  assert.equal(result.diagnostics[0].code, "block.text.too-long");
  assert.equal(result.diagnostics[0].actual, 6);
  assert.equal(result.diagnostics[0].limit, 5);
});

test("duplicate slide ids and a missing heading are reported", () => {
  const deck = validDeck();
  deck.slides.push({
    id: "intro",
    blocks: [{ id: "body", kind: "paragraph", text: "No headline" }],
  });
  const result = auditDeckQuality(deck);
  assert.deepEqual(result.diagnostics.map((item) => item.code), [
    "slide.id.duplicate",
    "heading.missing",
  ]);
});
