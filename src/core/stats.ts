// 穿着统计：穿着次数和最近穿着日期始终根据现有记录重新计算，删除或恢复记录不会重复累计。

import type { Item, WearRecord } from './types';

export function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayStr(): string {
  return toDateStr(new Date());
}

function parseYMD(s: string): number {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1);
}

/** b - a 的天数 */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseYMD(b) - parseYMD(a)) / 86400000);
}

export function addDays(s: string, n: number): string {
  const t = new Date(parseYMD(s) + n * 86400000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

export interface WearStat {
  count: number;
  last: string | null;
}

export function wearStats(records: WearRecord[]): Map<string, WearStat> {
  const map = new Map<string, WearStat>();
  for (const r of records) {
    for (const id of new Set(r.itemIds)) {
      const s = map.get(id) ?? { count: 0, last: null };
      s.count += 1;
      if (!s.last || r.date > s.last) s.last = r.date;
      map.set(id, s);
    }
  }
  return map;
}

export interface IdleItem {
  item: Item;
  /** null 表示从未穿过 */
  days: number | null;
}

/** 超过 thresholdDays 天没穿（或从未穿过、且录入已超过阈值天数）的在用单品 */
export function idleItems(items: Item[], stats: Map<string, WearStat>, today: string, thresholdDays = 30): IdleItem[] {
  const out: IdleItem[] = [];
  for (const item of items) {
    if (item.status !== 'active') continue;
    const s = stats.get(item.id);
    if (s?.last) {
      const days = daysBetween(s.last, today);
      if (days >= thresholdDays) out.push({ item, days });
    } else {
      const added = daysBetween(new Date(item.createdAt).toISOString().slice(0, 10), today);
      if (added >= thresholdDays) out.push({ item, days: null });
    }
  }
  return out.sort((a, b) => (b.days ?? 9999) - (a.days ?? 9999));
}

export function recordsInMonth(records: WearRecord[], year: number, month: number): WearRecord[] {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  return records.filter((r) => r.date.startsWith(prefix));
}
