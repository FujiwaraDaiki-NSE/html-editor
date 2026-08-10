import { annotationEnvelope } from "./annotation.mjs";
import { designHeight, designWidth } from "./slide-design.mjs";

const excerpt = (value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
/* One design pixel: getBoundingClientRect is fractional and scroll metrics are integers, so anything
   smaller is measurement noise rather than a broken layout. */
const overflowThreshold = 1;
const maxOverflowingIds = 20;

export function overflowingIds(measurements, frame = { width: designWidth, height: designHeight }) {
  if (!Array.isArray(measurements)) return [];
  const width = typeof frame?.width === "number" && Number.isFinite(frame.width) ? frame.width : designWidth;
  const height = typeof frame?.height === "number" && Number.isFinite(frame.height) ? frame.height : designHeight;
  const ids = new Set();
  const overflowing = [];
  for (const measurement of measurements) {
    if (!measurement || typeof measurement !== "object" || ids.size >= maxOverflowingIds) continue;
    const id = typeof measurement.id === "string" ? measurement.id : String(measurement.id ?? "");
    if (!id || ids.has(id)) continue;
    const box = measurement.box;
    const boxValues = [box?.left, box?.top, box?.right, box?.bottom];
    const outside = boxValues.every((value) => typeof value === "number" && Number.isFinite(value)) && (
      box.left < -overflowThreshold || box.top < -overflowThreshold ||
      box.right > width + overflowThreshold || box.bottom > height + overflowThreshold
    );
    const contentOverflow = typeof measurement.scrollHeight === "number" && Number.isFinite(measurement.scrollHeight) &&
      typeof measurement.clientHeight === "number" && Number.isFinite(measurement.clientHeight) &&
      measurement.scrollHeight - measurement.clientHeight > overflowThreshold;
    if (outside || contentOverflow) {
      ids.add(id);
      overflowing.push(id);
    }
  }
  return overflowing;
}

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
  if (Array.isArray(input.overflowing)) {
    const overflowing = [...new Set(input.overflowing
      .map((id) => String(id ?? ""))
      .filter(Boolean))].slice(0, maxOverflowingIds);
    if (overflowing.length > 0) envelope.overflowing = overflowing;
  }
  return envelope;
}

export const contextPromptRules = `The envelope carries only what the agent cannot observe; read slide HTML, CSS, templates, and history from project files.
slide is the slide id, whose content is in slides/<slide>.html.
Those files hold the editor canvas as of the start of this turn, so read them rather than asking for the markup.
selected.id and annotation weaveId are values of data-weave-id attributes.
If a snapshot and an id disagree, prefer the id.
overflowing lists data-weave-ids whose rendered box leaves the slide frame or exceeds its own content box; it is a rendering result the agent cannot measure on its own.`;
