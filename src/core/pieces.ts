// 一张照片里拍了好几件：把去背结果拆成一件一件。
// 衣服之间隔开一段距离，前景膨胀半个间距后仍然分开的就是不同的单品；
// 靠得很近的几块（一双鞋、一对耳环、被去背切断的带子）算同一件。
// 全部是纯函数。

import { binarize, components, dilate } from './mask';

export interface Piece {
  /** 外包框（含），原图坐标 */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 不透明像素数 */
  area: number;
  /** 与原图同尺寸的不透明度，只含这一件 */
  alpha: Uint8Array;
}

export interface SplitOptions {
  /** 两块之间小于这个距离（像素）算同一件；默认为图片较长边的 2.5% */
  joinGap?: number;
  /** 小于这个面积（像素）的当作碎屑去掉；默认为图片面积的 0.15% */
  minArea?: number;
}

export function splitPieces(alpha: Uint8Array, w: number, h: number, options: SplitOptions = {}): Piece[] {
  const fg = binarize(alpha);
  const joinGap = options.joinGap ?? Math.max(4, Math.round(Math.max(w, h) * 0.025));
  const minArea = options.minArea ?? Math.round(w * h * 0.0015);
  const grown = dilate(fg, w, h, Math.ceil(joinGap / 2));
  const { labels, count } = components(grown, w, h, true);
  const boxes = Array.from({ length: count + 1 }, () => ({ x0: w, y0: h, x1: -1, y1: -1, area: 0 }));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!fg[i]) continue;
      const b = boxes[labels[i]];
      b.area++;
      if (x < b.x0) b.x0 = x;
      if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y;
      if (y > b.y1) b.y1 = y;
    }
  }
  const keep = boxes.map((b, l) => l > 0 && b.area >= minArea);
  const pieces: Piece[] = [];
  const index = new Int32Array(count + 1).fill(-1);
  for (let l = 1; l <= count; l++) {
    if (!keep[l]) continue;
    index[l] = pieces.length;
    pieces.push({ ...boxes[l], alpha: new Uint8Array(w * h) });
  }
  for (let i = 0; i < w * h; i++) {
    if (!alpha[i]) continue;
    const k = index[labels[i]];
    if (k >= 0) pieces[k].alpha[i] = alpha[i];
  }
  // 按阅读顺序排：先上后下（同一行的从左到右）
  const rowH = Math.max(1, Math.round(h * 0.12));
  pieces.sort((a, b) => {
    const ra = Math.floor((a.y0 + a.y1) / 2 / rowH);
    const rb = Math.floor((b.y0 + b.y1) / 2 / rowH);
    return ra !== rb ? ra - rb : a.x0 - b.x0;
  });
  return pieces;
}
