import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoCut, finishPiece } from '../src/core/autocut';
import { frameContact, frameContactText } from '../src/core/frame';
import { normAngle, rotateImage } from '../src/core/orient';
import { draftPendingItem } from '../src/core/pending';
import { photo, scenes, teeShape } from './scenes';
import { raster } from './raster';
import { OUTLINES } from './outlines';

const NAVY: [number, number, number] = [34, 46, 92];

test('碰到照片边缘：下摆出了画面的 T 恤提示碰到了下边', () => {
  // T 恤往下挪，下摆超出照片
  const s = photo('下摆出画', 300, 300, (x, y) => (teeShape(x, y - 60, 0.5) ? NAVY : null), () => false);
  const r = autoCut(s.img);
  const c = frameContact(s.img, r.pieces[0].alpha);
  assert.deepEqual(c.sides, ['bottom']);
  assert.equal(frameContactText(c.sides), '衣服碰到了照片的下边');
  assert.equal(frameContactText(['top', 'left']), '衣服碰到了照片的上边和左边');
});

test('碰到照片边缘：四周都留了背景的不提示', () => {
  for (const s of scenes(0.5)) {
    const r = autoCut(s.img);
    assert.deepEqual(frameContact(s.img, r.pieces[0].alpha).sides, [], s.name);
  }
});

test('碰到照片边缘：背景和衣服颜色几乎一样时说不清，不提示', () => {
  const s = photo('同色背景', 300, 300, (x, y) => (teeShape(x, y, 0.5) ? [228, 226, 220] : null), () => true, [236, 234, 228]);
  const alpha = new Uint8Array(300 * 300);
  for (let y = 0; y < 300; y++) for (let x = 0; x < 300; x++) if (teeShape(x, y, 0.5)) alpha[y * 300 + x] = 255;
  assert.deepEqual(frameContact(s.img, alpha).sides, []);
});

test('流水线：横着拍的连帽外套 → 转正、量出帽子、猜成上衣或外套；碰到边缘的写进待整理', () => {
  // 把连帽外套的轮廓画在床单上，再整张转 90°（领口朝右）
  const d = OUTLINES.parka;
  const r0 = raster(d.shapes, d.view[0], d.view[1], 1.1, 40);
  const s = photo(
    '连帽外套',
    r0.w,
    r0.h,
    (x, y) => (r0.alpha[Math.round(y) * r0.w + Math.round(x)] > 127 ? [58, 104, 70] : null),
    () => false,
  );
  const sideways = rotateImage(s.img, -90);
  const cut = autoCut(sideways);
  const done = finishPiece(sideways, cut.pieces[0].alpha, cut.bg, cut.pieces[0].gaps)!;
  assert.ok(Math.abs(normAngle(-90 + done.angle)) <= 1.5, `转正了（转了 ${done.angle}°）`);
  assert.ok(done.guess?.category === 'top' || done.guess?.category === 'outer', `猜成 ${done.guess?.category}（不看帽子才认得出袖子）`);
  assert.ok(done.hood > 0.15 && done.hood < 0.32, `帽子占 ${done.hood.toFixed(3)}`);
  assert.equal(done.frame.sides.length, 0);
  const item = draftPendingItem({
    id: 'p1',
    color: { hex: '#3a6846', name: '墨绿' },
    guess: done.guess,
    images: { cutout: 'c', thumb: 't' },
    aspect: done.cropped.width / done.cropped.height,
    lowContrast: false,
    frameSides: ['left'],
    hoodTop: done.hood,
    now: 1,
  });
  assert.ok((item.hoodTop ?? 0) > 0.15);
  assert.match(item.reviewNote ?? '', /衣服碰到了照片的左边/);
  // 没帽子的也记下 0（量过了，不用再量）
  const plain = draftPendingItem({ ...{ id: 'p2', color: { hex: '#222222', name: '黑色' }, guess: null, images: { cutout: 'c', thumb: 't' }, aspect: 1, lowContrast: false, now: 2 }, hoodTop: 0 });
  assert.equal(plain.hoodTop, 0);
});
