import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSizeFit, bodyTypeOf, jeansWaistInches, parseSizeCode } from '../src/core/sizefit';
import type { BodyProfile } from '../src/core/types';

const me: BodyProfile = { height: 175, shoulder: 45, chest: 92, waist: 80, hip: 96, inseam: 80, gender: 'male' };

test('号型解析与体型判断', () => {
  assert.deepEqual(parseSizeCode('175/92A'), { height: 175, girth: 92, bodyType: 'A' });
  assert.deepEqual(parseSizeCode('号型：１７０／８８'), { height: 170, girth: 88, bodyType: undefined });
  assert.equal(parseSizeCode('M'), null);
  assert.equal(jeansWaistInches('W30'), 30);
  assert.equal(jeansWaistInches('29'), 29);
  assert.equal(jeansWaistInches('W30 L32'), 30);
  assert.equal(jeansWaistInches('M'), null);
  assert.equal(bodyTypeOf(me), 'A'); // 胸腰差 12
  assert.equal(bodyTypeOf({ ...me, waist: 86 }), 'C'); // 胸腰差 6
  assert.equal(bodyTypeOf({ ...me, gender: 'unspecified' }), null);
});

test('上装：号型和胸围一致时是标准号，版型不变', () => {
  const r = analyzeSizeFit({ category: 'top', fit: 'regular', size: '175/92A' }, me)!;
  assert.equal(r.steps, 0);
  assert.equal(r.effectiveFit, 'regular');
  assert.equal(r.notes[0].kind, 'good');
  assert.match(r.notes[0].text, /标准号/);
});

test('上装：修身版大一号穿，接近常规', () => {
  const r = analyzeSizeFit({ category: 'top', fit: 'slim', size: '180/96A' }, me)!;
  assert.equal(r.steps, 1);
  assert.equal(r.effectiveFit, 'regular');
  assert.ok(r.notes.some((n) => /大 4cm，约大一号/.test(n.text)));
  assert.ok(r.notes.some((n) => /衣长和袖长可能偏长/.test(n.text)));
  assert.ok(r.notes.some((n) => /接近常规/.test(n.text)));
});

test('上装：小一号会提示偏紧，修身版再小一号额外提醒', () => {
  const r = analyzeSizeFit({ category: 'top', fit: 'slim', size: '170/88A' }, me)!;
  assert.equal(r.steps, -1);
  assert.equal(r.effectiveFit, 'slim');
  assert.ok(r.notes.some((n) => n.kind === 'warn' && /可能偏紧/.test(n.text)));
  assert.ok(r.notes.some((n) => /紧绷/.test(n.text)));
});

test('下装按腰围比较，每号 2cm', () => {
  const r = analyzeSizeFit({ category: 'bottom', fit: 'regular', size: '175/84A' }, me)!;
  assert.equal(r.steps, 2);
  assert.equal(r.effectiveFit, 'loose');
  assert.ok(r.notes.some((n) => /腰围大 4cm|比你的腰围大 4cm/.test(n.text)));
});

test('牛仔裤英寸尺码换算腰围', () => {
  const r = analyzeSizeFit({ category: 'bottom', size: 'W31' }, me)!;
  assert.match(r.notes[0].text, /79cm/);
  assert.equal(r.notes[0].kind, 'good');
});

test('体型不同时提醒腰腹位置', () => {
  const r = analyzeSizeFit({ category: 'top', size: '175/92A' }, { ...me, waist: 86 })!;
  assert.ok(r.notes.some((n) => /更接近 C 体型，腰腹位置可能偏紧/.test(n.text)));
});

test('只有字母尺码或没有身材数据时给出说明，不做判断', () => {
  const a = analyzeSizeFit({ category: 'top', size: 'M' }, me)!;
  assert.equal(a.effectiveFit, undefined);
  assert.match(a.notes[0].text, /没法和你的身材精确比较/);
  const b = analyzeSizeFit({ category: 'top', size: '175/92A' }, null)!;
  assert.match(b.notes[0].text, /填写身材数据后/);
  assert.equal(analyzeSizeFit({ category: 'shoes', size: '42' }, me), null);
});

test('胸围是估算的时候提醒去量一下', () => {
  const r = analyzeSizeFit({ category: 'top', fit: 'regular', size: '175/92A' }, { ...me, estimated: ['chest', 'hip'] })!;
  assert.ok(r.notes.some((n) => /胸围是按身高体重估算的/.test(n.text)));
  const pants = analyzeSizeFit({ category: 'bottom', fit: 'regular', size: '175/80A' }, { ...me, estimated: ['chest'] })!;
  assert.ok(!pants.notes.some((n) => /估算/.test(n.text)), '下装看腰围，腰围是实测的就不提醒');
});
