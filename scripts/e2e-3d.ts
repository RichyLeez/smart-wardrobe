// 端到端测试：智能去背、正反两面照片、人台背面、3D 人台（网站版，本机存储）。
// 测试照片在浏览器里现场绘制：白 T 恤平铺在木地板上，地板有缝隙，角落压着一块蓝色地毯。
// 运行：npm run build && node --import tsx scripts/e2e-3d.ts [截图目录]

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
await new Promise<void>((r) => server.listen(5202, r));

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error(`检查失败：${msg}`);
  console.log(`  ✓ ${msg}`);
}

await mkdir(SHOTS, { recursive: true });
// 无头浏览器用软件渲染提供 WebGL
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors: string[] = [];

async function open(scheme: 'light' | 'dark'): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`console: ${m.text()}`));
  await page.goto('http://localhost:5202/smart-wardrobe/');
  await page.locator('.boot').waitFor({ state: 'detached', timeout: 15000 });
  return page;
}

/** 在页面里画一张平铺照片，返回 JPEG */
async function drawPhoto(page: Page, back: boolean): Promise<Buffer> {
  const b64 = await page.evaluate((isBack) => {
    const W = 900;
    const H = 700;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;
    // 木地板：两种木色交替，深色缝隙，加一点纹理
    for (let y = 0; y < H; y += 70) {
      ctx.fillStyle = (y / 70) % 2 === 0 ? '#b68e64' : '#9e7853';
      ctx.fillRect(0, y, W, 70);
      ctx.fillStyle = '#5c4632';
      ctx.fillRect(0, y, W, 4);
    }
    for (let i = 0; i < 400; i++) {
      ctx.fillStyle = `rgba(80,55,30,${0.05 + (i % 7) * 0.01})`;
      ctx.fillRect((i * 97) % W, (i * 53) % H, 40, 2);
    }
    // 右下角的蓝色地毯
    ctx.fillStyle = '#3d5a91';
    ctx.fillRect(700, 540, 200, 160);
    // T 恤（与示例衣橱的 tee 同一个轮廓，放大 2.6 倍）
    ctx.save();
    ctx.translate(190, 90);
    ctx.scale(2.6, 2.6);
    const neck = isBack ? 'Q100,16' : 'Q100,30';
    const p = new Path2D(`M70,8 ${neck} 130,8 L166,20 L198,58 L172,82 L155,70 L155,190 L45,190 L45,70 L28,82 L2,58 L34,20 Z`);
    ctx.fillStyle = '#f2f1ec';
    ctx.fill(p);
    // 平铺拍摄常见的褶皱阴影
    ctx.save();
    ctx.clip(p);
    for (let k = 0; k < 9; k++) {
      ctx.strokeStyle = `rgba(90,85,75,${0.1 + (k % 3) * 0.05})`;
      ctx.lineWidth = 3 + (k % 4) * 2;
      ctx.beginPath();
      ctx.moveTo(30 + k * 18, 30);
      ctx.quadraticCurveTo(60 + k * 14, 110, 20 + k * 20, 200);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = '#d8d6ce';
    ctx.lineWidth = 1.2;
    ctx.stroke(p);
    if (!isBack) {
      ctx.fillStyle = '#a3322f';
      ctx.beginPath();
      ctx.arc(100, 100, 22, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = '#20294a';
      ctx.fillRect(80, 40, 40, 14);
    }
    ctx.restore();
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  }, back);
  return Buffer.from(b64, 'base64');
}

/** 去背预览画布上某个相对位置的不透明度（去掉的部分淡淡显示，约 41） */
async function previewAlpha(page: Page, fx: number, fy: number): Promise<number> {
  return page.evaluate(
    ([x, y]) => {
      const c = document.querySelector('.cutout-view canvas') as HTMLCanvasElement;
      const ctx = c.getContext('2d')!;
      return ctx.getImageData(Math.round(c.width * x), Math.round(c.height * y), 1, 1).data[3];
    },
    [fx, fy],
  );
}

async function imageCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const req = indexedDB.open('smart-wardrobe');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction('images', 'readonly');
          const c = tx.objectStore('images').count();
          c.onsuccess = () => resolve(c.result);
          c.onerror = () => reject(c.error);
        };
      }),
  );
}

async function waitReady(page: Page) {
  await page.waitForFunction(() => document.querySelector('[data-testid=mannequin-3d]')?.getAttribute('data-status') === 'ready', null, {
    timeout: 30000,
  });
}

try {
  console.log('智能去背与正反两面：');
  const page = await open('light');
  await page.getByRole('button', { name: '用示例衣橱试试' }).click();
  await page.getByRole('button', { name: '就穿这套' }).waitFor({ timeout: 15000 });
  const front = await drawPhoto(page, false);
  const backPhoto = await drawPhoto(page, true);

  await page.locator('nav.tabbar').getByRole('button', { name: '衣橱' }).click();
  await page.getByRole('button', { name: '录入单品' }).first().click();
  await page.getByTestId('photo-input').setInputFiles({ name: 'tee.jpg', mimeType: 'image/jpeg', buffer: front });
  await page.getByRole('button', { name: '补充信息' }).waitFor({ timeout: 20000 });
  check((await page.getByRole('button', { name: '智能', exact: true }).getAttribute('aria-pressed')) === 'true', '默认使用智能去背');
  const smart = {
    tee: await previewAlpha(page, 0.5, 0.45),
    print: await previewAlpha(page, 0.5, 0.5),
    rug: await previewAlpha(page, 0.92, 0.92),
    floor: await previewAlpha(page, 0.08, 0.5),
  };
  check(smart.tee === 255 && smart.print === 255, '衣物和胸前印花保留');
  check(smart.rug < 80 && smart.floor < 80, `地板和贴边的地毯都去掉（${smart.floor}、${smart.rug}）`);
  await page.locator('.cutout-view').screenshot({ path: `${SHOTS}/3d-01-smart-cutout.png` });
  await page.getByRole('button', { name: '按颜色', exact: true }).click();
  await page.waitForTimeout(300);
  const byColorRug = await previewAlpha(page, 0.92, 0.92);
  check(byColorRug === 255, '按颜色去背时地毯残留，对比出智能去背的作用');
  await page.locator('.cutout-view').screenshot({ path: `${SHOTS}/3d-02-color-cutout.png` });
  await page.getByRole('button', { name: '智能', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.cutout-view .busy'));
  check((await previewAlpha(page, 0.92, 0.92)) < 80, '切回智能后地毯再次去掉');

  // 擦除笔刷：在 T 恤下摆旁边划一笔不会影响衣物主体
  await page.getByRole('button', { name: '擦除', exact: true }).click();
  const cv = await page.locator('.cutout-view canvas').boundingBox();
  if (!cv) throw new Error('找不到预览画布');
  await page.mouse.move(cv.x + cv.width * 0.12, cv.y + cv.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(cv.x + cv.width * 0.18, cv.y + cv.height * 0.3, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(() => !document.querySelector('.cutout-view .busy'));
  check((await previewAlpha(page, 0.5, 0.45)) === 255, '涂抹后重新贴合边缘，衣物仍完整');

  await page.getByRole('button', { name: '补充信息' }).click();
  await page.getByText('品牌和尺码').first().waitFor();
  check(await page.getByRole('button', { name: '拍背面' }).isVisible(), '信息页可以加背面照片');

  // 背面
  await page.getByRole('button', { name: '拍背面' }).click();
  await page.getByText('把衣服翻过来，拍背面').waitFor();
  await page.screenshot({ path: `${SHOTS}/3d-03-back-photo-step.png` });
  await page.getByTestId('photo-input').setInputFiles({ name: 'tee-back.jpg', mimeType: 'image/jpeg', buffer: backPhoto });
  await page.getByRole('button', { name: '用作背面' }).waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: '用作背面' }).click();
  await page.getByText('新拍的背面，保存后生效。').waitFor();
  check(await page.getByRole('button', { name: '换一张背面' }).isVisible(), '背面照片已加上');
  await page.locator('.field', { hasText: '类别' }).getByRole('button', { name: '上衣' }).click();
  await page.getByRole('button', { name: 'T恤', exact: true }).click();
  await page.locator('.back-card').screenshot({ path: `${SHOTS}/3d-04-back-card.png` });
  const before = await imageCount(page);
  await page.locator('.topbar').getByRole('button', { name: '保存' }).click();
  await page.getByText(/^已录入/).waitFor({ timeout: 15000 });
  check((await imageCount(page)) === before + 6, '正面、背面各存了贴图、缩略图和原图');

  // 重新打开：背面还在
  await page.locator('.grid .tile').first().click();
  await page.getByRole('button', { name: '换一张背面' }).waitFor();
  check(await page.getByText('人台转到背面和 3D 展示时使用。').isVisible(), '重新打开单品时背面照片还在');
  const itemName = await page.locator('#item-name').inputValue();
  await page.getByRole('button', { name: '关闭' }).click();

  console.log('试搭的背面与 3D：');
  await page.locator('nav.tabbar').getByRole('button', { name: '试搭' }).click();
  await page.locator('.pick', { hasText: itemName }).click();
  await page.getByRole('tab', { name: '下装' }).click();
  await page.locator('.pick').first().click();
  const frontHref = await page.locator('.builder-stage image.garment').last().getAttribute('href');
  await page.locator('.stage-tools').getByRole('button', { name: '背面' }).click();
  check(((await page.locator('.builder-stage svg').getAttribute('aria-label')) ?? '').startsWith('人台背面'), '人台转到背面');
  const backHrefs = await page.locator('.builder-stage image.garment').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
  check(!backHrefs.includes(frontHref), '背面视图换成了背面照片');
  await page.locator('.builder-stage').screenshot({ path: `${SHOTS}/3d-05-builder-back.png` });
  await page.locator('.stage-tools').getByRole('button', { name: '正面' }).click();

  await page.getByRole('button', { name: '3D 查看这套' }).click();
  await waitReady(page);
  const pixels = await page.evaluate(() => {
    const c = document.querySelector('[data-testid=mannequin-3d]') as HTMLCanvasElement;
    return c.width * c.height;
  });
  check(pixels > 100000, '3D 人台已渲染');
  await page.getByRole('button', { name: '正面', exact: true }).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOTS}/3d-06-viewer-front.png` });
  await page.getByRole('button', { name: '侧面', exact: true }).click();
  await page.waitForTimeout(900);
  await page.locator('.view3d-canvas').screenshot({ path: `${SHOTS}/3d-07-viewer-side.png` });
  await page.getByRole('button', { name: '背面', exact: true }).click();
  await page.waitForTimeout(900);
  await page.locator('.view3d-canvas').screenshot({ path: `${SHOTS}/3d-08-viewer-back.png` });
  // 拖动转动
  const box = (await page.getByTestId('mannequin-3d').boundingBox())!;
  await page.mouse.move(box.x + 150, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 210, box.y + 200, { steps: 4 });
  await page.mouse.up();
  check((await page.getByRole('button', { name: '背面', exact: true }).getAttribute('aria-pressed')) === 'false', '拖动后不再停在固定视角');
  await page.getByRole('button', { name: '关闭' }).click();

  console.log('今日和记录：');
  await page.locator('nav.tabbar').getByRole('button', { name: '今日' }).click();
  await page.getByRole('button', { name: '3D 查看方案 1' }).click();
  await waitReady(page);
  check(await page.getByText('拖动转动，双指缩放').isVisible(), '推荐方案可以 3D 查看');
  await page.locator('.view3d-canvas').screenshot({ path: `${SHOTS}/3d-09-today.png` });
  await page.getByRole('button', { name: '关闭' }).click();
  await page.locator('nav.tabbar').getByRole('button', { name: '记录' }).click();
  // 示例记录在最近几天，月初时可能在上个月
  if ((await page.locator('.calendar button[aria-label*="条记录"]').count()) === 0) await page.getByRole('button', { name: '上个月' }).click();
  await page.locator('.calendar button[aria-label*="条记录"]').first().click();
  check((await page.getByRole('button', { name: '3D 查看这天的穿搭' }).count()) > 0, '穿搭记录也可以 3D 查看');

  console.log('删除单品：');
  await page.locator('nav.tabbar').getByRole('button', { name: '衣橱' }).click();
  const beforeDelete = await imageCount(page);
  await page.locator('.grid .tile').first().click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.locator('.sheet').getByRole('button', { name: '删除', exact: true }).click();
  await page.getByText('已删除').waitFor();
  check((await imageCount(page)) === beforeDelete - 6, '正反两面的 6 张图片一起删除');
  await page.context().close();

  console.log('深色模式：');
  const dark = await open('dark');
  await dark.getByRole('button', { name: '用示例衣橱试试' }).click();
  await dark.getByRole('button', { name: '3D 查看方案 1' }).click();
  await waitReady(dark);
  await dark.waitForTimeout(600);
  await dark.screenshot({ path: `${SHOTS}/3d-10-dark.png` });
  await dark.context().close();

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
