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

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

/** Fetch every local asset referenced by the supplied fragments and inline it for offline output. */
export async function embedAssetReferences(fragments, baseUrl) {
  const assetPaths = [...new Set(fragments.flatMap((fragment) => assetPathsInHtml(fragment)))];
  const embeddedAssets = new Map(await Promise.all(assetPaths.map(async (path) => {
    const response = await fetch(`${baseUrl}/${path}`);
    if (!response.ok) throw new Error(`Could not include ${path} in the offline export.`);
    return [path, await blobToDataUrl(await response.blob())];
  })));
  return fragments.map((fragment) => replaceAssetReferences(fragment, (path) => embeddedAssets.get(path) ?? path));
}
