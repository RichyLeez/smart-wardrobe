// 智能去背：在"按颜色去背"（background.ts）的基础上，用颜色模型 + 图割重新分割，
// 适合背景不纯（花纹床单、地板缝、杂物）或衣物颜色接近背景的照片。
//
// 思路（与 GrabCut 相同）：
//   1. 图片四周一圈一定是背景；手动"擦除"的地方一定是背景，"恢复"的地方一定是衣物；
//      其余像素先按颜色去背的结果分成衣物 / 背景。
//   2. 分别用 5 个高斯分布拟合衣物和背景的颜色。
//   3. 每个像素按两种颜色模型的可能性打分，相邻像素颜色越接近越倾向于同一类，
//      用最大流求出总代价最小的分割。重复 2、3 几次。
//   4. 在缩小的图上计算，放大回原尺寸后，在边界附近逐像素按颜色模型重新判断，边缘更贴合。
// 全部是纯函数，不依赖浏览器。

import { featherMask, keepMainComponents, type RGBAImage } from './background';
import { GridMaxflow } from './maxflow';

export interface SmartCutOptions {
  /** 初始蒙版（0~255），通常是按颜色去背的结果；没有时假设衣物在画面中央 */
  init?: Uint8Array;
  /** 手动笔刷：0 未标记，1 擦除（一定是背景），2 恢复（一定是衣物）；与图片同尺寸 */
  strokes?: Uint8Array;
  /** 颜色模型与分割交替的次数 */
  iterations?: number;
  /** 计算分割时图片缩小到的最长边 */
  maxSide?: number;
  /** 边缘羽化半径（像素） */
  feather?: number;
  /** 只保留面积不小于最大一块这个比例的前景块；一张照片拍好几件时调小，避免把袜子这类小件当碎块去掉 */
  minPieceRatio?: number;
}

export interface SmartCutResult {
  alpha: Uint8Array;
  coverage: number;
}

// ---------- 高斯混合颜色模型 ----------

interface Gaussian {
  mean: [number, number, number];
  /** 协方差矩阵的逆，按行存放 */
  inv: number[];
  /** log(权重) - 0.5·log(det) - 1.5·log(2π) */
  logNorm: number;
}

export interface ColorModel {
  parts: Gaussian[];
}

const LOG_2PI_15 = 1.5 * Math.log(2 * Math.PI);
/** 协方差对角线上的正则项，避免纯色区域方差为 0 */
const COV_REG = 6;

function invert3(m: number[]): { inv: number[]; det: number } {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const k = 1 / det;
  return {
    det,
    inv: [
      A * k,
      -(b * i - c * h) * k,
      (b * f - c * e) * k,
      B * k,
      (a * i - c * g) * k,
      -(a * f - c * d) * k,
      C * k,
      -(a * h - b * g) * k,
      (a * e - b * d) * k,
    ],
  };
}

/** 用 k-means 分组后拟合高斯混合模型。samples 为 rgb 连续存放 */
export function fitColorModel(samples: Float32Array, count: number, k = 5): ColorModel {
  if (count === 0) return { parts: [] };
  // 样本太多时等间隔抽取，控制计算量
  const step = Math.max(1, Math.floor(count / 12000));
  const m = Math.floor((count - 1) / step) + 1;
  const pts = new Float32Array(m * 3);
  for (let s = 0, t = 0; s < count && t < m; s += step, t++) {
    pts[t * 3] = samples[s * 3];
    pts[t * 3 + 1] = samples[s * 3 + 1];
    pts[t * 3 + 2] = samples[s * 3 + 2];
  }
  const K = Math.max(1, Math.min(k, Math.floor(m / 8)));
  // 按亮度分位数初始化中心，结果稳定可复现
  const lum = new Float32Array(m);
  for (let p = 0; p < m; p++) lum[p] = pts[p * 3] + pts[p * 3 + 1] + pts[p * 3 + 2];
  const order = Array.from({ length: m }, (_, i) => i).sort((x, y) => lum[x] - lum[y]);
  const centers = new Float64Array(K * 3);
  for (let c = 0; c < K; c++) {
    const idx = order[Math.min(m - 1, Math.floor(((c + 0.5) / K) * m))];
    centers[c * 3] = pts[idx * 3];
    centers[c * 3 + 1] = pts[idx * 3 + 1];
    centers[c * 3 + 2] = pts[idx * 3 + 2];
  }
  const assign = new Uint8Array(m);
  for (let iter = 0; iter < 5; iter++) {
    const sum = new Float64Array(K * 3);
    const cnt = new Float64Array(K);
    for (let p = 0; p < m; p++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < K; c++) {
        const dr = pts[p * 3] - centers[c * 3];
        const dg = pts[p * 3 + 1] - centers[c * 3 + 1];
        const db = pts[p * 3 + 2] - centers[c * 3 + 2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      assign[p] = best;
      sum[best * 3] += pts[p * 3];
      sum[best * 3 + 1] += pts[p * 3 + 1];
      sum[best * 3 + 2] += pts[p * 3 + 2];
      cnt[best]++;
    }
    for (let c = 0; c < K; c++) {
      if (cnt[c] === 0) continue;
      centers[c * 3] = sum[c * 3] / cnt[c];
      centers[c * 3 + 1] = sum[c * 3 + 1] / cnt[c];
      centers[c * 3 + 2] = sum[c * 3 + 2] / cnt[c];
    }
  }
  // 每组的均值和协方差
  const parts: Gaussian[] = [];
  for (let c = 0; c < K; c++) {
    let n = 0;
    const mean = [0, 0, 0];
    for (let p = 0; p < m; p++) {
      if (assign[p] !== c) continue;
      n++;
      mean[0] += pts[p * 3];
      mean[1] += pts[p * 3 + 1];
      mean[2] += pts[p * 3 + 2];
    }
    if (n === 0) continue;
    mean[0] /= n;
    mean[1] /= n;
    mean[2] /= n;
    const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let p = 0; p < m; p++) {
      if (assign[p] !== c) continue;
      const v = [pts[p * 3] - mean[0], pts[p * 3 + 1] - mean[1], pts[p * 3 + 2] - mean[2]];
      for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) cov[r * 3 + q] += v[r] * v[q];
    }
    for (let r = 0; r < 9; r++) cov[r] /= n;
    cov[0] += COV_REG;
    cov[4] += COV_REG;
    cov[8] += COV_REG;
    const { inv, det } = invert3(cov);
    if (!(det > 0)) continue;
    parts.push({
      mean: [mean[0], mean[1], mean[2]],
      inv,
      logNorm: Math.log(n / m) - 0.5 * Math.log(det) - LOG_2PI_15,
    });
  }
  return { parts };
}

/** 颜色属于该模型的负对数可能性（越小越像） */
const logBuf = new Float64Array(16);

export function colorCost(model: ColorModel, r: number, g: number, b: number): number {
  const parts = model.parts;
  const k = parts.length;
  if (k === 0) return 60;
  let best = -Infinity;
  for (let c = 0; c < k; c++) {
    const p = parts[c];
    const x = r - p.mean[0];
    const y = g - p.mean[1];
    const z = b - p.mean[2];
    const iv = p.inv;
    const md = x * (iv[0] * x + iv[1] * y + iv[2] * z) + y * (iv[3] * x + iv[4] * y + iv[5] * z) + z * (iv[6] * x + iv[7] * y + iv[8] * z);
    const l = p.logNorm - 0.5 * md;
    logBuf[c] = l;
    if (l > best) best = l;
  }
  let s = 0;
  for (let c = 0; c < k; c++) s += Math.exp(logBuf[c] - best);
  return Math.min(200, -(best + Math.log(s)));
}

// ---------- 缩放 ----------

interface Small {
  w: number;
  h: number;
  /** rgb，连续存放 */
  rgb: Float32Array;
  /** 0~1，衣物比例 */
  init: Float32Array;
  /** 0 未标记，1 背景，2 衣物 */
  strokes: Uint8Array;
  scale: number;
}

function downscale(img: RGBAImage, maxSide: number, init: Uint8Array | undefined, strokes: Uint8Array | undefined): Small {
  const { width: W, height: H, data } = img;
  const scale = Math.min(1, maxSide / Math.max(W, H));
  const w = Math.max(8, Math.round(W * scale));
  const h = Math.max(8, Math.round(H * scale));
  const n = w * h;
  const rgb = new Float32Array(n * 3);
  const fg = new Float32Array(n);
  const cnt = new Float32Array(n);
  const s1 = new Float32Array(n);
  const s2 = new Float32Array(n);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / H));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / W));
      const si = sy * w + sx;
      const i = y * W + x;
      rgb[si * 3] += data[i * 4];
      rgb[si * 3 + 1] += data[i * 4 + 1];
      rgb[si * 3 + 2] += data[i * 4 + 2];
      cnt[si]++;
      if (init) fg[si] += init[i] / 255;
      if (strokes) {
        if (strokes[i] === 1) s1[si]++;
        else if (strokes[i] === 2) s2[si]++;
      }
    }
  }
  const st = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = cnt[i] || 1;
    rgb[i * 3] /= c;
    rgb[i * 3 + 1] /= c;
    rgb[i * 3 + 2] /= c;
    fg[i] = init ? fg[i] / c : NaN;
    if (s2[i] > 0 && s2[i] >= s1[i]) st[i] = 2;
    else if (s1[i] > 0) st[i] = 1;
  }
  return { w, h, rgb, init: fg, strokes: st, scale: w / W };
}

// ---------- 主流程 ----------

const COST_SCALE = 64;
const HARD = 1e9;
const GAMMA = 50;

/** 相邻像素的平滑权重：颜色越接近，越不该被切开 */
function smoothWeights(s: Small): { right: Float32Array; down: Float32Array } {
  const { w, h, rgb } = s;
  const n = w * h;
  const right = new Float32Array(n);
  const down = new Float32Array(n);
  let sum = 0;
  let cnt = 0;
  const diff2 = (i: number, j: number) => {
    const a = rgb[i * 3] - rgb[j * 3];
    const b = rgb[i * 3 + 1] - rgb[j * 3 + 1];
    const c = rgb[i * 3 + 2] - rgb[j * 3 + 2];
    return a * a + b * b + c * c;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x + 1 < w) {
        right[i] = diff2(i, i + 1);
        sum += right[i];
        cnt++;
      }
      if (y + 1 < h) {
        down[i] = diff2(i, i + w);
        sum += down[i];
        cnt++;
      }
    }
  }
  const beta = sum > 0 ? cnt / (2 * sum) : 0;
  for (let i = 0; i < n; i++) {
    right[i] = GAMMA * Math.exp(-beta * right[i]);
    down[i] = GAMMA * Math.exp(-beta * down[i]);
  }
  return { right, down };
}

/** 0 = 未定，1 = 一定是背景，2 = 一定是衣物 */
function hardLabels(s: Small): Uint8Array {
  const { w, h, strokes } = s;
  const hard = new Uint8Array(w * h);
  const band = Math.max(1, Math.round(Math.min(w, h) * 0.012));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (strokes[i] === 2) hard[i] = 2;
      else if (strokes[i] === 1) hard[i] = 1;
      else if (x < band || y < band || x >= w - band || y >= h - band) hard[i] = 1;
    }
  }
  return hard;
}

/** 去掉贴着画面边缘的前景块：衣物拍摄时四周留白，贴边的大多是地毯、家具这类背景 */
function dropBorderComponents(fg: Uint8Array, w: number, h: number, band: number): void {
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const onEdge = x <= band || y <= band || x >= w - 1 - band || y >= h - 1 - band;
      const s0 = y * w + x;
      if (!onEdge || !fg[s0] || seen[s0]) continue;
      let top = 0;
      stack[top++] = s0;
      seen[s0] = 1;
      while (top > 0) {
        const i = stack[--top];
        fg[i] = 0;
        const ix = i % w;
        const visit = (j: number) => {
          if (fg[j] && !seen[j]) {
            seen[j] = 1;
            stack[top++] = j;
          }
        };
        if (ix > 0) visit(i - 1);
        if (ix < w - 1) visit(i + 1);
        if (i >= w) visit(i - w);
        if (i < n - w) visit(i + w);
      }
    }
  }
}

/**
 * 从笔刷出发，沿颜色相近的相邻像素扩展（类似魔棒），得到"用户想标记的那一整块"。
 * 只用于初始分组，最终边界仍由图割决定。
 */
function growFromStrokes(s: Small, value: 1 | 2): Uint8Array {
  const { w, h, rgb, strokes } = s;
  const n = w * h;
  const out = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  const mean = [0, 0, 0];
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    if (strokes[i] !== value) continue;
    out[i] = 1;
    stack[top++] = i;
    mean[0] += rgb[i * 3];
    mean[1] += rgb[i * 3 + 1];
    mean[2] += rgb[i * 3 + 2];
    cnt++;
  }
  if (cnt === 0) return out;
  mean[0] /= cnt;
  mean[1] /= cnt;
  mean[2] /= cnt;
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    if (strokes[i] !== value) continue;
    varSum += (rgb[i * 3] - mean[0]) ** 2 + (rgb[i * 3 + 1] - mean[1]) ** 2 + (rgb[i * 3 + 2] - mean[2]) ** 2;
  }
  const reach = Math.max(26, 2.5 * Math.sqrt(varSum / cnt));
  const dist = (i: number, j: number) =>
    Math.hypot(rgb[i * 3] - rgb[j * 3], rgb[i * 3 + 1] - rgb[j * 3 + 1], rgb[i * 3 + 2] - rgb[j * 3 + 2]);
  const toMean = (j: number) => Math.hypot(rgb[j * 3] - mean[0], rgb[j * 3 + 1] - mean[1], rgb[j * 3 + 2] - mean[2]);
  while (top > 0) {
    const i = stack[--top];
    const x = i % w;
    const visit = (j: number) => {
      if (out[j] || strokes[j] === (value === 1 ? 2 : 1)) return;
      if (dist(i, j) < 18 && toMean(j) < reach) {
        out[j] = 1;
        stack[top++] = j;
      }
    };
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (i >= w) visit(i - w);
    if (i < n - w) visit(i + w);
  }
  return out;
}

function initialLabels(s: Small, hard: Uint8Array): Uint8Array {
  const { w, h, init } = s;
  const n = w * h;
  const band = Math.max(1, Math.round(Math.min(w, h) * 0.012));
  const fg = new Uint8Array(n);
  let count = 0;
  const hasInit = !Number.isNaN(init[0]);
  if (hasInit) {
    for (let i = 0; i < n; i++) if (init[i] > 0.5) fg[i] = 1;
    dropBorderComponents(fg, w, h, band);
    for (let i = 0; i < n; i++) count += fg[i];
  }
  // 没有初始蒙版，或初始结果几乎全空 / 全满时，假设衣物在画面中央
  if (!hasInit || count < n * 0.02 || count > n * 0.95) {
    fg.fill(0);
    const ix = Math.round(w * 0.1);
    const iy = Math.round(h * 0.1);
    for (let y = iy; y < h - iy; y++) for (let x = ix; x < w - ix; x++) fg[y * w + x] = 1;
  }
  // 笔刷：擦除的那一块颜色整体先算背景，恢复的那一块整体先算衣物
  const erased = growFromStrokes(s, 1);
  const restored = growFromStrokes(s, 2);
  for (let i = 0; i < n; i++) {
    if (erased[i]) fg[i] = 0;
    if (restored[i]) fg[i] = 1;
    if (hard[i] === 1) fg[i] = 0;
    else if (hard[i] === 2) fg[i] = 1;
  }
  return fg;
}

function modelsFrom(s: Small, labels: Uint8Array): { fg: ColorModel; bg: ColorModel } {
  const n = s.w * s.h;
  let nf = 0;
  for (let i = 0; i < n; i++) nf += labels[i];
  const fgS = new Float32Array(Math.max(1, nf) * 3);
  const bgS = new Float32Array(Math.max(1, n - nf) * 3);
  let a = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    const t = labels[i] ? fgS : bgS;
    const k = labels[i] ? a++ : b++;
    t[k * 3] = s.rgb[i * 3];
    t[k * 3 + 1] = s.rgb[i * 3 + 1];
    t[k * 3 + 2] = s.rgb[i * 3 + 2];
  }
  return { fg: fitColorModel(fgS, a), bg: fitColorModel(bgS, b) };
}

function cutOnce(s: Small, hard: Uint8Array, labels: Uint8Array, weights: { right: Float32Array; down: Float32Array }): Uint8Array {
  const { w, h, rgb } = s;
  const n = w * h;
  const { fg, bg } = modelsFrom(s, labels);
  const graph = new GridMaxflow(w, h);
  for (let i = 0; i < n; i++) {
    if (hard[i] === 1) graph.setTerminal(i, 0, HARD);
    else if (hard[i] === 2) graph.setTerminal(i, HARD, 0);
    else {
      const r = rgb[i * 3];
      const g = rgb[i * 3 + 1];
      const b = rgb[i * 3 + 2];
      // 选衣物要付出"不像衣物"的代价，所以连向背景端的容量是衣物代价
      const costFg = colorCost(fg, r, g, b);
      const costBg = colorCost(bg, r, g, b);
      graph.setTerminal(i, Math.round(costBg * COST_SCALE), Math.round(costFg * COST_SCALE));
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x + 1 < w) graph.setEdge(i, 0, Math.round(weights.right[i] * COST_SCALE));
      if (y + 1 < h) graph.setEdge(i, 2, Math.round(weights.down[i] * COST_SCALE));
    }
  }
  graph.maxflow();
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = graph.isSource(i) ? 1 : 0;
  return out;
}

/** 被衣物包围的小块背景（印花、褶皱阴影被误判）填回衣物 */
function fillSmallHoles(fg: Uint8Array, width: number, height: number, maxArea: number): void {
  const n = width * height;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const comp: number[] = [];
  for (let s = 0; s < n; s++) {
    if (fg[s] || seen[s]) continue;
    let top = 0;
    stack[top++] = s;
    seen[s] = 1;
    comp.length = 0;
    let touchesBorder = false;
    while (top > 0) {
      const i = stack[--top];
      comp.push(i);
      const x = i % width;
      const y = (i - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
      const visit = (j: number) => {
        if (!fg[j] && !seen[j]) {
          seen[j] = 1;
          stack[top++] = j;
        }
      };
      if (x > 0) visit(i - 1);
      if (x < width - 1) visit(i + 1);
      if (y > 0) visit(i - width);
      if (y < height - 1) visit(i + width);
    }
    if (!touchesBorder && comp.length <= maxArea) for (const i of comp) fg[i] = 1;
  }
}

/** 智能去背，返回与原图同尺寸的不透明度 */
export function smartCut(img: RGBAImage, options: SmartCutOptions = {}): SmartCutResult {
  const { width: W, height: H, data } = img;
  const N = W * H;
  const small = downscale(img, options.maxSide ?? 320, options.init, options.strokes);
  const hard = hardLabels(small);
  let labels = initialLabels(small, hard);
  const weights = smoothWeights(small);
  const iterations = Math.max(1, options.iterations ?? 3);
  for (let it = 0; it < iterations; it++) labels = cutOnce(small, hard, labels, weights);

  // 放大回原尺寸：远离边界的像素直接沿用，边界附近按颜色模型逐像素判断
  const { fg: fgModel, bg: bgModel } = modelsFrom(small, labels);
  const { w, h } = small;
  const fg = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    const fy = Math.max(0, Math.min(h - 1, ((y + 0.5) * h) / H - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(h - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.max(0, Math.min(w - 1, ((x + 0.5) * w) / W - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(w - 1, x0 + 1);
      const tx = fx - x0;
      const p =
        (labels[y0 * w + x0] * (1 - tx) + labels[y0 * w + x1] * tx) * (1 - ty) +
        (labels[y1 * w + x0] * (1 - tx) + labels[y1 * w + x1] * tx) * ty;
      const i = y * W + x;
      if (p <= 0.02) fg[i] = 0;
      else if (p >= 0.98) fg[i] = 1;
      else {
        const r = data[i * 4];
        const g = data[i * 4 + 1];
        const b = data[i * 4 + 2];
        const margin = colorCost(bgModel, r, g, b) - colorCost(fgModel, r, g, b);
        fg[i] = margin + 6 * (p - 0.5) > 0 ? 1 : 0;
      }
    }
  }
  const strokes = options.strokes;
  const applyStrokes = () => {
    if (!strokes) return;
    for (let i = 0; i < N; i++) {
      if (strokes[i] === 1) fg[i] = 0;
      else if (strokes[i] === 2) fg[i] = 1;
    }
  };
  applyStrokes();
  fillSmallHoles(fg, W, H, N * 0.002);
  keepMainComponents(fg, W, H, options.minPieceRatio ?? 0.03);
  applyStrokes();
  let count = 0;
  for (let i = 0; i < N; i++) count += fg[i];
  return { alpha: featherMask(fg, W, H, options.feather ?? 1), coverage: count / N };
}
