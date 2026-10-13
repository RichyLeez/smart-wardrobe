// 蒙版工具：腐蚀 / 膨胀、连通块标记、外包框。全部是纯函数。

/** 正方形结构元素的腐蚀 / 膨胀（可分离的滑动最小 / 最大值），mask 为 0/1 */
export function morph(src: Uint8Array, w: number, h: number, r: number, erode: boolean): Uint8Array {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const stop = erode ? 0 : 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = erode ? 1 : 0;
      for (let d = -r; d <= r; d++) {
        const xx = x + d;
        const s = xx < 0 || xx >= w ? 0 : src[y * w + xx];
        v = erode ? Math.min(v, s) : Math.max(v, s);
        if (v === stop) break;
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = erode ? 1 : 0;
      for (let d = -r; d <= r; d++) {
        const yy = y + d;
        const s = yy < 0 || yy >= h ? 0 : tmp[yy * w + x];
        v = erode ? Math.min(v, s) : Math.max(v, s);
        if (v === stop) break;
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

export const dilate = (m: Uint8Array, w: number, h: number, r: number) => morph(m, w, h, r, false);
export const erode = (m: Uint8Array, w: number, h: number, r: number) => morph(m, w, h, r, true);

/** 连通块标记：labels 中 0 表示不属于前景，areas[k] 为第 k 块的面积（areas[0] 恒为 0） */
export function components(mask: Uint8Array, w: number, h: number, eight = false): { labels: Int32Array; areas: number[]; count: number } {
  const n = w * h;
  const labels = new Int32Array(n);
  const areas: number[] = [0];
  const stack = new Int32Array(n);
  let next = 0;
  for (let s = 0; s < n; s++) {
    if (!mask[s] || labels[s]) continue;
    next++;
    let top = 0;
    stack[top++] = s;
    labels[s] = next;
    let area = 0;
    while (top > 0) {
      const i = stack[--top];
      area++;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx === 0 && dy === 0) || (!eight && dx !== 0 && dy !== 0)) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (mask[j] && !labels[j]) {
            labels[j] = next;
            stack[top++] = j;
          }
        }
      }
    }
    areas.push(area);
  }
  return { labels, areas, count: next };
}

export interface MaskBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
  /** 外包框较长的一边 */
  size: number;
}

export function maskBox(fg: Uint8Array, w: number, h: number): MaskBox {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  let area = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!fg[y * w + x]) continue;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { x0, y0, x1, y1, area, size: area ? Math.max(x1 - x0 + 1, y1 - y0 + 1) : 0 };
}

/** 不透明度（0~255）转成 0/1 前景 */
export function binarize(alpha: Uint8Array, threshold = 127): Uint8Array {
  const out = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) out[i] = alpha[i] > threshold ? 1 : 0;
  return out;
}
