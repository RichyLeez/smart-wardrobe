import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmPending, draftPendingItem, readyToConfirm, withCategory } from '../src/core/pending';
import { emptyFeedback, recommend } from '../src/core/recommend';
import { makeItem } from './helpers';

const images = { cutout: 'c', thumb: 't' };

test('批量录入的单品先存为待整理：按猜到的类别套默认值，自动起名', () => {
  const it = draftPendingItem({
    id: 'p1',
    color: { hex: '#20294a', name: '藏青' },
    guess: { category: 'bottom', subtype: '休闲裤', confidence: 'low', reason: '下面分成两条腿' },
    images,
    aspect: 0.5,
    lowContrast: false,
    now: 1,
  });
  assert.equal(it.status, 'pending');
  assert.equal(it.name, '藏青休闲裤');
  assert.equal(it.rise, 'mid');
  assert.ok(it.seasons.length > 0);
  assert.equal(it.reviewNote, undefined);
  assert.ok(readyToConfirm(it));
  const jeans = draftPendingItem({
    id: 'p3',
    color: { hex: '#56789f', name: '牛仔蓝' },
    guess: { category: 'bottom', subtype: '牛仔裤', confidence: 'high', reason: '' },
    images,
    aspect: 0.5,
    lowContrast: false,
    now: 1,
  });
  assert.equal(jeans.name, '牛仔裤', '不叫"牛仔蓝牛仔裤"');
  const unknown = draftPendingItem({ id: 'p2', color: { hex: '#fff', name: '白色' }, guess: null, images, aspect: 1, lowContrast: true, now: 1 });
  assert.equal(unknown.subtype, '');
  assert.equal(unknown.name, '白色上衣');
  assert.ok(!readyToConfirm(unknown), '没有子类不能直接确认');
  assert.match(unknown.reviewNote ?? '', /没认出类别/);
  assert.match(unknown.reviewNote ?? '', /去背可能不准/);
});

test('改类别时换默认值、自动名称跟着改；自己起的名字不动；确认后去掉提示', () => {
  const it = draftPendingItem({
    id: 'p1',
    color: { hex: '#20294a', name: '藏青' },
    guess: { category: 'top', subtype: '', confidence: 'low', reason: '长袖上衣' },
    images,
    aspect: 1,
    lowContrast: false,
    now: 1,
  });
  const coat = withCategory(it, 'outer', '大衣');
  assert.equal(coat.name, '藏青大衣');
  assert.equal(coat.warmth, 3);
  assert.equal(coat.rise, undefined);
  const named = withCategory({ ...it, name: '妈妈织的毛衣' }, 'top', '毛衣');
  assert.equal(named.name, '妈妈织的毛衣');
  const done = confirmPending(coat, 2);
  assert.equal(done.status, 'active');
  assert.equal(done.reviewNote, undefined);
});

test('待整理的单品不参与推荐', () => {
  const tee = makeItem('top', 'T恤', '#f7f7f5', { id: 'tee', status: 'pending' });
  const jeans = makeItem('bottom', '牛仔裤', '#4b6b8f', { id: 'jeans' });
  const r = recommend({
    items: [tee, jeans],
    weather: { tempC: 22, rain: false },
    occasion: null,
    goals: [],
    records: [],
    feedback: emptyFeedback(),
    today: '2026-10-13',
    rotation: false,
  });
  assert.ok(r.outfits.every((o) => !o.items.some((i) => i.id === 'tee')));
});
