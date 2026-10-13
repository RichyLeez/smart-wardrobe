import { test } from 'node:test';
import assert from 'node:assert/strict';
import { facetOptions, groupItems, matchesFacets, toggleFacet } from '../src/core/facets';
import { makeItem } from './helpers';

const items = [
  makeItem('top', 'T恤', '#232326', { id: 'a', brand: 'UNIQLO', material: '棉 100%' }),
  makeItem('top', '衬衫', '#f3f3f0', { id: 'b', brand: '优衣库', material: '棉 60%，聚酯纤维 40%' }),
  makeItem('outer', '风衣', '#bb9f72', { id: 'c', brand: 'ZARA', material: '聚酯纤维 100%', length: 'long' }),
  makeItem('bottom', '牛仔裤', '#506f94', { id: 'd', material: '棉 98%，氨纶 2%' }),
  makeItem('top', '毛衣', '#7a2433', { id: 'e', material: '羊毛' }),
];

test('分类：品牌写法统一后合并计数，面料按主要成分归类', () => {
  const brands = facetOptions(items, 'brand');
  assert.deepEqual(brands.map((b) => [b.label, b.count]), [['优衣库', 2], ['ZARA', 1]]);
  const fabrics = facetOptions(items, 'fabric');
  assert.deepEqual(fabrics.map((f) => [f.label, f.count]), [['棉', 3], ['聚酯纤维', 1], ['羊毛', 1]]);
});

test('分类：长短按固定顺序，季节可多值', () => {
  const len = facetOptions(items, 'length').map((o) => o.value);
  assert.deepEqual(len, ['regular', 'long']);
  const seasons = facetOptions(items, 'season').map((o) => o.value);
  assert.deepEqual(seasons, ['spring', 'summer', 'autumn', 'winter'].filter((s) => seasons.includes(s)));
});

test('筛选：同一维度内是"或"，不同维度之间是"且"', () => {
  let sel = toggleFacet({}, 'fabric', '棉');
  sel = toggleFacet(sel, 'fabric', '羊毛');
  assert.deepEqual(items.filter((i) => matchesFacets(i, sel)).map((i) => i.id), ['a', 'b', 'd', 'e']);
  sel = toggleFacet(sel, 'brand', '优衣库');
  assert.deepEqual(items.filter((i) => matchesFacets(i, sel)).map((i) => i.id), ['a', 'b']);
  sel = toggleFacet(toggleFacet(sel, 'brand', '优衣库'), 'fabric', '棉');
  assert.deepEqual(sel, { fabric: ['羊毛'] });
});

test('分组：没有品牌的单品放进"未填写"', () => {
  const groups = groupItems(items, 'brand');
  assert.deepEqual(groups.map((g) => [g.label, g.items.length]), [['优衣库', 2], ['ZARA', 1], ['未填写', 2]]);
});
