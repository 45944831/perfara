'use strict';

(function applyAppBrand() {
  function setBrand(appname) {
    if (!appname) return;
    const sel = document.getElementById('sel-platform');
    if (sel && sel.value === 'android') {
      document.title = appname;
    }
  }

  async function run() {
    const api = window.perfAPI;
    if (!api) return;
    // 优先同步主进程生成的完整标题（应用名 + 版本号 + 新版本标记）。
    // 否则这里把 document.title 写成光秃秃的应用名，会把标题栏的版本号冲掉。
    try {
      if (typeof api.getWindowTitle === 'function') {
        const t = await api.getWindowTitle();
        if (t && t.title) { document.title = t.title; return; }
      }
    } catch (_) {}
    // 旧版 preload / 测试 mock 没有该接口时，保持原来的兜底行为
    try {
      if (typeof api.getAppName !== 'function') return;
      const r = await api.getAppName();
      if (r && r.appname) setBrand(r.appname);
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
