// 端到端测试：穿法（上衣塞进下装、外套敞开）与衣架识别（网站版，本机存储）。
// 运行：npm run build && node --import tsx scripts/e2e-styling.ts [截图目录]

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
await new Promise<void>((r) => server.listen(5204, r));

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error(`检查失败：${msg}`);
  console.log(`  ✓ ${msg}`);
}

await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors: string[] = [];

/** 挂在衣架上的藏青衬衫：米白墙面，木横杆两端伸出肩外，金属挂钩冒出领口 */
async function drawHangerPhoto(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(() => {
    const W = 900;
    const H = 900;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#ece8df');
    g.addColorStop(1, '#ddd8cc');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // 横杆（衣服里面的部分被衣服挡住）
    ctx.fillStyle = '#9c6b3a';
    ctx.fillRect(150, 252, 600, 18);
    // 挂钩
    ctx.strokeStyle = '#85858c';
    ctx.lineWidth = 12;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(450, 256);
    ctx.lineTo(450, 175);
    ctx.arc(475, 175, 25, Math.PI, Math.PI * 1.9);
    ctx.stroke();
    // 衬衫：衣身 + 垂下的袖子
    ctx.fillStyle = '#24305a';
    ctx.beginPath();
    ctx.moveTo(400, 250);
    ctx.lineTo(500, 250);
    ctx.lineTo(610, 262);
    ctx.lineTo(652, 560);
    ctx.lineTo(612, 566);
    ctx.lineTo(600, 420);
    ctx.lineTo(600, 800);
    ctx.lineTo(300, 800);
    ctx.lineTo(300, 420);
    ctx.lineTo(288, 566);
    ctx.lineTo(248, 560);
    ctx.lineTo(290, 262);
    ctx.closePath();
    ctx.fill();
    // 门襟和纽扣
    ctx.fillStyle = '#e7e3d8';
    for (let y = 300; y < 780; y += 60) {
      ctx.beginPath();
      ctx.arc(450, y, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  });
  return Buffer.from(b64, 'base64');
}

/** 去背预览画布上某个相对位置的不透明度（去掉的部分淡淡显示） */
async function previewAlpha(page: Page, fx: number, fy: number): Promise<number> {
  return page.evaluate(
    ([x, y]) => {
      const c = document.querySelector('.cutout-view canvas') as HTMLCanvasElement;
      return c.getContext('2d')!.getImageData(Math.round(c.width * x), Math.round(c.height * y), 1, 1).data[3];
    },
    [fx, fy],
  );
}

/** 人台上敞开的外套贴图：下摆中间是否已经拉开（透明） */
async function openGap(page: Page, scope: string): Promise<boolean> {
  return (await gapAlpha(page, scope)) === 0;
}

async function gapAlpha(page: Page, scope: string): Promise<number> {
  return page.evaluate(async (sel) => {
    const el = document.querySelector(`${sel} image.garment[data-styling="open"]`);
    const href = el?.getAttribute('href');
    if (!href) return -1;
    const img = new Image();
    img.src = href;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    // 下摆往上一点、正中间
    return ctx.getImageData(Math.round(c.width / 2), Math.round(c.height * 0.9), 1, 1).data[3];
  }, scope);
}

async function waitReady(page: Page) {
  await page.waitForFunction(() => document.querySelector('[data-testid=mannequin-3d]')?.getAttribute('data-status') === 'ready', null, {
    timeout: 30000,
  });
}

try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`console: ${m.text()}`));
  await page.goto('http://localhost:5204/smart-wardrobe/');
  await page.locator('.boot').waitFor({ state: 'detached', timeout: 15000 });
  await page.getByRole('button', { name: '用示例衣橱试试' }).click();
  await page.getByRole('button', { name: '就穿这套' }).waitFor({ timeout: 15000 });

  console.log('试搭里的穿法：');
  const tabbar = page.locator('nav.tabbar');
  await tabbar.getByRole('button', { name: '试搭' }).click();
  await page.getByRole('tab', { name: '上衣' }).click();
  await page.locator('.pick', { hasText: '白衬衫' }).click();
  await page.getByRole('tab', { name: '下装' }).click();
  await page.locator('.pick', { hasText: '藏青西裤' }).click();
  await page.getByRole('tab', { name: '外套' }).click();
  await page.locator('.pick', { hasText: '卡其风衣' }).click();
  const tuck = page.getByRole('button', { name: '塞进裤腰' });
  const openBtn = page.getByRole('button', { name: '外套敞开', exact: true });
  check((await tuck.isVisible()) && (await openBtn.isVisible()), '有上衣、下装和外套时出现两个穿法开关');
  const stage = '.builder-stage';
  await tuck.click();
  check((await tuck.getAttribute('aria-pressed')) === 'true', '点一下就塞进去');
  check((await page.locator(`${stage} image.garment[data-styling="tucked"]`).count()) === 1, '人台上衬衫在裤腰处截断');
  const order = await page.locator(`${stage} image.garment`).evaluateAll((els) => els.map((e) => e.getAttribute('data-styling') ?? ''));
  check(order.indexOf('tucked') === 0, '塞进去的衬衫画在裤子下面');
  await openBtn.click();
  await page.waitForFunction(
    async () => {
      const el = document.querySelector('.builder-stage image.garment[data-styling="open"]');
      return !!el;
    },
    null,
    { timeout: 5000 },
  );
  await page.waitForTimeout(800);
  check(await openGap(page, stage), '风衣正面照片被拉开，中间露出衬衫');
  await page.locator(stage).screenshot({ path: `${SHOTS}/styling-01-builder.png` });
  await page.locator('.styling-row').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/styling-01b-builder-chips.png` });
  const notes = await page.locator('.notes').first().innerText();
  check(/敞开/.test(notes), `理由里提到敞开穿：${notes.split('\n').find((l) => /敞开/.test(l))}`);

  // 存为套装，清空后重新打开，穿法还在
  await page.getByRole('button', { name: '存为套装' }).click();
  await page.locator('.sheet').getByRole('button', { name: '保存' }).click();
  await page.getByText('已保存为套装').waitFor();
  await page.getByRole('button', { name: '清空' }).click();
  check((await tuck.count()) === 0, '清空后没有穿法开关');
  await page.locator('.outfit-card', { hasText: '白衬衫 + 藏青西裤 + 卡其风衣' }).click();
  await tuck.waitFor();
  check((await tuck.getAttribute('aria-pressed')) === 'true' && (await openBtn.getAttribute('aria-pressed')) === 'true', '套装保存了穿法');

  // 3D
  await page.getByRole('button', { name: '3D 查看这套' }).click();
  await waitReady(page);
  await page.getByRole('button', { name: '正面', exact: true }).click();
  await page.waitForTimeout(900);
  await page.locator('.view3d-canvas').screenshot({ path: `${SHOTS}/styling-02-3d-front.png` });
  await page.getByRole('button', { name: '侧面', exact: true }).click();
  await page.waitForTimeout(900);
  await page.locator('.view3d-canvas').screenshot({ path: `${SHOTS}/styling-03-3d-side.png` });
  check(await page.getByText('拖动转动，双指缩放').isVisible(), '3D 里也按穿法显示');
  await page.getByRole('button', { name: '关闭' }).click();

  // 记为今天：记录里保存穿法
  await page.getByRole('button', { name: '记为今天' }).click();
  await page.getByText('已记为今天的穿搭').first().waitFor();
  await tabbar.getByRole('button', { name: '今日' }).click();
  const worn = page.locator('section[aria-label="今天的穿搭"]');
  await worn.waitFor();
  check((await worn.locator('image.garment[data-styling="tucked"]').count()) === 1, '今天的记录按塞进去的样子显示');
  check((await worn.locator('image.garment[data-styling="open"]').count()) === 1, '外套也是敞开的');

  console.log('今日推荐的穿法：');
  await page.getByRole('button', { name: '看看其他搭配' }).click();
  await page.locator('.carousel').waitFor();
  const row = page.locator('.styling-row');
  if ((await row.count()) === 0) {
    // 第一套没有上下装（比如连衣裙），换到下一套
    await page.locator('.dots button').nth(1).click();
    await page.waitForTimeout(500);
  }
  check((await row.count()) === 1, '推荐的那套下面有穿法开关');
  const firstChip = row.locator('button.chip').first();
  const before = await firstChip.getAttribute('aria-pressed');
  await firstChip.click();
  check((await firstChip.getAttribute('aria-pressed')) !== before, '可以改推荐的穿法，评分和理由随之更新');
  await page.locator('.carousel').screenshot({ path: `${SHOTS}/styling-04-today.png` });

  console.log('衣架识别：');
  const photo = await drawHangerPhoto(page);
  await tabbar.getByRole('button', { name: '衣橱' }).click();
  await page.getByRole('button', { name: '录入单品' }).first().click();
  check(await page.getByText('挂在衣架上拍也可以').isVisible(), '拍照提示说明可以挂着拍');
  await page.getByTestId('photo-input').setInputFiles({ name: 'hanging.jpg', mimeType: 'image/jpeg', buffer: photo });
  await page.getByRole('button', { name: '下一步' }).waitFor({ timeout: 20000 });
  const sw = page.locator('label.switch', { hasText: '去掉衣架' }).locator('input');
  check(await sw.isChecked(), '认出衣架并默认去掉');
  const hook = await previewAlpha(page, 450 / 900, 200 / 900);
  const barL = await previewAlpha(page, 190 / 900, 261 / 900);
  const barR = await previewAlpha(page, 715 / 900, 261 / 900);
  const shirt = await previewAlpha(page, 0.5, 0.6);
  const sleeve = await previewAlpha(page, 270 / 900, 500 / 900);
  check(hook < 80 && barL < 80 && barR < 80, `挂钩和横杆两端去掉（${hook}、${barL}、${barR}）`);
  const sliver = await previewAlpha(page, 335 / 900, 254 / 900);
  check(sliver < 80, `斜肩上方露出的一窄条横杆也去掉（${sliver}）`);
  check(shirt === 255 && sleeve === 255, '衬衫和袖子保留');
  await page.locator('.cutout-view').screenshot({ path: `${SHOTS}/styling-05-hanger.png` });
  await sw.uncheck();
  check((await previewAlpha(page, 450 / 900, 200 / 900)) === 255, '关掉开关就保留这部分');
  await sw.check();
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByText('吊牌信息').first().waitFor();
  const ratio = await page.evaluate(async () => {
    const img = document.querySelector('.thumb.fill img') as HTMLImageElement;
    await img.decode();
    return img.naturalWidth / img.naturalHeight;
  });
  // 衬衫本身 404×550，带横杆会宽到 600、带挂钩会高到约 660
  check(Math.abs(ratio - 404 / 550) < 0.05, `贴图按衬衫本身裁切（宽高比 ${ratio.toFixed(2)}）`);
  await page.locator('.field', { hasText: '类别' }).getByRole('button', { name: '上衣' }).click();
  await page.getByRole('button', { name: '衬衫', exact: true }).click();
  await page.locator('.topbar').getByRole('button', { name: '保存' }).click();
  await page.getByText(/^已录入/).waitFor({ timeout: 15000 });

  console.log('照片里是敞开的外套：');
  await page.locator('.grid .tile', { hasText: '黑色羽绒服' }).click();
  const openable = page.locator('label.switch', { hasText: '可以敞开穿' }).locator('input');
  check(await openable.isChecked(), '羽绒服默认可以敞开穿');
  const photoOpenSwitch = page.locator('label.switch', { hasText: '照片里是敞开的' });
  await page.locator('.field', { has: photoOpenSwitch }).screenshot({ path: `${SHOTS}/styling-06-outer-fields.png` });
  await photoOpenSwitch.locator('input').check();
  check((await openable.count()) === 0, '照片敞开时不再问能不能敞开');
  await page.locator('.topbar').getByRole('button', { name: '保存' }).click();
  await page.getByText('已保存').first().waitFor();
  await tabbar.getByRole('button', { name: '试搭' }).click();
  await page.getByRole('tab', { name: '外套' }).click();
  await page.locator('.pick', { hasText: '黑色羽绒服' }).click();
  const fixed = page.getByRole('button', { name: '外套敞开（照片）' });
  check((await fixed.isDisabled()) && (await fixed.getAttribute('aria-pressed')) === 'true', '照片敞开的外套显示为已敞开、不能合上');
  await page.waitForTimeout(600);
  const fixedAlpha = await gapAlpha(page, stage);
  check(
    (await page.locator(`${stage} image.garment[data-styling="open"]`).count()) === 1 && fixedAlpha > 0,
    `照片本身就是敞开的，不再拉开一次（${fixedAlpha}）`,
  );

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
