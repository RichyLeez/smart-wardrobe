// 本地去背：适合在纯色、无纹理、与衣物反差明显的背景上拍摄的照片。
// 思路：用图片四周估计背景色 → 从边缘出发做连通区域生长 → 去掉小碎块 → 羽化边缘。
// 全部是纯函数，输入输出都是像素数组，方便测试和移植。

import { rgbToLab, deltaE, type Lab } from './color';

export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface BackgroundEstimate {
  lab: Lab;
  rgb: [number, number, number];
  /** 边缘像素到估计背景色的中位色差，越大说明背景越不均匀 */
  spread: number;
}

export interface RemovalOptions {
  /** 与背景色的色差阈值（ΔE），常用 10~40 */
  threshold: number;
  /** 去除被衣物包围、但颜色与背景一致的区域（如包带中间的空隙） */
  removeHoles?: boolean;
  /** 边缘羽化半径（像素） */
  feather?: number;
}

export interface RemovalResult {
  /** 每个像素的不透明度 0~255 */
  alpha: Uint8Array;
  background: BackgroundEstimate;
  /** 前景占整张图的比例 */
  coverage: number;
}

/** 预先把整张图转换为 Lab，后续调阈值时可以复用 */
export function toLabBuffer(img: RGBAImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n * 3);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    const lab = rgbToLab(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    out[i * 3] = lab[0];
    out[i * 3 + 1] = lab[1];
    out[i * 3 + 2] = lab[2];
  }
  return out;
}

function borderIndices(width: number, height: number): number[] {
  const band = Math.max(2, Math.round(Math.min(width, height) * 0.02));
  const idx: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x < band || y < band || x >= width - band || y >= height - band) idx.push(y * width + x);
    }
  }
  return idx;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function estimateBackground(img: RGBAImage, lab?: Float32Array): BackgroundEstimate {
  const labBuf = lab ?? toLabBuffer(img);
  const idx = borderIndices(img.width, img.height);
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (const i of idx) {
    rs.push(img.data[i * 4]);
    gs.push(img.data[i * 4 + 1]);
    bs.push(img.data[i * 4 + 2]);
  }
  const rgb: [number, number, number] = [median(rs), median(gs), median(bs)];
  const bgLab = rgbToLab(rgb[0], rgb[1], rgb[2]);
  const dists: number[] = [];
  const step = Math.max(1, Math.floor(idx.length / 4000));
  for (let k = 0; k < idx.length; k += step) {
    const i = idx[k];
    dists.push(deltaE([labBuf[i * 3], labBuf[i * 3 + 1], labBuf[i * 3 + 2]], bgLab));
  }
  return { lab: bgLab, rgb, spread: median(dists) };
}

function distAt(lab: Float32Array, i: number, ref: Lab): number {
  const a = lab[i * 3] - ref[0];
  const b = lab[i * 3 + 1] - ref[1];
  const c = lab[i * 3 + 2] - ref[2];
  return Math.sqrt(a * a + b * b + c * c);
}

function distBetween(lab: Float32Array, i: number, j: number): number {
  const a = lab[i * 3] - lab[j * 3];
  const b = lab[i * 3 + 1] - lab[j * 3 + 1];
  const c = lab[i * 3 + 2] - lab[j * 3 + 2];
  return Math.sqrt(a * a + b * b + c * c);
}

/**
 * 计算前景蒙版。
 * 相邻像素满足以下任一条件即视为背景：
 *  1. 与估计背景色的色差小于阈值；
 *  2. 与相邻背景像素非常接近，且与背景色的色差不超过阈值的 1.8 倍（用于跟随阴影和光线渐变）。
 */
export function removeBackground(
  img: RGBAImage,
  options: RemovalOptions,
  labBuffer?: Float32Array,
): RemovalResult {
  const { width, height } = img;
  const n = width * height;
  const lab = labBuffer ?? toLabBuffer(img);
  const bg = estimateBackground(img, lab);
  const t = Math.max(1, options.threshold);
  const localT = t * 0.35;
  const looseT = t * 1.8;

  const isBg = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;

  const seed = (i: number) => {
    if (!isBg[i] && distAt(lab, i, bg.lab) < t) {
      isBg[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < width; x++) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    seed(y * width);
    seed(y * width + width - 1);
  }

  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    const y = (i - x) / width;
    const visit = (j: number) => {
      if (isBg[j]) return;
      const dBg = distAt(lab, j, bg.lab);
      if (dBg < t || (dBg < looseT && distBetween(lab, i, j) < localT)) {
        isBg[j] = 1;
        queue[tail++] = j;
      }
    };
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (y > 0) visit(i - width);
    if (y < height - 1) visit(i + width);
  }

  const fg = new Uint8Array(n);
  for (let i = 0; i < n; i++) fg[i] = isBg[i] ? 0 : 1;

  if (options.removeHoles !== false) removeEnclosedHoles(fg, lab, bg.lab, width, height, t * 0.5, n * 0.003);
  keepMainComponents(fg, width, height, 0.03);

  const alpha = featherMask(fg, width, height, options.feather ?? 1);
  let count = 0;
  for (let i = 0; i < n; i++) if (fg[i]) count++;
  return { alpha, background: bg, coverage: count / n };
}

/** 4 邻域连通区域标记，返回每个像素所属区域编号（0 表示不属于 value 的像素）和各区域面积 */
function labelComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  value: number,
): { labels: Int32Array; areas: number[] } {
  const n = width * height;
  const labels = new Int32Array(n);
  const areas: number[] = [0];
  const stack = new Int32Array(n);
  let next = 1;
  for (let s = 0; s < n; s++) {
    if (mask[s] !== value || labels[s] !== 0) continue;
    let top = 0;
    stack[top++] = s;
    labels[s] = next;
    let area = 0;
    while (top > 0) {
      const i = stack[--top];
      area++;
      const x = i % width;
      const push = (j: number) => {
        if (mask[j] === value && labels[j] === 0) {
          labels[j] = next;
          stack[top++] = j;
        }
      };
      if (x > 0) push(i - 1);
      if (x < width - 1) push(i + 1);
      if (i >= width) push(i - width);
      if (i < n - width) push(i + width);
    }
    areas.push(area);
    next++;
  }
  return { labels, areas };
}

/** 只保留面积不小于最大区域 minRatio 的前景块（一双鞋是两块，都会保留） */
export function keepMainComponents(fg: Uint8Array, width: number, height: number, minRatio: number): void {
  const { labels, areas } = labelComponents(fg, width, height, 1);
  if (areas.length <= 2) return;
  const largest = Math.max(...areas.slice(1));
  const keep = areas.map((a, i) => i > 0 && a >= largest * minRatio);
  for (let i = 0; i < fg.length; i++) if (fg[i] && !keep[labels[i]]) fg[i] = 0;
}

/** 去掉被前景包围、颜色接近背景的较大区域 */
function removeEnclosedHoles(
  fg: Uint8Array,
  lab: Float32Array,
  bgLab: Lab,
  width: number,
  height: number,
  t: number,
  minArea: number,
): void {
  const n = width * height;
  const candidate = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (fg[i] && distAt(lab, i, bgLab) < t) candidate[i] = 1;
  const { labels, areas } = labelComponents(candidate, width, height, 1);
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (l > 0 && areas[l] >= minArea) fg[i] = 0;
  }
}

/** 先向内收缩 1 像素去掉背景色残边，再做盒式模糊得到柔和边缘 */
export function featherMask(fg: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const n = width * height;
  const eroded = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!fg[i]) continue;
      const inside =
        (x === 0 || fg[i - 1]) &&
        (x === width - 1 || fg[i + 1]) &&
        (y === 0 || fg[i - width]) &&
        (y === height - 1 || fg[i + width]);
      eroded[i] = inside ? 1 : 0;
    }
  }
  const out = new Uint8Array(n);
  if (radius <= 0) {
    for (let i = 0; i < n; i++) out[i] = eroded[i] ? 255 : 0;
    return out;
  }
  const r = Math.round(radius);
  // 可分离盒式模糊：先横向再纵向
  const tmp = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += x >= 0 && x < width ? eroded[y * width + x] : 0;
    for (let x = 0; x < width; x++) {
      tmp[y * width + x] = acc;
      const add = x + r + 1;
      const sub = x - r;
      if (add < width) acc += eroded[y * width + add];
      if (sub >= 0) acc -= eroded[y * width + sub];
    }
  }
  const size = (2 * r + 1) * (2 * r + 1);
  for (let x = 0; x < width; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += y >= 0 && y < height ? tmp[y * width + x] : 0;
    for (let y = 0; y < height; y++) {
      out[y * width + x] = Math.round((acc / size) * 255);
      const add = y + r + 1;
      const sub = y - r;
      if (add < height) acc += tmp[add * width + x];
      if (sub >= 0) acc -= tmp[sub * width + x];
    }
  }
  return out;
}

/**
 * 合并自动蒙版和手动笔刷结果。
 * override: 0 = 未修改，1 = 手动擦除（强制透明），2 = 手动恢复（强制不透明）
 */
export function combineMask(auto: Uint8Array, override: Uint8Array): Uint8Array {
  const out = new Uint8Array(auto.length);
  for (let i = 0; i < auto.length; i++) {
    const o = override[i];
    out[i] = o === 1 ? 0 : o === 2 ? 255 : auto[i];
  }
  return out;
}

/** 在 override 数组上画一个圆形笔刷 */
export function paintOverride(
  override: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  value: 1 | 2,
): void {
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(width - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(height - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) override[y * width + x] = value;
    }
  }
}

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 不透明区域的外接矩形，外扩 padding 比例 */
export function alphaBBox(alpha: Uint8Array, width: number, height: number, padding = 0.02): BBox | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * padding);
  const x = Math.max(0, minX - pad);
  const y = Math.max(0, minY - pad);
  return {
    x,
    y,
    width: Math.min(width, maxX + pad + 1) - x,
    height: Math.min(height, maxY + pad + 1) - y,
  };
}

/** 把蒙版写入图像的 alpha 通道并裁切到边界 */
export function applyMaskAndCrop(img: RGBAImage, alpha: Uint8Array, bbox: BBox): RGBAImage {
  const out = new Uint8ClampedArray(bbox.width * bbox.height * 4);
  for (let y = 0; y < bbox.height; y++) {
    for (let x = 0; x < bbox.width; x++) {
      const si = (y + bbox.y) * img.width + (x + bbox.x);
      const di = y * bbox.width + x;
      out[di * 4] = img.data[si * 4];
      out[di * 4 + 1] = img.data[si * 4 + 1];
      out[di * 4 + 2] = img.data[si * 4 + 2];
      out[di * 4 + 3] = Math.min(img.data[si * 4 + 3], alpha[si]);
    }
  }
  return { width: bbox.width, height: bbox.height, data: out };
}

/** 根据背景均匀程度给出建议阈值 */
export function suggestThreshold(bg: BackgroundEstimate): number {
  return Math.round(Math.min(40, Math.max(14, bg.spread * 2.5 + 12)));
}
