// 补回和背景同色的衣服部分。
// 白底上拍带白色的衣服（白色印花、白条纹）时，这些白色和背景几乎一样，去背会把它们当成背景挖掉。
// 衣服平铺时是一整块，所以按形状判断：
//   1. 被衣服围住的空洞：小的，或四周都是厚厚一圈衣服的（胸前印花），补回来；
//      大部分边上只隔着一条细带子就是外面的（包带中间、项链圈里），是真的镂空，保持去掉。
//   2. 衣服被切成三条以上平行的碎块（条纹的深色条），碎块之间的窄缝补上。
// 全部是纯函数。

import { components, maskBox } from './mask';

export interface GapResult {
  /** 补回之后的前景（0/1） */
  fg: Uint8Array;
  /** 1 = 这次补回来的像素 */
  added: Uint8Array;
  addedCount: number;
  /** 补了几个空洞、几条缝 */
  holes: number;
  bridged: number;
}

/** 条纹：三块以上的碎块之间、横向或纵向的窄缝补上 */
function bridgeStripes(fg: Uint8Array, added: Uint8Array, w: number, h: number, size: number, total: number): number {
  const { labels, areas } = components(fg, w, h);
  const big = areas.map((a, i) => i > 0 && a >= total * 0.01);
  const bigCount = big.filter(Boolean).length;
  if (bigCount < 3) return 0;
  const maxGap = Math.max(2, Math.round(size * 0.1));
  const fill: number[] = [];
  let pairs = 0;
  const scan = (len: number, at: (k: number) => number) => {
    let lastLabel = 0;
    let lastK = -1;
    for (let k = 0; k < len; k++) {
      const i = at(k);
      const l = labels[i];
      if (!l || !big[l]) continue;
      const gap = k - lastK - 1;
      if (lastLabel && l !== lastLabel && gap > 0 && gap <= maxGap) {
        for (let m = lastK + 1; m < k; m++) fill.push(at(m));
        pairs++;
      }
      lastLabel = l;
      lastK = k;
    }
  };
  for (let x = 0; x < w; x++) scan(h, (k) => k * w + x);
  for (let y = 0; y < h; y++) scan(w, (k) => y * w + k);
  let count = 0;
  for (const i of fill) {
    if (!fg[i]) {
      fg[i] = 1;
      added[i] = 1;
      count++;
    }
  }
  return pairs > 0 ? count : 0;
}

/** 被衣服围住的空洞：小的，或大部分边上衣服都很厚的，补回来 */
function fillHoles(fg: Uint8Array, added: Uint8Array, w: number, h: number, size: number, total: number): number {
  const n = w * h;
  // 外面：从画面边缘连通的非前景
  const outside = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const push = (i: number) => {
    if (!fg[i] && !outside[i]) {
      outside[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < n - w) push(i + w);
  }
  const holeMask = new Uint8Array(n);
  let anyHole = false;
  for (let i = 0; i < n; i++) {
    if (!fg[i] && !outside[i]) {
      holeMask[i] = 1;
      anyHole = true;
    }
  }
  if (!anyHole) return 0;

  // 衣服每个像素离外面有多远（只穿过衣服本身）
  const dist = new Int32Array(n).fill(-1);
  head = 0;
  tail = 0;
  for (let i = 0; i < n; i++) {
    if (outside[i]) {
      dist[i] = 0;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const d = dist[i] + 1;
    const visit = (j: number) => {
      if (fg[j] && dist[j] < 0) {
        dist[j] = d;
        queue[tail++] = j;
      }
    };
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (i >= w) visit(i - w);
    if (i < n - w) visit(i + w);
  }

  const { labels, areas } = components(holeMask, w, h);
  const edge = new Int32Array(areas.length);
  const thin = new Int32Array(areas.length);
  const thinLimit = size * 0.05;
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (!l) continue;
    const x = i % w;
    // 空洞边上的衣服像素：这一圈衣服有多厚
    let nearest = Infinity;
    if (x > 0 && fg[i - 1]) nearest = Math.min(nearest, dist[i - 1]);
    if (x < w - 1 && fg[i + 1]) nearest = Math.min(nearest, dist[i + 1]);
    if (i >= w && fg[i - w]) nearest = Math.min(nearest, dist[i - w]);
    if (i < n - w && fg[i + w]) nearest = Math.min(nearest, dist[i + w]);
    if (nearest === Infinity) continue;
    edge[l]++;
    if (nearest < thinLimit) thin[l]++;
  }
  const fillIt = areas.map((a, l) => l > 0 && (a <= total * 0.015 || thin[l] < edge[l] * 0.35));
  let count = 0;
  let holes = 0;
  const counted = new Uint8Array(areas.length);
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (l && fillIt[l]) {
      fg[i] = 1;
      added[i] = 1;
      count++;
      if (!counted[l]) {
        counted[l] = 1;
        holes++;
      }
    }
  }
  return holes;
}

/**
 * 补回和背景同色的衣服部分。fg 为 0/1（或 0~255，>127 视为前景）。
 * keepOut：用户用"擦除"涂过的像素（1），不会被补回。
 */
export function fillGarmentGaps(mask: Uint8Array, w: number, h: number, keepOut?: Uint8Array): GapResult {
  const n = w * h;
  const fg = new Uint8Array(n);
  // 0/1 蒙版或 0~255 的不透明度都可以
  let max = 0;
  for (let i = 0; i < n; i++) if (mask[i] > max) max = mask[i];
  const cut = max > 1 ? 127 : 0;
  for (let i = 0; i < n; i++) fg[i] = mask[i] > cut ? 1 : 0;
  const added = new Uint8Array(n);
  const box = maskBox(fg, w, h);
  if (box.area === 0) return { fg, added, addedCount: 0, holes: 0, bridged: 0 };
  const bridged = bridgeStripes(fg, added, w, h, box.size, box.area) > 0 ? 1 : 0;
  const holes = fillHoles(fg, added, w, h, box.size, box.area);
  let addedCount = 0;
  for (let i = 0; i < n; i++) {
    if (added[i] && keepOut?.[i] === 1) {
      fg[i] = 0;
      added[i] = 0;
    }
    addedCount += added[i];
  }
  return { fg, added, addedCount, holes, bridged };
}
