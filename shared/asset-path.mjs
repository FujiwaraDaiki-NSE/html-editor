const assetExtensions = ["png", "jpg", "jpeg", "webp", "svg", "gif"];
const assetExtensionsPattern = assetExtensions.map((extension) => [...extension].map((character) => `[${character.toLowerCase()}${character.toUpperCase()}]`).join("")).join("|");

export const assetFilenameSource = `^[A-Za-z0-9][A-Za-z0-9._-]*\\.(?:${assetExtensionsPattern})$`;
export const assetFilenamePattern = new RegExp(assetFilenameSource);

export function isAssetPath(value) {
  return typeof value === "string" && value.startsWith("assets/") && assetFilenamePattern.test(value.slice("assets/".length));
}

const assetReferencePattern = /(<(?:img\b[^>]*?\bsrc|image\b[^>]*?\b(?:href|xlink:href))=)(['"])(assets\/[^'"]+)\2/g;

export function assetPathsInHtml(html) {
  return [...html.matchAll(assetReferencePattern)].map((match) => match[3]).filter(isAssetPath);
}

export function replaceAssetReferences(html, replace) {
  return html.replace(assetReferencePattern, (match, prefix, quote, path) => isAssetPath(path) ? `${prefix}${quote}${replace(path)}${quote}` : match);
}

export function rewriteAssetUrls(html, baseUrl) {
  return replaceAssetReferences(html, (path) => `${baseUrl}/${path}`);
}
