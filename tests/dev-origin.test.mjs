import assert from "node:assert/strict";
import test from "node:test";

import { isAllowedWebOrigin } from "../server/dev-origin.mjs";

test("allows requests without an Origin header", () => {
  assert.equal(isAllowedWebOrigin(undefined, 3001), true);
});

test("rejects invalid configured ports when an Origin header is present", () => {
  assert.equal(isAllowedWebOrigin("http://localhost:3001", 0), false);
  assert.equal(isAllowedWebOrigin("http://localhost:3001", 65_536), false);
});

test("allows loopback origins only when the proxy preserves the same host and port", () => {
  assert.equal(isAllowedWebOrigin("http://127.0.0.1:3001", 3001, "127.0.0.1:3001"), true);
  assert.equal(isAllowedWebOrigin("http://localhost:3001", 3001, "localhost:3001"), true);
  assert.equal(isAllowedWebOrigin("http://localhost:3001", 3001, "192.168.1.20:3001"), false);
  assert.equal(isAllowedWebOrigin("http://127.0.0.1:3000", 3001, "127.0.0.1:3000"), false);
});

test("allows a non-loopback web origin only when the proxy preserves the same host", () => {
  assert.equal(isAllowedWebOrigin("http://192.168.1.20:3001", 3001, "192.168.1.20:3001"), true);
  assert.equal(isAllowedWebOrigin("http://editor.local:3001", 3001, "editor.local:3001"), true);
  assert.equal(isAllowedWebOrigin("http://192.168.1.20:3001", 3001, "127.0.0.1:4317"), false);
  assert.equal(isAllowedWebOrigin("http://attacker.example:3001", 3001, "192.168.1.20:3001"), false);
});

test("accepts normalized and explicit HTTP port 80 origins", () => {
  assert.equal(isAllowedWebOrigin("http://127.0.0.1", 80, "127.0.0.1"), true);
  assert.equal(isAllowedWebOrigin("http://127.0.0.1:80", 80, "127.0.0.1:80"), true);
  assert.equal(isAllowedWebOrigin("http://localhost", 80, "localhost"), true);
  assert.equal(isAllowedWebOrigin("http://localhost:80", 80, "localhost:80"), true);
});

test("rejects non-local, HTTPS, credential-bearing, and malformed origins", () => {
  for (const origin of [
    "https://localhost:3001",
    "http://192.168.1.20:3001",
    "http://user:password@localhost:3001",
    "http://localhost:3001/editor",
    "http://localhost:65536",
    "not-an-origin",
  ]) {
    assert.equal(isAllowedWebOrigin(origin, 3001), false, origin);
  }
});
