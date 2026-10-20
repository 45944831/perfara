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
    try {
      if (!window.perfAPI || typeof window.perfAPI.getAppName !== 'function') return;
      const r = await window.perfAPI.getAppName();
      if (r && r.appname) setBrand(r.appname);
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
