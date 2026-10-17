// 量衣服的"基准宽度"，让人台上的大小不受拍照距离、袖子张开多少的影响。
//
// 上衣、外套量衣身（腋下以下、不含袖子的那一段），连衣裙量上身（腰线以上），下装量腰头。
// 人台上按身材和版型定出这一段该有多宽，再按照片里的真实比例得到衣长：
//   - 平铺时衣身宽度是半个胸围加放松量，所以照片的"厘米/像素"可以由身材推出来，衣长按这个比例换算；
//   - 穿在身上从正面看，衣服绕过身体侧面，看到的宽度比平铺窄（约为平铺的 0.65～0.7），
//     所以贴图横向按人台身体宽度来定，纵向按真实衣长来定，两个方向的缩放不一样。
// 全部是纯函数。

import type { Category, Fit } from './types';

export interface GarmentShape {
  /** 基准段（衣身 / 上身 / 腰头）的宽度，占贴图宽度的比例 */
  w: number;
  /** 基准段中心的横坐标，占贴图宽度的比例（衣服不一定在图里居中） */
  cx: number;
  /** 对齐线（上衣的肩线、去掉帽子后的上沿；下装的腰头上沿）的纵坐标，占贴图高度的比例 */
  top: number;
  /** 衣服最下沿（下摆、裤脚）的纵坐标，占贴图高度的比例 */
  bottom?: number;
}

type Run = [number, number];

function runsOf(row: Uint8Array, w: number, gap: number): Run[] {
  const runs: Run[] = [];
  let start = -1;
  let last = -1;
  for (let x = 0; x < w; x++) {
    if (!row[x]) continue;
    if (start >= 0 && x - last > gap) {
      runs.push([start, last]);
      start = -1;
    }
    if (start < 0) start = x;
    last = x;
  }
  if (start >= 0) runs.push([start, last]);
  return runs;
}

const quantile = (v: number[], q: number) => {
  const s = v.slice().sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : 0;
};

/** 量一件衣服；类别不适用或图太小时返回 null。hoodTop：帽子占贴图高度的比例（帽子不算衣身） */
export function measureShape(alpha: Uint8Array, w: number, h: number, category: Category, hoodTop = 0): GarmentShape | null {
  if (!['top', 'outer', 'dress', 'bottom'].includes(category)) return null;
  // 缩到最长边 240 计算
  const k = Math.min(1, 240 / Math.max(w, h));
  const gw = Math.max(1, Math.round(w * k));
  const gh = Math.max(1, Math.round(h * k));
  const m = new Uint8Array(gw * gh);
  const cnt = new Float32Array(gw * gh);
  const sum = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(gh - 1, Math.floor(y * k));
    for (let x = 0; x < w; x++) {
      const i = gy * gw + Math.min(gw - 1, Math.floor(x * k));
      sum[i] += alpha[y * w + x] > 127 ? 1 : 0;
      cnt[i]++;
    }
  }
  for (let i = 0; i < m.length; i++) m[i] = cnt[i] && sum[i] / cnt[i] >= 0.5 ? 1 : 0;
  const start = category === 'top' || category === 'outer' ? Math.round(hoodTop * gh) : 0;
  let y0 = -1;
  let y1 = -1;
  for (let y = start; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (!m[y * gw + x]) continue;
      if (y0 < 0) y0 = y;
      y1 = y;
      break;
    }
  }
  if (y0 < 0 || y1 - y0 < 10) return null;
  const H = y1 - y0 + 1;
  const gap = Math.max(1, Math.round(gw * 0.012));
  const rowRuns = (y: number) => runsOf(m.subarray(y * gw, (y + 1) * gw), gw, gap);
  const rows = (f0: number, f1: number) => {
    const out: number[] = [];
    for (let y = y0 + Math.floor(H * f0); y <= Math.min(y1, y0 + Math.ceil(H * f1)); y++) out.push(y);
    return out;
  };
  let widths: number[] = [];
  let centers: number[] = [];
  if (category === 'bottom') {
    // 腰头：最上面几行的整体宽度
    for (const y of rows(0, 0.06)) {
      const r = rowRuns(y);
      if (!r.length) continue;
      widths.push(r[r.length - 1][1] - r[0][0] + 1);
      centers.push((r[0][0] + r[r.length - 1][1]) / 2);
    }
  } else {
    // 衣身：中线所在的那一段（两侧分开的袖子不算）。袖子贴着衣身时这一段会偏宽，取偏小的分位数
    const [f0, f1] = category === 'dress' ? [0.18, 0.38] : [0.5, 0.95];
    const band = rows(f0, f1);
    // 先估计中线：这些行最外两端的中点
    const mids: number[] = [];
    for (const y of band) {
      const r = rowRuns(y);
      if (r.length) mids.push((r[0][0] + r[r.length - 1][1]) / 2);
    }
    const c = quantile(mids, 0.5);
    for (const y of band) {
      const r = rowRuns(y);
      if (!r.length) continue;
      let best = r[0];
      let bestD = Infinity;
      for (const run of r) {
        const d = c < run[0] ? run[0] - c : c > run[1] ? c - run[1] : 0;
        if (d < bestD) {
          bestD = d;
          best = run;
        }
      }
      widths.push(best[1] - best[0] + 1);
      centers.push((best[0] + best[1]) / 2);
    }
    const lo = quantile(widths, 0.3);
    // 只用接近这个宽度的行定中心
    const keep = widths.map((v) => v <= lo * 1.15);
    centers = centers.filter((_, i) => keep[i]);
    widths = [lo];
  }
  const width = category === 'bottom' ? quantile(widths, 0.5) : widths[0];
  if (!width || width < 4) return null;
  return {
    w: +(width / gw).toFixed(4),
    cx: +((quantile(centers, 0.5) + 0.5) / gw).toFixed(4),
    top: +(y0 / gh).toFixed(4),
    bottom: +((y1 + 1) / gh).toFixed(4),
  };
}

/** 平铺宽度相对于身体对应部位半围的放松量（版型越宽松越大） */
export function flatEase(category: Category, fit: Fit | undefined): number {
  const f = fit ?? 'regular';
  if (category === 'bottom') return f === 'slim' ? 1.0 : f === 'loose' ? 1.1 : 1.04;
  const base = f === 'slim' ? 1.05 : f === 'loose' ? 1.26 : 1.13;
  return category === 'outer' ? base + 0.08 : base;
}

/** 穿在身上从正面看的宽度相对于人台身体宽度的放松量 */
export function frontEase(category: Category, fit: Fit | undefined): number {
  const f = fit ?? 'regular';
  if (category === 'bottom') return f === 'slim' ? 1.04 : f === 'loose' ? 1.22 : 1.1;
  const base = f === 'slim' ? 1.06 : f === 'loose' ? 1.28 : 1.15;
  return category === 'outer' ? base + 0.08 : base;
}
