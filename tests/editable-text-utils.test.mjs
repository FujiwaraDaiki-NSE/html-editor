import assert from "node:assert/strict";
import test from "node:test";

import { normalizePastedText } from "../app/components/editable-text-utils.ts";

test("multiline paste normalizes platform line endings and unsafe invisible bytes", () => {
  assert.equal(normalizePastedText("one\r\ntwo\rthree\u0000\u00a0four", true), "one\ntwo\nthree four");
});

test("single-line paste collapses line breaks and horizontal whitespace", () => {
  assert.equal(normalizePastedText(" one\r\n  two\tthree ", false), " one two three ");
});
