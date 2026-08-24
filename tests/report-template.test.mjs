import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = resolve(root, 'examples/digital-year-end-report-template.html');

test('年度末報告テンプレートは自己完結した4:3 HTMLである', async () => {
  const html = await readFile(templatePath, 'utf8');

  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="ja">/);
  assert.match(html, /--slide-width:\s*960px/);
  assert.match(html, /--slide-height:\s*720px/);
  assert.match(html, /--red:\s*#e00000/);
  assert.match(html, /--blue:\s*#004dff/);
  assert.match(html, /aspect-ratio:\s*4\s*\/\s*3/);
  assert.match(html, /width:\s*var\(--slide-width\)/);
  assert.match(html, /height:\s*var\(--slide-height\)/);
  assert.match(html, /flex-shrink:\s*0/);
  assert.match(html, /\.deck\s*\{[\s\S]*?min-width:\s*var\(--slide-width\)/);
  assert.match(html, /\.slide\s*\{[\s\S]*?width:\s*var\(--slide-width\);[\s\S]*?height:\s*var\(--slide-height\);[\s\S]*?aspect-ratio:\s*4\s*\/\s*3;[\s\S]*?flex-shrink:\s*0/);
  assert.doesNotMatch(html, /@media\s*\(max-width:\s*720px\)/);
  assert.equal((html.match(/viewBox="0 0 960 720"/g) ?? []).length, 9);
  assert.equal((html.match(/preserveAspectRatio="none"/g) ?? []).length, 9);
  assert.equal((html.match(/M0 396 C174 150 568 22 960 0 L960 720 L0 720 Z/g) ?? []).length, 1);
  assert.equal((html.match(/M0 0 L960 0 C598 24 302 118 124 285 C57 348 18 392 0 416 Z/g) ?? []).length, 8);
  assert.equal((html.match(/x1="210" y1="69" x2="960" y2="69" stroke="#e00000" stroke-width="2"/g) ?? []).length, 1);
  assert.equal((html.match(/x1="210" y1="662" x2="960" y2="662" stroke="#004dff" stroke-width="2"/g) ?? []).length, 1);
  assert.equal((html.match(/x1="140" y1="69" x2="960" y2="69" stroke="#e00000" stroke-width="2"/g) ?? []).length, 2);
  assert.equal((html.match(/x1="140" y1="662" x2="960" y2="662" stroke="#004dff" stroke-width="2"/g) ?? []).length, 2);
  assert.equal((html.match(/x1="98" y1="69" x2="960" y2="69" stroke="#e00000" stroke-width="2"/g) ?? []).length, 6);
  assert.equal((html.match(/x1="98" y1="662" x2="960" y2="662" stroke="#004dff" stroke-width="2"/g) ?? []).length, 6);
  const gradientIds = [...html.matchAll(/<linearGradient id="([^"]+)"/g)].map(([, id]) => id);
  assert.equal(gradientIds.length, 9);
  assert.equal(new Set(gradientIds).size, 9);
  for (const id of gradientIds) assert.match(html, new RegExp(`fill="url\\(#${id}\\)"`));
  assert.match(html, /linearGradient id="frame-gradient-cover" x1="0%" x2="100%" y1="0%" y2="0%"/);
  assert.match(html, /stop offset="0%" stop-color="#c2c2c2"/);
  assert.match(html, /stop offset="55%" stop-color="#dcdcdc"/);
  assert.match(html, /stop offset="100%" stop-color="#f3f3f3"/);
  assert.doesNotMatch(html, /slide__rule|radial-gradient/);
  assert.match(html, /\.cover h1 \.placeholder\s*\{\s*color:\s*var\(--blue\)/);
  assert.match(html, /\.slide__footer\s*\{[\s\S]*?top:\s*662px;[\s\S]*?right:\s*38px;[\s\S]*?bottom:\s*0;[\s\S]*?left:\s*var\(--frame-start\)/);
  assert.match(html, /\.slide__footer > :first-child\s*\{\s*position:\s*absolute;\s*bottom:\s*31px;\s*left:\s*0;/);
  assert.match(html, /\.slide__footer > :last-child\s*\{\s*position:\s*absolute;\s*right:\s*0;\s*bottom:\s*34px/);
  assert.match(html, /\.slide__page\s*\{\s*position:\s*absolute;\s*right:\s*0;\s*bottom:\s*12px;/);
  assert.match(html, /\.slide__frame\s*\{[\s\S]*?z-index:\s*-1/);
  assert.match(html, /\.slide__footer\s*\{[\s\S]*?position:\s*absolute/);
  assert.doesNotMatch(html, /\.slide\s*>\s*:not\(\.slide__frame\)\s*\{[\s\S]*?position:\s*relative/);
  assert.doesNotMatch(html, /\bvw\b/);
  assert.match(html, /@page\s*\{\s*size:\s*10in 7\.5in/);
  assert.match(html, /-webkit-print-color-adjust:\s*exact/);
  assert.match(html, /print-color-adjust:\s*exact/);
  assert.match(html, /\.slide\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(html, /@media print[\s\S]*?\.slide\[hidden\]\s*\{\s*display:\s*block\s*!important/);
  assert.doesNotMatch(html, /<script\s+[^>]*src=/i);
  assert.doesNotMatch(html, /<link\s+[^>]*href=/i);
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(html, /<img\b/i);
});

test('代表レイアウトと差し替えプレースホルダーを含む', async () => {
  const html = await readFile(templatePath, 'utf8');
  const requiredSlides = ['cover', 'agenda', 'chapter', 'body', 'cards', 'comparison', 'media', 'summary'];

  for (const slide of requiredSlides) {
    assert.match(html, new RegExp(`data-slide="${slide}"`));
  }
  assert.ok((html.match(/class="slide(?:\s|\")/g) ?? []).length >= 8);
  assert.ok((html.match(/\[.*?を入力\]/g) ?? []).length >= 20);
  assert.match(html, /class="controls"/);
  assert.match(html, /\.controls\s*\{[\s\S]*?position:\s*relative;[\s\S]*?margin:\s*-64px auto 20px/);
  assert.doesNotMatch(html, /\.controls\s*\{[^}]*position:\s*fixed/);
  assert.match(html, /data-action="previous"/);
  assert.match(html, /data-action="next"/);
  assert.match(html, /slide\.querySelector\('\.slide__page'\)/);
  assert.equal((html.match(/class="slide__footer"/g) ?? []).length, 9);
  assert.match(html, /01 \/ 09/);
  assert.match(html, /09 \/ 09/);
  assert.match(html, /\[copyright表記を入力\]/);
  assert.doesNotMatch(html, /<div class="callout"><span>/);
  assert.match(html, /\.callout::before/);
  assert.match(html, /ArrowLeft/);
  assert.match(html, /ArrowRight/);
  assert.match(html, /event\.preventDefault\(\)/);
  assert.match(html, /scrollIntoView\(\{ block: 'center' \}\)/);
  assert.match(html, /event\.altKey \|\| event\.ctrlKey \|\| event\.metaKey \|\| event\.shiftKey/);
  assert.match(html, /target\.isContentEditable/);
  assert.match(html, /\['INPUT', 'TEXTAREA', 'SELECT'\]/);
});
