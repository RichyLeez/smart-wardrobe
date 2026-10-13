// 构建脚本（esbuild）。
//   node scripts/build.mjs build  → dist/（可部署的网站）、dist/智能衣橱-单文件版.html（可直接双击打开）
//                                    和 dist/artifact.html（发布到 claude.ai 的页面正文，外层 HTML 由平台补上）
//   node scripts/build.mjs dev    → 本地开发服务器，局域网内手机也能访问

import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';

const mode = process.argv[2] ?? 'build';
const dev = mode === 'dev';
const port = Number(process.env.PORT ?? 5173);

const options = {
  entryPoints: ['src/main.tsx'],
  bundle: true,
  format: 'iife',
  target: ['es2020', 'safari15'],
  jsx: 'automatic',
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
  loader: { '.css': 'css' },
  outdir: dev ? 'dev' : 'dist',
  write: false,
  logLevel: 'info',
  legalComments: 'none',
};

/**
 * 部分依赖（jszip）的字符串里带有原始控制字符（如 ZIP 文件头 "PK\x03\x04"）。
 * 浏览器能执行，但发布平台和一些工具会把页面当成含终端控制符的文件处理，
 * 所以统一改写为 \xNN 转义。这些字符只会出现在字符串或正则里，转义后含义不变。
 */
function escapeControlChars(js) {
  return js.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (c, i) => {
    if (js[i - 1] === '\\') throw new Error(`第 ${i} 个字符前有反斜杠，不能直接转义`);
    return '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0');
  });
}

function bundleText(result, ext) {
  const text = result.outputFiles.find((f) => f.path.endsWith(ext))?.text ?? '';
  return ext === '.js' ? escapeControlChars(text) : text;
}

async function renderHtml(result, { standalone }) {
  const tpl = await readFile('src/index.html', 'utf8');
  const js = bundleText(result, '.js');
  const css = bundleText(result, '.css');
  const head = standalone
    ? ''
    : '<link rel="manifest" href="manifest.webmanifest" />\n    <link rel="apple-touch-icon" href="icon-192.png" />';
  // 用函数做替换，避免代码里的 $ 符号被当成替换模式
  return tpl
    .replace('<!--MANIFEST-->', () => head)
    .replace('<!--CSS-->', () => `<style>${css}</style>\n    ${BOOT_GUARD}`)
    .replace('<div id="root"></div>', () => ROOT)
    .replace('<!--JS-->', () => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`);
}

/**
 * 启动前的出错提示：如果脚本在应用启动前就出错，把错误原文显示在页面上，
 * 而不是留下一片空白（用户可以把这段文字发回来排查）。应用启动后不再弹出。
 */
const BOOT_GUARD = `<script>(function(){var shown=false;function show(m){if(shown||window.__wardrobeBooted)return;shown=true;var d=document.createElement('div');d.setAttribute('role','alert');d.style.cssText='position:fixed;left:12px;right:12px;top:12px;z-index:9999;padding:12px 14px;border-radius:10px;background:#b13a35;color:#fff;font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;white-space:pre-wrap;word-break:break-all';d.textContent='页面出错了，请把这段文字发给 Claude：\\n'+m;(document.body||document.documentElement).appendChild(d);}window.addEventListener('error',function(e){show((e.message||'未知错误')+(e.filename?' @'+e.filename.split('/').pop()+':'+e.lineno+':'+e.colno:''));});window.addEventListener('unhandledrejection',function(e){var r=e.reason;show('未处理的异常：'+(r&&r.message?r.message:String(r)));});})();</script>`;

/** 脚本还没运行时就能看到的文字，React 启动后会替换掉 */
const ROOT = '<div id="root"><p class="boot-static">正在打开智能衣橱…</p></div>';

/** claude.ai 发布页面：不写 doctype/head/body，标题放在最前面 */
function renderArtifact(result) {
  const js = bundleText(result, '.js');
  const css = bundleText(result, '.css');
  return [
    '<title>智能衣橱</title>',
    `<style>${css}</style>`,
    BOOT_GUARD,
    ROOT,
    '<noscript>需要开启 JavaScript 才能使用智能衣橱。</noscript>',
    `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`,
    '',
  ].join('\n');
}

if (dev) {
  await mkdir('dev', { recursive: true });
  await cp('public', 'dev', { recursive: true });
  const ctx = await esbuild.context({
    ...options,
    plugins: [
      {
        name: 'html',
        setup(build) {
          build.onEnd(async (result) => {
            if (result.errors.length) return;
            await writeFile('dev/index.html', await renderHtml(result, { standalone: false }));
          });
        },
      },
    ],
  });
  await ctx.watch();
  await ctx.serve({ servedir: 'dev', port, host: '0.0.0.0' });
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => `http://${n.address}:${port}`);
  console.log(`\n  本机访问：http://localhost:${port}`);
  if (lan.length) console.log(`  手机访问（同一 Wi-Fi）：${lan.join('  ')}`);
  console.log('  修改代码后刷新页面即可看到变化，按 Ctrl+C 停止。\n');
} else {
  await rm('dist', { recursive: true, force: true });
  await mkdir('dist', { recursive: true });
  const result = await esbuild.build(options);
  await cp('public', 'dist', { recursive: true });
  await writeFile('dist/index.html', await renderHtml(result, { standalone: false }));
  await writeFile('dist/智能衣橱-单文件版.html', await renderHtml(result, { standalone: true }));
  await writeFile('dist/artifact.html', renderArtifact(result));
  const size = (await readFile('dist/index.html')).length;
  console.log(`\n  已生成 dist/index.html（${(size / 1024).toFixed(0)} KB）和 dist/智能衣橱-单文件版.html\n`);
}
