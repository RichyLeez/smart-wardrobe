import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, CATEGORY_DEFAULTS, classificationDefaults, defaultsFor } from '../src/core/catalog';
import {
  applicableCount,
  applyBulk,
  autoReviewNote,
  commonValue,
  isUnverified,
  markVerified,
  organizeGroups,
  tagState,
  upgradeLegacyPending,
  viewCounts,
} from '../src/core/organize';
import { emptyFeedback, recommend } from '../src/core/recommend';
import { makeItem } from './helpers';

test('只认出大类时按大类套默认值，每个大类都有', () => {
  for (const c of CATEGORIES) {
    const d = CATEGORY_DEFAULTS[c];
    assert.ok(d.seasons.length > 0 && d.occasions.length > 0 && d.styles.length > 0, c);
  }
  assert.deepEqual(classificationDefaults('top', 'T恤'), defaultsFor('top', 'T恤'));
  assert.deepEqual(classificationDefaults('top', ''), CATEGORY_DEFAULTS.top);
  assert.equal(classificationDefaults('bottom', '').length, 'long');
});

test('自动分类的提示：没认出款式、碰到边缘、和背景接近', () => {
  assert.equal(autoReviewNote({ guess: { category: 'top', subtype: 'T恤', confidence: 'high', reason: '短袖' } }), undefined);
  const note = autoReviewNote({
    guess: { category: 'top', subtype: '', confidence: 'low', reason: '长袖上衣' },
    frameSides: ['left'],
    lowContrast: true,
  });
  assert.match(note ?? '', /只认出是长袖上衣，款式没认出/);
  assert.match(autoReviewNote({ guess: { category: 'top', subtype: '', confidence: 'low', reason: '有袖子' } }) ?? '', /只认出是上衣（有袖子）/);
  assert.match(note ?? '', /左边/);
  assert.match(note ?? '', /去背可能不准/);
});

test('自动分类的单品照常参与推荐；核对后去掉标记和提示', () => {
  const tee = makeItem('top', 'T恤', '#f7f7f5', { unverified: true, reviewNote: '衣服碰到了照片左边' });
  const jeans = makeItem('bottom', '牛仔裤', '#4b6b8f', { unverified: true });
  const shoes = makeItem('shoes', '运动鞋', '#f7f7f5');
  assert.ok(isUnverified(tee));
  const recs = recommend({
    items: [tee, jeans, shoes],
    weather: { tempC: 24, rain: false },
    occasion: null,
    goals: [],
    records: [],
    feedback: emptyFeedback(),
    today: '2026-10-17',
    rotation: false,
  });
  assert.ok(recs.outfits.length > 0, '未核对的也在推荐里');
  assert.ok(recs.outfits[0].items.some((i) => i.id === tee.id));
  const done = markVerified(tee, 5);
  assert.equal(done.unverified, undefined);
  assert.equal(done.reviewNote, undefined);
  assert.equal(done.updatedAt, 5);
  assert.equal(markVerified(shoes, 5), shoes, '本来就核对过的不变');
});

test('以前待整理的单品转成在用、未核对，其他的不动', () => {
  const p = makeItem('top', 'T恤', '#000000', { status: 'pending', reviewNote: '没认出类别' });
  const up = upgradeLegacyPending(p)!;
  assert.equal(up.status, 'active');
  assert.equal(up.unverified, true);
  assert.equal(up.reviewNote, '没认出类别');
  assert.equal(upgradeLegacyPending(makeItem('top', 'T恤', '#000000')), null);
  assert.equal(upgradeLegacyPending(makeItem('top', 'T恤', '#000000', { status: 'archived' })), null);
});

test('整理页按大类分组，没认出款式的排在组里最前面；三种范围的件数', () => {
  const a = makeItem('top', '衬衫', '#ffffff', { unverified: true });
  const b = makeItem('top', 'T恤', '#000000');
  const c = { ...makeItem('top', 'T恤', '#1f2a44', { unverified: true }), subtype: '' };
  const d = makeItem('bottom', '西裤', '#1c1c1e');
  const old = makeItem('top', '毛衣', '#734d30', { status: 'archived' });
  const groups = organizeGroups([d, a, b, c, old], 'all');
  assert.deepEqual(groups.map((g) => g.label), ['上衣', '下装']);
  assert.equal(groups[0].items[0].id, c.id, '款式没认出的在最前');
  assert.equal(groups[0].items.length, 3, '归档的不在整理页');
  assert.deepEqual(organizeGroups([d, a, b, c], 'unverified').flatMap((g) => g.items.map((i) => i.id)), [c.id, a.id]);
  assert.deepEqual(organizeGroups([d, a, b, c], 'nosubtype').flatMap((g) => g.items.map((i) => i.id)), [c.id]);
  assert.deepEqual(viewCounts([d, a, b, c, old]), { all: 4, unverified: 2, nosubtype: 1 });
});

test('多选时季节、场合、风格的三种状态，单选项是否一致', () => {
  const a = makeItem('top', 'T恤', '#ffffff');
  const b = makeItem('top', '毛衣', '#000000');
  assert.equal(tagState([a, b], 'seasons', 'summer'), 'some');
  assert.equal(tagState([a, b], 'seasons', 'autumn'), 'all');
  assert.equal(tagState([a, b], 'occasions', 'formal'), 'none');
  assert.equal(commonValue([a, b], 'warmth'), undefined);
  assert.equal(commonValue([a, b], 'fit'), 'regular');
  assert.equal(commonValue([a, a], 'warmth'), 1);
  assert.equal(applicableCount([a, b, makeItem('shoes', '运动鞋', '#ffffff')], 'fit'), 2);
  assert.equal(applicableCount([a, b], 'rise'), 0);
});

test('成批改款式：重新套默认值、自动名称跟着变、算核对过；没变的不返回', () => {
  const a = makeItem('top', 'T恤', '#1f2a44', { name: '藏青T恤', unverified: true, reviewNote: '只认出是上衣' });
  const b = makeItem('outer', '大衣', '#1f2a44', { name: '我的大衣', unverified: true });
  const c = makeItem('top', '卫衣', '#1f2a44', { name: '藏青卫衣' });
  const out = applyBulk([a, b, c], { category: 'top', subtype: '卫衣' }, 9);
  assert.equal(out.length, 2, '本来就是卫衣、也核对过的不改');
  const [na, nb] = out;
  assert.equal(na.subtype, '卫衣');
  assert.equal(na.name, '藏青卫衣');
  assert.equal(nb.name, '我的大衣', '自己起的名字不动');
  assert.equal(nb.category, 'top');
  assert.deepEqual(na.styles, defaultsFor('top', '卫衣')!.styles);
  assert.equal(na.unverified, undefined);
  assert.equal(na.reviewNote, undefined);
  assert.equal(na.updatedAt, 9);
  // 同一大类改成"款式不确定"时保留原来的季节、场合、风格
  const custom = makeItem('top', 'T恤', '#ffffff', { seasons: ['winter'] });
  const [unsure] = applyBulk([custom], { category: 'top', subtype: '' }, 9);
  assert.equal(unsure.subtype, '');
  assert.deepEqual(unsure.seasons, ['winter']);
  // 换到另一大类、款式不确定：按大类默认值
  const [shoe] = applyBulk([custom], { category: 'shoes', subtype: '' }, 9);
  assert.deepEqual(shoe.seasons, CATEGORY_DEFAULTS.shoes.seasons);
  assert.equal(shoe.fit, undefined, '鞋没有版型');
});

test('成批加上 / 去掉季节和场合，顺序保持春夏秋冬；只改其他项时不算核对', () => {
  const a = makeItem('top', 'T恤', '#ffffff', { unverified: true });
  const b = makeItem('top', '毛衣', '#000000', { unverified: true });
  const out = applyBulk([a, b], { add: { seasons: ['spring'], occasions: ['formal'] }, remove: { seasons: ['summer'] } }, 3);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].seasons, ['spring', 'autumn']);
  assert.deepEqual(out[1].seasons, ['spring', 'autumn', 'winter']);
  assert.ok(out.every((i) => i.occasions.includes('formal')));
  assert.ok(out.every((i) => i.unverified), '只改季节场合时仍是未核对');
  assert.equal(applyBulk(out, { add: { seasons: ['spring'] } }, 4).length, 0, '已经有的不重复加');
});

test('成批改保暖度、花纹、版型长度腰线：不适用的大类跳过；标为没问题', () => {
  const tee = makeItem('top', 'T恤', '#ffffff', { unverified: true });
  const pants = makeItem('bottom', '休闲裤', '#000000');
  const shoes = makeItem('shoes', '运动鞋', '#ffffff');
  const out = applyBulk([tee, pants, shoes], { fit: 'loose', rise: 'high', warmth: 3, pattern: 'stripe' }, 2);
  const byId = new Map(out.map((i) => [i.id, i]));
  assert.equal(byId.get(tee.id)!.fit, 'loose');
  assert.equal(byId.get(tee.id)!.rise, undefined, '上衣没有腰线');
  assert.equal(byId.get(pants.id)!.rise, 'high');
  assert.equal(byId.get(shoes.id)!.fit, undefined, '鞋没有版型');
  assert.equal(byId.get(shoes.id)!.warmth, 3);
  assert.equal(byId.get(shoes.id)!.pattern, 'stripe');
  const ok = applyBulk([tee, pants], { verify: true }, 7);
  assert.deepEqual(ok.map((i) => i.id), [tee.id], '只有未核对的那件变了');
  assert.equal(ok[0].unverified, undefined);
});
