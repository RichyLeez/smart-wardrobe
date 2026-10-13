// 把衣服转正：横着拍、倒着拍、放歪了，都转成领口（裤腰）朝上。
//
// 思路：
//   1. 平铺的衣服、裤子、裙子左右对称。在缩小的轮廓上试遍各个方向的直线，
//      找出"沿这条线翻过来和自己重合得最多"的对称轴。
//   2. 对称轴有两头。领口、帽子、裤腰那头比下摆窄；裤子下面分成两条腿。
//      按这两点判断哪头朝上；拿不准时宁可少转（拍照时多数是正着放的）。
//   3. 不对称的（鞋、包、袜子）和分成好几块的，不转。
// 全部是纯函数。

import type { RGBAImage } from './background';
import { components } from './mask';

export interface Orientation {
  /** 需要顺时针旋转的角度（度，-180~180）；0 表示不用转 */
  angle: number;
  /** 对称程度 0~1（沿对称轴翻过来重合的比例） */
  symmetry: number;
  /** 方向判断是否有把握（没把握时只做小角度的摆正） */
  confident: boolean;
}

const NONE: Orientation = { angle: 0, symmetry: 0, confident: false };

interface Grid {
  g: Uint8Array;
  gw: number;
  gh: number;
}

function toGrid(alpha: Uint8Array, w: number, h: number, maxSide: number): Grid {
  const k = Math.min(1, maxSide / Math.max(w, h));
  const gw = Math.max(1, Math.round(w * k));
  const gh = Math.max(1, Math.round(h * k));
  const sum = new Float32Array(gw * gh);
  const cnt = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(gh - 1, Math.floor(y * k));
    for (let x = 0; x < w; x++) {
      const gx = Math.min(gw - 1, Math.floor(x * k));
      sum[gy * gw + gx] += alpha[y * w + x] > 127 ? 1 : 0;
      cnt[gy * gw + gx]++;
    }
  }
  const g = new Uint8Array(gw * gh);
  for (let i = 0; i < g.length; i++) g[i] = cnt[i] && sum[i] / cnt[i] >= 0.5 ? 1 : 0;
  return { g, gw, gh };
}

/** 把角度规范到 (-180, 180] */
export function normAngle(a: number): number {
  let r = a % 360;
  if (r <= -180) r += 360;
  if (r > 180) r -= 360;
  return r;
}

interface Axis {
  /** 对称轴方向与竖直方向的夹角（弧度） */
  theta: number;
  /** 对称轴相对重心的横向偏移（格） */
  shift: number;
  score: number;
}

interface Pts {
  xs: Float32Array;
  ys: Float32Array;
  n: number;
  cx: number;
  cy: number;
}

function symmetryAt(grid: Grid, p: Pts, theta: number, shift: number): number {
  const { g, gw, gh } = grid;
  const ux = Math.sin(theta);
  const uy = Math.cos(theta);
  // 法向
  const nx = Math.cos(theta);
  const ny = -Math.sin(theta);
  const ox = p.cx + shift * nx;
  const oy = p.cy + shift * ny;
  let hit = 0;
  for (let i = 0; i < p.n; i++) {
    const dx = p.xs[i] - ox;
    const dy = p.ys[i] - oy;
    const along = dx * ux + dy * uy;
    const rx = Math.round(ox + 2 * along * ux - dx - 0.5);
    const ry = Math.round(oy + 2 * along * uy - dy - 0.5);
    if (rx >= 0 && ry >= 0 && rx < gw && ry < gh && g[ry * gw + rx]) hit++;
  }
  return hit / p.n;
}

function bestAxisNear(grid: Grid, p: Pts, theta: number, span: number, step: number, shifts: number[]): Axis {
  let best: Axis = { theta, shift: 0, score: -1 };
  for (let t = theta - span; t <= theta + span + 1e-9; t += step) {
    for (const s of shifts) {
      const sc = symmetryAt(grid, p, t, s);
      if (sc > best.score) best = { theta: t, shift: s, score: sc };
    }
  }
  return best;
}

interface EndEvidence {
  /** 正数：上端比下端窄（像领口、裤腰在上）；负数：反过来 */
  e: number;
}

/**
 * 以 t 为"朝上"方向把轮廓重新栅格化，比较两头：
 * 上端窄、下端宽 → 正；下面分成两条腿、上面一整条 → 再加分。
 */
function endEvidence(grid: Grid, p: Pts, axis: Axis, tx: number, ty: number): EndEvidence {
  const { g, gw, gh } = grid;
  // 横向单位向量（朝上方向顺时针转 90°，即观察者的右手）
  const rx = -ty;
  const ry = tx;
  const nx = Math.cos(axis.theta);
  const ny = -Math.sin(axis.theta);
  const ox = p.cx + axis.shift * nx;
  const oy = p.cy + axis.shift * ny;
  let aMin = Infinity;
  let aMax = -Infinity;
  let qMin = Infinity;
  let qMax = -Infinity;
  for (let i = 0; i < p.n; i++) {
    const dx = p.xs[i] - ox;
    const dy = p.ys[i] - oy;
    const a = dx * tx + dy * ty;
    const q = dx * rx + dy * ry;
    if (a < aMin) aMin = a;
    if (a > aMax) aMax = a;
    if (q < qMin) qMin = q;
    if (q > qMax) qMax = q;
  }
  const H = Math.max(1, Math.round(aMax - aMin) + 1);
  const W = Math.max(1, Math.round(qMax - qMin) + 1);
  const rows: Array<Array<[number, number]>> = [];
  const minRun = Math.max(1, Math.round(W * 0.03));
  const mergeGap = Math.max(1, Math.round(W * 0.02));
  // 每一列离上端、下端最近的不透明格子（看两头是不是一条直边）
  const firstRow = new Int32Array(W).fill(-1);
  const lastRow = new Int32Array(W).fill(-1);
  for (let r = 0; r < H; r++) {
    const a = aMax - r;
    const runs: Array<[number, number]> = [];
    let start = -1;
    for (let c = 0; c <= W; c++) {
      let on = false;
      if (c < W) {
        const q = qMin + c;
        const x = Math.floor(ox + a * tx + q * rx);
        const y = Math.floor(oy + a * ty + q * ry);
        on = x >= 0 && y >= 0 && x < gw && y < gh && g[y * gw + x] === 1;
        if (on) {
          if (firstRow[c] < 0) firstRow[c] = r;
          lastRow[c] = r;
        }
      }
      if (on && start < 0) start = c;
      if (!on && start >= 0) {
        const prev = runs[runs.length - 1];
        if (prev && start - prev[1] - 1 <= mergeGap) prev[1] = c - 1;
        else runs.push([start, c - 1]);
        start = -1;
      }
    }
    rows.push(runs.filter((x) => x[1] - x[0] + 1 >= minRun));
  }
  const band = (f0: number, f1: number) => {
    const a = Math.floor(H * f0);
    const b = Math.max(a + 1, Math.ceil(H * f1));
    return { rows: rows.slice(a, b) };
  };
  // 下摆、裙摆、包底是一条宽的直边；领口、帽子、肩膀、提手那头是斜的或圆的，贴着端线的部分很窄
  const near = Math.max(1, Math.round(H * 0.025));
  let flatTop = 0;
  let flatBot = 0;
  for (let c = 0; c < W; c++) {
    if (firstRow[c] >= 0 && firstRow[c] <= near) flatTop++;
    if (lastRow[c] >= 0 && H - 1 - lastRow[c] <= near) flatBot++;
  }
  let e = (flatBot - flatTop) / W;
  // 领口：端线正中间往里凹一小块（圆领、V 领、吊带之间），下摆正中间是平的。
  // 只算浅的凹口，裤子两条腿之间的大空当不算
  const axisCol = Math.round(-qMin);
  const dip = (depth: (c: number) => number) => {
    let centre = 0;
    let cc = 0;
    let least = Infinity;
    const half = Math.max(1, Math.round(W * 0.03));
    const wide = Math.max(2, Math.round(W * 0.25));
    for (let c = axisCol - wide; c <= axisCol + wide; c++) {
      if (c < 0 || c >= W) continue;
      const d = depth(c);
      if (d < 0) continue;
      if (Math.abs(c - axisCol) <= half) {
        centre += d;
        cc++;
      }
      least = Math.min(least, d);
    }
    return cc && Number.isFinite(least) ? (centre / cc - least) / H : 0;
  };
  const dipTop = dip((c) => firstRow[c]);
  const dipBot = dip((c) => (lastRow[c] < 0 ? -1 : H - 1 - lastRow[c]));
  const neckLike = (d: number) => d >= 0.025 && d <= 0.22;
  if (neckLike(dipTop) && dipBot < 0.012) e += 0.3;
  if (neckLike(dipBot) && dipTop < 0.012) e -= 0.3;
  // 裤腿：从这一头开始连续很长一段（至少四分之一）都分成两段，每段都不细。
  // 领口很深的上衣，肩膀两侧在最上面也是两段，但只有一小截，不算
  const legRow = (r: Array<[number, number]>) =>
    r.length === 2 && r[1][0] - r[0][1] - 1 >= W * 0.04 && r.every((x) => (x[1] - x[0] + 1) / W >= 0.15);
  const legRun = (fromTop: boolean) => {
    let best = 0;
    let cur = 0;
    let miss = 0;
    for (let k = 0; k < H; k++) {
      const r = rows[fromTop ? k : H - 1 - k];
      if (legRow(r)) {
        cur += 1 + miss;
        miss = 0;
        best = Math.max(best, cur);
      } else if (cur > 0) {
        if (++miss > 2) break;
      } else if (k > H * 0.06) break;
    }
    return best / H;
  };
  const single = (rs: Array<Array<[number, number]>>) => (rs.length ? rs.filter((r) => r.length === 1).length / rs.length : 0);
  // 帽子、包的提手：端头是一个圆顶，比另一头窄得多，往里走很快变宽。
  // 下摆即使被去背弄残了，也还是方的，不会是圆顶
  const extent = (fromTop: boolean, f: number) => {
    const k = Math.min(H - 1, Math.max(0, Math.round(H * f)));
    const r = rows[fromTop ? k : H - 1 - k];
    return r.length ? (r[r.length - 1][1] - r[0][0] + 1) / W : 0;
  };
  const dome = (fromTop: boolean) => {
    const tip = extent(fromTop, 0.02);
    return tip > 0 && tip <= 0.75 * extent(fromTop, 0.08) && tip <= 0.65 * extent(!fromTop, 0.04);
  };
  if (dome(true) && !dome(false)) e += 0.2;
  if (dome(false) && !dome(true)) e -= 0.2;
  if (legRun(false) >= 0.25 && single(band(0.02, 0.12).rows) >= 0.6) e += 0.5;
  if (legRun(true) >= 0.25 && single(band(0.88, 0.98).rows) >= 0.6) e -= 0.5;
  return { e };
}

/**
 * 按需要转的角度给的先验：多数照片是正着拍的，其次是横着，倒着的最少。
 * 倒过来要有很强的依据：领口、下摆被去背弄残了（例如白底上的白条纹）时，两头可能看着差不多
 */
function prior(angle: number): number {
  const a = Math.abs(angle);
  if (a <= 25) return 0.1;
  if (a >= 65 && a <= 115) return 0;
  if (a >= 155) return -0.35;
  return -0.05;
}

/** 从轮廓判断衣服该怎么转正 */
export function detectOrientation(alpha: Uint8Array, w: number, h: number): Orientation {
  const grid = toGrid(alpha, w, h, 120);
  const { g, gw, gh } = grid;
  let n = 0;
  for (let i = 0; i < g.length; i++) n += g[i];
  if (n < 60) return NONE;
  // 分成两块以上大小差不多的（一双鞋、几件放一起）不转
  const comp = components(g, gw, gh, true);
  const largest = Math.max(0, ...comp.areas.slice(1));
  if (comp.areas.filter((a, i) => i > 0 && a >= largest * 0.25).length >= 2) return NONE;
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  let k = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (!g[y * gw + x]) continue;
      xs[k] = x + 0.5;
      ys[k] = y + 0.5;
      sx += x + 0.5;
      sy += y + 0.5;
      k++;
    }
  }
  const p: Pts = { xs, ys, n, cx: sx / n, cy: sy / n };
  // 细长条（腰带、围巾、领带）不转：它们的对称轴顺着长边，转成竖的反而不对
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - p.cx;
    const dy = ys[i] - p.cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const tr = (sxx + syy) / n;
  const det = (sxx * syy - sxy * sxy) / (n * n);
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  const l2 = Math.max(1e-6, tr / 2 - disc);
  if (Math.sqrt(l1 / l2) >= 3.2) return NONE;
  const shifts = [-3, -2, -1, 0, 1, 2, 3];
  const deg = Math.PI / 180;
  // 粗找：每 3° 一条
  const coarse: Axis[] = [];
  for (let t = 0; t < 180; t += 3) coarse.push(bestAxisNear(grid, p, t * deg, 0, 1, shifts));
  coarse.sort((a, b) => b.score - a.score);
  const fine = (a: Axis) => bestAxisNear(grid, p, a.theta, 3 * deg, 0.5 * deg, [a.shift - 1, a.shift - 0.5, a.shift, a.shift + 0.5, a.shift + 1]);
  const best = fine(coarse[0]);
  if (best.score < 0.78) return { angle: 0, symmetry: best.score, confident: false };
  // 和最好的对称轴差不多好的另一条（例如接近长方形的轮廓，横竖两条都对称）
  const axes: Axis[] = [best];
  for (const c of coarse.slice(1)) {
    const diff = Math.abs(normAngle((c.theta - best.theta) / deg));
    if (Math.min(diff, 180 - diff) < 20) continue;
    if (c.score < best.score - 0.06) break;
    axes.push(fine(c));
    break;
  }
  type Cand = { angle: number; total: number; e: number; score: number };
  const cands: Cand[] = [];
  for (const axis of axes) {
    if (axis.score < best.score - 0.06) continue;
    for (const sign of [1, -1]) {
      // 朝上方向（图片坐标，y 向下）
      const tx = sign * Math.sin(axis.theta);
      const ty = sign * Math.cos(axis.theta);
      const { e } = endEvidence(grid, p, axis, tx, ty);
      // 把 t 转到正上方 (0, -1) 需要顺时针转的角度
      const angle = normAngle(-90 - Math.atan2(ty, tx) / deg);
      cands.push({ angle, total: axis.score + 0.8 * e + prior(angle), e, score: axis.score });
    }
  }
  cands.sort((a, b) => b.total - a.total);
  const top = cands[0];
  // 转大角度要有明确的依据：轮廓足够对称，而且两头区别明显
  const confident = Math.abs(top.angle) <= 25 || (top.e >= 0.15 && top.score >= 0.85);
  let chosen = top;
  if (!confident) {
    // 没把握分清哪头朝上：只在接近当前方向时摆正
    const near = cands.filter((c) => Math.abs(c.angle) <= 25).sort((a, b) => Math.abs(a.angle) - Math.abs(b.angle))[0];
    if (!near) return { angle: 0, symmetry: best.score, confident: false };
    chosen = near;
  }
  const angle = Math.abs(chosen.angle) < 1.5 ? 0 : Math.round(chosen.angle * 2) / 2;
  return { angle, symmetry: chosen.score, confident };
}

/** 图片的不透明度通道 */
export function alphaOf(img: RGBAImage): Uint8Array {
  const n = img.width * img.height;
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = img.data[i * 4 + 3];
  return a;
}

/** 顺时针转 90° 的整数倍，逐像素搬运，不损失清晰度 */
function rotateQuarter(img: RGBAImage, quarters: number): RGBAImage {
  const q = ((quarters % 4) + 4) % 4;
  if (q === 0) return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  const { width: w, height: h, data } = img;
  const W = q % 2 ? h : w;
  const H = q % 2 ? w : h;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let X: number;
      let Y: number;
      if (q === 1) {
        X = h - 1 - y;
        Y = x;
      } else if (q === 2) {
        X = w - 1 - x;
        Y = h - 1 - y;
      } else {
        X = y;
        Y = w - 1 - x;
      }
      const si = (y * w + x) * 4;
      const di = (Y * W + X) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = data[si + 3];
    }
  }
  return { width: W, height: H, data: out };
}

/**
 * 顺时针旋转任意角度，画布放大到能装下整张图，空出来的地方透明。
 * 双线性插值按预乘透明度计算，半透明的边缘不会发黑。90° 的整数倍逐像素搬运。
 */
export function rotateImage(img: RGBAImage, angleDeg: number): RGBAImage {
  const a = normAngle(angleDeg);
  const quarter = Math.round(a / 90);
  if (Math.abs(a - quarter * 90) < 0.01) return rotateQuarter(img, quarter);
  const { width: w, height: h, data } = img;
  const rad = (a * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const W = Math.ceil(Math.abs(w * cos) + Math.abs(h * sin));
  const H = Math.ceil(Math.abs(w * sin) + Math.abs(h * cos));
  const out = new Uint8ClampedArray(W * H * 4);
  const cx = w / 2;
  const cy = h / 2;
  const CX = W / 2;
  const CY = H / 2;
  const px = (x: number, y: number, c: number) => data[(y * w + x) * 4 + c];
  for (let Y = 0; Y < H; Y++) {
    for (let X = 0; X < W; X++) {
      // 逆向映射：输出像素中心转回原图
      const dx = X + 0.5 - CX;
      const dy = Y + 0.5 - CY;
      const sx = dx * cos + dy * sin + cx - 0.5;
      const sy = -dx * sin + dy * cos + cy - 0.5;
      if (sx < -1 || sy < -1 || sx > w || sy > h) continue;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      let r = 0;
      let gg = 0;
      let b = 0;
      let al = 0;
      for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 2; i++) {
          const xx = x0 + i;
          const yy = y0 + j;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const wt = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
          const A = px(xx, yy, 3) * wt;
          r += px(xx, yy, 0) * A;
          gg += px(xx, yy, 1) * A;
          b += px(xx, yy, 2) * A;
          al += A;
        }
      }
      if (al <= 0) continue;
      const o = (Y * W + X) * 4;
      out[o] = r / al;
      out[o + 1] = gg / al;
      out[o + 2] = b / al;
      out[o + 3] = al;
    }
  }
  return { width: W, height: H, data: out };
}

/** 裁到不透明部分（四周留一点边） */
export function cropToContent(img: RGBAImage, padding = 0.02): RGBAImage {
  const { width: w, height: h, data } = img;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] <= 8) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return img;
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * padding);
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad);
  y1 = Math.min(h - 1, y1 + pad);
  const W = x1 - x0 + 1;
  const H = y1 - y0 + 1;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const s = ((y + y0) * w + x0) * 4;
    out.set(data.subarray(s, s + W * 4), y * W * 4);
  }
  return { width: W, height: H, data: out };
}

/** 转正一件已经去好背景的图：先按轮廓判断，再旋转并裁到衣物边界 */
export function uprightPiece(img: RGBAImage, extraQuarters = 0): { image: RGBAImage; orientation: Orientation; angle: number } {
  const orientation = detectOrientation(alphaOf(img), img.width, img.height);
  const angle = normAngle(orientation.angle + extraQuarters * 90);
  if (angle === 0) return { image: img, orientation, angle };
  return { image: cropToContent(rotateImage(img, angle)), orientation, angle };
}
