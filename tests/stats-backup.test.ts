import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, daysBetween, idleItems, wearStats } from '../src/core/stats';
import { BACKUP_APP, BACKUP_VERSION, validateManifest } from '../src/core/backup';
import { emptyFeedback } from '../src/core/recommend';
import type { WearRecord } from '../src/core/types';
import { makeItem } from './helpers';

const rec = (id: string, date: string, itemIds: string[]): WearRecord => ({
  id,
  date,
  itemIds,
  itemSnapshots: [],
  source: 'manual',
  createdAt: 0,
  updatedAt: 0,
});

test('日期工具跨月、跨年计算正确', () => {
  assert.equal(daysBetween('2026-09-30', '2026-10-02'), 2);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('穿着次数按记录重新计算，同一条记录重复的单品只算一次', () => {
  const stats = wearStats([rec('a', '2026-10-01', ['x', 'y', 'x']), rec('b', '2026-10-05', ['x'])]);
  assert.equal(stats.get('x')?.count, 2);
  assert.equal(stats.get('x')?.last, '2026-10-05');
  assert.equal(stats.get('y')?.count, 1);
});

test('闲置提醒：超过阈值未穿或录入很久从未穿过', () => {
  const a = makeItem('top', 'T恤', '#ffffff', { id: 'a', createdAt: Date.UTC(2026, 7, 1) });
  const b = makeItem('top', 'T恤', '#000000', { id: 'b', createdAt: Date.UTC(2026, 9, 10) });
  const c = makeItem('top', 'T恤', '#888888', { id: 'c', createdAt: Date.UTC(2026, 7, 1) });
  const stats = wearStats([rec('r', '2026-08-20', ['a']), rec('r2', '2026-10-10', ['c'])]);
  const idle = idleItems([a, b, c], stats, '2026-10-13', 30);
  assert.deepEqual(
    idle.map((i) => i.item.id),
    ['a'],
  );
  assert.equal(idle[0].days, 54);
});

test('备份清单校验：图片缺失和非本应用文件都会被拒绝', () => {
  const item = makeItem('top', 'T恤', '#ffffff', { id: 'i1' });
  const ok = {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: '',
    items: [item],
    outfits: [],
    records: [],
    settings: { body: null, goals: [], goalsCustomized: false, rotation: true },
    feedback: emptyFeedback(),
    images: { [item.images.cutout]: 'images/a.png', [item.images.thumb]: 'images/b.png' },
  };
  assert.deepEqual(validateManifest(ok), []);
  assert.ok(validateManifest({ ...ok, images: {} })[0].includes('图片'));
  assert.ok(validateManifest({ ...ok, app: 'x' }).length > 0);
  assert.ok(validateManifest(null).length > 0);
});
