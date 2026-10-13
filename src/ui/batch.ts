// 批量录入：一张照片 → 自动去背（一张一件或拆成几件）→ 取色、猜类别 → 存成待整理的单品。
// 计算在 core/autocut.ts，这里只负责读照片、生成贴图和编码。

import type { BBox } from '../core/background';
import { autoCut, finishPiece } from '../core/autocut';
import { draftPendingItem } from '../core/pending';
import type { Item } from '../core/types';
import { newId } from './ids';
import { canvasToBlob, createCanvas, loadPhoto, rgbaToCanvas, scaleCanvas, transparentBlob } from './imageTools';
import type { NewImage } from './store';

export interface BatchPiece {
  item: Item;
  images: NewImage[];
  /** 缩略图的 data URL，进度列表里显示 */
  preview: string;
}

const tick = () => new Promise((r) => setTimeout(r, 16));

/** 录入时间严格递增，待整理里按拍摄顺序排 */
let lastStamp = 0;
const stamp = () => (lastStamp = Math.max(Date.now(), lastStamp + 1));

/** 存档原图：一张多件时只留这一件附近的部分，避免同一张大图存好几份 */
function cropArchive(archive: HTMLCanvasElement, box: BBox, k: number): HTMLCanvasElement {
  const pad = 0.06;
  const x0 = Math.max(0, (box.x - box.width * pad) * k);
  const y0 = Math.max(0, (box.y - box.height * pad) * k);
  const x1 = Math.min(archive.width, (box.x + box.width * (1 + pad)) * k);
  const y1 = Math.min(archive.height, (box.y + box.height * (1 + pad)) * k);
  const c = createCanvas(x1 - x0, y1 - y0);
  c.getContext('2d')!.drawImage(archive, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height);
  return c;
}

export async function processPhoto(file: Blob, multi: boolean): Promise<BatchPiece[]> {
  const photo = await loadPhoto(file);
  await tick();
  const cut = autoCut(photo.rgba, { multi });
  await tick();
  const k = photo.archive.width / photo.rgba.width;
  const out: BatchPiece[] = [];
  for (const p of cut.pieces) {
    const done = finishPiece(photo.rgba, p.alpha, cut.bg, p.gaps);
    if (!done) continue;
    const cutout = scaleCanvas(rgbaToCanvas(done.cropped), 640);
    const thumb = scaleCanvas(cutout, 280);
    const archive = multi && cut.pieces.length > 1 ? cropArchive(photo.archive, done.box, k) : photo.archive;
    const ids = { cutout: newId('img-'), thumb: newId('img-'), original: newId('img-') };
    const images: NewImage[] = [
      { id: ids.cutout, blob: await transparentBlob(cutout), width: cutout.width, height: cutout.height },
      { id: ids.thumb, blob: await transparentBlob(thumb), width: thumb.width, height: thumb.height },
      { id: ids.original, blob: await canvasToBlob(archive, 'image/jpeg', 0.85), width: archive.width, height: archive.height },
    ];
    const c = done.colors;
    const item = draftPendingItem({
      id: newId('item-'),
      color: c ? { hex: c.primary.hex, name: c.primary.name } : { hex: '#8d8d92', name: '灰色' },
      color2: c?.multiColor && c.secondary ? { hex: c.secondary.hex, name: c.secondary.name } : undefined,
      guess: done.guess,
      images: { cutout: ids.cutout, thumb: ids.thumb, original: ids.original },
      aspect: done.cropped.width / done.cropped.height,
      lowContrast: done.lowContrast,
      now: stamp(),
    });
    out.push({ item, images, preview: scaleCanvas(thumb, 120).toDataURL('image/png') });
    await tick();
  }
  return out;
}
