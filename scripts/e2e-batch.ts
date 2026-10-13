// 端到端测试：批量录入（相册多选、一张拍多件）、待整理、白底上带白色部分的衣服（网站版，本机存储）。
// 运行：npm run build && node --import tsx scripts/e2e-batch.ts [截图目录]

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
await new Promise<void>((r) => server.listen(5205, r));

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error(`检查失败：${msg}`);
  console.log(`  ✓ ${msg}`);
}

await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors: string[] = [];

type Kind = 'blackTee' | 'stripes' | 'jeans' | 'multi';

/** 在页面里画测试照片，返回 JPEG */
async function draw(page: Page, kind: Kind): Promise<Buffer> {
  const b64 = await page.evaluate((k) => {
    const multi = k === 'multi';
    const W = multi ? 1200 : 900;
    const H = 900;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;
    // 背景：白床单（缓慢起伏的明暗）或浅灰地面
    const sheet = k === 'jeans' ? '#d6d4ce' : k === 'multi' ? '#e2dccf' : '#ecebe5';
    ctx.fillStyle = sheet;
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 6; i++) {
      const g = ctx.createRadialGradient(150 * i + 80, 140 * (i % 3) + 200, 10, 150 * i + 80, 140 * (i % 3) + 200, 420);
      g.addColorStop(0, 'rgba(255,255,255,0.07)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    const tee = 'M70,8 Q100,30 130,8 L166,20 L198,58 L172,82 L155,70 L155,190 L45,190 L45,70 L28,82 L2,58 L34,20 Z';
    const pants = 'M18,4 L142,4 L142,22 L152,304 L94,304 L80,98 L66,304 L8,304 L18,22 Z';
    const shorts = 'M22,4 L148,4 L148,22 L166,134 L94,134 L85,74 L76,134 L4,134 L22,22 Z';
    /** 画一件：先画软阴影，再在形状里画内容 */
    const piece = (d: string, x: number, y: number, s: number, paint: (ctx: CanvasRenderingContext2D) => void) => {
      const p = new Path2D(d);
      ctx.save();
      ctx.translate(x + 5, y + 7);
      ctx.scale(s, s);
      ctx.filter = 'blur(3px)';
      ctx.fillStyle = 'rgba(60,50,40,0.16)';
      ctx.fill(p);
      ctx.restore();
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(s, s);
      ctx.clip(p);
      paint(ctx);
      ctx.restore();
    };
    if (k === 'blackTee') {
      piece(tee, 130, 140, 3.2, (g) => {
        g.fillStyle = '#212125';
        g.fillRect(0, 0, 200, 200);
        // 胸前白色字母印花、白色下摆罗纹
        g.fillStyle = '#f6f6f3';
        g.fillRect(70, 70, 60, 32);
        g.fillStyle = '#212125';
        for (let i = 0; i < 4; i++) g.fillRect(76 + i * 14, 78, 6, 16);
        g.fillStyle = '#f6f6f3';
        g.fillRect(0, 180, 200, 12);
      });
    } else if (k === 'stripes') {
      piece(tee, 130, 140, 3.2, (g) => {
        for (let y = 0; y < 200; y += 14) {
          g.fillStyle = (y / 14) % 2 === 0 ? '#1f2c5a' : '#f6f6f3';
          g.fillRect(0, y, 200, 14);
        }
      });
    } else if (k === 'jeans') {
      piece(pants, 245, 40, 2.6, (g) => {
        g.fillStyle = '#56789f';
        g.fillRect(0, 0, 160, 310);
        g.strokeStyle = 'rgba(40,60,90,0.5)';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(18, 22);
        g.lineTo(142, 22);
        g.stroke();
      });
    } else {
      piece(tee, 60, 160, 2.1, (g) => {
        g.fillStyle = '#2a3566';
        g.fillRect(0, 0, 200, 200);
      });
      piece(shorts, 640, 220, 2.6, (g) => {
        g.fillStyle = '#a9875c';
        g.fillRect(0, 0, 170, 140);
      });
      // 一只袜子
      piece('M10,10 L50,10 L50,120 Q50,150 80,150 L110,150 L110,180 L40,180 Q10,180 10,150 Z', 520, 620, 1.3, (g) => {
        g.fillStyle = '#b2343d';
        g.fillRect(0, 0, 120, 190);
      });
    }
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  }, kind);
  return Buffer.from(b64, 'base64');
}

/** 从本机数据库读出单品（按录入顺序） */
async function storedItems(page: Page) {
  return page.evaluate(
    () =>
      new Promise<Array<{ id: string; name: string; status: string; category: string; subtype: string; reviewNote?: string; images: { cutout: string } }>>(
        (resolve, reject) => {
          const req = indexedDB.open('smart-wardrobe');
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const all = req.result.transaction('items', 'readonly').objectStore('items').getAll();
            all.onsuccess = () => resolve((all.result as Array<{ createdAt: number }>).sort((a, b) => a.createdAt - b.createdAt) as never);
            all.onerror = () => reject(all.error);
          };
        },
      ),
  );
}

/** 读出某张贴图在相对位置的不透明度；line 为竖线（x, y0, y1）时返回线上最小的不透明度 */
async function cutoutAlpha(page: Page, imageId: string, pts: Array<[number, number]>, line?: [number, number, number]): Promise<number[]> {
  return page.evaluate(
    ([id, points, ln]) =>
      new Promise<number[]>((resolve, reject) => {
        const req = indexedDB.open('smart-wardrobe');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const g = req.result.transaction('images', 'readonly').objectStore('images').get(id);
          g.onsuccess = async () => {
            const bmp = await createImageBitmap(g.result.blob as Blob);
            const c = document.createElement('canvas');
            c.width = bmp.width;
            c.height = bmp.height;
            const ctx = c.getContext('2d', { willReadFrequently: true })!;
            ctx.drawImage(bmp, 0, 0);
            const d = ctx.getImageData(0, 0, c.width, c.height).data;
            const at = (x: number, y: number) => d[(Math.round(y * (c.height - 1)) * c.width + Math.round(x * (c.width - 1))) * 4 + 3];
            const out = points.map(([x, y]) => at(x, y));
            if (ln) {
              let min = 255;
              for (let y = ln[1]; y <= ln[2]; y += 1 / c.height) min = Math.min(min, at(ln[0], y));
              out.push(min);
            }
            resolve(out);
          };
          g.onerror = () => reject(g.error);
        };
      }),
    [imageId, pts, line ?? null] as const,
  );
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

try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`console: ${m.text()}`));
  // tsx 编译测试脚本时会给函数加 __name 包装，页面里补一个同名的空函数
  await page.addInitScript('window.__name = (f) => f;');
  await page.goto('http://localhost:5205/smart-wardrobe/');
  await page.locator('.boot').waitFor({ state: 'detached', timeout: 15000 });

  console.log('相册一次选多张：');
  const photos = {
    blackTee: await draw(page, 'blackTee'),
    stripes: await draw(page, 'stripes'),
    jeans: await draw(page, 'jeans'),
    multi: await draw(page, 'multi'),
  };
  if (process.env.DUMP_PHOTOS) for (const [k, v] of Object.entries(photos)) await import('node:fs/promises').then((fs) => fs.writeFile(`${process.env.DUMP_PHOTOS}/${k}.jpg`, v));
  await page.getByRole('button', { name: '批量录入' }).click();
  await page.getByRole('dialog', { name: '批量录入' }).waitFor();
  await page.getByTestId('batch-input').setInputFiles([
    { name: 'black-tee.jpg', mimeType: 'image/jpeg', buffer: photos.blackTee },
    { name: 'stripes.jpg', mimeType: 'image/jpeg', buffer: photos.stripes },
    { name: 'jeans.jpg', mimeType: 'image/jpeg', buffer: photos.jeans },
  ]);
  await page.getByText('全部处理完了').waitFor({ timeout: 60000 });
  const rows = await page.locator('.batch-row .batch-text').allInnerTexts();
  check(rows.length === 3 && rows.every((t) => t.endsWith('存了 1 件')), `三张照片各存了一件：${rows.join(' / ')}`);
  await page.screenshot({ path: `${SHOTS}/batch-01-progress.png` });

  console.log('一张照片拍好几件：');
  await page.getByRole('button', { name: '一张拍好几件' }).click();
  await page.getByTestId('batch-input').setInputFiles([{ name: 'flatlay.jpg', mimeType: 'image/jpeg', buffer: photos.multi }]);
  await page.getByText('全部处理完了').waitFor({ timeout: 60000 });
  const multiRow = (await page.locator('.batch-row .batch-text').allInnerTexts())[3];
  check(multiRow.endsWith('存了 3 件'), `拆成三件：${multiRow}`);
  check((await page.locator('.batch-row').nth(3).locator('.batch-previews img').count()) === 3, '每件都有小图');
  await page.screenshot({ path: `${SHOTS}/batch-02-multi.png` });

  console.log('白底上带白色部分的衣服：');
  const items = await storedItems(page);
  check(items.length === 6 && items.every((i) => i.status === 'pending'), '六件都先存成待整理');
  const [black, stripe, jeans, tee2, shorts, sock] = items;
  // 黑 T 恤：胸前白色印花的位置（相对贴图：横向中间、纵向约 0.45）
  const [printA, bodyA] = await cutoutAlpha(page, black.images.cutout, [
    [0.5, 0.43],
    [0.5, 0.7],
  ]);
  check(printA === 255 && bodyA === 255, `黑 T 恤胸前的白色印花保留（${printA}）`);
  check(/去背可能不准/.test(black.reviewNote ?? ''), '提示和背景颜色接近');
  // 条纹 T 恤：衣身中间一条竖线上下都是不透明的（白条纹没有被挖掉、也没有留浅缝）
  const [stripeMin] = await cutoutAlpha(page, stripe.images.cutout, [], [0.5, 0.35, 0.95]);
  check(stripeMin >= 250, `条纹 T 恤衣身的白条纹都补回来了（竖线上最低不透明度 ${stripeMin}）`);

  console.log('按轮廓猜的类别：');
  check(black.category === 'top' && black.subtype === 'T恤', `黑 T 恤猜成 ${black.category}/${black.subtype}`);
  check(stripe.subtype === 'T恤', '条纹 T 恤猜成 T恤');
  check(jeans.category === 'bottom' && jeans.subtype === '牛仔裤', `牛仔裤猜成 ${jeans.subtype}`);
  check(tee2.subtype === 'T恤' && shorts.subtype === '短裤', `平铺照片里的 T 恤和短裤：${tee2.subtype}、${shorts.subtype}`);
  check(sock.subtype === '' && /没认出类别/.test(sock.reviewNote ?? ''), `袜子不硬猜，提示选一下类别（${sock.category}/${sock.subtype}）`);

  console.log('待整理：');
  await page.getByRole('button', { name: '去整理' }).click();
  await page.getByRole('dialog', { name: '待整理' }).waitFor();
  check((await page.locator('.review-card').count()) === 6, '待整理列出六件');
  await page.screenshot({ path: `${SHOTS}/batch-03-review.png` });
  // 袜子：删掉
  const sockCard = page.locator('.review-card').nth(5);
  await sockCard.getByRole('button', { name: /^删除/ }).click();
  await page.locator('.sheet').getByRole('button', { name: '删除', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.review-card').length === 5);
  check(true, '删掉不要的一件');
  // 平铺照片里的 T 恤：改成卫衣（先点上衣，再点卫衣）
  const teeCard = page.locator('.review-card').nth(3);
  await teeCard.getByRole('group', { name: '款式' }).getByRole('button', { name: '卫衣' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.review-card')[3]?.querySelector('strong')?.textContent?.endsWith('卫衣'));
  check(true, '改款式后名称跟着变成「…卫衣」');
  // 细改：打开编辑页，确认后回到待整理
  await page.locator('.review-card').nth(0).getByRole('button', { name: '细改' }).click();
  await page.getByText('这件是批量录入的，还没确认').waitFor();
  check(await page.getByRole('button', { name: '用原图重新去背' }).isVisible(), '可以用原图重新去背');
  await page.getByRole('button', { name: '用原图重新去背' }).click();
  await page.getByRole('button', { name: '下一步' }).waitFor({ timeout: 20000 });
  check(await page.locator('label.switch', { hasText: '补回和背景同色的部分' }).isVisible(), '重新去背时也补回了白色印花');
  await page.getByRole('button', { name: '下一步' }).click();
  await page.locator('.topbar').getByRole('button', { name: '确认' }).click();
  await page.getByRole('dialog', { name: '待整理' }).waitFor();
  check((await page.locator('.review-card').count()) === 4, '在编辑页确认后回到待整理，少了一件');
  await page.getByRole('button', { name: '全部确认' }).click();
  await page.getByText(/已确认 4 件/).waitFor();
  check(await page.getByText('都整理好了').isVisible(), '全部确认后待整理清空');
  const after = await storedItems(page);
  check(after.length === 5 && after.every((i) => i.status === 'active'), '五件都进了衣橱');

  console.log('录入页：白底拍黑 T 恤');
  await page.getByRole('button', { name: '去衣橱看看' }).click();
  check((await page.locator('.grid .tile').count()) === 5, '衣橱里显示五件');
  await page.screenshot({ path: `${SHOTS}/batch-06-wardrobe.png` });
  await page.getByRole('button', { name: '录入单品' }).first().click();
  check(await page.getByText('白色或带白边、白字的衣服，用深色床单或地板当背景').isVisible(), '拍照提示里说明白色衣服用深色背景');
  await page.getByTestId('photo-input').setInputFiles({ name: 'black-tee.jpg', mimeType: 'image/jpeg', buffer: photos.blackTee });
  await page.getByRole('button', { name: '下一步' }).waitFor({ timeout: 20000 });
  check(await page.locator('.warnbox', { hasText: '衣服上有和背景很接近的颜色' }).isVisible(), '提醒衣服和背景颜色接近');
  const fill = page.locator('label.switch', { hasText: '补回和背景同色的部分' }).locator('input');
  check(await fill.isChecked(), '默认补回');
  // 照片里印花在 (130+70*3.2+96, 140+86*3.2) 附近，换成相对位置
  const px = (130 + 100 * 3.2) / 900;
  const py = (140 + 86 * 3.2) / 900;
  check((await previewAlpha(page, px, py)) === 255, '预览里白色印花是保留的');
  await page.locator('.cutout-view').screenshot({ path: `${SHOTS}/batch-04-white-print.png` });
  await fill.uncheck();
  check((await previewAlpha(page, px, py)) < 80, '关掉开关后印花又被挖掉（对照）');
  check(await page.locator('.warnbox', { hasText: '衣服上有和背景很接近的颜色' }).isVisible(), '提示仍然显示');
  await page.screenshot({ path: `${SHOTS}/batch-05-editor-warn.png`, fullPage: true });

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
