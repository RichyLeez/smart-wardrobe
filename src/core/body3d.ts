// 3D 人台：由身材数据生成无五官的人体网格。
// 做法：把身体分成躯干、头、手臂、腿、脚几段，每一段沿高度方向取水平截面（超椭圆），
// 截面的宽度和 2D 人台轮廓一致，厚度按常见人体比例估算。
// 坐标：单位 cm；输出网格用 X 向右（正面看）、Y 向上、Z 朝向观看者（正面）。
// 内部计算沿用 2D 人台的 y（从头顶向下），输出时转换为 Y = 身高 - y。

import { mannequinGeometry, type MannequinGeometry } from './body';
import type { BodyProfile } from './types';

/** 水平截面：中心 (cx, cz)，半宽 a，半厚 b，超椭圆指数 p（2 为椭圆，越大越方） */
export interface Section {
  cx: number;
  cz: number;
  a: number;
  b: number;
  p: number;
}

export type PartName = 'torso' | 'head' | 'armL' | 'armR' | 'legL' | 'legR' | 'footL' | 'footR';

export interface BodyPart {
  name: PartName;
  y0: number;
  y1: number;
  rows: number;
  section(y: number): Section;
  /** 下端是否封口（平底） */
  capBottom?: boolean;
}

export interface Body3D {
  g: MannequinGeometry;
  parts: BodyPart[];
  footLength: number;
}

// ---------- 插值 ----------

/** 单调三次插值（不会在关键点之间冲过头），keys 按 y 递增 */
export function monotone(keys: Array<[number, number]>): (y: number) => number {
  const n = keys.length;
  const xs = keys.map((k) => k[0]);
  const ys = keys.map((k) => k[1]);
  const d: number[] = [];
  const m: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-9, xs[i + 1] - xs[i]));
  m[0] = d[0] ?? 0;
  m[n - 1] = d[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (y: number) => {
    if (y <= xs[0]) return ys[0];
    if (y >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && y > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (y - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1]
    );
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 端部收圆：离端点 len 以内按四分之一圆收小 */
function roundEnd(dist: number, len: number): number {
  if (dist >= len) return 1;
  const t = 1 - Math.max(0, dist) / len;
  return Math.sqrt(Math.max(0, 1 - t * t));
}

// ---------- 人体 ----------

export function body3d(b: BodyProfile): Body3D {
  const g = mannequinGeometry(b);
  const H = g.height;
  const chestB = g.chestHalf * 0.74;
  const waistB = g.waistHalf * 0.8;
  const hipB = g.hipHalf * 0.76;
  const neckTop = g.chinY - H * 0.012;

  const torsoA = monotone([
    [neckTop, g.neckHalf],
    [g.shoulderY - H * 0.015, g.neckHalf * 1.08],
    [g.shoulderY - H * 0.002, g.shoulderHalf * 0.82],
    [g.shoulderY + H * 0.018, g.shoulderHalf * 0.97],
    [g.shoulderY + H * 0.06, g.chestHalf * 0.98],
    [g.chestY, g.chestHalf],
    [g.waistY, g.waistHalf],
    [g.hipY, g.hipHalf],
    [g.crotchY + H * 0.012, g.hipHalf * 0.9],
  ]);
  const torsoB = monotone([
    [neckTop, g.neckHalf * 1.05],
    [g.shoulderY - H * 0.015, g.neckHalf * 1.15],
    [g.shoulderY - H * 0.002, chestB * 0.62],
    [g.shoulderY + H * 0.018, chestB * 0.72],
    [g.shoulderY + H * 0.06, chestB * 0.92],
    [g.chestY, chestB],
    [g.waistY, waistB],
    [g.hipY, hipB],
    [g.crotchY + H * 0.012, hipB * 0.72],
  ]);
  const torso: BodyPart = {
    name: 'torso',
    y0: neckTop,
    y1: g.crotchY + H * 0.012,
    rows: 72,
    capBottom: true,
    section: (y) => ({ cx: 0, cz: 0, a: torsoA(y), b: torsoB(y), p: 2.5 }),
  };

  const headCy = g.chinY - g.headRy;
  const head: BodyPart = {
    name: 'head',
    y0: headCy - g.headRy,
    y1: headCy + g.headRy,
    rows: 26,
    section: (y) => {
      const t = (y - headCy) / g.headRy;
      const k = Math.sqrt(Math.max(0, 1 - t * t));
      return { cx: 0, cz: 0.4, a: g.headRx * k, b: g.headRx * 1.12 * k, p: 2 };
    },
  };

  // 手臂：基本竖直，和 2D 人台的手臂位置一致
  const armTop = g.shoulderY - H * 0.004;
  const armEnd = g.wristY + H * 0.06;
  const ah = g.armHalf;
  const armX = monotone([
    [armTop, g.shoulderHalf * 0.8],
    [g.shoulderY + H * 0.05, (g.shoulderHalf + ah * 0.9 + g.chestHalf * 0.98) / 2],
    [g.waistY, g.chestHalf + ah * 0.93],
    [g.wristY, g.hipHalf + ah * 0.75],
    [armEnd, g.hipHalf + ah * 0.7],
  ]);
  const armR = monotone([
    [armTop, ah * 1.0],
    [g.shoulderY + H * 0.03, ah * 1.08],
    [g.waistY, ah * 0.8],
    [(g.waistY + g.wristY) / 2, ah * 0.72],
    [g.wristY, ah * 0.52],
    [g.wristY + H * 0.025, ah * 0.66],
    [armEnd, ah * 0.5],
  ]);
  const arm = (side: 1 | -1): BodyPart => ({
    name: side > 0 ? 'armR' : 'armL',
    y0: armTop,
    y1: armEnd,
    rows: 52,
    section: (y) => {
      const r = armR(y) * roundEnd(y - armTop, ah * 1.0) * roundEnd(armEnd - y, ah * 0.7);
      const hand = y > g.wristY ? 0.62 : 1;
      return { cx: side * armX(y), cz: -0.3, a: r, b: r * hand, p: 2 };
    },
  });

  // 腿：从臀部开始（与躯干重叠）到脚踝
  const legTop = g.hipY - H * 0.02;
  const legEnd = g.ankleY + H * 0.012;
  const kneeC = g.legCenter * 0.82;
  const ankleC = g.legCenter * 0.76;
  const legX = monotone([
    [legTop, g.legCenter * 1.02],
    [g.crotchY + H * 0.03, g.legCenter + g.thighHalf * 0.065],
    [g.kneeY, kneeC],
    [g.ankleY, ankleC],
  ]);
  const legA = monotone([
    [legTop, g.thighHalf * 1.0],
    [g.crotchY + H * 0.03, g.thighHalf * 0.92],
    [g.kneeY, g.kneeHalf],
    [g.kneeY + (g.ankleY - g.kneeY) * 0.3, g.calfHalf * 0.9],
    [g.ankleY, g.ankleHalf],
  ]);
  const leg = (side: 1 | -1): BodyPart => ({
    name: side > 0 ? 'legR' : 'legL',
    y0: legTop,
    y1: legEnd,
    rows: 60,
    section: (y) => {
      const a = legA(y);
      return { cx: side * legX(y), cz: 0, a, b: a * 0.95, p: 2.1 };
    },
  });

  const footLength = H * 0.145;
  const footTop = g.ankleY - H * 0.004;
  const foot = (side: 1 | -1): BodyPart => ({
    name: side > 0 ? 'footR' : 'footL',
    y0: footTop,
    y1: H,
    rows: 14,
    capBottom: true,
    section: (y) => {
      const u = Math.pow(clamp01((y - g.ankleY) / (H - g.ankleY)), 0.7);
      return {
        cx: side * ankleC,
        cz: lerp(0.3, footLength * 0.5 - g.ankleHalf * 1.3, u),
        a: g.ankleHalf * (1.05 + 0.45 * u),
        b: lerp(g.ankleHalf * 1.05, footLength * 0.5, u),
        p: 2.3,
      };
    },
  });

  return { g, parts: [torso, head, arm(-1), arm(1), leg(-1), leg(1), foot(-1), foot(1)], footLength };
}

export function partByName(m: Body3D, name: PartName): BodyPart {
  return m.parts.find((p) => p.name === name)!;
}

/** 超椭圆截面在 x 处的前表面深度（以截面中心为 0），超出宽度返回 -1 */
export function sectionDepth(s: Section, x: number, dilate = 0): number {
  const a = s.a + dilate;
  if (a <= 0) return -1;
  const t = Math.abs(x - s.cx) / a;
  if (t >= 1) return -1;
  return (s.b + dilate) * Math.pow(1 - Math.pow(t, s.p), 1 / s.p);
}

/**
 * 若干身体部位在 (x, y) 处的前表面 z（取最大），每个部位先向外扩 dilate。
 * 衣服按前后对称包裹，所以中心不在 0 的部位（头、脚）加上中心偏移的绝对值。
 */
export function envelopeDepth(parts: BodyPart[], y: number, x: number, dilate: number): number {
  let z = 0;
  for (const p of parts) {
    if (y < p.y0 || y > p.y1) continue;
    const s = p.section(y);
    const d = sectionDepth(s, x, dilate);
    if (d > 0) z = Math.max(z, Math.abs(s.cz) + d);
  }
  return z;
}

/** 几个部位在 y 处的左右范围（扩 dilate 后），没有部位时返回 null */
export function envelopeExtent(parts: BodyPart[], y: number, dilate: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of parts) {
    if (y < p.y0 || y > p.y1) continue;
    const s = p.section(y);
    if (s.a <= 0) continue;
    lo = Math.min(lo, s.cx - s.a - dilate);
    hi = Math.max(hi, s.cx + s.a + dilate);
  }
  return lo <= hi ? [lo, hi] : null;
}

// ---------- 网格 ----------

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint16Array;
  /** 顶点颜色 rgb 0~1（人台、鞋） */
  colors?: Float32Array;
  /** 衣物：正面、背面贴图坐标，以及顶点属于正面条带（1）还是背面条带（0） */
  uvFront?: Float32Array;
  uvBack?: Float32Array;
  side?: Float32Array;
}

export class MeshBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  uvF: number[] = [];
  uvB: number[] = [];
  side: number[] = [];
  idx: number[] = [];

  get count(): number {
    return this.pos.length / 3;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    return this.count - 1;
  }

  build(): MeshData {
    if (this.count > 65535) throw new Error('网格顶点过多');
    const out: MeshData = {
      positions: new Float32Array(this.pos),
      normals: new Float32Array(this.nor),
      indices: new Uint16Array(this.idx),
    };
    if (this.col.length) out.colors = new Float32Array(this.col);
    if (this.uvF.length) {
      out.uvFront = new Float32Array(this.uvF);
      out.uvBack = new Float32Array(this.uvB);
      out.side = new Float32Array(this.side);
    }
    return out;
  }
}

function superPoint(s: Section, theta: number): [number, number] {
  const c = Math.cos(theta);
  const sn = Math.sin(theta);
  const e = 2 / s.p;
  return [s.cx + s.a * Math.sign(c) * Math.pow(Math.abs(c), e), s.cz + s.b * Math.sign(sn) * Math.pow(Math.abs(sn), e)];
}

/**
 * 沿高度扫出一段管状网格。section 返回 y 处的截面；
 * 法线用数值微分求得，保证接缝处连续，并统一朝外。
 */
export function sweep(
  mb: MeshBuilder,
  H: number,
  y0: number,
  y1: number,
  rows: number,
  ring: number,
  section: (y: number) => Section,
  opts: { capBottom?: boolean; color?: (y: number) => [number, number, number] } = {},
): void {
  const base = mb.count;
  const eps = (y1 - y0) / rows / 4;
  for (let r = 0; r <= rows; r++) {
    const y = y0 + ((y1 - y0) * r) / rows;
    const s = section(y);
    const sUp = section(Math.max(y0, y - eps));
    const sDn = section(Math.min(y1, y + eps));
    const dy = Math.min(y1, y + eps) - Math.max(y0, y - eps);
    for (let k = 0; k <= ring; k++) {
      const th = (k / ring) * Math.PI * 2;
      const [x, z] = superPoint(s, th);
      const [xu, zu] = superPoint(sUp, th);
      const [xd, zd] = superPoint(sDn, th);
      const [xa, za] = superPoint(s, th - 0.01);
      const [xb, zb] = superPoint(s, th + 0.01);
      // 两个切向量：沿高度（世界 Y 向上，所以 y 增大 = Y 减小）和沿圆周
      const tyx = (xd - xu) / dy;
      const tyy = -1;
      const tyz = (zd - zu) / dy;
      const tcx = xb - xa;
      const tcz = zb - za;
      // 叉乘 (ty × tc)，tc 的 Y 分量为 0
      let nx = tyy * tcz;
      let ny = tyz * tcx - tyx * tcz;
      let nz = -tyy * tcx;
      let len = Math.hypot(nx, ny, nz);
      if (len < 1e-6) {
        nx = 0;
        ny = r === 0 ? 1 : -1;
        nz = 0;
        len = 1;
      }
      nx /= len;
      ny /= len;
      nz /= len;
      // 朝外：与截面中心指向该点的方向同侧
      if (nx * (x - s.cx) + nz * (z - s.cz) < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      mb.vertex(x, H - y, z, nx, ny, nz);
      if (opts.color) mb.col.push(...opts.color(y));
    }
  }
  const stride = ring + 1;
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < ring; k++) {
      const a = base + r * stride + k;
      const b = a + stride;
      mb.idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  if (opts.capBottom) {
    const s = section(y1);
    const center = mb.vertex(s.cx, H - y1, s.cz, 0, -1, 0);
    if (opts.color) mb.col.push(...opts.color(y1));
    const first = mb.count;
    for (let k = 0; k <= ring; k++) {
      const [x, z] = superPoint(s, (k / ring) * Math.PI * 2);
      mb.vertex(x, H - y1, z, 0, -1, 0);
      if (opts.color) mb.col.push(...opts.color(y1));
    }
    for (let k = 0; k < ring; k++) mb.idx.push(center, first + k, first + k + 1);
  }
}

/** 整个人台的网格（含脚） */
export function bodyMesh(m: Body3D, ring = 28): MeshData {
  const mb = new MeshBuilder();
  for (const p of m.parts) sweep(mb, m.g.height, p.y0, p.y1, p.rows, ring, p.section, { capBottom: p.capBottom });
  return mb.build();
}
