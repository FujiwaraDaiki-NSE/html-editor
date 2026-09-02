import { annotationEnvelope } from "./annotation.mjs";
import { designHeight, designWidth } from "./slide-design.mjs";

const excerpt = (value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
/* One design pixel: getBoundingClientRect is fractional and scroll metrics are integers, so anything
   smaller is measurement noise rather than a broken layout. */
const overflowThreshold = 1;
const maxOverflowingIds = 20;

export function isReferencePath(value) {
  if (typeof value !== "string" || !value.startsWith("references/")) return false;
  const segments = value.slice("references/".length).split("/");
  return segments.length > 0 && segments.every((segment) => segment && segment !== "." && segment !== ".." && !segment.includes("\\"));
}

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
  if (input.modificationScope && typeof input.modificationScope === "object" && !Array.isArray(input.modificationScope)) {
    const kind = String(input.modificationScope.kind ?? "");
    if (["element", "current-slide", "selected-slides", "deck"].includes(kind)) {
      const slideIds = Array.isArray(input.modificationScope.slideIds)
        ? [...new Set(input.modificationScope.slideIds.map((id) => String(id)).filter(Boolean))].slice(0, 100)
        : [];
      const elementId = input.modificationScope.elementId === null ? null : String(input.modificationScope.elementId ?? "");
      if (kind === "element" && !elementId) throw new Error("Element scope requires an elementId.");
      if (["element", "current-slide", "selected-slides"].includes(kind) && slideIds.length === 0) throw new Error(`${kind} scope requires slideIds.`);
      envelope.modificationScope = { kind, slideIds, elementId };
    }
  }
  const executionMode = String(input.executionMode ?? "");
  if (["apply", "propose", "plan"].includes(executionMode)) envelope.executionMode = executionMode;
  if (input.allowSkillChanges === true) envelope.allowSkillChanges = true;
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
  if (Array.isArray(input.attachments)) {
    const attachments = input.attachments.map((attachment) => {
      if (!attachment || typeof attachment !== "object") return null;
      if (!isReferencePath(attachment.path) || typeof attachment.name !== "string" || !attachment.name.trim()) return null;
      if (typeof attachment.bytes !== "number" || !Number.isFinite(attachment.bytes) || attachment.bytes < 0) return null;
      const kind = attachment.kind === "folder" ? "folder" : attachment.kind === "file" || attachment.kind == null ? "file" : null;
      if (!kind || (kind === "folder" && (!Number.isInteger(attachment.files) || attachment.files < 0))) return null;
      const result = { path: attachment.path, name: attachment.name, bytes: attachment.bytes, kind };
      if (kind === "folder") result.files = attachment.files;
      return result;
    }).filter(Boolean).slice(0, 20);
    if (attachments.length > 0) envelope.attachments = attachments;
  }
  return envelope;
}

export const contextPromptRules = `The envelope carries only what the agent cannot observe; read slide HTML, CSS, templates, and history from project files.
slide is the slide id, whose content is in slides/<slide>.html.
modificationScope is a hard write boundary, separate from reference context. element permits only elementId on the listed slide; current-slide and selected-slides permit only the listed slideIds; deck permits the complete deck.
executionMode controls delivery: apply edits files, propose returns a change proposal without editing, and plan returns a plan before any edit.
allowSkillChanges is an explicit permission. Project skills must remain unchanged unless it is true and executionMode is apply.
Never widen modificationScope because annotations, attachments, or other references are present. If the request requires a wider scope, stop and ask for explicit permission.
Those files hold the editor canvas as of the start of this turn, so read them rather than asking for the markup.
selected.id and annotation weaveId are values of data-weave-id attributes.
If a snapshot and an id disagree, prefer the id.
overflowing lists data-weave-ids whose rendered box leaves the slide frame or exceeds its own content box; it is a rendering result the agent cannot measure on its own.
attachments are files the human brought in for this turn, addressed by paths relative to the project root.
Folder attachments are project-relative directories; their contents are not enumerated in the envelope.
Their contents are not included; open the files yourself when needed, and use available tools to convert formats you cannot read directly.`;
