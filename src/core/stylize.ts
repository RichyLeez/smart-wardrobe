// 简化图形：把去背后的衣物照片变成干净的"插画"，去掉平铺拍摄时的褶皱、阴影和反光。
//
// 做法：
//   1. 轮廓：透明度先模糊再取阈值，边缘的毛刺和褶皱造成的小凹凸被抹平。
//   2. 色块：在 Lab 空间里聚类，亮度的权重调低，所以同一块布因为褶皱产生的明暗会归到同一类；
//      颜色明显不同的部分（条纹、印花、拼色）仍然分开。相近的类合并，太小的类并入最接近的类。
//   3. 每个像素按所属色块填色（色块颜色取较亮的那部分像素，避免被阴影拉暗），再做众数滤波去掉碎点。
//   4. 重新画上统一的立体感：离轮廓越近越暗一点，上亮下暗，最外圈和色块交界画细线。
// 全部是纯函数，输入输出都是像素数组。

import type { RGBAImage } from './background';
import { labToRgb, rgbToLab, type Lab } from './color';

export interface StylizeOptions {
  /** 聚类的最大颜色数 */
  maxColors?: number;
  /** 亮度在聚类距离里的权重（越小越不在意明暗） */
  lightnessWeight?: number;
  /** 两类的加权距离小于它就合并 */
  mergeDistance?: number;
}

export interface StylizeResult {
  image: RGBAImage;
  /** 最终的色块颜色（按面积从大到小） */
  colors: Array<{ rgb: [number, number, number]; share: number }>;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** 可分离盒式模糊，结果为 0~1 */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const size = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / size;
      acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / size;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** 到轮廓外的距离（像素，3-4 倒角距离近似） */
function insideDistance(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? INF : 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!mask[i]) continue;
      d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3;
  return d;
}

interface Cluster {
  c: [number, number, number];
  n: number;
}

export function stylizeGarment(img: RGBAImage, options: StylizeOptions = {}): StylizeResult {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const wl = options.lightnessWeight ?? 0.4;
  const K = options.maxColors ?? 6;
  const merge = options.mergeDistance ?? 10;

  // 1. 平滑轮廓
  const solid = new Float32Array(n);
  for (let i = 0; i < n; i++) solid[i] = data[i * 4 + 3] > 127 ? 1 : 0;
  const r = Math.max(1, Math.round(Math.max(w, h) / 220));
  const blurred = boxBlur(solid, w, h, r);
  const mask = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (blurred[i] >= 0.5) {
      mask[i] = 1;
      count++;
    }
  }
  const out = new Uint8ClampedArray(n * 4);
  if (count === 0) return { image: { width: w, height: h, data: out }, colors: [] };

  // 2. 颜色聚类（只用原本不透明的像素取样）
  const lab = new Float32Array(n * 3);
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    // 新长出来的轮廓像素没有颜色，借用最近的不透明邻居
    let j = i;
    if (data[i * 4 + 3] <= 127) {
      const x = i % w;
      const y = (i - x) / w;
      search: for (let rr = 1; rr <= r + 1; rr++) {
        for (let dy = -rr; dy <= rr; dy++) {
          for (let dx = -rr; dx <= rr; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const k = yy * w + xx;
            if (data[k * 4 + 3] > 127) {
              j = k;
              break search;
            }
          }
        }
      }
    }
    const L = rgbToLab(data[j * 4], data[j * 4 + 1], data[j * 4 + 2]);
    lab[i * 3] = L[0];
    lab[i * 3 + 1] = L[1];
    lab[i * 3 + 2] = L[2];
    if (data[i * 4 + 3] > 127) samples.push(i);
  }
  const step = Math.max(1, Math.floor(samples.length / 6000));
  const pts: number[] = [];
  for (let s = 0; s < samples.length; s += step) pts.push(samples[s]);
  const dist = (i: number, c: [number, number, number]) => {
    const dl = (lab[i * 3] - c[0]) * wl;
    const da = lab[i * 3 + 1] - c[1];
    const db = lab[i * 3 + 2] - c[2];
    return dl * dl + da * da + db * db;
  };
  // 初始中心：最远点采样，结果稳定
  const centers: Array<[number, number, number]> = [];
  const first = pts[Math.floor(pts.length / 2)];
  centers.push([lab[first * 3], lab[first * 3 + 1], lab[first * 3 + 2]]);
  while (centers.length < K) {
    let best = -1;
    let bestD = -1;
    for (const i of pts) {
      let m = Infinity;
      for (const c of centers) m = Math.min(m, dist(i, c));
      if (m > bestD) {
        bestD = m;
        best = i;
      }
    }
    if (bestD < merge * merge * 0.25 || best < 0) break;
    centers.push([lab[best * 3], lab[best * 3 + 1], lab[best * 3 + 2]]);
  }
  for (let it = 0; it < 8; it++) {
    const sum = centers.map(() => [0, 0, 0, 0]);
    for (const i of pts) {
      let bi = 0;
      let bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = dist(i, centers[c]);
        if (d < bd) {
          bd = d;
          bi = c;
        }
      }
      sum[bi][0] += lab[i * 3];
      sum[bi][1] += lab[i * 3 + 1];
      sum[bi][2] += lab[i * 3 + 2];
      sum[bi][3]++;
    }
    for (let c = 0; c < centers.length; c++) {
      if (sum[c][3] > 0) centers[c] = [sum[c][0] / sum[c][3], sum[c][1] / sum[c][3], sum[c][2] / sum[c][3]];
    }
  }
  // 合并相近的类和太小的类
  let clusters: Cluster[] = centers.map((c) => ({ c, n: 0 }));
  for (const i of pts) {
    let bi = 0;
    let bd = Infinity;
    for (let c = 0; c < clusters.length; c++) {
      const d = dist(i, clusters[c].c);
      if (d < bd) {
        bd = d;
        bi = c;
      }
    }
    clusters[bi].n++;
  }
  clusters = clusters.filter((c) => c.n > 0);
  const wdist = (a: Cluster, b: Cluster) =>
    Math.sqrt(((a.c[0] - b.c[0]) * wl) ** 2 + (a.c[1] - b.c[1]) ** 2 + (a.c[2] - b.c[2]) ** 2);
  for (;;) {
    let pa = -1;
    let pb = -1;
    let pd = Infinity;
    const total = clusters.reduce((s, c) => s + c.n, 0);
    for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        const d = wdist(clusters[a], clusters[b]);
        const tiny = Math.min(clusters[a].n, clusters[b].n) < total * 0.015;
        const eff = tiny ? d * 0.3 : d;
        if (eff < pd) {
          pd = eff;
          pa = a;
          pb = b;
        }
      }
    }
    if (pa < 0 || pd >= merge * (clusters.some((c) => c.n < total * 0.015) ? 3.5 : 1)) break;
    const A = clusters[pa];
    const B = clusters[pb];
    const nn = A.n + B.n;
    A.c = [(A.c[0] * A.n + B.c[0] * B.n) / nn, (A.c[1] * A.n + B.c[1] * B.n) / nn, (A.c[2] * A.n + B.c[2] * B.n) / nn];
    A.n = nn;
    clusters.splice(pb, 1);
  }

  // 3. 分配色块 + 众数滤波
  const label = new Int16Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    let bi = 0;
    let bd = Infinity;
    for (let c = 0; c < clusters.length; c++) {
      const d = dist(i, clusters[c].c);
      if (d < bd) {
        bd = d;
        bi = c;
      }
    }
    label[i] = bi;
  }
  const kc = clusters.length;
  const votes = new Int32Array(kc);
  for (let pass = 0; pass < 2 && kc > 1; pass++) {
    const next = new Int16Array(label);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (label[i] < 0) continue;
        votes.fill(0);
        // 3×3 众数：去掉碎点，同时保留驳领、门襟这类细线
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const l = label[yy * w + xx];
            if (l >= 0) votes[l]++;
          }
        }
        let best = label[i];
        for (let c = 0; c < kc; c++) if (votes[c] > votes[best]) best = c;
        next[i] = best;
      }
    }
    label.set(next);
  }
  // 色块颜色：取亮度在 55%~85% 分位之间的像素平均，避开褶皱阴影和高光
  const colors: Array<[number, number, number]> = [];
  const shares: number[] = [];
  for (let c = 0; c < kc; c++) {
    const Ls: number[] = [];
    for (let i = 0; i < n; i++) if (label[i] === c && data[i * 4 + 3] > 127) Ls.push(lab[i * 3]);
    Ls.sort((a, b) => a - b);
    const lo = Ls[Math.floor(Ls.length * 0.55)] ?? 0;
    const hi = Ls[Math.min(Ls.length - 1, Math.floor(Ls.length * 0.85))] ?? 100;
    let sa = 0;
    let sb = 0;
    let sl = 0;
    let m = 0;
    let all = 0;
    for (let i = 0; i < n; i++) {
      if (label[i] !== c) continue;
      all++;
      const L = lab[i * 3];
      if (data[i * 4 + 3] <= 127 || L < lo || L > hi) continue;
      sl += L;
      sa += lab[i * 3 + 1];
      sb += lab[i * 3 + 2];
      m++;
    }
    const c0 = clusters[c].c;
    const mean: Lab = m ? [sl / m, sa / m, sb / m] : [c0[0], c0[1], c0[2]];
    colors.push(labToRgb(mean));
    shares.push(all / count);
  }

  // 4. 立体感与描边
  const d = insideDistance(mask, w, h);
  const R = Math.max(4, Math.max(w, h) * 0.07);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      const l = label[i];
      const base = colors[l];
      let shade = 0.84 + 0.16 * smoothstep(0, R, d[i]);
      shade *= 1.04 - 0.08 * (y / h);
      // 最外圈描边
      if (d[i] < 1.6) shade *= 0.66;
      else {
        // 色块交界的细线
        const nb = [x > 0 ? label[i - 1] : l, x < w - 1 ? label[i + 1] : l, y > 0 ? label[i - w] : l, y < h - 1 ? label[i + w] : l];
        if (nb.some((v) => v >= 0 && v !== l && v < l)) shade *= 0.86;
      }
      out[i * 4] = base[0] * shade;
      out[i * 4 + 1] = base[1] * shade;
      out[i * 4 + 2] = base[2] * shade;
      // 轮廓外侧半个像素做抗锯齿
      out[i * 4 + 3] = Math.round(255 * smoothstep(0.5, 0.75, blurred[i]));
    }
  }
  const order = colors.map((rgb, k) => ({ rgb, share: shares[k] })).sort((a, b) => b.share - a.share);
  return { image: { width: w, height: h, data: out }, colors: order };
}
