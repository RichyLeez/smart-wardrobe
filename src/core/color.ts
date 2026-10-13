// 颜色工具：sRGB → CIELAB 转换、主色提取（k-means）、中文色名匹配与配色判断。

export type Lab = [number, number, number];
export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full.slice(0, 6), 16);
  if (Number.isNaN(n)) return [128, 128, 128];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: RGB): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function srgbToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, c * 255));
}

// 预计算 0~255 的线性值，图像批量转换时更快
const LINEAR_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) LINEAR_LUT[i] = srgbToLinear(i);

const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;

function fLab(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

export function rgbToLab(r: number, g: number, b: number): Lab {
  const lr = LINEAR_LUT[r | 0];
  const lg = LINEAR_LUT[g | 0];
  const lb = LINEAR_LUT[b | 0];
  const x = (lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / XN;
  const y = (lr * 0.2126 + lg * 0.7152 + lb * 0.0722) / YN;
  const z = (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / ZN;
  const fx = fLab(x);
  const fy = fLab(y);
  const fz = fLab(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToRgb([L, a, b]: Lab): RGB {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const x = inv(fx) * XN;
  const y = inv(fy) * YN;
  const z = inv(fz) * ZN;
  const lr = x * 3.2406 + y * -1.5372 + z * -0.4986;
  const lg = x * -0.9689 + y * 1.8758 + z * 0.0415;
  const lb = x * 0.0557 + y * -0.204 + z * 1.057;
  return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)];
}

export function hexToLab(hex: string): Lab {
  const [r, g, b] = hexToRgb(hex);
  return rgbToLab(r, g, b);
}

export function deltaE(a: Lab, b: Lab): number {
  const dl = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

/** 色度（饱和程度） */
export function chroma(lab: Lab): number {
  return Math.sqrt(lab[1] * lab[1] + lab[2] * lab[2]);
}

/** 色相角 0~360 */
export function hue(lab: Lab): number {
  const h = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
  return h < 0 ? h + 360 : h;
}

export function hueDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// ---------- 中文色名 ----------

export interface NamedColor {
  name: string;
  hex: string;
  /** 时尚搭配中可作为"百搭色"的颜色 */
  neutral: boolean;
}

export const PALETTE: NamedColor[] = [
  { name: '黑色', hex: '#1c1c1e', neutral: true },
  { name: '深灰', hex: '#48484c', neutral: true },
  { name: '灰色', hex: '#8a8a8f', neutral: true },
  { name: '浅灰', hex: '#c8c8cc', neutral: true },
  { name: '白色', hex: '#f7f7f5', neutral: true },
  { name: '米白', hex: '#eee6d8', neutral: true },
  { name: '米色', hex: '#ddcdb0', neutral: true },
  { name: '卡其', hex: '#bfa477', neutral: true },
  { name: '驼色', hex: '#a87a4c', neutral: true },
  { name: '棕色', hex: '#734d30', neutral: true },
  { name: '咖啡', hex: '#4a3324', neutral: true },
  { name: '藏青', hex: '#1f2a44', neutral: true },
  { name: '牛仔蓝', hex: '#4b6b8f', neutral: true },
  { name: '军绿', hex: '#5a5d3a', neutral: true },
  { name: '雾霾蓝', hex: '#8297ab', neutral: false },
  { name: '浅蓝', hex: '#a8c5e2', neutral: false },
  { name: '蓝色', hex: '#2f5db3', neutral: false },
  { name: '墨绿', hex: '#2c4a3a', neutral: false },
  { name: '绿色', hex: '#3d8b4c', neutral: false },
  { name: '薄荷绿', hex: '#a6dbc2', neutral: false },
  { name: '红色', hex: '#c7313b', neutral: false },
  { name: '酒红', hex: '#6d1e2d', neutral: false },
  { name: '粉色', hex: '#f0b5c4', neutral: false },
  { name: '橙色', hex: '#e67f37', neutral: false },
  { name: '黄色', hex: '#f0cd48', neutral: false },
  { name: '紫色', hex: '#6b4a9d', neutral: false },
  { name: '浅紫', hex: '#c4b5dc', neutral: false },
];

const PALETTE_LAB = PALETTE.map((p) => ({ ...p, lab: hexToLab(p.hex) }));

export function nearestColorName(lab: Lab): NamedColor {
  let best = PALETTE_LAB[0];
  let bestD = Infinity;
  for (const p of PALETTE_LAB) {
    // 明度差权重略低，避免同一颜色因为光线明暗被识别成别的颜色
    const dl = (lab[0] - p.lab[0]) * 0.75;
    const da = lab[1] - p.lab[1];
    const db = lab[2] - p.lab[2];
    const dist = dl * dl + da * da + db * db;
    if (dist < bestD) {
      bestD = dist;
      best = p;
    }
  }
  return { name: best.name, hex: best.hex, neutral: best.neutral };
}

export function paletteByName(name: string): NamedColor | undefined {
  return PALETTE.find((p) => p.name === name);
}

/**
 * 判断颜色在搭配中是否属于中性色。
 * 依据色名（黑白灰、米驼棕、藏青、牛仔蓝、军绿）或者低色度。
 */
export function isNeutralColor(hex: string, name?: string): boolean {
  const lab = hexToLab(hex);
  if (chroma(lab) < 12) return true;
  const named = name ? paletteByName(name) : undefined;
  if (named) return named.neutral;
  return nearestColorName(lab).neutral;
}

// ---------- 主色提取 ----------

export interface ColorCluster {
  hex: string;
  lab: Lab;
  /** 占比 0~1 */
  weight: number;
}

/** 可复现的伪随机数（mulberry32） */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 从 RGBA 像素中提取主色。只统计 alpha 足够高的像素（即去背后的衣物部分）。
 * 返回按占比从大到小排序的颜色簇。
 */
export function extractColors(
  data: Uint8ClampedArray,
  k = 4,
  maxSamples = 6000,
  alphaMin = 200,
): ColorCluster[] {
  const total = data.length / 4;
  let opaque = 0;
  for (let i = 0; i < total; i++) if (data[i * 4 + 3] >= alphaMin) opaque++;
  if (opaque === 0) return [];
  const stride = Math.max(1, Math.floor(opaque / maxSamples));
  const samples: Lab[] = [];
  let seen = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    if (data[o + 3] < alphaMin) continue;
    if (seen++ % stride !== 0) continue;
    samples.push(rgbToLab(data[o], data[o + 1], data[o + 2]));
  }
  return kmeansLab(samples, Math.min(k, samples.length));
}

export function kmeansLab(samples: Lab[], k: number, iterations = 12): ColorCluster[] {
  if (samples.length === 0 || k <= 0) return [];
  const rand = seededRandom(42);
  // k-means++ 初始化
  const centers: Lab[] = [samples[Math.floor(rand() * samples.length)]];
  const dist = new Float64Array(samples.length);
  while (centers.length < k) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      let m = Infinity;
      for (const c of centers) m = Math.min(m, sqDist(samples[i], c));
      dist[i] = m;
      sum += m;
    }
    if (sum === 0) break;
    let r = rand() * sum;
    let idx = 0;
    for (; idx < samples.length - 1; idx++) {
      r -= dist[idx];
      if (r <= 0) break;
    }
    centers.push(samples[idx]);
  }
  const assign = new Int32Array(samples.length);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < samples.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const dd = sqDist(samples[i], centers[c]);
        if (dd < bestD) {
          bestD = dd;
          best = c;
        }
      }
      assign[i] = best;
    }
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < samples.length; i++) {
      const s = sums[assign[i]];
      s[0] += samples[i][0];
      s[1] += samples[i][1];
      s[2] += samples[i][2];
      s[3] += 1;
    }
    for (let c = 0; c < centers.length; c++) {
      const s = sums[c];
      if (s[3] > 0) centers[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
    }
  }
  const counts = new Array(centers.length).fill(0);
  for (let i = 0; i < samples.length; i++) counts[assign[i]]++;
  const clusters = centers
    .map((lab, i) => ({ lab, weight: counts[i] / samples.length, hex: rgbToHex(labToRgb(lab)) }))
    .filter((c) => c.weight > 0);
  // 合并非常接近的簇（同一颜色的明暗面）
  clusters.sort((a, b) => b.weight - a.weight);
  const merged: ColorCluster[] = [];
  for (const c of clusters) {
    const near = merged.find((m) => deltaE(m.lab, c.lab) < 12);
    if (near) {
      const w = near.weight + c.weight;
      near.lab = [
        (near.lab[0] * near.weight + c.lab[0] * c.weight) / w,
        (near.lab[1] * near.weight + c.lab[1] * c.weight) / w,
        (near.lab[2] * near.weight + c.lab[2] * c.weight) / w,
      ];
      near.weight = w;
      near.hex = rgbToHex(labToRgb(near.lab));
    } else {
      merged.push({ ...c });
    }
  }
  return merged.sort((a, b) => b.weight - a.weight);
}

function sqDist(a: Lab, b: Lab): number {
  const x = a[0] - b[0];
  const y = a[1] - b[1];
  const z = a[2] - b[2];
  return x * x + y * y + z * z;
}

export interface ColorSuggestion {
  primary: { hex: string; name: string };
  secondary?: { hex: string; name: string };
  /** 第二颜色占比较大时，可能是拼色或花纹 */
  multiColor: boolean;
}

/** 根据提取结果给出录入表单的颜色建议 */
export function suggestColors(clusters: ColorCluster[]): ColorSuggestion | null {
  if (clusters.length === 0) return null;
  const p = clusters[0];
  const primary = { hex: p.hex, name: nearestColorName(p.lab).name };
  const second = clusters.find((c, i) => i > 0 && c.weight >= 0.18 && deltaE(c.lab, p.lab) > 22);
  if (!second) return { primary, multiColor: false };
  const secondary = { hex: second.hex, name: nearestColorName(second.lab).name };
  return { primary, secondary, multiColor: secondary.name !== primary.name };
}
