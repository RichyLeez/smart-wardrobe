// 把 dist/ 发布到 GitHub Pages（gh-pages 分支根目录）。
// 用法：npm run build && npm run deploy:pages
// 需要当前仓库已设置 origin 远程地址，并有推送权限。

import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
const dir = await mkdtemp(join(tmpdir(), 'wardrobe-pages-'));
try {
  await cp('dist', dir, { recursive: true });
  // 发布页面版（claude.ai 用）不放到网站里
  await rm(join(dir, 'artifact.html'), { force: true });
  // 关闭 Jekyll 处理，文件原样发布
  await writeFile(join(dir, '.nojekyll'), '');
  run('git', ['init', '-q', '-b', 'gh-pages'], dir);
  run('git', ['add', '-A'], dir);
  run('git', ['-c', 'user.name=smart-wardrobe', '-c', 'user.email=deploy@localhost', 'commit', '-q', '-m', `发布网站 ${new Date().toISOString()}`], dir);
  run('git', ['push', '-f', remote, 'gh-pages'], dir);
  console.log('\n  已发布到 gh-pages 分支，GitHub Pages 通常 1 分钟内更新。\n');
} finally {
  await rm(dir, { recursive: true, force: true });
}
