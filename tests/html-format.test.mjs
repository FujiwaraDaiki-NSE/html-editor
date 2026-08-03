import assert from "node:assert/strict";
import test from "node:test";

import { formatDeckCss, formatSlideHtml } from "../shared/html-format.mjs";

test("normalizes attribute quoting and spacing into one canonical shape", async () => {
  const messy = `<main class='weave-slide orbit'   data-weave-id=x><section class=hero></section></main>`;
  const formatted = await formatSlideHtml(messy);
  assert.match(formatted, /<main class="weave-slide orbit" data-weave-id="x">/);
  assert.ok(formatted.endsWith("\n"));
  assert.ok(!formatted.endsWith("\n\n"));
});

test("is idempotent — formatting formatted output changes nothing", async () => {
  const once = await formatSlideHtml(
    `<main class="weave-slide"><section class="hero"><h1 class="heading" data-weave-id="h">Title</h1><p class="paragraph" data-weave-id="p">A <b>bold</b> run of body text here.</p></section></main>`,
  );
  const twice = await formatSlideHtml(once);
  assert.equal(twice, once);
});

test("preserves <br> line breaks (the canonical break inside slide text)", async () => {
  const formatted = await formatSlideHtml(
    `<h1 class="heading" data-weave-id="h">Make ideas visible,<br>while they move.</h1>`,
  );
  assert.match(formatted, /Make ideas visible,<br \/>\s*while they move\./);
});

test("formats and is idempotent for the project stylesheet", async () => {
  const once = await formatDeckCss(`.weave-slide{color:red;font-size:64px}.weave-slide .hero{gap:18px}`);
  assert.match(once, /\.weave-slide \{/);
  assert.equal(await formatDeckCss(once), once);
});
