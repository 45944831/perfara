'use strict';
// 顶部署名链接：点击交给主进程用系统浏览器打开，避免渲染进程直接导航到外部页面。
(() => {
  const link = document.getElementById('link-attribution');
  if (!link) return;
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const api = window.perfAPI;
    if (api && typeof api.openAttribution === 'function') {
      const r = api.openAttribution();
      if (r && typeof r.catch === 'function') r.catch(() => {});
    }
  });
})();
