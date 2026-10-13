import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BODY,
  completeBody,
  estimateMeasures,
  applyPlacement,
  mannequinGeometry,
  mannequinShapes,
  placeGarment,
  suggestGoals,
  validateBody,
} from '../src/core/body';
import { makeItem } from './helpers';

test('默认身材数据通过校验，异常数据给出中文提示', () => {
  assert.deepEqual(validateBody(DEFAULT_BODY), []);
  const errs = validateBody({ ...DEFAULT_BODY, inseam: 120 });
  assert.ok(errs.length > 0);
  assert.ok(errs[0].includes('内侧腿长'));
});

test('腿长比例偏低时建议拉长腿部；腰臀比明显时建议突出腰线', () => {
  const goals = suggestGoals({ ...DEFAULT_BODY, height: 160, inseam: 68, waist: 64, hip: 92, gender: 'female' });
  const ids = goals.map((g) => g.goal);
  assert.ok(ids.includes('lengthen_legs'));
  assert.ok(ids.includes('define_waist'));
  const balanced = suggestGoals({ ...DEFAULT_BODY, inseam: 80 });
  assert.ok(!balanced.map((g) => g.goal).includes('lengthen_legs'));
});

test('肩宽胸围明显大于臀部时建议平衡上身', () => {
  const goals = suggestGoals({ ...DEFAULT_BODY, shoulder: 48, chest: 108, hip: 92, gender: 'male' });
  assert.ok(goals.some((g) => g.goal === 'balance_upper'));
});

test('人台关键位置从上到下依次排列，且随腿长变化', () => {
  const g = mannequinGeometry(DEFAULT_BODY);
  const ys = [g.chinY, g.shoulderY, g.chestY, g.waistY, g.hipY, g.crotchY, g.kneeY, g.ankleY, g.height];
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] > ys[i - 1], `第 ${i} 个位置顺序错误`);
  const longLegs = mannequinGeometry({ ...DEFAULT_BODY, inseam: 84 });
  assert.ok(longLegs.waistY < g.waistY, '腿长时腰线应更高');
  const shapes = mannequinShapes(g);
  assert.ok(shapes.body.startsWith('M') && shapes.body.endsWith('Z'));
});

test('衣物按类别放到正确位置：高腰裤比低腰裤靠上，长裤盖到脚踝', () => {
  const g = mannequinGeometry(DEFAULT_BODY);
  const high = placeGarment(makeItem('bottom', '西裤', '#222222', { rise: 'high', imageAspect: 0.45 }), g);
  const low = placeGarment(makeItem('bottom', '西裤', '#222222', { rise: 'low', imageAspect: 0.45 }), g);
  assert.ok(high.y < low.y);
  assert.ok(high.y + high.height > g.ankleY - 2);
  const shoes = placeGarment(makeItem('shoes', '运动鞋', '#ffffff', { imageAspect: 2 }), g);
  assert.ok(Math.abs(shoes.y + shoes.height - g.height) < 3);
  const shortTop = placeGarment(makeItem('top', 'T恤', '#ffffff', { length: 'short', imageAspect: 1.1 }), g);
  const longTop = placeGarment(makeItem('top', 'T恤', '#ffffff', { length: 'long', imageAspect: 1.1 }), g);
  assert.ok(shortTop.y + shortTop.height < longTop.y + longTop.height);
  const moved = applyPlacement(shortTop, { dx: 5, dy: -2, scale: 1.2 });
  assert.ok(Math.abs(moved.width - shortTop.width * 1.2) < 1e-9);
});

test('只填身高体重：按 GB/T 1335 中间体比例估算三围，体重越大腰围涨得越多', () => {
  const f = estimateMeasures(160, 52, 'female');
  assert.ok(Math.abs(f.chest - 84) <= 2 && Math.abs(f.waist - 67) <= 2 && Math.abs(f.hip - 90) <= 2, JSON.stringify(f));
  const m = estimateMeasures(170, 65, 'male');
  assert.ok(Math.abs(m.chest - 90) <= 2 && Math.abs(m.waist - 77) <= 2, JSON.stringify(m));
  const heavy = estimateMeasures(170, 85, 'male');
  assert.ok(heavy.waist - m.waist > heavy.chest - m.chest, '腰围比胸围涨得多');
  assert.equal(heavy.inseam, m.inseam, '腿长只和身高有关');
  // 常见身高体重范围内估算结果都能通过校验
  for (const g of ['female', 'male', 'unspecified'] as const) {
    for (const h of [150, 165, 180, 195]) {
      for (const bmi of [16.5, 20, 25, 32]) {
        const body = completeBody(h, Math.round(bmi * (h / 100) ** 2), g, {});
        assert.deepEqual(validateBody(body), [], `${g} ${h}cm BMI ${bmi}`);
      }
    }
  }
});

test('量过的尺寸优先，没量的按估算补上并记下来', () => {
  const b = completeBody(168, 60, 'female', { waist: 70 });
  assert.equal(b.waist, 70);
  assert.equal(b.weight, 60);
  assert.deepEqual(b.estimated, ['shoulder', 'chest', 'hip', 'inseam']);
  const full = completeBody(175, undefined, 'male', { shoulder: 45, chest: 92, waist: 80, hip: 96, inseam: 80 });
  assert.equal(full.estimated, undefined);
  assert.throws(() => completeBody(175, undefined, 'male', { chest: 92 }), /体重/);
  assert.ok(validateBody({ ...b, weight: 12 })[0].includes('体重'));
});

test('估算的尺寸不用来给身材建议', () => {
  const est = completeBody(160, 52, 'female', {});
  assert.deepEqual(suggestGoals(est), []);
  const shortLegs = completeBody(160, 52, 'female', { inseam: 68 });
  assert.deepEqual(suggestGoals(shortLegs).map((g) => g.goal), ['lengthen_legs']);
});
