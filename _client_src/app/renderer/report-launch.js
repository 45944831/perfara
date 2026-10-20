'use strict';

/**
 * 设备信息栏内：本地报告路径 +「打开本地报告」。
 * 默认隐藏且按钮置灰；仅在用户点击「停止」结束采集后由 showDeviceReportAfterStop 展示并启用。
 */
(function initReportLaunch() {
  const section = document.getElementById('device-report-section');
  const hint = document.getElementById('report-path-hint');
  const btn = document.getElementById('btn-open-report');
  if (!section || !hint || !btn || !window.perfAPI || typeof window.perfAPI.getReportsPathInfo !== 'function') {
    return;
  }

  function appendToLog(msg) {
    const el = document.getElementById('log-output');
    if (!el) return;
    const line = document.createElement('div');
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  function resetDeviceReportSection() {
    section.hidden = true;
    btn.disabled = true;
    hint.textContent = '…';
    hint.removeAttribute('title');
    hint.classList.remove('report-path--missing');
  }

  async function refreshHint() {
    hint.textContent = '…';
    hint.removeAttribute('title');
    hint.classList.remove('report-path--missing');
    try {
      const info = await window.perfAPI.getReportsPathInfo();
      const dir = info.reportsDir || '';
      hint.textContent = dir;
      hint.title = `${dir}\n默认打开：${info.defaultFile || 'perf.html'}`;
      if (info.defaultExists === false) {
        hint.classList.add('report-path--missing');
        hint.title += '\n（当前 perf.html 不存在，可稍后生成再打开）';
      }
    } catch (e) {
      hint.textContent = '无法读取路径';
      hint.title = e.message || String(e);
    }
  }

  async function showDeviceReportAfterStop() {
    section.hidden = false;
    await refreshHint();
    btn.disabled = false;
  }

  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    try {
      const r = await window.perfAPI.openLocalReport('perf.html');
      if (r && r.ok) return;
      const msg = (r && r.reason) || '打开失败';
      appendToLog(`打开本地报告：${msg}`);
    } catch (e) {
      appendToLog(`打开本地报告：${e.message || e}`);
    }
  });

  window.resetDeviceReportSection = resetDeviceReportSection;
  window.showDeviceReportAfterStop = showDeviceReportAfterStop;
})();

/**
 * 顶栏「报告库」：打开 reports/library.html（历史报告列表 + 多份对比）。
 * 独立成一段，避免上面那段因缺少 device-report-section 提前 return 而失效。
 */
(function initReportLibrary() {
  const btn = document.getElementById('btn-open-library');
  if (!btn || !window.perfAPI || typeof window.perfAPI.openLocalReport !== 'function') return;

  btn.addEventListener('click', async () => {
    const prev = btn.textContent;
    btn.disabled = true;
    try {
      const r = await window.perfAPI.openLocalReport('library.html');
      if (!r || !r.ok) {
        const el = document.getElementById('log-output');
        if (el) {
          const line = document.createElement('div');
          line.className = 'log-error';
          line.textContent = `[${new Date().toLocaleTimeString()}] 打开报告库失败：${(r && r.reason) || '未知错误'}`;
          el.appendChild(line);
          el.scrollTop = el.scrollHeight;
        } else {
          alert(`打开报告库失败：${(r && r.reason) || '未知错误'}`);
        }
      }
    } catch (e) {
      alert(`打开报告库失败：${e.message || e}`);
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  });
})();
