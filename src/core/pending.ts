// 待整理的单品：批量录入时先按猜到的类别存下来（status = 'pending'），
// 用户在"待整理"里点一下类别、子类再确认，确认后才参与推荐。
// 全部是纯函数。

import { CATEGORY_LABELS, FIELD_APPLICABILITY, defaultsFor } from './catalog';
import { frameContactText, type FrameSide } from './frame';
import type { CategoryGuess } from './guess';
import type { Category, ColorInfo, ImageRefs, Item } from './types';

/** 颜色名接款式名；颜色名和款式开头重复时只留款式（"牛仔蓝" + "牛仔裤" → "牛仔裤"） */
export function colorPlus(colorName: string, kind: string): string {
  if (kind.length >= 2 && colorName.startsWith(kind.slice(0, 2))) return kind;
  return `${colorName}${kind}`;
}

/** 自动名称：颜色 + 子类（没有子类时用类别），例如"藏青T恤""黑色鞋" */
export function autoName(colorName: string, category: Category, subtype: string): string {
  return colorPlus(colorName, subtype || CATEGORY_LABELS[category]);
}

/** 换类别、子类：套用子类的常用默认值；名称还是自动名称时一起更新 */
export function withCategory(item: Item, category: Category, subtype: string): Item {
  const app = FIELD_APPLICABILITY[category];
  const def = subtype ? defaultsFor(category, subtype) : undefined;
  const renamed = item.name === autoName(item.color.name, item.category, item.subtype);
  const next: Item = {
    ...item,
    category,
    subtype,
    name: renamed ? autoName(item.color.name, category, subtype) : item.name,
    warmth: def?.warmth ?? item.warmth,
    seasons: def?.seasons ?? item.seasons,
    occasions: def?.occasions ?? item.occasions,
    styles: def?.styles ?? item.styles,
    fit: app.fit ? def?.fit ?? item.fit ?? 'regular' : undefined,
    length: app.length ? def?.length ?? item.length ?? 'regular' : undefined,
    rise: app.rise ? def?.rise ?? item.rise ?? 'mid' : undefined,
  };
  return next;
}

/** 能不能直接确认：要有子类 */
export function readyToConfirm(item: Item): boolean {
  return item.status === 'pending' && !!item.subtype;
}

export function confirmPending(item: Item, now: number): Item {
  const out: Item = { ...item, status: 'active', updatedAt: now };
  delete out.reviewNote;
  return out;
}

/** 批量录入：按取色和猜到的类别生成一件待整理的单品 */
export function draftPendingItem(input: {
  id: string;
  color: ColorInfo;
  color2?: ColorInfo;
  guess: CategoryGuess | null;
  images: ImageRefs;
  aspect: number;
  lowContrast: boolean;
  now: number;
  /** 连帽上衣的帽子占贴图高度的比例 */
  hoodTop?: number;
  /** 衣服碰到的照片边缘 */
  frameSides?: FrameSide[];
}): Item {
  const category: Category = input.guess?.category ?? 'top';
  const subtype = input.guess?.subtype ?? '';
  const notes: string[] = [];
  if (!input.guess) notes.push('没认出类别，请选一下');
  else if (!subtype) notes.push(`看着像${CATEGORY_LABELS[category]}（${input.guess.reason}），请选具体款式`);
  if (input.frameSides?.length) {
    notes.push(`${frameContactText(input.frameSides)}，那一侧可能缺了一块，可以退后一点重拍`);
  }
  if (input.lowContrast) notes.push('衣服上有和背景很接近的颜色，去背可能不准，可以点「细改」检查');
  const base: Item = {
    id: input.id,
    name: '',
    category,
    subtype: '',
    color: input.color,
    color2: input.color2,
    pattern: 'solid',
    seasons: [],
    warmth: 2,
    occasions: [],
    styles: [],
    tags: [],
    favorite: false,
    status: 'pending',
    images: input.images,
    imageAspect: input.aspect,
    hoodTop: input.hoodTop !== undefined ? Math.round(input.hoodTop * 1000) / 1000 : undefined,
    createdAt: input.now,
    updatedAt: input.now,
  };
  base.name = autoName(input.color.name, category, '');
  const item = withCategory(base, category, subtype);
  if (notes.length) item.reviewNote = notes.join('；');
  return item;
}
