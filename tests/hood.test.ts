import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BODY, applyPlacement, garmentView, mannequinGeometry, placeGarment } from '../src/core/body';
import { hoodTop } from '../src/core/hood';
import { alphaOf } from '../src/core/orient';
import { makeItem } from './helpers';
import { outlineImage } from './outlines';

const hood = (name: Parameters<typeof outlineImage>[0]) => {
  const img = outlineImage(name);
  return hoodTop(alphaOf(img), img.width, img.height);
};

test('帽子：连帽外套、袖子折起来的连帽卫衣量出帽子的高度', () => {
  // 帽子从 4 到 80～96（共 300），减去保留的一小截领口
  const parka = hood('parka');
  assert.ok(parka > 0.18 && parka < 0.3, `连帽外套的帽子占 ${parka.toFixed(3)}`);
  const folded = hood('foldedHood');
  assert.ok(folded > 0.2 && folded < 0.32, `连帽卫衣的帽子占 ${folded.toFixed(3)}`);
});

test('帽子：圆领、衬衫、背心、吊带裙、半身裙、裤子、包都没有帽子', () => {
  for (const name of ['tee', 'shirt', 'trench', 'folded', 'tank', 'dress', 'skirt', 'pants', 'tote'] as const) {
    assert.equal(hood(name), 0, name);
  }
});

test('帽子：试穿时放下——人台上按肩线对齐，帽子那一段藏起来；手动挪动时跟着走', () => {
  const g = mannequinGeometry(DEFAULT_BODY);
  const plain = placeGarment(makeItem('top', '卫衣', '#3c6e48', { imageAspect: 0.9 }), g);
  const hooded = placeGarment(makeItem('top', '卫衣', '#3c6e48', { imageAspect: 0.9 * (1 - 0.25), hoodTop: 0.25 }), g);
  assert.equal(plain.clipTop, undefined);
  assert.ok(hooded.clipTop !== undefined);
  // 帽子以下的部分和没帽子的一样摆
  assert.ok(Math.abs(hooded.clipTop! - plain.y) < 0.01);
  assert.ok(Math.abs(hooded.y + hooded.height - (plain.y + plain.height)) < 0.01);
  assert.ok(Math.abs(hooded.width - plain.width) < 0.01);
  const moved = applyPlacement(hooded, { dx: 0, dy: 3, scale: 1 });
  assert.ok(Math.abs(moved.clipTop! - (hooded.clipTop! + 3)) < 0.01);
  // 背面同样藏起来
  const back = garmentView(makeItem('outer', '夹克', '#333333', { imageAspect: 0.8, hoodTop: 0.2 }), g, 'back');
  assert.ok(back.rect.clipTop !== undefined);
});

test('帽子：用户选了不放下、没帽子、或者是下装时，照原来的方式摆', () => {
  const g = mannequinGeometry(DEFAULT_BODY);
  assert.equal(placeGarment(makeItem('top', '卫衣', '#3c6e48', { hoodTop: 0.25, hoodUp: true }), g).clipTop, undefined);
  assert.equal(placeGarment(makeItem('top', '卫衣', '#3c6e48', { hoodTop: 0 }), g).clipTop, undefined);
  assert.equal(placeGarment(makeItem('bottom', '牛仔裤', '#4a6a90', { hoodTop: 0.3 }), g).clipTop, undefined);
});
