'use strict';
/**
 * 顶栏「新版本」提示：纯文字标签，不弹窗、不抢焦点、不自动跳转。
 * 4 个采集页共用；状态来自主进程（启动时静默检查 GitHub Releases）。
 */
(() => {
  function boot() {
    const api = window.perfAPI;
    if (!api || typeof api.getAppUpdate !== 'function') return;
    const right = document.querySelector('.topbar-right');
    if (!right || document.getElementById('btn-app-update')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btn-app-update';
    btn.className = 'update-notice';
    btn.hidden = true;

    const dot = document.createElement('span');
    dot.className = 'update-notice-dot';
    const label = document.createElement('span');
    label.textContent = '新版本';
    btn.appendChild(dot);
    btn.appendChild(label);
    right.insertBefore(btn, right.firstChild);

    function render(info) {
      if (!info || !info.url) {
        btn.hidden = true;
        btn.removeAttribute('title');
        return;
      }
      btn.hidden = false;
      // 标题栏只显示「新版本可用」标记且不能点；这里把当前版本 → 目标版本讲清楚，
      // 并明确它是唯一的跳转入口
      const cur = info.currentVersion
        ? '当前 v' + String(info.currentVersion).replace(/^[vV](?=\d)/, '') + ' · '
        : '';
      btn.title = cur + '发现新版本 ' + String(info.tag || '') + '，点击前往 GitHub 下载页面';
    }

    btn.addEventListener('click', () => {
      if (btn.hidden) return;
      const r = api.openAppUpdate && api.openAppUpdate();
      if (r && typeof r.catch === 'function') r.catch(() => {});
    });

    // 首屏先取缓存；后台检查晚于页面加载时由事件推送补上
    const r = api.getAppUpdate();
    if (r && typeof r.then === 'function') r.then(render).catch(() => {});
    if (typeof api.onAppUpdate === 'function') api.onAppUpdate(render);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
