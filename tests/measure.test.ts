import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BODY, garmentView, mannequinGeometry, placeGarment } from '../src/core/body';
import { measureShape } from '../src/core/measure';
import { alphaOf } from '../src/core/orient';
import type { Item } from '../src/core/types';
import { makeItem } from './helpers';
import { raster, type Shape } from './raster';

const g = mannequinGeometry(DEFAULT_BODY);

/** 画成贴图（scale 越大像越近拍的，pad 是裁切时四周留的空白）后量一遍，返回带 shape 的单品 */
function photoItem(shapes: Shape[], view: [number, number], cat: Item['category'], subtype: string, scale: number, pad: number, extra: Partial<Item> = {}): Item {
  const r = raster(shapes, view[0], view[1], scale, pad);
  const shape = measureShape(r.alpha, r.w, r.h, cat);
  assert.ok(shape, '量得出来');
  return makeItem(cat, subtype, '#2a3566', { imageAspect: r.w / r.h, shape, ...extra });
}

// T 恤：衣身 x 45～155（宽 110），袖子张开的两种摆法
const TEE = 'M70,8 Q100,30 130,8 L166,20 L198,58 L172,82 L155,70 L155,190 L45,190 L45,70 L28,82 L2,58 L34,20 Z';
const TEE_WIDE = 'M70,8 Q100,30 130,8 L170,16 L236,44 L222,74 L155,62 L155,190 L45,190 L45,62 L-22,74 L-36,44 L30,16 Z';

test('量衣身：袖子不算，宽度和中心对得上', () => {
  const r = raster([{ d: TEE }], 200, 196, 2, 20);
  const s = measureShape(r.alpha, r.w, r.h, 'top')!;
  // 衣身 110 / (200 + 20 / 2 * 2)，按 2 倍画、四周留 20 像素
  assert.ok(Math.abs(s.w - 220 / r.w) < 0.03, `衣身宽度占比 ${s.w}`);
  assert.ok(Math.abs(s.cx - 0.5) < 0.02);
  assert.ok(s.top < 0.12);
});

test('人台上的大小：拍得远近、裁切留白不同，衣身宽度和衣长都一样', () => {
  const near = placeGarment(photoItem([{ d: TEE }], [200, 196], 'top', 'T恤', 3, 10), g);
  const far = placeGarment(photoItem([{ d: TEE }], [200, 196], 'top', 'T恤', 1.2, 30), g);
  const torso = (r: ReturnType<typeof placeGarment>, img: number) => r.width * img;
  // 衣身在人台上的宽度 = 贴图宽 × 衣身占比，两张都应该接近身体宽度 × 放松量
  const nearShape = measureShape(raster([{ d: TEE }], 200, 196, 3, 10).alpha, raster([{ d: TEE }], 200, 196, 3, 10).w, raster([{ d: TEE }], 200, 196, 3, 10).h, 'top')!;
  const farR = raster([{ d: TEE }], 200, 196, 1.2, 30);
  const farShape = measureShape(farR.alpha, farR.w, farR.h, 'top')!;
  const a = torso(near, nearShape.w);
  const b = torso(far, farShape.w);
  assert.ok(Math.abs(a - b) / a < 0.03, `衣身宽度 ${a.toFixed(1)} vs ${b.toFixed(1)}`);
  // 衣长（对齐线到下摆）一样
  const hem = (r: ReturnType<typeof placeGarment>, sh: { bottom?: number }) => r.y + r.height * sh.bottom!;
  assert.ok(Math.abs(hem(near, nearShape) - hem(far, farShape)) < 1.5, `下摆位置 ${hem(near, nearShape).toFixed(1)} vs ${hem(far, farShape).toFixed(1)}`);
  // 肩线对齐
  assert.ok(Math.abs(near.anchorY! - far.anchorY!) < 0.01);
});

test('人台上的大小：袖子张开多少不影响衣身的大小', () => {
  const r1 = raster([{ d: TEE }], 200, 196, 2, 20);
  const r2 = raster([{ d: TEE_WIDE, dx: 40 }], 280, 196, 2, 20);
  const s1 = measureShape(r1.alpha, r1.w, r1.h, 'top')!;
  const s2 = measureShape(r2.alpha, r2.w, r2.h, 'top')!;
  const p1 = placeGarment(makeItem('top', 'T恤', '#222222', { imageAspect: r1.w / r1.h, shape: s1 }), g);
  const p2 = placeGarment(makeItem('top', 'T恤', '#222222', { imageAspect: r2.w / r2.h, shape: s2 }), g);
  const t1 = p1.width * s1.w;
  const t2 = p2.width * s2.w;
  assert.ok(Math.abs(t1 - t2) / t1 < 0.04, `衣身宽度 ${t1.toFixed(1)} vs ${t2.toFixed(1)}`);
  assert.ok(Math.abs(p1.y + p1.height * s1.bottom! - (p2.y + p2.height * s2.bottom!)) < 1.5, '下摆位置一样');
});

test('人台上的大小：衣服在身体正中，版型越宽松越宽，身材越壮越宽', () => {
  const item = photoItem([{ d: TEE }], [200, 196], 'top', 'T恤', 2, 20);
  const p = placeGarment(item, g);
  const center = p.x + p.width * item.shape!.cx;
  assert.ok(Math.abs(center) < 0.5, `衣身中心 ${center}`);
  const loose = placeGarment({ ...item, fit: 'loose' }, g);
  const slim = placeGarment({ ...item, fit: 'slim' }, g);
  assert.ok(loose.width > p.width && p.width > slim.width);
  const big = mannequinGeometry({ ...DEFAULT_BODY, chest: 110, waist: 98, hip: 110, shoulder: 47 });
  assert.ok(placeGarment(item, big).width > p.width * 1.1);
  // 背面和正面范围一致（镜像）
  const back = garmentView(item, g, 'back');
  assert.ok(Math.abs(back.rect.width - p.width) < 1e-6 && Math.abs(back.rect.x + p.x + p.width) < 1e-6);
});

test('人台上的大小：裤子按腰头宽度定，裤长来自照片', () => {
  const PANTS = 'M18,4 L142,4 L142,22 L152,304 L94,304 L80,98 L66,304 L8,304 L18,22 Z';
  const SHORTS = 'M22,4 L148,4 L148,22 L166,134 L94,134 L85,74 L76,134 L4,134 L22,22 Z';
  const pants = photoItem([{ d: PANTS }], [160, 310], 'bottom', '休闲裤', 2, 20);
  const pantsFar = photoItem([{ d: PANTS }], [160, 310], 'bottom', '休闲裤', 0.9, 40);
  const shorts = photoItem([{ d: SHORTS }], [170, 140], 'bottom', '短裤', 2, 20);
  const a = placeGarment(pants, g);
  const b = placeGarment(pantsFar, g);
  const hemOf = (r: ReturnType<typeof placeGarment>, it: Item) => r.y + r.height * it.shape!.bottom!;
  assert.ok(Math.abs(hemOf(a, pants) - hemOf(b, pantsFar)) < 2, '远近不影响裤长');
  const waistOnBody = (r: ReturnType<typeof placeGarment>, it: Item) => r.width * it.shape!.w;
  assert.ok(Math.abs(waistOnBody(a, pants) - waistOnBody(b, pantsFar)) < 0.8, '腰头宽度一样');
  const c = placeGarment(shorts, g);
  assert.ok(hemOf(c, shorts) < hemOf(a, pants) - 30, '短裤比长裤短得多');
  // 长裤落在脚踝附近（不会拖到很远或者只到小腿）
  const hem = hemOf(a, pants);
  assert.ok(hem > g.kneeY + 15 && hem < g.height + 8, `裤脚在 ${hem.toFixed(1)}，脚踝 ${g.ankleY.toFixed(1)}`);
});

test('人台上的大小：录入页调过的大小以肩线中点为基准缩放', () => {
  const item = photoItem([{ d: TEE }], [200, 196], 'top', 'T恤', 2, 20);
  const p = placeGarment(item, g);
  const q = placeGarment({ ...item, sizeAdjust: 1.2 }, g);
  assert.ok(Math.abs(q.width - p.width * 1.2) < 1e-6);
  // 肩线位置不动
  assert.ok(Math.abs(q.y + (p.anchorY! - p.y) * 1.2 - p.anchorY!) < 1e-6);
});

test('人台上的大小：量错了（衣长和按类别估计的差太多）时用原来的摆法', () => {
  const item = makeItem('top', 'T恤', '#222222', { imageAspect: 1, shape: { w: 0.08, cx: 0.5, top: 0 } });
  const p = placeGarment(item, g);
  const old = placeGarment({ ...item, shape: undefined }, g);
  assert.deepEqual(p, old);
  const zero = placeGarment({ ...item, shape: { w: 0, cx: 0.5, top: 0 } }, g);
  assert.deepEqual(zero, old, '量不出来（w = 0）时照原来的方式摆');
  // 量的结果和图片里的位置一致：用 alphaOf 读 RGBA 贴图
  const img = { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(255) };
  assert.equal(alphaOf(img)[0], 255);
});
