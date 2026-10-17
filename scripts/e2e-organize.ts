// 端到端测试：录入时自动分类、直接存进衣橱（未核对），在「整理」里按类别成批修改（网站版，本机存储）。
// 运行：npm run build && node --import tsx scripts/e2e-organize.ts [截图目录]

import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium, type Page } from 'playwright';

const SHOTS = process.argv[2] ?? 'e2e-shots';
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/^\/smart-wardrobe/, '');
  if (p.endsWith('/')) p += 'index.html';
  try {
    const body = await readFile(join('dist', p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise<void>((r) => server.listen(5207, r));

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error(`检查失败：${msg}`);
  console.log(`  ✓ ${msg}`);
}

await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch();
const errors: string[] = [];

type Kind = 'tee' | 'pants' | 'sweater' | 'cutoff';

/**
 * 在页面里画测试照片（浅色床单上平铺）：
 * tee：藏青短袖 T 恤；pants：炭灰长裤（两条腿）；sweater：酒红长袖短款上衣（只能猜到"上衣"）；
 * cutoff：墨绿连帽外套，下摆出了画面（碰到左边）。
 */
async function draw(page: Page, kind: Kind): Promise<Buffer> {
  const b64 = await page.evaluate((k) => {
    const W = 1200;
    const H = 900;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ecebe5';
    ctx.fillRect(0, 0, W, H);
    const shapes: Record<string, { d: string; color: string; x: number; y: number; s: number; rot?: number }> = {
      tee: { d: 'M70,8 Q100,30 130,8 L166,20 L198,58 L172,82 L155,70 L155,190 L45,190 L45,70 L28,82 L2,58 L34,20 Z', color: '#26315e', x: 280, y: 150, s: 3.2 },
      pants: { d: 'M20,0 L180,0 L190,300 L115,300 L100,90 L85,300 L10,300 Z', color: '#3a3b3f', x: 420, y: 60, s: 2.6 },
      sweater: { d: 'M75,6 Q105,22 135,6 L170,14 L208,150 L184,158 L160,70 L160,166 L50,166 L50,70 L26,158 L2,150 L40,14 Z', color: '#6d1e2d', x: 260, y: 160, s: 3.2 },
      cutoff: {
        d: 'M70,80 Q70,4 105,4 Q140,4 140,80 L180,92 L206,200 L182,208 L166,130 L166,296 L44,296 L44,130 L28,208 L4,200 L30,92 Z',
        color: '#3d6b48',
        x: 690,
        y: 160,
        s: 2.6,
        rot: Math.PI / 2,
      },
    };
    const sh = shapes[k];
    ctx.save();
    ctx.translate(sh.x, sh.y);
    if (sh.rot) ctx.rotate(sh.rot);
    ctx.scale(sh.s, sh.s);
    const p = new Path2D(sh.d);
    ctx.save();
    ctx.translate(4, 5);
    ctx.filter = 'blur(3px)';
    ctx.fillStyle = 'rgba(60,50,40,0.16)';
    ctx.fill(p);
    ctx.restore();
    ctx.fillStyle = sh.color;
    ctx.fill(p);
    ctx.restore();
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  }, kind);
  return Buffer.from(b64, 'base64');
}

interface Stored {
  id: string;
  name: string;
  status: string;
  category: string;
  subtype: string;
  seasons: string[];
  occasions: string[];
  rise?: string;
  unverified?: boolean;
  reviewNote?: string;
  hoodTop?: number;
}

/** 从本机数据库读出单品（按录入顺序） */
async function storedItems(page: Page): Promise<Stored[]> {
  return page.evaluate(
    () =>
      new Promise<Stored[]>((resolve, reject) => {
        const req = indexedDB.open('smart-wardrobe');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const all = req.result.transaction('items', 'readonly').objectStore('items').getAll();
          all.onsuccess = () => resolve((all.result as Array<{ createdAt: number }>).sort((a, b) => a.createdAt - b.createdAt) as never);
          all.onerror = () => reject(all.error);
        };
      }),
  );
}

try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`console: ${m.text()}`));
  await page.addInitScript('window.__name = (f) => f;');
  await page.goto('http://localhost:5207/smart-wardrobe/');
  await page.locator('.boot').waitFor({ state: 'detached', timeout: 15000 });
  const photos = {
    tee: await draw(page, 'tee'),
    pants: await draw(page, 'pants'),
    sweater: await draw(page, 'sweater'),
    cutoff: await draw(page, 'cutoff'),
  };
  const tabbar = page.locator('nav.tabbar');
  const organize = () => page.locator('.overlay[aria-label="整理"]');
  const bar = () => page.locator('.org-bar');
  const sheet = () => page.locator('.sheet');
  const tile = (name: string) => organize().locator('.org-pick', { hasText: name }).first();

  console.log('录入时直接存进衣橱：');
  await tabbar.getByRole('button', { name: '衣橱' }).click();
  async function quickAdd(kind: Kind) {
    await page.locator('.topbar').getByRole('button', { name: '录入单品' }).click();
    await page.getByTestId('photo-input').setInputFiles({ name: `${kind}.jpg`, mimeType: 'image/jpeg', buffer: photos[kind] });
    await page.getByRole('button', { name: '存进衣橱' }).waitFor({ timeout: 30000 });
    if (kind === 'tee') {
      check(await page.getByText('按衣服轮廓自动分好类别和款式').isVisible(), '说明「存进衣橱」会自动分类');
      await page.screenshot({ path: `${SHOTS}/organize-01-cutout.png` });
    }
    if (kind === 'cutoff') check(await page.locator('.warnbox', { hasText: '衣服碰到了照片的' }).isVisible(), '碰到边缘照样提示');
    await page.getByRole('button', { name: '存进衣橱' }).click();
    await page.getByText(/已录入/).waitFor({ timeout: 20000 });
    await page.locator('.overlay').waitFor({ state: 'detached' });
  }
  await quickAdd('tee');
  let items = await storedItems(page);
  check(items.length === 1, '存好一件，不用填信息页');
  const tee = items[0];
  check(tee.status === 'active' && tee.unverified === true, '直接在用，标为未核对');
  check(tee.category === 'top' && tee.subtype === 'T恤', `按轮廓认成 T 恤（${tee.name}）`);
  check(tee.seasons.length > 0 && tee.occasions.length > 0, '季节、场合按款式填好');
  await quickAdd('pants');
  await quickAdd('sweater');
  await quickAdd('cutoff');
  items = await storedItems(page);
  check(items.length === 4 && items.every((i) => i.unverified), '四件都直接进了衣橱');
  const pants = items[1];
  const sweater = items[2];
  const parka = items[3];
  check(pants.category === 'bottom', `长裤认成下装（${pants.subtype || '款式没认出'}）`);
  check(/左边/.test(parka.reviewNote ?? ''), `碰到边缘写进提示（${parka.reviewNote}）`);
  console.log(`    猜的结果：${items.map((i) => `${i.name}=${i.category}/${i.subtype || '-'}`).join('，')}`);
  const noSub = items.filter((i) => !i.subtype).length;

  console.log('衣橱里的提示和整理入口：');
  const notice = page.locator('.notice-line');
  check(/4 件是录入时自动分的类/.test(await notice.innerText()), '衣橱顶部说明有 4 件没核对');
  await page.screenshot({ path: `${SHOTS}/organize-02-wardrobe.png` });
  await notice.click();
  await organize().waitFor();
  check((await organize().locator('.chips').getByRole('button', { name: /未核对/ }).getAttribute('aria-pressed')) === 'true', '从提示进来先看未核对的');
  check((await organize().locator('.org-pick').count()) === 4, '列出 4 件');
  const heads = await organize().locator('.group-head').allInnerTexts();
  check(heads.length >= 2, `按大类分组（${heads.map((h) => h.replace(/\s+/g, '')).join('、')}）`);
  if (noSub) check(await organize().locator('.chips').getByRole('button', { name: /没认出款式/ }).isVisible(), `有 ${noSub} 件没认出款式，可以单独筛出来`);
  await page.screenshot({ path: `${SHOTS}/organize-03-list.png` });

  console.log('成批改季节（不算核对）：');
  await tile(tee.name).click();
  check(/已选 1 件/.test(await bar().innerText()), '选中后下面出现成批修改');
  await bar().getByRole('button', { name: '季节' }).click();
  await sheet().getByRole('button', { name: '冬', exact: true }).click();
  await page.screenshot({ path: `${SHOTS}/organize-04-sheet.png` });
  await sheet().getByRole('button', { name: '改 1 件' }).click();
  await page.getByText(/改好了 1 件的季节/).waitFor();
  items = await storedItems(page);
  let t = items.find((i) => i.id === tee.id)!;
  check(t.seasons.includes('winter'), '加上了冬');
  check(t.unverified === true, '只改季节还算未核对');

  console.log('成批改款式（算核对过）：');
  await tile(parka.name).click();
  if (sweater.category === parka.category) await tile(sweater.name).click();
  await bar().getByRole('button', { name: '改款式' }).click();
  await sheet().getByRole('button', { name: '上衣', exact: true }).click();
  await sheet().getByRole('button', { name: '卫衣', exact: true }).click();
  await sheet().getByRole('button', { name: /^改 \d 件$/ }).click();
  await page.getByText(/改成了卫衣/).waitFor();
  items = await storedItems(page);
  const p2 = items.find((i) => i.id === parka.id)!;
  check(p2.category === 'top' && p2.subtype === '卫衣', '外套改成了卫衣');
  check(!p2.unverified && !p2.reviewNote, '改过款式就算核对过，提示也去掉');
  check((await tile(parka.name).count()) === 0, '核对过的不再出现在未核对里');

  console.log('剩下的一起标为没问题：');
  await organize().getByRole('button', { name: '全选' }).click();
  await bar().getByRole('button', { name: '没问题' }).click();
  await page.getByText(/件标为核对过了/).waitFor();
  check(await organize().getByText('都核对过了').isVisible(), '未核对的都处理完了');
  items = await storedItems(page);
  check(items.every((i) => !i.unverified), '数据里也都去掉了标记');

  console.log('在全部里成批改场合、腰线：');
  await organize().getByRole('button', { name: /看全部/ }).click();
  await organize().getByRole('button', { name: '全选' }).click();
  await bar().getByRole('button', { name: '场合' }).click();
  await sheet().getByRole('button', { name: '正式', exact: true }).click();
  await sheet().getByRole('button', { name: '改 4 件' }).click();
  await page.getByText(/的场合/).waitFor();
  items = await storedItems(page);
  check(items.every((i) => i.occasions.includes('formal')), '4 件都加上了正式');
  await tile(pants.name).click();
  await bar().getByRole('button', { name: '版型长度' }).click();
  check(await sheet().getByText('腰线', { exact: true }).isVisible(), '下装可以改腰线');
  await sheet().locator('.field', { hasText: '腰线' }).getByRole('button', { name: '高腰' }).click();
  await sheet().getByRole('button', { name: '确定修改' }).click();
  await page.getByText(/改好了 1 件/).waitFor();
  items = await storedItems(page);
  check(items.find((i) => i.id === pants.id)?.rise === 'high', '腰线改成高腰');

  console.log('细改一件，关掉后回到整理：');
  await organize().getByRole('button', { name: `细改${tee.name}` }).click();
  await page.locator('#item-name').waitFor();
  await page.getByRole('button', { name: '关闭' }).click();
  await organize().waitFor();
  check(true, '回到了整理页');

  console.log('成批删除：');
  // 改款式时自动名称跟着变了（酒红上衣 → 酒红卫衣），按最新的名称找
  const sw = (await storedItems(page)).find((i) => i.id === sweater.id)!;
  check(sw.name !== sweater.name || sw.subtype === sweater.subtype, `自动名称跟着款式变（${sweater.name} → ${sw.name}）`);
  await tile(sw.name).click();
  await bar().getByRole('button', { name: '删除' }).click();
  await page.locator('.sheet').getByRole('button', { name: '删除 1 件' }).click();
  await page.getByText('已删除 1 件').waitFor();
  items = await storedItems(page);
  check(items.length === 3 && !items.some((i) => i.id === sweater.id), '删掉了');
  await organize().getByRole('button', { name: '关闭' }).click();

  console.log('补充信息再存：版型、长度、腰线收起来，保存算核对过');
  await page.locator('.topbar').getByRole('button', { name: '录入单品' }).click();
  await page.getByTestId('photo-input').setInputFiles({ name: 'tee.jpg', mimeType: 'image/jpeg', buffer: photos.tee });
  await page.getByRole('button', { name: '补充信息' }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '补充信息' }).click();
  await page.locator('#item-name').waitFor();
  const shapeToggle = page.getByRole('button', { name: '版型、长度、腰线' });
  check((await shapeToggle.getAttribute('aria-expanded')) === 'false', '版型、长度、腰线默认收起');
  check((await page.locator('.field-label', { hasText: '版型' }).count()) === 0, '收起时不显示版型');
  await shapeToggle.click();
  check(await page.locator('.field-label', { hasText: '版型' }).isVisible(), '点开可以改');
  await page.locator('.topbar').getByRole('button', { name: '保存' }).click();
  await page.getByText(/已录入/).waitFor();
  items = await storedItems(page);
  check(items.length === 4 && !items[3].unverified, '看过信息再存的不算未核对');

  console.log('以前批量录入、还没确认的单品：打开后转成在用、未核对');
  await page.evaluate(
    (src) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('smart-wardrobe');
        req.onsuccess = () => {
          const tx = req.result.transaction('items', 'readwrite');
          tx.objectStore('items').put({ ...src, id: 'legacy-1', name: '旧的待整理', status: 'pending', reviewNote: '没认出类别，请选一下', createdAt: Date.now() });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    items[0],
  );
  await page.reload();
  await page.locator('.boot').waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForTimeout(500);
  items = await storedItems(page);
  const legacy = items.find((i) => i.id === 'legacy-1')!;
  check(legacy.status === 'active' && legacy.unverified === true, '转成在用、未核对');
  await tabbar.getByRole('button', { name: '衣橱' }).click();
  check(/1 件是录入时自动分的类/.test(await page.locator('.notice-line').innerText()), '衣橱里提示 1 件没核对');

  console.log('未核对的照常参与推荐：');
  await tabbar.getByRole('button', { name: '今日' }).click();
  await page.getByRole('button', { name: '就穿这套' }).first().waitFor({ timeout: 15000 });
  check(true, '今日页给出了搭配');

  console.log('深色模式：');
  await page.emulateMedia({ colorScheme: 'dark' });
  await tabbar.getByRole('button', { name: '衣橱' }).click();
  await page.locator('.topbar').getByRole('button', { name: '整理' }).click();
  await organize().waitFor();
  await organize().locator('.org-pick').first().click();
  await page.screenshot({ path: `${SHOTS}/organize-05-dark.png` });

  await ctx.close();
  check(errors.length === 0, `没有页面错误${errors.length ? '：\n' + errors.join('\n') : ''}`);
  console.log('\n全部通过');
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  if (errors.length) console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
