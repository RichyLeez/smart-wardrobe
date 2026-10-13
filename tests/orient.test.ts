import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoCut } from '../src/core/autocut';
import { alphaOf, cropToContent, detectOrientation, normAngle, rotateImage, uprightPiece } from '../src/core/orient';
import { OUTLINES, outlineImage } from './outlines';
import { scenes } from './scenes';

/** 转了 a 度之后，再按检测结果转回来，离正着差多少度 */
function residual(name: keyof typeof OUTLINES, a: number): number {
  const turned = cropToContent(rotateImage(outlineImage(name), a));
  const o = detectOrientation(alphaOf(turned), turned.width, turned.height);
  return Math.abs(normAngle(a + o.angle));
}

const GARMENTS: Array<keyof typeof OUTLINES> = ['tee', 'shirt', 'hoodie', 'pants', 'wide', 'shorts', 'skirt', 'dress', 'trench', 'folded', 'foldedHood', 'tank', 'tote'];

test('转正：正着放的不转', () => {
  for (const name of GARMENTS) {
    const img = outlineImage(name);
    assert.equal(detectOrientation(alphaOf(img), img.width, img.height).angle, 0, name);
  }
});

test('转正：横着、倒着、歪着拍的都转成领口（裤腰、提手）朝上', () => {
  for (const name of GARMENTS) {
    for (const a of [90, -90, 180, 12, -25]) {
      assert.ok(residual(name, a) <= 1.5, `${name} 转了 ${a}° 后没转回来（差 ${residual(name, a)}°）`);
    }
  }
});

test('转正：腰带这种细长条、分开的一双鞋不转', () => {
  const belt = outlineImage('belt');
  assert.equal(detectOrientation(alphaOf(belt), belt.width, belt.height).angle, 0);
  // 两只分开摆的鞋
  const w = 120;
  const h = 124;
  const pair = new Uint8Array(w * h);
  for (let y = 10; y < 114; y++) for (let x = 0; x < w; x++) if ((x > 12 && x < 48) || (x > 72 && x < 108)) pair[y * w + x] = 255;
  assert.equal(detectOrientation(pair, w, h).angle, 0);
});

test('转正：白底上去背后缺了白领口、白下摆的 T 恤不会被倒过来；横着拍的转回来或者不转', () => {
  const [blackTee, , stripes] = scenes(0.5);
  for (const s of [blackTee, stripes]) {
    const r = autoCut(s.img);
    const a = r.pieces[0].alpha;
    assert.equal(detectOrientation(a, s.w, s.h).angle, 0, s.name);
    // 整张照片转 90°（模拟横着拍）后再去背
    const sideways = rotateImage(s.img, 90);
    const r2 = autoCut(sideways);
    const o = detectOrientation(r2.pieces[0].alpha, sideways.width, sideways.height);
    const left = Math.abs(normAngle(90 + o.angle));
    if (s === blackTee) assert.ok(left <= 1.5, `${s.name}：检测到 ${o.angle}°`);
    // 条纹 T 恤的领口和下摆都被去掉了，两头分不清：宁可不转（用户点「转 90°」），也不能转反
    else assert.ok(left <= 1.5 || (o.angle === 0 && !o.confident), `${s.name}：检测到 ${o.angle}°`);
  }
});

test('旋转：90° 的整数倍逐像素搬运，任意角度保留面积并裁到衣物边界', () => {
  const img = { width: 3, height: 2, data: new Uint8ClampedArray(3 * 2 * 4) };
  for (let i = 0; i < 6; i++) img.data.set([i * 10, 0, 0, 255], i * 4);
  const r = rotateImage(img, 90);
  assert.equal(r.width, 2);
  assert.equal(r.height, 3);
  // 原来左上角 (0,0) 顺时针转 90° 后在右上角
  assert.equal(r.data[(0 * 2 + 1) * 4], 0);
  // 原来左下角 (0,1) 在左上角
  assert.equal(r.data[0], 30);
  const tee = outlineImage('tee');
  const area = (m: Uint8Array) => m.reduce((s, v) => s + v / 255, 0);
  const turned = cropToContent(rotateImage(tee, 33));
  assert.ok(Math.abs(area(alphaOf(turned)) / area(alphaOf(tee)) - 1) < 0.02, '面积基本不变');
  const up = uprightPiece(turned);
  assert.ok(Math.abs(normAngle(33 + up.angle)) <= 1.5);
  assert.ok(Math.abs(up.image.width / up.image.height - tee.width / tee.height) < 0.08, '转回来后宽高比和原来差不多');
});
