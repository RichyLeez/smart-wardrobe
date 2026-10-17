import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { floatToHalf, halfToFloat, parseModel, postprocess, preprocess, resizeBilinear, runCpu, type ConvOp } from '../src/core/u2net';

const model = parseModel(new Uint8Array(readFileSync('public/models/u2net.bin')).buffer);

test('抠图模型：文件能读，结构完整', () => {
  assert.equal(model.inputSize, 320);
  assert.equal(model.tensors[0], 3);
  const convs = model.ops.filter((o): o is ConvOp => o.t === 'conv');
  assert.equal(convs.length, 119);
  assert.equal(model.tensors[model.output], 1);
  // 每个卷积的输入通道数等于各输入张量通道数之和
  for (const c of convs) assert.equal(c.ins.reduce((s, t) => s + model.tensors[t], 0), c.i);
  // 最后一个算子算出输出，并带 sigmoid
  const last = model.ops[model.ops.length - 1] as ConvOp;
  assert.equal(last.out, model.output);
  assert.ok(last.sigmoid);
  assert.ok(convs.some((c) => c.q === 'i8') && convs.some((c) => c.q === 'f16'));
});

test('半精度转换：来回转换误差在半精度范围内', () => {
  for (const v of [0, 1, -1, 0.1, 3.14159, 65504, 1e-5, -0.000061, 122.8]) {
    const back = halfToFloat(floatToHalf(v));
    assert.ok(Math.abs(back - v) <= Math.abs(v) * 1e-3 + 1e-7, `${v} → ${back}`);
  }
  assert.equal(floatToHalf(1), 0x3c00);
  assert.equal(floatToHalf(-2), 0xc000);
});

test('CPU 实现和 Python 参考实现的输出一致（64×64 的白底黑 T 恤）', () => {
  const buf = readFileSync('tests/fixtures/u2net-64.bin');
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const input = f.slice(0, 3 * 64 * 64);
  const ref = f.slice(3 * 64 * 64);
  const y = runCpu(model, input, 64, 64);
  let maxDiff = 0;
  for (let i = 0; i < ref.length; i++) maxDiff = Math.max(maxDiff, Math.abs(y[i] - ref[i]));
  assert.ok(maxDiff < 1e-3, `最大差 ${maxDiff}`);
});

test('输入输出整理：归一化、拉伸到 0~255 并放大到照片尺寸', () => {
  const img = { width: 8, height: 4, data: new Uint8ClampedArray(8 * 4 * 4).fill(128) };
  const x = preprocess(img, 4, [0.5, 0.5, 0.5], [0.25, 0.25, 0.25]);
  // 除以最大值后是 1，(1 - 0.5) / 0.25 = 2
  assert.ok(x.every((v) => Math.abs(v - 2) < 1e-6));
  const p = new Float32Array([0.1, 0.1, 0.9, 0.9]);
  const out = postprocess(p, 2, 4, 2);
  assert.equal(out[0], 0);
  assert.equal(out[7], 255, "下面一行是 0.9，拉伸后是 255");
  assert.deepEqual([...resizeBilinear(new Float32Array([0, 1]), 1, 1, 2, 1, 4)].map((v) => +v.toFixed(2)), [0, 0.25, 0.75, 1]);
});
