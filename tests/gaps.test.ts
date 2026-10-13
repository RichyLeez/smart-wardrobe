import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillGarmentGaps } from '../src/core/gaps';

const W = 200;
const H = 200;
function maskOf(inside: (x: number, y: number) => boolean): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inside(x, y)) m[y * W + x] = 255;
  return m;
}
const at = (m: Uint8Array, x: number, y: number) => m[y * W + x];

test('胸前的白色印花被挖掉：四周是厚厚一圈衣服，补回来', () => {
  const tee = (x: number, y: number) => x >= 50 && x < 150 && y >= 30 && y < 180;
  const print = (x: number, y: number) => x >= 75 && x < 125 && y >= 70 && y < 110;
  const r = fillGarmentGaps(maskOf((x, y) => tee(x, y) && !print(x, y)), W, H);
  assert.equal(r.holes, 1);
  assert.equal(at(r.fg, 100, 90), 1);
  assert.equal(at(r.added, 100, 90), 1);
  assert.equal(at(r.added, 60, 40), 0, '原本就是衣服的不算补回');
  assert.equal(r.addedCount, 50 * 40);
});

test('包带围出来的空隙是真的镂空，保持去掉；小的镂空（扣眼、小印花）补回', () => {
  // 包身 + 上面一条细带子围成的提手
  const body = (x: number, y: number) => x >= 40 && x < 160 && y >= 90 && y < 180;
  const strap = (x: number, y: number) => {
    const outer = (x - 100) ** 2 / 50 ** 2 + (y - 90) ** 2 / 60 ** 2 < 1;
    const inner = (x - 100) ** 2 / 44 ** 2 + (y - 90) ** 2 / 54 ** 2 < 1;
    return y < 90 && outer && !inner;
  };
  const eyelet = (x: number, y: number) => (x - 70) ** 2 + (y - 140) ** 2 < 4 ** 2;
  const r = fillGarmentGaps(maskOf((x, y) => (body(x, y) || strap(x, y)) && !eyelet(x, y)), W, H);
  assert.equal(at(r.fg, 100, 60), 0, '提手中间');
  assert.equal(at(r.fg, 70, 140), 1, '小扣眼补回');
});

test('条纹的白条被去掉、深色条断成几块：窄缝补上，变回一整件', () => {
  const tee = (x: number, y: number) => x >= 40 && x < 160 && y >= 20 && y < 180;
  const dark = (y: number) => Math.floor((y - 20) / 12) % 2 === 0;
  const r = fillGarmentGaps(maskOf((x, y) => tee(x, y) && dark(y)), W, H);
  assert.equal(r.bridged, 1);
  for (const y of [40, 70, 100, 130, 160]) assert.equal(at(r.fg, 100, y), 1, `第 ${y} 行`);
  assert.equal(at(r.fg, 41, 33), 1, '侧缝处也连上');
  assert.equal(at(r.fg, 30, 33), 0, '衣服外面不动');
  assert.equal(at(r.fg, 100, 190), 0);
});

test('一双鞋两块分开，不当成条纹连起来；擦除过的地方不补', () => {
  const shoes = maskOf((x, y) => y >= 80 && y < 120 && ((x >= 20 && x < 90) || (x >= 110 && x < 180)));
  const r = fillGarmentGaps(shoes, W, H);
  assert.equal(r.addedCount, 0);
  assert.equal(at(r.fg, 100, 100), 0);
  const tee = (x: number, y: number) => x >= 50 && x < 150 && y >= 30 && y < 180;
  const print = (x: number, y: number) => x >= 75 && x < 125 && y >= 70 && y < 110;
  const keepOut = new Uint8Array(W * H);
  for (let y = 70; y < 110; y++) for (let x = 75; x < 125; x++) keepOut[y * W + x] = 1;
  const r2 = fillGarmentGaps(maskOf((x, y) => tee(x, y) && !print(x, y)), W, H, keepOut);
  assert.equal(at(r2.fg, 100, 90), 0);
  assert.equal(r2.addedCount, 0);
});
