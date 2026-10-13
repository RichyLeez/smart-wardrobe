// 整库备份的数据格式与校验（不含 ZIP 读写，ZIP 由 storage/backup.ts 负责）。

import type { FeedbackState, Item, Outfit, Settings, WearRecord } from './types';

export const BACKUP_APP = 'smart-wardrobe';
export const BACKUP_VERSION = 1;

export interface BackupManifest {
  app: typeof BACKUP_APP;
  version: number;
  exportedAt: string;
  items: Item[];
  outfits: Outfit[];
  records: WearRecord[];
  settings: Settings;
  feedback: FeedbackState;
  /** 图片 id → ZIP 内的文件路径 */
  images: Record<string, string>;
  /** 图片 id → [宽, 高] */
  imageSizes?: Record<string, [number, number]>;
}

/** 示例衣橱的图片是现场绘制的（id 以 demo: 开头），不需要也不会写进备份 */
export function isVirtualImageId(id: string): boolean {
  return id.startsWith('demo:');
}

/** 一件单品用到的全部图片（正面、背面的贴图、缩略图和原图） */
export function itemImageIds(item: Pick<Item, 'images'>): string[] {
  const im = item.images;
  return [im.cutout, im.thumb, im.original, im.backCutout, im.backThumb, im.backOriginal].filter((x): x is string => !!x);
}

/** 单品的背面图片 */
export function backImageIds(item: Pick<Item, 'images'>): string[] {
  const im = item.images;
  return [im.backCutout, im.backThumb, im.backOriginal].filter((x): x is string => !!x);
}

export function collectImageIds(items: Item[], records: WearRecord[]): string[] {
  const ids = new Set<string>();
  for (const i of items) for (const id of itemImageIds(i)) ids.add(id);
  for (const r of records) if (r.photo) ids.add(r.photo);
  return [...ids].filter((id) => !isVirtualImageId(id));
}

/** 校验备份清单，返回错误描述；为空表示可以导入 */
export function validateManifest(m: unknown): string[] {
  const errors: string[] = [];
  if (!m || typeof m !== 'object') return ['备份文件内容无法识别'];
  const x = m as Partial<BackupManifest>;
  if (x.app !== BACKUP_APP) errors.push('这不是智能衣橱的备份文件');
  if (typeof x.version !== 'number' || x.version > BACKUP_VERSION) errors.push('备份文件版本过新，请先更新应用');
  if (!Array.isArray(x.items)) errors.push('缺少单品数据');
  if (!Array.isArray(x.records)) errors.push('缺少穿搭记录数据');
  if (!Array.isArray(x.outfits)) errors.push('缺少套装数据');
  if (!x.images || typeof x.images !== 'object') errors.push('缺少图片索引');
  if (errors.length) return errors;
  const imageIds = new Set(Object.keys(x.images!));
  const missing = collectImageIds(x.items!, x.records!).filter((id) => !imageIds.has(id));
  if (missing.length) errors.push(`有 ${missing.length} 张图片在备份中缺失`);
  return errors;
}
