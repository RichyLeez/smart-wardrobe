import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoCut } from '../src/core/autocut';
import { modelConfidence } from '../src/core/u2net';
import { scenes, score } from './scenes';

const [blackTee, , stripes] = scenes(0.5);

/** 模拟模型结果：真值蒙版模糊一下（模型在 320×320 上算，边缘是软的），里面 0.97，外面 0.02 */
function fakePrior(truth: Uint8Array, w: number, h: number, missing?: (x: number, y: number) => boolean): Uint8Array {
  const out = new Uint8Array(w * h);
  const r = 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let c = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          s += truth[yy * w + xx];
          c++;
        }
      }
      let p = 0.02 + 0.95 * (s / c);
      if (missing?.(x, y)) p = 0.03;
      out[y * w + x] = Math.round(p * 255);
    }
  }
  return out;
}

test('识别模型：白底黑 T 恤的白罗纹领口、白下摆贴着轮廓，按颜色分不出来，加上模型后保留', () => {
  const s = blackTee;
  const before = score(s, autoCut(s.img).pieces[0].alpha);
  const prior = fakePrior(s.truth, s.w, s.h);
  const after = score(s, autoCut(s.img, { prior, priorWeight: 10 }).pieces[0].alpha);
  assert.ok(after.whiteKept > before.whiteKept + 0.15, `白色部分保留 ${before.whiteKept} → ${after.whiteKept}`);
  assert.ok(after.iou > before.iou + 0.04 && after.iou > 0.94, `IoU ${before.iou} → ${after.iou}`);
  assert.ok(after.leak < s.w * s.h * 0.01, '没有把床单带进来');
});

test('识别模型：条纹延伸到侧缝和袖口的白条纹也补上', () => {
  const s = stripes;
  const before = score(s, autoCut(s.img).pieces[0].alpha);
  const after = score(s, autoCut(s.img, { prior: fakePrior(s.truth, s.w, s.h), priorWeight: 10 }).pieces[0].alpha);
  assert.ok(after.iou > before.iou + 0.04 && after.iou > 0.92, `IoU ${before.iou} → ${after.iou}`);
});

test('识别模型只"补"不"删"：模型漏掉一截袖子时，按颜色认出的袖子照样保留', () => {
  const s = blackTee;
  // 模型把左袖（图的左上角）当成背景
  const prior = fakePrior(s.truth, s.w, s.h, (x, y) => x < s.w * 0.3 && y < s.h * 0.45);
  const a = autoCut(s.img, { prior, priorWeight: 10 }).pieces[0].alpha;
  // 左袖中间一点（按 600 坐标的 T 恤轮廓，缩放 0.5）
  const x = Math.round(140 * 0.5);
  const y = Math.round(170 * 0.5);
  assert.equal(s.truth[y * s.w + x], 1, '这里确实是袖子');
  assert.equal(a[y * s.w + x], 255, '袖子保留');
});

test('识别模型：权重为 0（模型对照片没把握）时和不用模型的结果一样', () => {
  const s = blackTee;
  const prior = new Uint8Array(s.w * s.h).fill(200);
  const a = autoCut(s.img).pieces[0].alpha;
  const b = autoCut(s.img, { prior, priorWeight: 0 }).pieces[0].alpha;
  assert.deepEqual(b, a);
});

test('模型的把握：结果非黑即白时完全信任，大片拿不准时不用', () => {
  const n = 320 * 320;
  const clean = new Float32Array(n).map((_, i) => (i % 320 < 160 ? 0.99 : 0.01));
  assert.equal(modelConfidence(clean), 1);
  const murky = new Float32Array(n).map((_, i) => (i % 3 === 0 ? 0.5 : i % 2 ? 0.9 : 0.05));
  assert.equal(modelConfidence(murky), 0);
  const some = new Float32Array(n).map((_, i) => (i % 100 < 15 ? 0.5 : 0.99));
  const c = modelConfidence(some);
  assert.ok(c > 0 && c < 1, `15% 拿不准时部分信任：${c}`);
});
