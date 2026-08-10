import { annotationEnvelope } from "./annotation.mjs";

const excerpt = (value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 200);

export function editorEnvelope(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const envelope = {};
  const slide = String(input.slide ?? "");
  if (slide) envelope.slide = slide;
  if (input.selected && typeof input.selected === "object" && !Array.isArray(input.selected)) {
    const selected = {
      id: String(input.selected.id ?? ""),
      kind: String(input.selected.kind ?? ""),
      text: excerpt(input.selected.text),
    };
    if (selected.id || selected.kind || selected.text) envelope.selected = selected;
  }
  if (Array.isArray(input.annotations)) {
    let annotations = [];
    try {
      annotations = annotationEnvelope(input.annotations);
    } catch {
      annotations = [];
    }
    if (annotations.length > 0) envelope.annotations = annotations;
  }
  return envelope;
}

export const contextPromptRules = `The envelope carries only what the agent cannot observe; read slide HTML, CSS, templates, and history from project files.
slide is the slide id, whose content is in slides/<slide>.html.
selected.id and annotation weaveId are values of data-weave-id attributes.
If a snapshot and an id disagree, prefer the id.`;
