// 用显卡（WebGL2）跑抠图模型。模型格式和 CPU 参考实现见 core/u2net.ts。
//
// 张量存法：每 4 个通道放进一个 RGBA 半精度像素，一个张量的各组通道在纹理里排成网格
// （gx 列 × gy 行，每格是 w×h）。卷积每次画一个输出张量：每个像素算 4 个输出通道，
// 依次读各输入张量的各组通道和 3×3（或 1×1）邻域，权重从一张权重纹理里取：
// 先放偏置（每组输出一个像素），再按 [输出组][输入组][邻域][4 行] 放 4×4 的权重块。
// 中间结果用完立刻回收纹理，最后把输出编码成两个字节读回来。

import { floatToHalf, convBias, convWeights, lastUse, type ConvOp, type U2Model } from '../core/u2net';

interface GTensor {
  tex: WebGLTexture;
  c: number;
  w: number;
  h: number;
  /** 通道组数、网格列数 */
  g: number;
  gx: number;
  key: string;
}

const WT_WIDTH = 4096;

function grid(c: number): { g: number; gx: number; gy: number } {
  const g = Math.ceil(c / 4);
  const gx = Math.ceil(Math.sqrt(g));
  return { g, gx, gy: Math.ceil(g / gx) };
}

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

function convFrag(n: number, k: number, relu: boolean, sigmoid: boolean): string {
  const taps = k * k;
  const r = (k - 1) / 2;
  let decl = '';
  let body = '';
  for (let i = 0; i < n; i++) {
    decl += `uniform highp sampler2D uX${i}; uniform int uG${i}; uniform int uGX${i}; uniform int uOff${i};\n`;
    body += `
  for (int g = 0; g < uG${i}; g++) {
    ivec2 tile = ivec2((g % uGX${i}) * uOW, (g / uGX${i}) * uOH);
    int wb = base + (uOff${i} + g) * ${taps * 4};
    for (int t = 0; t < ${taps}; t++) {
      int sx = x + (t % ${k} - ${r}) * uDil;
      int sy = y + (t / ${k} - ${r}) * uDil;
      if (sx < 0 || sy < 0 || sx >= uOW || sy >= uOH) continue;
      vec4 v = texelFetch(uX${i}, tile + ivec2(sx, sy), 0);
      int wi = wb + t * 4;
      acc += vec4(dot(wf(wi), v), dot(wf(wi + 1), v), dot(wf(wi + 2), v), dot(wf(wi + 3), v));
    }
  }`;
  }
  return `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform highp sampler2D uW;
uniform int uOW;
uniform int uOH;
uniform int uOGX;
uniform int uOG;
uniform int uIGT;
uniform int uDil;
${decl}
out vec4 frag;
vec4 wf(int i) { return texelFetch(uW, ivec2(i % ${WT_WIDTH}, i / ${WT_WIDTH}), 0); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int tx = p.x / uOW;
  int ty = p.y / uOH;
  int og = ty * uOGX + tx;
  if (og >= uOG) { frag = vec4(0.0); return; }
  int x = p.x - tx * uOW;
  int y = p.y - ty * uOH;
  vec4 acc = wf(og);
  int base = uOG + og * uIGT * ${taps * 4};
  ${body}
  ${relu ? 'acc = max(acc, 0.0);' : ''}
  ${sigmoid ? 'acc = 1.0 / (1.0 + exp(-acc));' : ''}
  frag = acc;
}`;
}

/** 2×2 最大池化 / 双线性缩放 / 相加：输出的每格对应输入同一组 */
const POOL = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform highp sampler2D uX;
uniform int uOW; uniform int uOH; uniform int uIW; uniform int uIH; uniform int uGX; uniform int uG;
out vec4 frag;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int tx = p.x / uOW; int ty = p.y / uOH;
  if (ty * uGX + tx >= uG) { frag = vec4(0.0); return; }
  int x = (p.x - tx * uOW) * 2; int y = (p.y - ty * uOH) * 2;
  ivec2 tile = ivec2(tx * uIW, ty * uIH);
  vec4 m = texelFetch(uX, tile + ivec2(x, y), 0);
  if (x + 1 < uIW) m = max(m, texelFetch(uX, tile + ivec2(x + 1, y), 0));
  if (y + 1 < uIH) m = max(m, texelFetch(uX, tile + ivec2(x, y + 1), 0));
  if (x + 1 < uIW && y + 1 < uIH) m = max(m, texelFetch(uX, tile + ivec2(x + 1, y + 1), 0));
  frag = m;
}`;

const RESIZE = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform highp sampler2D uX;
uniform int uOW; uniform int uOH; uniform int uIW; uniform int uIH; uniform int uGX; uniform int uG;
out vec4 frag;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int tx = p.x / uOW; int ty = p.y / uOH;
  if (ty * uGX + tx >= uG) { frag = vec4(0.0); return; }
  float fx = clamp((float(p.x - tx * uOW) + 0.5) * float(uIW) / float(uOW) - 0.5, 0.0, float(uIW - 1));
  float fy = clamp((float(p.y - ty * uOH) + 0.5) * float(uIH) / float(uOH) - 0.5, 0.0, float(uIH - 1));
  int x0 = int(floor(fx)); int y0 = int(floor(fy));
  int x1 = min(x0 + 1, uIW - 1); int y1 = min(y0 + 1, uIH - 1);
  float ax = fx - float(x0); float ay = fy - float(y0);
  ivec2 tile = ivec2(tx * uIW, ty * uIH);
  vec4 a = texelFetch(uX, tile + ivec2(x0, y0), 0);
  vec4 b = texelFetch(uX, tile + ivec2(x1, y0), 0);
  vec4 c = texelFetch(uX, tile + ivec2(x0, y1), 0);
  vec4 d = texelFetch(uX, tile + ivec2(x1, y1), 0);
  frag = mix(mix(a, b, ax), mix(c, d, ax), ay);
}`;

const ADD = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform highp sampler2D uA;
uniform highp sampler2D uB;
out vec4 frag;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  frag = texelFetch(uA, p, 0) + texelFetch(uB, p, 0);
}`;

/** 输出（0~1）编码成两个字节，用最通用的 RGBA8 读回 */
const READOUT = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform highp sampler2D uX;
out vec4 frag;
void main() {
  float v = clamp(texelFetch(uX, ivec2(gl_FragCoord.xy), 0).r, 0.0, 1.0) * 65535.0;
  float hi = floor(v / 256.0);
  frag = vec4(hi / 255.0, (v - hi * 256.0) / 255.0, 0.0, 1.0);
}`;

interface Prog {
  p: WebGLProgram;
  u: Map<string, WebGLUniformLocation | null>;
}

export class U2Gpu {
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private fbo: WebGLFramebuffer;
  private vao: WebGLVertexArrayObject;
  private progs = new Map<string, Prog>();
  private weights = new Map<number, WebGLTexture>();
  private pool = new Map<string, WebGLTexture[]>();
  private lost = false;

  /** 浏览器能不能用：WebGL2 并且能画到半精度纹理 */
  static supported(): boolean {
    try {
      const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
      const gl = c.getContext('webgl2') as WebGL2RenderingContext | null;
      if (!gl) return false;
      const ok = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return ok;
    } catch {
      return false;
    }
  }

  constructor(private model: U2Model) {
    this.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('浏览器不支持 WebGL2');
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
      throw new Error('浏览器不支持半精度渲染');
    }
    this.gl = gl;
    if ('addEventListener' in this.canvas) {
      (this.canvas as HTMLCanvasElement).addEventListener('webglcontextlost', () => (this.lost = true));
    }
    this.fbo = gl.createFramebuffer()!;
    this.vao = gl.createVertexArray()!;
    for (const op of model.ops) if (op.t === 'conv') this.weights.set(op.out, this.uploadWeights(op));
  }

  get isLost(): boolean {
    return this.lost || this.gl.isContextLost();
  }

  private program(key: string, frag: string): Prog {
    const hit = this.progs.get(key);
    if (hit) return hit;
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`着色器编译失败：${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`着色器链接失败：${gl.getProgramInfoLog(p)}`);
    const prog = { p, u: new Map<string, WebGLUniformLocation | null>() };
    this.progs.set(key, prog);
    return prog;
  }

  private uni(prog: Prog, name: string): WebGLUniformLocation | null {
    if (!prog.u.has(name)) prog.u.set(name, this.gl.getUniformLocation(prog.p, name));
    return prog.u.get(name)!;
  }

  private halfTexture(w: number, h: number, data: Uint16Array | null): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, data);
    return t;
  }

  /** 权重纹理：先放偏置，再按 [输出组][输入组][邻域][4 行] 放 4×4 权重块 */
  private uploadWeights(op: ConvOp): WebGLTexture {
    const model = this.model;
    const w = convWeights(model, op);
    const bias = convBias(model, op);
    const taps = op.k * op.k;
    const og = Math.ceil(op.o / 4);
    const groups: Array<{ cBase: number; c: number }> = [];
    let cBase = 0;
    for (const t of op.ins) {
      const c = model.tensors[t];
      for (let g = 0; g < Math.ceil(c / 4); g++) groups.push({ cBase: cBase + g * 4, c: Math.min(4, c - g * 4) });
      cBase += c;
    }
    const texels = og + og * groups.length * taps * 4;
    const rows = Math.ceil(texels / WT_WIDTH);
    const data = new Uint16Array(WT_WIDTH * rows * 4);
    for (let o = 0; o < op.o; o++) data[o] = floatToHalf(bias[o]);
    for (let g = 0; g < og; g++) {
      for (let ig = 0; ig < groups.length; ig++) {
        const { cBase: cb, c } = groups[ig];
        for (let t = 0; t < taps; t++) {
          for (let j = 0; j < 4; j++) {
            const o = g * 4 + j;
            if (o >= op.o) continue;
            const texel = og + ((g * groups.length + ig) * taps + t) * 4 + j;
            for (let m = 0; m < c; m++) data[texel * 4 + m] = floatToHalf(w[(o * op.i + cb + m) * taps + t]);
          }
        }
      }
    }
    return this.halfTexture(WT_WIDTH, rows, data);
  }

  private alloc(c: number, w: number, h: number): GTensor {
    const { g, gx, gy } = grid(c);
    const key = `${w * gx}x${h * gy}`;
    const free = this.pool.get(key);
    const tex = free?.pop() ?? this.halfTexture(w * gx, h * gy, null);
    return { tex, c, w, h, g, gx, key };
  }

  private release(t: GTensor): void {
    const list = this.pool.get(t.key) ?? [];
    list.push(t.tex);
    this.pool.set(t.key, list);
  }

  private target(t: GTensor): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    const rows = Math.ceil(t.g / t.gx);
    gl.viewport(0, 0, t.w * t.gx, t.h * rows);
  }

  private bind(prog: Prog, name: string, unit: number, tex: WebGLTexture): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.uni(prog, name), unit);
  }

  private draw(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** input：3×size×size（core/u2net.ts 的 preprocess），返回 size×size 的概率 */
  run(input: Float32Array, size: number): Float32Array {
    const gl = this.gl;
    const model = this.model;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    // 输入：一组通道，RGB 放在前三个分量
    const inp = this.alloc(3, size, size);
    const half = new Uint16Array(size * size * 4);
    const plane = size * size;
    for (let i = 0; i < plane; i++) {
      half[i * 4] = floatToHalf(input[i]);
      half[i * 4 + 1] = floatToHalf(input[plane + i]);
      half[i * 4 + 2] = floatToHalf(input[2 * plane + i]);
    }
    gl.bindTexture(gl.TEXTURE_2D, inp.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RGBA, gl.HALF_FLOAT, half);
    const T: Array<GTensor | undefined> = [inp];
    const last = lastUse(model);
    model.ops.forEach((op, k) => {
      if (op.t === 'conv') {
        const ins = op.ins.map((i) => T[i]!);
        const out = this.alloc(op.o, ins[0].w, ins[0].h);
        const prog = this.program(`conv${ins.length}-${op.k}-${op.relu ? 1 : 0}${op.sigmoid ? 1 : 0}`, convFrag(ins.length, op.k, op.relu, op.sigmoid));
        gl.useProgram(prog.p);
        this.target(out);
        this.bind(prog, 'uW', 0, this.weights.get(op.out)!);
        gl.uniform1i(this.uni(prog, 'uOW'), out.w);
        gl.uniform1i(this.uni(prog, 'uOH'), out.h);
        gl.uniform1i(this.uni(prog, 'uOGX'), out.gx);
        gl.uniform1i(this.uni(prog, 'uOG'), out.g);
        gl.uniform1i(this.uni(prog, 'uDil'), op.dil);
        let off = 0;
        ins.forEach((t, i) => {
          this.bind(prog, `uX${i}`, i + 1, t.tex);
          gl.uniform1i(this.uni(prog, `uG${i}`), t.g);
          gl.uniform1i(this.uni(prog, `uGX${i}`), t.gx);
          gl.uniform1i(this.uni(prog, `uOff${i}`), off);
          off += t.g;
        });
        gl.uniform1i(this.uni(prog, 'uIGT'), off);
        this.draw();
        T[op.out] = out;
      } else if (op.t === 'pool' || op.t === 'resize') {
        const src = T[op.in]!;
        const like = op.t === 'resize' ? T[op.like]! : null;
        const out = this.alloc(src.c, like ? like.w : Math.ceil(src.w / 2), like ? like.h : Math.ceil(src.h / 2));
        const prog = op.t === 'pool' ? this.program('pool', POOL) : this.program('resize', RESIZE);
        gl.useProgram(prog.p);
        this.target(out);
        this.bind(prog, 'uX', 0, src.tex);
        gl.uniform1i(this.uni(prog, 'uOW'), out.w);
        gl.uniform1i(this.uni(prog, 'uOH'), out.h);
        gl.uniform1i(this.uni(prog, 'uIW'), src.w);
        gl.uniform1i(this.uni(prog, 'uIH'), src.h);
        gl.uniform1i(this.uni(prog, 'uGX'), out.gx);
        gl.uniform1i(this.uni(prog, 'uG'), out.g);
        this.draw();
        T[op.out] = out;
      } else {
        const a = T[op.a]!;
        const b = T[op.b]!;
        const out = this.alloc(a.c, a.w, a.h);
        const prog = this.program('add', ADD);
        gl.useProgram(prog.p);
        this.target(out);
        this.bind(prog, 'uA', 0, a.tex);
        this.bind(prog, 'uB', 1, b.tex);
        this.draw();
        T[op.out] = out;
      }
      for (let t = 0; t < T.length; t++) {
        const x = T[t];
        if (x && last[t] === k && t !== model.output) {
          this.release(x);
          T[t] = undefined;
        }
      }
    });
    // 读出：编码成 RGBA8
    const res = T[model.output]!;
    const rt = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, rt);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const prog = this.program('readout', READOUT);
    gl.useProgram(prog.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, rt, 0);
    gl.viewport(0, 0, size, size);
    this.bind(prog, 'uX', 0, res.tex);
    this.draw();
    const bytes = new Uint8Array(size * size * 4);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    gl.deleteTexture(rt);
    this.release(res);
    if (gl.isContextLost()) throw new Error('显卡上下文丢失');
    const out = new Float32Array(size * size);
    // 纹理第 0 行在最下面读出来也在第 0 行（readPixels 和 texelFetch 用同一个坐标系）
    for (let i = 0; i < size * size; i++) out[i] = (bytes[i * 4] * 256 + bytes[i * 4 + 1]) / 65535;
    return out;
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of this.weights.values()) gl.deleteTexture(t);
    for (const list of this.pool.values()) for (const t of list) gl.deleteTexture(t);
    this.weights.clear();
    this.pool.clear();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
