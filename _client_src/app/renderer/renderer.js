'use strict';

// ─── DOM refs ────────────────────────────────────────────────────────────────
const selDevice    = document.getElementById('sel-device');
const selApp = document.getElementById('sel-app');
const btnRefresh   = document.getElementById('btn-refresh');
const btnStart     = document.getElementById('btn-start');
const startHintEl  = document.getElementById('start-hint');
const btnStop      = document.getElementById('btn-stop');
const btnExportCsv = document.getElementById('btn-export-csv');
const btnExportJson= document.getElementById('btn-export-json');
const btnTagScene  = document.getElementById('btn-tag-scene');
const prepHintEl   = document.getElementById('prep-hint');
const statusBadge  = document.getElementById('status-badge');
const pidLabel     = document.getElementById('pid-label');
const elapsedEl    = document.getElementById('elapsed');
const logOutput    = document.getElementById('log-output');
const deviceInfoBar = document.getElementById('device-info-bar');
const deviceInfoText = document.getElementById('device-info-text');
const fpsWarnBar = document.getElementById('fps-warn-bar');
const fpsWarnText = document.getElementById('fps-warn-text');

const valSysCpu  = document.getElementById('val-syscpu');
const valProcCpu = document.getElementById('val-proccpu');
const valMem     = document.getElementById('val-mem');
const valFps     = document.getElementById('val-fps');
const valJank    = document.getElementById('val-jank');
const valJankRate= document.getElementById('val-jankrate');
const valBigJank = document.getElementById('val-bigjank');
const valNet    = document.getElementById('val-net');
const valGpu    = document.getElementById('val-gpu');
const valBattery= document.getElementById('val-battery');
const valTemp   = document.getElementById('val-temp');

let _startHintTimer = null;
function showStartHint(msg, durationMs) {
  if (!startHintEl) return;
  startHintEl.textContent = msg;
  startHintEl.hidden = false;
  if (_startHintTimer) clearTimeout(_startHintTimer);
  _startHintTimer = setTimeout(() => {
    startHintEl.hidden = true;
    startHintEl.textContent = '';
    _startHintTimer = null;
  }, durationMs || 5000);
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

// ─── State ───────────────────────────────────────────────────────────────────
let allPackages = [];
let isCollecting = false;
let startTime = null;
let elapsedTimer = null;
let _lastDevice = null;
let _lastPkg = null;
/** 当前设备/应用下已累计的采样点数；>0 时「开始」会询问重新采集还是继续采集 */
let _sessionSamples = 0;
let _deviceInfoTimer = null;
let _waitingFirstData = false;

// ─── Scene tagging ────────────────────────────────────────────────────────────
let _sceneTags = [];
let _sceneTagStart = null;
function _syncAndroidTags() {
  try { window.perfAPI.setTags('android', _sceneTags); } catch (_) {}
  try { chartMgr.setTags(_sceneTags); } catch (_) {}
}
function _resetAndroidTags() {
  _sceneTags = [];
  _sceneTagStart = null;
  if (btnTagScene) {
    btnTagScene.textContent = '开始标记';
    btnTagScene.disabled = true;
  }
  _syncAndroidTags();
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
    _syncAndroidTags();
    log(`结束标记：${start} → ${end}`, 'info');
  };
}

function showPrepHint(msg) {
  if (!prepHintEl) return;
  prepHintEl.textContent = msg || '采集准备中，请稍后';
  prepHintEl.hidden = false;
  _waitingFirstData = true;
}
function hidePrepHint() {
  if (!prepHintEl) return;
  prepHintEl.hidden = true;
  prepHintEl.textContent = '';
  _waitingFirstData = false;
}

async function refreshDeviceInfoBar() {
  if (!deviceInfoBar) return;
  const deviceId = selDevice.value;
  const pkg = selApp ? selApp.value.trim() : '';
  if (!deviceId || !pkg) {
    deviceInfoBar.hidden = true;
    if (deviceInfoText) deviceInfoText.textContent = '';
    if (typeof window.resetDeviceReportSection === 'function') window.resetDeviceReportSection();
    return;
  }
  if (typeof window.resetDeviceReportSection === 'function') window.resetDeviceReportSection();
  deviceInfoBar.hidden = false;
  if (deviceInfoText) deviceInfoText.textContent = '加载设备信息…';
  try {
    const info = await window.perfAPI.getAndroidDeviceInfo(deviceId);
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

// ─── Charts ──────────────────────────────────────────────────────────────────
const chartMgr = new ChartManager();
window.addEventListener('DOMContentLoaded', () => chartMgr.init());

function _flagOn(v) {
  if (v === true || v === 1 || v === '1') return true;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
  return false;
}

async function initContinuousScreenBtnAndroid() {
  const btn = document.getElementById('btn-screen-continuous');
  if (!btn) return;
  btn.hidden = true;
  try {
    const cfg = await window.perfAPI.getConfigOut();
    const u = cfg && (cfg.upload || cfg);
    if (_flagOn(u && u.screentag)) btn.hidden = false;
  } catch (_) {}
  btn.onclick = () => log('连续截图功能开发中…', 'info');
}

// ─── Logging ─────────────────────────────────────────────────────────────────
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

// ─── Platform selector navigation ────────────────────────────────────────────
document.getElementById('sel-platform').addEventListener('change', e => {
  const map = { iphone: 'iphone.html', 'iphone-gpu': 'iphone_gpu.html', pc: 'pc.html' };
  const target = map[e.target.value];
  if (target) window.location.href = target;
});

// ─── 采集参数设置（勾选要采的参数，默认全选）────────────────────────────────────
const _metricPlatform = 'android';
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
  initContinuousScreenBtnAndroid();
  initMetricSettingsUI();
  try {
    window.perfAPI.onTrialBudgetExhausted(async () => {
      if (isCollecting) {
        log('试用时长已用完，请激活后继续使用', 'warn');
        try {
          await window.perfAPI.stopCollect();
        } catch (_) {}
        setCollecting(false);
      }
    });
  } catch (_) {}
});

// ─── Device refresh ──────────────────────────────────────────────────────────
async function refreshDevices() {
  log('正在扫描设备...');
  try {
    const devices = await window.perfAPI.getDevices();
    selDevice.innerHTML = '<option value="">-- 选择设备 --</option>';
    if (devices.length === 0) {
      log('未检测到设备，请确认 USB 调试已开启', 'warn');
      return;
    }
    for (const d of devices) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.displayName || d.model || d.id;
      opt.title = d.id;
      selDevice.appendChild(opt);
    }
    if (devices.length === 1) {
      selDevice.value = devices[0].id;
      await loadPackages(devices[0].id);
    }
    log(`检测到 ${devices.length} 台设备`, 'info');
  } catch (e) {
    log('扫描设备失败: ' + e.message, 'error');
  }
}

// ─── Package loading（纯 USB/adb 读取，不安装任何 APK）───────────────────────
async function loadPackages(deviceId) {
  if (!deviceId) return;
  log(`正在加载 ${deviceId} 的应用列表...`);
  if (selApp) {
    selApp.disabled = true;
    selApp.innerHTML = '<option value="">加载中…</option>';
  }
  try {
    const packages = await window.perfAPI.getPackages(deviceId);
    allPackages = Array.isArray(packages) ? packages : [];
    if (selApp) {
      selApp.innerHTML = '<option value="">-- 选择应用 --</option>';
      for (const p of allPackages) {
        const opt = document.createElement('option');
        opt.value = p.pkg;
        opt.textContent =
          p.label && p.label !== p.pkg ? `${p.label} (${p.pkg})` : p.pkg;
        selApp.appendChild(opt);
      }
      selApp.disabled = false;
    }
    log(`加载完成（第三方应用列表），共 ${allPackages.length} 个应用`, 'info');
    scheduleDeviceInfoBar();
  } catch (e) {
    log('加载应用列表失败: ' + e.message, 'error');
    if (selApp) {
      selApp.innerHTML = '<option value="">-- 选择应用 --</option>';
      selApp.disabled = false;
    }
  }
}

// ─── Wireless connect ─────────────────────────────────────────────────────────
const btnWifiToggle      = document.getElementById('btn-wifi-toggle');
const wifiGroup          = document.getElementById('wifi-group');
const wifiIpInput        = document.getElementById('wifi-ip');
const btnWifiConnect     = document.getElementById('btn-wifi-connect');
const btnWifiDisconnect  = document.getElementById('btn-wifi-disconnect');

btnWifiToggle.onclick = async () => {
  // First try auto-connect using the currently selected USB device
  const deviceId = selDevice.value;
  if (deviceId && !deviceId.includes(':')) {
    log(`正在自动获取设备 IP 并连接无线...`);
    const result = await window.perfAPI.autoConnectWifi(deviceId);
    if (result.ok) {
      log(`无线自动连接成功: ${result.msg}`, 'info');
      wifiGroup.style.display = 'none';
      await refreshDevices();
      return;
    }
    log(`自动连接失败 (${result.msg})，请手动输入 IP`, 'warn');
  }
  // Fall back to manual input
  const hidden = wifiGroup.style.display === 'none';
  wifiGroup.style.display = hidden ? '' : 'none';
  if (hidden) wifiIpInput.focus();
};

btnWifiConnect.onclick = async () => {
  const ipPort = wifiIpInput.value.trim();
  if (!ipPort) { log('请输入设备 IP:PORT', 'warn'); return; }
  log(`正在连接 ${ipPort} ...`);
  const result = await window.perfAPI.connectWifi(ipPort);
  if (result.ok) {
    log(`无线连接成功: ${result.msg}`, 'info');
    wifiGroup.style.display = 'none';
    await refreshDevices();
  } else {
    log(`无线连接失败: ${result.msg}`, 'error');
  }
};

btnWifiDisconnect.onclick = async () => {
  const ipPort = wifiIpInput.value.trim() || selDevice.value;
  if (!ipPort) { log('请输入要断开的设备 IP:PORT', 'warn'); return; }
  await window.perfAPI.disconnectWifi(ipPort);
  log(`已断开 ${ipPort}`, 'warn');
  await refreshDevices();
};

wifiIpInput.onkeydown = (e) => { if (e.key === 'Enter') btnWifiConnect.click(); };

// ─── Event handlers ───────────────────────────────────────────────────────────
btnRefresh.onclick = refreshDevices;

/** 采集中切换设备/应用：立即停止渲染、清空图表与内存缓存，并停止采集 */
function haltAndroidCollectOnSwitch() {
  if (!isCollecting) return;
  isCollecting = false;
  clearInterval(elapsedTimer);
  elapsedEl.textContent = '';
  chartMgr.reset();
  resetCards();
  _resetAndroidTags();
  _sessionSamples = 0;
  void window.perfAPI.androidClearHistory().catch(() => {});
  btnStart.disabled = false;
  btnStop.disabled = true;
  if (pidLabel) pidLabel.style.display = 'none';
  statusBadge.textContent = '待机';
  statusBadge.className = 'badge idle';
  hidePrepHint();
  _lastDevice = null;
  _lastPkg = null;
  void window.perfAPI.stopCollect().catch(() => {});
}

selDevice.onchange = () => {
  if (isCollecting) haltAndroidCollectOnSwitch();
  if (selDevice.value) loadPackages(selDevice.value);
  else {
    if (selApp) {
      selApp.innerHTML = '<option value="">-- 选择应用 --</option>';
      allPackages = [];
    }
    scheduleDeviceInfoBar();
  }
};

if (selApp) {
  selApp.addEventListener('change', () => {
    if (isCollecting) haltAndroidCollectOnSwitch();
    // 切换包名：清空 reports/shots，避免截图串包
    void window.perfAPI.clearReportShots().catch(() => {});
    scheduleDeviceInfoBar();
  });
}

/** 清空本轮 Android 采集：主进程缓存 + 图表 + 卡片 + 场景标记（等清空完成再开始，避免首个采样点被清掉） */
async function resetAndroidSessionData() {
  try { await window.perfAPI.androidClearHistory(); } catch (_) {}
  chartMgr.reset();
  resetCards();
  _resetAndroidTags();
  _sessionSamples = 0;
}

btnStart.onclick = async () => {
  const deviceId = selDevice.value;
  const pkg = selApp ? selApp.value.trim() : '';

  if (!deviceId) {
    log('请先选择设备', 'warn');
    return;
  }
  if (!pkg) {
    showStartHint('请先选择应用');
    return;
  }
  hideStartHint();

  const switched = (deviceId !== _lastDevice || pkg !== _lastPkg);

  // 换设备/换应用：上一轮数据已无意义，直接按「重新采集」处理。
  // 同设备同应用且已有数据：让用户明确选择「重新采集」还是「继续采集」。
  let mode = 'fresh';
  if (!switched && _sessionSamples > 0 && typeof window.askStartMode === 'function') {
    mode = await window.askStartMode(_sessionSamples);
    if (!mode) {
      log('已取消开始采集', 'info');
      return;
    }
  }

  if (mode === 'fresh') await resetAndroidSessionData();

  _lastDevice = deviceId;
  _lastPkg = pkg;

  log(`开始采集（${mode === 'append' ? '继续采集' : '重新采集'}）: ${pkg} @ ${deviceId}`, 'info');
  if (typeof window.resetDeviceReportSection === 'function') window.resetDeviceReportSection();
  setCollecting(true);
  showPrepHint('采集准备中，请稍后');

  try {
    const devLabel = selDevice.options[selDevice.selectedIndex]?.text?.trim() || deviceId;
    let appLabel = '';
    if (Array.isArray(allPackages)) {
      const row = allPackages.find((p) => p && p.pkg === pkg);
      const lb = row && row.label != null ? String(row.label).trim() : '';
      if (lb && lb !== pkg) appLabel = lb;
    }
    const result = await window.perfAPI.startCollect(deviceId, pkg, devLabel, appLabel, _metricConfig);
    if (!result.ok) throw new Error(result.reason);
  } catch (e) {
    // 日志面板可能被 configout 的 logpannel=false 隐藏，失败原因必须直接显示在界面上，
    // 否则用户只看到「点开始就停了」而没有任何线索。
    const raw = String((e && e.message) || e || '未知错误');
    const brief = raw.replace(/\s+/g, ' ').trim().slice(0, 180);
    log('启动失败: ' + raw, 'error');
    hidePrepHint();
    showStartHint('启动失败：' + brief, 15000);
    setCollecting(false);
  }
};

btnStop.onclick = async () => {
  await window.perfAPI.stopCollect();
  log('已停止采集', 'warn');
  setCollecting(false);
  if (typeof window.showDeviceReportAfterStop === 'function') {
    await window.showDeviceReportAfterStop();
  }
};

btnExportCsv.onclick  = () => exportData('csv');
btnExportJson.onclick = () => exportData('json');

async function exportData(format) {
  const result = await window.perfAPI.exportData(format);
  if (result.ok) log(`已导出至: ${result.filePath}`, 'info');
  else log('导出失败: ' + result.reason, 'error');
}

// ─── 帧数据异常提示 ───────────────────────────────────────────────────────────
// 应用不在前台 / 没有渲染层时 SurfaceFlinger 拿不到帧，fps 恒为 0。
// 这种情况下报告里的「达帧率 / 均帧 / 低帧占比 / 1%Low / 稳帧范围」等整族派生指标
// 都算不出来（目标帧率由帧率分布 P95 推出，全 0 时无解），必须当场提示，
// 否则用户只会看到「参数丢了很多」。
let _zeroFpsStreak = 0;
const FPS_WARN_THRESHOLD = 5;
function updateFpsWarn(data) {
  if (!fpsWarnBar) return;
  const fps = data && typeof data.fps === 'number' ? data.fps : null;
  if (fps === null) return;
  _zeroFpsStreak = fps > 0 ? 0 : _zeroFpsStreak + 1;
  if (isCollecting && _zeroFpsStreak >= FPS_WARN_THRESHOLD) {
    if (fpsWarnText) {
      fpsWarnText.textContent =
        `已连续 ${_zeroFpsStreak} 秒未取到帧数据：被测应用可能不在前台或没有渲染层。` +
        '此时 FPS / Jank 为 0，报告里的达帧率、均帧、低帧占比等帧率质量指标也无法计算，请把应用切到前台后重新采集。';
    }
    fpsWarnBar.hidden = false;
  } else {
    fpsWarnBar.hidden = true;
  }
}
function resetFpsWarn() {
  _zeroFpsStreak = 0;
  if (fpsWarnBar) fpsWarnBar.hidden = true;
}

// ─── IPC listeners ────────────────────────────────────────────────────────────
window.perfAPI.onPerfData((data) => {
  // When Android app process is gone we auto-stop; freeze charts/cards until user starts again.
  if (!isCollecting) return;
  _sessionSamples += 1;
  if (_waitingFirstData) hidePrepHint();
  updateCards(data);
  chartMgr.update(data);
  updateFpsWarn(data);
  if (data.pid && pidLabel) {
    pidLabel.textContent = `PID: ${data.pid}`;
    pidLabel.style.display = '';
  }
  btnExportCsv.disabled = false;
  btnExportJson.disabled = false;
  if (btnTagScene) btnTagScene.disabled = false;
});

window.perfAPI.onCollectLog((msg) => {
  log(msg);
});

window.perfAPI.onCollectError((msg) => {
  log('采集错误: ' + msg, 'error');
});

window.perfAPI.onCollectStopped((payload) => {
  // Auto-stop (Android): keep existing charts as-is, just stop updating and show stopped status.
  if (isCollecting) {
    const reason = payload && payload.reason;
    if (reason === 'process_gone') {
      log('检测到应用进程已退出，采集已自动停止', 'warn');
    } else {
      log('采集已停止', 'warn');
    }
  }
  setCollecting(false);
  statusBadge.textContent = '已停止';
  statusBadge.className = 'badge idle';
});

// ─── UI helpers ───────────────────────────────────────────────────────────────
function setCollecting(v) {
  isCollecting = v;
  btnStart.disabled = v;
  btnStop.disabled = !v;
  // 允许采集中切换设备/应用，以便中断并清空（见 haltAndroidCollectOnSwitch）

  statusBadge.textContent = v ? '采集中' : '待机';
  statusBadge.className = 'badge ' + (v ? 'running' : 'idle');

  if (v) {
    startTime = Date.now();
    resetFpsWarn();
    elapsedTimer = setInterval(updateElapsed, 1000);
    if (btnTagScene) btnTagScene.disabled = false;
  } else {
    clearInterval(elapsedTimer);
    elapsedEl.textContent = '';
    if (pidLabel) pidLabel.style.display = 'none';
    hidePrepHint();
    resetFpsWarn();
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
  [valSysCpu, valProcCpu, valMem, valFps, valJank, valBigJank, valNet, valGpu, valBattery, valTemp]
    .forEach((el) => { el.textContent = '--'; });
  if (valJankRate) valJankRate.textContent = '';
}

function updateCards(d) {
  // 被移除的参数没有对应字段，逐项判空（旧版数据一律有值，行为不变）
  const cpu = d.cpu || {};
  const mem = d.mem || {};
  const net = d.net || {};
  const bat = d.battery || {};
  valSysCpu.textContent  = cpu.sysCpu ?? '--';
  valProcCpu.textContent = cpu.procCpu ?? '--';
  valMem.textContent     = mem.totalPss ?? '--';
  valFps.textContent     = d.fps ?? '--';
  valJank.textContent    = d.jank ?? 0;
  valBigJank.textContent = d.bigJank ?? 0;
  if (valJankRate) valJankRate.textContent = d.jankRate ? `${d.jankRate}%` : '';
  valNet.textContent     = (net.rxKBps != null && net.txKBps != null) ? `${net.rxKBps} / ${net.txKBps}` : '--';
  valGpu.textContent     = d.gpu ?? '--';
  valBattery.textContent = bat.level ?? '--';
  valTemp.textContent    = d.temperature || bat.temperature || '--';

  // Color warnings（无数据的项跳过着色）
  if (cpu.sysCpu != null)   colorWarn('card-cpu',     cpu.sysCpu,  80, 95);
  if (mem.totalPss != null) colorWarn('card-mem',     mem.totalPss,300, 500);
  if (d.fps != null)        colorWarn('card-fps',     60 - d.fps,    15, 30);
  if (d.jank != null)       colorWarn('card-jank',    d.jank,        3,  10);
  if (d.bigJank != null)    colorWarn('card-bigjank', d.bigJank,     1,  3);
  if (d.temperature != null) colorWarn('card-temp',   d.temperature, 50, 65);
  if (d.gpu != null)        colorWarn('card-gpu',     d.gpu,         80, 95);
}

function colorWarn(cardId, value, warnThresh, critThresh) {
  const card = document.getElementById(cardId);
  if (!card) return;
  card.classList.remove('highlight', 'warn', 'critical');
  if (value >= critThresh) card.classList.add('critical');
  else if (value >= warnThresh) card.classList.add('warn');
}

// ─── Init ─────────────────────────────────────────────────────────────────────
refreshDevices();
