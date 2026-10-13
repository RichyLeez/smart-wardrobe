// 3D 人台上的衣物：把平铺照片"包"在人台外面。
//
// 做法：衣物在正面看到的位置和 2D 人台一致（同一个摆放矩形）。在这个范围内建一张网格：
//   1. 每个点的厚度取"对应身体部位向外扩一点"和"照片这一行每段不透明区域的椭圆截面"中的较大值，
//      所以贴身的地方跟着身体，裙摆、阔腿裤有自己的体积；越外层扩得越多。
//   2. 上衣、外套、连衣裙的袖子：平铺时袖子是斜着张开的，这里以肩点为轴把袖子转下来贴着手臂，
//      再按袖子宽度做成包住手臂的圆筒。
//   3. 外层衣物会包住里层衣物（例如大衣罩住裙摆），不会被里层穿出来。
// 前半面贴正面照片，后半面贴背面照片（没有背面照片时用正面照片，并在渲染时模糊细节）。
// 照片透明的地方在渲染时丢弃，所以轮廓始终来自照片。
// 这只是帮助观察配色和层次的示意，不是布料的物理模拟。

import { isSkirtLike } from './catalog';
import { hiddenFromBack, type GarmentRect } from './body';
import { MeshBuilder, envelopeDepth, envelopeExtent, partByName, sweep, type Body3D, type BodyPart, type MeshData, type Section } from './body3d';
import type { Category } from './types';

/** 缩小后的透明度网格（来自换装贴图），按行存放 */
export interface AlphaGrid {
  width: number;
  height: number;
  alpha: Uint8Array;
}

export interface ShellInput {
  category: Category;
  subtype: string;
  /** 正面照片在人台上的位置（正面视角坐标） */
  front: { rect: GarmentRect; mask: AlphaGrid };
  /** 背面照片的位置（背面视角坐标，x 向观察者右手为正）；没有背面照片时省略 */
  back?: { rect: GarmentRect; mask: AlphaGrid };
  /** 第几层，越大越靠外 */
  layer: number;
}

export function sampleAlpha(m: AlphaGrid, u: number, v: number): number {
  if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
  const x = Math.min(m.width - 1, Math.floor(u * m.width));
  const y = Math.min(m.height - 1, Math.floor(v * m.height));
  return m.alpha[y * m.width + x];
}

/** 双线性取样，用来求亚格点精度的边缘位置 */
export function sampleAlphaSmooth(m: AlphaGrid, u: number, v: number): number {
  if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
  const fx = Math.max(0, Math.min(m.width - 1, u * m.width - 0.5));
  const fy = Math.max(0, Math.min(m.height - 1, v * m.height - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(m.width - 1, x0 + 1);
  const y1 = Math.min(m.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = m.alpha;
  const w = m.width;
  return (a[y0 * w + x0] * (1 - tx) + a[y0 * w + x1] * tx) * (1 - ty) + (a[y1 * w + x0] * (1 - tx) + a[y1 * w + x1] * tx) * ty;
}

export function frontUV(rect: GarmentRect, x: number, y: number): [number, number] {
  return [(x - rect.x) / rect.width, (y - rect.y) / rect.height];
}

/** 背面贴图坐标：从身后看，观察者的右手方向是 -x */
export function backUV(rect: GarmentRect, x: number, y: number): [number, number] {
  return [(-x - rect.x) / rect.width, (y - rect.y) / rect.height];
}

/** 每一层向外扩的厚度（cm） */
export function layerOffset(layer: number): number {
  return 0.45 + layer * 0.75;
}

interface ShapeRule {
  /** 包裹的身体部位（袖子另外处理，这里不含手臂） */
  parts: BodyPart[];
  /** 照片里一段宽 2w 的区域，厚度取 k·w */
  k: number;
  /** 厚度上限 */
  cap: number;
}

function hasSleeves(cat: Category): boolean {
  return cat === 'top' || cat === 'outer' || cat === 'dress';
}

function rule(m: Body3D, cat: Category, subtype: string, y: number, off: number): ShapeRule {
  const g = m.g;
  const P = (...names: Parameters<typeof partByName>[1][]) => names.map((n) => partByName(m, n));
  const torso = partByName(m, 'torso');
  const torsoCap = (yy: number) => {
    if (yy < torso.y0 || yy > torso.y1) return 40;
    return torso.section(yy).b * 1.2 + off;
  };
  switch (cat) {
    case 'top':
    case 'outer':
      if (y < g.crotchY) return { parts: P('torso'), k: 0.22, cap: torsoCap(y) };
      return { parts: P('torso', 'legL', 'legR'), k: 0.62, cap: 40 };
    case 'dress':
      if (y < g.hipY) return { parts: P('torso'), k: 0.22, cap: torsoCap(y) };
      return { parts: P('torso', 'legL', 'legR'), k: 0.7, cap: 45 };
    case 'bottom':
      if (isSkirtLike(subtype)) return { parts: P('torso', 'legL', 'legR'), k: y < g.hipY ? 0.22 : 0.7, cap: y < g.hipY ? torsoCap(y) : 45 };
      return { parts: P('torso', 'legL', 'legR'), k: y < g.crotchY ? 0.22 : 0.55, cap: y < g.crotchY ? torsoCap(y) : 30 };
    case 'belt':
      return { parts: P('torso'), k: 0, cap: 0 };
    case 'scarf':
      return { parts: P('torso', 'head'), k: 0.35, cap: 8 };
    case 'hat':
      return { parts: P('head'), k: 0.7, cap: 20 };
    case 'bag':
      return { parts: [], k: 0.28, cap: 9 };
    case 'jewelry':
      return { parts: P('torso', 'head', 'armL', 'armR'), k: 0.25, cap: 3 };
    default:
      return { parts: P('torso'), k: 0.2, cap: 10 };
  }
}

/** 背面条带画到哪一行为止（y 向下）；围巾背面只露出脖子一圈 */
function backLimit(m: Body3D, cat: Category, subtype: string): number {
  if (hiddenFromBack({ category: cat, subtype })) return -Infinity;
  if (cat === 'scarf') return m.g.shoulderY + m.g.height * 0.035;
  return Infinity;
}

// ---------- 里层衣物的厚度图 ----------

/** 按 1cm 格子记录已经穿上的衣物最外层的厚度，外层衣物据此包住里层 */
export class DepthMap {
  private x0 = -80;
  private y0 = -30;
  private w = 160;
  private h: number;
  private z: Float32Array;

  constructor(height: number) {
    this.h = Math.ceil(height + 60);
    this.z = new Float32Array(this.w * this.h);
  }

  private cell(x: number, y: number): number {
    const cx = Math.floor(x - this.x0);
    const cy = Math.floor(y - this.y0);
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return -1;
    return cy * this.w + cx;
  }

  splat(x: number, y: number, z: number): void {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = this.cell(x + dx, y + dy);
        if (c >= 0 && z > this.z[c]) this.z[c] = z;
      }
    }
  }

  private raw(cx: number, cy: number): number {
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return 0;
    return this.z[cy * this.w + cx];
  }

  /** 双线性插值，外层表面不会出现台阶 */
  at(x: number, y: number): number {
    const fx = x - this.x0 - 0.5;
    const fy = y - this.y0 - 0.5;
    const cx = Math.floor(fx);
    const cy = Math.floor(fy);
    const tx = fx - cx;
    const ty = fy - cy;
    const a = this.raw(cx, cy);
    const b = this.raw(cx + 1, cy);
    const c = this.raw(cx, cy + 1);
    const d = this.raw(cx + 1, cy + 1);
    // 写入时已向四周扩了一格，所以在里层衣物范围内四个角都有值
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
}

// ---------- 网格 ----------

export interface ShellGrid {
  xs: Float32Array;
  ys: Float32Array;
  /** 每个格点对应的照片坐标（贴边的格点吸附到照片边缘上），按行存放 */
  ux: Float32Array;
  uy: Float32Array;
  /** 变形后的位置（袖子转到手臂上之后），按行存放 */
  px: Float32Array;
  py: Float32Array;
  /** 每个格点的半厚度（前表面 z，背面为 -z） */
  depth: Float32Array;
  /** 每个格点是否有衣物（正面或背面照片不透明） */
  opaque: Uint8Array;
  /** 每个格点属于袖子的程度 0~1；袖子部分不画在衣身网格里，而是单独做成圆筒 */
  sleeve: Float32Array;
  tubes: SleeveTube[];
}

/** 一只袖子：沿手臂的一串椭圆截面，贴图坐标反算回平铺照片 */
export interface SleeveTube {
  side: 1 | -1;
  pvx: number;
  pvy: number;
  turn: number;
  rings: Array<{
    y: number;
    /** 圆筒中心（手臂中心）和照片里袖子在这一高度的中心（转下来之后、平移之前） */
    c: number;
    cSrc: number;
    /** 照片里袖子半宽、圆筒半宽、圆筒半厚 */
    hw: number;
    hwT: number;
    b: number;
  }>;
  /** 照片坐标处是否属于这只袖子 */
  isSleeve: (x: number, y: number) => boolean;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * 找出袖子：逐行看这一侧有几段不透明区域。袖子和衣身分开的那些行里，最靠里的一段是衣身，
 * 记下衣身外缘；袖子和衣身连在一起的行（腋下、肩头）沿用最近一行的衣身外缘。
 * 返回每个格点属于袖子的程度 0~1 和每行的衣身外缘；没有分开的行（无袖、蝙蝠袖）时返回 null。
 */
export function sleeveInfo(
  xs: Float32Array,
  ys: Float32Array,
  opaque: Uint8Array,
  side: 1 | -1,
): { weight: Float32Array; edge: Float32Array; last: number } | null {
  const cols = xs.length;
  const rows = ys.length;
  const edge = new Float32Array(rows).fill(NaN);
  let first = -1;
  let last = -1;
  const order: number[] = [];
  for (let j = 0; j < cols; j++) if (side * xs[j] >= -1) order.push(j);
  if (side < 0) order.reverse();
  for (let i = 0; i < rows; i++) {
    // 从中线往外走，记录这一侧的各段
    const spans: Array<[number, number]> = [];
    let start = -1;
    let prev = -1;
    for (const j of order) {
      const o = opaque[i * cols + j];
      if (o && start < 0) start = j;
      if (!o && start >= 0) {
        spans.push([start, prev]);
        start = -1;
      }
      prev = j;
    }
    if (start >= 0) spans.push([start, prev]);
    // 两段之间至少隔开 1.5cm 才算分开
    const real: Array<[number, number]> = [];
    for (const sp of spans) {
      const last = real[real.length - 1];
      if (last && Math.abs(xs[sp[0]] - xs[last[1]]) < 1.5) last[1] = sp[1];
      else real.push([sp[0], sp[1]]);
    }
    if (real.length >= 2) {
      edge[i] = Math.abs(xs[real[0][1]]);
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return null;
  for (let i = 0; i < first; i++) edge[i] = edge[first];
  for (let i = first + 1; i <= last; i++) if (Number.isNaN(edge[i])) edge[i] = edge[i - 1];
  const weight = new Float32Array(rows * cols);
  for (let i = 0; i <= last + 1 && i < rows; i++) {
    const e = edge[Math.min(i, last)];
    for (let j = 0; j < cols; j++) weight[i * cols + j] = smoothstep(0.2, 1.2, side * xs[j] - e);
  }
  return { weight, edge, last };
}

/** 这一行从中线往外第一段不透明区域的外缘（|x|），没有时返回 NaN */
function innerSpanEdge(xs: Float32Array, opaque: Uint8Array, i: number, side: 1 | -1): number {
  const cols = xs.length;
  let edge = NaN;
  let gap = 0;
  let started = false;
  const order: number[] = [];
  for (let j = 0; j < cols; j++) if (side * xs[j] >= 0) order.push(j);
  if (side < 0) order.reverse();
  for (const j of order) {
    if (opaque[i * cols + j]) {
      started = true;
      gap = 0;
      edge = Math.abs(xs[j]);
    } else if (started) {
      gap += Math.abs(xs[1] - xs[0]);
      if (gap >= 1.5) break;
    }
  }
  return edge;
}

/** 计算衣物外壳的网格（纯计算，便于测试） */
/** 里层衣物：衣身和袖子分开记录，外层的衣身只包住里层衣身，外层的袖子只包住里层袖子 */
export interface InnerLayers {
  body: DepthMap;
  arms: DepthMap;
}

export function shellGrid(m: Body3D, input: ShellInput, innerLayers?: InnerLayers): ShellGrid {
  const inner = innerLayers?.body;
  const innerArms = innerLayers?.arms;
  const H = m.g.height;
  const g = m.g;
  const off = layerOffset(input.layer);
  const fr = input.front.rect;
  const br = input.back?.rect;
  let x0 = fr.x;
  let x1 = fr.x + fr.width;
  let y0 = fr.y;
  let y1 = fr.y + fr.height;
  if (br) {
    x0 = Math.min(x0, -(br.x + br.width));
    x1 = Math.max(x1, -br.x);
    y0 = Math.min(y0, br.y);
    y1 = Math.max(y1, br.y + br.height);
  }
  y0 = Math.max(-H * 0.05, y0);
  y1 = Math.min(H * 1.02, y1);
  // 左右再包含被裹住的身体，保证前后两片在边缘合拢
  for (let k = 0; k <= 12; k++) {
    const y = y0 + ((y1 - y0) * k) / 12;
    const ext = envelopeExtent(rule(m, input.category, input.subtype, y, off).parts, y, off);
    if (ext) {
      x0 = Math.min(x0, ext[0]);
      x1 = Math.max(x1, ext[1]);
    }
  }
  x0 -= 2;
  x1 += 2;
  const cols = Math.max(24, Math.min(110, Math.round((x1 - x0) / 0.8)));
  const rows = Math.max(16, Math.min(130, Math.round((y1 - y0) / 0.85)));
  const n = rows * cols;
  const xs = new Float32Array(cols);
  const ys = new Float32Array(rows);
  for (let j = 0; j < cols; j++) xs[j] = x0 + ((x1 - x0) * j) / (cols - 1);
  for (let i = 0; i < rows; i++) ys[i] = y0 + ((y1 - y0) * i) / (rows - 1);
  const dx = (x1 - x0) / (cols - 1);

  const alphaAt = (x: number, y: number): number => {
    const [uf, vf] = frontUV(fr, x, y);
    let a = sampleAlphaSmooth(input.front.mask, uf, vf);
    if (input.back) {
      const [ub, vb] = backUV(input.back.rect, x, y);
      a = Math.max(a, sampleAlphaSmooth(input.back.mask, ub, vb));
    }
    return a;
  };
  const opaque = new Uint8Array(n);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) opaque[i * cols + j] = alphaAt(xs[j], ys[i]) > 110 ? 1 : 0;
  }
  /** 在 xa（不透明）和 xb（透明）之间二分，求透明度 = 110 的精确位置 */
  const edgeBetween = (xa: number, xb: number, y: number): number => {
    let a = xa;
    let b = xb;
    for (let it = 0; it < 6; it++) {
      const mid = (a + b) / 2;
      if (alphaAt(mid, y) > 110) a = mid;
      else b = mid;
    }
    return (a + b) / 2;
  };

  /** 竖直方向上的二分 */
  const edgeBetweenY = (x: number, ya: number, yb: number): number => {
    let a = ya;
    let b = yb;
    for (let it = 0; it < 6; it++) {
      const mid = (a + b) / 2;
      if (alphaAt(x, mid) > 110) a = mid;
      else b = mid;
    }
    return (a + b) / 2;
  };
  // 紧挨着衣物的透明格点吸附到照片边缘：这样厚度在边缘正好收到 0，前后两片合拢
  const ux = new Float32Array(n);
  const uy = new Float32Array(n);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const k = i * cols + j;
      ux[k] = xs[j];
      uy[k] = ys[i];
      if (opaque[k]) continue;
      const l = j > 0 && opaque[k - 1];
      const r = j < cols - 1 && opaque[k + 1];
      const t = i > 0 && opaque[k - cols];
      const b = i < rows - 1 && opaque[k + cols];
      if (l && !r) ux[k] = edgeBetween(xs[j - 1], xs[j], ys[i]) + 0.02;
      else if (r && !l) ux[k] = edgeBetween(xs[j + 1], xs[j], ys[i]) - 0.02;
      else if (t && !b) uy[k] = edgeBetweenY(xs[j], ys[i - 1], ys[i]) + 0.02;
      else if (b && !t) uy[k] = edgeBetweenY(xs[j], ys[i + 1], ys[i]) - 0.02;
    }
  }

  const px = new Float32Array(n);
  const py = new Float32Array(n);
  const sleeve = new Float32Array(n);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      px[i * cols + j] = ux[i * cols + j];
      py[i * cols + j] = uy[i * cols + j];
    }
  }

  // 1. 衣身：在躯干范围内，如果照片里的衣身比身体窄，就横向拉宽到身体两侧，
  //    这样正面照片的侧缝落在身体侧面，和背面照片接上，不会露出身体
  const sleeves = hasSleeves(input.category)
    ? ([1, -1] as const).map((side) => ({ side, info: sleeveInfo(xs, ys, opaque, side) }))
    : [];
  const torso = partByName(m, 'torso');
  const stretchable = input.category === 'top' || input.category === 'outer' || input.category === 'dress' || input.category === 'bottom';
  if (stretchable) {
    for (let i = 0; i < rows; i++) {
      const y = ys[i];
      if (y < torso.y0 || y > g.crotchY) continue;
      const A = torso.section(y).a + off;
      for (const side of [1, -1] as const) {
        const sl = sleeves.find((s) => s.side === side)?.info;
        const S = sl && i <= sl.last + 1 ? sl.edge[Math.min(i, sl.last)] : innerSpanEdge(xs, opaque, i, side);
        if (!(S > 2) || S >= A) continue;
        const scale = A / S;
        for (let j = 0; j < cols; j++) {
          const x = ux[i * cols + j];
          if (side * x < 0) continue;
          px[i * cols + j] = side * x <= S ? x * scale : x + side * (A - S);
        }
      }
    }
  }

  // 2. 厚度：身体外扩 + 每段不透明区域的椭圆（椭圆按照片坐标算，再随拉宽一起移动）
  const depth = new Float32Array(n);
  for (let i = 0; i < rows; i++) {
    const y = ys[i];
    const r = rule(m, input.category, input.subtype, y, off);
    for (let j = 0; j < cols; j++) depth[i * cols + j] = envelopeDepth(r.parts, y, px[i * cols + j], off);
    if (r.k <= 0) continue;
    let j = 0;
    while (j < cols) {
      if (!opaque[i * cols + j]) {
        j++;
        continue;
      }
      let e = j;
      while (e + 1 < cols && opaque[i * cols + e + 1]) e++;
      const left = j > 0 ? edgeBetween(xs[j], xs[j - 1], y) : xs[j] - dx / 2;
      const right = e < cols - 1 ? edgeBetween(xs[e], xs[e + 1], y) : xs[e] + dx / 2;
      const c = (left + right) / 2;
      const hw = Math.max(dx * 0.5, (right - left) / 2);
      const bz = Math.min(r.k * hw, r.cap);
      for (let q = Math.max(0, j - 1); q <= Math.min(cols - 1, e + 1); q++) {
        const t = (ux[i * cols + q] - c) / hw;
        if (Math.abs(t) >= 1) continue;
        const z = bz * Math.sqrt(1 - t * t);
        if (z > depth[i * cols + q]) depth[i * cols + q] = z;
      }
      j = e + 1;
    }
  }

  // 3. 袖子：转到接近手臂的角度，再平移到手臂中心，做成包住手臂的椭圆筒（单独成网格）
  const tubes: SleeveTube[] = [];
  for (const { side, info } of sleeves) {
    if (!info) continue;
    const wts = info.weight;
    const arm = partByName(m, side > 0 ? 'armR' : 'armL');
    const pvx = g.shoulderHalf * 0.86;
    const pvy = g.shoulderY + H * 0.012;
    // 袖子张开的角度（取中位数），和手臂角度比较
    const angles: number[] = [];
    for (let k = 0; k < n; k++) {
      if (!opaque[k] || wts[k] < 0.5) continue;
      const u = side * ux[k] - pvx;
      const v = uy[k] - pvy;
      if (Math.hypot(u, v) > 6) angles.push(Math.atan2(u, v));
    }
    if (angles.length < 6) continue;
    angles.sort((a, b) => a - b);
    const spread = angles[Math.floor(angles.length / 2)];
    const armAngle = Math.atan2(Math.abs(arm.section(g.wristY).cx) - pvx, g.wristY - pvy);
    const turn = Math.max(0, spread - armAngle - 0.08);
    // 转下来之后，每 1cm 高度上袖子的左右范围
    const bins = new Map<number, [number, number]>();
    for (let k = 0; k < n; k++) {
      if (!opaque[k] || wts[k] < 0.5) continue;
      sleeve[k] = Math.max(sleeve[k], wts[k]);
      const u = side * ux[k] - pvx;
      const v = uy[k] - pvy;
      const r = Math.hypot(u, v);
      const a = Math.atan2(u, v) - turn * smoothstep(1.5, 4, r);
      const x = side * (pvx + r * Math.sin(a));
      const y = pvy + r * Math.cos(a);
      const key = Math.round(y);
      const cur = bins.get(key);
      if (cur) {
        cur[0] = Math.min(cur[0], x);
        cur[1] = Math.max(cur[1], x);
      } else bins.set(key, [x, x]);
    }
    for (let k = 0; k < n; k++) if (wts[k] > 0) sleeve[k] = Math.max(sleeve[k], wts[k]);
    const keys = [...bins.keys()].sort((a, b) => a - b);
    if (keys.length < 3) continue;
    const span = (yy: number): [number, number] | null => {
      let lo = 0;
      let hi = 0;
      let c = 0;
      for (let d = -2; d <= 2; d++) {
        const sp = bins.get(Math.round(yy) + d);
        if (!sp) continue;
        lo += sp[0];
        hi += sp[1];
        c++;
      }
      return c ? [lo / c, hi / c] : null;
    };
    const rings: SleeveTube['rings'] = [];
    for (let y = keys[0] - 0.5; y <= keys[keys.length - 1] + 0.5; y += 0.8) {
      const sp = span(y);
      if (!sp) continue;
      const cSrc = (sp[0] + sp[1]) / 2;
      const hw = Math.max(0.8, (sp[1] - sp[0]) / 2 + dx * 0.5);
      const ya = Math.max(arm.y0 + 1, Math.min(arm.y1 - 1, y));
      const as = arm.section(ya);
      const shift = as.cx - cSrc;
      const c = Math.abs(shift) < 18 ? as.cx : cSrc;
      const armR = as.a + off;
      let hwT = Math.max(hw, armR);
      let b = Math.max(armR, hw * 0.85);
      if (innerArms) {
        b = Math.max(b, innerArms.at(c, y) + 0.5);
        while (hwT < hw + 6 && (innerArms.at(c - hwT, y) > 0 || innerArms.at(c + hwT, y) > 0)) hwT += 0.5;
      }
      rings.push({ y, c, cSrc, hw, hwT, b });
    }
    const edge = info.edge;
    const last = info.last;
    const isSleeve = (x: number, y: number): boolean => {
      const i = Math.round(((y - ys[0]) / (ys[rows - 1] - ys[0])) * (rows - 1));
      if (i < 0 || i >= rows || i > last + 1) return false;
      return side * x - edge[Math.min(i, last)] > 0.6;
    };
    tubes.push({ side, pvx, pvy, turn, rings, isSleeve });
  }

  // 4. 包住里层衣物
  if (inner) {
    for (let k = 0; k < n; k++) {
      if (sleeve[k] >= 0.5) continue;
      const z = inner.at(px[k], py[k]);
      if (z > 0 && z + 0.5 > depth[k]) depth[k] = z + 0.5;
    }
  }
  // 最外两列收拢到 0，前后两片在侧面合上
  for (let i = 0; i < rows; i++) {
    depth[i * cols] = 0;
    depth[i * cols + cols - 1] = 0;
  }
  return { xs, ys, ux, uy, px, py, depth, opaque, sleeve, tubes };
}

/** 衣物外壳网格：前后两片，带正面 / 背面贴图坐标 */
export function shellMesh(m: Body3D, input: ShellInput, grid: ShellGrid): MeshData {
  const H = m.g.height;
  const { xs, ys, px, py, depth } = grid;
  const cols = xs.length;
  const rows = ys.length;
  const limit = backLimit(m, input.category, input.subtype);
  const fr = input.front.rect;
  const mb = new MeshBuilder();
  const idx = (i: number, j: number) => Math.max(0, Math.min(rows - 1, i)) * cols + Math.max(0, Math.min(cols - 1, j));
  for (const sideSign of [1, -1]) {
    const base = mb.count;
    const P = (i: number, j: number): [number, number, number] => {
      const k = idx(i, j);
      return [px[k], H - py[k], depth[k] * sideSign];
    };
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const k = i * cols + j;
        // 法线：横向切线 × 纵向切线（世界 Y 向上），后片取反
        const a = P(i, j + 1);
        const b = P(i, j - 1);
        const c = P(i - 1, j);
        const d = P(i + 1, j);
        const tx = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
        const ty = [c[0] - d[0], c[1] - d[1], c[2] - d[2]];
        let nx = tx[1] * ty[2] - tx[2] * ty[1];
        let ny = tx[2] * ty[0] - tx[0] * ty[2];
        let nz = tx[0] * ty[1] - tx[1] * ty[0];
        if (sideSign < 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        const len = Math.hypot(nx, ny, nz) || 1;
        mb.vertex(px[k], H - py[k], depth[k] * sideSign, nx / len, ny / len, nz / len);
        const x = grid.ux[k];
        const y = grid.uy[k];
        const [uf, vf] = frontUV(fr, x, y);
        mb.uvF.push(uf, vf);
        if (input.back) {
          const [ub, vb] = backUV(input.back.rect, x, y);
          mb.uvB.push(ub, vb);
        } else {
          mb.uvB.push(uf, vf);
        }
        mb.side.push(sideSign > 0 ? 1 : 0);
      }
    }
    const o = grid.opaque;
    const sl = grid.sleeve;
    for (let i = 0; i < rows - 1; i++) {
      if (sideSign < 0 && ys[i] > limit) break;
      for (let j = 0; j < cols - 1; j++) {
        // 整个格子都透明的跳过，减少三角形
        const any = o[i * cols + j] | o[i * cols + j + 1] | o[(i + 1) * cols + j] | o[(i + 1) * cols + j + 1];
        if (!any) continue;
        // 袖子由单独的圆筒负责
        const ks = [i * cols + j, i * cols + j + 1, (i + 1) * cols + j, (i + 1) * cols + j + 1];
        if (ks.some((k) => sl[k] >= 0.5)) continue;
        const a = base + i * cols + j;
        const b = a + cols;
        mb.idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  for (const tube of grid.tubes) sleeveTubeMesh(mb, H, input, tube);
  return mb.build();
}

/** 袖子圆筒：前半圈贴正面照片，后半圈贴背面照片，贴图坐标沿转动、平移、拉宽反算回照片 */
function sleeveTubeMesh(mb: MeshBuilder, H: number, input: ShellInput, tube: SleeveTube): void {
  const seg = 24;
  const { side, pvx, pvy, turn, rings } = tube;
  if (rings.length < 2) return;
  const fr = input.front.rect;
  const toSource = (x: number, ring: SleeveTube['rings'][number]): [number, number] => {
    // 圆筒宽度对应照片里袖子宽度（略往里收，边缘不透明，前后两半在侧面合上）
    const xPre = ring.cSrc + ((x - ring.c) * Math.max(0.3, ring.hw - 0.35)) / ring.hwT;
    const u = side * xPre - pvx;
    const v = ring.y - pvy;
    const r = Math.hypot(u, v);
    const a = Math.atan2(u, v) + turn * smoothstep(1.5, 4, r);
    return [side * (pvx + r * Math.sin(a)), pvy + r * Math.cos(a)];
  };
  const base = mb.count;
  const keep: boolean[] = [];
  for (const ring of rings) {
    for (let q = 0; q <= seg; q++) {
      const th = (q / seg) * Math.PI * 2;
      const c = Math.cos(th);
      const sn = Math.sin(th);
      const x = ring.c + ring.hwT * c;
      const z = ring.b * sn;
      let nx = c / ring.hwT;
      let nz = sn / ring.b;
      const len = Math.hypot(nx, nz) || 1;
      nx /= len;
      nz /= len;
      mb.vertex(x, H - ring.y, z, nx, 0, nz);
      const [sx, sy] = toSource(x, ring);
      const [uf, vf] = frontUV(fr, sx, sy);
      mb.uvF.push(uf, vf);
      if (input.back) mb.uvB.push(...backUV(input.back.rect, sx, sy));
      else mb.uvB.push(uf, vf);
      // 上半圈（z ≥ 0）属于正面
      mb.side.push(sn >= 0 ? 1 : 0);
      keep.push(tube.isSleeve(sx, sy));
    }
  }
  const stride = seg + 1;
  for (let r = 0; r < rings.length - 1; r++) {
    for (let q = 0; q < seg; q++) {
      const a = r * stride + q;
      const b = a + stride;
      if (!keep[a] || !keep[a + 1] || !keep[b] || !keep[b + 1]) continue;
      mb.idx.push(base + a, base + b, base + a + 1, base + a + 1, base + b, base + b + 1);
    }
  }
}

export function garmentShell(m: Body3D, input: ShellInput, inner?: InnerLayers): MeshData {
  return shellMesh(m, input, shellGrid(m, input, inner));
}

/** 一整套衣物：按从里到外的顺序生成，外层包住里层 */
export function outfitShells(m: Body3D, inputs: ShellInput[]): MeshData[] {
  const layers: InnerLayers = { body: new DepthMap(m.g.height), arms: new DepthMap(m.g.height) };
  return inputs.map((input) => {
    const grid = shellGrid(m, input, layers);
    // 包、帽子、配饰不参与包裹（不会把外套撑开）
    if (input.category !== 'bag' && input.category !== 'jewelry' && input.category !== 'hat') {
      for (let k = 0; k < grid.depth.length; k++) if (grid.opaque[k] && grid.sleeve[k] < 0.5) layers.body.splat(grid.px[k], grid.py[k], grid.depth[k]);
      for (const t of grid.tubes) {
        for (const ring of t.rings) {
          for (let q = 0; q <= 12; q++) {
            const th = (q / 12) * Math.PI;
            layers.arms.splat(ring.c + ring.hwT * Math.cos(th), ring.y, ring.b * Math.sin(th));
          }
        }
      }
    }
    return shellMesh(m, input, grid);
  });
}

// ---------- 鞋 ----------

export type RGB = [number, number, number];

/** 鞋：在脚的外面扩一层，鞋面和鞋底两种颜色；靴子向上包到小腿 */
export function shoeMesh(m: Body3D, subtype: string, upper: RGB, sole: RGB): MeshData {
  const g = m.g;
  const H = g.height;
  const mb = new MeshBuilder();
  const boots = subtype.includes('靴');
  const top = boots ? g.kneeY + (g.ankleY - g.kneeY) * 0.42 : g.ankleY - H * 0.006;
  const soleTop = H - H * 0.014;
  for (const side of ['L', 'R'] as const) {
    const legPart = partByName(m, side === 'L' ? 'legL' : 'legR');
    const footPart = partByName(m, side === 'L' ? 'footL' : 'footR');
    const section = (y: number): Section => {
      const s = y <= g.ankleY ? legPart.section(Math.min(legPart.y1, y)) : footPart.section(y);
      const grow = y > soleTop ? 0.9 : 0.6;
      return { ...s, a: s.a + grow, b: s.b + grow, cz: s.cz + (y > g.ankleY ? 0.4 : 0) };
    };
    sweep(mb, H, top, H, boots ? 34 : 14, 28, section, {
      capBottom: true,
      color: (y) => (y > soleTop ? sole : upper),
    });
  }
  return mb.build();
}
