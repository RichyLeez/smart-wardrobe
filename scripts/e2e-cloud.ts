// 端到端测试：模拟 claude.ai 发布环境（云端数据库、图片存储、下载），在真实浏览器里走完整流程。
// 运行：node --import tsx scripts/e2e-cloud.ts [截图目录]
// 需要先 npm run build 生成 dist/artifact.html。

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
import JSZip from 'jszip';
import { FakeAssets, FakeCloud } from '../tests/fake-cloud';

const SHOTS = process.argv[2] ?? 'e2e-shots';
const UID = 'u_e2etestuser0000000000';
const PREFIX = `data/users/${UID}/w/`;

const cloud = new FakeCloud();
const assets = new FakeAssets();
const downloads: Array<{ filename: string; size: number; bytes: Buffer }> = [];

// 与平台一致：外层 HTML 由平台补上，页面正文放进 body
const body = await readFile('dist/artifact.html', 'utf8');
const page_html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${body}</body></html>`;

const server = createServer((req, res) => {
  const url = req.url ?? '/';
  if (url.startsWith('/_blob/')) {
    const blob = assets.files.get(url.slice('/_blob/'.length));
    if (!blob) {
      res.writeHead(404).end();
      return;
    }
    blob.arrayBuffer().then((buf) => {
      res.writeHead(200, { 'content-type': blob.type });
      res.end(Buffer.from(buf));
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page_html);
});
await new Promise<void>((r) => server.listen(5199, r));

const MOCK = `(() => {
  const SEG = /^[A-Za-z0-9_\\-.~:@+]{1,200}$/;
  const check = (p, even) => {
    const parts = p.split('/');
    if (parts.some((x) => !SEG.test(x)) || (parts.length % 2 === 0) !== even) throw new TypeError('路径不合法：' + p);
  };
  const fail = (r) => { if (r && r.error) throw r.error; return r; };
  const docRef = (path) => {
    check(path, true);
    return {
      id: path.split('/').pop(), path,
      get: async () => { const d = await window.__cloudGet(path); return { id: path.split('/').pop(), exists: !!d, data: () => d || undefined, metadata: {} }; },
      set: async (data) => { fail(await window.__cloudSet(path, JSON.parse(JSON.stringify(data)))); },
      update: async () => { throw { code: 'invalid_argument', message: 'not used' }; },
      delete: async () => { fail(await window.__cloudDelete(path)); },
      collection: (name) => colRef(path + '/' + name),
    };
  };
  const query = (path, filters, order, lim) => ({
    where: (f, op, v) => query(path, [...filters, [f, op, v]], order, lim),
    orderBy: (f, dir) => query(path, filters, [f, dir || 'asc'], lim),
    limit: (n) => query(path, filters, order, n),
    get: async () => {
      const rows = fail(await window.__cloudQuery({ path, filters, order, lim }));
      const docs = rows.map((r) => ({ id: r.id, exists: true, data: () => r.data, metadata: {} }));
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  });
  const colRef = (path) => { check(path, false); return Object.assign(query(path, [], null, null), { path, doc: (id) => docRef(path + '/' + (id || Math.random().toString(36).slice(2))) }); };
  const toB64 = async (blob) => {
    const buf = new Uint8Array(await blob.arrayBuffer()); let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const hang = window.__mockMode === 'hang';
  const caps = {
    permissions: Object.freeze({
      state: async () => ({ db: 'prompt', user: 'granted', assets: 'prompt', downloads: 'granted' }),
      request: (names) => hang ? new Promise(() => {}) : new Promise((r) => setTimeout(() => r(Object.fromEntries((names || []).map((n) => [n, 'granted']))), 700)),
      manage: async () => {},
    }),
    db: Object.freeze({ doc: docRef, collection: colRef }),
    assets: Object.freeze({
      upload: async (blob, opts) => fail(await window.__assetUpload(await toB64(blob), (opts && opts.type) || blob.type)),
      list: () => window.__assetList(),
      delete: (ref) => window.__assetDelete(ref),
    }),
    user: Object.freeze({ id: async () => '${UID}', isOwner: async () => true, canEdit: async () => true }),
    downloads: Object.freeze({ save: async ({ filename, data }) => { await window.__download(filename, await toB64(data)); return { status: 'saved' }; } }),
  };
  window.claude = Object.freeze({ use: (name) => new Promise((r) => setTimeout(() => r(caps[name] || null), 60)) });
})();`;

async function wire(page: Page, mode: 'normal' | 'hang') {
  const wrapErr = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (e) {
      const code = typeof e === 'object' && e && 'code' in e ? (e as { code: string }).code : 'invalid_argument';
      return { error: { code, message: String((e as { message?: string })?.message ?? e) } };
    }
  };
  await page.exposeFunction('__cloudGet', (path: string) => cloud.docs.get(path) ?? null);
  await page.exposeFunction('__cloudSet', (path: string, data: Record<string, unknown>) => wrapErr(() => cloud.doc(path).set(data)));
  await page.exposeFunction('__cloudDelete', (path: string) => wrapErr(() => cloud.doc(path).delete()));
  await page.exposeFunction(
    '__cloudQuery',
    (spec: { path: string; filters: Array<[string, string, unknown]>; order: [string, 'asc' | 'desc'] | null; lim: number | null }) =>
      wrapErr(async () => {
        let q = cloud.collection(spec.path) as ReturnType<FakeCloud['collection']> | ReturnType<ReturnType<FakeCloud['collection']>['where']>;
        for (const [f, op, v] of spec.filters) q = q.where(f, op, v);
        if (spec.order) q = q.orderBy(spec.order[0], spec.order[1]);
        if (spec.lim !== null) q = q.limit(spec.lim);
        const snap = await q.get();
        return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
      }),
  );
  await page.exposeFunction('__assetUpload', (b64: string, type: string) =>
    wrapErr(() => assets.upload(new Blob([Buffer.from(b64, 'base64')], { type }), { type })),
  );
  await page.exposeFunction('__assetList', () => assets.list());
  await page.exposeFunction('__assetDelete', (ref: string) => assets.delete(ref));
  await page.exposeFunction('__download', (filename: string, b64: string) => {
    const bytes = Buffer.from(b64, 'base64');
    downloads.push({ filename, size: bytes.length, bytes });
  });
  await page.addInitScript(`window.__mockMode = '${mode}';`);
  await page.addInitScript(MOCK);
}

const count = (coll: string) => [...cloud.docs.keys()].filter((p) => p.startsWith(PREFIX + coll + '/')).length;
function check(cond: unknown, msg: string) {
  if (!cond) throw new Error(`检查失败：${msg}`);
  console.log(`  ✓ ${msg}`);
}

await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch();
const errors: string[] = [];

async function newPage(scheme: 'light' | 'dark', mode: 'normal' | 'hang' = 'normal', waitReady = true) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  await wire(page, mode);
  await page.goto('http://localhost:5199/');
  if (waitReady) await page.locator('.boot').waitFor({ state: 'detached', timeout: 15000 });
  return page;
}

try {
  console.log('云端模式流程：');
  let page = await newPage('light', 'normal', false);
  await page.getByText('第一次打开，需要你允许页面保存数据').waitFor({ timeout: 5000 });
  await page.screenshot({ path: `${SHOTS}/boot-01-permission.png` });
  check(true, '首次打开先显示授权说明，而不是空白');
  await page.locator('.boot').waitFor({ state: 'detached', timeout: 15000 });
  await page.getByText('先把衣橱搬进来').waitFor();
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByText('保存在你的 Claude 账号下').waitFor();
  check(true, '设置页说明数据保存在 Claude 账号下（云端模式已启用）');
  await page.getByRole('button', { name: '返回' }).click();

  await page.getByRole('button', { name: '用示例衣橱试试' }).click();
  await page.getByRole('button', { name: '就穿这套' }).waitFor({ timeout: 20000 });
  check(count('items') === 20, `示例单品写入云端：${count('items')} 件`);
  check(assets.files.size === 0, '示例图片现场绘制，没有占用图片存储');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/cloud-01-today.png` });

  await page.getByRole('button', { name: '填最高/最低气温' }).click();
  await page.locator('#temp-min').fill('8');
  await page.locator('#temp-max').fill('18');
  await page.screenshot({ path: `${SHOTS}/cloud-02-temp-sheet.png` });
  await page.getByRole('button', { name: '用这个气温' }).click();
  await page.getByText('8–18°，手动输入').waitFor();
  const temp = (await page.locator('.temp').innerText()).replace(/\s/g, '');
  check(temp.startsWith('14'), `按最高/最低气温换算代表气温：${temp}`);
  await page.waitForTimeout(500);
  const today = cloud.docs.get(PREFIX + 'kv/today') as { v: { weather: { tempMin: number } } } | undefined;
  check(today?.v.weather.tempMin === 8, '今日气温写入云端');

  await page.getByRole('button', { name: '就穿这套' }).click();
  await page.getByText('已记为今天的穿搭').waitFor();
  check(count('records') === 5, `穿搭记录写入云端：${count('records')} 条`);

  await page.locator('nav.tabbar').getByRole('button', { name: '衣橱' }).click();
  await page.getByRole('button', { name: '录入单品' }).click();
  await page.getByTestId('photo-input').setInputFiles('tests/fixtures/navy-tee.jpg');
  await page.getByRole('button', { name: '补充信息' }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/cloud-03-cutout.png` });
  await page.getByRole('button', { name: '补充信息' }).click();
  await page.getByRole('group').first().getByRole('button', { name: '上衣' }).click();
  await page.getByRole('button', { name: 'T恤', exact: true }).click();
  const colorName = await page.locator('.color-current span').nth(1).innerText();
  await page.screenshot({ path: `${SHOTS}/cloud-04-info.png`, fullPage: true });
  await page.locator('.topbar').getByRole('button', { name: '保存' }).click();
  await page.getByText(/^已录入/).waitFor({ timeout: 20000 });
  check(assets.files.size === 3, `照片上传到图片存储：${assets.files.size} 个文件（贴图、缩略图、原图）`);
  check(count('images') === 3, '图片索引写入云端');
  check(count('items') === 21, '新单品写入云端');
  console.log(`    识别的颜色：${colorName}`);

  // 刷新后数据仍在（另一台设备打开同理）
  await page.context().close();
  page = await newPage('light');
  await page.locator('nav.tabbar').getByRole('button', { name: '衣橱' }).click();
  const tee = page.locator('img[src^="/_blob/"]').first();
  await tee.waitFor({ timeout: 10000 });
  const loaded = await tee.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
  check(loaded, '刷新后照片从云端地址正常显示');
  await page.screenshot({ path: `${SHOTS}/cloud-05-wardrobe.png` });

  await page.locator('nav.tabbar').getByRole('button', { name: '今日' }).click();
  await page.getByText('今天穿了这套').waitFor();
  check(true, '刷新后今天的穿搭记录仍在');

  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: '导出完整备份（.zip）' }).click();
  await page.getByText(/备份已导出/).waitFor({ timeout: 20000 });
  check(downloads.length === 1 && downloads[0].size > 1000 && downloads[0].filename.endsWith('.zip'), `备份通过平台下载导出：${downloads[0]?.filename}（${downloads[0]?.size} 字节）`);
  const zip = await JSZip.loadAsync(downloads[0].bytes);
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
  check(manifest.items.length === 21 && Object.keys(manifest.images).length === 3, `备份是有效的 ZIP：${manifest.items.length} 件单品、${Object.keys(manifest.images).length} 张照片`);
  await page.screenshot({ path: `${SHOTS}/cloud-06-settings.png`, fullPage: true });

  await page.getByRole('button', { name: '清除示例数据' }).click();
  await page.getByText(/已清除 20 件示例单品/).waitFor();
  check(count('items') === 1, `清除示例后只剩自己录入的单品：${count('items')} 件`);
  check(count('records') === 0, '示例记录和用示例单品做的记录一并清除');

  await page.getByRole('button', { name: '返回' }).click();
  await page.locator('nav.tabbar').getByRole('button', { name: '衣橱' }).click();
  await page.locator('.grid .tile').first().click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.locator('.sheet').getByRole('button', { name: '删除' }).click();
  await page.getByText('已删除').waitFor();
  check(count('items') === 0 && assets.files.size === 0 && count('images') === 0, '删除单品时云端图片一并删除');
  check(cloud.maxInflight <= 1, `同一文档没有并发写入（最大 ${cloud.maxInflight}）`);
  await page.context().close();

  console.log('深色模式截图：');
  page = await newPage('dark');
  await page.getByRole('button', { name: '用示例衣橱试试' }).click();
  await page.getByRole('button', { name: '就穿这套' }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/dark-01-today.png` });
  await page.locator('nav.tabbar').getByRole('button', { name: '衣橱' }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/dark-02-wardrobe.png` });
  await page.context().close();

  console.log('授权提示一直没有回应时：');
  page = await newPage('light', 'hang', false);
  await page.getByRole('button', { name: '先用本机模式' }).waitFor({ timeout: 12000 });
  await page.screenshot({ path: `${SHOTS}/boot-02-slow.png` });
  check(true, '等待 8 秒后给出说明和“先用本机模式”按钮');
  await page.getByRole('button', { name: '先用本机模式' }).click();
  await page.getByText('先把衣橱搬进来').waitFor({ timeout: 8000 });
  await page.getByText(/云端存储不可用（你选择了先用本机模式）/).waitFor();
  check(true, '选择本机模式后页面正常打开，并提示数据只存在这个浏览器');
  await page.context().close();

  const overflow = errors.filter((e) => !e.includes('favicon'));
  check(overflow.length === 0, `没有页面错误${overflow.length ? '：\n' + overflow.join('\n') : ''}`);
  console.log('\n全部通过');
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  if (errors.length) console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
