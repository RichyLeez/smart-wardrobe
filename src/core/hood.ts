// 连帽上衣的帽子：平铺拍照时帽子摊在领口上方，穿在身上时垂在背后，从正面看不到。
// 从去背后的轮廓量出帽子占图片高度的比例，人台上按肩线对齐、把这一段藏起来（试穿时把帽子放下）。
// 全部是纯函数。

interface Profile {
  /** 每行最左、最右的不透明像素（没有时为 -1） */
  left: Int32Array;
  right: Int32Array;
  /** 每行不透明的段数 */
  runs: Uint8Array;
  /** 每行不透明像素个数 */
  count: Int32Array;
  top: number;
  bottom: number;
  x0: number;
  x1: number;
}

function profile(alpha: Uint8Array, w: number, h: number): Profile | null {
  const left = new Int32Array(h).fill(-1);
  const right = new Int32Array(h).fill(-1);
  const runs = new Uint8Array(h);
  const count = new Int32Array(h);
  let top = -1;
  let bottom = -1;
  let x0 = w;
  let x1 = -1;
  const minGap = Math.max(2, Math.round(w * 0.015));
  for (let y = 0; y < h; y++) {
    let last = -1;
    let r = 0;
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] <= 127) continue;
      count[y]++;
      if (left[y] < 0) left[y] = x;
      if (last < 0 || x - last > minGap) r++;
      last = x;
      right[y] = x;
    }
    runs[y] = Math.min(255, r);
    if (left[y] >= 0) {
      if (top < 0) top = y;
      bottom = y;
      x0 = Math.min(x0, left[y]);
      x1 = Math.max(x1, right[y]);
    }
  }
  if (top < 0) return null;
  return { left, right, runs, count, top, bottom, x0, x1 };
}

const median = (v: number[]) => (v.length ? v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)] : 0);

/**
 * 帽子：上衣最上面一段是一整块、比下摆窄得多的圆顶（平铺时帽子摊在领口上方）。
 * 返回帽子占整张图高度的比例（保留帽子根部一小截当领口）；没有帽子时返回 0。
 * 穿在身上时帽子垂在背后，从正面看不到，人台上要把这部分藏起来，并按肩线对齐。
 */
export function hoodTop(alpha: Uint8Array, w: number, h: number): number {
  const p = profile(alpha, w, h);
  if (!p) return 0;
  const H = p.bottom - p.top + 1;
  const cx = Math.round((p.x0 + p.x1) / 2);
  const gap = Math.max(2, Math.round(w * 0.015));
  /** 这一行里中线所在（或离中线最近）的那一段的宽度；两侧分开的袖子不算 */
  const centreRun = (y: number) => {
    let best = 0;
    let bestD = Infinity;
    let start = -1;
    let last = -1;
    const flush = () => {
      if (start < 0) return;
      const d = cx < start ? start - cx : cx > last ? cx - last : 0;
      if (d < bestD) {
        bestD = d;
        best = last - start + 1;
      }
    };
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] <= 127) continue;
      if (start >= 0 && x - last > gap) {
        flush();
        start = -1;
      }
      if (start < 0) start = x;
      last = x;
    }
    flush();
    return best;
  };
  const hemRows: number[] = [];
  for (let y = p.top + Math.floor(H * 0.8); y <= p.top + Math.floor(H * 0.95); y++) hemRows.push(centreRun(y));
  const hem = median(hemRows);
  if (hem < 8) return 0;
  let k = 0;
  let single = 0;
  for (let y = p.top; y <= p.bottom; y++) {
    if (centreRun(y) > hem * 0.62) break;
    if (p.runs[y] === 1) single++;
    k++;
  }
  const frac = k / H;
  if (frac < 0.12 || frac > 0.45) return 0;
  // 帽子是一整块（背心、吊带的两条肩带不算）
  if (single / k < 0.8) return 0;
  // 帽子下面紧接着是肩膀，一下子变宽（裙腰往下是慢慢变宽的）
  const below = Math.min(p.bottom, p.top + k + Math.round(H * 0.06));
  if (centreRun(below) < hem * 0.85) return 0;
  // 图片上沿到衣服上沿之间可能还留着一点空白；保留帽子根部一小截当领口
  return Math.max(0, (p.top + k) / h - 0.03);
}
