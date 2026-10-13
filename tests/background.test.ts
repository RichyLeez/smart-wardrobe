import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alphaBBox,
  applyMaskAndCrop,
  combineMask,
  paintOverride,
  removeBackground,
  type RGBAImage,
} from '../src/core/background';

function makeImage(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

const at = (alpha: Uint8Array, w: number, x: number, y: number) => alpha[y * w + x];

test('浅色背景上的深色衣物：背景透明、衣物保留', () => {
  // 背景从左到右有轻微明暗渐变，模拟真实拍摄的光线
  const img = makeImage(120, 100, (x, y) => {
    const inShirt = x >= 30 && x < 90 && y >= 20 && y < 85;
    if (inShirt) return [32, 44, 70];
    const shade = 235 - Math.round(x * 0.15);
    return [shade, shade - 2, shade - 6];
  });
  const r = removeBackground(img, { threshold: 18 });
  assert.equal(at(r.alpha, 120, 5, 5), 0);
  assert.equal(at(r.alpha, 120, 115, 50), 0);
  assert.equal(at(r.alpha, 120, 60, 50), 255);
  assert.ok(r.coverage > 0.28 && r.coverage < 0.36, `coverage=${r.coverage}`);
  const box = alphaBBox(r.alpha, 120, 100, 0)!;
  assert.ok(Math.abs(box.x - 30) <= 2 && Math.abs(box.width - 60) <= 3, JSON.stringify(box));
});

test('一双鞋是两块分开的前景，都要保留；小噪点要去掉', () => {
  const img = makeImage(100, 60, (x, y) => {
    const left = x >= 10 && x < 45 && y >= 20 && y < 45;
    const right = x >= 55 && x < 90 && y >= 20 && y < 45;
    const dust = x >= 50 && x < 52 && y >= 5 && y < 7;
    if (left || right) return [20, 20, 22];
    if (dust) return [30, 30, 30];
    return [245, 245, 245];
  });
  const r = removeBackground(img, { threshold: 18 });
  assert.equal(at(r.alpha, 100, 25, 30), 255);
  assert.equal(at(r.alpha, 100, 70, 30), 255);
  assert.equal(at(r.alpha, 100, 51, 6), 0);
});

test('被衣物包围、颜色接近背景的空隙（如包带中间）会被去掉', () => {
  const img = makeImage(100, 100, (x, y) => {
    const ring = x >= 20 && x < 80 && y >= 20 && y < 80;
    const hole = x >= 35 && x < 65 && y >= 35 && y < 65;
    if (ring && !hole) return [150, 40, 40];
    return [240, 240, 240];
  });
  const r = removeBackground(img, { threshold: 18 });
  assert.equal(at(r.alpha, 100, 50, 50), 0);
  assert.equal(at(r.alpha, 100, 25, 50), 255);
  const keep = removeBackground(img, { threshold: 18, removeHoles: false });
  assert.equal(at(keep.alpha, 100, 50, 50), 255);
});

test('手动擦除和恢复覆盖自动结果，裁切后尺寸正确', () => {
  const img = makeImage(50, 50, (x, y) => (x >= 10 && x < 40 && y >= 10 && y < 40 ? [0, 0, 0] : [255, 255, 255]));
  const r = removeBackground(img, { threshold: 18, feather: 0 });
  const override = new Uint8Array(50 * 50);
  paintOverride(override, 50, 50, 25, 25, 3, 1);
  paintOverride(override, 50, 50, 3, 3, 2, 2);
  const merged = combineMask(r.alpha, override);
  assert.equal(merged[25 * 50 + 25], 0);
  assert.equal(merged[3 * 50 + 3], 255);
  const box = alphaBBox(merged, 50, 50, 0)!;
  const cropped = applyMaskAndCrop(img, merged, box);
  assert.equal(cropped.width, box.width);
  assert.equal(cropped.data.length, box.width * box.height * 4);
});
