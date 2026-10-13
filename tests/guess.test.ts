import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessCategory } from '../src/core/guess';
import { raster, type Shape } from './raster';

// 示例衣橱的轮廓（与 ui/demo.ts 相同的主体路径）
const DEMO: Record<string, { view: [number, number]; shapes: Shape[] }> = {
  tee: { view: [200, 196], shapes: [{ d: 'M70,8 Q100,30 130,8 L166,20 L198,58 L172,82 L155,70 L155,190 L45,190 L45,70 L28,82 L2,58 L34,20 Z' }] },
  shirt: { view: [240, 236], shapes: [{ d: 'M84,10 L120,30 L156,10 L192,24 L236,184 L210,194 L172,86 L172,230 L68,230 L68,86 L30,194 L4,184 L48,24 Z' }] },
  hoodie: { view: [250, 246], shapes: [{ d: 'M86,30 Q90,2 125,2 Q160,2 164,30 L200,38 L246,192 L218,204 L178,98 L178,240 L72,240 L72,98 L32,204 L4,192 L50,38 Z' }] },
  pants: { view: [160, 310], shapes: [{ d: 'M18,4 L142,4 L142,22 L152,304 L94,304 L80,98 L66,304 L8,304 L18,22 Z' }] },
  wide: { view: [190, 310], shapes: [{ d: 'M40,4 L150,4 L150,22 L186,304 L104,304 L95,110 L86,304 L4,304 L40,22 Z' }] },
  shorts: { view: [170, 140], shapes: [{ d: 'M22,4 L148,4 L148,22 L166,134 L94,134 L85,74 L76,134 L4,134 L22,22 Z' }] },
  skirt: { view: [190, 214], shapes: [{ d: 'M50,4 L140,4 L140,22 L186,208 L4,208 L50,22 Z' }] },
  dress: { view: [210, 340], shapes: [{ d: 'M72,6 L90,6 Q105,34 120,6 L138,6 L150,62 L134,124 L206,334 L4,334 L76,124 L60,62 Z' }] },
  trench: { view: [260, 340], shapes: [{ d: 'M92,8 L130,28 L168,8 L206,22 L256,220 L228,230 L186,96 L194,334 L66,334 L74,96 L32,230 L4,220 L54,22 Z' }] },
  sneakers: {
    view: [280, 116],
    shapes: [
      { d: 'M6,70 Q8,30 40,26 L70,30 Q96,46 140,54 Q156,60 154,82 L6,82 Z', dx: 120, dy: 6 },
      { d: 'M6,82 L154,82 L154,94 L6,94 Z', dx: 120, dy: 6 },
      { d: 'M6,82 Q8,40 42,36 L74,40 Q100,56 146,64 Q162,70 160,94 L6,94 Z' },
      { d: 'M6,94 L160,94 L160,108 L6,108 Z' },
    ],
  },
  tote: {
    view: [190, 220],
    shapes: [{ d: 'M58,70 Q58,8 95,8 Q132,8 132,70', stroke: 9 }, { d: 'M18,66 L172,66 L186,214 L4,214 Z' }],
  },
  belt: { view: [320, 44], shapes: [{ rect: [40, 10, 276, 24] }, { d: 'M6,4 L48,4 L48,40 L6,40 Z', stroke: 5 }] },
};

function guess(name: string, color?: string) {
  const d = DEMO[name];
  const r = raster(d.shapes, d.view[0], d.view[1]);
  return guessCategory(r.alpha, r.w, r.h, color);
}

test('按轮廓猜类别：短袖 T 恤、长袖上衣、长外套', () => {
  assert.deepEqual(pick(guess('tee')), ['top', 'T恤']);
  assert.deepEqual(pick(guess('shirt')), ['top', ''], '长袖分不出衬衫还是卫衣，只猜上衣');
  assert.deepEqual(pick(guess('hoodie')), ['top', '']);
  assert.deepEqual(pick(guess('trench')), ['outer', '大衣']);
});

test('按轮廓猜类别：长裤、阔腿裤、短裤、牛仔裤、半身裙、连衣裙', () => {
  assert.deepEqual(pick(guess('pants', '#20294a')), ['bottom', '休闲裤']);
  assert.deepEqual(pick(guess('pants', '#506f94')), ['bottom', '牛仔裤'], '牛仔蓝');
  assert.deepEqual(pick(guess('wide')), ['bottom', '阔腿裤']);
  assert.deepEqual(pick(guess('shorts')), ['bottom', '短裤']);
  assert.deepEqual(pick(guess('skirt')), ['bottom', '半身裙']);
  assert.equal(guess('dress')?.category, 'dress');
});

test('按轮廓猜类别：鞋、包、腰带；一双分开摆的鞋', () => {
  assert.equal(guess('sneakers')?.category, 'shoes');
  assert.equal(guess('tote')?.category, 'bag');
  assert.equal(guess('belt')?.category, 'belt');
  const pair = raster([{ d: 'M10,20 Q10,4 30,4 Q50,4 50,30 L48,110 Q30,122 12,110 Z' }, { d: 'M70,20 Q70,4 90,4 Q110,4 110,30 L108,110 Q90,122 72,110 Z' }], 120, 124);
  assert.equal(guessCategory(pair.alpha, pair.w, pair.h)?.category, 'shoes');
});

test('猜不出来时不乱猜', () => {
  const blob = raster([{ d: 'M10,10 L110,10 L110,110 L10,110 Z' }], 120, 120);
  assert.equal(guessCategory(blob.alpha, blob.w, blob.h), null, '一个方块');
  assert.equal(guessCategory(new Uint8Array(100), 10, 10), null, '空的');
  const sock = raster([{ d: 'M10,10 L50,10 L50,120 Q50,150 80,150 L110,150 L110,180 L40,180 Q10,180 10,150 Z' }], 120, 190);
  assert.equal(guessCategory(sock.alpha, sock.w, sock.h), null, '袜子（不对称的 L 形）');
});

function pick(g: ReturnType<typeof guessCategory>) {
  return g ? [g.category, g.subtype] : null;
}
