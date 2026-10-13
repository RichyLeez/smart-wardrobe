// 衣服有没有碰到照片边缘：碰到边缘的部分会被当成背景去掉（去背时照片四周一圈一定算背景），
// 拍的时候没拍全（下摆、袖子出了画面）也会这样。录入时提示往后退一点重拍。
//
// 只看去背结果不够：贴边的那块常常已经被去掉了。所以从留下的衣服出发，
// 沿颜色连续、又像衣服颜色的像素往外长，长到照片边缘的就是"衣服还在往外延伸"。
// 全部是纯函数。

import type { RGBAImage } from './background';
import { deltaE, kmeansLab, rgbToLab, type Lab } from './color';
import { erode } from './mask';

export type FrameSide = 'top' | 'right' | 'bottom' | 'left';

export interface FrameContact {
  /** 衣服碰到的边（按上、右、下、左排列） */
  sides: FrameSide[];
  /** 每条边上被衣服占到的比例 */
  share: Record<FrameSide, number>;
}

export const FRAME_SIDE_LABELS: Record<FrameSide, string> = { top: '上', right: '右', bottom: '下', left: '左' };

const ORDER: FrameSide[] = ['top', 'right', 'bottom', 'left'];

/** "衣服碰到了照片的左边和上边" */
export function frameContactText(sides: FrameSide[]): string {
  if (!sides.length) return '';
  const names = sides.map((s) => `${FRAME_SIDE_LABELS[s]}边`);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join('、')}和${names[names.length - 1]}`;
  return `衣服碰到了照片的${list}`;
}

export function frameContact(img: RGBAImage, alpha: Uint8Array, minShare = 0.05): FrameContact {
  const { width: W0, height: H0, data } = img;
  const empty: FrameContact = { sides: [], share: { top: 0, right: 0, bottom: 0, left: 0 } };
  // 缩到最长边 240 计算
  const k = Math.min(1, 240 / Math.max(W0, H0));
  const w = Math.max(2, Math.round(W0 * k));
  const h = Math.max(2, Math.round(H0 * k));
  const n = w * h;
  const sum = new Float32Array(n * 4);
  const cnt = new Float32Array(n);
  for (let y = 0; y < H0; y++) {
    const gy = Math.min(h - 1, Math.floor(y * k));
    for (let x = 0; x < W0; x++) {
      const gx = Math.min(w - 1, Math.floor(x * k));
      const g = gy * w + gx;
      const s = y * W0 + x;
      sum[g * 4] += data[s * 4];
      sum[g * 4 + 1] += data[s * 4 + 1];
      sum[g * 4 + 2] += data[s * 4 + 2];
      sum[g * 4 + 3] += alpha[s] > 127 ? 1 : 0;
      cnt[g]++;
    }
  }
  const lab: Lab[] = new Array(n);
  const fg = new Uint8Array(n);
  let area = 0;
  for (let i = 0; i < n; i++) {
    const c = cnt[i] || 1;
    lab[i] = rgbToLab(sum[i * 4] / c, sum[i * 4 + 1] / c, sum[i * 4 + 2] / c);
    if (sum[i * 4 + 3] / c >= 0.5) {
      fg[i] = 1;
      area++;
    }
  }
  if (area < 20) return empty;
  // 衣服的几种主要颜色：只取衣服里面（边缘一圈和背景混色），占比太小的不算
  const inner = erode(fg, w, h, 2);
  let innerArea = 0;
  for (let i = 0; i < n; i++) innerArea += inner[i];
  const src = innerArea >= 20 ? inner : fg;
  const stride = Math.max(1, Math.floor((innerArea || area) / 3000));
  const samples: Lab[] = [];
  for (let i = 0, s = 0; i < n; i++) if (src[i] && s++ % stride === 0) samples.push(lab[i]);
  const centres = kmeansLab(samples, 4)
    .filter((c) => c.weight >= 0.04)
    .map((c) => c.lab);
  const likeGarment = (l: Lab) => centres.some((c) => deltaE(l, c) < 14);
  // 从衣服往外长：和相邻像素颜色连续（ΔE < 7），又像衣服的颜色
  const region = new Uint8Array(fg);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) if (fg[i]) queue[tail++] = i;
  let grown = 0;
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const visit = (j: number) => {
      if (region[j]) return;
      if (deltaE(lab[i], lab[j]) >= 7 || !likeGarment(lab[j])) return;
      region[j] = 1;
      grown++;
      queue[tail++] = j;
    };
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (i >= w) visit(i - w);
    if (i < n - w) visit(i + w);
  }
  // 长出来的比衣服本身还多：背景和衣服颜色太像，说不清是不是碰到了边缘
  if (grown > area * 0.6) return empty;
  // 每条边：最外两圈里属于衣服（或衣服延伸）的比例
  const share: Record<FrameSide, number> = { top: 0, right: 0, bottom: 0, left: 0 };
  const line = (side: FrameSide) => {
    let hit = 0;
    const len = side === 'top' || side === 'bottom' ? w : h;
    for (let t = 0; t < len; t++) {
      let on = false;
      for (let d = 0; d < 2 && !on; d++) {
        const x = side === 'left' ? d : side === 'right' ? w - 1 - d : t;
        const y = side === 'top' ? d : side === 'bottom' ? h - 1 - d : t;
        on = region[y * w + x] === 1;
      }
      if (on) hit++;
    }
    return hit / len;
  };
  for (const s of ORDER) share[s] = line(s);
  return { sides: ORDER.filter((s) => share[s] >= minShare), share };
}
