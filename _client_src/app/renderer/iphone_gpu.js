'use strict';

// ─── 采集参数配置（默认全选；取消勾选后隐藏对应卡片与曲线、且不采集该组数据） ───
let _metricConfig = {};
function initMetricSettingsUI() {
  if (typeof window.MetricSettings !== 'object' || !window.MetricSettings) return;
  _metricConfig = window.MetricSettings.load('ios_gpu');
  window.MetricSettings.applyToPage('ios_gpu', _metricConfig);
  const btn = document.getElementById('btn-metric-settings');
  if (btn) {
    btn.addEventListener('click', () => {
      window.MetricSettings.openDialog('ios_gpu', cfg => {
        _metricConfig = cfg;
        window.MetricSettings.applyToPage('ios_gpu', cfg);
      });
    });
  }
}

// ─── Platform navigation ──────────────────────────────────────────────────────
document.getElementById('sel-platform').addEventListener('change', e => {
  const map = { android: 'index.html', iphone: 'iphone.html', pc: 'pc.html' };
  const target = map[e.target.value];
  if (target) window.location.href = target;
});

// ─── GPU chart configs ────────────────────────────────────────────────────────
// Metric names come directly from the JSON keys output by collect_ios_gpu.py.
// Each series uses ?? null so missing metrics simply leave gaps without errors.
const GPU_CHART_CONFIGS = {
  occupancy: {
    el: 'chart-occupancy',
    series: [
      { name: 'Vertex',   key: d => d['Vertex Occupancy']   ?? null },
      { name: 'Fragment', key: d => d['Fragment Occupancy'] ?? null },
      { name: 'Compute',  key: d => d['Compute Occupancy']  ?? null },
    ],
    type: 'line', fmt: v => v.toFixed(1) + '%',
  },
  aluPerf: {
    el: 'chart-alu-perf',
    series: [
      { name: 'ALU 利用率', key: d => d['ALU Utilization'] ?? null },
      { name: 'F32',        key: d => d['F32 Utilization'] ?? null },
      { name: 'F16',        key: d => d['F16 Utilization'] ?? null },
      { name: 'ALU 限制器', key: d => d['ALU Limiter']     ?? null },
    ],
    type: 'line', fmt: v => v.toFixed(1) + '%',
  },
  texture: {
    el: 'chart-texture',
    series: [
      { name: '采样利用率',   key: d => d['Texture Sample Utilization']  ?? null },
      { name: '过滤限制器',   key: d => d['Texture Filtering Limiter']   ?? null },
      { name: '采样限制器',   key: d => d['Texture Sample Limiter']      ?? null },
      { name: '缓存限制器',   key: d => d['Texture Cache Limiter']       ?? null },
    ],
    type: 'line', fmt: v => v.toFixed(1) + '%',
  },
  bandwidth: {
    el: 'chart-bandwidth',
    series: [
      { name: '读 GB/s', key: d => d['GPU Read Bandwidth']  ?? null },
      { name: '写 GB/s', key: d => d['GPU Write Bandwidth'] ?? null },
    ],
    type: 'line', fmt: v => v.toFixed(3) + ' GB/s',
  },
  cache: {
    el: 'chart-cache',
    series: [
      { name: 'LLC 利用率', key: d => d['GPU Last Level Cache Utilization'] ?? null },
      { name: 'LLC 限制器', key: d => d['GPU Last Level Cache Limiter']     ?? null },
      { name: 'MMU 利用率', key: d => d['MMU Utilization']                  ?? null },
      { name: 'MMU 限制器', key: d => d['MMU Limiter']                      ?? null },
    ],
    type: 'line', fmt: v => v.toFixed(1) + '%',
  },
  shader: {
    el: 'chart-shader',
    series: [
      { name: '插值限制器', key: d => d['Fragment Input Interpolation Limiter']      ?? null },
      { name: '插值利用率', key: d => d['Fragment Input Interpolation Utilization']  ?? null },
      { name: 'TG加载',     key: d => d['Threadgroup/Imageblock Load Utilization']  ?? null },
      { name: 'TG存储',     key: d => d['Threadgroup/Imageblock Store Utilization'] ?? null },
    ],
    type: 'line', fmt: v => v.toFixed(1) + '%',
  },
};

// Patch ChartManager's CHART_CONFIGS with GPU configs
Object.keys(CHART_CONFIGS).forEach(k => delete CHART_CONFIGS[k]);
Object.assign(CHART_CONFIGS, GPU_CHART_CONFIGS);

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

const valAlu     = document.getElementById('val-alu');
const valFrag    = document.getElementById('val-frag');
const valVert    = document.getElementById('val-vert');
const valTex     = document.getElementById('val-tex');
const valRbw     = document.getElementById('val-rbw');
const valWbw     = document.getElementById('val-wbw');
const valF32     = document.getElementById('val-f32');
const valF16     = document.getElementById('val-f16');
const valLlc     = document.getElementById('val-llc');
const valMmu     = document.getElementById('val-mmu');
const valPartial = document.getElementById('val-partial');

// ─── State ────────────────────────────────────────────────────────────────────
let allApps       = [];
let isCollecting  = false;
let startTime     = null;
let elapsedTimer  = null;
let _activeDevice = '';
let _activeBundle = '';
/** 已累计采样点数；>0 时「开始」会询问重新采集还是继续采集 */
let _sessionSamples = 0;

/** 上一轮最后一条采样（用于时间轴等）；再次开始采集后、首包到达前不改动图表 */
let _lastGpuSample   = null;
/** 新一轮「开始」后、首条 IPC 到来前为 true；首包到达时不清空图表，新点接续在旧曲线之后 */
let _pendingSessionChartsReset = false;
let _lastChartTimeStr = '';

/** 当前批 trim 后的序列；_gpuPlayIndex 之前已上屏，之后待按间隔上屏 */
let _gpuPlayQueue = [];
let _gpuPlayIndex = 0;
let _gpuPlayTimer = null;

/** 图表与数值卡片：每点间隔（毫秒），仅 iOS 16 及以下 GPU 路径使用 */
const GPU_PLAY_MS = 333;
/** iOS17+：待播 N 组在 100s 内均匀播完 → 间隔 = 100/N 秒/组 */
const GPU_IOS17_PLAY_TOTAL_SEC = 100;
/** 待播组数不大于 500 时，在控制台打印「总共多少组」 */
const GPU_IOS17_LOG_GROUPS_MAX = 500;

/** 当前播放间隔（毫秒） */
let _gpuPlayIntervalMs = GPU_PLAY_MS;
/** 最近一次 ios-gpu-start-collect 返回的系统主版本，用于 iOS17+ 策略 */
let _iosGpuMajor = 0;

/** 每批前后各丢弃的条数（头 2 + 尾 2 不参与图表与卡片） */
const GPU_TRIM_HEAD = 2;
const GPU_TRIM_TAIL = 2;

// ─── Scene tagging ────────────────────────────────────────────────────────────
let _sceneTags = [];
let _sceneTagStart = null;
function _syncIosGpuTags() {
  try { window.perfAPI.iosGpuSetTags(_sceneTags); } catch (_) {}
  try { chartMgr.setTags(_sceneTags); } catch (_) {}
}
function _resetIosGpuTags() {
  _sceneTags = [];
  _sceneTagStart = null;
  if (btnTagScene) {
    btnTagScene.textContent = '开始标记';
    btnTagScene.disabled = true;
  }
  _syncIosGpuTags();
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
    _syncIosGpuTags();
    log(`结束标记：${start} → ${end}`, 'info');
  };
}

function trimGpuBatchEdges(batch) {
  if (!batch || batch.length <= GPU_TRIM_HEAD + GPU_TRIM_TAIL) return [];
  return batch.slice(GPU_TRIM_HEAD, batch.length - GPU_TRIM_TAIL);
}

function _clearGpuPlayTimer() {
  if (_gpuPlayTimer) {
    clearInterval(_gpuPlayTimer);
    _gpuPlayTimer = null;
  }
}

function _resetGpuPlayback() {
  _clearGpuPlayTimer();
  _gpuPlayQueue = [];
  _gpuPlayIndex = 0;
  _gpuPlayIntervalMs = GPU_PLAY_MS;
}

function _computeGpuPlayIntervalMs(remaining) {
  if (remaining <= 0) return GPU_PLAY_MS;
  if (_iosGpuMajor < 17) return GPU_PLAY_MS;
  return (GPU_IOS17_PLAY_TOTAL_SEC / remaining) * 1000;
}

function _restartGpuPlaybackTimer() {
  _clearGpuPlayTimer();
  if (_gpuPlayIndex >= _gpuPlayQueue.length) return;
  _gpuPlayTimer = setInterval(() => {
    if (!isCollecting) {
      _clearGpuPlayTimer();
      return;
    }
    if (_gpuPlayIndex >= _gpuPlayQueue.length) {
      _clearGpuPlayTimer();
      return;
    }
    _gpuEmitOnePlayStep();
  }, _gpuPlayIntervalMs);
}

/** 下一批到达或停止时：把当前队列里尚未按间隔画出的点一次性写入图表 */
function _flushRemainingGpuPlayToChart() {
  if (!_gpuPlayQueue.length || _gpuPlayIndex >= _gpuPlayQueue.length) return;
  while (_gpuPlayIndex < _gpuPlayQueue.length) {
    const p = _gpuPlayQueue[_gpuPlayIndex++];
    try { chartMgr.update(p); } catch (_) {}
  }
  const last = _gpuPlayQueue[_gpuPlayQueue.length - 1];
  _lastGpuSample = last;
  if (last.time != null) _lastChartTimeStr = last.time;
  _updateGpuCardsFromSample(last);
}

function _gpuEmitOnePlayStep() {
  if (_gpuPlayIndex >= _gpuPlayQueue.length) return false;
  const p = _gpuPlayQueue[_gpuPlayIndex++];
  try { chartMgr.update(p); } catch (_) {}
  _lastGpuSample = p;
  if (p.time != null) _lastChartTimeStr = p.time;
  _updateGpuCardsFromSample(p);
  return true;
}

/** 新一批开始：先画第一点，余下按 _gpuPlayIntervalMs 画一点 */
function _startGpuPlayback() {
  _clearGpuPlayTimer();
  if (!_gpuPlayQueue.length) return;
  _gpuEmitOnePlayStep();
  if (_gpuPlayIndex >= _gpuPlayQueue.length) return;
  _restartGpuPlaybackTimer();
}

function _flushPendingGpuChartOnStop() {
  _clearGpuPlayTimer();
  _flushRemainingGpuPlayToChart();
  _gpuPlayQueue = [];
  _gpuPlayIndex = 0;
}

function _stopGpuPlaybackImmediately() {
  // 停止即刻生效：不 flush 队列剩余点，避免“停止后还在继续渲染”
  _clearGpuPlayTimer();
  _gpuPlayQueue = [];
  _gpuPlayIndex = 0;
}

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

function showPrepHint() {
  if (!prepHintEl) return;
  prepHintEl.hidden = false;
  prepHintEl.textContent =
    '仅游戏，采集准备中...（GPU数据非实时延迟1-2分钟，其它实时）';
}
function hidePrepHint() {
  if (!prepHintEl) return;
  prepHintEl.hidden = true;
  prepHintEl.textContent = '';
}

let _prepOnceTimer = null;
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
window.addEventListener('DOMContentLoaded', () => {
  initMetricSettingsUI();
  chartMgr.init();
});

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
  void window.perfAPI.iosGpuStopCollect().catch(() => {});
}

selDevice.onchange = () => {
  if (isCollecting) haltCollectOnSwitch();
  if (selDevice.value !== _activeDevice) {
    _activeDevice = '';
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
  if (selBundle.value !== _activeBundle) {
    // 切换应用：清空 reports/shots，避免截图串包
    void window.perfAPI.clearReportShots().catch(() => {});
    _activeBundle = '';
    _clearData();
  }
  scheduleDeviceInfoBar();
};

async function _clearData() {
  _pendingSessionChartsReset = false;
  _lastGpuSample = null;
  _lastChartTimeStr = '';
  _iosGpuMajor = 0;
  _resetGpuPlayback();
  _resetIosGpuTags();
  void window.perfAPI.iosGpuClearHistory().catch(() => {});
  chartMgr.reset();
  [valAlu, valFrag, valVert, valTex, valRbw, valWbw,
   valF32, valF16, valLlc, valMmu, valPartial].forEach(el => { if (el) el.textContent = '--'; });
  btnExportCsv.disabled  = true;
  btnExportJson.disabled = true;
}

// ─── Start / Stop ─────────────────────────────────────────────────────────────
btnStart.onclick = async () => {
  const curDevice = selDevice.value;
  const searchText = _getSearchText();
  const curBundle =
    (selBundle && selBundle.value ? String(selBundle.value).trim() : '') || searchText;

  if (!curDevice) {
    showPrepHintOnce('请先选择设备');
    return;
  }
  if (!curBundle) {
    showPrepHintOnce('请先选择应用或输入包名');
    return;
  }
  hideStartHint();
  if (typeof window.resetDeviceReportSection === 'function') window.resetDeviceReportSection();

  // 换设备/换应用：上一轮数据已无意义，直接按「重新采集」。
  // 同设备同应用且已有数据：让用户明确选择「重新采集」还是「继续采集」。
  let mode = 'fresh';
  if (curDevice === _activeDevice && curBundle === _activeBundle &&
      _sessionSamples > 0 && typeof window.askStartMode === 'function') {
    mode = await window.askStartMode(_sessionSamples);
    if (!mode) { log('已取消开始采集'); return; }
  }

  if (mode === 'fresh') {
    await _clearData();
    _sessionSamples = 0;
  }
  _activeDevice = curDevice;
  _activeBundle = curBundle;

  btnStart.disabled = true;
  btnStop.disabled  = false;
  statusBadge.textContent = '连接中';
  statusBadge.className   = 'badge info';
  isCollecting = true;
  startTime    = Date.now();
  _pendingSessionChartsReset = false;
  showPrepHint();

  elapsedTimer = setInterval(() => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    elapsedEl.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);

  log('开始 GPU 采集…');

  const appEntry = allApps.find(a => a.bundleID === curBundle);
  const nameTrim =
    appEntry && appEntry.name != null ? String(appEntry.name).trim() : '';
  const appName = nameTrim || curBundle;
  const res = await window.perfAPI.iosGpuStartCollect({
    bundleId: curBundle,
    appName,
    udid: curDevice,
    metricConfig: _metricConfig,
  });
  if (!res.ok) {
    log(`启动失败: ${res.reason}`, 'error');
    stopUI();
  } else {
    _iosGpuMajor = typeof res.iosGpuMajor === 'number' ? res.iosGpuMajor : 0;
  }
};

btnStop.onclick = async () => {
  // 先让 UI 立即生效（按钮/状态马上变化），停止采集异步执行
  stopUI();
  log('正在停止…');
  Promise.resolve()
    .then(() => window.perfAPI.iosGpuStopCollect())
    .then(() => log('GPU 采集已停止'))
    .then(async () => {
      if (typeof window.showDeviceReportAfterStop === 'function') {
        await window.showDeviceReportAfterStop();
      }
    })
    .catch(() => {});
};

function stopUI() {
  _stopGpuPlaybackImmediately();
  isCollecting = false;
  _pendingSessionChartsReset = false;
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
  const r = await window.perfAPI.iosGpuExportData('csv');
  log(r.ok ? `已导出: ${r.filePath}` : `导出失败: ${r.reason}`, r.ok ? '' : 'error');
};
btnExportJson.onclick = async () => {
  const r = await window.perfAPI.iosGpuExportData('json');
  log(r.ok ? `已导出: ${r.filePath}` : `导出失败: ${r.reason}`, r.ok ? '' : 'error');
};

// ─── Data handler ─────────────────────────────────────────────────────────────
function _updateGpuCardsFromSample(data) {
  function setVal(el, raw, fmt, cardId, warnAt, critAt) {
    if (raw == null) return;
    el.textContent = fmt(raw);
    if (!cardId) return;
    const card = document.getElementById(cardId);
    if (!card) return;
    const v = parseFloat(fmt(raw));
    card.classList.toggle('warn',     !isNaN(v) && v >= warnAt && v < critAt);
    card.classList.toggle('critical', !isNaN(v) && v >= critAt);
  }

  setVal(valAlu,  data['ALU Utilization'],          v => v.toFixed(1), 'card-alu',  60, 85);
  setVal(valFrag, data['Fragment Occupancy'],        v => v.toFixed(1), 'card-frag', 70, 90);
  setVal(valVert, data['Vertex Occupancy'],          v => v.toFixed(1), 'card-vert', 50, 80);
  setVal(valTex,  data['Texture Sample Limiter'],    v => v.toFixed(1), 'card-tex',  60, 85);

  const rbw = data['GPU Read Bandwidth'];
  const wbw = data['GPU Write Bandwidth'];
  if (rbw != null) valRbw.textContent = rbw.toFixed(3);
  if (wbw != null) valWbw.textContent = wbw.toFixed(3);

  if (data['F32 Utilization']                  != null) valF32.textContent     = data['F32 Utilization'].toFixed(1);
  if (data['F16 Utilization']                  != null) valF16.textContent     = data['F16 Utilization'].toFixed(1);
  if (data['GPU Last Level Cache Utilization'] != null) valLlc.textContent     = data['GPU Last Level Cache Utilization'].toFixed(1);
  if (data['MMU Limiter']                      != null) valMmu.textContent     = data['MMU Limiter'].toFixed(1);
  if (data['Partial Renders Count']            != null) valPartial.textContent = data['Partial Renders Count'];
}

function handleGpuBatch(batch) {
  if (!isCollecting || !Array.isArray(batch) || batch.length === 0) return;

  hidePrepHint();

  const trimmed = trimGpuBatchEdges(batch);
  if (trimmed.length === 0) return;

  // 与 iOS <17 一致：每批 trim 后追加到队列；采集持续下发时与渲染并行（不替换队列）
  const wasEmpty = _gpuPlayQueue.length === 0 || _gpuPlayIndex >= _gpuPlayQueue.length;
  _gpuPlayQueue.push(...trimmed);
  _sessionSamples += trimmed.length;

  const remaining = _gpuPlayQueue.length - _gpuPlayIndex;
  _gpuPlayIntervalMs = _computeGpuPlayIntervalMs(remaining);
  if (_iosGpuMajor >= 17 && remaining > 0 && remaining <= GPU_IOS17_LOG_GROUPS_MAX) {
    console.log(
      `[iOS GPU] 总共 ${remaining} 组，渲染间隔 ${(_gpuPlayIntervalMs / 1000).toFixed(3)} 秒/组（${GPU_IOS17_PLAY_TOTAL_SEC}÷${remaining}，${GPU_IOS17_PLAY_TOTAL_SEC}s 内播完）`
    );
  }

  btnExportCsv.disabled  = false;
  btnExportJson.disabled = false;
  if (btnTagScene) btnTagScene.disabled = false;

  if (statusBadge.className !== 'badge running') {
    statusBadge.textContent = '采集中';
    statusBadge.className   = 'badge running';
  }

  if (wasEmpty) _startGpuPlayback();
  else _restartGpuPlaybackTimer();
}

window.perfAPI.onIosGpuDataBatch(handleGpuBatch);

// ─── Log / Error listeners ────────────────────────────────────────────────────
window.perfAPI.onIosGpuLog(msg => {
  log(`[采集] ${msg}`);
  if (!isCollecting) return;
  if (msg.includes('等待游戏') || msg.includes('仍在等待')) {
    statusBadge.textContent = '等待游戏';
    statusBadge.className   = 'badge waiting';
  } else if (msg.includes('GPU collection started')) {
    statusBadge.textContent = '采集中';
    statusBadge.className   = 'badge running';
  }
});
window.perfAPI.onIosGpuError(msg => {
  log(`错误: ${msg}`, 'error');
  // 不停止采集 — 后端会自动重启采集进程
});

function _flagOn(v) {
  if (v === true || v === 1 || v === '1') return true;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
  return false;
}

async function initContinuousScreenBtnIosGpu() {
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
window.addEventListener('DOMContentLoaded', () => {
  hidePrepHint(); // 确保初始不显示任何红点/文字
  initContinuousScreenBtnIosGpu();
  refreshDevices();
  try {
    window.perfAPI.onTrialBudgetExhausted(async () => {
      if (isCollecting) {
        log('试用时长已用完，请激活后继续使用', 'warn');
        try {
          await window.perfAPI.iosGpuStopCollect();
        } catch (_) {}
        stopUI();
      }
    });
  } catch (_) {}
});
