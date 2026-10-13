import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateBackground, paintOverride, removeBackground, suggestThreshold, type RGBAImage } from '../src/core/background';
import { GridMaxflow } from '../src/core/maxflow';
import { colorCost, fitColorModel, smartCut } from '../src/core/smartcut';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeImage(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

function iou(alpha: Uint8Array, truth: (x: number, y: number) => boolean, w: number, h: number): number {
  let inter = 0;
  let union = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = alpha[y * w + x] > 127;
      const t = truth(x, y);
      if (a && t) inter++;
      if (a || t) union++;
    }
  }
  return inter / union;
}

test('网格最大流与穷举最小割结果一致', () => {
  const rand = rng(7);
  for (let trial = 0; trial < 40; trial++) {
    const w = 3;
    const h = 3;
    const n = w * h;
    const src: number[] = [];
    const snk: number[] = [];
    // edges[i][d]：i 向右（0）、向下（2）以及反向的容量
    const right: Array<[number, number]> = [];
    const down: Array<[number, number]> = [];
    const g = new GridMaxflow(w, h);
    for (let i = 0; i < n; i++) {
      const s = Math.floor(rand() * 10);
      const t = Math.floor(rand() * 10);
      src.push(s);
      snk.push(t);
      g.setTerminal(i, s, t);
      const r: [number, number] = [Math.floor(rand() * 8), Math.floor(rand() * 8)];
      const d: [number, number] = [Math.floor(rand() * 8), Math.floor(rand() * 8)];
      right.push(r);
      down.push(d);
      g.setEdge(i, 0, r[0], r[1]);
      g.setEdge(i, 2, d[0], d[1]);
    }
    const flow = g.maxflow();
    // 穷举所有分割：S 一侧付出到汇点的容量，T 一侧付出到源点的容量，S→T 的边付出正向容量
    let best = Infinity;
    for (let mask = 0; mask < 1 << n; mask++) {
      const inS = (i: number) => (mask >> i) & 1;
      let cut = 0;
      for (let i = 0; i < n; i++) {
        cut += inS(i) ? snk[i] : src[i];
        const x = i % w;
        const y = Math.floor(i / w);
        if (x + 1 < w) {
          const j = i + 1;
          if (inS(i) && !inS(j)) cut += right[i][0];
          if (inS(j) && !inS(i)) cut += right[i][1];
        }
        if (y + 1 < h) {
          const j = i + w;
          if (inS(i) && !inS(j)) cut += down[i][0];
          if (inS(j) && !inS(i)) cut += down[i][1];
        }
      }
      best = Math.min(best, cut);
    }
    assert.equal(flow, best, `第 ${trial} 组`);
    // 分割结果本身也是一个最小割
    let cut = 0;
    for (let i = 0; i < n; i++) {
      const si = g.isSource(i);
      cut += si ? snk[i] : src[i];
      const x = i % w;
      const y = Math.floor(i / w);
      if (x + 1 < w) {
        const sj = g.isSource(i + 1);
        if (si && !sj) cut += right[i][0];
        if (sj && !si) cut += right[i][1];
      }
      if (y + 1 < h) {
        const sj = g.isSource(i + w);
        if (si && !sj) cut += down[i][0];
        if (sj && !si) cut += down[i][1];
      }
    }
    assert.equal(cut, best, `第 ${trial} 组的分割`);
  }
});

test('颜色模型：属于自己的颜色代价更低', () => {
  const rand = rng(3);
  const n = 400;
  const s = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const navy = i % 2 === 0;
    s[i * 3] = (navy ? 30 : 200) + rand() * 10;
    s[i * 3 + 1] = (navy ? 40 : 60) + rand() * 10;
    s[i * 3 + 2] = (navy ? 80 : 50) + rand() * 10;
  }
  const m = fitColorModel(s, n);
  assert.ok(m.parts.length >= 2);
  assert.ok(colorCost(m, 35, 45, 85) < colorCost(m, 120, 200, 120));
  assert.ok(colorCost(m, 205, 65, 55) < colorCost(m, 120, 200, 120));
});

// 白色 T 恤平铺在木地板上：地板有两种木色、深色缝隙和噪点，右下角还压着一块蓝色地毯
const W = 200;
const H = 160;
function inTee(x: number, y: number): boolean {
  const torso = x >= 70 && x < 130 && y >= 30 && y < 135;
  const sleeveL = y >= 30 && y < 70 && x >= 40 && x < 70 && y - 30 < (x - 40) * 1.4 + 10;
  const sleeveR = y >= 30 && y < 70 && x >= 130 && x < 160 && y - 30 < (160 - x) * 1.4 + 10;
  const neck = (x - 100) ** 2 / 16 ** 2 + (y - 30) ** 2 / 9 ** 2 < 1;
  return (torso || sleeveL || sleeveR) && !neck;
}
function floorScene(): RGBAImage {
  const rand = rng(11);
  return makeImage(W, H, (x, y) => {
    const noise = () => Math.round((rand() - 0.5) * 16);
    if (inTee(x, y)) {
      const print = (x - 100) ** 2 + (y - 80) ** 2 < 14 ** 2;
      if (print) return [150 + noise(), 40 + noise(), 45 + noise()];
      return [236 + noise() / 2, 235 + noise() / 2, 228 + noise() / 2];
    }
    if (x > 165 && y > 120) return [60 + noise(), 80 + noise(), 140 + noise()];
    if (y % 20 === 0) return [92 + noise(), 70 + noise(), 50 + noise()];
    const plank = Math.floor(y / 20) % 2 === 0;
    const grain = Math.round(Math.sin(x * 0.21 + y) * 6);
    return plank ? [182 + grain + noise(), 142 + grain + noise(), 100 + noise()] : [158 + grain + noise(), 120 + grain + noise(), 84 + noise()];
  });
}

test('杂乱背景：智能去背比按颜色去背准确', () => {
  const img = floorScene();
  const bg = estimateBackground(img);
  const t = suggestThreshold(bg);
  const byColor = removeBackground(img, { threshold: t });
  const smart = smartCut(img, { init: byColor.alpha });
  const a = iou(byColor.alpha, inTee, W, H);
  const b = iou(smart.alpha, inTee, W, H);
  assert.ok(b > 0.93, `智能去背 IoU=${b.toFixed(3)}`);
  assert.ok(b > a, `智能 ${b.toFixed(3)} 应好于按颜色 ${a.toFixed(3)}`);
  // 胸前的深红色印花不能被当成背景挖掉
  assert.equal(smart.alpha[80 * W + 100], 255);
  // 地毯和地板缝都去掉
  assert.equal(smart.alpha[150 * W + 190], 0);
  assert.equal(smart.alpha[100 * W + 20], 0);
});

test('没有初始蒙版时也能从画面中央找出衣物', () => {
  const img = floorScene();
  const smart = smartCut(img);
  assert.ok(iou(smart.alpha, inTee, W, H) > 0.9);
});

test('手动"恢复"几笔，会沿边缘把整块颜色接近背景的部分找回来', () => {
  // 白底上的深色衬衫，领子是米白色，和背景很接近
  const rand = rng(5);
  const inShirt = (x: number, y: number) => x >= 50 && x < 150 && y >= 40 && y < 140;
  const inCollar = (x: number, y: number) => x >= 75 && x < 125 && y >= 22 && y < 40;
  const img = makeImage(200, 160, (x, y) => {
    const n = () => Math.round((rand() - 0.5) * 6);
    if (inShirt(x, y)) return [40 + n(), 50 + n(), 70 + n()];
    if (inCollar(x, y)) return [222 + n(), 218 + n(), 200 + n()];
    return [248 + n() / 2, 248 + n() / 2, 246 + n() / 2];
  });
  const truth = (x: number, y: number) => inShirt(x, y) || inCollar(x, y);
  const plain = smartCut(img, { init: removeBackground(img, { threshold: 18 }).alpha });
  const collarKept = (alpha: Uint8Array) => {
    let k = 0;
    let t = 0;
    for (let y = 22; y < 40; y++) for (let x = 75; x < 125; x++) {
      t++;
      if (alpha[y * 200 + x] > 127) k++;
    }
    return k / t;
  };
  assert.ok(collarKept(plain.alpha) < 0.5, '不涂抹时领子被当作背景');
  const strokes = new Uint8Array(200 * 160);
  paintOverride(strokes, 200, 160, 90, 30, 4, 2);
  const fixed = smartCut(img, { init: removeBackground(img, { threshold: 18 }).alpha, strokes });
  assert.ok(collarKept(fixed.alpha) > 0.9, `涂一笔后领子找回 ${collarKept(fixed.alpha).toFixed(2)}`);
  assert.ok(iou(fixed.alpha, truth, 200, 160) > 0.93);
  // 背景没有被一起带进来
  assert.equal(fixed.alpha[10 * 200 + 10], 0);
  assert.equal(fixed.alpha[30 * 200 + 160], 0);
});

test('手动"擦除"会去掉连在衣物上的阴影', () => {
  const rand = rng(9);
  const inBag = (x: number, y: number) => x >= 60 && x < 130 && y >= 40 && y < 120;
  const inShadow = (x: number, y: number) => x >= 130 && x < 150 && y >= 50 && y < 125;
  const img = makeImage(200, 160, (x, y) => {
    const n = () => Math.round((rand() - 0.5) * 6);
    if (inBag(x, y)) return [150 + n(), 100 + n(), 60 + n()];
    if (inShadow(x, y)) return [150 + n(), 150 + n(), 150 + n()];
    return [235 + n(), 235 + n(), 232 + n()];
  });
  const init = removeBackground(img, { threshold: 14 }).alpha;
  const strokes = new Uint8Array(200 * 160);
  paintOverride(strokes, 200, 160, 140, 90, 4, 1);
  const r = smartCut(img, { init, strokes });
  let shadowLeft = 0;
  for (let y = 50; y < 125; y++) for (let x = 130; x < 150; x++) if (r.alpha[y * 200 + x] > 127) shadowLeft++;
  assert.ok(shadowLeft < 20 * 75 * 0.1, `阴影剩余 ${shadowLeft}`);
  assert.equal(r.alpha[80 * 200 + 95], 255);
});
