import assert from "node:assert/strict";
import test from "node:test";

import {
  auditContentPolicy,
  auditCssSafety,
  auditHtmlSafety,
} from "../shared/content-policy.mjs";
import { migrateSlideHtmlToTailwind } from "../shared/tailwind-slide.mjs";

test("self-contained declarative CSS and HTML pass", () => {
  const result = auditContentPolicy({
    css: '.weave-slide { background-image: url("data:image/svg+xml;base64,AAAA"); }',
    html: '<main class="weave-slide"><a href="#details">Details</a></main>',
  });
  assert.deepEqual(result, {
    ok: true,
    diagnostics: [],
    summary: { errors: 0, warnings: 0 },
  });
});

test("CSS imports, external assets, and javascript URLs are rejected", () => {
  const result = auditCssSafety(`
    @import "theme.css";
    .one { background: url(https://cdn.example/image.png) }
    .two { background: url('javascript:alert(1)') }
  `);
  assert.equal(result.ok, false);
  assert.deepEqual(new Set(result.diagnostics.map((item) => item.code)), new Set([
    "css.import",
    "css.external-url",
    "css.javascript-url",
  ]));
  assert.ok(result.diagnostics.every((item) => item.source === "css" && item.index >= 0));
});

test("HTML scripts, event handlers, external URLs, and encoded javascript are rejected", () => {
  const result = auditHtmlSafety(`
    <script>alert(1)</script>
    <img src="//cdn.example/image.png" onerror="alert(1)">
    <a href="java&#115;cript:alert(1)">open</a>
  `);
  assert.equal(result.ok, false);
  const codes = result.diagnostics.map((item) => item.code);
  assert.ok(codes.includes("html.script"));
  assert.ok(codes.includes("html.event-handler"));
  assert.ok(codes.includes("html.external-url"));
  assert.ok(codes.includes("html.javascript-url"));
  assert.ok(result.diagnostics.every((item) => item.source === "html" && item.length > 0));
});

test("relative and embedded resources do not count as external URLs", () => {
  const result = auditHtmlSafety(`
    <img src="./images/chart.png">
    <a href="/appendix">Appendix</a>
    <img src="data:image/png;base64,AAAA">
    <p>Document onload= complete</p>
  `);
  assert.equal(result.ok, true);
});

test("Tailwind slide utilities pass while inline, arbitrary, and unknown styles fail", () => {
  const valid = auditContentPolicy({ html: '<main class="weave-slide flex flex-col gap-6"><h1 class="heading text-6xl font-semibold">Title</h1></main>' });
  assert.equal(valid.ok, true);

  const invalid = auditContentPolicy({ html: '<main class="weave-slide mystery" style="padding: 19px"><h1 class="text-[61px]">Title</h1></main>' });
  assert.deepEqual(new Set(invalid.diagnostics.map((item) => item.code)), new Set([
    "design.inline-style",
    "design.unknown-class",
    "design.arbitrary-class",
  ]));
});

test("legacy slide styling migrates to Tailwind classes idempotently", () => {
  const legacy = '<main class="weave-slide plain" style="--accent: #f6b84b"><section class="hero"><h1 class="heading" data-weave-id="h">Title</h1></section></main>';
  const migrated = migrateSlideHtmlToTailwind(legacy);
  assert.match(migrated, /theme-plain/);
  assert.match(migrated, /bg-white/);
  assert.match(migrated, /heading [^"]*text-6xl/);
  assert.equal(migrated.includes("style="), false);
  assert.equal(migrateSlideHtmlToTailwind(migrated), migrated);
});
