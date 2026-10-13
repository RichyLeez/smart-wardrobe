import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoCut, finishPiece } from '../src/core/autocut';
import { removeBackground, suggestThreshold, estimateBackground } from '../src/core/background';
import { smartCut } from '../src/core/smartcut';
import { photo, scenes, score, teeShape } from './scenes';

const [blackTee, whiteTee, stripes] = scenes(0.5);

test('白底上的黑 T 恤：胸前白色印花不再被挖掉，并提示衣服和背景颜色接近', () => {
  const before = smartCut(blackTee.img, { init: removeBackground(blackTee.img, { threshold: suggestThreshold(estimateBackground(blackTee.img)) }).alpha });
  const r = autoCut(blackTee.img);
  assert.equal(r.pieces.length, 1);
  const p = r.pieces[0];
  const printAt = (a: Uint8Array) => a[Math.round(130) * blackTee.w + 150];
  assert.equal(printAt(before.alpha) > 127, false, '原来的去背把印花挖掉了');
  assert.equal(printAt(p.alpha), 255, '补回印花');
  assert.equal(p.gaps.holes, 1);
  assert.ok(score(blackTee, p.alpha).iou > score(blackTee, before.alpha).iou);
  const done = finishPiece(blackTee.img, p.alpha, r.bg, p.gaps);
  assert.ok(done?.lowContrast, '提示和背景接近');
  assert.equal(done?.guess?.category, 'top');
});

test('白底上的藏青白条纹：白条纹补回，整件连起来', () => {
  const r = autoCut(stripes.img);
  const s = score(stripes, r.pieces[0].alpha);
  assert.ok(r.pieces[0].gaps.bridged === 1);
  assert.ok(s.iou > 0.85 && s.whiteKept > 0.75, JSON.stringify(s));
  assert.equal(s.leak < stripes.w * stripes.h * 0.01, true, '没有把床单带进来');
});

test('白底上的白 T 恤：智能去背本身就能分开，不会误补', () => {
  const r = autoCut(whiteTee.img);
  const s = score(whiteTee, r.pieces[0].alpha);
  assert.ok(s.iou > 0.9, JSON.stringify(s));
  assert.equal(r.pieces[0].gaps.addedCount, 0);
});

test('一张照片拍了三件：拆成三件，分别取色、猜类别', () => {
  const W = 600;
  const H = 450;
  const navy: [number, number, number] = [36, 46, 92];
  const khaki: [number, number, number] = [176, 150, 108];
  const red: [number, number, number] = [180, 40, 50];
  const inPants = (x: number, y: number) =>
    (y >= 40 && y < 110 && x >= 340 && x < 470) || (y >= 110 && y < 400 && ((x >= 340 && x < 399) || (x >= 411 && x < 470)));
  const inSock = (x: number, y: number) => x >= 120 && x < 160 && y >= 340 && y < 420;
  const scene = photo(
    '三件',
    W,
    H,
    (x, y) => (teeShape(x / 0.55, y / 0.55) ? navy : inPants(x, y) ? khaki : inSock(x, y) ? red : null),
    () => false,
    [222, 221, 216],
    4,
  );
  const r = autoCut(scene.img, { multi: true });
  assert.equal(r.pieces.length, 3, `拆出 ${r.pieces.length} 件`);
  const done = r.pieces.map((p) => finishPiece(scene.img, p.alpha, r.bg, p.gaps)!);
  assert.equal(done[0].guess?.subtype, 'T恤');
  const navyName = done[0].colors?.primary.name ?? '';
  assert.ok(/藏青|蓝/.test(navyName), navyName);
  assert.equal(done[1].guess?.category, 'bottom');
  assert.ok(done[2].box.width < 80 && done[2].box.height < 120, '袜子单独成一件');
  // 每件只含自己：T 恤这件里没有裤子的像素
  assert.equal(r.pieces[0].alpha[200 * W + 400], 0);
});
