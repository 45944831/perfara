'use strict';

/**
 * 日志面板：由 configout/config.js 的 logpannel 控制（true 显示区域；false 整条不显示）。
 * logpannel 为 true 时，勾选状态保存在 localStorage（键 perfandroid.showLogPanel）。
 */
const LS_KEY = 'perfandroid.showLogPanel';

(function initLogPanelToggle() {
  const panel = document.querySelector('.log-panel');
  const chk = document.getElementById('chk-show-log');
  if (!panel || !chk) return;

  function cfgLogPanelEnabled(cfg) {
    if (!cfg || typeof cfg !== 'object') return true;
    const v = cfg.logpannel ?? cfg.logPanel ?? cfg.log_panel;
    if (v === undefined) return true;
    return v === true || v === 1 || String(v).toLowerCase() === 'true';
  }

  async function cfgAllowsLogPanel() {
    try {
      if (window.perfAPI && typeof window.perfAPI.getConfigOut === 'function') {
        const cfg = await window.perfAPI.getConfigOut();
        if (cfgLogPanelEnabled(cfg)) return true;
      }
    } catch (_) {}
    return false;
  }

  function readShowPreference() {
    const v = localStorage.getItem(LS_KEY);
    if (v === null) return true;
    return v !== '0';
  }

  function applyVisible(show) {
    chk.checked = show;
    panel.classList.toggle('log-panel--hidden', !show);
  }

  async function run() {
    const enabled = await cfgAllowsLogPanel();
    panel.classList.toggle('log-panel--config-off', !enabled);
    panel.classList.toggle('log-panel--from-config', enabled);
    if (!enabled) {
      return;
    }

    if (!chk._logPanelBound) {
      chk._logPanelBound = true;
      chk.addEventListener('change', () => {
        localStorage.setItem(LS_KEY, chk.checked ? '1' : '0');
        applyVisible(chk.checked);
      });
    }

    applyVisible(readShowPreference());
  }

  void run();
  try {
    if (window.perfAPI && typeof window.perfAPI.onActivationRefresh === 'function') {
      window.perfAPI.onActivationRefresh(() => void run());
    }
  } catch (_) {}
})();
