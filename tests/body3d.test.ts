import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BODY, garmentView, mannequinGeometry } from '../src/core/body';
import { MeshBuilder, body3d, bodyMesh, envelopeDepth, partByName, sectionDepth, sweep } from '../src/core/body3d';
import { DepthMap, backUV, frontUV, outfitShells, sampleAlpha, shellGrid, shellMesh, type AlphaGrid, type ShellInput } from '../src/core/garment3d';
import type { Item } from '../src/core/types';

/** 把多边形（照片像素坐标）栅格化成透明度网格 */
function polyMask(poly: number[][], w: number, h: number, mw = 160): AlphaGrid {
  const mh = Math.round((mw * h) / w);
  const alpha = new Uint8Array(mw * mh);
  const inside = (x: number, y: number) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) alpha[y * mw + x] = inside(((x + 0.5) * w) / mw, ((y + 0.5) * h) / mh) ? 255 : 0;
  return { width: mw, height: mh, alpha };
}

// 示例衣橱里的针织衫轮廓（240×234）和半身裙（190×214）
const KNIT = [[82, 12], [120, 26], [158, 12], [194, 26], [236, 180], [210, 192], [172, 88], [172, 228], [68, 228], [68, 88], [30, 192], [4, 180], [46, 26]];
const SKIRT = [[50, 4], [140, 4], [140, 22], [186, 208], [4, 208], [50, 22]];

type PlaceItem = Pick<Item, 'category' | 'subtype' | 'length' | 'rise' | 'imageAspect' | 'images' | 'backAspect'>;
const knitItem: PlaceItem = { category: 'top', subtype: '针织衫', length: 'regular', rise: undefined, imageAspect: 240 / 234, images: { cutout: 'f', thumb: 't' } };
const skirtItem: PlaceItem = { category: 'bottom', subtype: '半身裙', length: 'regular', rise: 'mid', imageAspect: 190 / 214, images: { cutout: 's', thumb: 't' } };

test('3D 人台尺寸来自身材数据，网格完整、法线朝外', () => {
  const m = body3d(DEFAULT_BODY);
  const g = m.g;
  const torso = partByName(m, 'torso');
  const chest = torso.section(g.chestY);
  assert.ok(Math.abs(chest.a - g.chestHalf) < 0.5, `胸部半宽 ${chest.a}`);
  assert.ok(chest.b < chest.a && chest.b > chest.a * 0.5, '胸部厚度小于宽度');
  const mesh = bodyMesh(m);
  const n = mesh.positions.length / 3;
  assert.ok(n > 1000 && n < 65536);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const [x, y, z] = [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];
    const [nx, ny, nz] = [mesh.normals[i * 3], mesh.normals[i * 3 + 1], mesh.normals[i * 3 + 2]];
    assert.ok(Number.isFinite(x + y + z + nx + ny + nz), '没有无效数值');
    assert.ok(Math.abs(Math.hypot(nx, ny, nz) - 1) < 1e-3, '法线是单位向量');
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  assert.ok(Math.abs(minY) < 0.5, `脚底贴地 ${minY}`);
  assert.ok(Math.abs(maxY - DEFAULT_BODY.height) < 0.5, `头顶在身高处 ${maxY}`);
  for (const i of mesh.indices) assert.ok(i < n);
  // 每一段的法线都背离该段截面中心
  for (const part of m.parts) {
    const mb = new MeshBuilder();
    sweep(mb, g.height, part.y0, part.y1, part.rows, 16, part.section);
    const pm = mb.build();
    const k = pm.positions.length / 3;
    let outward = 0;
    for (let i = 0; i < k; i++) {
      const y = g.height - pm.positions[i * 3 + 1];
      const s = part.section(Math.max(part.y0, Math.min(part.y1, y)));
      const dx = pm.positions[i * 3] - s.cx;
      const dz = pm.positions[i * 3 + 2] - s.cz;
      if (pm.normals[i * 3] * dx + pm.normals[i * 3 + 2] * dz >= -1e-6) outward++;
    }
    assert.ok(outward / k > 0.97, `${part.name} 法线朝外 ${outward}/${k}`);
  }
});

test('臀围更大，臀部截面更宽', () => {
  const a = body3d({ ...DEFAULT_BODY, hip: 90 });
  const b = body3d({ ...DEFAULT_BODY, hip: 104 });
  const wa = partByName(a, 'torso').section(a.g.hipY).a;
  const wb = partByName(b, 'torso').section(b.g.hipY).a;
  assert.ok(wb > wa + 1.5, `${wa} → ${wb}`);
});

test('截面深度：中心最厚，超出宽度为 -1，外扩后变大', () => {
  const s = { cx: 0, cz: 0, a: 10, b: 6, p: 2 };
  assert.equal(sectionDepth(s, 0), 6);
  assert.equal(sectionDepth(s, 11), -1);
  assert.ok(sectionDepth(s, 11, 2) > 0);
});

test('正面 / 背面贴图坐标：背面从身后看是镜像', () => {
  const rect = { x: -20, y: 30, width: 40, height: 60 };
  assert.deepEqual(frontUV(rect, -20, 30), [0, 0]);
  assert.deepEqual(frontUV(rect, 20, 90), [1, 1]);
  // 身体右侧（x 为正）从身后看在观察者左手边
  assert.deepEqual(backUV(rect, 20, 30), [0, 0]);
  assert.deepEqual(backUV(rect, -20, 90), [1, 1]);
});

test('背面视图：有背面照片用背面，没有时用正面照片镜像', () => {
  const g = mannequinGeometry(DEFAULT_BODY);
  const bag: PlaceItem = { category: 'bag', subtype: '托特包', length: undefined, rise: undefined, imageAspect: 0.86, images: { cutout: 'f', thumb: 't' } };
  const front = garmentView(bag, g, 'front');
  const back = garmentView(bag, g, 'back');
  assert.equal(back.image, 'f');
  assert.equal(back.mirrored, true);
  assert.ok(front.rect.x > 0 && back.rect.x < 0, '包在正面右侧，背面看在左侧');
  assert.ok(Math.abs(back.rect.x + front.rect.x + front.rect.width) < 1e-9);
  const withBack = garmentView({ ...knitItem, images: { cutout: 'f', thumb: 't', backCutout: 'b', backThumb: 'bt' }, backAspect: 1.2 }, g, 'back');
  assert.equal(withBack.image, 'b');
  assert.equal(withBack.mirrored, false);
});

function knitInput(layer = 0): ShellInput {
  const m = body3d(DEFAULT_BODY);
  return { category: 'top', subtype: '针织衫', front: { rect: garmentView(knitItem, m.g, 'front').rect, mask: polyMask(KNIT, 240, 234) }, layer };
}

test('衣身包住身体，前后两片在两侧合拢', () => {
  const m = body3d(DEFAULT_BODY);
  const input = knitInput();
  const grid = shellGrid(m, input);
  const cols = grid.xs.length;
  const torso = partByName(m, 'torso');
  let checked = 0;
  for (let k = 0; k < grid.depth.length; k++) {
    if (!grid.opaque[k] || grid.sleeve[k] >= 0.5) continue;
    const y = grid.py[k];
    if (y < m.g.chestY || y > m.g.waistY) continue;
    const body = envelopeDepth([torso], y, grid.px[k], 0);
    assert.ok(grid.depth[k] >= body, `(${grid.px[k].toFixed(1)}, ${y.toFixed(1)}) 衣服 ${grid.depth[k].toFixed(2)} 不应在身体 ${body.toFixed(2)} 里面`);
    checked++;
  }
  assert.ok(checked > 100);
  for (let i = 0; i < grid.ys.length; i++) {
    assert.equal(grid.depth[i * cols], 0);
    assert.equal(grid.depth[i * cols + cols - 1], 0);
  }
});

test('平铺张开的袖子转到手臂上，做成包住手臂的圆筒', () => {
  const m = body3d(DEFAULT_BODY);
  const input = knitInput();
  const grid = shellGrid(m, input);
  assert.equal(grid.tubes.length, 2, '左右两只袖子');
  for (const t of grid.tubes) {
    const arm = partByName(m, t.side > 0 ? 'armR' : 'armL');
    assert.ok(t.rings.length > 10);
    for (const r of t.rings) {
      if (r.y < arm.y0 || r.y > arm.y1) continue;
      const s = arm.section(r.y);
      assert.ok(Math.abs(r.c - s.cx) < 0.01, '圆筒中心在手臂上');
      assert.ok(r.hwT >= s.a && r.b >= s.b, '圆筒比手臂粗');
    }
  }
  // 圆筒中间一圈的贴图坐标落在照片里的袖子上
  const mesh = shellMesh(m, input, grid);
  const uv = mesh.uvFront!;
  const side = mesh.side!;
  const mask = input.front.mask;
  let onSleeve = 0;
  let total = 0;
  const n = mesh.positions.length / 3;
  for (let i = n - 2000; i < n; i++) {
    if (side[i] !== 1) continue;
    total++;
    if (sampleAlpha(mask, uv[i * 2], uv[i * 2 + 1]) > 128) onSleeve++;
  }
  assert.ok(onSleeve / total > 0.6, `袖子圆筒的正面大多贴到袖子 ${onSleeve}/${total}`);
});

test('外层包住里层：半身裙外面再穿一层时不会被裙摆穿出', () => {
  const m = body3d(DEFAULT_BODY);
  const skirt: ShellInput = {
    category: 'bottom',
    subtype: '半身裙',
    front: { rect: garmentView(skirtItem, m.g, 'front').rect, mask: polyMask(SKIRT, 190, 214) },
    layer: 0,
  };
  const coat: ShellInput = { ...skirt, category: 'dress', subtype: '连衣裙', layer: 1 };
  const [inner, outer] = outfitShells(m, [skirt, coat]);
  assert.ok(inner.indices.length > 0 && outer.indices.length > 0);
  // 和 outfitShells 一样记录里层，再生成外层
  const gInner = shellGrid(m, skirt);
  const layers = { body: new DepthMap(m.g.height), arms: new DepthMap(m.g.height) };
  for (let k = 0; k < gInner.depth.length; k++) if (gInner.opaque[k]) layers.body.splat(gInner.px[k], gInner.py[k], gInner.depth[k]);
  const wrapped = shellGrid(m, coat, layers);
  let checked = 0;
  for (let k = 0; k < wrapped.depth.length; k++) {
    if (!wrapped.opaque[k]) continue;
    const z = layers.body.at(wrapped.px[k], wrapped.py[k]);
    if (z <= 0) continue;
    assert.ok(wrapped.depth[k] >= z + 0.49, '外层比里层厚');
    checked++;
  }
  assert.ok(checked > 100);
});

test('眼镜、项链从身后看不到，不生成背面', () => {
  const m = body3d(DEFAULT_BODY);
  const glasses: ShellInput = {
    category: 'jewelry',
    subtype: '眼镜',
    front: { rect: { x: -8, y: 8, width: 16, height: 5 }, mask: polyMask([[0, 0], [100, 0], [100, 30], [0, 30]], 100, 30, 60) },
    layer: 0,
  };
  const mesh = shellMesh(m, glasses, shellGrid(m, glasses));
  const n = mesh.positions.length / 3;
  for (let t = 0; t < mesh.indices.length; t++) assert.equal(mesh.side![mesh.indices[t]], 1, '三角形都在正面');
  assert.ok(n > 0);
});
