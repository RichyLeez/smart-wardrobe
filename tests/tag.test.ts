import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalBrand, mainFiber, normalizeTagText, parseTagText } from '../src/core/tag';

const fibers = (p: ReturnType<typeof parseTagText>) => p.fibers.map((f) => `${f.part}:${f.name}:${f.pct}`);

test('吊牌：中英双语的优衣库 T 恤', () => {
  const p = parseTagText(`UNIQLO
优衣库
商品编号 / ITEM NO. 455361
尺码 SIZE M
号型 170/92A
面料：棉 100%
FABRIC: COTTON 100%
执行标准：GB/T 22849-2014
安全类别：GB 18401 B类
品名：男装 圆领T恤(短袖)`);
  assert.equal(p.brand, '优衣库');
  assert.equal(p.styleNo, '455361');
  assert.equal(p.size, 'M');
  assert.equal(p.sizeCode, '170/92A');
  assert.deepEqual(fibers(p), ['shell:棉:100']);
  assert.equal(p.materialText, '棉 100%');
  assert.equal(p.category, 'top');
  assert.equal(p.subtype, 'T恤');
  assert.equal(p.subtypeSource, 'name');
  const std = p.standards.find((s) => s.code.startsWith('GB/T 22849'));
  assert.equal(std?.label, '针织T恤衫');
  assert.ok(p.standards.some((s) => s.code.startsWith('GB 18401')), '安全规范也被记录');
});

test('吊牌：文字识别把每个字分开、百分号前有空格、把 0 认成 O', () => {
  const p = parseTagText(`品 牌 : 太 平 鸟
货 号 : B1DAD3101
号 型 : 175/96A
规 格 : L
成 分 : 面 料 : 聚 酯 纤 维 65 % 粘 纤 35 %
里 料 : 聚 酯 纤 维 1OO %
执 行 标 准 : GB/T 2664-2017
等 级 : 合 格 品
品 名 : 西 装 外 套
版 型 : 修 身`);
  assert.equal(p.brand, '太平鸟');
  assert.equal(p.styleNo, 'B1DAD3101');
  assert.equal(p.sizeCode, '175/96A');
  assert.equal(p.size, 'L');
  assert.deepEqual(fibers(p), ['shell:聚酯纤维:65', 'shell:粘纤:35', 'lining:聚酯纤维:100']);
  assert.equal(p.materialText, '聚酯纤维 65%，粘纤 35%；里料 聚酯纤维 100%');
  assert.equal(p.category, 'outer');
  assert.equal(p.subtype, '西装外套');
  assert.equal(p.fit, 'slim');
  assert.equal(p.standards[0].label, '男西服、大衣');
});

test('吊牌：羽绒服的填充物和含绒量会提示厚实', () => {
  const p = parseTagText(`波司登 BOSIDENG
品名：男士羽绒服
面料：锦纶 100%
里料：聚酯纤维 100%
填充物：白鸭绒 含绒量 90%
充绒量：180g
执行标准：GB/T 14272-2021
号型：180/96A`);
  assert.equal(p.brand, '波司登');
  assert.equal(p.subtype, '羽绒服');
  assert.equal(p.downContent, 90);
  assert.equal(p.warmthHint, 3);
  assert.ok(fibers(p).includes('filling:鸭绒:90'));
  assert.ok(fibers(p).includes('shell:锦纶:100'));
});

test('吊牌：牛仔裤的 W/L 尺码、英文成分和直筒版型', () => {
  const p = parseTagText(`Levi's 李维斯
STYLE NO. 00501-0101
SIZE W30 L32
501 ORIGINAL FIT 直筒
COTTON 99% ELASTANE 1%
品名：牛仔裤
执行标准：FZ/T 81006-2017`);
  assert.equal(p.brand, '李维斯');
  assert.equal(p.styleNo, '00501-0101');
  assert.equal(p.size, 'W30');
  assert.deepEqual(fibers(p), ['shell:棉:99', 'shell:氨纶:1']);
  assert.equal(p.stretch, false);
  assert.equal(p.fit, 'regular');
  assert.equal(p.subtype, '牛仔裤');
});

test('吊牌：百分比在前、含 2% 以上氨纶算有弹性', () => {
  const p = parseTagText('成分：95%棉 5%氨纶\n品名：针织打底衫');
  assert.deepEqual(fibers(p), ['shell:棉:95', 'shell:氨纶:5']);
  assert.equal(p.stretch, true);
  assert.equal(p.subtype, '打底衫');
});

test('洗标上的常见英文不会被误认成品牌或长度', () => {
  const p = parseTagText(`100% COTTON
MACHINE WASH COLD
DO NOT BLEACH
DRY CLEAN ONLY
LONG SLEEVE`);
  assert.equal(p.brand, undefined);
  assert.equal(p.length, undefined);
  assert.deepEqual(fibers(p), ['shell:棉:100']);
});

test('品名里的"棉"不会被当成 100% 棉；人造棉归为粘纤', () => {
  const p = parseTagText('品名：棉服\n面料：聚酯纤维100%');
  assert.deepEqual(fibers(p), ['shell:聚酯纤维:100']);
  assert.equal(p.subtype, '棉服');
  assert.equal(mainFiber('人造棉 100%'), '粘纤');
});

test('品名缺失时按执行标准推断类别；"企业名称"不当作品名', () => {
  const p = parseTagText('企业名称：某某服饰有限公司\n执行标准：GB/T 2660-2017\n号型：165/84A');
  assert.equal(p.productName, undefined);
  assert.equal(p.category, 'top');
  assert.equal(p.subtype, '衬衫');
  assert.equal(p.subtypeSource, 'standard');
});

test('主要面料和品牌统一写法', () => {
  assert.equal(mainFiber('棉 95%，氨纶 5%'), '棉');
  assert.equal(mainFiber('聚酯纤维 35%，羊毛 65%；里料 聚酯纤维 100%'), '羊毛');
  assert.equal(mainFiber('羊毛'), '羊毛');
  assert.equal(mainFiber('麂皮'), '麂皮');
  assert.equal(mainFiber(''), undefined);
  assert.equal(canonicalBrand('uniqlo'), '优衣库');
  assert.equal(canonicalBrand(' 某小众品牌 '), '某小众品牌');
  assert.equal(normalizeTagText('棉 ９５％'), '棉 95%');
});
