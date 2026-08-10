import assert from "node:assert/strict";
import test from "node:test";

import { normalizePastedText, textExcerptOfNode } from "../app/components/editable-text-utils.ts";

const textNode = (nodeValue) => ({ nodeType: 3, nodeName: "#text", nodeValue, childNodes: [] });
const elementNode = (nodeName, ...childNodes) => ({ nodeType: 1, nodeName, nodeValue: null, childNodes });

test("multiline paste normalizes platform line endings and unsafe invisible bytes", () => {
  assert.equal(normalizePastedText("one\r\ntwo\rthree\u0000\u00a0four", true), "one\ntwo\nthree four");
});

test("single-line paste collapses line breaks and horizontal whitespace", () => {
  assert.equal(normalizePastedText(" one\r\n  two\tthree ", false), " one two three ");
});

test("text excerpts preserve br boundaries as normalized whitespace", () => {
  const heading = elementNode("H1", textNode("Stories come alive"), elementNode("BR"), textNode("the moment…"));
  assert.equal(textExcerptOfNode(heading), "Stories come alive the moment…");
});

test("text excerpts collect nested text and bound the normalized result", () => {
  const paragraph = elementNode("P", textNode("  One  "), elementNode("STRONG", textNode("two")), textNode(" three  "));
  assert.equal(textExcerptOfNode(paragraph, 12), "One two thr…");
});
