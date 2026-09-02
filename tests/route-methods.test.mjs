import assert from "node:assert/strict";
import test from "node:test";

import { routeMethodDecision } from "../server/route-methods.mjs";

test("allows both project collection operations", () => {
  assert.deepEqual(routeMethodDecision("/api/projects", "GET"), { allowed: true, allow: "GET, POST" });
  assert.deepEqual(routeMethodDecision("/api/projects", "POST"), { allowed: true, allow: "GET, POST" });
});

test("rejects unsupported project collection methods with the complete Allow value", () => {
  assert.deepEqual(routeMethodDecision("/api/projects", "PUT"), { allowed: false, allow: "GET, POST" });
});

test("preserves single-method route guards and leaves unknown routes to the 404 handler", () => {
  assert.deepEqual(routeMethodDecision("/api/state", "POST"), { allowed: false, allow: "GET" });
  assert.deepEqual(routeMethodDecision("/api/variations/compare", "GET"), { allowed: true, allow: "GET" });
  assert.deepEqual(routeMethodDecision("/api/variations/compare", "POST"), { allowed: false, allow: "GET" });
  assert.deepEqual(routeMethodDecision("/api/save", "GET"), { allowed: false, allow: "POST" });
  assert.deepEqual(routeMethodDecision("/missing", "POST"), { allowed: true, allow: null });
});

test("exposes draft, milestone, and exploration session actions as POST routes", () => {
  assert.deepEqual(routeMethodDecision("/api/draft", "POST"), { allowed: true, allow: "POST" });
  assert.deepEqual(routeMethodDecision("/api/milestones", "POST"), { allowed: true, allow: "POST" });
  assert.deepEqual(routeMethodDecision("/api/variations", "GET"), { allowed: true, allow: "GET" });
  assert.deepEqual(routeMethodDecision("/api/variations/pause", "POST"), { allowed: true, allow: "POST" });
  assert.deepEqual(routeMethodDecision("/api/variations/import", "POST"), { allowed: true, allow: "POST" });
});
