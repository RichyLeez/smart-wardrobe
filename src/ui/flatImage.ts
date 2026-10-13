// 简化图形：在浏览器里把衣物贴图转成去掉褶皱的插画（core/stylize.ts），结果只缓存在内存里。
// 一次只处理一张，并在每张之间让出主线程，处理期间人台先显示照片。

import { stylizeGarment } from '../core/stylize';
import { createCanvas, loadImageElement, transparentBlob } from './imageTools';

/** 简化图形的虚拟图片 id：flat:原图片 id */
export const FLAT_PREFIX = 'flat:';

export function flatId(id: string): string {
  return FLAT_PREFIX + id;
}

let chain: Promise<unknown> = Promise.resolve();

export function renderFlat(srcUrl: string, maxSide = 320): Promise<Blob> {
  const job = chain.then(async () => {
    await new Promise((r) => setTimeout(r, 0));
    const img = await loadImageElement(srcUrl);
    const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = createCanvas(img.naturalWidth * s, img.naturalHeight * s);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('浏览器不支持画布');
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const src = ctx.getImageData(0, 0, c.width, c.height);
    const { image } = stylizeGarment({ width: c.width, height: c.height, data: src.data });
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
    return transparentBlob(c);
  });
  chain = job.catch(() => undefined);
  return job;
}
