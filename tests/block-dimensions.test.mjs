import test from 'node:test';
import assert from 'node:assert/strict';
import { blockDimensionClasses } from '../shared/block-dimensions.mjs';
import { auditTailwindSlideHtml, buildTailwindSlideCss, readSize, applySize } from '../shared/tailwind-slide.mjs';

test('direct sizes survive content policy and override old layout constraints', () => {
  const classes = blockDimensionClasses(['image', 'w-full', 'max-w-sm', 'basis-1/2', 'flex-1', 'aspect-video', 'h-full'], 402, 202, true, true);
  assert.deepEqual(classes, ['image', 'w-101', 'max-w-full', 'flex-none', 'h-51']);
  assert.deepEqual(auditTailwindSlideHtml(`<img class="${classes.join(' ')}">`), []);
  assert.match(buildTailwindSlideCss(), /\.weave-slide \.w-101 \{ width: 25.25rem;/);
  assert.equal(readSize(classes, 'row', []), 'fixed');
  assert.ok(!applySize(classes, 'fill', 'column').includes('w-101'));
});
test('changing one axis preserves the other axis and decoration', () => {
  assert.deepEqual(blockDimensionClasses(['w-60', 'h-40', 'rounded-lg'], 240, 200, false, true), ['w-60', 'rounded-lg', 'h-50']);
  assert.throws(() => blockDimensionClasses([], NaN, 20, true, true));
});
