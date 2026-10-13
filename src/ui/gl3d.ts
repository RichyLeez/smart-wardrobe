// 3D 人台的 WebGL 渲染：人台、鞋、衣物外壳和地面阴影。只依赖浏览器自带的 WebGL1。

import type { MeshData } from '../core/body3d';

const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec3 aColor;
attribute vec2 aUvF;
attribute vec2 aUvB;
attribute float aSide;
uniform mat4 uViewProj;
varying vec3 vPos;
varying vec3 vN;
varying vec3 vColor;
varying vec2 vUvF;
varying vec2 vUvB;
varying float vSide;
void main() {
  vPos = aPos;
  vN = aNormal;
  vColor = aColor;
  vUvF = aUvF;
  vUvB = aUvB;
  vSide = aSide;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const SHADE = `
uniform vec3 uEye;
uniform vec3 uKey;
uniform vec3 uFill;
vec3 shade(vec3 base, vec3 n, vec3 pos, float flatness) {
  vec3 v = normalize(uEye - pos);
  float inside = 0.0;
  if (dot(n, v) < 0.0) { n = -n; inside = 1.0; }
  float d = 0.42 + 0.58 * max(dot(n, uKey), 0.0) + 0.16 * max(dot(n, uFill), 0.0);
  d = mix(d, 0.78 + 0.3 * max(dot(n, uKey), 0.0), flatness);
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0) * 0.1;
  vec3 c = base * d + rim;
  return inside > 0.5 ? c * 0.6 : c;
}`;

const FRAG_SOLID = `
precision mediump float;
varying vec3 vPos;
varying vec3 vN;
varying vec3 vColor;
${SHADE}
void main() {
  gl_FragColor = vec4(shade(vColor, normalize(vN), vPos, 0.0), 1.0);
}`;

const FRAG_GARMENT = `
precision mediump float;
uniform sampler2D uFront;
uniform sampler2D uBack;
uniform float uHasBack;
uniform float uBackBlur;
uniform float uMinY;
varying vec3 vPos;
varying vec3 vN;
varying vec2 vUvF;
varying vec2 vUvB;
varying float vSide;
${SHADE}
bool outside(vec2 uv) { return uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0; }
void main() {
  // 塞进下装的上衣：腰头以下不画
  if (vPos.y < uMinY) discard;
  vec4 c;
  if (vSide > 0.5) {
    if (outside(vUvF)) discard;
    c = texture2D(uFront, vUvF);
  } else if (uHasBack > 0.5 && uBackBlur > 0.5) {
    // 背面借用合上的正面照片（敞开的外套没有背面照片时），模糊掉正面细节
    if (outside(vUvB)) discard;
    vec4 a = texture2D(uBack, vUvB);
    vec4 b = texture2D(uBack, vUvB, 3.5);
    c = vec4(b.rgb / max(b.a, 0.004) * a.a, a.a);
  } else if (uHasBack > 0.5) {
    if (outside(vUvB)) discard;
    c = texture2D(uBack, vUvB);
  } else {
    // 没有背面照片：轮廓用正面照片，颜色取模糊后的正面，去掉纽扣、印花这类正面细节
    if (outside(vUvF)) discard;
    vec4 a = texture2D(uFront, vUvF);
    vec4 b = texture2D(uFront, vUvF, 3.5);
    c = vec4(b.rgb / max(b.a, 0.004) * a.a, a.a);
  }
  if (c.a < 0.35) discard;
  vec3 base = c.rgb / c.a;
  gl_FragColor = vec4(shade(base, normalize(vN), vPos, 0.35), 1.0);
}`;

const VERT_SHADOW = `
attribute vec2 aXY;
uniform mat4 uViewProj;
uniform vec2 uSize;
varying vec2 vUv;
void main() {
  vUv = aXY;
  gl_Position = uViewProj * vec4(aXY.x * uSize.x, 0.05, aXY.y * uSize.y, 1.0);
}`;

const FRAG_SHADOW = `
precision mediump float;
uniform vec3 uInk;
varying vec2 vUv;
void main() {
  float r = length(vUv);
  float a = 0.26 * (1.0 - smoothstep(0.0, 1.0, r));
  gl_FragColor = vec4(uInk * a, a);
}`;

type GL = WebGLRenderingContext;

interface Program {
  prog: WebGLProgram;
  attr: Record<string, number>;
  uni: Record<string, WebGLUniformLocation | null>;
}

function compile(gl: GL, vs: string, fs: string, attrs: string[], unis: string[]): Program {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? '着色器编译失败');
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  // 位置属性固定在 0 号，避免部分实现里 0 号属性未启用时的性能问题
  gl.bindAttribLocation(prog, 0, attrs[0]);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? '着色器链接失败');
  const attr: Record<string, number> = {};
  for (const a of attrs) attr[a] = gl.getAttribLocation(prog, a);
  const uni: Record<string, WebGLUniformLocation | null> = {};
  for (const u of unis) uni[u] = gl.getUniformLocation(prog, u);
  return { prog, attr, uni };
}

interface GpuMesh {
  count: number;
  buffers: Partial<Record<'aPos' | 'aNormal' | 'aColor' | 'aUvF' | 'aUvB' | 'aSide', { buf: WebGLBuffer; size: number }>>;
  index: WebGLBuffer;
}

export interface GarmentDraw {
  mesh: MeshData;
  front: TexImageSource;
  back?: TexImageSource;
  /** back 其实是正面照片，需要模糊 */
  backBlur?: boolean;
  /** 低于这个高度（世界坐标 Y）不画 */
  minY?: number;
}

interface GpuGarment {
  mesh: GpuMesh;
  front: WebGLTexture;
  back?: WebGLTexture;
  backBlur: boolean;
  minY: number;
}

// ---------- 矩阵 ----------

type Mat4 = Float32Array;

function perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

function lookAt(eye: number[], target: number[], up: number[]): Mat4 {
  const z = norm([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = norm(cross(up, z));
  const y = cross(z, x);
  const m = new Float32Array(16);
  m[0] = x[0];
  m[4] = x[1];
  m[8] = x[2];
  m[1] = y[0];
  m[5] = y[1];
  m[9] = y[2];
  m[2] = z[0];
  m[6] = z[1];
  m[10] = z[2];
  m[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]);
  m[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]);
  m[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]);
  m[15] = 1;
  return m;
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

function cross(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function norm(v: number[]): number[] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function rotY(v: number[], a: number): number[] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

export function cssColor(name: string, fallback: [number, number, number]): [number, number, number] {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const m = v.match(/^#([0-9a-f]{6})$/i);
    if (!m) return fallback;
    const n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  } catch {
    return fallback;
  }
}

// ---------- 渲染器 ----------

export class Renderer3D {
  readonly canvas: HTMLCanvasElement;
  private gl: GL;
  private solid: Program;
  private garment: Program;
  private shadow: Program;
  private shadowBuf: WebGLBuffer;
  private body: GpuMesh | null = null;
  private shoes: GpuMesh | null = null;
  private garments: GpuGarment[] = [];
  private height = 170;
  private frame = 0;
  private lost = false;
  private disposed = false;
  /** 视角：yaw 为绕身体竖轴的角度（0 = 正面，π = 背面），pitch 为俯仰 */
  yaw = 0;
  pitch = 0.08;
  zoom = 1;
  bodyColor: [number, number, number] = [0.84, 0.82, 0.76];
  /** 地面阴影颜色（深浅模式都用接近黑色） */
  inkColor: [number, number, number] = [0.04, 0.05, 0.08];
  /** 每一帧之前调用，返回 true 表示还需要继续动画 */
  onFrame: ((dt: number) => boolean) | null = null;
  private last = 0;

  static create(canvas: HTMLCanvasElement): Renderer3D | null {
    let gl: GL | null = null;
    try {
      gl = (canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: true }) ??
        canvas.getContext('experimental-webgl', { antialias: true, alpha: true })) as GL | null;
    } catch {
      gl = null;
    }
    if (!gl) return null;
    try {
      return new Renderer3D(canvas, gl);
    } catch (e) {
      console.warn('3D 人台初始化失败', e);
      return null;
    }
  }

  private constructor(canvas: HTMLCanvasElement, gl: GL) {
    this.canvas = canvas;
    this.gl = gl;
    const attrs = ['aPos', 'aNormal', 'aColor', 'aUvF', 'aUvB', 'aSide'];
    const common = ['uViewProj', 'uEye', 'uKey', 'uFill'];
    this.solid = compile(gl, VERT, FRAG_SOLID, attrs, common);
    this.garment = compile(gl, VERT, FRAG_GARMENT, attrs, [...common, 'uFront', 'uBack', 'uHasBack', 'uBackBlur', 'uMinY']);
    this.shadow = compile(gl, VERT_SHADOW, FRAG_SHADOW, ['aXY'], ['uViewProj', 'uSize', 'uInk']);
    this.shadowBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shadowBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
  }

  get contextLost(): boolean {
    return this.lost;
  }

  private upload(mesh: MeshData): GpuMesh {
    const gl = this.gl;
    const buffers: GpuMesh['buffers'] = {};
    const add = (name: keyof GpuMesh['buffers'], data: Float32Array | undefined, size: number) => {
      if (!data) return;
      const buf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      buffers[name] = { buf, size };
    };
    add('aPos', mesh.positions, 3);
    add('aNormal', mesh.normals, 3);
    add('aColor', mesh.colors, 3);
    add('aUvF', mesh.uvFront, 2);
    add('aUvB', mesh.uvBack, 2);
    add('aSide', mesh.side, 1);
    const index = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    return { count: mesh.indices.length, buffers, index };
  }

  private free(m: GpuMesh | null): void {
    if (!m) return;
    for (const b of Object.values(m.buffers)) if (b) this.gl.deleteBuffer(b.buf);
    this.gl.deleteBuffer(m.index);
  }

  private texture(src: TexImageSource): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  setBody(mesh: MeshData, height: number): void {
    this.free(this.body);
    this.body = this.upload(mesh);
    this.height = height;
    this.requestRender();
  }

  setShoes(mesh: MeshData | null): void {
    this.free(this.shoes);
    this.shoes = mesh ? this.upload(mesh) : null;
    this.requestRender();
  }

  setGarments(list: GarmentDraw[]): void {
    for (const g of this.garments) {
      this.free(g.mesh);
      this.gl.deleteTexture(g.front);
      if (g.back) this.gl.deleteTexture(g.back);
    }
    this.garments = list.map((g) => ({
      mesh: this.upload(g.mesh),
      front: this.texture(g.front),
      back: g.back ? this.texture(g.back) : undefined,
      backBlur: !!g.backBlur,
      minY: g.minY ?? -1e6,
    }));
    this.requestRender();
  }

  private bind(p: Program, m: GpuMesh): void {
    const gl = this.gl;
    for (const name of ['aPos', 'aNormal', 'aColor', 'aUvF', 'aUvB', 'aSide'] as const) {
      const loc = p.attr[name];
      if (loc < 0) continue;
      const b = m.buffers[name];
      if (b) {
        gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, b.size, gl.FLOAT, false, 0, 0);
      } else {
        gl.disableVertexAttribArray(loc);
        if (name === 'aColor') gl.vertexAttrib3f(loc, ...this.bodyColor);
        else gl.vertexAttrib4f(loc, 0, 0, 0, 1);
      }
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.index);
  }

  /** 按画布尺寸和视角计算相机 */
  private camera(): { viewProj: Mat4; eye: number[] } {
    const c = this.canvas;
    const aspect = c.width / Math.max(1, c.height);
    const H = this.height;
    const fovy = (30 * Math.PI) / 180;
    const halfH = H * 0.6;
    const halfW = H * 0.3;
    const dist = Math.max(halfH / Math.tan(fovy / 2), halfW / (Math.tan(fovy / 2) * aspect)) / this.zoom;
    const target = [0, H * 0.5, 0];
    const eye = [
      target[0] + dist * Math.sin(this.yaw) * Math.cos(this.pitch),
      target[1] + dist * Math.sin(this.pitch),
      target[2] + dist * Math.cos(this.yaw) * Math.cos(this.pitch),
    ];
    const view = lookAt(eye, target, [0, 1, 0]);
    const proj = perspective(fovy, aspect, dist * 0.3, dist * 3);
    return { viewProj: multiply(proj, view), eye };
  }

  resize(): void {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    this.requestRender();
  }

  requestRender(): void {
    if (this.frame || this.lost || this.disposed) return;
    this.frame = requestAnimationFrame((t) => {
      this.frame = 0;
      const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 0;
      this.last = t;
      const more = this.onFrame ? this.onFrame(dt) : false;
      this.draw();
      if (more) this.requestRender();
      else this.last = 0;
    });
  }

  draw(): void {
    if (this.lost) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const { viewProj, eye } = this.camera();
    // 灯光跟着相机转，任何角度都看得清
    const key = norm(rotY([0.45, 0.7, 0.75], this.yaw));
    const fill = norm(rotY([-0.7, 0.2, 0.3], this.yaw));

    // 地面阴影
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.shadow.prog);
    gl.uniformMatrix4fv(this.shadow.uni.uViewProj, false, viewProj);
    gl.uniform2f(this.shadow.uni.uSize, this.height * 0.2, this.height * 0.13);
    gl.uniform3f(this.shadow.uni.uInk, ...this.inkColor);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shadowBuf);
    gl.enableVertexAttribArray(this.shadow.attr.aXY);
    gl.vertexAttribPointer(this.shadow.attr.aXY, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(this.shadow.attr.aXY);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);

    const setCommon = (p: Program) => {
      gl.useProgram(p.prog);
      gl.uniformMatrix4fv(p.uni.uViewProj, false, viewProj);
      gl.uniform3f(p.uni.uEye, eye[0], eye[1], eye[2]);
      gl.uniform3f(p.uni.uKey, key[0], key[1], key[2]);
      gl.uniform3f(p.uni.uFill, fill[0], fill[1], fill[2]);
    };
    setCommon(this.solid);
    if (this.body) {
      this.bind(this.solid, this.body);
      gl.drawElements(gl.TRIANGLES, this.body.count, gl.UNSIGNED_SHORT, 0);
    }
    if (this.shoes) {
      this.bind(this.solid, this.shoes);
      gl.drawElements(gl.TRIANGLES, this.shoes.count, gl.UNSIGNED_SHORT, 0);
    }
    if (this.garments.length) {
      setCommon(this.garment);
      gl.uniform1i(this.garment.uni.uFront, 0);
      gl.uniform1i(this.garment.uni.uBack, 1);
      for (const g of this.garments) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, g.front);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, g.back ?? g.front);
        gl.uniform1f(this.garment.uni.uHasBack, g.back ? 1 : 0);
        gl.uniform1f(this.garment.uni.uBackBlur, g.backBlur ? 1 : 0);
        gl.uniform1f(this.garment.uni.uMinY, g.minY);
        this.bind(this.garment, g.mesh);
        gl.drawElements(gl.TRIANGLES, g.mesh.count, gl.UNSIGNED_SHORT, 0);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.onFrame = null;
    if (!this.lost) {
      this.setGarments([]);
      this.free(this.body);
      this.free(this.shoes);
      this.body = null;
      this.shoes = null;
      this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  }
}
