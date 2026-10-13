import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fabricOf } from '../src/core/fabric';
import { emptyFeedback, evaluateOutfit, outfitPalette, recommend, type RecommendContext } from '../src/core/recommend';
import type { Item } from '../src/core/types';
import { makeItem } from './helpers';

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

const notesOf = (items: Item[], partial: Partial<RecommendContext> = {}) => {
  const e = evaluateOutfit(items, ctx(items, partial));
  return { e, material: e.parts.material.notes.map((n) => n.text).join('\n'), color: e.parts.color.notes.map((n) => n.text).join('\n') };
};

test('面料识别：成分优先，没有成分按子类的常见面料估计', () => {
  const f = (cat: Item['category'], sub: string, material?: string) => fabricOf(makeItem(cat, sub, '#888888', { material }));
  assert.equal(f('bottom', '牛仔裤', '棉 98%，氨纶 2%')!.kind, 'denim');
  assert.equal(f('bottom', '西裤')!.kind, 'suiting');
  const sweater = f('top', '毛衣', '羊毛 70%，锦纶 30%')!;
  assert.equal(sweater.kind, 'knit');
  assert.equal(sweater.label, '羊毛针织');
  assert.ok(sweater.warm > 0.9);
  assert.equal(f('top', 'T恤')!.kind, 'jersey');
  assert.equal(f('top', '衬衫')!.label, '棉质衬衫布');
  assert.equal(f('dress', '连衣裙', '桑蚕丝 100%')!.kind, 'silk');
  assert.equal(f('dress', '连衣裙')!.source, 'subtype');
  assert.equal(f('shoes', '皮鞋')!.kind, 'leather');
  assert.equal(f('outer', '羽绒服')!.kind, 'down');
  assert.equal(f('bag', '双肩包')!.kind, 'nylon');
  assert.equal(f('top', '衬衫', '亚麻 100%')!.kind, 'linen');
  assert.equal(f('jewelry', '项链'), null);
});

test('热天：涤纶上衣提示不透气，麻和棉得到肯定', () => {
  const poly = makeItem('top', 'T恤', '#f2f2f0', { name: '涤纶T恤', material: '聚酯纤维 100%' });
  const linen = makeItem('top', '衬衫', '#f2f2f0', { name: '亚麻衬衫', material: '亚麻 100%' });
  const shorts = makeItem('bottom', '短裤', '#20294a', { material: '棉 100%' });
  assert.match(notesOf([poly, shorts], { weather: { tempC: 32, rain: false } }).material, /不太透气/);
  const ok = notesOf([linen, shorts], { weather: { tempC: 32, rain: false } });
  assert.match(ok.material, /透气，适合 32°C/);
  assert.ok(ok.e.parts.material.score > notesOf([poly, shorts], { weather: { tempC: 32, rain: false } }).e.parts.material.score);
});

test('牛仔叠穿：颜色接近时提醒，深浅拉开时认可', () => {
  const jacket = makeItem('outer', '夹克', '#4b6b8f', { name: '牛仔夹克' });
  const jeans = makeItem('bottom', '牛仔裤', '#4a6a90');
  const darkJeans = makeItem('bottom', '牛仔裤', '#1d2738');
  const tee = makeItem('top', 'T恤', '#f7f7f5');
  assert.match(notesOf([tee, jeans, jacket]).material, /都是牛仔、颜色又接近/);
  assert.match(notesOf([tee, darkJeans, jacket]).material, /深浅拉开/);
});

test('正式程度：西装外套配卫衣会被指出，皮鞋配同色皮带加分', () => {
  const blazer = makeItem('outer', '西装外套', '#2b2b30');
  const hoodie = makeItem('top', '卫衣', '#8d8d92');
  const trousers = makeItem('bottom', '西裤', '#20294a');
  const shoes = makeItem('shoes', '皮鞋', '#1c1c1e');
  const belt = makeItem('belt', '皮带', '#1f1f22');
  assert.match(notesOf([hoodie, trousers, blazer, shoes]).material, /正式程度差得远/);
  const shirt = makeItem('top', '衬衫', '#f7f7f5');
  const formal = notesOf([shirt, trousers, blazer, shoes, belt], { occasion: 'formal' });
  assert.match(formal.material, /皮具同色/);
  assert.match(formal.material, /正式程度一致/);
});

test('质感对比：真丝上衣配针织开衫得到肯定；三件厚重面料提醒笨重', () => {
  const silk = makeItem('top', '衬衫', '#efe6d8', { name: '真丝衬衫', material: '桑蚕丝 100%' });
  const cardigan = makeItem('outer', '开衫', '#7a6a5a', { material: '羊毛 100%' });
  const trousers = makeItem('bottom', '西裤', '#20294a');
  assert.match(notesOf([silk, trousers, cardigan]).material, /顺滑和.*纹理形成质感对比/);
  const sweater = makeItem('top', '毛衣', '#7a2433');
  const cords = makeItem('bottom', '休闲裤', '#6b4a30', { name: '灯芯绒裤' });
  const coat = makeItem('outer', '大衣', '#3a3a3e');
  assert.match(notesOf([sweater, cords, coat], { weather: { tempC: 5, rain: false } }).material, /偏厚重/);
});

test('花纹：条纹配格纹提醒打架；纯色单品取花纹里的颜色加分', () => {
  const stripe = makeItem('top', '衬衫', '#f7f7f5', { pattern: 'stripe', color2: { hex: '#20294a', name: '藏青' } });
  const check = makeItem('bottom', '休闲裤', '#8a5a3c', { pattern: 'check', color2: { hex: '#2b2b30', name: '炭灰' } });
  const navy = makeItem('bottom', '西裤', '#21294b');
  assert.match(notesOf([stripe, check]).color, /图案容易打架/);
  assert.match(notesOf([stripe, navy]).color, /取了.*花纹里的颜色/);
});

test('配色呼应与色板：鞋子和上衣同色系；色板说明配色方式、面积占比合计为 1', () => {
  const top = makeItem('top', '针织衫', '#a7c3df');
  const trousers = makeItem('bottom', '西裤', '#2b2b30');
  const shoes = makeItem('shoes', '乐福鞋', '#9fbbd8', { name: '雾蓝乐福鞋' });
  assert.match(notesOf([top, trousers, shoes]).color, /雾蓝乐福鞋和.*颜色呼应/);
  const pal = outfitPalette([top, trousers, makeItem('shoes', '皮鞋', '#1c1c1e')]);
  assert.match(pal.scheme, /^中性色 \+ .+点缀$/);
  assert.ok(Math.abs(pal.swatches.reduce((a, s) => a + s.share, 0) - 1) < 1e-9);
  assert.equal(outfitPalette([makeItem('top', 'T恤', '#f7f7f5'), trousers]).scheme, '中性色');
  const pink = makeItem('dress', '连衣裙', '#eeb4c3');
  assert.match(outfitPalette([pink, makeItem('outer', '开衫', '#e8a6b8')]).scheme, /同色系/);
});

test('版型轮廓：上下都宽松给出建议，一松一紧认可', () => {
  const hoodie = makeItem('top', '卫衣', '#8d8d92');
  const wide = makeItem('bottom', '阔腿裤', '#c1a67a');
  const slim = makeItem('bottom', '牛仔裤', '#1d2738', { fit: 'slim' });
  assert.match(evaluateOutfit([hoodie, wide], ctx([hoodie, wide])).parts.style.notes.map((n) => n.text).join(), /上下都宽松/);
  assert.match(evaluateOutfit([hoodie, slim], ctx([hoodie, slim])).parts.style.notes.map((n) => n.text).join(), /上松下紧/);
});

test('这件怎么搭：指定单品出现在每一套里，即使不在当季', () => {
  const items = [
    makeItem('top', '毛衣', '#7a2433', { id: 'sweater' }),
    makeItem('top', 'T恤', '#f7f7f5', { id: 'tee' }),
    makeItem('top', '衬衫', '#a7c3df', { id: 'shirt' }),
    makeItem('bottom', '牛仔裤', '#4b6b8f', { id: 'jeans' }),
    makeItem('bottom', '西裤', '#20294a', { id: 'trousers' }),
    makeItem('dress', '连衣裙', '#eeb4c3', { id: 'dress' }),
    makeItem('shoes', '运动鞋', '#f7f7f5', { id: 'sneakers' }),
    makeItem('shoes', '皮鞋', '#1c1c1e', { id: 'oxfords' }),
    makeItem('outer', '风衣', '#bb9f72', { id: 'trench' }),
  ];
  const hot = ctx(items, { weather: { tempC: 29, rain: false } });
  const r = recommend(hot, { pinned: ['sweater'] });
  assert.ok(r.outfits.length >= 2);
  for (const o of r.outfits) {
    assert.ok(o.items.some((i) => i.id === 'sweater'));
    assert.ok(!o.items.some((i) => i.category === 'dress'));
  }
  assert.ok(r.outfits[0].parts.weather.notes.some((n) => n.kind === 'warn'), '天气不合适时照样提醒');
  const shoes = recommend(ctx(items), { pinned: ['oxfords'] });
  assert.ok(shoes.outfits.every((o) => o.items.some((i) => i.id === 'oxfords')));
  const dress = recommend(ctx(items), { pinned: ['dress'] });
  assert.ok(dress.outfits.every((o) => o.items.some((i) => i.id === 'dress') && !o.items.some((i) => i.category === 'top')));
});
