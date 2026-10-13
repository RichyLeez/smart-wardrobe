import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractColors,
  hexToLab,
  isNeutralColor,
  labToRgb,
  nearestColorName,
  rgbToHex,
  suggestColors,
  deltaE,
} from '../src/core/color';

test('Lab 与 RGB 往返转换误差很小', () => {
  for (const hex of ['#000000', '#ffffff', '#1f2a44', '#c7313b', '#a8c5e2', '#5a5d3a']) {
    const back = rgbToHex(labToRgb(hexToLab(hex)));
    assert.ok(deltaE(hexToLab(hex), hexToLab(back)) < 1, `${hex} → ${back}`);
  }
});

test('常见衣物颜色能识别成对应的中文色名', () => {
  const cases: Array<[string, string]> = [
    ['#111214', '黑色'],
    ['#fbfbfa', '白色'],
    ['#202b47', '藏青'],
    ['#4d6d92', '牛仔蓝'],
    ['#c4a679', '卡其'],
    ['#c9303a', '红色'],
    ['#f2b6c5', '粉色'],
    ['#8b8b90', '灰色'],
  ];
  for (const [hex, name] of cases) assert.equal(nearestColorName(hexToLab(hex)).name, name, hex);
});

test('中性色判断：黑白灰、卡其、藏青为中性，红色和浅蓝不是', () => {
  assert.equal(isNeutralColor('#111111'), true);
  assert.equal(isNeutralColor('#c4a679'), true);
  assert.equal(isNeutralColor('#202b47'), true);
  assert.equal(isNeutralColor('#c9303a'), false);
  assert.equal(isNeutralColor('#a8c5e2'), false);
});

test('主色提取只统计不透明像素，并给出主色和第二色', () => {
  const w = 40;
  const h = 40;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (x < 4) {
        // 透明区域里放绿色，不应被统计
        data.set([0, 255, 0, 0], o);
      } else if (y < 28) {
        data.set([200, 48, 58, 255], o); // 红
      } else {
        data.set([30, 42, 68, 255], o); // 藏青
      }
    }
  }
  const clusters = extractColors(data, 4);
  const s = suggestColors(clusters);
  assert.ok(s);
  assert.equal(s!.primary.name, '红色');
  assert.equal(s!.secondary?.name, '藏青');
  assert.equal(s!.multiColor, true);
  assert.ok(!clusters.some((c) => nearestColorName(c.lab).name === '绿色'));
});
