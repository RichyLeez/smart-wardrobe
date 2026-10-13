// 整库备份：导出为一个 ZIP（manifest.json + images/），导入时整体替换当前数据。

import JSZip from 'jszip';
import {
  BACKUP_APP,
  BACKUP_VERSION,
  collectImageIds,
  validateManifest,
  type BackupManifest,
} from '../core/backup';
import { emptyFeedback } from '../core/recommend';
import type { FeedbackState, Item, Outfit, Settings, WearRecord } from '../core/types';
import * as db from './db';

const EXT: Record<string, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};
const MIME: Record<string, string> = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

export async function exportBackup(onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const [items, outfits, records, settings, feedback] = await Promise.all([
    db.getAll<Item>('items'),
    db.getAll<Outfit>('outfits'),
    db.getAll<WearRecord>('records'),
    db.getKV<Settings>('settings'),
    db.getKV<FeedbackState>('feedback'),
  ]);
  const zip = new JSZip();
  const images: Record<string, string> = {};
  const imageSizes: Record<string, [number, number]> = {};
  const ids = collectImageIds(items, records);
  let n = 0;
  for (const id of ids) {
    const rec = await db.getOne<db.StoredImage>('images', id);
    n++;
    onProgress?.(n, ids.length);
    if (!rec) continue;
    const path = `images/${id}.${EXT[rec.blob.type] ?? 'bin'}`;
    zip.file(path, rec.blob);
    images[id] = path;
    imageSizes[id] = [rec.width, rec.height];
  }
  const manifest: BackupManifest = {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    items,
    outfits,
    records,
    settings: settings ?? { body: null, goals: [], goalsCustomized: false, rotation: true },
    feedback: feedback ?? emptyFeedback(),
    images,
    imageSizes,
  };
  zip.file('manifest.json', JSON.stringify(manifest));
  // 图片本身已压缩，ZIP 不再压缩以节省时间
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}

export interface ImportSummary {
  items: number;
  records: number;
  outfits: number;
}

/** 读取并校验备份；校验通过后返回一个执行导入的函数，便于先让用户确认 */
export async function readBackup(
  file: Blob,
): Promise<{ summary: ImportSummary; apply: (onProgress?: (done: number, total: number) => void) => Promise<void> }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error('无法读取这个文件，请选择智能衣橱导出的 .zip 备份');
  }
  const entry = zip.file('manifest.json');
  if (!entry) throw new Error('备份里缺少 manifest.json，文件可能不完整');
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await entry.async('string'));
  } catch {
    throw new Error('备份清单损坏，无法解析');
  }
  const errors = validateManifest(manifest);
  if (errors.length) throw new Error(errors.join('；'));

  const summary = { items: manifest.items.length, records: manifest.records.length, outfits: manifest.outfits.length };
  const apply = async (onProgress?: (done: number, total: number) => void) => {
    const imageRows: db.StoredImage[] = [];
    for (const [id, path] of Object.entries(manifest.images)) {
      const f = zip.file(path);
      if (!f) continue;
      const raw = await f.async('blob');
      const ext = path.split('.').pop() ?? '';
      const blob = new Blob([raw], { type: MIME[ext] ?? 'application/octet-stream' });
      const size = manifest.imageSizes?.[id] ?? [0, 0];
      imageRows.push({ id, blob, width: size[0], height: size[1] });
    }
    await db.clearAll();
    // 逐张写入，便于显示进度（云端模式下每张图片都要上传）
    for (let i = 0; i < imageRows.length; i++) {
      onProgress?.(i, imageRows.length);
      await db.put('images', imageRows[i]);
    }
    onProgress?.(imageRows.length, imageRows.length);
    await db.putMany('items', manifest.items);
    await db.putMany('outfits', manifest.outfits);
    await db.putMany('records', manifest.records);
    await db.setKV('settings', manifest.settings);
    await db.setKV('feedback', manifest.feedback ?? emptyFeedback());
  };
  return { summary, apply };
}

export function backupFilename(): string {
  const d = new Date();
  const p = (v: number) => String(v).padStart(2, '0');
  return `智能衣橱备份-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.zip`;
}
