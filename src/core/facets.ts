// 衣橱分类：按品牌、长短、面料、颜色、版型、季节、场合、风格、保暖度筛选和分组。
// 同一维度内多选是"或"，不同维度之间是"且"。

import { CATEGORY_LABELS, FIT_LABELS, OCCASIONS, OCCASION_LABELS, SEASONS, SEASON_LABELS, STYLES, STYLE_LABELS, WARMTH_LABELS } from './catalog';
import { canonicalBrand, mainFiber } from './tag';
import type { Item } from './types';

export type FacetKey = 'category' | 'color' | 'brand' | 'fabric' | 'length' | 'fit' | 'season' | 'occasion' | 'style' | 'warmth';

export const FACET_LABELS: Record<FacetKey, string> = {
  category: '类别',
  color: '颜色',
  brand: '品牌',
  fabric: '面料',
  length: '长短',
  fit: '版型',
  season: '季节',
  occasion: '场合',
  style: '风格',
  warmth: '保暖',
};

/** 筛选面板里显示的维度（类别已在页面顶部单独筛选） */
export const FILTER_FACETS: FacetKey[] = ['color', 'brand', 'fabric', 'length', 'fit', 'season', 'occasion', 'style', 'warmth'];
/** 可以用来分组浏览的维度 */
export const GROUP_FACETS: FacetKey[] = ['category', 'color', 'brand', 'fabric', 'length', 'fit', 'season'];

const LENGTH_FACET_LABELS: Record<string, string> = { short: '短', regular: '中等', long: '长' };

export interface FacetValue {
  value: string;
  label: string;
}

/** 一件单品在某个维度上的取值（季节、场合、风格可以有多个） */
export function facetValues(item: Item, key: FacetKey): FacetValue[] {
  switch (key) {
    case 'category':
      return [{ value: item.category, label: CATEGORY_LABELS[item.category] }];
    case 'color':
      return [{ value: item.color.name, label: item.color.name }];
    case 'brand': {
      const b = canonicalBrand(item.brand);
      return b ? [{ value: b, label: b }] : [];
    }
    case 'fabric': {
      const f = mainFiber(item.material);
      return f ? [{ value: f, label: f }] : [];
    }
    case 'length':
      return item.length ? [{ value: item.length, label: LENGTH_FACET_LABELS[item.length] }] : [];
    case 'fit':
      return item.fit ? [{ value: item.fit, label: FIT_LABELS[item.fit] }] : [];
    case 'season':
      return item.seasons.map((s) => ({ value: s, label: SEASON_LABELS[s] }));
    case 'occasion':
      return item.occasions.map((o) => ({ value: o, label: OCCASION_LABELS[o] }));
    case 'style':
      return item.styles.map((s) => ({ value: s, label: STYLE_LABELS[s] }));
    case 'warmth':
      return [{ value: String(item.warmth), label: WARMTH_LABELS[item.warmth] }];
  }
}

/** 固定顺序的维度按定义顺序排列，其余按数量从多到少 */
const FIXED_ORDER: Partial<Record<FacetKey, string[]>> = {
  length: ['short', 'regular', 'long'],
  fit: ['slim', 'regular', 'loose'],
  season: SEASONS,
  occasion: OCCASIONS,
  style: STYLES,
  warmth: ['1', '2', '3'],
};

export interface FacetOption extends FacetValue {
  count: number;
}

export function facetOptions(items: Item[], key: FacetKey): FacetOption[] {
  const map = new Map<string, FacetOption>();
  for (const it of items) {
    for (const v of facetValues(it, key)) {
      const prev = map.get(v.value);
      if (prev) prev.count++;
      else map.set(v.value, { ...v, count: 1 });
    }
  }
  const list = [...map.values()];
  const order = FIXED_ORDER[key];
  if (order) return list.sort((a, b) => order.indexOf(a.value) - order.indexOf(b.value));
  return list.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN'));
}

export type FacetSelection = Partial<Record<FacetKey, string[]>>;

export function selectionSize(sel: FacetSelection): number {
  return Object.values(sel).reduce((n, v) => n + (v?.length ?? 0), 0);
}

export function matchesFacets(item: Item, sel: FacetSelection): boolean {
  for (const [key, values] of Object.entries(sel) as Array<[FacetKey, string[] | undefined]>) {
    if (!values || values.length === 0) continue;
    const mine = facetValues(item, key).map((v) => v.value);
    if (!mine.some((v) => values.includes(v))) return false;
  }
  return true;
}

export function toggleFacet(sel: FacetSelection, key: FacetKey, value: string): FacetSelection {
  const cur = sel[key] ?? [];
  const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
  const out = { ...sel, [key]: next };
  if (next.length === 0) delete out[key];
  return out;
}

export interface ItemGroup {
  value: string;
  label: string;
  items: Item[];
}

/** 按某个维度分组；没有这项信息的单品放在最后一组"未填写" */
export function groupItems(items: Item[], key: FacetKey): ItemGroup[] {
  const options = facetOptions(items, key);
  const groups: ItemGroup[] = options.map((o) => ({ value: o.value, label: o.label, items: [] }));
  const byValue = new Map(groups.map((g) => [g.value, g]));
  const missing: Item[] = [];
  for (const it of items) {
    const vs = facetValues(it, key);
    if (vs.length === 0) missing.push(it);
    for (const v of vs) byValue.get(v.value)?.items.push(it);
  }
  if (missing.length) groups.push({ value: '', label: '未填写', items: missing });
  return groups.filter((g) => g.items.length > 0);
}
