/** Persist direct sizing using the same finite Tailwind utility vocabulary as slide HTML. */
export function blockDimensionClasses(classes, width, height, changeWidth, changeHeight) {
  if (!Array.isArray(classes) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || typeof changeWidth !== 'boolean' || typeof changeHeight !== 'boolean') throw new TypeError('Explicit valid dimensions and axes are required');
  const widthStep = Math.min(320, Math.max(1, Math.round(width / 4)));
  const heightStep = Math.min(320, Math.max(1, Math.round(height / 4)));
  const kept = classes.filter((name) => !(changeWidth && (/^(w-|max-w-|min-w-|basis-|flex-1$|flex-auto$|self-stretch$)/.test(name))) && !(changeHeight && /^(h-|min-h-|max-h-|aspect-)/.test(name)));
  if (changeWidth) kept.push(`w-${widthStep}`, 'max-w-full', 'flex-none');
  if (changeHeight) kept.push(`h-${heightStep}`);
  return [...new Set(kept)];
}
