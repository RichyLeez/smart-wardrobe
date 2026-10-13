import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './ui/App';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// 只有部署成网站（页面带 manifest）并通过 https 或 localhost 访问时才注册离线缓存；
// 单文件版、claude.ai 发布页面和嵌入页面都跳过
const deployedSite = !!document.querySelector('link[rel="manifest"]');
if (
  deployedSite &&
  'serviceWorker' in navigator &&
  (location.protocol === 'https:' || location.hostname === 'localhost') &&
  window.self === window.top
) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* 没有 sw.js（例如单文件版本）时忽略 */
    });
  });
}
