// 端到端测试：吊牌识别与分类筛选（网站版，本机存储）。
// 识别组件用替身代替（测试环境不能访问 jsDelivr），替身返回一段带典型识别错误的吊牌文字，
// 用来检查识别之后的整条流程：结果展示 → 填入 → 号型与身材对比 → 保存 → 按品牌筛选 → 按面料分组。
// 运行：npm run build && node --import tsx scripts/e2e-tag.ts [截图目录]

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
await new Promise<void>((r) => server.listen(5201, r));

// 识别结果故意带上常见问题：字之间有空格、百分号前有空格、把 0 认成 O
const TAG_TEXT = `品 牌 : 太 平 鸟
货 号 : B1DAD3101
号 型 : 175/96A
规 格 : L
成 分 : 面 料 : 聚 酯 纤 维 65 % 粘 纤 35 %
里 料 : 聚 酯 纤 维 1OO %
执 行 标 准 : GB/T 2664-2017
品 名 : 西 装 外 套
版 型 : 修 身`;

const TESSERACT_STUB = `window.Tesseract = {
  createWorker: async (langs, oem, options) => {
    window.__ocrLangs = langs;
    const log = (status, progress) => options && options.logger && options.logger({ status, progress });
    log('loading tesseract core', 0.5);
    await new Promise((r) => setTimeout(r, 150));
    log('loading language traineddata', 1);
    log('initializing api', 1);
    return {
      recognize: async (image) => {
        window.__ocrImage = image && image.width ? image.width + 'x' + image.height : 'unknown';
        log('recognizing text', 0.6);
        await new Promise((r) => setTimeout(r, 150));
        return { data: { text: ${JSON.stringify(TAG_TEXT)} } };
      },
      terminate: async () => {},
    };
  },
};`;

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error(`检查失败：${msg}`);
  console.log(`  ✓ ${msg}`);
}

await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch();
const errors: string[] = [];

async function open(scheme: 'light' | 'dark'): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  let stubbed = 0;
  await page.route('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js', (route) => {
    stubbed++;
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: TESSERACT_STUB });
  });
  (page as unknown as { stubbed: () => number }).stubbed = () => stubbed;
  await page.goto('http://localhost:5201/smart-wardrobe/');
  await page.locator('.boot').waitFor({ state: 'detached', timeout: 15000 });
  return page;
}

try {
  console.log('吊牌识别流程：');
  const page = await open('light');

  // 身材数据（男，胸围 92、腰围 80）
  await page.getByRole('button', { name: '设置' }).click();
  const fill = async (label: string, v: string) => page.locator('.body-grid label', { hasText: label }).locator('input').fill(v);
  await fill('身高', '175');
  await fill('肩宽', '45');
  await fill('胸围', '92');
  await fill('腰围', '80');
  await fill('臀围', '96');
  await fill('内侧腿长', '80');
  await page.getByRole('button', { name: '男', exact: true }).click();
  await page.getByRole('button', { name: '保存身材数据' }).click();
  await page.getByText('身材数据已保存').waitFor();
  await page.getByRole('button', { name: '返回' }).click();

  // 先载入示例衣橱，后面用来测试筛选和分组
  await page.getByRole('button', { name: '用示例衣橱试试' }).click();
  await page.getByRole('button', { name: '就穿这套' }).waitFor({ timeout: 15000 });

  // 录入一件：衣服照片 → 去背 → 信息页拍吊牌
  await page.locator('nav.tabbar').getByRole('button', { name: '衣橱' }).click();
  await page.getByRole('button', { name: '录入单品' }).click();
  await page.getByTestId('photo-input').setInputFiles('tests/fixtures/navy-tee.jpg');
  await page.getByRole('button', { name: '下一步' }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByText('吊牌信息').first().waitFor();
  await page.getByTestId('tag-input').setInputFiles('tests/fixtures/navy-tee.jpg');
  await page.getByRole('button', { name: '填入这些信息' }).waitFor({ timeout: 15000 });
  check((page as unknown as { stubbed: () => number }).stubbed() === 1, '第一次识别时才加载识别组件');
  const langs = await page.evaluate(() => (window as unknown as { __ocrLangs: string[] }).__ocrLangs);
  check(JSON.stringify(langs) === JSON.stringify(['chi_sim', 'eng']), '识别使用简体中文和英文字库');
  const result = await page.locator('.tag-result').innerText();
  check(/太平鸟/.test(result) && /B1DAD3101/.test(result), '认出品牌和货号');
  check(/175\/96A/.test(result), '认出号型');
  check(/聚酯纤维 65%，粘纤 35%；里料 聚酯纤维 100%/.test(result), '成分按面料、里料整理好（O 已纠正为 0）');
  check(/西装外套（外套，来自品名）/.test(result), '从品名认出款式');
  check(/GB\/T 2664-2017（男西服、大衣）/.test(result), '执行标准对应到产品类型');
  await page.locator('.tag-card').screenshot({ path: `${SHOTS}/tag-01-result.png` });

  await page.getByRole('button', { name: '填入这些信息' }).click();
  await page.getByText(/已从吊牌填入：/).waitFor();
  check((await page.locator('#item-brand').inputValue()) === '太平鸟', '品牌已填入');
  check((await page.locator('#item-size').inputValue()) === 'L 175/96A', '尺码和号型已填入');
  check((await page.locator('#item-material').inputValue()).startsWith('聚酯纤维 65%'), '成分已填入');
  const fitText = await page.locator('.fit-analysis').innerText();
  check(/比你的胸围大 4cm，约大一号/.test(fitText), '号型和身材对比：大一号');
  check(/吊牌标注修身版，大一号穿，你穿上接近常规/.test(fitText), '修身版大一号，换算为常规');
  const fitPressed = await page.locator('.field', { hasText: '版型' }).locator('button[aria-pressed="true"]').innerText();
  check(fitPressed === '常规', '版型字段按换算结果填为常规');
  await page.locator('.fit-analysis').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/tag-02-fit.png` });

  await page.locator('.topbar').getByRole('button', { name: '保存' }).click();
  await page.getByText(/^已录入/).waitFor({ timeout: 15000 });

  // 粘贴文字流程（编辑刚保存的单品）
  await page.locator('.grid .tile').first().click();
  check((await page.locator('#item-style-no').inputValue()) === 'B1DAD3101', '重新打开单品时货号仍在');
  await page.getByRole('button', { name: '查看识别的文字' }).click();
  check((await page.locator('#tag-text').inputValue()).includes('太 平 鸟'), '保存了识别的原文，可以查看和修改');
  await page.locator('#tag-text').fill('UNIQLO 优衣库\n尺码 SIZE M\n号型 170/92A\n面料：棉 100%');
  await page.getByRole('button', { name: '读取这段文字' }).click();
  const r2 = await page.locator('.tag-result').innerText();
  check(/优衣库/.test(r2) && /M 170\/92A/.test(r2) && /棉 100%/.test(r2), '粘贴的文字也能读取');
  await page.getByRole('button', { name: '不用了' }).click();
  await page.getByRole('button', { name: '关闭' }).click();

  // 分类筛选：品牌
  await page.getByRole('button', { name: '按品牌、面料、长短筛选' }).click();
  const sheet = page.locator('.sheet');
  await sheet.getByText('品牌', { exact: true }).waitFor();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/tag-03-filter-sheet.png` });
  await sheet.getByRole('button', { name: /太平鸟/ }).click();
  await sheet.getByRole('button', { name: /^看 1 件$/ }).click();
  check((await page.locator('.grid .tile').count()) === 1, '按品牌筛选后只剩 1 件');
  check(await page.getByRole('button', { name: '去掉条件：品牌 太平鸟' }).isVisible(), '页面上显示已选条件');
  await page.getByRole('button', { name: '去掉条件：品牌 太平鸟' }).click();
  check((await page.locator('.grid .tile').count()) === 21, '去掉条件后恢复全部 21 件');

  // 分组：按面料
  await page.locator('#wardrobe-group').selectOption('fabric');
  const heads = await page.locator('.group-head').allInnerTexts();
  check(heads.some((h) => h.startsWith('聚酯纤维')) && heads.some((h) => h.startsWith('棉')), `按面料分组：${heads.map((h) => h.replace(/\s+/g, ' ')).join('、')}`);
  await page.screenshot({ path: `${SHOTS}/tag-04-grouped.png` });
  await page.locator('#wardrobe-group').selectOption('brand');
  await page.screenshot({ path: `${SHOTS}/tag-05-grouped-brand.png` });

  // 试搭里也能筛选
  await page.locator('nav.tabbar').getByRole('button', { name: '试搭' }).click();
  await page.getByRole('button', { name: '按品牌、面料、颜色筛选' }).click();
  await page.locator('.sheet').getByRole('button', { name: /^聚酯纤维/ }).click();
  await page.locator('.sheet').getByRole('button', { name: /^看 \d+ 件$/ }).click();
  check(await page.getByRole('button', { name: /去掉条件：面料 聚酯纤维/ }).isVisible(), '试搭的单品列表也能按面料筛选');
  await page.context().close();

  console.log('深色模式：');
  const dark = await open('dark');
  await dark.locator('nav.tabbar').getByRole('button', { name: '衣橱' }).click();
  await dark.getByRole('button', { name: '录入单品' }).first().click();
  await dark.getByTestId('photo-input').setInputFiles('tests/fixtures/navy-tee.jpg');
  await dark.getByRole('button', { name: '下一步' }).waitFor({ timeout: 15000 });
  await dark.getByRole('button', { name: '下一步' }).click();
  await dark.getByTestId('tag-input').setInputFiles('tests/fixtures/navy-tee.jpg');
  await dark.getByRole('button', { name: '填入这些信息' }).waitFor({ timeout: 15000 });
  await dark.locator('.tag-card').screenshot({ path: `${SHOTS}/tag-06-dark.png` });
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
