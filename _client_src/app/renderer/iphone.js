'use strict';

// ─── Platform navigation ──────────────────────────────────────────────────────
document.getElementById('sel-platform').addEventListener('change', e => {
  const map = { android: 'index.html', 'iphone-gpu': 'iphone_gpu.html', pc: 'pc.html' };
  const target = map[e.target.value];
  if (target) window.location.href = target;
});

// ─── iOS-specific chart configs (6 charts) ────────────────────────────────────
// Override CHART_CONFIGS from charts.js with iOS metrics
const IOS_CHART_CONFIGS = {
  cpu: {
    el: 'chart-cpu',
    series: [
      { name: '进程CPU',       key: d => d.cpuUsage    ?? null },
      { name: '系统内核CPU',   key: d => d.cpuTotalSystem ?? null },
      { name: '系统用户CPU',   key: d => d.cpuTotalUser   ?? null },
    ],
    type: 'line', fmt: v => v + '%',
  },
  fps: {
    el: 'chart-fps',
    series: [{ name: 'FPS', key: d => d.fps ?? null }],
    type: 'line', fmt: v => v + ' fps',
  },
  mem: {
    el: 'chart-mem',
    series: [
      { name: '物理内存',   key: d => d.physFootprint   != null ? +(d.physFootprint / 1048576).toFixed(1)   : null },
      { name: 'RSS',        key: d => d.memResidentSize != null ? +(d.memResidentSize / 1048576).toFixed(1) : null },
    ],
    type: 'line', fmt: v => v + ' MB',
  },
  memdetail: {
    el: 'chart-memdetail',
    series: [
      { name: '私有常驻',   key: d => d.memRPrvt      != null ? +(d.memRPrvt      / 1048576).toFixed(1) : null },
      { name: '共享常驻',   key: d => d.memRShrd      != null ? +(d.memRShrd      / 1048576).toFixed(1) : null },
      { name: '匿名',       key: d => d.memAnon       != null ? +(d.memAnon       / 1048576).toFixed(1) : null },
      { name: '压缩',       key: d => d.memCompressed != null ? +(d.memCompressed / 1048576).toFixed(1) : null },
      { name: '可清除',     key: d => d.memPurgeable  != null ? +(d.memPurgeable  / 1048576).toFixed(1) : null },
    ],
    type: 'line', fmt: v => v + ' MB',
  },
  disk: {
    el: 'chart-disk',
    series: [
      { name: '读 KB/s', key: d => d._diskReadKBps  ?? null },
      { name: '写 KB/s', key: d => d._diskWriteKBps ?? null },
    ],
    type: 'line', fmt: v => v + ' KB/s',
  },
  events: {
    el: 'chart-events',
    series: [
      { name: '上下文切换', key: d => d._ctxSwitchPs  ?? null },
      { name: '中断唤醒',   key: d => d._intWakeupsPs ?? null },
      { name: '缺页中断',   key: d => d._vmPageInsPs  ?? null },
    ],
    type: 'line', fmt: v => v,
  },
};

// ─── Patch CHART_CONFIGS so ChartManager uses iOS configs ────────────────────
// ChartManager reads the module-level CHART_CONFIGS — we replace its content
Object.keys(CHART_CONFIGS).forEach(k => delete CHART_CONFIGS[k]);
Object.assign(CHART_CONFIGS, IOS_CHART_CONFIGS);

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const selDevice    = document.getElementById('sel-device');
const selBundle = document.getElementById('sel-bundle');
const inpAppSearch = document.getElementById('inp-app-search');
const appsLoadingEl = document.getElementById('ios-apps-loading');
const btnRefresh   = document.getElementById('btn-refresh');
const btnStart     = document.getElementById('btn-start');
const startHintEl  = document.getElementById('start-hint');
const btnStop      = document.getElementById('btn-stop');
const btnExportCsv = document.getElementById('btn-export-csv');
const btnExportJson= document.getElementById('btn-export-json');
const btnTagScene  = document.getElementById('btn-tag-scene');
const statusBadge  = document.getElementById('status-badge');
const elapsedEl    = document.getElementById('elapsed');
const logOutput    = document.getElementById('log-output');
const deviceInfoBar = document.getElementById('device-info-bar');
const deviceInfoText = document.getElementById('device-info-text');
const prepHintEl   = document.getElementById('prep-hint');

const valFps    = document.getElementById('val-fps');
const valCpu    = document.getElementById('val-cpu');
const valSysCpu = document.getElementById('val-syscpu');
const valMem    = document.getElementById('val-mem');
const valThread = document.getElementById('val-thread');
const valDisk   = document.getElementById('val-disk');
const valStatus = document.getElementById('val-status');
const valPorts  = document.getElementById('val-ports');
const valMsg    = document.getElementById('val-msg');
const valSyscall= document.getElementById('val-syscall');
const valCtx    = document.getElementById('val-ctx');
const valJank    = document.getElementById('val-jank');
const valBigJank = document.getElementById('val-big-jank');
const valStutter = document.getElementById('val-stutter');

let _startHintTimer = null;
function showStartHint(msg) {
  if (!startHintEl) return;
  startHintEl.textContent = msg;
  startHintEl.hidden = false;
  if (_startHintTimer) clearTimeout(_startHintTimer);
  _startHintTimer = setTimeout(() => {
    startHintEl.hidden = true;
    startHintEl.textContent = '';
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

// ─── State ────────────────────────────────────────────────────────────────────
let allApps      = [];
let isCollecting = false;
let startTime    = null;
let elapsedTimer = null;

// Track active device/app to detect changes that warrant a data reset
let _activeDevice = '';
let _activeBundle = '';
/** 已累计采样点数；>0 时「开始」会询问重新采集还是继续采集 */
let _sessionSamples = 0;

// Delta accumulators for cumulative counters
let _prevDisk    = null;
let _prevEvents  = null;
let _prevMsg     = null;
let _waitingFirstData = false;
let _prepOnceTimer = null;

// ─── Scene tagging ────────────────────────────────────────────────────────────
let _sceneTags = [];
let _sceneTagStart = null;
function _syncIosTags() {
  try { window.perfAPI.iosSetTags(_sceneTags); } catch (_) {}
  try { chartMgr.setTags(_sceneTags); } catch (_) {}
}
function _resetIosTags() {
  _sceneTags = [];
  _sceneTagStart = null;
  if (btnTagScene) {
    btnTagScene.textContent = '开始标记';
    btnTagScene.disabled = true;
  }
  _syncIosTags();
}
function _getCurXIndex() {
  try { return chartMgr.getLastXIndex(); } catch (_) { return -1; }
}
if (btnTagScene) {
  btnTagScene.onclick = () => {
    const idx = _getCurXIndex();
    if (idx < 0) { log('暂无数据点，无法标记', 'warn'); return; }
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
    _syncIosTags();
    log(`结束标记：${start} → ${end}`, 'info');
  };
}

function showPrepHint() {
  if (!prepHintEl) return;
  prepHintEl.hidden = false;
  prepHintEl.textContent = '请手动启动应用，采集准备中，请稍后';
}
function hidePrepHint() {
  if (!prepHintEl) return;
  prepHintEl.hidden = true;
  prepHintEl.textContent = '';
}

function showPrepHintOnce(msg) {
  if (!prepHintEl) return;
  if (_prepOnceTimer) { clearTimeout(_prepOnceTimer); _prepOnceTimer = null; }
  prepHintEl.hidden = false;
  prepHintEl.textContent = msg || '';
  _prepOnceTimer = setTimeout(() => {
    _prepOnceTimer = null;
    hidePrepHint();
  }, 5000);
}

let _deviceInfoTimer = null;
async function refreshDeviceInfoBar() {
  if (!deviceInfoBar) return;
  const udid = selDevice.value;
  if (!udid) {
    deviceInfoBar.hidden = true;
    if (deviceInfoText) deviceInfoText.textContent = '';
    if (typeof window.resetDeviceReportSection === 'function') window.resetDeviceReportSection();
    return;
  }
  if (typeof window.resetDeviceReportSection === 'function') window.resetDeviceReportSection();
  deviceInfoBar.hidden = false;
  if (deviceInfoText) deviceInfoText.textContent = '加载设备信息…';
  try {
    const info = await window.perfAPI.getIosDeviceInfo(udid);
    const text = typeof formatDeviceInfoText === 'function' ? formatDeviceInfoText(info) : '';
    if (!text) {
      deviceInfoBar.hidden = true;
      if (deviceInfoText) deviceInfoText.textContent = '';
      if (typeof window.resetDeviceReportSection === 'function') window.resetDeviceReportSection();
      return;
    }
    if (deviceInfoText) deviceInfoText.textContent = text;
    deviceInfoBar.hidden = false;
  } catch (_) {
    deviceInfoBar.hidden = true;
    if (deviceInfoText) deviceInfoText.textContent = '';
    if (typeof window.resetDeviceReportSection === 'function') window.resetDeviceReportSection();
  }
}
function scheduleDeviceInfoBar() {
  if (_deviceInfoTimer) clearTimeout(_deviceInfoTimer);
  _deviceInfoTimer = setTimeout(() => {
    _deviceInfoTimer = null;
    refreshDeviceInfoBar();
  }, 350);
}

// ─── Charts ───────────────────────────────────────────────────────────────────
const chartMgr = new ChartManager();
window.addEventListener('DOMContentLoaded', () => chartMgr.init());

// ─── Logging ──────────────────────────────────────────────────────────────────
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

document.getElementById('btn-clear-log').onclick = () => { logOutput.innerHTML = ''; };

// ─── Device refresh ───────────────────────────────────────────────────────────
async function refreshDevices() {
  log('扫描 iOS 设备…');
  try {
    const devices = await window.perfAPI.iosGetDevices();
    selDevice.innerHTML = '<option value="">-- 选择设备 --</option>';
    if (!devices || devices.length === 0) {
      log('未检测到 iOS 设备，请确认 USB 已连接且受信任', 'warn');
      return;
    }
    for (const d of devices) {
      const opt = document.createElement('option');
      opt.value = d.udid;
      opt.textContent = d.name || 'iOS 设备';
      opt.title = d.udid;
      selDevice.appendChild(opt);
    }
    if (devices.length === 1) {
      selDevice.value = devices[0].udid;
      loadApps();
    }
    log(`发现 ${devices.length} 台设备`);
  } catch (e) {
    log(`设备扫描失败: ${e.message}`, 'error');
  }
}

async function loadApps() {
  if (appsLoadingEl) appsLoadingEl.hidden = false;
  if (selBundle) selBundle.disabled = true;
  log('读取已安装应用列表…');
  try {
    const apps = await window.perfAPI.iosGetApps();
    allApps = apps || [];
    renderAppList(allApps);
    log(`已加载 ${allApps.length} 个应用`);
    scheduleDeviceInfoBar();
  } catch (e) {
    log(`应用列表加载失败: ${e.message}`, 'warn');
  } finally {
    if (appsLoadingEl) appsLoadingEl.hidden = true;
    if (selBundle) selBundle.disabled = false;
  }
}

function _getSearchText() {
  return inpAppSearch && inpAppSearch.value != null ? String(inpAppSearch.value).trim() : '';
}

function _filterAppsForSearch(apps, q) {
  const query = String(q || '').trim().toLowerCase();
  if (!query) return apps || [];
  const arr = Array.isArray(apps) ? apps : [];
  return arr.filter((a) => {
    const bid = a && a.bundleID != null ? String(a.bundleID).trim().toLowerCase() : '';
    const n = a && a.name != null ? String(a.name).trim().toLowerCase() : '';
    return (bid && bid.includes(query)) || (n && n.includes(query));
  });
}

function renderAppList(apps) {
  selBundle.innerHTML = '<option value="">-- 选择应用 --</option>';
  const q = _getSearchText();
  const filtered = _filterAppsForSearch(apps, q);
  for (const a of filtered) {
    if (!a.bundleID) continue;
    const bid = String(a.bundleID).trim();
    if (!bid) continue;
    const n = a.name != null ? String(a.name).trim() : '';
    const opt = document.createElement('option');
    opt.value = bid;
    opt.textContent = n ? `${n} (${bid})` : bid;
    selBundle.appendChild(opt);
  }
  if (q && filtered.length === 0) {
    const opt = document.createElement('option');
    opt.value = q;
    opt.textContent = `手动输入: ${q}`;
    selBundle.appendChild(opt);
    selBundle.value = q;
  }
}

btnRefresh.onclick = refreshDevices;

if (inpAppSearch) {
  inpAppSearch.addEventListener('input', () => {
    renderAppList(allApps);
    scheduleDeviceInfoBar();
  });
}

/** 采集中切换设备/应用：立即停止渲染、清空图表与内存缓存，并停止采集进程 */
function haltCollectOnSwitch() {
  if (!isCollecting) return;
  stopUI();
  _activeDevice = '';
  _activeBundle = '';
  _clearData();
  void window.perfAPI.iosStopCollect().catch(() => {});
}

selDevice.onchange = () => {
  if (isCollecting) haltCollectOnSwitch();
  if (selDevice.value !== _activeDevice) {
    _activeDevice = '';  // will be set on next Start
    _activeBundle = '';
    _clearData();
  }
  if (selDevice.value) {
    scheduleDeviceInfoBar();
    loadApps();
  } else {
    if (appsLoadingEl) appsLoadingEl.hidden = true;
    if (selBundle) selBundle.disabled = false;
    scheduleDeviceInfoBar();
  }
};

selBundle.onchange = () => {
  if (isCollecting) haltCollectOnSwitch();
  if (selBundle.value && selBundle.value !== _activeBundle) {
    // 切换应用：清空 reports/shots，避免截图串包
    void window.perfAPI.clearReportShots().catch(() => {});
    _activeBundle = '';
    _clearData();
  }
  scheduleDeviceInfoBar();
};

async function _clearData() {
  try { await window.perfAPI.iosClearHistory(); } catch (_) {}
  chartMgr.reset();
  _resetIosTags();
  _prevDisk = null; _prevEvents = null; _prevMsg = null;
  [valFps, valCpu, valSysCpu, valMem, valThread, valDisk,
   valStatus, valPorts, valMsg, valSyscall, valCtx,
   valJank, valBigJank, valStutter].forEach(el => { if (el) el.textContent = '--'; });
  btnExportCsv.disabled  = true;
  btnExportJson.disabled = true;
}

// ─── Start / Stop ─────────────────────────────────────────────────────────────
btnStart.onclick = async () => {
  if (!selDevice.value) {
    showPrepHintOnce('请先选择设备');
    return;
  }
  const searchText = _getSearchText();
  const bundleId = (selBundle && selBundle.value ? String(selBundle.value).trim() : '') || searchText;
  if (!bundleId) {
    showPrepHintOnce('请先选择应用或输入包名');
    return;
  }
  hideStartHint();
  if (typeof window.resetDeviceReportSection === 'function') window.resetDeviceReportSection();

  // Find execName from allApps (CFBundleExecutable)
  const appEntry = allApps.find(a => a.bundleID === bundleId);
  const execName = (appEntry && appEntry.execName) || '';

  // 换设备/换应用：上一轮数据已无意义，直接按「重新采集」。
  // 同设备同应用且已有数据：让用户明确选择「重新采集」还是「继续采集」。
  let mode = 'fresh';
  if (curDevice === _activeDevice && bundleId === _activeBundle &&
      _sessionSamples > 0 && typeof window.askStartMode === 'function') {
    mode = await window.askStartMode(_sessionSamples);
    if (!mode) { log('已取消开始采集'); return; }
  }

  if (mode === 'fresh') {
    await _clearData();
    _sessionSamples = 0;
  }
  _activeDevice = curDevice;
  _activeBundle = bundleId;

  btnStart.disabled = true;
  btnStop.disabled  = false;
  statusBadge.textContent = '采集中';
  statusBadge.className   = 'badge running';
  isCollecting = true;
  _waitingFirstData = true;
  showPrepHint();
  startTime    = Date.now();
  _prevDisk    = null;
  _prevEvents  = null;
  _prevMsg     = null;

  elapsedTimer = setInterval(() => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    elapsedEl.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);

  log(`开始采集: ${bundleId}${execName ? ' (exec: ' + execName + ')' : ''}`);

  const nameTrim =
    appEntry && appEntry.name != null ? String(appEntry.name).trim() : '';
  const appName = nameTrim || bundleId;
  const res = await window.perfAPI.iosStartCollect(bundleId, execName, appName, selDevice.value, _metricConfig);
  if (!res.ok) {
    log(`启动失败: ${res.reason}`, 'error');
    stopUI();
  }
};

btnStop.onclick = async () => {
  // 先让 UI 立即生效（按钮/状态马上变化），停止采集异步执行
  stopUI();
  log('正在停止…');
  Promise.resolve()
    .then(() => window.perfAPI.iosStopCollect())
    .then(() => log('采集已停止'))
    .then(async () => {
      if (typeof window.showDeviceReportAfterStop === 'function') {
        await window.showDeviceReportAfterStop();
      }
    })
    .catch(() => {});
};

function stopUI() {
  isCollecting = false;
  _waitingFirstData = false;
  hidePrepHint();
  btnStart.disabled = false;
  btnStop.disabled  = true;
  statusBadge.textContent = '待机';
  statusBadge.className   = 'badge idle';
  clearInterval(elapsedTimer);
  elapsedEl.textContent = '';
  if (btnTagScene) btnTagScene.disabled = true;
}

// ─── Export ───────────────────────────────────────────────────────────────────
btnExportCsv.onclick  = async () => {
  const r = await window.perfAPI.iosExportData('csv');
  log(r.ok ? `已导出: ${r.filePath}` : `导出失败: ${r.reason}`, r.ok ? '' : 'error');
};
btnExportJson.onclick = async () => {
  const r = await window.perfAPI.iosExportData('json');
  log(r.ok ? `已导出: ${r.filePath}` : `导出失败: ${r.reason}`, r.ok ? '' : 'error');
};

// ─── Data handler ─────────────────────────────────────────────────────────────
window.perfAPI.onIosPerfData(data => {
  if (!isCollecting) return;

  if (_waitingFirstData) {
    _waitingFirstData = false;
    hidePrepHint();
  }

  // Enable export buttons once data arrives
  btnExportCsv.disabled  = false;
  btnExportJson.disabled = false;
  if (btnTagScene) btnTagScene.disabled = false;

  // ── Compute delta fields ────────────────────────────────────────────────────
  const now = data;

  // Disk KB/s
  if (_prevDisk && now.diskBytesRead != null && now.diskBytesWritten != null) {
    now._diskReadKBps  = Math.max(0, Math.round((now.diskBytesRead  - _prevDisk.r) / 1024));
    now._diskWriteKBps = Math.max(0, Math.round((now.diskBytesWritten - _prevDisk.w) / 1024));
  } else {
    now._diskReadKBps  = 0;
    now._diskWriteKBps = 0;
  }
  if (now.diskBytesRead != null) _prevDisk = { r: now.diskBytesRead, w: now.diskBytesWritten || 0 };

  // System events /s
  if (_prevEvents && now.ctxSwitch != null) {
    now._ctxSwitchPs  = Math.max(0, (now.ctxSwitch  - _prevEvents.ctx) | 0);
    now._intWakeupsPs = Math.max(0, (now.intWakeups  - _prevEvents.int) | 0);
    now._vmPageInsPs  = Math.max(0, (now.vmPageIns   - _prevEvents.pg)  | 0);
  } else {
    now._ctxSwitchPs = now._intWakeupsPs = now._vmPageInsPs = 0;
  }
  if (now.ctxSwitch != null) _prevEvents = { ctx: now.ctxSwitch, int: now.intWakeups || 0, pg: now.vmPageIns || 0 };

  // Messages /s
  let msgSentPs = 0, msgRecvPs = 0, sysCallPs = 0;
  if (_prevMsg && now.msgSent != null) {
    msgSentPs  = Math.max(0, (now.msgSent     - _prevMsg.s) | 0);
    msgRecvPs  = Math.max(0, (now.msgRecv     - _prevMsg.r) | 0);
    sysCallPs  = Math.max(0, (now.sysCallsMach - _prevMsg.sc)| 0);
  }
  if (now.msgSent != null) _prevMsg = { s: now.msgSent, r: now.msgRecv || 0, sc: now.sysCallsMach || 0 };

  // ── Update stat cards ───────────────────────────────────────────────────────
  function fmtVal(v, digits = 1) { return v != null ? (digits === 0 ? String(v | 0) : (+v).toFixed(digits)) : '--'; }

  setCard(valFps,    data.fps,         v => (v | 0),                 'card-fps',    60, 40);
  setCard(valCpu,    data.cpuUsage,    v => (+v).toFixed(1),         'card-cpu',    50, 80);
  setCard(valSysCpu, data.cpuTotalSystem != null ? data.cpuTotalSystem + (data.cpuTotalUser || 0) : null,
                                       v => v.toFixed(1),            'card-syscpu', 60, 85);
  setCard(valMem,    data.physFootprint, v => (v / 1048576).toFixed(0), 'card-mem', 300, 500);
  if (data.threadCount != null) valThread.textContent = data.threadCount;
  if (data.diskBytesRead != null) valDisk.textContent = now._diskReadKBps;

  // Info cards
  if (data.procStatus != null) valStatus.textContent = _procStatusLabel(data.procStatus);
  if (data.machPortCount != null) valPorts.textContent = data.machPortCount;
  if (now.msgSent     != null) valMsg.textContent    = `${msgSentPs}/${msgRecvPs}`;
  if (now.sysCallsMach!= null) valSyscall.textContent= sysCallPs;
  if (now.ctxSwitch   != null) valCtx.textContent    = now._ctxSwitchPs;
  if (data.jank     != null) { valJank.textContent    = data.jank;     setCardHighlight('card-jank',     data.jank > 0); }
  if (data.big_jank != null) { valBigJank.textContent = data.big_jank; setCardHighlight('card-big-jank', data.big_jank > 0); }
  if (data.stutter  != null) { valStutter.textContent = data.stutter.toFixed(4); setCardHighlight('card-stutter', data.stutter > 0.05); }

  // ── Update charts ───────────────────────────────────────────────────────────
  _sessionSamples += 1;
  try { chartMgr.update(now); } catch (_) {}
});

function setCard(el, raw, fmt, cardId, warnAt, critAt) {
  if (raw == null) return;
  el.textContent = fmt(raw);
  const card = document.getElementById(cardId);
  if (!card) return;
  const v = +fmt(raw);
  card.classList.toggle('highlight', false);
  card.classList.toggle('warn',     v >= warnAt && v < critAt);
  card.classList.toggle('critical', v >= critAt);
}

function setCardHighlight(cardId, active) {
  const card = document.getElementById(cardId);
  if (!card) return;
  card.classList.toggle('warn', active);
}

function _procStatusLabel(s) {
  const map = { 1: '前台', 2: '后台', 3: '挂起', 4: '终止' };
  return map[s] || String(s);
}

// ─── Log / Error listeners ────────────────────────────────────────────────────
window.perfAPI.onIosLog(msg => log(`[采集] ${msg}`));
window.perfAPI.onIosError(msg => {
  log(`错误: ${msg}`, 'error');
  if (isCollecting) stopUI();
});

if (typeof window.perfAPI.onIosCollectStopped === 'function') {
  window.perfAPI.onIosCollectStopped(payload => {
    if (payload && payload.reason === 'sysmon-missing') {
      log('未匹配到目标进程（{"code":0}），采集已停止', 'error');
      stopUI();
    }
  });
}

function _flagOn(v) {
  if (v === true || v === 1 || v === '1') return true;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
  return false;
}

async function initContinuousScreenBtnIos() {
  const btn = document.getElementById('btn-screen-continuous');
  if (!btn) return;
  btn.hidden = true;
  try {
    const cfg = await window.perfAPI.getConfigOut();
    const u = cfg && (cfg.upload || cfg);
    if (_flagOn(u && u['iosscreen-tag'])) btn.hidden = false;
  } catch (_) {}
  btn.onclick = () => log('连续截图功能开发中…');
}

// ─── Init ─────────────────────────────────────────────────────────────────────
const _metricPlatform = 'ios';
let _metricConfig = {};

function initMetricSettingsUI() {
  _metricConfig = window.MetricSettings.load(_metricPlatform);
  window.MetricSettings.applyToPage(_metricPlatform, _metricConfig);
  const btn = document.getElementById('btn-metric-settings');
  if (btn) {
    btn.onclick = () => {
      window.MetricSettings.openDialog(_metricPlatform, (cfg) => {
        _metricConfig = cfg;
        const off = Object.keys(cfg).filter(k => !cfg[k]);
        log(off.length
          ? `采集参数已更新：已移除 ${off.map(k => (window.MetricSettings.METRIC_GROUPS[k] || {}).label || k).join('、')}（下次采集生效）`
          : '采集参数已更新：全部参数（下次采集生效）', 'info');
      });
    };
  }
}

window.addEventListener('DOMContentLoaded', () => {
  hidePrepHint(); // 确保初始不显示任何红点/文字
  initContinuousScreenBtnIos();
  initMetricSettingsUI();
  refreshDevices();
  try {
    window.perfAPI.onTrialBudgetExhausted(async () => {
      if (isCollecting) {
        log('试用时长已用完，请激活后继续使用', 'warn');
        try {
          await window.perfAPI.iosStopCollect();
        } catch (_) {}
        stopUI();
      }
    });
  } catch (_) {}
});
