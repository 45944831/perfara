'use strict';

const inpExePath = document.getElementById('inp-exe-path');
const btnBrowseExe = document.getElementById('btn-browse-exe');
const btnStart = document.getElementById('btn-start');
const startHintEl = document.getElementById('start-hint');
const btnStop = document.getElementById('btn-stop');
const btnExportCsv = document.getElementById('btn-export-csv');
const btnExportJson = document.getElementById('btn-export-json');
const btnTagScene = document.getElementById('btn-tag-scene');
const prepHintEl = document.getElementById('prep-hint');
const statusBadge = document.getElementById('status-badge');
const pidLabel = document.getElementById('pid-label');
const elapsedEl = document.getElementById('elapsed');
const logOutput = document.getElementById('log-output');
const deviceInfoBar = document.getElementById('device-info-bar');
const deviceInfoText = document.getElementById('device-info-text');

const valSysCpu = document.getElementById('val-syscpu');
const valProcCpu = document.getElementById('val-proccpu');
const valMem = document.getElementById('val-mem');
const valFps = document.getElementById('val-fps');
const valJank = document.getElementById('val-jank');
const valJankRate = document.getElementById('val-jankrate');
const valBigJank = document.getElementById('val-bigjank');
const valNet = document.getElementById('val-net');
const valGpu = document.getElementById('val-gpu');
const valBattery = document.getElementById('val-battery');
const valTemp = document.getElementById('val-temp');

let _startHintTimer = null;

/** 当前采集参数配置（勾选项），来自 metric-settings.js，启动采集时透传 */
let _metricConfig = {};

function showStartHint(msg) {
  if (!startHintEl) return;
  startHintEl.textContent = msg;
  startHintEl.hidden = false;
  if (_startHintTimer) clearTimeout(_startHintTimer);
  _startHintTimer = setTimeout(() => {
    startHintEl.hidden = true;
    _startHintTimer = null;
  }, 5000);
}
function hideStartHint() {
  if (_startHintTimer) {
    clearTimeout(_startHintTimer);
    _startHintTimer = null;
  }
  if (startHintEl) {
    startHintEl.hidden = true;
    startHintEl.textContent = '';
  }
}

let isCollecting = false;
let startTime = null;
let elapsedTimer = null;
let _lastExe = '';
/** 已累计采样点数；>0 时「开始」会询问重新采集还是继续采集 */
let _sessionSamples = 0;
let _waitingFirstData = false;

let _sceneTags = [];
let _sceneTagStart = null;
function _syncPcTags() {
  try {
    window.perfAPI.pcSetTags(_sceneTags);
  } catch (_) {}
  try {
    chartMgr.setTags(_sceneTags);
  } catch (_) {}
}
function _resetPcTags() {
  _sceneTags = [];
  _sceneTagStart = null;
  if (btnTagScene) {
    btnTagScene.textContent = '开始标记';
    btnTagScene.disabled = true;
  }
  _syncPcTags();
}
function _getCurXIndex() {
  try {
    return chartMgr.getLastXIndex();
  } catch (_) {
    return -1;
  }
}
if (btnTagScene) {
  btnTagScene.onclick = () => {
    const idx = _getCurXIndex();
    if (idx < 0) {
      log('暂无数据点，无法标记', 'warn');
      return;
    }
    if (_sceneTagStart == null) {
      _sceneTagStart = idx;
      btnTagScene.textContent = '结束标记';
      log(`开始标记：${idx}`, 'info');
      return;
    }
    const start = _sceneTagStart;
    const end = idx;
    _sceneTagStart = null;
    btnTagScene.textContent = '开始标记';
    if (end < start) {
      log(`结束索引(${end})小于开始索引(${start})，已忽略`, 'warn');
      return;
    }
    _sceneTags.push([start, end]);
    _syncPcTags();
    log(`结束标记：${start} → ${end}`, 'info');
  };
}

function showPrepHint(msg) {
  if (!prepHintEl) return;
  prepHintEl.textContent = msg || '准备中…';
  prepHintEl.hidden = false;
  _waitingFirstData = true;
}
function hidePrepHint() {
  if (!prepHintEl) return;
  prepHintEl.hidden = true;
  prepHintEl.textContent = '';
  _waitingFirstData = false;
}

function refreshDeviceInfoBarPc() {
  if (!deviceInfoBar) return;
  const p = inpExePath ? inpExePath.value.trim() : '';
  if (!p) {
    deviceInfoBar.hidden = true;
    if (deviceInfoText) deviceInfoText.textContent = '';
    if (typeof window.resetDeviceReportSection === 'function') window.resetDeviceReportSection();
    return;
  }
  if (typeof window.resetDeviceReportSection === 'function') window.resetDeviceReportSection();
  deviceInfoBar.hidden = false;
  const base = p.split(/[/\\]/).pop() || p;
  if (deviceInfoText) deviceInfoText.textContent = `PC · ${base}`;
}

const chartMgr = new ChartManager();
window.addEventListener('DOMContentLoaded', () => {
  // 先应用采集参数（隐藏被移除指标的卡片/图表），再初始化图表
  _metricConfig = window.MetricSettings.load('pc');
  window.MetricSettings.applyToPage('pc', _metricConfig);
  chartMgr.init();
});

/**
 * 日志面板最多保留的行数。
 * 长时间采集 + adb 反复报错时日志只会 append，DOM 节点无限增长（几千行后
 * 滚动与重排明显变慢）。超过上限时整批砍掉头部，避免每追加一行就删一行。
 */
const MAX_LOG_LINES = 500;

function log(msg, type = '') {
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  if (type) line.className = `log-${type}`;
  logOutput.appendChild(line);
  // 一次性砍到 MAX-50，使节点数稳定在 [450, 500] 区间，减少删除次数
  if (logOutput.childElementCount > MAX_LOG_LINES) {
    const drop = logOutput.childElementCount - MAX_LOG_LINES + 50;
    for (let i = 0; i < drop; i++) {
      const first = logOutput.firstElementChild;
      if (!first) break;
      logOutput.removeChild(first);
    }
  }
  logOutput.scrollTop = logOutput.scrollHeight;
}

document.getElementById('btn-clear-log').onclick = () => {
  logOutput.innerHTML = '';
};

document.getElementById('sel-platform').addEventListener('change', (e) => {
  const map = {
    android: 'index.html',
    iphone: 'iphone.html',
    'iphone-gpu': 'iphone_gpu.html',
  };
  const target = map[e.target.value];
  if (target) window.location.href = target;
});

btnBrowseExe.onclick = async () => {
  try {
    const r = await window.perfAPI.pcPickExe();
    if (r && r.ok && r.path) {
      inpExePath.value = r.path;
      _lastExe = '';
      refreshDeviceInfoBarPc();
      log(`已选择：${r.path}`, 'info');
    }
  } catch (e) {
    log('选择文件失败: ' + e.message, 'error');
  }
};

inpExePath.addEventListener('change', () => {
  _lastExe = '';
  refreshDeviceInfoBarPc();
});

function haltPcCollectOnExeChange() {
  if (!isCollecting) return;
  isCollecting = false;
  clearInterval(elapsedTimer);
  elapsedEl.textContent = '';
  chartMgr.reset();
  resetCards();
  _resetPcTags();
  void window.perfAPI.pcClearHistory().catch(() => {});
  btnStart.disabled = false;
  btnStop.disabled = true;
  if (pidLabel) pidLabel.style.display = 'none';
  statusBadge.textContent = '待机';
  statusBadge.className = 'badge idle';
  hidePrepHint();
  _lastExe = '';
  void window.perfAPI.pcStopCollect().catch(() => {});
}

inpExePath.addEventListener('input', () => {
  if (isCollecting) haltPcCollectOnExeChange();
});

btnStart.onclick = async () => {
  const exe = inpExePath ? inpExePath.value.trim() : '';
  if (!exe) {
    showStartHint('请先浏览选择 .exe');
    return;
  }
  hideStartHint();

  const switched = (exe !== _lastExe);

  // 换 exe：上一轮数据已无意义，直接按「重新采集」。
  // 同一个 exe 且已有数据：让用户明确选择「重新采集」还是「继续采集」。
  let mode = 'fresh';
  if (!switched && _sessionSamples > 0 && typeof window.askStartMode === 'function') {
    mode = await window.askStartMode(_sessionSamples);
    if (!mode) { log('已取消开始采集', 'info'); return; }
  }

  if (mode === 'fresh') {
    try { await window.perfAPI.pcClearHistory(); } catch (_) {}
    chartMgr.reset();
    resetCards();
    _resetPcTags();
    _sessionSamples = 0;
  }
  _lastExe = exe;

  log(`开始 PC 采集（${mode === 'append' ? '继续采集' : '重新采集'}）: ${exe}`, 'info');
  if (typeof window.resetDeviceReportSection === 'function') window.resetDeviceReportSection();
  setCollecting(true);
  showPrepHint('采集准备中，请手工启动应用…');

  try {
    const result = await window.perfAPI.pcStartCollect(exe, _metricConfig);
    if (!result.ok) throw new Error(result.reason);
  } catch (e) {
    log('启动失败: ' + e.message, 'error');
    setCollecting(false);
  }
};

btnStop.onclick = async () => {
  await window.perfAPI.pcStopCollect();
  log('已停止采集', 'warn');
  setCollecting(false);
  if (typeof window.showDeviceReportAfterStop === 'function') {
    await window.showDeviceReportAfterStop();
  }
};

btnExportCsv.onclick = () => exportData('csv');
btnExportJson.onclick = () => exportData('json');

async function exportData(format) {
  const result = await window.perfAPI.pcExportData(format);
  if (result.ok) log(`已导出至: ${result.filePath}`, 'info');
  else log('导出失败: ' + result.reason, 'error');
}

window.perfAPI.onPcPerfData((data) => {
  if (!isCollecting) return;
  if (!data || typeof data !== 'object') return;
  if (_waitingFirstData) {
    _waitingFirstData = false;
    if (prepHintEl) {
      prepHintEl.textContent = '请手工启动应用，否则只有系统指标';
      prepHintEl.hidden = false;
    }
  }
  _sessionSamples += 1;
  try {
    updateCards(data);
  } catch (e) {
    console.error('[pc] updateCards', e);
  }
  try {
    chartMgr.update(data);
  } catch (e) {
    console.error('[pc] chartMgr.update', e);
  }
  if (data.pid && pidLabel) {
    pidLabel.textContent = `PID: ${data.pid}`;
    pidLabel.style.display = '';
  }
  btnExportCsv.disabled = false;
  btnExportJson.disabled = false;
  if (btnTagScene) btnTagScene.disabled = false;
});

window.perfAPI.onPcCollectLog((msg) => log(msg));

window.perfAPI.onPcCollectError((msg) => {
  log('采集错误: ' + msg, 'error');
});

window.perfAPI.onPcCollectStopped((payload) => {
  if (isCollecting) {
    const reason = payload && payload.reason;
    if (reason === 'process_gone') {
      log('目标进程已退出，采集已停止', 'warn');
    } else {
      log('采集已停止', 'warn');
    }
  }
  setCollecting(false);
  statusBadge.textContent = '已停止';
  statusBadge.className = 'badge idle';
});

window.addEventListener('DOMContentLoaded', () => {
  // 采集参数设置按钮（勾选要采的参数，默认全选）
  {
    const btn = document.getElementById('btn-metric-settings');
    if (btn) {
      btn.onclick = () => {
        window.MetricSettings.openDialog('pc', (cfg) => {
          _metricConfig = cfg;
          const off = Object.keys(cfg).filter(k => !cfg[k]);
          log(off.length
            ? `采集参数已更新：已移除 ${off.map(k => (window.MetricSettings.METRIC_GROUPS[k] || {}).label || k).join('、')}（下次采集生效）`
            : '采集参数已更新：全部参数（下次采集生效）', 'info');
        });
      };
    }
  }
});

function setCollecting(v) {
  isCollecting = v;
  btnStart.disabled = v;
  btnStop.disabled = !v;
  statusBadge.textContent = v ? '采集中' : '待机';
  statusBadge.className = 'badge ' + (v ? 'running' : 'idle');
  if (v) {
    startTime = Date.now();
    elapsedTimer = setInterval(updateElapsed, 1000);
    if (btnTagScene) btnTagScene.disabled = false;
  } else {
    clearInterval(elapsedTimer);
    elapsedEl.textContent = '';
    if (pidLabel) pidLabel.style.display = 'none';
    hidePrepHint();
    if (btnTagScene) btnTagScene.disabled = true;
  }
}

function updateElapsed() {
  const s = Math.floor((Date.now() - startTime) / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  elapsedEl.textContent = `${mm}:${ss}`;
}

function resetCards() {
  [
    valSysCpu,
    valProcCpu,
    valMem,
    valFps,
    valJank,
    valBigJank,
    valNet,
    valGpu,
    valBattery,
    valTemp,
  ].forEach((el) => {
    if (el) el.textContent = '--';
  });
  if (valJankRate) valJankRate.textContent = '';
}

function updateCards(d) {
  const cpu = d.cpu || {};
  const mem = d.mem || {};
  const net = d.net || {};
  const bat = d.battery || {};
  const sys = cpu.sysCpu;
  const proc = cpu.procCpu;
  const rss = mem.totalPss;
  const fps = d.fps;
  const jk = d.jank;
  const bjk = d.bigJank;
  const rx = net.rxKBps;
  const tx = net.txKBps;
  const gpu = d.gpu;
  const temp = d.temperature != null ? d.temperature : bat.temperature;

  if (valSysCpu) valSysCpu.textContent = sys != null ? String(sys) : '--';
  if (valProcCpu) valProcCpu.textContent = proc != null ? String(proc) : '--';
  if (valMem) valMem.textContent = rss != null ? String(rss) : '--';
  if (valFps) valFps.textContent = fps != null ? String(fps) : '--';
  // 卡顿分级 PC 侧不做测量：null = 未测量，显示 '--'，不能显示 0（会被读成「零卡顿」）
  if (valJank) valJank.textContent = jk != null ? String(jk) : '--';
  if (valBigJank) valBigJank.textContent = bjk != null ? String(bjk) : '--';
  if (valJankRate) valJankRate.textContent = d.jankRate ? `${d.jankRate}%` : '';
  if (valNet) valNet.textContent = `${rx != null ? rx : '--'} / ${tx != null ? tx : '--'}`;
  if (valGpu) valGpu.textContent = gpu != null ? String(gpu) : '--';
  if (valBattery) valBattery.textContent = bat.level != null ? String(bat.level) : '--';
  if (valTemp) valTemp.textContent = temp != null ? String(temp) : '--';

  colorWarn('card-cpu', Number(sys) || 0, 80, 95);
  colorWarn('card-mem', Number(rss) || 0, 300, 500);
  // 无帧率数据时不做任何着色（旧写法 60-0=60 会被判成「正常」，等于给假 0 背书）
  if (fps != null) colorWarn('card-fps', 60 - Number(fps), 15, 30);
  else colorWarn('card-fps', -Infinity, 15, 30);
  if (jk != null) colorWarn('card-jank', Number(jk), 3, 10);
  else colorWarn('card-jank', -Infinity, 3, 10);
  if (bjk != null) colorWarn('card-bigjank', Number(bjk), 1, 3);
  else colorWarn('card-bigjank', -Infinity, 1, 3);
  colorWarn('card-temp', Number(temp) || 0, 50, 65);
  colorWarn('card-gpu', Number(gpu) || 0, 80, 95);
}

function colorWarn(cardId, value, warnThresh, critThresh) {
  const card = document.getElementById(cardId);
  if (!card) return;
  card.classList.remove('highlight', 'warn', 'critical');
  if (value >= critThresh) card.classList.add('critical');
  else if (value >= warnThresh) card.classList.add('warn');
}

refreshDeviceInfoBarPc();
