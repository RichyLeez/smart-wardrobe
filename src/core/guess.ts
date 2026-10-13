// 按去背后的轮廓猜类别：批量录入时先猜一个，用户点一下就能改。
// 只看形状（和裤子的颜色），规则来自平铺照片的常见轮廓：
//   - 裤子：下面分成两条腿、上面是一整条裤腰；长短看高宽比，腿口宽窄分阔腿裤；蓝色的算牛仔裤。
//   - 上衣：上部（袖子）明显比下部（衣身）宽，或袖子和衣身之间有空隙；袖子短的是 T 恤；很长的是大衣。
//   - 裙子：没有袖子、越往下越宽；高的是连衣裙，矮的是半身裙；顶上两条细带子的是吊带。
//   - 一双鞋：两块大小形状相近的长条。
//   - 很细长的是腰带，宽一些的长条是围巾；上面有提手、下面方方正正的是包。
// 猜不出来时返回 null。全部是纯函数。

import { hexToLab } from './color';
import type { Category } from './types';
import { components } from './mask';

export interface CategoryGuess {
  category: Category;
  /** 猜不出具体款式时为空字符串 */
  subtype: string;
  /** high：形状特征很明确；low：只是大致像 */
  confidence: 'high' | 'low';
  /** 中文说明，例如"下面分成两条腿" */
  reason: string;
}

interface Run {
  a: number;
  b: number;
}

/** 把裁好的不透明度缩到最长边不超过 maxSide 的 0/1 网格 */
function toGrid(alpha: Uint8Array, w: number, h: number, maxSide: number) {
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

function crop(g: Uint8Array, gw: number, gh: number) {
  let x0 = gw;
  let y0 = gh;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (!g[y * gw + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const W = x1 - x0 + 1;
  const H = y1 - y0 + 1;
  const m = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) m[y * W + x] = g[(y + y0) * gw + x + x0];
  return { m, W, H };
}

const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = v.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const quantile = (v: number[], q: number) => {
  if (!v.length) return 0;
  const s = v.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};

/** 牛仔蓝：偏蓝、不太亮也不太暗 */
function denimLike(hex: string | undefined): boolean {
  if (!hex) return false;
  const [L, a, b] = hexToLab(hex);
  const hue = (Math.atan2(b, a) * 180) / Math.PI;
  const chroma = Math.hypot(a, b);
  return L > 22 && L < 70 && chroma > 8 && hue < -60 && hue > -130 && a < 12;
}

/**
 * alpha：只含这一件的不透明度（可以是整张图，函数自己找外包框）。
 * colorHex：主色，用来区分牛仔裤。
 */
export function guessCategory(alpha: Uint8Array, w: number, h: number, colorHex?: string): CategoryGuess | null {
  const { g, gw, gh } = toGrid(alpha, w, h, 160);
  const c = crop(g, gw, gh);
  if (!c || c.W < 6 || c.H < 6) return null;
  const { m, W, H } = c;
  const ar = H / W;

  // 每一行的连续段（合并很窄的缝，去掉很短的段）
  const minRun = Math.max(1, Math.round(W * 0.02));
  const mergeGap = Math.max(1, Math.round(W * 0.015));
  const rows: Run[][] = [];
  for (let y = 0; y < H; y++) {
    const runs: Run[] = [];
    let start = -1;
    for (let x = 0; x <= W; x++) {
      const on = x < W && m[y * W + x] === 1;
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        const prev = runs[runs.length - 1];
        if (prev && start - prev.b - 1 <= mergeGap) prev.b = x - 1;
        else runs.push({ a: start, b: x - 1 });
        start = -1;
      }
    }
    rows.push(runs.filter((r) => r.b - r.a + 1 >= minRun));
  }
  const rowsIn = (f0: number, f1: number) => rows.slice(Math.floor(H * f0), Math.max(Math.floor(H * f0) + 1, Math.ceil(H * f1)));
  const span = (r: Run[]) => (r.length ? (r[r.length - 1].b - r[0].a + 1) / W : 0);
  const frac = (rs: Run[][], pred: (r: Run[]) => boolean) => (rs.length ? rs.filter(pred).length / rs.length : 0);
  let area = 0;
  for (let i = 0; i < m.length; i++) area += m[i];
  const fill = area / (W * H);

  // 分开的几块
  const comp = components(m, W, H, true);
  const largest = Math.max(0, ...comp.areas.slice(1));
  const big = comp.areas.map((a, i) => (i > 0 && a >= largest * 0.15 ? i : 0)).filter(Boolean);
  if (big.length === 2) {
    const [p, q] = big.map((l) => {
      let x0 = W;
      let y0 = H;
      let x1 = -1;
      let y1 = -1;
      for (let i = 0; i < m.length; i++) {
        if (comp.labels[i] !== l) continue;
        const x = i % W;
        const y = (i - x) / W;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
      const bw = x1 - x0 + 1;
      const bh = y1 - y0 + 1;
      return { area: comp.areas[l], elong: Math.max(bw, bh) / Math.min(bw, bh) };
    });
    const similar = Math.min(p.area, q.area) / Math.max(p.area, q.area) >= 0.5;
    if (similar && p.elong >= 1.3 && q.elong >= 1.3) {
      return { category: 'shoes', subtype: '', confidence: 'low', reason: '两块大小形状相近，像一双鞋' };
    }
  }
  if (big.length >= 3) return null;

  // 左右对称程度（和自己的镜像的重合比例）：平铺的衣服、裤子、裙子基本对称，袜子、侧面的鞋不对称
  let inter = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x] && m[y * W + (W - 1 - x)]) inter++;
  const symmetric = area > 0 && inter / area >= 0.75;

  // 裤子：下面两条腿，上面一整条裤腰
  const bottomRows = rowsIn(0.75, 0.95);
  const legs = frac(bottomRows, (r) => r.length === 2 && r[1].a - r[0].b - 1 >= W * 0.05);
  const waist = frac(rowsIn(0, 0.12), (r) => r.length === 1 && span(r) >= 0.6);
  if (symmetric && legs >= 0.6 && waist >= 0.6) {
    if (ar < 1.3) return { category: 'bottom', subtype: '短裤', confidence: 'high', reason: '下面分成两条腿，长度较短' };
    const legW = median(bottomRows.filter((r) => r.length === 2).map((r) => (r[0].b - r[0].a + 1 + r[1].b - r[1].a + 1) / 2 / W));
    const waistW = median(rowsIn(0, 0.1).map(span));
    if (waistW > 0 && legW / waistW >= 0.6) return { category: 'bottom', subtype: '阔腿裤', confidence: 'high', reason: '两条腿，裤腿很宽' };
    if (denimLike(colorHex)) return { category: 'bottom', subtype: '牛仔裤', confidence: 'high', reason: '两条腿，牛仔蓝' };
    return { category: 'bottom', subtype: '休闲裤', confidence: 'low', reason: '下面分成两条腿' };
  }

  // 有没有袖子：上部比衣身宽，或者袖子和衣身之间有空隙（三段）
  const upper = quantile(rowsIn(0.05, 0.35).map(span), 0.8);
  const body = median(rowsIn(0.6, 0.9).map(span));
  const threeRuns = frac(rowsIn(0.1, 0.6), (r) => r.length === 3);
  if (symmetric && body > 0 && (upper >= body * 1.3 || threeRuns >= 0.25)) {
    const lenRatio = H / (body * W);
    const ext = (upper - body) / 2 / body;
    let sleeveEnd = 0;
    for (let y = 0; y < H; y++) {
      if (span(rows[y]) > body * 1.12 || rows[y].length === 3) sleeveEnd = y / H;
    }
    const longSleeve = ext >= 0.55 || sleeveEnd >= 0.5;
    if (!longSleeve) {
      return lenRatio >= 2
        ? { category: 'dress', subtype: '连衣裙', confidence: 'low', reason: '短袖，长度到膝盖左右' }
        : { category: 'top', subtype: 'T恤', confidence: 'high', reason: '短袖' };
    }
    // 长外套：衣身比袖子长出一大截
    if (lenRatio >= 1.75 && sleeveEnd <= 0.72) return { category: 'outer', subtype: '大衣', confidence: 'low', reason: '长袖，衣长很长' };
    return { category: 'top', subtype: '', confidence: 'low', reason: '长袖上衣' };
  }

  // 没有袖子
  const elong = Math.max(ar, 1 / ar);
  if (elong >= 5) return { category: 'belt', subtype: '皮带', confidence: 'low', reason: '很细的长条' };
  // 横着的矮长块：侧面拍的鞋（一双前后叠着）
  if (ar <= 1 / 1.6 && fill >= 0.45 && fill <= 0.85) {
    return { category: 'shoes', subtype: '', confidence: 'low', reason: '横着的矮长块，像侧面拍的鞋' };
  }
  // 包：提手围出一个空洞（在上半部分）
  const holeTop = (() => {
    const outside = new Uint8Array(W * H);
    const stack: number[] = [];
    const push = (i: number) => {
      if (!m[i] && !outside[i]) {
        outside[i] = 1;
        stack.push(i);
      }
    };
    for (let x = 0; x < W; x++) {
      push(x);
      push((H - 1) * W + x);
    }
    for (let y = 0; y < H; y++) {
      push(y * W);
      push(y * W + W - 1);
    }
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % W;
      if (x > 0) push(i - 1);
      if (x < W - 1) push(i + 1);
      if (i >= W) push(i - W);
      if (i < W * H - W) push(i + W);
    }
    let holes = 0;
    for (let i = 0; i < W * H; i++) if (!m[i] && !outside[i] && i < W * H * 0.45) holes++;
    return holes / (W * H);
  })();
  if (holeTop >= 0.03) return { category: 'bag', subtype: '手提包', confidence: 'low', reason: '上面有提手围成的空当' };
  const topRows = rowsIn(0, 0.12);
  const straps = frac(topRows, (r) => r.length >= 2 && r.every((x) => (x.b - x.a + 1) / W <= 0.2));
  if (symmetric && straps >= 0.5) {
    const mid = median(rowsIn(0.3, 0.45).map(span));
    const flare = mid > 0 && median(rowsIn(0.8, 0.95).map(span)) >= mid * 1.5;
    if (flare) return { category: 'dress', subtype: '连衣裙', confidence: 'low', reason: '顶上两条带子，下面裙摆展开' };
    return ar >= 1.6
      ? { category: 'dress', subtype: '吊带裙', confidence: 'low', reason: '顶上两条细带子，长度较长' }
      : { category: 'top', subtype: '吊带', confidence: 'low', reason: '顶上两条细带子' };
  }
  const topSpan = median(rowsIn(0.02, 0.12).map(span));
  const lowSpan = median(rowsIn(0.8, 0.95).map(span));
  const single = frac(rowsIn(0.3, 0.95), (r) => r.length === 1);
  if (symmetric && topSpan > 0 && lowSpan >= topSpan * 1.2 && single >= 0.8 && ar >= 0.6) {
    return ar >= 1.35
      ? { category: 'dress', subtype: '连衣裙', confidence: 'low', reason: '没有袖子，越往下越宽，长度较长' }
      : { category: 'bottom', subtype: '半身裙', confidence: 'high', reason: '没有袖子，从腰头往下变宽' };
  }
  const shoulders = frac(rowsIn(0, 0.1), (r) => r.length === 2 && r.every((x) => (x.b - x.a + 1) / W > 0.1));
  if (symmetric && shoulders >= 0.5 && single >= 0.8) {
    return ar >= 1.7
      ? { category: 'dress', subtype: '连衣裙', confidence: 'low', reason: '无袖，长度较长' }
      : { category: 'top', subtype: '背心', confidence: 'low', reason: '无袖，肩部两条' };
  }
  if (elong >= 2.2 && fill >= 0.75) return { category: 'scarf', subtype: '围巾', confidence: 'low', reason: '宽的长条' };
  // 包：上面是提手（两段或中间空），下面方正结实
  const handle = frac(rowsIn(0, 0.3), (r) => r.length >= 2);
  const lowerFill = (() => {
    let a = 0;
    let t = 0;
    for (let y = Math.floor(H * 0.45); y < H; y++) for (let x = 0; x < W; x++) {
      t++;
      a += m[y * W + x];
    }
    return t ? a / t : 0;
  })();
  if (handle >= 0.4 && lowerFill >= 0.8) return { category: 'bag', subtype: '手提包', confidence: 'low', reason: '上面有提手，包身方正' };
  return null;
}
