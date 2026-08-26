import assert from "node:assert/strict";
import test from "node:test";

import {
  auditContentPolicy,
  auditCssSafety,
  auditHtmlSafety,
} from "../shared/content-policy.mjs";
import { slideFragmentFromBlocks } from "../shared/slide-design.mjs";
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

test("embedded documents, document styles, and srcdoc are rejected", () => {
  const result = auditHtmlSafety(`
    <iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>
    <object data="assets/file.svg"></object>
    <embed src="assets/file.svg">
    <style>.editor { display: none }</style>
    <div style="position: fixed">overlay</div>
  `);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.filter((item) => item.code === "html.unsafe-element").length >= 4);
  assert.ok(result.diagnostics.some((item) => item.code === "html.unsafe-attribute"));
});

test("malformed numeric entities are handled without throwing", () => {
  assert.doesNotThrow(() => auditHtmlSafety('<a href="&#99999999;javascript:alert(1)">open</a>'));
});

test("CSS comments cannot split unsafe tokens", () => {
  const result = auditCssSafety(`
    @im/**/port "theme.css";
    .one { background: url(/**/https://cdn.example/image.png) }
  `);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item) => item.code === "css.import"));
  assert.ok(result.diagnostics.some((item) => item.code === "css.external-url"));
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
  const valid = auditContentPolicy({ html: '<main class="weave-slide flex flex-col gap-6"><h1 data-weave-id="title" class="heading text-6xl font-semibold">Title</h1></main>' });
  assert.equal(valid.ok, true);

  const invalid = auditContentPolicy({ html: '<main class="weave-slide mystery" style="padding: 19px"><h1 data-weave-id="title" class="text-[61px]">Title</h1></main>' });
  assert.deepEqual(new Set(invalid.diagnostics.map((item) => item.code)), new Set([
    "html.unsafe-attribute",
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

test("image, list, table, grid span, decoration, and static SVG vocabulary passes", () => {
  const html = `<main class="weave-slide"><img data-weave-id="image" class="image w-full object-cover object-center aspect-4/3 rounded-lg" src="assets/example.png" alt="Example"><ul data-weave-id="list" class="list list-disc pl-6"><li>One</li></ul><table data-weave-id="table" class="table w-full border-collapse"><tbody><tr><td class="p-2 border-b border-slate-700">Cell</td></tr></tbody></table><div class="grid grid-cols-3"><div class="col-span-2 row-span-2 bg-slate-800 border border-slate-300 rounded-xl shadow-lg"></div></div><svg data-weave-id="chart" class="w-full aspect-video text-amber-400"><circle fill="currentColor" /></svg></main>`;
  assert.deepEqual(auditContentPolicy({ html }).diagnostics, []);
});

test("selectable elements without weave ids produce non-blocking warnings", () => {
  const result = auditContentPolicy({ html: '<main class="weave-slide"><h1>Title</h1><p>Body</p><table><tr><td>Cell</td></tr></table></main>' });
  assert.equal(result.ok, true);
  assert.equal(result.summary.errors, 0);
  assert.equal(result.summary.warnings, 3);
  assert.equal(new Set(result.diagnostics.map((item) => item.code)).size, 1);
  assert.ok(result.diagnostics.every((item) => item.severity === "warning" && item.index >= 0 && item.length > 0));
});

test("id-bearing ancestors cover nested selectable elements, while list and table cells are exempt", () => {
  const result = auditContentPolicy({ html: '<main class="weave-slide"><figure data-weave-id="figure"><img src="assets/a.png"></figure><div data-weave-id="copy"><p>Nested</p></div><ul data-weave-id="list"><li>Cell-like</li></ul><table data-weave-id="table"><tr><td>Cell</td><th>Header</th></tr></table></main>' });
  assert.equal(result.summary.warnings, 0);
});

test("seed slide fragments have complete selectable-element coverage", () => {
  const html = slideFragmentFromBlocks({
    background: "orbit",
    total: 1,
    position: 1,
    blocks: [
      { id: "heading", kind: "heading", text: "Title" },
      { id: "paragraph", kind: "paragraph", text: "Body" },
      { id: "metrics", kind: "metrics", text: "24%|growth" },
    ],
  });
  const result = auditContentPolicy({ html });
  assert.equal(result.summary.warnings, 0);
});
