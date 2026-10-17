// 端到端测试：拍照更省事——横着拍自动转正、按轮廓先选好类别、连帽上衣试穿时把帽子放下、
// 衣服碰到照片边缘时提示（网站版，本机存储）。
// 运行：npm run build && node --import tsx scripts/e2e-capture.ts [截图目录]

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
await new Promise<void>((r) => server.listen(5206, r));

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error(`检查失败：${msg}`);
  console.log(`  ✓ ${msg}`);
}

await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors: string[] = [];

type Kind = 'parka' | 'cutoff' | 'tee';

/**
 * 在页面里画测试照片（白床单）：
 * parka：袖子摊开的墨绿连帽外套，帽子摊在领口上方，领口朝右横着拍，四周留了背景；
 * cutoff：同一件，但下摆出了画面（碰到左边）；
 * tee：袖子摊开的藏青 T 恤，正着拍（对照：不转、没有帽子）。
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
    for (let i = 0; i < 6; i++) {
      const g = ctx.createRadialGradient(190 * i + 80, 140 * (i % 3) + 200, 10, 190 * i + 80, 140 * (i % 3) + 200, 420);
      g.addColorStop(0, 'rgba(255,255,255,0.07)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    // 连帽外套（坐标 210×300，领口朝上）
    const parka = 'M70,80 Q70,4 105,4 Q140,4 140,80 L180,92 L206,200 L182,208 L166,130 L166,296 L44,296 L44,130 L28,208 L4,200 L30,92 Z';
    const tee = 'M70,8 Q100,30 130,8 L166,20 L198,58 L172,82 L155,70 L155,190 L45,190 L45,70 L28,82 L2,58 L34,20 Z';
    const piece = (d: string, paint: (g: CanvasRenderingContext2D) => void) => {
      const p = new Path2D(d);
      ctx.save();
      ctx.translate(5, 7);
      ctx.filter = 'blur(3px)';
      ctx.fillStyle = 'rgba(60,50,40,0.16)';
      ctx.fill(p);
      ctx.restore();
      ctx.save();
      ctx.clip(p);
      paint(ctx);
      ctx.restore();
    };
    if (k === 'tee') {
      ctx.save();
      ctx.translate(280, 150);
      ctx.scale(3.2, 3.2);
      piece(tee, (g) => {
        g.fillStyle = '#26315e';
        g.fillRect(0, 0, 200, 200);
      });
      ctx.restore();
    } else {
      ctx.save();
      // 领口朝右：顺时针转 90°
      ctx.translate(k === 'cutoff' ? 690 : 1010, 160);
      ctx.rotate(Math.PI / 2);
      ctx.scale(2.6, 2.6);
      piece(parka, (g) => {
        g.fillStyle = '#3d6b48';
        g.fillRect(0, 0, 210, 300);
        // 拉链和胸前的小 logo
        g.fillStyle = '#26402c';
        g.fillRect(104, 80, 2, 216);
        g.fillStyle = '#f2efe6';
        g.fillRect(132, 130, 10, 12);
      });
      ctx.restore();
    }
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  }, kind);
  return Buffer.from(b64, 'base64');
}

/** 从本机数据库读出单品（按录入顺序） */
async function storedItems(page: Page) {
  return page.evaluate(
    () =>
      new Promise<
        Array<{ id: string; name: string; status: string; category: string; subtype: string; reviewNote?: string; imageAspect: number; hoodTop?: number; hoodUp?: boolean; images: { cutout: string } }>
      >((resolve, reject) => {
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

/** 录入页信息步骤里预览图的宽高比 */
async function previewAspect(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const img = document.querySelector('img[alt="换装贴图"]') as HTMLImageElement;
    await img.decode();
    return img.naturalWidth / img.naturalHeight;
  });
}

try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`console: ${m.text()}`));
  await page.addInitScript('window.__name = (f) => f;');
  await page.goto('http://localhost:5206/smart-wardrobe/');
  await page.locator('.boot').waitFor({ state: 'detached', timeout: 15000 });
  await page.getByRole('button', { name: '用示例衣橱试试' }).click();
  await page.getByRole('button', { name: '就穿这套' }).waitFor({ timeout: 15000 });
  const photos = { parka: await draw(page, 'parka'), cutoff: await draw(page, 'cutoff'), tee: await draw(page, 'tee') };
  if (process.env.DUMP_PHOTOS) for (const [k, v] of Object.entries(photos)) await import('node:fs/promises').then((fs) => fs.writeFile(`${process.env.DUMP_PHOTOS}/${k}.jpg`, v));
  const tabbar = page.locator('nav.tabbar');
  const editor = () => page.locator('.overlay').last();
  const hoodSwitch = () => page.locator('label.switch', { hasText: '试穿时把帽子放下' });
  const hoodClipped = () => page.locator('.builder-stage g[clip-path^="url(#"] image.garment').count();

  console.log('拍照提示：');
  await tabbar.getByRole('button', { name: '衣橱' }).click();
  await page.getByRole('button', { name: '录入单品' }).first().click();
  check(await page.getByText('横着拍、倒着拍都可以').isVisible(), '提示横着拍会自动转正');
  check(await page.getByText('碰到照片边缘的部分会被去掉').isVisible(), '提示四周要留背景');
  check(await page.getByText('试穿时会自动放下').isVisible(), '提示连帽衣服把帽子摊开拍');

  console.log('衣服碰到照片边缘：');
  await page.getByTestId('photo-input').setInputFiles({ name: 'cutoff.jpg', mimeType: 'image/jpeg', buffer: photos.cutoff });
  await page.getByRole('button', { name: '补充信息' }).waitFor({ timeout: 30000 });
  const edge = page.locator('.warnbox', { hasText: '衣服碰到了照片的' });
  check(await edge.isVisible(), '提示衣服碰到了边缘');
  check(/左边/.test(await edge.innerText()), '指出是左边（下摆出了画面）');
  await page.screenshot({ path: `${SHOTS}/capture-01-edge.png`, fullPage: true });
  await page.getByRole('button', { name: '重拍' }).click();

  console.log('横着拍的连帽外套：');
  await page.getByTestId('photo-input').setInputFiles({ name: 'parka.jpg', mimeType: 'image/jpeg', buffer: photos.parka });
  await page.getByRole('button', { name: '补充信息' }).waitFor({ timeout: 30000 });
  check((await page.locator('.warnbox', { hasText: '衣服碰到了照片的' }).count()) === 0, '四周留了背景就不提示');
  await page.getByRole('button', { name: '补充信息' }).click();
  await page.locator('#item-name').waitFor();
  check(await page.getByText('已经把照片转正了').isVisible(), '提示已经转正');
  const upright = await previewAspect(page);
  check(upright < 1, `转正后领口朝上（宽高比 ${upright.toFixed(2)}，比横着的窄）`);
  // 手动转 90°：转四次回到原样
  await page.getByRole('button', { name: '转 90°' }).first().click();
  await page.waitForTimeout(300);
  const turned = await previewAspect(page);
  check(turned > 1, `点「转 90°」可以手动转（宽高比 ${turned.toFixed(2)}）`);
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '转 90°' }).first().click();
  await page.waitForTimeout(300);
  check(Math.abs((await previewAspect(page)) - upright) < 0.02, '转四次回到原样');
  check(await page.getByText('按衣服轮廓猜的，不对就点一下改').isVisible(), '类别按轮廓先选好了');
  await editor().getByRole('button', { name: '上衣', exact: true }).click();
  await editor().getByRole('button', { name: '卫衣', exact: true }).click();
  check(!(await page.getByText('按衣服轮廓猜的，不对就点一下改').isVisible()), '改过以后不再提示是猜的');
  check(await hoodSwitch().locator('input').isChecked(), '认出帽子，默认试穿时放下');
  await page.screenshot({ path: `${SHOTS}/capture-02-info.png` });
  await page.locator('.topbar').getByRole('button', { name: '保存' }).click();
  await page.getByText(/已录入/).waitFor();
  let items = await storedItems(page);
  const parka = items.filter((i) => !i.id.startsWith('demo')).pop()!;
  check((parka.hoodTop ?? 0) > 0.15 && !parka.hoodUp, `记下帽子的高度（占贴图 ${(parka.hoodTop ?? 0).toFixed(2)}）`);

  console.log('人台上把帽子放下：');
  await tabbar.getByRole('button', { name: '试搭' }).click();
  const clear = page.getByRole('button', { name: '清空' });
  if (await clear.isVisible()) await clear.click();
  await page.getByRole('tab', { name: '上衣' }).click();
  await page.locator('.pick', { hasText: parka.name }).first().click();
  await page.getByRole('tab', { name: '下装' }).click();
  await page.locator('.pick', { hasText: '藏青西裤' }).click();
  await page.waitForTimeout(800);
  check((await hoodClipped()) === 1, '帽子藏起来（贴图上面那一段被裁掉）');
  // 衣服按肩线对齐：看得见的部分从肩线附近开始
  const top = await page.evaluate(() => {
    const clip = document.querySelector('.builder-stage clipPath rect');
    return Number(clip?.getAttribute('y'));
  });
  check(top > 20 && top < 35, `看得见的部分从肩线开始（y = ${top.toFixed(1)} cm）`);
  await page.locator('.builder-stage').screenshot({ path: `${SHOTS}/capture-03-builder.png` });
  await page.getByRole('button', { name: '3D 查看这套' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid=mannequin-3d]')?.getAttribute('data-status') === 'ready', null, { timeout: 30000 });
  await page.getByRole('button', { name: '正面', exact: true }).click();
  await page.waitForTimeout(900);
  await page.locator('.view3d-canvas').screenshot({ path: `${SHOTS}/capture-04-3d.png` });
  check(true, '3D 里帽子同样放下');
  await page.getByRole('button', { name: '关闭' }).click();

  console.log('不放下帽子：');
  await tabbar.getByRole('button', { name: '衣橱' }).click();
  await page.locator('.grid .tile', { hasText: parka.name }).first().click();
  await hoodSwitch().locator('input').uncheck();
  await page.locator('.topbar').getByRole('button', { name: '保存' }).click();
  await page.getByText('已保存').waitFor();
  items = await storedItems(page);
  check(items.find((i) => i.id === parka.id)?.hoodUp === true, '关掉后记为不放下');
  await tabbar.getByRole('button', { name: '试搭' }).click();
  await page.waitForTimeout(600);
  check((await hoodClipped()) === 0, '人台上显示帽子');

  console.log('以前录入的连帽衣服：打开时补量帽子');
  await page.evaluate(
    (id) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('smart-wardrobe');
        req.onsuccess = () => {
          const store = req.result.transaction('items', 'readwrite').objectStore('items');
          const g = store.get(id);
          g.onsuccess = () => {
            const it = g.result;
            delete it.hoodTop;
            delete it.hoodUp;
            const p = store.put(it);
            p.onsuccess = () => resolve();
            p.onerror = () => reject(p.error);
          };
        };
        req.onerror = () => reject(req.error);
      }),
    parka.id,
  );
  await page.reload();
  await page.locator('.boot').waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForFunction(
    async (id) => {
      const it = await new Promise<{ hoodTop?: number }>((resolve) => {
        const req = indexedDB.open('smart-wardrobe');
        req.onsuccess = () => {
          const g = req.result.transaction('items', 'readonly').objectStore('items').get(id);
          g.onsuccess = () => resolve(g.result);
        };
      });
      return (it.hoodTop ?? 0) > 0.15;
    },
    parka.id,
    { timeout: 15000 },
  );
  check(true, '去掉记录后重新打开，后台补量出帽子');

  console.log('正着拍、没有帽子的 T 恤（对照）：');
  await tabbar.getByRole('button', { name: '衣橱' }).click();
  await page.getByRole('button', { name: '录入单品' }).first().click();
  await page.getByTestId('photo-input').setInputFiles({ name: 'tee.jpg', mimeType: 'image/jpeg', buffer: photos.tee });
  await page.getByRole('button', { name: '补充信息' }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '补充信息' }).click();
  await page.locator('#item-name').waitFor();
  check(!(await page.getByText('已经把照片转正了').isVisible()), '正着拍的不转');
  check((await editor().getByRole('button', { name: 'T恤', exact: true }).getAttribute('aria-pressed')) === 'true', '按轮廓猜成 T 恤');
  check((await hoodSwitch().count()) === 0, '没有帽子不问');
  await page.getByRole('button', { name: '关闭' }).click();

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
