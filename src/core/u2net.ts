// 抠图模型（U²-Net）：读取 public/models/u2net.bin（由 scripts/model/convert_u2net.py 生成），
// 准备输入、整理输出，以及一个 CPU 上的参考实现（单元测试用；浏览器里用显卡跑，见 ui/u2netGpu.ts）。
//
// 模型输出每个像素"是照片主体（衣服）"的概率。它看的是形状和纹理，不只是颜色，
// 所以白床单上的白领口、白下摆这类和背景同色的部分也能认出来。去背时它只作为一个参考，
// 和颜色模型一起交给图割决定边界（smartcut.ts 的 prior）。
// 全部是纯函数。

import type { RGBAImage } from './background';

export type ConvOp = {
  t: 'conv';
  out: number;
  /** 输入张量（按通道依次拼起来） */
  ins: number[];
  k: 1 | 3;
  dil: number;
  relu: boolean;
  sigmoid: boolean;
  /** 输出、输入通道数 */
  o: number;
  i: number;
  /** 权重存法：int8（每个输出通道一个缩放系数）或 float16 */
  q: 'i8' | 'f16';
  /** 数据区里的字节偏移 */
  w: number;
  s?: number;
  b: number;
};
export type ModelOp =
  | ConvOp
  | { t: 'pool'; out: number; in: number }
  | { t: 'resize'; out: number; in: number; like: number }
  | { t: 'add'; out: number; a: number; b: number };

export interface U2Model {
  inputSize: number;
  mean: [number, number, number];
  std: [number, number, number];
  output: number;
  /** 每个张量的通道数，张量 0 是输入 */
  tensors: number[];
  ops: ModelOp[];
  data: DataView;
}

export function parseModel(buf: ArrayBuffer): U2Model {
  const head = new Uint8Array(buf, 0, 4);
  if (String.fromCharCode(...head) !== 'U2NB') throw new Error('模型文件格式不对');
  const dv = new DataView(buf);
  const version = dv.getUint32(4, true);
  if (version !== 1) throw new Error(`不支持的模型版本 ${version}`);
  const hl = dv.getUint32(8, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, hl)));
  return { ...json, data: new DataView(buf, 12 + hl) };
}

/** float16 → float32 */
export function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

const f32buf = new Float32Array(1);
const u32buf = new Uint32Array(f32buf.buffer);
/** float32 → float16（就近舍入） */
export function floatToHalf(v: number): number {
  f32buf[0] = v;
  const x = u32buf[0];
  const sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15;
  let m = x & 0x7fffff;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    m |= 0x800000;
    const shift = 14 - e;
    let r = m >> shift;
    if ((m >> (shift - 1)) & 1) r++;
    return sign | r;
  }
  let r = (e << 10) | (m >> 13);
  if (m & 0x1000) r++;
  return sign | r;
}

/** 某个卷积的权重，按 [输出][输入][kh][kw] 展开成 float32 */
export function convWeights(model: U2Model, op: ConvOp): Float32Array {
  const n = op.o * op.i * op.k * op.k;
  const out = new Float32Array(n);
  const per = n / op.o;
  const dv = model.data;
  if (op.q === 'i8') {
    for (let o = 0; o < op.o; o++) {
      const s = dv.getFloat32(op.s! + o * 4, true);
      for (let j = 0; j < per; j++) out[o * per + j] = dv.getInt8(op.w + o * per + j) * s;
    }
  } else {
    for (let j = 0; j < n; j++) out[j] = halfToFloat(dv.getUint16(op.w + j * 2, true));
  }
  return out;
}

export function convBias(model: U2Model, op: ConvOp): Float32Array {
  const out = new Float32Array(op.o);
  for (let o = 0; o < op.o; o++) out[o] = model.data.getFloat32(op.b + o * 4, true);
  return out;
}

/**
 * 准备输入：缩放到 size×size（双线性），除以最大值，再按均值方差归一化（和 rembg 的做法一致）。
 * 返回按通道存放的 3×size×size。
 */
export function preprocess(img: RGBAImage, size: number, mean: number[], std: number[]): Float32Array {
  const { width: W, height: H, data } = img;
  const out = new Float32Array(3 * size * size);
  let max = 0;
  const plane = size * size;
  for (let y = 0; y < size; y++) {
    // 和 PIL 的双线性缩小不完全一样：缩小较多时先按区域平均，避免丢掉细节
    const sy0 = (y * H) / size;
    const sy1 = ((y + 1) * H) / size;
    for (let x = 0; x < size; x++) {
      const sx0 = (x * W) / size;
      const sx1 = ((x + 1) * W) / size;
      let r = 0;
      let g = 0;
      let b = 0;
      let c = 0;
      for (let yy = Math.floor(sy0); yy < Math.min(H, Math.ceil(sy1)); yy++) {
        for (let xx = Math.floor(sx0); xx < Math.min(W, Math.ceil(sx1)); xx++) {
          const o = (yy * W + xx) * 4;
          r += data[o];
          g += data[o + 1];
          b += data[o + 2];
          c++;
        }
      }
      const i = y * size + x;
      out[i] = r / c / 255;
      out[plane + i] = g / c / 255;
      out[2 * plane + i] = b / c / 255;
      max = Math.max(max, out[i], out[plane + i], out[2 * plane + i]);
    }
  }
  const k = 1 / Math.max(max, 1e-6);
  for (let ch = 0; ch < 3; ch++) {
    for (let i = 0; i < plane; i++) out[ch * plane + i] = (out[ch * plane + i] * k - mean[ch]) / std[ch];
  }
  return out;
}

/**
 * 整理输出：双线性放大到照片尺寸，存成 0~255。stretch 为真时先按最小、最大值拉伸到 0~1（rembg 的做法）；
 * 给去背当参考时不拉伸，保留模型本来的把握程度。
 */
export function postprocess(prob: Float32Array, size: number, width: number, height: number, stretch = true): Uint8Array {
  let lo = 0;
  let hi = 1;
  if (stretch) {
    lo = Infinity;
    hi = -Infinity;
    for (let i = 0; i < prob.length; i++) {
      lo = Math.min(lo, prob[i]);
      hi = Math.max(hi, prob[i]);
    }
  }
  const k = 1 / Math.max(hi - lo, 1e-6);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const fy = Math.max(0, Math.min(size - 1, ((y + 0.5) * size) / height - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(size - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, Math.min(size - 1, ((x + 0.5) * size) / width - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(size - 1, x0 + 1);
      const tx = fx - x0;
      const v =
        (prob[y0 * size + x0] * (1 - tx) + prob[y0 * size + x1] * tx) * (1 - ty) +
        (prob[y1 * size + x0] * (1 - tx) + prob[y1 * size + x1] * tx) * ty;
      out[y * width + x] = Math.round(Math.max(0, Math.min(1, (v - lo) * k)) * 255);
    }
  }
  return out;
}

/**
 * 模型对这张照片有多大把握（0~1）：拿不准的像素（概率在 0.2～0.8 之间）占比不超过 8% 时完全信任，
 * 超过 25% 时不用。干净背景上的单件衣服通常只有 1%～3%；旁边堆着别的衣服、杂物时会到 30%～40%，
 * 这时模型会把床单、别的衣服也认成主体，去背只按颜色来。
 */
export function modelConfidence(prob: Float32Array): number {
  let mid = 0;
  for (let i = 0; i < prob.length; i++) if (prob[i] > 0.2 && prob[i] < 0.8) mid++;
  const share = mid / Math.max(1, prob.length);
  return Math.max(0, Math.min(1, (0.25 - share) / (0.25 - 0.08)));
}

// ---------- CPU 参考实现 ----------

interface Tensor {
  c: number;
  h: number;
  w: number;
  d: Float32Array;
}

function conv(model: U2Model, op: ConvOp, inputs: Tensor[]): Tensor {
  const { h, w } = inputs[0];
  const plane = h * w;
  const wts = convWeights(model, op);
  const bias = convBias(model, op);
  const out = new Float32Array(op.o * plane);
  const k = op.k;
  const taps = k * k;
  const dil = op.dil;
  const r = k === 3 ? dil : 0;
  for (let o = 0; o < op.o; o++) {
    const dst = out.subarray(o * plane, (o + 1) * plane);
    dst.fill(bias[o]);
    let cBase = 0;
    for (const t of inputs) {
      for (let c = 0; c < t.c; c++) {
        const src = t.d.subarray(c * plane, (c + 1) * plane);
        const wb = (o * op.i + cBase + c) * taps;
        for (let tap = 0; tap < taps; tap++) {
          const wv = wts[wb + tap];
          if (wv === 0) continue;
          const dy = Math.floor(tap / k) * dil - r;
          const dx = (tap % k) * dil - r;
          const y0 = Math.max(0, -dy);
          const y1 = Math.min(h, h - dy);
          const x0 = Math.max(0, -dx);
          const x1 = Math.min(w, w - dx);
          for (let y = y0; y < y1; y++) {
            const so = (y + dy) * w + dx;
            const doff = y * w;
            for (let x = x0; x < x1; x++) dst[doff + x] += wv * src[so + x];
          }
        }
      }
      cBase += t.c;
    }
    if (op.relu) for (let j = 0; j < plane; j++) if (dst[j] < 0) dst[j] = 0;
    if (op.sigmoid) for (let j = 0; j < plane; j++) dst[j] = 1 / (1 + Math.exp(-dst[j]));
  }
  return { c: op.o, h, w, d: out };
}

/** 2×2 最大池化，步长 2，尺寸向上取整 */
function pool(t: Tensor): Tensor {
  const h = Math.ceil(t.h / 2);
  const w = Math.ceil(t.w / 2);
  const out = new Float32Array(t.c * h * w);
  for (let c = 0; c < t.c; c++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let m = -Infinity;
        for (let dy = 0; dy < 2; dy++) {
          const yy = y * 2 + dy;
          if (yy >= t.h) continue;
          for (let dx = 0; dx < 2; dx++) {
            const xx = x * 2 + dx;
            if (xx >= t.w) continue;
            m = Math.max(m, t.d[(c * t.h + yy) * t.w + xx]);
          }
        }
        out[(c * h + y) * w + x] = m;
      }
    }
  }
  return { c: t.c, h, w, d: out };
}

/** 双线性缩放（像素中心对齐，越界取边缘） */
export function resizeBilinear(src: Float32Array, c: number, h: number, w: number, H: number, W: number): Float32Array {
  const out = new Float32Array(c * H * W);
  const coord = (o: number, n: number, size: number) => Math.max(0, Math.min(size - 1, (o + 0.5) * (size / n) - 0.5));
  for (let y = 0; y < H; y++) {
    const fy = coord(y, H, h);
    const y0 = Math.floor(fy);
    const y1 = Math.min(h - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = coord(x, W, w);
      const x0 = Math.floor(fx);
      const x1 = Math.min(w - 1, x0 + 1);
      const tx = fx - x0;
      for (let ch = 0; ch < c; ch++) {
        const b = ch * h * w;
        out[(ch * H + y) * W + x] =
          (src[b + y0 * w + x0] * (1 - tx) + src[b + y0 * w + x1] * tx) * (1 - ty) +
          (src[b + y1 * w + x0] * (1 - tx) + src[b + y1 * w + x1] * tx) * ty;
      }
    }
  }
  return out;
}

/** 每个张量最后一次被用到是第几个算子（用完就释放，省内存） */
export function lastUse(model: U2Model): number[] {
  const last = new Array(model.tensors.length).fill(-1);
  model.ops.forEach((op, k) => {
    const ins = op.t === 'conv' ? op.ins : op.t === 'add' ? [op.a, op.b] : op.t === 'resize' ? [op.in, op.like] : [op.in];
    for (const t of ins) last[t] = k;
  });
  last[model.output] = model.ops.length;
  return last;
}

/** 在 CPU 上跑一遍（很慢，只用于测试和对照）。input：3×h×w，h、w 要是 32 的倍数 */
export function runCpu(model: U2Model, input: Float32Array, h: number, w: number): Float32Array {
  const T: Array<Tensor | undefined> = [{ c: 3, h, w, d: input }];
  const last = lastUse(model);
  model.ops.forEach((op, k) => {
    if (op.t === 'conv') T[op.out] = conv(model, op, op.ins.map((i) => T[i]!));
    else if (op.t === 'pool') T[op.out] = pool(T[op.in]!);
    else if (op.t === 'resize') {
      const s = T[op.in]!;
      const ref = T[op.like]!;
      T[op.out] = { c: s.c, h: ref.h, w: ref.w, d: resizeBilinear(s.d, s.c, s.h, s.w, ref.h, ref.w) };
    } else {
      const a = T[op.a]!;
      const b = T[op.b]!;
      const d = new Float32Array(a.d.length);
      for (let j = 0; j < d.length; j++) d[j] = a.d[j] + b.d[j];
      T[op.out] = { ...a, d };
    }
    for (let t = 0; t < T.length; t++) if (T[t] && last[t] === k && t !== model.output) T[t] = undefined;
  });
  return T[model.output]!.d;
}
