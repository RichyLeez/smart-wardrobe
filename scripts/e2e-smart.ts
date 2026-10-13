// 端到端测试：只填身高体重、简化图形、色板与面料评分、"这件怎么搭"（网站版，本机存储）。
// 运行：npm run build && node --import tsx scripts/e2e-smart.ts [截图目录]

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
await new Promise<void>((r) => server.listen(5203, r));

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error(`检查失败：${msg}`);
  console.log(`  ✓ ${msg}`);
}

await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors: string[] = [];

/** 人台上第一件衣服贴图的实际像素宽度（简化图形最长边 320，示例照片 640） */
async function garmentWidth(page: Page, scope: string): Promise<number> {
  return page.evaluate(async (sel) => {
    const el = document.querySelector(`${sel} image.garment`);
    const href = el?.getAttribute('href');
    if (!href) return -1;
    const img = new Image();
    img.src = href;
    await img.decode();
    return Math.max(img.naturalWidth, img.naturalHeight);
  }, scope);
}

try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`console: ${m.text()}`));
  await page.goto('http://localhost:5203/smart-wardrobe/');
  await page.locator('.boot').waitFor({ state: 'detached', timeout: 15000 });

  console.log('只填身高体重：');
  await page.getByRole('button', { name: '用示例衣橱试试' }).click();
  await page.getByRole('button', { name: '就穿这套' }).waitFor({ timeout: 15000 });
  check(await page.getByText('填写身高和体重').isVisible(), '首页提示填写身高和体重');
  await page.getByRole('button', { name: '设置' }).click();
  const fill = async (label: string, v: string) => page.locator('.body-grid label', { hasText: label }).locator('input').fill(v);
  await fill('身高', '165');
  await fill('体重', '55');
  await page.getByRole('button', { name: '女', exact: true }).click();
  const est = await page.locator('.body-estimate').innerText();
  check(/肩宽 \d+、胸围 \d+、腰围 \d+、臀围 \d+、腿长 \d+ cm/.test(est), `估算出其余尺寸：${est.slice(0, 40)}…`);
  check((await page.locator('.body-grid label', { hasText: '胸围' }).count()) === 0, '其余尺寸默认收起');
  await page.getByRole('button', { name: '保存身材数据' }).click();
  await page.getByText('身材数据已保存').waitFor();
  check(await page.getByText('比例按身高体重估算').isVisible(), '说明比例是估算的');
  await page.screenshot({ path: `${SHOTS}/smart-01-body.png` });
  await page.getByRole('button', { name: '填写更多尺寸（可选，更准）' }).click();
  check((await page.locator('.body-grid label', { hasText: '腰围' }).locator('input').getAttribute('placeholder')) !== '', '展开后估算值作为提示');
  await fill('腰围', '66');
  await page.getByRole('button', { name: '保存身材数据' }).click();
  await page.getByRole('button', { name: '返回' }).click();
  check(!(await page.getByText('填写身高和体重').isVisible()), '保存后首页不再提示');
  await page.getByRole('button', { name: '设置' }).click();
  check((await page.locator('.body-grid label', { hasText: '体重' }).locator('input').inputValue()) === '55', '体重已保存');
  check((await page.locator('.body-grid label', { hasText: '腰围' }).locator('input').inputValue()) === '66', '实测的腰围已保存，再次打开时展开');
  await page.getByRole('button', { name: '返回' }).click();

  console.log('色板、面料与简化图形：');
  const scheme = await page.locator('.palette-meta strong').first().innerText();
  check(/中性色|同色系|邻近色|对比色|多色/.test(scheme), `显示配色方式：${scheme}`);
  await page.getByRole('button', { name: '查看评分明细' }).click();
  check(await page.locator('.parts').getByText('面料', { exact: true }).isVisible(), '评分明细里有面料一项');
  await page.waitForFunction(
    async () => {
      const el = document.querySelector('.slide image.garment');
      const href = el?.getAttribute('href');
      if (!href) return false;
      const img = new Image();
      img.src = href;
      await img.decode();
      return Math.max(img.naturalWidth, img.naturalHeight) <= 320;
    },
    null,
    { timeout: 20000, polling: 500 },
  );
  check((await garmentWidth(page, '.slide')) <= 320, '人台上默认显示简化图形');
  await page.locator('.slide .stage').first().screenshot({ path: `${SHOTS}/smart-02-flat.png` });
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: '照片', exact: true }).click();
  await page.getByRole('button', { name: '返回' }).click();
  await page.waitForTimeout(500);
  check((await garmentWidth(page, '.slide')) > 320, '切到照片后显示原始照片');
  await page.locator('.slide .stage').first().screenshot({ path: `${SHOTS}/smart-03-photo.png` });
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: '简化图形', exact: true }).click();
  await page.getByRole('button', { name: '返回' }).click();

  console.log('这件怎么搭：');
  await page.locator('nav.tabbar').getByRole('button', { name: '衣橱' }).click();
  await page.locator('.grid .tile', { hasText: '白衬衫' }).click();
  await page.getByRole('button', { name: '这件怎么搭' }).click();
  await page.locator('.match-card').first().waitFor();
  const cards = await page.locator('.match-card .match-items').allInnerTexts();
  check(cards.length >= 2 && cards.every((t) => t.includes('白衬衫')), `${cards.length} 套都包含白衬衫`);
  check(await page.locator('.match-card').first().locator('.palette-bar').isVisible(), '每套都有色板');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/smart-04-match.png` });
  await page.locator('.match-card').first().getByRole('button', { name: '去试搭调整' }).click();
  await page.locator('.builder-stage').waitFor();
  check((await page.locator('.pick[aria-pressed="true"]', { hasText: '白衬衫' }).count()) === 1, '带到试搭里继续调整');
  check(await page.locator('.palette-bar').isVisible(), '试搭里也显示色板');

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
