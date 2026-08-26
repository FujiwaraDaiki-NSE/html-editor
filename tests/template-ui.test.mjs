import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

test("the editor renders and persists the template/layout hierarchy", () => {
  assert.match(page, /composeSlideHtml/);
  assert.match(page, /extractSlideSourceHtml/);
  assert.match(page, /templateId: string; layoutId: string; accent: string/);
  assert.match(page, /defaultLayoutId: string; masterHtml: string; layouts: TemplateLayout\[\]/);
  assert.match(page, /composeSlideHtml\(\{[\s\S]*masterHtml: template\.masterHtml[\s\S]*layoutHtml: layout\.html/);
  assert.match(page, /extractSlideSourceHtml\(html, \{ templateId: current\.templateId, layoutId: current\.layoutId, accent: current\.accent \}\)/);
  assert.match(page, /defaultTemplateId, slides: captureActive\(\)/);
  assert.doesNotMatch(page, /applyTemplateToSlideHtml/);
  assert.doesNotMatch(page, /updateSlidePageNumber\(/);
});

test("new project and slide pickers expose one template with nested layouts", () => {
  assert.match(page, /templates\.map\(\(template\) => \(\s*<div className="template-group"/);
  assert.match(page, /template\.layouts\.map\(\(layout\)/);
  assert.match(page, /body: JSON\.stringify\(\{ title, templateId: newProjectTemplate \}\)/);
  assert.match(page, /const currentTemplate = templates\.find\(\(template\) => template\.id === \(currentSlide\?\.templateId/);
  assert.match(page, /setDefaultTemplateId\(bundle\.deck\.defaultTemplateId\)/);
  assert.match(page, /templates, css: deckCss/);
  assert.match(page, /setImportedTemplates\(bundle\.templates\)/);
  assert.match(page, /type Snapshot = \{ title: string; defaultTemplateId: string; templates: TemplateDoc\[\]/);
});

test("ordinary canvas interactions ignore inherited furniture outside content", () => {
  assert.match(page, /const isEditableSlideNode = \(node: Element \| null\)/);
  assert.match(page, /!isEditableSlideNode\(target\)/);
  assert.match(page, /!isEditableSlideNode\(node\)/);
  assert.match(page, /filter\(isEditableSlideNode\)/);
  assert.match(page, /!isEditableSlideNode\(target\).*target === session\.node/);
  assert.match(page, /target && isEditableSlideNode\(target\)/);
});
