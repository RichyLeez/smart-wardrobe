import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RGBAImage } from '../src/core/background';
import { rgbToLab } from '../src/core/color';
import { stylizeGarment } from '../src/core/stylize';

function makeImage(w: number, h: number, paint: (x: number, y: number) => [number, number, number, number]): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(paint(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}

const inside = (x: number, y: number) => x >= 30 && x < 170 && y >= 20 && y < 220;

/** 褶皱：沿斜向的明暗起伏，亮度上下差 30% 左右 */
const wrinkle = (x: number, y: number) => 0.82 + 0.18 * Math.sin((x + y * 0.6) / 7) * Math.sin(y / 23);

test('褶皱造成的明暗被抹平，单色衣服只剩一种颜色', () => {
  const img = makeImage(200, 240, (x, y) => {
    if (!inside(x, y)) return [0, 0, 0, 0];
    const k = wrinkle(x, y);
    return [40 * k, 58 * k, 110 * k, 255];
  });
  const { image, colors } = stylizeGarment(img);
  assert.equal(colors.length, 1, `色块数 ${colors.length}`);
  // 远离边缘的地方亮度几乎一致（原图起伏很大）
  const Ls: number[] = [];
  const Lsrc: number[] = [];
  for (let y = 60; y < 180; y += 3) {
    for (let x = 60; x < 140; x += 3) {
      const i = (y * 200 + x) * 4;
      Ls.push(rgbToLab(image.data[i], image.data[i + 1], image.data[i + 2])[0]);
      Lsrc.push(rgbToLab(img.data[i], img.data[i + 1], img.data[i + 2])[0]);
    }
  }
  const spread = (a: number[]) => Math.max(...a) - Math.min(...a);
  assert.ok(spread(Lsrc) > 10, `原图起伏 ${spread(Lsrc).toFixed(1)}`);
  assert.ok(spread(Ls) < 5, `处理后起伏 ${spread(Ls).toFixed(1)}`);
  // 颜色取亮部，不被阴影拉暗
  const lab = rgbToLab(colors[0].rgb[0], colors[0].rgb[1], colors[0].rgb[2]);
  const meanSrc = Lsrc.reduce((a, b) => a + b, 0) / Lsrc.length;
  assert.ok(lab[0] >= meanSrc, '色块不比原图平均更暗');
  // 外面仍然透明
  assert.equal(image.data[3], 0);
});

test('条纹和拼色保留下来，只去掉褶皱', () => {
  const img = makeImage(200, 240, (x, y) => {
    if (!inside(x, y)) return [0, 0, 0, 0];
    const k = wrinkle(x, y);
    const navy = Math.floor(y / 16) % 2 === 0;
    return navy ? [30 * k, 40 * k, 90 * k, 255] : [240 * k, 238 * k, 230 * k, 255];
  });
  const { image, colors } = stylizeGarment(img);
  assert.equal(colors.length, 2);
  const L = (x: number, y: number) => {
    const i = (y * 200 + x) * 4;
    return rgbToLab(image.data[i], image.data[i + 1], image.data[i + 2])[0];
  };
  assert.ok(L(100, 40) < 40 && L(100, 56) > 70, '深浅条纹分得开');
  assert.ok(Math.abs(L(80, 40) - L(120, 72)) < 4, '同一种条纹颜色一致');
});

test('轮廓上的毛刺被抹平', () => {
  const img = makeImage(200, 240, (x, y) => {
    const spike = y % 9 === 0 && x >= 170 && x < 173;
    if (!inside(x, y) && !spike) return [0, 0, 0, 0];
    return [180, 60, 60, 255];
  });
  const { image } = stylizeGarment(img);
  for (let y = 0; y < 240; y += 9) assert.ok(image.data[(y * 200 + 172) * 4 + 3] < 40, `第 ${y} 行的毛刺去掉了`);
  assert.equal(image.data[(100 * 200 + 100) * 4 + 3], 255);
});

test('全透明的图片返回空结果', () => {
  const { image, colors } = stylizeGarment(makeImage(20, 20, () => [0, 0, 0, 0]));
  assert.equal(colors.length, 0);
  assert.ok(image.data.every((v) => v === 0));
});
