import assert from "node:assert/strict";
import test from "node:test";

import { assetPathsInHtml, embedAssetReferences, isAssetPath, replaceAssetReferences, rewriteAssetUrls } from "../shared/asset-path.mjs";

test("SVG image asset references are extracted and replaced without touching unrelated hrefs", () => {
  const html = '<main><img src="assets/photo.PNG"><svg><image href="assets/cover.jpeg"><image xlink:href="assets/legacy.JPG" clip-path="url(#clip)"><image href="#symbol"><a href="assets/link.png"></a></svg></main>';
  assert.equal(isAssetPath("assets/photo.PNG"), true);
  assert.deepEqual(assetPathsInHtml(html), ["assets/photo.PNG", "assets/cover.jpeg", "assets/legacy.JPG"]);
  const replaced = replaceAssetReferences(html, (path) => `data:${path}`);
  assert.match(replaced, /src="data:assets\/photo\.PNG"/);
  assert.match(replaced, /href="data:assets\/cover\.jpeg"/);
  assert.match(replaced, /xlink:href="data:assets\/legacy\.JPG"/);
  assert.match(replaced, /clip-path="url\(#clip\)"/);
  assert.match(replaced, /href="#symbol"/);
  assert.match(replaced, /<a href="assets\/link\.png"/);
});

test("offline asset embedding fetches each local asset once and replaces all references", async () => {
  const originalFetch = globalThis.fetch;
  const originalFileReader = globalThis.FileReader;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    return { ok: true, blob: async () => ({ type: "image/png" }) };
  };
  globalThis.FileReader = class {
    readAsDataURL(blob) {
      this.result = `data:${blob.type};base64,embedded`;
      queueMicrotask(() => this.onload?.());
    }
  };
  try {
    const fragments = await embedAssetReferences([
      '<main><img src="assets/logo.png"><img src="assets/logo.png"><svg><image href="assets/icon.svg"></svg></main>',
    ], "http://127.0.0.1:4317/api");
    assert.deepEqual(requests, [
      "http://127.0.0.1:4317/api/assets/logo.png",
      "http://127.0.0.1:4317/api/assets/icon.svg",
    ]);
    assert.equal((fragments[0].match(/data:image\/png;base64,embedded/g) ?? []).length, 3);
    assert.doesNotMatch(fragments[0], /assets\/(?:logo|icon)\.(?:png|svg)/);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.FileReader = originalFileReader;
  }
});

/* displayAssetHtml backs the three display-only surfaces — template preview, presenter stage,
   and the new-project template gallery — none of which read their DOM back for saving. */
test("display HTML rewrites relative asset references onto the API origin", () => {
  const html = rewriteAssetUrls('<main><img src="assets/photo.png"><svg><image href="assets/cover.jpeg"><image xlink:href="assets/legacy.PNG"><image href="#symbol"></svg></main>', "http://127.0.0.1:4317/api");
  assert.match(html, /src="http:\/\/127\.0\.0\.1:4317\/api\/assets\/photo\.png"/);
  assert.match(html, /href="http:\/\/127\.0\.0\.1:4317\/api\/assets\/cover\.jpeg"/);
  assert.match(html, /xlink:href="http:\/\/127\.0\.0\.1:4317\/api\/assets\/legacy\.PNG"/);
  assert.match(html, /href="#symbol"/);
});
