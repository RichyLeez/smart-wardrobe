// 离线缓存：页面本身只有一个 index.html（脚本和样式已内联），缓存它即可离线打开。
// 数据保存在 IndexedDB，不经过这里。
const CACHE = 'smart-wardrobe-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      // 只清理页面自己的旧缓存，不动抠图模型的缓存（wardrobe-model-*）
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('smart-wardrobe-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 页面：网络优先，断网时用缓存；天气接口不缓存
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 抠图模型由页面自己存进单独的缓存（约 56MB），这里不再复制一份
  if (url.pathname.includes('/models/')) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html'))),
  );
});
