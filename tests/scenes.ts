// 测试用的平铺照片：床单（暖白、缓慢起伏的明暗、噪点）+ 衣服投下的软阴影 + 衣服。
// 用于检验白底上带白色部分的衣服、一张照片拍好几件。
import type { RGBAImage } from '../src/core/background';

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type RGB = [number, number, number];
export interface Scene {
  name: string;
  img: RGBAImage;
  truth: Uint8Array;
  /** 衣服上白色部分的掩码（用来统计保留比例） */
  white: Uint8Array;
  w: number;
  h: number;
}

/** 通用的 T 恤轮廓（坐标按 600×600） */
export function teeShape(x: number, y: number, s = 1): boolean {
  x /= s;
  y /= s;
  const torso = x >= 190 && x < 410 && y >= 120 && y < 520;
  const sleeveL = y >= 120 && y < 260 && x >= 90 && x < 190 && y - 120 < (x - 90) * 1.3 + 30;
  const sleeveR = y >= 120 && y < 260 && x >= 410 && x < 510 && y - 120 < (510 - x) * 1.3 + 30;
  const neck = (x - 300) ** 2 / 60 ** 2 + (y - 120) ** 2 / 34 ** 2 < 1;
  return (torso || sleeveL || sleeveR) && !neck;
}

function blurMask(m: Uint8Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    let c = 0;
    for (let d = -r; d <= r; d++) {
      const xx = x + d;
      if (xx >= 0 && xx < w) { a += m[y * w + xx]; c++; }
    }
    tmp[y * w + x] = a / c;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    let c = 0;
    for (let d = -r; d <= r; d++) {
      const yy = y + d;
      if (yy >= 0 && yy < h) { a += tmp[yy * w + x]; c++; }
    }
    out[y * w + x] = a / c;
  }
  return out;
}

/**
 * 画一张平铺照片：床单（暖白、缓慢起伏的明暗、噪点）+ 衣服投下的软阴影 + 衣服。
 * garment(x,y) 返回衣服在这一点的颜色，null 表示不在衣服上。
 */
export function photo(
  name: string,
  w: number,
  h: number,
  garment: (x: number, y: number) => RGB | null,
  isWhitePart: (x: number, y: number) => boolean,
  sheet: RGB = [238, 236, 230],
  seed = 1,
): Scene {
  const rand = rng(seed);
  const truth = new Uint8Array(w * h);
  const white = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (garment(x, y)) truth[y * w + x] = 1;
    if (truth[y * w + x] && isWhitePart(x, y)) white[y * w + x] = 1;
  }
  // 阴影：蒙版往右下偏 3 像素后模糊
  const shifted = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = x - 3;
    const sy = y - 4;
    if (sx >= 0 && sy >= 0 && truth[sy * w + sx]) shifted[y * w + x] = 1;
  }
  const shadow = blurMask(shifted, w, h, 5);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const n = (rand() - 0.5) * 8;
    let c: RGB;
    const g = garment(x, y);
    if (g) {
      // 衣服边缘 1~2 像素稍暗（布料厚度、卷边）
      let edge = false;
      for (let d = -2; d <= 2 && !edge; d++) {
        if (!garment(x + d, y) || !garment(x, y + d)) edge = true;
      }
      const k = edge ? 0.9 : 1;
      c = [g[0] * k + n, g[1] * k + n, g[2] * k + n];
    } else {
      // 床单：大范围的明暗起伏 + 阴影
      const wave = Math.sin(x * 0.011 + y * 0.007) * 5 + Math.sin(y * 0.02) * 3;
      const sh = 1 - 0.13 * shadow[i];
      c = [(sheet[0] + wave) * sh + n, (sheet[1] + wave) * sh + n, (sheet[2] + wave) * sh + n];
    }
    data.set([c[0], c[1], c[2], 255], i * 4);
  }
  return { name, img: { width: w, height: h, data }, truth, white, w, h };
}

const BLACK: RGB = [32, 32, 36];
const WHITE: RGB = [246, 246, 244];
const NAVY: RGB = [30, 42, 86];

/** k：缩放（1 = 600×600） */
export function scenes(k = 1): Scene[] {
  const W = Math.round(600 * k);
  const H = Math.round(600 * k);
  const at = <T>(f: (x: number, y: number) => T) => (x: number, y: number) => f(x / k, y / k);
  const list: Scene[] = [];
  // 1. 黑 T 恤：胸前白色印花、白色罗纹领口、白色下摆
  const collar = (x: number, y: number) => (x - 300) ** 2 / 76 ** 2 + (y - 120) ** 2 / 48 ** 2 < 1;
  const hem = (_x: number, y: number) => y >= 496;
  const print = (x: number, y: number) => x >= 250 && x < 350 && y >= 230 && y < 290 && (Math.floor(x / 10) + Math.floor(y / 10)) % 3 !== 0;
  list.push(
    photo(
      '黑T白印花白罗纹',
      W,
      H,
      at((x, y) => {
        if (!teeShape(x, y)) return null;
        if (collar(x, y) || hem(x, y) || print(x, y)) return WHITE;
        return BLACK;
      }),
      at((x, y) => collar(x, y) || hem(x, y) || print(x, y)),
    ),
  );
  // 2. 白 T 恤，胸前红色小图案
  const dot = (x: number, y: number) => (x - 300) ** 2 + (y - 250) ** 2 < 30 ** 2;
  list.push(
    photo(
      '白T恤',
      W,
      H,
      at((x, y) => (!teeShape(x, y) ? null : dot(x, y) ? ([170, 40, 45] as RGB) : WHITE)),
      at((x, y) => !dot(x, y)),
      [236, 234, 228],
      2,
    ),
  );
  // 3. 藏青白条纹 T 恤，白条纹一直延伸到侧缝和袖子
  list.push(
    photo(
      '藏青白条纹',
      W,
      H,
      at((x, y) => (!teeShape(x, y) ? null : Math.floor(y / 22) % 2 === 0 ? NAVY : WHITE)),
      at((_x, y) => Math.floor(y / 22) % 2 !== 0),
      [238, 236, 230],
      3,
    ),
  );
  return list;
}

export function score(s: Scene, alpha: Uint8Array) {
  let inter = 0;
  let union = 0;
  let wk = 0;
  let wt = 0;
  let leak = 0;
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i] > 127;
    const t = s.truth[i] === 1;
    if (a && t) inter++;
    if (a || t) union++;
    if (s.white[i]) {
      wt++;
      if (a) wk++;
    }
    if (a && !t) leak++;
  }
  return { iou: +(inter / union).toFixed(3), whiteKept: wt ? +(wk / wt).toFixed(3) : 1, leak };
}
