import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFeedback,
  emptyFeedback,
  evaluateOutfit,
  recommend,
  signatureOf,
  summarizeNotes,
  swapAlternatives,
  type RecommendContext,
} from '../src/core/recommend';
import { warmthTarget } from '../src/core/weather';
import type { Item, WearRecord } from '../src/core/types';
import { makeItem } from './helpers';

function wardrobe(): Item[] {
  return [
    makeItem('top', '衬衫', '#f7f7f5', { id: 'shirt-white', name: '白衬衫' }),
    makeItem('top', 'T恤', '#1c1c1e', { id: 'tee-black', name: '黑T恤' }),
    makeItem('top', '毛衣', '#c9303a', { id: 'sweater-red', name: '红毛衣' }),
    makeItem('top', '针织衫', '#a8c5e2', { id: 'knit-blue', name: '浅蓝针织衫' }),
    makeItem('bottom', '西裤', '#1f2a44', { id: 'trousers-navy', name: '藏青西裤' }),
    makeItem('bottom', '牛仔裤', '#4b6b8f', { id: 'jeans', name: '牛仔裤' }),
    makeItem('bottom', '短裤', '#bfa477', { id: 'shorts', name: '卡其短裤' }),
    makeItem('dress', '连衣裙', '#f0b5c4', { id: 'dress-pink', name: '粉色连衣裙' }),
    makeItem('outer', '风衣', '#bfa477', { id: 'trench', name: '卡其风衣' }),
    makeItem('outer', '羽绒服', '#1c1c1e', { id: 'down', name: '黑羽绒服' }),
    makeItem('outer', '西装外套', '#48484c', { id: 'blazer', name: '深灰西装' }),
    makeItem('shoes', '运动鞋', '#f7f7f5', { id: 'sneakers', name: '白球鞋' }),
    makeItem('shoes', '皮鞋', '#1c1c1e', { id: 'oxfords', name: '黑皮鞋' }),
    makeItem('shoes', '凉鞋', '#a87a4c', { id: 'sandals', name: '凉鞋' }),
    makeItem('bag', '托特包', '#a87a4c', { id: 'tote', name: '驼色托特包' }),
    makeItem('belt', '皮带', '#1c1c1e', { id: 'belt', name: '黑皮带' }),
  ];
}

function ctx(partial: Partial<RecommendContext> = {}): RecommendContext {
  return {
    items: wardrobe(),
    weather: { tempC: 22, rain: false },
    occasion: null,
    goals: [],
    records: [],
    feedback: emptyFeedback(),
    today: '2026-10-13',
    rotation: true,
    ...partial,
  };
}

const ids = (items: Item[]) => items.map((i) => i.id);

test('正常衣橱给出 3 套完整、互不相同的搭配', () => {
  const r = recommend(ctx());
  assert.equal(r.outfits.length, 3);
  const sigs = new Set(r.outfits.map((o) => o.signature));
  assert.equal(sigs.size, 3);
  for (const o of r.outfits) {
    const cats = o.items.map((i) => i.category);
    assert.ok(cats.includes('dress') || (cats.includes('top') && cats.includes('bottom')), cats.join(','));
    assert.ok(cats.includes('shoes'));
    assert.ok(o.score >= 0 && o.score <= 100);
    assert.ok(summarizeNotes(o).length > 0);
  }
});

test('5°C 时每套都有外套、不会出现短裤和凉鞋', () => {
  const r = recommend(ctx({ weather: { tempC: 5, rain: false } }));
  assert.ok(r.outfits.length > 0);
  for (const o of r.outfits) {
    const all = ids(o.items);
    assert.ok(o.items.some((i) => i.category === 'outer'), all.join(','));
    assert.ok(!all.includes('shorts'));
    assert.ok(!all.includes('sandals'));
  }
});

test('30°C 时不推荐外套和厚毛衣', () => {
  const r = recommend(ctx({ weather: { tempC: 30, rain: false } }));
  assert.ok(r.outfits.length > 0);
  for (const o of r.outfits) {
    assert.ok(!o.items.some((i) => i.category === 'outer'));
    assert.ok(!ids(o.items).includes('sweater-red'));
  }
});

test('正式场合优先推荐西裤和皮鞋', () => {
  const r = recommend(ctx({ occasion: 'formal', weather: { tempC: 18, rain: false } }));
  const best = r.outfits[0];
  assert.ok(ids(best.items).includes('trousers-navy'), ids(best.items).join(','));
  assert.ok(ids(best.items).includes('oxfords'));
  assert.ok(best.parts.occasion.score > 0.9);
});

test('昨天刚穿过的单品会被降低优先级', () => {
  const base = recommend(ctx({ weather: { tempC: 18, rain: false } }));
  const first = base.outfits[0];
  const records: WearRecord[] = [
    {
      id: 'r1',
      date: '2026-10-12',
      itemIds: ids(first.items),
      itemSnapshots: [],
      source: 'recommend',
      createdAt: 0,
      updatedAt: 0,
    },
  ];
  const after = recommend(ctx({ weather: { tempC: 18, rain: false }, records }));
  assert.notEqual(after.outfits[0].signature, first.signature);
  const again = evaluateOutfit(first.items, ctx({ weather: { tempC: 18, rain: false }, records }));
  assert.ok(again.parts.rotation.score < first.parts.rotation.score);
  assert.ok(again.parts.rotation.notes.some((n) => n.text.includes('昨天')));
});

test('标记"不喜欢"后，这一套不再排在第一', () => {
  const c = ctx({ weather: { tempC: 18, rain: false } });
  const first = recommend(c).outfits[0];
  const fb = applyFeedback(c.feedback, first.items, 'dislike');
  assert.ok(fb.dislikedOutfits.includes(signatureOf(first.items)));
  const after = recommend({ ...c, feedback: fb });
  assert.ok(!after.outfits.some((o) => o.signature === first.signature));
});

test('拉长腿部目标下，高腰下装得分高于低腰', () => {
  const top = makeItem('top', 'T恤', '#f7f7f5', { length: 'regular' });
  const high = makeItem('bottom', '西裤', '#1f2a44', { rise: 'high' });
  const low = makeItem('bottom', '西裤', '#1f2a44', { rise: 'low' });
  const c = ctx({ goals: ['lengthen_legs'] });
  const a = evaluateOutfit([top, high], c);
  const b = evaluateOutfit([top, low], c);
  assert.ok(a.parts.body.score > b.parts.body.score);
  assert.ok(a.parts.body.notes.some((n) => n.text.includes('高腰')));
});

test('两种高饱和、不协调的颜色会被提示', () => {
  const red = makeItem('top', 'T恤', '#c7313b');
  const green = makeItem('bottom', '休闲裤', '#3d8b4c');
  const e = evaluateOutfit([red, green], ctx());
  assert.ok(e.parts.color.score < 0.6, String(e.parts.color.score));
  assert.ok(e.parts.color.notes.some((n) => n.kind === 'warn'));
  const navy = makeItem('bottom', '休闲裤', '#1f2a44');
  const e2 = evaluateOutfit([red, navy], ctx());
  assert.ok(e2.parts.color.score > 0.9);
});

test('换一件：返回同类别的替代品，外套可以选择不穿', () => {
  const c = ctx({ weather: { tempC: 16, rain: false } });
  const items = wardrobe();
  const current = [items[0], items[4], items[8], items[11]]; // 白衬衫、藏青西裤、风衣、白球鞋
  const alts = swapAlternatives(current, 'outer', c);
  assert.ok(alts.length >= 2);
  assert.ok(alts.some((a) => !a.items.some((i) => i.category === 'outer')));
  for (let k = 1; k < alts.length; k++) assert.ok(alts[k - 1].score >= alts[k].score);
});

test('衣橱缺少下装时给出提示而不是报错', () => {
  const r = recommend(ctx({ items: wardrobe().filter((i) => i.category !== 'bottom' && i.category !== 'dress') }));
  assert.equal(r.outfits.length, 0);
  assert.ok(r.notes[0].text.includes('下装'));
});

test('换一批：排除已展示的签名后给出新的组合', () => {
  const c = ctx({ weather: { tempC: 20, rain: false } });
  const first = recommend(c);
  const next = recommend(c, { exclude: first.outfits.map((o) => o.signature), seed: 7 });
  for (const o of next.outfits) assert.ok(!first.outfits.some((f) => f.signature === o.signature));
});

test('保暖分档覆盖从炎热到寒冷', () => {
  assert.equal(warmthTarget(30).outer, 'avoid');
  assert.equal(warmthTarget(20).outer, 'optional');
  assert.equal(warmthTarget(5).outer, 'required');
  assert.ok(warmthTarget(0).min > warmthTarget(15).min);
});
