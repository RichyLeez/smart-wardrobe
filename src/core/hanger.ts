// 识别衣架：挂着拍的衣服，去背后衣架常常和衣服连在一起被留下来。
// 衣架的特点是"细"：挂钩是冒出领口上方的一根细线，横杆两端是伸出肩膀外的细条。
// 做法：
//   1. 对前景做形态学开运算（先腐蚀再膨胀），细于一定宽度的部分会消失，剩下的最大块是衣身；
//   2. 前景减去开运算结果得到"细的部分"，按连通块逐个判断：
//      - 挂钩：大部分像素在衣身上沿以上，位置靠近衣身中线；
//      - 横杆：在肩部高度、大部分像素在衣身左右轮廓以外，横向细长，颜色和衣身明显不同。
//   3. 横杆贴着斜肩露出的窄条和衣服连成一片，从认出的衣架像素出发按颜色向外扩展把它带走。
//   吊带、细肩带通常在两侧且和衣服同色，不会被当成衣架。
// 全部是纯函数。

import type { RGBAImage } from './background';
import { deltaE, rgbToLab, type Lab } from './color';
import { components, morph } from './mask';

export interface HangerResult {
  /** 1 表示衣架像素 */
  mask: Uint8Array;
  found: boolean;
  pixels: number;
}

export function detectHanger(alpha: Uint8Array, img: RGBAImage): HangerResult {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const empty = { mask: new Uint8Array(n), found: false, pixels: 0 };
  const fg = new Uint8Array(n);
  let minX = w;
  let maxX = -1;
  for (let i = 0; i < n; i++) {
    if (alpha[i] > 127) {
      fg[i] = 1;
      const x = i % w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  if (maxX < 0) return empty;
  const r = Math.max(2, Math.round((maxX - minX + 1) * 0.018));
  const opened = morph(morph(fg, w, h, r, true), w, h, r, false);

  // 衣身：开运算后的最大连通块（以及面积不小于它 20% 的块，例如两只鞋）
  const { labels: bl, count: bc } = components(opened, w, h, true);
  if (bc === 0) return empty;
  const areas = new Array(bc + 1).fill(0);
  for (let i = 0; i < n; i++) if (bl[i]) areas[bl[i]]++;
  const largest = Math.max(...areas);
  const body = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (bl[i] && areas[bl[i]] >= largest * 0.2) body[i] = 1;

  // 衣身轮廓：每列最上沿、每行左右范围
  const topY = new Int32Array(w).fill(h);
  const rowMin = new Int32Array(h).fill(w);
  const rowMax = new Int32Array(h).fill(-1);
  let by0 = h;
  let by1 = -1;
  let bx0 = w;
  let bx1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!body[y * w + x]) continue;
      if (y < topY[x]) topY[x] = y;
      if (x < rowMin[y]) rowMin[y] = x;
      if (x > rowMax[y]) rowMax[y] = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
    }
  }
  if (by1 < 0) return empty;
  const bw = bx1 - bx0 + 1;
  const bh = by1 - by0 + 1;
  const bcx = (bx0 + bx1) / 2;

  // 衣身的代表颜色（取样中位数）
  const labs: Lab[] = [];
  const step = Math.max(1, Math.floor(n / 4000));
  for (let i = 0; i < n; i += step) if (body[i]) labs.push(rgbToLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]));
  const med = (k: 0 | 1 | 2) => labs.map((l) => l[k]).sort((a, b) => a - b)[Math.floor(labs.length / 2)] ?? 50;
  const bodyLab: Lab = [med(0), med(1), med(2)];

  // 细的部分
  const thin = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (fg[i] && !body[i]) thin[i] = 1;
  const { labels, count } = components(thin, w, h, true);
  const stats = Array.from({ length: count + 1 }, () => ({
    n: 0,
    above: 0,
    side: 0,
    sx: 0,
    x0: w,
    x1: -1,
    y0: h,
    y1: -1,
    L: 0,
    a: 0,
    b: 0,
  }));
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (!l) continue;
    const x = i % w;
    const y = (i - x) / w;
    const s = stats[l];
    s.n++;
    s.sx += x;
    if (x < s.x0) s.x0 = x;
    if (x > s.x1) s.x1 = x;
    if (y < s.y0) s.y0 = y;
    if (y > s.y1) s.y1 = y;
    if (y < topY[x] - 1) s.above++;
    if (rowMax[y] >= 0 && (x < rowMin[y] - 1 || x > rowMax[y] + 1)) s.side++;
    const lab = rgbToLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    s.L += lab[0];
    s.a += lab[1];
    s.b += lab[2];
  }

  const mask = new Uint8Array(n);
  let found = false;
  const isHanger = new Uint8Array(count + 1);
  for (let l = 1; l <= count; l++) {
    const s = stats[l];
    if (s.n < 6) continue;
    const cxl = s.sx / s.n;
    const color: Lab = [s.L / s.n, s.a / s.n, s.b / s.n];
    const differs = deltaE(color, bodyLab) > 15;
    const height = s.y1 - s.y0 + 1;
    const width = s.x1 - s.x0 + 1;
    // 挂钩：冒出衣身上沿，靠近中线，有一定高度
    const hook = s.above >= s.n * 0.5 && Math.abs(cxl - bcx) < bw * 0.2 && height >= bh * 0.03 && s.y1 <= by0 + bh * 0.2;
    // 横杆两端：在肩部高度伸出衣身两侧，横向细长，颜色不同
    const bar = s.side >= s.n * 0.6 && s.y0 <= by0 + bh * 0.3 && width >= height * 2 && differs;
    // 1 挂钩，2 横杆
    if (hook || bar) {
      isHanger[l] = bar ? 2 : 1;
      found = true;
    }
  }
  if (!found) return empty;
  let pixels = 0;
  // 横杆像素记下它所在连通块的平均颜色，用于下面沿颜色扩展（挂钩不扩展，免得碰到领子）
  const seedLab = new Map<number, Lab>();
  for (let l = 1; l <= count; l++) {
    const s = stats[l];
    if (isHanger[l] === 2) seedLab.set(l, [s.L / s.n, s.a / s.n, s.b / s.n]);
  }
  const owner = new Int32Array(n);
  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (isHanger[labels[i]] && labels[i]) {
      mask[i] = 1;
      owner[i] = labels[i];
      if (isHanger[labels[i]] === 2) queue.push(i);
      pixels++;
    }
  }

  // 横杆贴着斜肩露出的一窄条：开运算会把它算进衣身（它和衣服连成一片）。
  // 从已认出的衣架像素出发，沿"颜色像衣架、不像衣服"的像素扩展，只在肩部高度、离每列最上沿不远的范围里。
  const colTop = new Int32Array(w).fill(h);
  for (let i = 0; i < n; i++) {
    if (!fg[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    if (y < colTop[x]) colTop[x] = y;
  }
  const yLimit = by0 + bh * 0.3;
  const depth = 2 * r + 2;
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    const x = i % w;
    const y = (i - x) / w;
    const ref = seedLab.get(owner[i])!;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) {
      if (j < 0 || mask[j] || !fg[j]) continue;
      const jx = j % w;
      const jy = (j - jx) / w;
      if (jy > yLimit || jy - colTop[jx] > depth) continue;
      const lab = rgbToLab(data[j * 4], data[j * 4 + 1], data[j * 4 + 2]);
      if (deltaE(lab, ref) >= 14 || deltaE(lab, bodyLab) <= 20) continue;
      mask[j] = 1;
      owner[j] = owner[i];
      queue.push(j);
      pixels++;
    }
  }
  // 向外扩 3 像素，带走半透明的边（羽化后的光晕也会撑大裁切范围），但不碰衣身
  const grown = morph(mask, w, h, 3, false);
  for (let i = 0; i < n; i++) {
    if (grown[i] && !body[i] && alpha[i] > 0 && !mask[i]) {
      mask[i] = 1;
      pixels++;
    }
  }
  return { mask, found, pixels };
}

/** 把衣架像素设为透明 */
export function removeMasked(alpha: Uint8Array, mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(alpha);
  for (let i = 0; i < out.length; i++) if (mask[i]) out[i] = 0;
  return out;
}
