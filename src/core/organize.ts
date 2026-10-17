// 自动分类与整理：录入时按轮廓猜好类别和款式、套好默认值后直接放进衣橱（带"未核对"标记），
// 以后在「整理」页按类别成批修改。全部是纯函数。

import { CATEGORIES, CATEGORY_LABELS, FIELD_APPLICABILITY, OCCASIONS, SEASONS, STYLES } from './catalog';
import { frameContactText, type FrameSide } from './frame';
import type { CategoryGuess } from './guess';
import { withCategory } from './pending';
import type { Category, Fit, Item, Length, Occasion, Pattern, Rise, Season, Style, Warmth } from './types';

// ---------- 录入时 ----------

/** 自动分类时要留意的地方（写进 reviewNote，整理页里显示） */
export function autoReviewNote(input: {
  guess: CategoryGuess | null;
  frameSides?: FrameSide[];
  lowContrast?: boolean;
}): string | undefined {
  const notes: string[] = [];
  const g = input.guess;
  if (g && !g.subtype) {
    const label = CATEGORY_LABELS[g.category];
    // "长袖上衣"这类说明本身带着大类名时直接用它
    const what = g.reason.includes(label) ? g.reason : g.reason ? `${label}（${g.reason}）` : label;
    notes.push(`只认出是${what}，款式没认出`);
  }
  if (input.frameSides?.length) notes.push(`${frameContactText(input.frameSides)}，那一侧可能缺了一块`);
  if (input.lowContrast) notes.push('衣服上有和背景很接近的颜色，去背可能不准');
  return notes.length ? notes.join('；') : undefined;
}

export function isUnverified(item: Item): boolean {
  return item.status === 'active' && !!item.unverified;
}

/** 核对过：去掉"未核对"标记和提示 */
export function markVerified(item: Item, now: number): Item {
  if (!item.unverified && item.reviewNote === undefined) return item;
  const out: Item = { ...item, updatedAt: now };
  delete out.unverified;
  delete out.reviewNote;
  return out;
}

/**
 * 以前批量录入、还没确认的单品（status: 'pending'）：现在自动分类的单品直接在用，
 * 所以打开应用时把它们转成"在用、未核对"。不需要转的返回 null。
 */
export function upgradeLegacyPending(item: Item): Item | null {
  if (item.status !== 'pending') return null;
  return { ...item, status: 'active', unverified: true };
}

// ---------- 整理页：分组 ----------

export type OrganizeView = 'all' | 'unverified' | 'nosubtype';

export interface OrganizeGroup {
  category: Category;
  label: string;
  items: Item[];
}

export function inView(item: Item, view: OrganizeView): boolean {
  if (item.status !== 'active') return false;
  if (view === 'unverified') return !!item.unverified;
  if (view === 'nosubtype') return !item.subtype;
  return true;
}

export function viewCounts(items: Item[]): Record<OrganizeView, number> {
  const out: Record<OrganizeView, number> = { all: 0, unverified: 0, nosubtype: 0 };
  for (const i of items) {
    if (i.status !== 'active') continue;
    out.all++;
    if (i.unverified) out.unverified++;
    if (!i.subtype) out.nosubtype++;
  }
  return out;
}

/** 按大类分组；组内同一款式排在一起（没认出款式的排在最前面，方便先处理） */
export function organizeGroups(items: Item[], view: OrganizeView): OrganizeGroup[] {
  const shown = items.filter((i) => inView(i, view));
  const groups: OrganizeGroup[] = [];
  for (const c of CATEGORIES) {
    const list = shown.filter((i) => i.category === c);
    if (!list.length) continue;
    list.sort((a, b) => (a.subtype === b.subtype ? a.name.localeCompare(b.name, 'zh') : !a.subtype ? -1 : !b.subtype ? 1 : a.subtype.localeCompare(b.subtype, 'zh')));
    groups.push({ category: c, label: CATEGORY_LABELS[c], items: list });
  }
  return groups;
}

// ---------- 整理页：成批修改 ----------

export type TagKey = 'seasons' | 'occasions' | 'styles';
export type TagValue<K extends TagKey> = K extends 'seasons' ? Season : K extends 'occasions' ? Occasion : Style;
export type TriState = 'all' | 'some' | 'none';

const TAG_ORDER: Record<TagKey, readonly string[]> = { seasons: SEASONS, occasions: OCCASIONS, styles: STYLES };

/** 选中的几件里，有多少件带着这个季节 / 场合 / 风格 */
export function tagState(items: Item[], key: TagKey, value: string): TriState {
  let n = 0;
  for (const i of items) if ((i[key] as string[]).includes(value)) n++;
  return n === 0 ? 'none' : n === items.length ? 'all' : 'some';
}

export type SingleKey = 'warmth' | 'pattern' | 'fit' | 'length' | 'rise';

/** 选中的几件这一项都一样时返回这个值，不一样（或都没有）时返回 undefined */
export function commonValue<K extends SingleKey>(items: Item[], key: K): Item[K] | undefined {
  const vals = items.map((i) => i[key]);
  if (!vals.length || vals[0] === undefined) return undefined;
  return vals.every((v) => v === vals[0]) ? vals[0] : undefined;
}

/** 版型、长度、腰线只对部分大类有意义：选中的里有几件适用 */
export function applicableCount(items: Item[], key: 'fit' | 'length' | 'rise'): number {
  return items.filter((i) => FIELD_APPLICABILITY[i.category][key]).length;
}

export interface BulkEdit {
  /** 换大类和款式：按新款式重新套默认值，算核对过（subtype 为空表示"款式不确定"） */
  category?: Category;
  subtype?: string;
  /** 每一件都加上 / 都去掉的季节、场合、风格 */
  add?: { [K in TagKey]?: TagValue<K>[] };
  remove?: { [K in TagKey]?: TagValue<K>[] };
  warmth?: Warmth;
  pattern?: Pattern;
  fit?: Fit;
  length?: Length;
  rise?: Rise;
  /** 标为核对过 */
  verify?: boolean;
}

function editTags<K extends TagKey>(cur: TagValue<K>[], key: K, add: string[] = [], remove: string[] = []): TagValue<K>[] {
  const set = new Set<string>(cur);
  for (const v of add) set.add(v);
  for (const v of remove) set.delete(v);
  return TAG_ORDER[key].filter((v) => set.has(v)) as TagValue<K>[];
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** 对选中的每一件应用同一组修改，只返回真的变了的单品 */
export function applyBulk(items: Item[], edit: BulkEdit, now: number): Item[] {
  const out: Item[] = [];
  for (const orig of items) {
    let it = orig;
    let changed = false;
    if (edit.category) {
      const sub = edit.subtype ?? '';
      if (orig.category !== edit.category || orig.subtype !== sub) {
        it = withCategory(it, edit.category, sub);
        changed = true;
      }
    }
    for (const key of ['seasons', 'occasions', 'styles'] as const) {
      const add = edit.add?.[key] as string[] | undefined;
      const remove = edit.remove?.[key] as string[] | undefined;
      if (!add?.length && !remove?.length) continue;
      const next = editTags(it[key] as TagValue<typeof key>[], key, add, remove);
      if (!sameList(next, it[key])) {
        it = { ...it, [key]: next };
        changed = true;
      }
    }
    if (edit.warmth !== undefined && it.warmth !== edit.warmth) {
      it = { ...it, warmth: edit.warmth };
      changed = true;
    }
    if (edit.pattern !== undefined && it.pattern !== edit.pattern) {
      it = { ...it, pattern: edit.pattern };
      changed = true;
    }
    const app = FIELD_APPLICABILITY[it.category];
    if (edit.fit !== undefined && app.fit && it.fit !== edit.fit) {
      it = { ...it, fit: edit.fit };
      changed = true;
    }
    if (edit.length !== undefined && app.length && it.length !== edit.length) {
      it = { ...it, length: edit.length };
      changed = true;
    }
    if (edit.rise !== undefined && app.rise && it.rise !== edit.rise) {
      it = { ...it, rise: edit.rise };
      changed = true;
    }
    if (edit.verify || edit.category) {
      const v = markVerified(it, now);
      if (v !== it) {
        it = v;
        changed = true;
      }
    }
    if (changed) out.push({ ...it, updatedAt: now });
  }
  return out;
}
