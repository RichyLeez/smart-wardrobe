// 浏览器端的图片读写：读取照片、缩放、导出为 Blob。

import type { RGBAImage } from '../core/background';

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  return c;
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('浏览器不支持画布，无法处理图片');
  return ctx;
}

export function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片无法读取，请换一张照片（支持 JPG、PNG、HEIC 转换后的图片）'));
    img.src = src;
  });
}

export interface LoadedPhoto {
  /** 用于处理的缩小版像素 */
  rgba: RGBAImage;
  /** 用于存档的原图（最长边不超过 archiveMax） */
  archive: HTMLCanvasElement;
}

/** 读取用户选择的照片。浏览器会按 EXIF 自动纠正方向。 */
export async function loadPhoto(file: Blob, workMax = 900, archiveMax = 1280): Promise<LoadedPhoto> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(url);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) throw new Error('图片尺寸无效');
    const archiveScale = Math.min(1, archiveMax / Math.max(w, h));
    const archive = createCanvas(w * archiveScale, h * archiveScale);
    ctx2d(archive).drawImage(img, 0, 0, archive.width, archive.height);
    const workScale = Math.min(1, workMax / Math.max(w, h));
    const work = createCanvas(w * workScale, h * workScale);
    const wctx = ctx2d(work);
    wctx.drawImage(img, 0, 0, work.width, work.height);
    const data = wctx.getImageData(0, 0, work.width, work.height).data;
    return { rgba: { width: work.width, height: work.height, data }, archive };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function rgbaToCanvas(img: RGBAImage): HTMLCanvasElement {
  const c = createCanvas(img.width, img.height);
  const data = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  ctx2d(c).putImageData(data, 0, 0);
  return c;
}

/** 等比缩放到最长边不超过 maxSide */
export function scaleCanvas(src: HTMLCanvasElement, maxSide: number): HTMLCanvasElement {
  const s = Math.min(1, maxSide / Math.max(src.width, src.height));
  if (s === 1) return src;
  const c = createCanvas(src.width * s, src.height * s);
  const ctx = ctx2d(c);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

export function canvasToBlob(c: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('图片导出失败'))), type, quality);
  });
}

let webpAlpha: boolean | null = null;

/** 透明图优先用 WebP（体积小），不支持时回退 PNG */
export async function transparentBlob(c: HTMLCanvasElement): Promise<Blob> {
  if (webpAlpha !== false) {
    const b = await canvasToBlob(c, 'image/webp', 0.9);
    webpAlpha = b.type === 'image/webp';
    if (webpAlpha) return b;
  }
  return canvasToBlob(c, 'image/png');
}

export function imageDataOf(c: HTMLCanvasElement): RGBAImage {
  const data = ctx2d(c).getImageData(0, 0, c.width, c.height).data;
  return { width: c.width, height: c.height, data };
}

/** 把 SVG 字符串栅格化为画布（示例衣橱使用） */
export async function svgToCanvas(svg: string, width: number, height: number): Promise<HTMLCanvasElement> {
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  const img = await loadImageElement(url);
  const c = createCanvas(width, height);
  ctx2d(c).drawImage(img, 0, 0, width, height);
  return c;
}

/** 预览：保留区域正常显示，去掉的区域淡淡显示，便于手动擦除 */
export function renderMaskPreview(
  target: HTMLCanvasElement,
  img: RGBAImage,
  alpha: Uint8Array,
  ghost = 0.16,
): void {
  if (target.width !== img.width) target.width = img.width;
  if (target.height !== img.height) target.height = img.height;
  const ctx = ctx2d(target);
  const out = ctx.createImageData(img.width, img.height);
  const src = img.data;
  const dst = out.data;
  const ghostA = Math.round(255 * ghost);
  for (let i = 0; i < alpha.length; i++) {
    const o = i * 4;
    dst[o] = src[o];
    dst[o + 1] = src[o + 1];
    dst[o + 2] = src[o + 2];
    const a = alpha[i];
    dst[o + 3] = Math.max(a, ghostA);
  }
  ctx.putImageData(out, 0, 0);
}
