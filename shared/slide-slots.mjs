export const titleSlotName = "title";
export const contentSlotName = "content";
export const titleSlotSelector = `[data-weave-slot="${titleSlotName}"]`;
export const contentSlotSelector = `[data-weave-slot="${contentSlotName}"]`;

const namedEntities = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };

const decodeEntities = (value) => value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/gi, (entity, name) => {
  if (name[0] !== "#") return namedEntities[name.toLowerCase()] ?? entity;
  const hex = name[1]?.toLowerCase() === "x";
  const point = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
  try { return Number.isFinite(point) ? String.fromCodePoint(point) : entity; } catch { return entity; }
});

export function titleFromSlideHtml(input) {
  const html = String(input);
  const match = html.match(/<([a-z][\w:-]*)\b(?=[^>]*\bdata-weave-slot\s*=\s*(?:"title"|'title'))[^>]*>([\s\S]*?)<\/\1\s*>/i);
  if (!match) return null;
  return decodeEntities(match[2].replace(/<br\s*\/?\s*>/gi, " ").replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}
