import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RGBAImage } from '../src/core/background';
import { detectHanger, removeMasked } from '../src/core/hanger';
import { canToggleOpen, canTuck, isOpen, isTucked, normalizeStyling, openFront, toggleStyling } from '../src/core/styling';
import { emptyFeedback, evaluateOutfit, recommend, type RecommendContext } from '../src/core/recommend';
import type { Item } from '../src/core/types';
import { makeItem } from './helpers';

function canvas(w: number, h: number): RGBAImage {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
}
function fill(img: RGBAImage, x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) {
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x++) img.data.set([...rgb, 255], (y * img.width + x) * 4);
  }
}
const alphaOf = (img: RGBAImage) => {
  const a = new Uint8Array(img.width * img.height);
  for (let i = 0; i < a.length; i++) a[i] = img.data[i * 4 + 3];
  return a;
};
const NAVY: [number, number, number] = [30, 40, 90];

/** 挂在衣架上的 T 恤：衣身 + 袖子，领口上方冒出挂钩，肩外露出横杆两端 */
function hangingTee(withHanger: boolean): RGBAImage {
  const img = canvas(300, 320);
  if (withHanger) fill(img, 50, 84, 250, 89, [160, 110, 60]); // 木横杆，衣服里的部分会被衣身盖住
  fill(img, 95, 80, 205, 300, NAVY); // 衣身
  fill(img, 70, 80, 95, 150, NAVY); // 左袖
  fill(img, 205, 80, 230, 150, NAVY); // 右袖
  if (withHanger) {
    fill(img, 148, 40, 152, 80, [185, 185, 190]); // 挂钩竖杆
    fill(img, 148, 36, 172, 40, [185, 185, 190]); // 挂钩弯头
  }
  return img;
}

test('挂着拍的衣服：认出挂钩和伸出肩外的横杆，去掉后衣身完整', () => {
  const img = hangingTee(true);
  const r = detectHanger(alphaOf(img), img);
  assert.ok(r.found);
  const at = (x: number, y: number) => r.mask[y * 300 + x];
  assert.equal(at(150, 50), 1, '挂钩');
  assert.equal(at(165, 37), 1, '挂钩弯头');
  assert.equal(at(58, 86), 1, '左边伸出的横杆');
  assert.equal(at(244, 86), 1, '右边伸出的横杆');
  assert.equal(at(150, 200), 0, '衣身不动');
  assert.equal(at(80, 120), 0, '袖子不动');
  assert.equal(at(100, 82), 0, '肩线不动');
  const cleaned = removeMasked(alphaOf(img), r.mask);
  assert.equal(cleaned[50 * 300 + 150], 0);
  assert.equal(cleaned[200 * 300 + 150], 255);
});

test('去背羽化留下的半透明光晕跟着衣架一起去掉，裁切范围回到衣服本身', () => {
  const img = hangingTee(true);
  const alpha = alphaOf(img);
  // 挂钩两侧一像素宽的半透明边
  for (let y = 40; y < 80; y++) {
    alpha[y * 300 + 147] = 60;
    alpha[y * 300 + 152] = 60;
  }
  const cleaned = removeMasked(alpha, detectHanger(alpha, img).mask);
  let top = 320;
  for (let i = 0; i < cleaned.length; i++) if (cleaned[i] > 16) top = Math.min(top, Math.floor(i / 300));
  assert.equal(top, 80, '最上面一行是衣服的肩线');
});

test('没有衣架时不误判；吊带的细肩带（两侧、同色）保留', () => {
  const plain = hangingTee(false);
  assert.equal(detectHanger(alphaOf(plain), plain).found, false);
  const cami = canvas(300, 320);
  fill(cami, 100, 90, 200, 300, NAVY);
  fill(cami, 112, 40, 115, 90, NAVY);
  fill(cami, 185, 40, 188, 90, NAVY);
  const r = detectHanger(alphaOf(cami), cami);
  assert.equal(r.found, false, '肩带不是衣架');
});

test('拉开外套：中线下摆露出空隙，领口几乎不动，侧缝和袖子不动', () => {
  const img = canvas(200, 240);
  fill(img, 40, 0, 160, 240, [120, 90, 60]); // 衣身
  fill(img, 0, 10, 40, 120, [120, 90, 60]); // 袖子
  fill(img, 160, 10, 200, 120, [120, 90, 60]);
  // 领口 V 字：顶部中间透明
  for (let y = 0; y < 30; y++) for (let x = 100 - (30 - y); x < 100 + (30 - y); x++) img.data[(y * 200 + x) * 4 + 3] = 0;
  const out = openFront(img);
  const a = (x: number, y: number) => out.data[(y * 200 + x) * 4 + 3];
  assert.equal(a(100, 235), 0, '下摆中间敞开');
  assert.equal(a(100, 40), 0, '领口下方也开了一点');
  assert.equal(a(95, 235), 0, '下摆的开口比较宽');
  assert.equal(a(41, 235), 255, '侧缝还在');
  assert.equal(a(158, 235), 255);
  assert.equal(a(10, 60), 255, '袖子不受影响');
  let gapTop = 0;
  let gapBottom = 0;
  for (let x = 40; x < 160; x++) {
    if (a(x, 40) === 0) gapTop++;
    if (a(x, 235) === 0) gapBottom++;
  }
  assert.ok(gapBottom > gapTop * 2, `越往下开得越大 ${gapTop} → ${gapBottom}`);
  // 原图不变
  assert.equal(img.data[(235 * 200 + 100) * 4 + 3], 255);
});

test('穿法判断：短款上衣不塞，照片敞开的外套只能敞开，换掉下装后塞进去失效', () => {
  const tee = makeItem('top', 'T恤', '#f7f7f5', { id: 'tee' });
  const crop = makeItem('top', '吊带', '#f7f7f5', { id: 'crop' });
  const jeans = makeItem('bottom', '牛仔裤', '#4b6b8f', { id: 'jeans' });
  const blazer = makeItem('outer', '西装外套', '#2b2b30', { id: 'blazer' });
  const openShot = makeItem('outer', '夹克', '#2b2b30', { id: 'jk', photoOpen: true });
  const zipless = makeItem('outer', '夹克', '#2b2b30', { id: 'np', openable: false });
  assert.ok(canTuck(tee, jeans));
  assert.ok(!canTuck(crop, jeans), '吊带是短款');
  assert.ok(!canTuck(tee, undefined));
  assert.ok(canToggleOpen(blazer));
  assert.ok(!canToggleOpen(openShot) && isOpen(openShot, undefined), '照片敞开的总是敞开');
  assert.ok(!canToggleOpen(zipless) && !isOpen(zipless, { open: ['np'] }));
  const s = toggleStyling(toggleStyling(undefined, 'tucked', 'tee'), 'open', 'blazer');
  assert.ok(isTucked(tee, [tee, jeans], s) && isOpen(blazer, s));
  assert.ok(!isTucked(tee, [tee], s), '没有下装时不算塞进去');
  assert.deepEqual(normalizeStyling([tee, blazer], s), { open: ['blazer'] });
  assert.deepEqual(toggleStyling(s, 'tucked', 'tee'), { open: ['blazer'] });
});


function ctx(items: Item[], partial: Partial<RecommendContext> = {}): RecommendContext {
  return {
    items,
    weather: { tempC: 20, rain: false },
    occasion: null,
    goals: [],
    records: [],
    feedback: emptyFeedback(),
    today: '2026-10-13',
    rotation: false,
    ...partial,
  };
}

test('推荐会自己判断要不要塞进去：长款上衣 + 想拉长腿时塞进裤腰', () => {
  const longTee = makeItem('top', 'T恤', '#f7f7f5', { id: 'long', length: 'long' });
  const jeans = makeItem('bottom', '牛仔裤', '#20294a', { id: 'jeans', rise: 'high' });
  const c = ctx([longTee, jeans], { goals: ['lengthen_legs'] });
  const plain = evaluateOutfit([longTee, jeans], c);
  const auto = evaluateOutfit([longTee, jeans], c, 'auto');
  assert.deepEqual(auto.styling, { tucked: ['long'] });
  assert.ok(auto.score > plain.score);
  assert.ok(auto.parts.body.notes.some((n) => /塞进下装，腰线露出来/.test(n.text)));
  assert.ok(plain.parts.body.notes.some((n) => /长款上衣盖住腰线/.test(n.text)));
  // 上下都宽松：塞进去后不再提醒松垮
  const hoodie = makeItem('top', '卫衣', '#8d8d92', { id: 'hoodie' });
  const wide = makeItem('bottom', '阔腿裤', '#c1a67a', { id: 'wide' });
  const t = evaluateOutfit([hoodie, wide], ctx([hoodie, wide]), { tucked: ['hoodie'] });
  assert.ok(t.parts.style.notes.some((n) => /宽松但不拖沓/.test(n.text)));
  assert.ok(!t.parts.style.notes.some((n) => /上下都宽松/.test(n.text)));
});

test('外套敞开：天气不冷时显修长，很冷时建议拉上；敞开后内搭颜色更重要', () => {
  const tee = makeItem('top', 'T恤', '#f7f7f5', { id: 'tee' });
  const trousers = makeItem('bottom', '西裤', '#20294a', { id: 'trousers' });
  const coat = makeItem('outer', '大衣', '#2b2b30', { id: 'coat' });
  const mild = ctx([tee, trousers, coat], { goals: ['lengthen_legs'], weather: { tempC: 14, rain: false } });
  const auto = evaluateOutfit([tee, trousers, coat], mild, 'auto');
  assert.deepEqual(auto.styling.open, ['coat']);
  assert.ok(auto.parts.body.notes.some((n) => /敞开穿，形成竖向线条/.test(n.text)));
  assert.ok(auto.parts.color.notes.some((n) => /敞开露出/.test(n.text)));
  const cold = ctx([tee, trousers, coat], { goals: ['lengthen_legs'], weather: { tempC: 2, rain: false } });
  assert.equal(evaluateOutfit([tee, trousers, coat], cold, 'auto').styling.open, undefined, '很冷时合上');
  const forced = evaluateOutfit([tee, trousers, coat], cold, { open: ['coat'] });
  assert.ok(forced.parts.weather.notes.some((n) => /拉上更保暖/.test(n.text)));
  const r = recommend(ctx([tee, trousers, coat], { weather: { tempC: 14, rain: false }, goals: ['lengthen_legs'] }));
  assert.ok(r.outfits.every((o) => o.styling !== undefined));
});

test('斜肩上方露出的一窄条横杆也去掉，肩线和领口不动', () => {
  const img = canvas(300, 320);
  fill(img, 50, 82, 250, 88, [160, 110, 60]); // 横杆
  // 衣身：肩线从中间 y=80 斜到两边 y=88
  for (let x = 95; x < 205; x++) fill(img, x, Math.round(80 + (Math.abs(x - 150) / 55) * 8), x + 1, 300, NAVY);
  fill(img, 70, 88, 95, 150, NAVY);
  fill(img, 205, 88, 230, 150, NAVY);
  fill(img, 148, 40, 152, 80, [185, 185, 190]);
  const r = detectHanger(alphaOf(img), img);
  assert.ok(r.found);
  const at = (x: number, y: number) => r.mask[y * 300 + x];
  assert.equal(at(100, 84), 1, '肩膀上方露出的横杆');
  assert.equal(at(198, 85), 1);
  assert.equal(at(60, 85), 1, '横杆伸出的一端');
  assert.equal(at(150, 82), 0, '领口处的衣服');
  assert.equal(at(100, 95), 0, '衣身');
  assert.equal(at(80, 100), 0, '袖子');
});
