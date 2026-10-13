// 自动去背流水线：按颜色去背 → 智能去背 → 补回和背景同色的衣服部分 → 去掉衣架，
// 一张照片拍好几件时再拆成一件一件，并为每件取色、按轮廓猜类别。
// 录入页按步骤调用其中的函数（方便用户调整），批量录入直接调用 autoCut + finishPiece。
// 全部是纯函数。

import {
  alphaBBox,
  applyMaskAndCrop,
  estimateBackground,
  removeBackground,
  suggestThreshold,
  toLabBuffer,
  type BackgroundEstimate,
  type BBox,
  type RGBAImage,
} from './background';
import { deltaE, extractColors, rgbToLab, suggestColors, type ColorSuggestion, type Lab } from './color';
import { fillGarmentGaps, type GapResult } from './gaps';
import { guessCategory, type CategoryGuess } from './guess';
import { binarize, erode, maskBox } from './mask';
import { detectHanger, removeMasked, type HangerResult } from './hanger';
import { frameContact, type FrameContact } from './frame';
import { hoodTop } from './hood';
import { alphaOf, uprightPiece } from './orient';
import { splitPieces } from './pieces';
import { smartCut } from './smartcut';

export type CutMode = 'smart' | 'color';

export interface Cleanup {
  gaps: GapResult;
  /** 补回之后的不透明度 */
  filled: Uint8Array;
  hanger: HangerResult;
}

/** 去背后的整理：补回和背景同色的衣服部分，再找衣架（在补回后的结果上找） */
export function cleanupCut(alpha: Uint8Array, img: RGBAImage, options: { hanger?: boolean } = {}): Cleanup {
  const { width: w, height: h } = img;
  const gaps = fillGarmentGaps(alpha, w, h);
  const filled = gaps.addedCount ? withAdded(alpha, gaps.added, w) : alpha;
  const hanger =
    options.hanger === false ? { mask: new Uint8Array(w * h), found: false, pixels: 0 } : detectHanger(filled, img);
  return { gaps, filled, hanger };
}

/** 把补回的像素设为不透明；紧挨着补回处的半透明羽化边也补满，免得留下一道浅缝 */
export function withAdded(alpha: Uint8Array, added: Uint8Array, w?: number): Uint8Array {
  const out = new Uint8Array(alpha);
  for (let i = 0; i < out.length; i++) if (added[i]) out[i] = 255;
  if (!w) return out;
  const n = out.length;
  for (let i = 0; i < n; i++) {
    if (!alpha[i] || added[i] || alpha[i] === 255) continue;
    const x = i % w;
    const near =
      (x > 0 && added[i - 1]) || (x < w - 1 && added[i + 1]) || (i >= w && added[i - w]) || (i < n - w && added[i + w]);
    if (near) out[i] = 255;
  }
  return out;
}

/**
 * 衣服上有没有和背景很接近的颜色（白底拍带白色的衣服）：
 * 补回过东西，或者留下的衣服里有相当一部分颜色和背景几乎一样。
 */
/**
 * 衣服里有多少像素和"衣服周围的背景"颜色几乎一样（ΔE < 10）。
 * 背景取衣服外面一圈（离衣服 1%～4% 尺寸）的中位颜色，不受照片四角暗角的影响；
 * 衣服去掉贴边的两圈像素（边缘和背景混色）。没有这一圈背景时用整张图估计的背景色。
 */
export function nearBackgroundShare(img: RGBAImage, alpha: Uint8Array, bg: BackgroundEstimate): number {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const fg = binarize(alpha);
  const box = maskBox(fg, w, h);
  if (!box.area) return 0;
  const r1 = Math.round(box.size * 0.01) + 2;
  const r2 = Math.max(r1 + 3, Math.round(box.size * 0.04));
  // 从衣服往外按步数算距离，只算到 r2
  const dist = new Int16Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (fg[i]) {
      dist[i] = 0;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const d = dist[i] + 1;
    if (d > r2) continue;
    const x = i % w;
    if (x > 0 && dist[i - 1] < 0) (dist[i - 1] = d), (queue[tail++] = i - 1);
    if (x < w - 1 && dist[i + 1] < 0) (dist[i + 1] = d), (queue[tail++] = i + 1);
    if (i >= w && dist[i - w] < 0) (dist[i - w] = d), (queue[tail++] = i - w);
    if (i < n - w && dist[i + w] < 0) (dist[i + w] = d), (queue[tail++] = i + w);
  }
  const step = Math.max(1, Math.floor(n / 40000));
  const ring: Lab[] = [];
  for (let i = 0; i < n; i += step) {
    if (dist[i] >= r1 && dist[i] <= r2) ring.push(rgbToLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]));
  }
  const med = (k: 0 | 1 | 2) => ring.map((l) => l[k]).sort((a, b) => a - b)[Math.floor(ring.length / 2)];
  const ref: Lab = ring.length >= 20 ? [med(0), med(1), med(2)] : bg.lab;
  const inner = erode(fg, w, h, 2);
  let total = 0;
  let close = 0;
  for (let i = 0; i < n; i += step) {
    if (!inner[i]) continue;
    total++;
    if (deltaE(rgbToLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]), ref) < 10) close++;
  }
  return total ? close / total : 0;
}

export function isLowContrast(img: RGBAImage, alpha: Uint8Array, bg: BackgroundEstimate, gaps?: GapResult): boolean {
  let area = 0;
  for (let i = 0; i < alpha.length; i++) if (alpha[i] > 127) area++;
  if (gaps && gaps.addedCount > area * 0.003) return true;
  return nearBackgroundShare(img, alpha, bg) >= 0.03;
}

export interface AutoCutResult {
  bg: BackgroundEstimate;
  threshold: number;
  /** 按颜色去背的结果（也是智能去背的起点） */
  colorAlpha: Uint8Array;
  /** 去背的原始结果 */
  raw: Uint8Array;
  /** 每一件（一张一件时只有一件）：补回、去衣架之后的不透明度 */
  pieces: Array<{ alpha: Uint8Array; gaps: GapResult; hanger: HangerResult }>;
}

/** 整张照片自动去背；multi 为真时拆成好几件 */
export function autoCut(img: RGBAImage, options: { mode?: CutMode; multi?: boolean; lab?: Float32Array } = {}): AutoCutResult {
  const { width: w, height: h } = img;
  const lab = options.lab ?? toLabBuffer(img);
  const bg = estimateBackground(img, lab);
  const threshold = suggestThreshold(bg);
  const minPieceRatio = options.multi ? 0.002 : 0.03;
  const color = removeBackground(img, { threshold, minPieceRatio }, lab);
  const raw = options.mode === 'color' ? color.alpha : smartCut(img, { init: color.alpha, minPieceRatio }).alpha;
  const parts = options.multi ? splitPieces(raw, w, h).map((p) => p.alpha) : [raw];
  const pieces = parts.map((a) => {
    const c = cleanupCut(a, img, { hanger: !options.multi });
    return { alpha: c.hanger.found ? removeMasked(c.filled, c.hanger.mask) : c.filled, gaps: c.gaps, hanger: c.hanger };
  });
  return { bg, threshold, colorAlpha: color.alpha, raw, pieces };
}

export interface FinishedPiece {
  box: BBox;
  /** 裁到衣物边界、背景透明、已经转正的图 */
  cropped: RGBAImage;
  colors: ColorSuggestion | null;
  guess: CategoryGuess | null;
  lowContrast: boolean;
  /** 转正时顺时针转了多少度 */
  angle: number;
  /** 连帽上衣：帽子占贴图高度的比例（没有帽子为 0） */
  hood: number;
  /** 衣服碰到的照片边缘 */
  frame: FrameContact;
}

/** 一件的收尾：裁切、取色、转正、猜类别、量帽子、判断是否和背景太接近、有没有碰到照片边缘 */
export function finishPiece(img: RGBAImage, alpha: Uint8Array, bg: BackgroundEstimate, gaps?: GapResult): FinishedPiece | null {
  const box = alphaBBox(alpha, img.width, img.height);
  if (!box || box.width < 8 || box.height < 8) return null;
  const raw = applyMaskAndCrop(img, alpha, box);
  const colors = suggestColors(extractColors(raw.data, 4));
  const up = uprightPiece(raw);
  const cropped = up.image;
  const upAlpha = alphaOf(cropped);
  const hood = hoodTop(upAlpha, cropped.width, cropped.height);
  // 猜类别时不看摊开的帽子（帽子会让上半部分显得比衣身窄，认不出袖子）
  let shape = upAlpha;
  if (hood > 0) {
    shape = new Uint8Array(upAlpha);
    shape.fill(0, 0, Math.round(cropped.height * hood) * cropped.width);
  }
  const guess = guessCategory(shape, cropped.width, cropped.height, colors?.primary.hex);
  return {
    box,
    cropped,
    colors,
    guess,
    lowContrast: isLowContrast(img, alpha, bg, gaps),
    angle: up.angle,
    hood,
    frame: frameContact(img, alpha),
  };
}
