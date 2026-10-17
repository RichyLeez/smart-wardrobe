// 端到端测试：识别模型（下载、缓存、在显卡上运行、和去背结合）、按轮廓先选好类别、人台上的大小。
// 运行：npm run build && node --import tsx scripts/e2e-matting.ts [截图目录]
//
// 无头浏览器用软件模拟显卡（SwiftShader），模型在 320×320 上跑一次要两三分钟，
// 所以界面流程里把模型输入调到 128×128（localStorage 的 wardrobe:matting-size）；
// 320 尺寸下显卡结果的正确性由第一步单独检查：64×64 的输入和 Python 参考实现对照。

import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright';

const SHOTS = process.argv[2] ?? 'e2e-shots';
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.bin': 'application/octet-stream',
};
// 显卡自检页面：把 core/u2net.ts 和 ui/u2netGpu.ts 打包成一个脚本
const selftest = await build({
  stdin: {
    contents: `
      import { parseModel } from './src/core/u2net';
      import { U2Gpu } from './src/ui/u2netGpu';
      window.selftest = async () => {
        const model = parseModel(await (await fetch('/smart-wardrobe/models/u2net.bin')).arrayBuffer());
        const fx = new Float32Array(await (await fetch('/fixture/u2net-64.bin')).arrayBuffer());
        const gpu = new U2Gpu(model);
        const y = gpu.run(fx.slice(0, 3 * 64 * 64), 64);
        const ref = fx.slice(3 * 64 * 64);
        let max = 0, agree = 0;
        for (let i = 0; i < ref.length; i++) {
          max = Math.max(max, Math.abs(y[i] - ref[i]));
          if ((y[i] > 0.5) === (ref[i] > 0.5)) agree++;
        }
        gpu.dispose();
        return { max, agree: agree / ref.length };
      };`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'iife',
  write: false,
  target: 'es2020',
});
const selftestJs = selftest.outputFiles[0].text;

let modelRequests = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/selftest.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><script>${selftestJs}</script>`);
    return;
  }
  if (url.pathname === '/fixture/u2net-64.bin') {
    res.writeHead(200).end(await readFile('tests/fixtures/u2net-64.bin'));
    return;
  }
  let p = decodeURIComponent(url.pathname).replace(/^\/smart-wardrobe/, '');
  if (p.endsWith('/')) p += 'index.html';
  if (p.includes('/models/u2net.bin')) modelRequests++;
  try {
    const body = await readFile(join('dist', p));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream', 'content-length': body.length }).end(body);
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
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors: string[] = [];

/** 白床单上的黑 T 恤：白色罗纹领口、白色下摆贴着轮廓（按颜色分不出来） */
async function drawTee(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(() => {
    const W = 900;
    const H = 900;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ecebe5';
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 5; i++) {
      const g = ctx.createRadialGradient(180 * i + 60, 160 * (i % 3) + 200, 10, 180 * i + 60, 160 * (i % 3) + 200, 420);
      g.addColorStop(0, 'rgba(255,255,255,0.07)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    const tee = new Path2D('M70,8 Q100,30 130,8 L166,20 L198,58 L172,82 L155,70 L155,190 L45,190 L45,70 L28,82 L2,58 L34,20 Z');
    ctx.save();
    ctx.translate(135, 150);
    ctx.scale(3.2, 3.2);
    ctx.save();
    ctx.translate(1.5, 2);
    ctx.filter = 'blur(1px)';
    ctx.fillStyle = 'rgba(60,50,40,0.14)';
    ctx.fill(tee);
    ctx.restore();
    ctx.clip(tee);
    ctx.fillStyle = '#212125';
    ctx.fillRect(0, 0, 200, 200);
    // 白色罗纹领口和白色下摆
    ctx.strokeStyle = '#f4f3ef';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(70, 8);
    ctx.quadraticCurveTo(100, 30, 130, 8);
    ctx.stroke();
    ctx.fillStyle = '#f4f3ef';
    ctx.fillRect(0, 176, 200, 20);
    ctx.restore();
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  });
  return Buffer.from(b64, 'base64');
}

async function previewAlpha(page: Page, fx: number, fy: number): Promise<number> {
  return page.evaluate(
    ([x, y]) => {
      const c = document.querySelector('.cutout-view canvas') as HTMLCanvasElement;
      return c.getContext('2d')!.getImageData(Math.round(c.width * x), Math.round(c.height * y), 1, 1).data[3];
    },
    [fx, fy],
  );
}

async function storedItems(page: Page) {
  return page.evaluate(
    () =>
      new Promise<Array<{ id: string; name: string; category: string; subtype: string; sizeAdjust?: number; shape?: { w: number } }>>((resolve, reject) => {
        const req = indexedDB.open('smart-wardrobe');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const all = req.result.transaction('items', 'readonly').objectStore('items').getAll();
          all.onsuccess = () => resolve(all.result as never);
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

  console.log('显卡上的模型和参考实现对照（64×64）：');
  await page.goto('http://localhost:5207/selftest.html');
  page.setDefaultTimeout(300000);
  const st = await page.evaluate(() => (window as unknown as { selftest: () => Promise<{ max: number; agree: number }> }).selftest());
  check(st.max < 0.05 && st.agree > 0.99, `最大差 ${st.max.toFixed(4)}，蒙版一致 ${(st.agree * 100).toFixed(2)}%`);
  page.setDefaultTimeout(30000);
  // 自检页面也读了一次模型文件，下面只数应用自己的下载
  modelRequests = 0;

  await page.goto('http://localhost:5207/smart-wardrobe/');
  await page.evaluate(() => localStorage.setItem('wardrobe:matting-size', '128'));
  await page.reload();
  await page.locator('.boot').waitFor({ state: 'detached', timeout: 15000 });
  const tabbar = page.locator('nav.tabbar');
  const photo = await drawTee(page);
  if (process.env.DUMP_PHOTOS) await import('node:fs/promises').then((fs) => fs.writeFile(`${process.env.DUMP_PHOTOS}/white-rib-tee.jpg`, photo));

  console.log('不用识别模型（对照）：');
  await tabbar.getByRole('button', { name: '衣橱' }).click();
  await page.getByRole('button', { name: '录入单品' }).first().click();
  check(await page.getByRole('button', { name: '下载识别模型' }).isVisible(), '录入页提示可以下载识别模型');
  check(!(await page.getByRole('button', { name: '批量录入' }).isVisible()) && !(await page.getByText('衣服多？').isVisible()), '没有批量录入入口');
  await page.getByTestId('photo-input').setInputFiles({ name: 'tee.jpg', mimeType: 'image/jpeg', buffer: photo });
  await page.getByRole('button', { name: '补充信息' }).waitFor({ timeout: 30000 });
  // 下摆中间（照片里 x 450，y 150 + 186×3.2）
  const hemX = 450 / 900;
  const hemY = (150 + 186 * 3.2) / 900;
  const hemBefore = await previewAlpha(page, hemX, hemY);
  check(hemBefore < 128, `按颜色去背时白下摆被去掉（${hemBefore}）`);
  await page.getByRole('button', { name: '重拍' }).click();

  console.log('下载识别模型：');
  await page.getByRole('button', { name: '下载识别模型' }).click();
  await page.getByText('识别模型已准备好').waitFor({ timeout: 180000 });
  check(modelRequests === 1, '模型下载了一次');
  await page.screenshot({ path: `${SHOTS}/matting-01-ready.png` });

  console.log('用识别模型去背：');
  await page.getByTestId('photo-input').setInputFiles({ name: 'tee.jpg', mimeType: 'image/jpeg', buffer: photo });
  await page.getByRole('button', { name: '补充信息' }).waitFor({ timeout: 180000 });
  check(await page.getByText('已用识别模型找出衣服').isVisible(), '提示用了识别模型');
  const hemAfter = await previewAlpha(page, hemX, hemY);
  check(hemAfter > 200, `白下摆保留下来（${hemAfter}）`);
  const sheet = await previewAlpha(page, 0.5, 0.95);
  check(sheet < 128, `下摆下面的床单仍然去掉（预览里去掉的部分是半透明的：${sheet}）`);
  await page.locator('.cutout-view').screenshot({ path: `${SHOTS}/matting-02-cutout.png` });
  await page.getByRole('button', { name: '补充信息' }).click();
  await page.locator('#item-name').waitFor();

  console.log('类别和人台上的大小：');
  const editor = page.locator('.overlay').last();
  check((await editor.getByRole('button', { name: 'T恤', exact: true }).getAttribute('aria-pressed')) === 'true', '按轮廓先选好了 T 恤');
  check(await page.getByText('按衣服轮廓猜的，不对就点一下改').isVisible(), '说明是猜的');
  const sizeCard = page.locator('.size-preview');
  await sizeCard.scrollIntoViewIfNeeded();
  check(await sizeCard.getByText('已按你的身材和版型自动定好').isVisible(), '人台预览说明大小已按身材定好');
  check((await sizeCard.locator('.size-preview-value').innerText()) === '100%', '默认 100%');
  await sizeCard.getByRole('button', { name: '大一点' }).click();
  await sizeCard.getByRole('button', { name: '大一点' }).click();
  check((await sizeCard.locator('.size-preview-value').innerText()) === '108%', '调大到 108%');
  await page.screenshot({ path: `${SHOTS}/matting-03-size.png` });
  await page.locator('.topbar').getByRole('button', { name: '保存' }).click();
  await page.getByText(/已录入/).waitFor();
  const [tee] = await storedItems(page);
  check(tee.subtype === 'T恤' && Math.abs((tee.sizeAdjust ?? 1) - 1.08) < 1e-6, '保存了类别和大小');
  check((tee.shape?.w ?? 0) > 0.3, `量了衣身宽度（占贴图 ${tee.shape?.w}）`);
  check(!(await page.getByText('吊牌').first().isVisible().catch(() => false)), '没有吊牌识别');

  console.log('重新打开：模型从本机读取');
  await page.reload();
  await page.locator('.boot').waitFor({ state: 'detached', timeout: 15000 });
  await tabbar.getByRole('button', { name: '衣橱' }).click();
  await page.getByRole('button', { name: '录入单品' }).first().click();
  await page.getByText('识别模型已准备好').waitFor({ timeout: 180000 });
  check(modelRequests === 1, '没有再下载');
  await page.getByRole('button', { name: '关闭' }).click();

  console.log('设置：');
  await page.locator('[aria-label="设置"]').first().click().catch(async () => {
    await tabbar.getByRole('button', { name: '今日' }).click();
    await page.locator('[aria-label="设置"]').first().click();
  });
  const sec = page.locator('section', { hasText: '衣服识别模型' });
  await sec.scrollIntoViewIfNeeded();
  await sec.getByText(/已下载/).waitFor();
  check(true, '设置里显示已下载');
  await sec.getByRole('button', { name: '删除' }).click();
  await sec.getByText('未下载').waitFor();
  check(true, '可以删除');
  await page.screenshot({ path: `${SHOTS}/matting-04-settings.png`, fullPage: true });

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
