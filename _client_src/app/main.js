// 空 catch 约定（S-05）：本文件里的 `catch (_) {}` 全在「进程退出 / 窗口关闭」的
// 清理链上——停采集器、恢复系统代理、取消 inflight、销毁窗口。每一步都必须是
// best-effort：某一步失败不能阻断后面的清理，否则会留下「系统代理没恢复」「adb
// 子进程没杀干净」这类残留，比原始错误更难查。需要让用户知道的错误一律不在这里
// 吞掉，走 dialog / 日志面板。
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const { pathToFileURL } = require('url');
// 采集/导出模块体积不小（adb.js 单文件 49KB），且只有真正开始采集时才用得上。
// 改惰性加载，省掉启动路径上的解析与 asar 读取开销；调用方式与直接 require 完全一致。
const { lazy } = require('./src/lazy-module');
const Collector       = lazy('./src/collector');
const PcCollector     = lazy('./src/pc-collector', 'PcCollector');  // 类
const PcCollectorMod  = lazy('./src/pc-collector');                 // 模块级静态方法
const IosCollector    = lazy('./src/ios-collector');
const IosGpuCollector = lazy('./src/ios-gpu-collector');
const Exporter        = lazy('./src/exporter');
const reportsDataJs = require('./src/reports-data-js');
const RunXlsx       = require('./src/run-xlsx');
const {
  readAppNameFromReports,
  readConfigOut,
  loadLogpannelFromConfigOutOnce,
} = require('./src/reports-config');
const { getMachineUid } = require('./src/machine-uid');
const activationStore = require('./src/activation');
const trialSession = require('./src/trial-session');
const troughShots = require('./src/trough-shots');
const weaknetTracker = require('./src/weaknet-tracker');
const weaknetHost = require('./src/weaknet-host');
const phoneProxy = require('./src/phone-proxy');
const sysproxy = require('./src/sysproxy');
const appLabels = require('./src/app-labels');
const appVersionInfo = require('./src/app-version');
const { isValidVersion, normalizeVersion } = require('./src/version-scheme');
const { fetchLatestRelease, sanitizeReleaseUrl } = require('./src/update-check');
const { DEFAULT_APP_NAME, formatWindowTitle } = require('./src/window-title');
const foregroundApp = require('./src/foreground-app');
const TraceCapture = require('./src/trace-capture');

// ─── 2.1 Perfetto / simpleperf 旁路取证 ──────────────────────────────────────
// 默认完全关闭。开启后只在「手动触发」或「低谷截图命中」时抓一段 10s 级 trace，
// 任何失败都静默降级，绝不参与主采集判定，也不把异常抛回采集链。
let traceCapture = null;
let traceDeviceId = '';
/** 当前被测包名：帧归因按包读 gfxinfo framestats（切换应用时同步更新） */
let tracePackageName = '';
/** 开启旁路时，低谷截图命中是否自动附带取证 */
let traceAutoOnTrough = true;

function ensureTraceCapture(deviceId) {
  const id = String(deviceId || '');
  if (traceCapture && traceDeviceId === id) return traceCapture;
  if (traceCapture) { try { traceCapture.dispose(); } catch (_) {} }
  traceDeviceId = id;
  traceCapture = TraceCapture.createTraceCapture({
    deviceId: id || 'generic-device',
    packageName: tracePackageName,
    // 与报告页同目录（reports/traces）：用户在同一个地方就能管理「报告 + 取证片段」，
    // 便携包解到 D:/E: 时 trace 也不再往 C 盘 userData 里堆。只有安装目录不可写
    // （Program Files）才随 data.js 一起退回 userData/reports，保证两者始终同处。
    reportDir: path.join(reportsDataJs.resolveReportsRootDir(), 'traces'),
    enabled: false,
    runAdb: (args, timeout) => require('./src/adb').runAdb(args, timeout),
    cancelInflight: () => {
      try { require('./src/adb').cancelAllInflight(); } catch (_) {}
    },
    // 帧归因：优先用最近一拍 timestats 自带的 FrameTimeline 归因（零额外 adb 调用，
    // 且与曲线里的 jank 是同一图层、同一窗口）；拿不到才退回 gfxinfo framestats 的
    // 位掩码。绝不再从 perfetto 的 stdout 里猜（那条路永远是空的）。
    snapshotJank: async (pkg) => {
      const last = perfHistory.length ? perfHistory[perfHistory.length - 1] : null;
      const attr = last && last.jankAttr;
      if (attr && typeof attr === 'object'
        && typeof attr._frames === 'number' && attr._frames > 0) {
        return { ok: true, source: 'timestats', counts: attr };
      }
      // 兜底：采集正在走 framestats/gfxinfo 通道时跳过 —— 多插一次 dump 会重置帧缓冲，
      // 让那一拍的帧数变少。宁可这一次没有归因，也不污染主采样。
      const method = last && last.fpsMethod ? String(last.fpsMethod) : '';
      if (method === 'framestats' || method === 'gfxinfo-delta') {
        return { ok: false, reason: 'framestats-channel-in-use' };
      }
      return require('./src/adb').getJankSnapshot(traceDeviceId, pkg);
    },
    log: (m) => console.log(m),
  });
  return traceCapture;
}

ipcMain.handle('trace-capture-config', async (_e, cfg) => {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  if (typeof c.autoOnTrough === 'boolean') traceAutoOnTrough = c.autoOnTrough;
  const tc = ensureTraceCapture(c.deviceId || traceDeviceId);
  tc.setEnabled(!!c.enabled);
  if (c.enabled) {
    try {
      const sup = await tc.isSupported();
      return { ok: true, enabled: true, supported: sup.supported,
        backend: sup.backend, sdkInt: sup.sdkInt, diagnostics: tc.getDiagnostics() };
    } catch (_) { return { ok: true, enabled: true, supported: false }; }
  }
  return { ok: true, enabled: false, diagnostics: tc.getDiagnostics() };
});

ipcMain.handle('trace-capture-now', async (_e, opts) => {
  const tc = ensureTraceCapture((opts && opts.deviceId) || traceDeviceId);
  // 手动触发不强开旁路：只有开关打开才抓，避免误触产生无谓开销
  const r = await tc.capture(Object.assign({ source: 'manual' }, opts || {}));
  return r;
});

ipcMain.handle('trace-capture-status', async () => ({
  enabled: traceCapture ? traceCapture.isEnabled() : false,
  autoOnTrough: traceAutoOnTrough,
  diagnostics: traceCapture ? traceCapture.getDiagnostics() : null,
  records: traceCapture ? traceCapture.list() : [],
}));

ipcMain.handle('trace-capture-cancel', async () => {
  if (!traceCapture) return { ok: false, reason: 'not-configured' };
  try { return { ok: true, result: traceCapture.cancel() }; }
  catch (_) { return { ok: false, reason: 'exception' }; }
});

// ─── 窗口标题 / 新版本状态 ───────────────────────────────────────────────────
// 标题栏由主进程统一生成（应用名 + 版本号 + 新版本标记），渲染进程改不了它。
const APP_UPDATE_CHANNEL = 'app-update';
let latestAppUpdate = null;
let appUpdateCheckInflight = false;
let windowAppName = DEFAULT_APP_NAME;   // 首屏后再用 configout 里的应用名覆盖
let cachedAppVersion = null;

/** 版本号一次运行只读一次：标题栏和新版本检查共用同一来源，不会各读各的 */
function getAppVersionCached() {
  if (cachedAppVersion === null) cachedAppVersion = readCurrentAppVersion();
  return cachedAppVersion;
}

function buildWindowTitle() {
  return formatWindowTitle({
    appName: windowAppName,
    version: getAppVersionCached(),
    hasUpdate: !!latestAppUpdate,
  });
}

function applyWindowTitle() {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(buildWindowTitle());
  } catch (_) {}
}

/** 系统代理快照放用户目录：进程被强杀后下次启动还要靠它把整机代理还回去 */
function sysproxyBackupFile() {
  return path.join(app.getPath('userData'), 'weaknet-sysproxy-backup.json');
}

/**
 * 采集起止与弱网追踪的接线。
 * 开始采集时启动轮询（只问本机引擎：手机关闭走 USB 代理，限速也在本机引擎上），
 * 结束时收口并取出时段；没有段就不写进 data.js，报告页也就不会多出空区块。
 */
function startWeaknetTracking(category, deviceId) {
  try {
    // 引擎端口可能是顺延出来的实际值，不能盲猜 8899
    const info = weaknetHost.currentInfo();
    weaknetTracker.start({
      ctrlPort: (info && info.ctrlPort) || 0,
      // USB 接管的手机是被本机引擎限速的，报告里的来源要记成手机而不是本机
      phoneUsb: category === 'android' && !!phoneProxy.heldPort(deviceId),
    });
  } catch (_) {}
}

function stopWeaknetTracking() {
  try {
    return weaknetTracker.stop();
  } catch (_) {
    return null;
  }
}

function sendToRenderer(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  } catch (_) {}
}

function _broadcastToAllLogPanels(msg) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('collect-log', msg);
    mainWindow.webContents.send('pc-collect-log', msg);
    mainWindow.webContents.send('ios-collect-log', msg);
    mainWindow.webContents.send('ios-gpu-log', msg);
  } catch (_) {}
}

// Startup log messages may be emitted before renderer listeners attach.
const _startupLogQueue = [];
let _startupLogFlushed = false;

function _logStartup(msg) {
  try {
    if (!_startupLogFlushed) _startupLogQueue.push(msg);
  } catch (_) {}
  _broadcastToAllLogPanels(msg);
}

function sendToRendererWithTrialLog(channel, payload) {
  sendToRenderer(channel, payload);
  if (channel === 'trial-budget-tick' && payload && payload.remainingSec != null) {
    const s = Math.max(0, Math.floor(Number(payload.remainingSec) || 0));
    _broadcastToAllLogPanels(`试用剩余: ${s}s`);
  }
}

/**
 * 报告落盘前对采样数组做快照。
 * 之前用 JSON.parse(JSON.stringify(arr)) 深拷贝，长时采集（数千点 × 数十字段）时
 * 这一次「序列化 + 解析」要跑几百毫秒并阻塞主进程。写文件是同步的、采样对象每帧新建
 * 且之后不再改动，因此浅拷贝数组即可，省掉整轮深拷贝。
 */
function snapshotArr(arr) {
  return Array.isArray(arr) ? arr.slice() : [];
}

/** 低谷截图失败只提示一次，避免每 10s 刷屏 */
const _shotWarned = new Set();

/**
 * 每拍数据进来后喂一次低谷判定；命中则异步截图（不阻塞采样）。
 * @param {'android'|'ios'} category
 * @param {object} data 采样点
 * @param {() => Promise<Buffer>} capture 返回 PNG 字节
 * @param {string} logChannel 采集日志通道
 */
function _pushTroughShot(category, data, capture, logChannel) {
  const fps = data ? data.fps : null;
  if (typeof fps !== 'number' || !isFinite(fps) || fps <= 0) return;
  const ts = Number.isFinite(data.timestamp) ? data.timestamp : Date.now();
  // 卡顿分级用于区分「真掉帧」与「静置/加载时的主动限帧」；iOS 无此字段时为 undefined，
  // 判定器按「未测量」处理，不因缺证据而拒绝截图。
  const ctx = {
    jank: data.jank, bigJank: data.bigJank, smallJank: data.smallJank,
    tinyJank: data.tinyJank, jankRate: data.jankRate,
    // 帧耗时证据：偶发长帧会被 1s 窗口的平均帧率抹平，只看 FPS 会漏（见 trough-detector）
    overrunP99: data.overrunP99, overrunMax: data.overrunMax, jankyRatio: data.jankyRatio,
  };
  troughShots.feed(category, ts, fps, capture, ctx).then((r) => {
    if (r.meta) {
      sendToRenderer('trough-shot', r.meta);
      sendToRenderer(logChannel, `已截取低谷截图 ${r.meta.time}（FPS ${r.meta.fps} / 目标 ${r.meta.target}`
        + `${r.meta.reason === 'overrun' ? ' / 帧耗时超时' : ''}）`);
      // 2.1 低谷命中自动附带一段旁路取证：截图说明「长什么样」，
      // trace 回答「这一帧等的是谁」。失败一律静默，不影响截图与主采集。
      if (traceAutoOnTrough && traceCapture && traceCapture.isEnabled()) {
        void traceCapture.capture({
          source: 'auto', reason: r.meta.reason,
          fps: r.meta.fps, target: r.meta.target, ts,
          overrunMax: data.overrunMax, durationSec: 10,
        }).then((t) => {
          if (t && t.ok) {
            sendToRenderer(logChannel, `已保存旁路取证片段（${t.kind}）：${t.path}`);
          }
        }).catch(() => {});
      }
    } else if (r.error && !_shotWarned.has(category)) {
      _shotWarned.add(category);
      sendToRenderer(logChannel, `[warn] 低谷截图失败：${r.error.message}（本轮不再提示）`);
    }
  }).catch(() => {});
}

/**
 * 采集结束后在报告目录生成 Excel（每个性能组一个标签页 + 标记区间 + 原始采样）。
 * 写 data.js 成功才调用：传进来的路径就是实际落盘目录，自动跟随 userData fallback。
 * Excel 属于附加产物，失败只记日志，绝不影响停止采集与报告生成。
 */
async function _writeRunXlsxSafe(payload, dataJsPath, logChannel) {
  try {
    // 紧随 writeDataJs 取本次归档元信息：Excel 与历史报告 <id>.js 同名同目录落盘，
    // 提取某次采集时两者一一对应；归档失败则 getLastArchive() 为 null，回退根目录。
    const archive = reportsDataJs.getLastArchive();
    const r = await RunXlsx.writeRunXlsxAsync(payload, dataJsPath, archive);
    if (logChannel) {
      sendToRenderer(logChannel, `已生成 Excel：${r.file}（${r.sheets.length} 个标签页）`);
    }
    return r;
  } catch (e) {
    console.error('[reports/xlsx]', e && e.message ? e.message : e);
    if (logChannel) sendToRenderer(logChannel, `[warn] Excel 生成失败：${e && e.message ? e.message : e}`);
    return null;
  }
}

/**
 * adb 参数白名单校验。
 * deviceId / packageName 从渲染进程经 IPC 到达主进程，途中会被拼进 `adb -s <serial> shell …`：
 * serial 落在 adb 自己的参数位（以 - 开头会被当成选项），包名落在设备端 sh 的命令串里。
 * 设备侧命令已统一走 shellArg 转义，这里再把住主进程入口这一道，越界的输入直接拒掉。
 */
const SAFE_DEVICE_SERIAL = /^[\w][\w.:-]{0,127}$/;
const SAFE_PACKAGE_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,255}$/u;

function invalidAdbArgs(deviceId, packageName) {
  if (deviceId != null && !SAFE_DEVICE_SERIAL.test(String(deviceId))) {
    return `设备序列号不合法: ${String(deviceId).slice(0, 40)}`;
  }
  if (packageName != null && !SAFE_PACKAGE_NAME.test(String(packageName))) {
    return `包名不合法: ${String(packageName).slice(0, 60)}`;
  }
  return null;
}

/**
 * 采集参数的展示顺序：renderer 把它放在 metricConfig.__order 里随 IPC 传过来。
 * 顺序只影响展示、不参与采集过滤，因此不进入 normalizeMetricConfig 的结果；
 * 这里单独抽出，写报告时放到 payload.metricOrder，报告端据此重排卡片与图表。
 */
function extractMetricOrder(rawCfg) {
  if (!rawCfg || typeof rawCfg !== 'object' || !Array.isArray(rawCfg.__order)) return null;
  const seen = new Set();
  const out = [];
  for (const g of rawCfg.__order) {
    if (typeof g !== 'string' || !g || g === '__order' || seen.has(g)) continue;
    seen.add(g);
    out.push(g);
  }
  return out.length ? out : null;
}

/** PC 上报 JSON：根级 category；device 包名/应用名为 exe 文件名；deviceId 用本机 UID 作上传 uid */
function buildPcReportDataJsPayload(pcSession, perfArr, tagArr, machineUid, metricConfig) {
  const raw = pcSession && pcSession.exePath ? String(pcSession.exePath) : '';
  const exeName = raw ? path.basename(raw) : 'PC';
  const uid = String(machineUid || '').trim();
  return {
    category: 'pc',
    device: {
      name: exeName,
      bundleId: exeName,
      appName: exeName,
      category: 'pc',
      udid: '',
      model: '',
      osVersion: '',
      deviceId: uid,
    },
    perf: snapshotArr(perfArr),
    tag: snapshotArr(tagArr),
    // 采集参数配置（勾选项）；报告端据此隐藏被移除指标的图表与指标行
    metricConfig: metricConfig && typeof metricConfig === 'object' ? JSON.parse(JSON.stringify(metricConfig)) : null,
    // 采集参数的展示顺序；报告端据此重排卡片与图表
    metricOrder: pcSession && Array.isArray(pcSession.metricOrder) ? pcSession.metricOrder.slice() : null,
  };
}

let mainWindow = null;
let collector = null;
let perfHistory = [];
let androidTags = [];
/** @type {{ deviceId: string, packageName: string, deviceLabel: string, appLabel: string } | null} */
let androidSession = null;
/**
 * 会话级指标（Android）：冷启动计时 + 本轮退出原因。
 * 存在这里而不是 collector 上：采集器 stop 后会被置 null，而报告是用户随后
 * 手动点「保存」才生成，中间隔着任意长的时间。
 */
let androidLastLaunch = null;

let iosCollector = null;
let iosPerfHistory = [];
let iosTags = [];
/** @type {{ bundleId: string, execName: string, appName: string } | null} */
let iosSession = null;

let iosGpuCollector = null;
let iosGpuHistory   = [];
let iosGpuTags = [];
/** @type {{ bundleId: string, appName: string, udid: string } | null} */
let iosGpuSession = null;

let pcCollector = null;
let pcPerfHistory = [];
let pcTags = [];
/** @type {{ exePath: string, label: string } | null} */
let pcSession = null;

function createWindow() {
  const iconPath = path.join(__dirname, 'icon', 'perfara.ico');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0f1117',
    // 先隐藏，等首屏渲染完再显示：避免用户先看到一个空白窗口再「跳」出界面
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'default',
    // 标题里的应用名要读 configout 配置（同步扫盘），放到首屏之后再补，
    // 避免这一次 I/O 阻塞窗口创建；版本号与新版本标记从建窗口时就带上
    title: buildWindowTitle(),
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
  });

  // 首屏就绪即显示；万一 ready-to-show 没触发（个别环境/异常），3s 后兜底显示
  let shown = false;
  const showNow = () => {
    if (shown || !mainWindow || mainWindow.isDestroyed()) return;
    shown = true;
    try { mainWindow.show(); } catch (_) {}
  };
  mainWindow.once('ready-to-show', showNow);
  setTimeout(showNow, 3000);

  // 渲染进程（apply-app-brand.js / 页面自身）改 document.title 时，别把标题栏里的
  // 版本号与新版本标记冲掉：忽略文档标题变更，重新压上主进程生成的标题。
  mainWindow.webContents.on('page-title-updated', (e) => {
    try { e.preventDefault(); } catch (_) {}
    applyWindowTitle();
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Flush any queued startup logs after renderer is ready.
  try {
    mainWindow.webContents.on('did-finish-load', () => {
      // 首屏已出，此时再读配置补应用名（不阻塞启动）；标题仍统一由主进程生成
      try {
        windowAppName = readAppNameFromReports();
        applyWindowTitle();
      } catch (_) {}
      if (_startupLogFlushed) return;
      _startupLogFlushed = true;
      if (_startupLogQueue.length === 0) return;
      for (const m of _startupLogQueue.splice(0)) {
        try { _broadcastToAllLogPanels(m); } catch (_) {}
      }
    });
  } catch (_) {}

  mainWindow.on('closed', () => {
    if (collector) collector.stop();
    if (pcCollector) {
      try {
        pcCollector.stop();
      } catch (_) {}
      pcCollector = null;
    }
    if (iosCollector) iosCollector.stop();
    if (iosGpuCollector) iosGpuCollector.stop();
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  loadLogpannelFromConfigOutOnce();
  try {
    appLabels.init(path.join(app.getPath('userData'), 'app-labels.json'));
  } catch (_) {}
  // Windows/Linux: remove the default File/Edit/View menu bar from the window.
  // (macOS keeps the system menu bar unless you replace it with a custom Menu.)
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
  }
  // 上次崩溃留下的系统代理接管（引擎被强杀时 atexit 没跑）：先还回去再开窗口
  try { sysproxy.restoreStale(sysproxyBackupFile()); } catch (_) {}
  // 手机侧同理：账本只在内存里，强杀重开后是空的，把「映射已断、代理还指着本工具端口」的手机清掉
  phoneProxy.sweepStale().catch(() => {});
  createWindow();
  // 每次运行只查一次：延时 5s 避开启动路径；本次运行期间不再轮询（失败也不重试，
  // 想重新检查请重启程序）。这样既不会打扰长时间运行的采集，也不会产生后台流量。
  setTimeout(() => { runAppUpdateCheck(); }, 5000);
});

let weaknetQuitting = false;
app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  // 弱网引擎是独立进程：先把它的系统代理接管和限速收掉再退出，
  // 否则强杀后整机代理会指向一个没人监听的端口（shutdown 内部有 4 s 上限）。
  // 手机侧同理：USB 接管过的手机要还原系统代理并撤掉反向映射。
  if (weaknetQuitting) { app.quit(); return; }
  weaknetQuitting = true;
  try { appLabels.saveNow(); } catch (_) {}
  // 兜底：链上任何一步的 await 卡死（adb 通道僵死、引擎不响应）都不能让进程变成
  // 「窗口没了但进程常驻」的僵尸 —— 8 s 后无条件退出。
  const hardExit = setTimeout(() => { try { app.exit(0); } catch (_) {} }, 8000);
  if (hardExit.unref) hardExit.unref();
  phoneProxy.restoreAll().catch(() => {})
    .then(() => weaknetHost.shutdown())
    .then(() => { try { sysproxy.clearBackup(sysproxyBackupFile()); } catch (_) {} })
    .catch(() => {})
    // 收掉本次运行自己拉起来的 adb server：否则 adb.exe 会以孤儿进程常驻，
    // 既占着 5037，也把便携包里的 adb.exe 文件锁住（整个目录移不走也删不掉）。
    // 先取消在途 adb 子进程，避免 kill 的瞬间又有一条命令把 server 重新拉起来。
    .then(() => {
      // 2.1 退出前先收掉在途 trace，别留下 adb 子进程
      try { if (traceCapture) traceCapture.dispose(); } catch (_) {}
      try { require('./src/adb').cancelAllInflight(); } catch (_) {}
      try { return require('./src/adb').killServerIfOwned().catch(() => null); } catch (_) { return null; }
    })
    .then(() => { clearTimeout(hardExit); app.quit(); });
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── IPC Handlers ────────────────────────────────────────────────────────────

/* ═══ 新版本提示（静默，不弹窗） ═══════════════════════════════════════════
   每次启动只问一次 GitHub Releases，运行中不再检查。结果同时驱动窗口标题栏的
   「新版本可用」标记和顶栏那个可点击标签（标题栏不能点，跳转入口仍在顶栏）。
   状态变量在文件顶部统一声明；离线 / 超时 / 限流 / 响应异常一律静默忽略。 */

/** 版本优先读包外 version.txt（发版脚本生成，改它无需重打包 asar），否则用源码常量 */
function readCurrentAppVersion() {
  const candidates = [];
  if (app.isPackaged) candidates.push(path.join(process.resourcesPath, 'version.txt'));
  candidates.push(path.join(__dirname, 'version.txt'));
  for (const f of candidates) {
    try {
      if (!fs.existsSync(f)) continue;
      const v = String(fs.readFileSync(f, 'utf8')).trim();
      // 旧包残留的日期式版本号（2026.11.02）不合新规范，忽略它回退到源码常量，
      // 否则标题会显示旧格式、新版本判定也会把本地版本误当成不支持。
      if (isValidVersion(v)) return normalizeVersion(v);
    } catch (_) {}
  }
  return appVersionInfo.APP_VERSION;
}

function broadcastAppUpdate() {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(APP_UPDATE_CHANNEL, latestAppUpdate);
    }
  } catch (_) {}
  // 同一份检查结果也刷新标题栏上的「新版本可用」标记
  applyWindowTitle();
}

async function runAppUpdateCheck() {
  if (appUpdateCheckInflight) return latestAppUpdate;
  appUpdateCheckInflight = true;
  try {
    const r = await fetchLatestRelease({
      owner: appVersionInfo.GITHUB_OWNER,
      repo: appVersionInfo.GITHUB_REPO,
      currentVersion: getAppVersionCached(),
      timeoutMs: 5000,
    });
    if (r && r.ok && r.update) {
      // 带上本地版本，顶栏标签可以提示「当前 vX → 新版本 vY」
      latestAppUpdate = { ...r.update, currentVersion: getAppVersionCached() };
      broadcastAppUpdate();
    }
  } catch (_) {
    // 离线是常态，检查失败不提示
  } finally {
    appUpdateCheckInflight = false;
  }
  return latestAppUpdate;
}

// 渲染进程首屏拿缓存（可能比后台检查更早），后续靠事件推送
ipcMain.handle('get-app-update', () => latestAppUpdate);

// 渲染进程同步窗口标题，避免它自己拼一个没有版本号 / 新版本标记的 document.title
ipcMain.handle('get-window-title', () => ({
  title: buildWindowTitle(),
  version: getAppVersionCached(),
  hasUpdate: !!latestAppUpdate,
  updateTag: latestAppUpdate ? latestAppUpdate.tag : null,
}));

// 地址固定取自主进程缓存且再过一次白名单，渲染进程不能传 URL
ipcMain.handle('open-app-update', async () => {
  const url = latestAppUpdate && sanitizeReleaseUrl(
    latestAppUpdate.url, appVersionInfo.GITHUB_OWNER, appVersionInfo.GITHUB_REPO);
  if (!url) return { ok: false, reason: '暂无可用的新版本' };
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
});

ipcMain.handle('get-devices', async () => {
  const ADB = require('./src/adb');
  const devices = await ADB.getDevices();
  return await Promise.all(devices.map(async (d) => {
    let displayName = String(d.model || '').replace(/-wifi$/i, '');
    if (d.wifi) displayName = displayName ? `${displayName} (无线)` : '无线设备';
    try {
      const info = await ADB.getDeviceInfo(d.id);
      if (info && info.name) displayName = info.name + (d.wifi ? ' (无线)' : '');
    } catch (_) {}
    return { ...d, displayName };
  }));
});

ipcMain.handle('get-android-device-info', async (_e, deviceId) => {
  const bad = invalidAdbArgs(deviceId, null);
  if (bad) { _logStartup(`[adb] 拒绝 get-android-device-info：${bad}`); return null; }
  try {
    const ADB = require('./src/adb');
    return await ADB.getDeviceInfo(deviceId);
  } catch (_) {
    return null;
  }
});

ipcMain.handle('get-ios-device-info', async (_e, udid) => {
  try {
    return await IosCollector.getLockdownDeviceInfo(udid || '');
  } catch (_) {
    return null;
  }
});

ipcMain.handle('connect-wifi', async (_event, ipPort) => {
  const ADB = require('./src/adb');
  return await ADB.connectWifi(ipPort);
});

ipcMain.handle('auto-connect-wifi', async (_event, deviceId) => {
  const ADB = require('./src/adb');
  return await ADB.autoConnectWifi(deviceId);
});

ipcMain.handle('disconnect-wifi', async (_event, ipPort) => {
  const ADB = require('./src/adb');
  return await ADB.disconnectWifi(ipPort);
});

// 应用名来自 APK 里的资源（adb 没有取 label 的接口），单包要读一次清单/资源表。
// 所以这里只做两件快事：把缓存命中直接填上、把剩下的丢给后台逐条解析。
let _labelRunId = 0;

function startLabelResolution(deviceId, packages) {
  const runId = ++_labelRunId;
  const ADB = require('./src/adb');
  appLabels.resolveAll({
    deviceId,
    packages,
    adb: ADB,
    // 换设备/刷新列表后旧轮次自行退出，别把上一台机器的名字推到界面
    isStale: () => runId !== _labelRunId,
    // 采集中暂停：exec-out 拉资源表会占 USB 通道，宁可名字晚几分钟
    shouldPause: () => !!collector,
    onUpdate: (items, progress) => {
      if (runId !== _labelRunId) return;
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('app-labels', { deviceId, items, ...progress });
    },
  }).catch(() => {});
}

ipcMain.handle('get-packages', async (_event, deviceId) => {
  const bad = invalidAdbArgs(deviceId, null);
  if (bad) { _logStartup(`[adb] 拒绝 get-packages：${bad}`); return []; }
  const ADB = require('./src/adb');
  const packages = await ADB.getThirdPartyPackages(deviceId);
  try {
    await appLabels.attachCached(deviceId, packages, ADB);
  } catch (_) {}
  startLabelResolution(deviceId, packages);
  return packages;
});

/* ═══ 启动时自动选中真机前台应用 ═════════════════════════════════════════════
   主进程只给「事实」：当前前台包名、是否系统桌面。要不要落到下拉框由渲染进程决定。
   设备在系统桌面（或读不到前台）时 renderer 一律保持原样式，不打扰用户。 */
ipcMain.handle('get-foreground-app', async (_event, deviceId) => {
  const bad = invalidAdbArgs(deviceId, null);
  if (bad) { _logStartup(`[adb] 拒绝 get-foreground-app：${bad}`); return null; }
  try {
    const ADB = require('./src/adb');
    const r = foregroundApp.parseForegroundApp(await ADB.getForegroundSnapshot(deviceId));
    if (!r.pkg || r.isDesktop) return r;
    // 命中磁盘缓存就顺手带回显示名，省掉一次往返；没命中由 renderer 异步补
    try {
      const locale = await ADB.getDeviceLocale(deviceId);
      const cached = appLabels.cacheGet(r.pkg, null, locale);
      if (cached) r.label = cached;
    } catch (_) {}
    return r;
  } catch (_) {
    return null;
  }
});

/** 系统应用不在 pm list -3 里，单独补一次桌面显示名；失败/超时返回空串，界面退回包名 */
ipcMain.handle('get-foreground-app-label', async (_event, deviceId, packageName) => {
  const bad = invalidAdbArgs(deviceId, packageName);
  if (bad) return '';
  let timer = null;
  try {
    const ADB = require('./src/adb');
    const locale = await ADB.getDeviceLocale(deviceId).catch(() => null);
    const cached = appLabels.cacheGet(packageName, null, locale);
    if (cached) return cached;
    // resources.arsc 可能几十 MB，给 6s 上限；超时就保持包名，绝不拖住启动
    const cap = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), 6000);
      if (timer.unref) timer.unref();
    });
    const label = await Promise.race([
      ADB.resolveAppLabel(deviceId, packageName, locale).catch(() => null),
      cap,
    ]);
    if (typeof label === 'string' && label) {
      appLabels.cachePut(packageName, null, locale, label);
      return label;
    }
  } catch (_) {} finally {
    if (timer) clearTimeout(timer);
  }
  return '';
});

// 说明：已移除「安装 perfara.apk + 广播拉应用列表」的采集方式。
// Android 端所有性能数据（CPU/内存/FPS/Jank/网络/温度等）均通过 USB + adb shell 直接读取，
// 应用列表统一由 get-packages（pm list packages -3）提供，不再向手机安装任何 APK。

ipcMain.handle('get-pid', async (_event, deviceId, packageName) => {
  const bad = invalidAdbArgs(deviceId, packageName);
  if (bad) { _logStartup(`[adb] 拒绝 get-pid：${bad}`); return null; }
  const ADB = require('./src/adb');
  return await ADB.getPid(deviceId, packageName);
});

// 未换设备/包名时不清空 perfHistory，多次开始数据拼接到内存；清空见 android-clear-history
ipcMain.handle('start-collect', async (_event, deviceId, packageName, deviceLabel, appLabel, metricConfig) => {
  const badArgs = invalidAdbArgs(deviceId, packageName);
  if (badArgs) return { ok: false, reason: badArgs };
  const trial = trialSession.canStartCollect(app, getMachineUid, activationStore, readConfigOut);
  if (!trial.ok) return { ok: false, reason: trial.reason };
  if (trial.remainingSec != null && mainWindow && !mainWindow.isDestroyed()) {
    const s = Math.max(0, Math.floor(Number(trial.remainingSec) || 0));
    mainWindow.webContents.send('collect-log', `试用剩余: ${s}s`);
  }
  // Cancel any inflight adb tasks from previous run to avoid stale logs/processes.
  try { require('./src/adb').cancelAllInflight(); } catch (_) {}
  if (collector) collector.stop();
  const label = typeof appLabel === 'string' ? appLabel.trim() : '';
  const mc = metricConfig && typeof metricConfig === 'object'
    ? Collector.normalizeMetricConfig(metricConfig)
    : null;
  androidSession = {
    deviceId,
    packageName,
    deviceLabel: deviceLabel || deviceId,
    appLabel: label,
    metricConfig: mc,
    metricOrder: extractMetricOrder(metricConfig),
  };
  androidLastLaunch = null;
  // 旁路取证的帧归因按包名取 gfxinfo，切换应用时必须同步（否则会读到上一个包的帧）
  tracePackageName = packageName;
  if (traceCapture) traceCapture.setPackageName(packageName);
  // 会话级「退出原因」基线：必须在拉起应用**之前**取。
  // 之后保存报告时再取一次，差集就是本轮期间的 ANR / 崩溃 / 被系统杀。
  // 取不到（Android 10 及更早没有 exit-info）→ null，报告显示「本机不支持」。
  try {
    const base = await require('./src/adb').getAppExitInfo(deviceId, packageName);
    androidSession.exitBaseline = base && base.supported ? base.keys : null;
  } catch (_) {
    androidSession.exitBaseline = null;
  }

  collector = new Collector(deviceId, packageName, 1000, mc);
  startWeaknetTracking('android', deviceId);
  _shotWarned.delete('android');
  troughShots.beginRun(getBundledReportsDir(), 'android', packageName, Date.now());
  collector.on('log', (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('collect-log', msg);
    }
  });
  collector.on('data', (data) => {
    perfHistory.push(data);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('perf-data', data);
    }
    _pushTroughShot('android', data, () => require('./src/adb').captureScreen(deviceId), 'collect-log');
  });
  collector.on('stopped', (payload) => {
    trialSession.onCollectStopped();
    // 冷启动计时挂在 stopped 上：采集器随后会被置 null，报告却是之后才生成的
    if (payload && payload.launch) androidLastLaunch = payload.launch;
    // Ensure stale background adb tasks can't keep running/logging.
    try { require('./src/adb').cancelAllInflight(); } catch (_) {}
    collector = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('collect-stopped', payload);
    }
  });
  collector.on('error', (err) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('collect-error', err.message);
    }
  });

  try {
    await collector.start();
  } catch (e) {
    try {
      collector.stop();
    } catch (_) {}
    collector = null;
    stopWeaknetTracking();
    return { ok: false, reason: e.message || String(e) };
  }
  trialSession.onCollectStarted(app, getMachineUid, activationStore, readConfigOut, sendToRendererWithTrialLog);
  return { ok: true };
});

ipcMain.handle('android-clear-history', async () => {
  perfHistory = [];
  androidTags = [];
  return { ok: true };
});

ipcMain.handle('set-tags', async (_e, category, tags) => {
  const safeTags = Array.isArray(tags) ? tags : [];
  if (category === 'android') androidTags = safeTags;
  else if (category === 'ios') iosTags = safeTags;
  else if (category === 'ios_gpu') iosGpuTags = safeTags;
  else if (category === 'pc') pcTags = safeTags;
  return { ok: true };
});

function _tryClearShotsDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 120 });
  } catch (_) {}
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
}

/**
 * 切换包名/Bundle 时清空 reports/shots 下的所有文件。
 * 兼容：开发态在项目下 reports；打包后优先 resources/reports（若不可写则回退到 userData/reports）。
 */
ipcMain.handle('clear-report-shots', async () => {
  const primary = path.join(getBundledReportsDir(), 'shots');
  const fallback = path.join(app.getPath('userData'), 'reports', 'shots');
  _tryClearShotsDir(primary);
  _tryClearShotsDir(fallback);
  troughShots.resetAll();
  return { ok: true };
});

ipcMain.handle('stop-collect', async () => {
  trialSession.onCollectStopped();
  // 关机前先取诊断：采集耗时与历史截断是报告「数据完整性」的一部分
  let androidDiag = null;
  let androidSpilled = [];
  if (collector) {
    try {
      androidDiag = collector.getDiagnostics();
      // 1.5 先把落盘分片合并回来再 stop（stop 后临时文件会被清理）
      androidSpilled = collector.drainHistory();
      collector.stop();
    } catch (e) {
      console.error('[stop-collect]', e.message);
    }
    collector = null;
  }
  const weaknet = stopWeaknetTracking();
  // 会话级退出原因：与开始前的基线做差集 → 本轮期间的 ANR / 崩溃 / 被系统杀。
  // baseline 为 null（Android 10 及更早没有 exit-info）时不查，报告显示「本机不支持」。
  let sessionExit = null;
  if (androidSession && Array.isArray(androidSession.exitBaseline)) {
    try {
      sessionExit = await require('./src/adb').getAppExitInfo(
        androidSession.deviceId, androidSession.packageName, androidSession.exitBaseline);
    } catch (_) {
      sessionExit = null;
    }
  }
  const sessionInfo = {
    launch: androidLastLaunch || (androidDiag && androidDiag.launch) || null,
    exit: sessionExit || null,
  };
  try {
    if (perfHistory.length > 0 && androidSession) {
      const disp = reportsDataJs.formatReportAppId(
        androidSession.packageName,
        androidSession.appLabel,
      );
      const payload = {
        device: {
          name: androidSession.deviceLabel,
          bundleId: disp,
          appName: disp,
          category: 'android',
          deviceId: androidSession.deviceId || '',
          udid: '',
        },
        // 1.5 报告合并：collector 的「分片 + 内存尾部」与主进程逐拍累积
        // 都包含内存尾部，不能 concat（会重复）。取更完整的一份：
        // 分片全部成功时两者等长；万一写盘失败，主进程那份仍是全量。
        perf: (androidSpilled.length >= perfHistory.length
          ? androidSpilled : snapshotArr(perfHistory)),
        tag: snapshotArr(androidTags),
        // 采集参数配置：报告端据此隐藏被移除指标的图表与指标行；metricOrder 据此重排
        metricConfig: androidSession.metricConfig || null,
        metricOrder: androidSession.metricOrder || null,
        shots: troughShots.getShots('android'),
        // 采集期诊断（逐拍耗时 / 历史截断 / UID）：写进口径元数据，
        // 让「采样点变稀」「长时丢点」有据可查，而不是靠猜
        diagnostics: androidDiag || undefined,
        // 1.1 设备自报峰值刷新率：目标帧率优先用它，而不是 FPS 序列 P95；
        // 报告里同时标出来源，避免把「主动锁 30fps」误判成「达标 30 帧」。
        displayProfile: (androidDiag && androidDiag.displayProfile) || undefined,
        // 2.1 旁路取证片段（开启过才有）：报告页给出「取证片段」入口
        traceCaptures: (traceCapture && traceCapture.list().length)
          ? traceCapture.list() : undefined,
        // 会话级指标：冷启动耗时 + 本轮 ANR/崩溃（都没有则不写字段）
        session: (sessionInfo.launch || sessionInfo.exit) ? sessionInfo : undefined,
        // 采集期间开过弱网才带这一段，报告页据此追加「弱网总结分析」
        weaknet: weaknet || undefined,
      };
      const dataJsPath = reportsDataJs.writeDataJs(payload);
      // 异步导出：12 小时报告要建 510 万单元格，同步做会让窗口卡死好几秒
      await _writeRunXlsxSafe(payload, dataJsPath, 'collect-log');
    }
  } catch (e) {
    console.error('[reports/data.js]', e.message);
  }
  return { ok: true };
});

ipcMain.handle('export-data', async (_event, format) => {
  if (perfHistory.length === 0) return { ok: false, reason: '没有数据可导出' };

  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: '导出性能数据',
    defaultPath: `perf_${Date.now()}.${format || 'csv'}`,
    filters: [
      { name: 'CSV', extensions: ['csv'] },
      { name: 'JSON', extensions: ['json'] },
    ],
  });

  if (canceled || !filePath) return { ok: false, reason: '已取消' };

  try {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.json') {
      fs.writeFileSync(filePath, JSON.stringify({ perf: perfHistory, tag: androidTags || [] }, null, 2), 'utf8');
    } else {
      fs.writeFileSync(filePath, Exporter.toCSV(perfHistory), 'utf8');
    }
    return { ok: true, filePath };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

ipcMain.handle('pc-pick-exe', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: '选择要监控的可执行文件',
    filters: [
      { name: '可执行文件', extensions: ['exe', 'EXE'] },
      { name: '所有文件', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (canceled || !filePaths || !filePaths[0]) return { ok: false };
  return { ok: true, path: filePaths[0] };
});

ipcMain.handle('pc-start-collect', async (_e, exePath, metricConfig) => {
  const trial = trialSession.canStartCollect(app, getMachineUid, activationStore, readConfigOut);
  if (!trial.ok) return { ok: false, reason: trial.reason };
  if (trial.remainingSec != null && mainWindow && !mainWindow.isDestroyed()) {
    const s = Math.max(0, Math.floor(Number(trial.remainingSec) || 0));
    mainWindow.webContents.send('pc-collect-log', `试用剩余: ${s}s`);
  }
  if (pcCollector) {
    try {
      pcCollector.stop('restart');
    } catch (_) {}
    pcCollector = null;
  }
  const raw = String(exePath || '').trim();
  const abs = path.normalize(path.resolve(raw));
  if (!raw || !fs.existsSync(abs)) {
    return { ok: false, reason: '可执行文件不存在' };
  }
  const label = path.basename(abs) || 'PC';
  const mc = metricConfig && typeof metricConfig === 'object'
    ? PcCollectorMod.normalizePcMetricConfig(metricConfig)
    : null;
  pcSession = { exePath: abs, label, metricConfig: mc, metricOrder: extractMetricOrder(metricConfig) };
  pcCollector = new PcCollector(abs, mc);
  startWeaknetTracking('pc');
  pcCollector.on('log', (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pc-collect-log', msg);
    }
  });
  pcCollector.on('data', (data) => {
    pcPerfHistory.push(data);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pc-perf-data', data);
    }
  });
  pcCollector.on('stopped', (payload) => {
    trialSession.onCollectStopped();
    pcCollector = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pc-collect-stopped', payload);
    }
  });
  pcCollector.on('script-error', (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pc-collect-error', String(msg));
    }
  });
  try {
    await pcCollector.start();
  } catch (e) {
    pcCollector = null;
    pcSession = null;
    return { ok: false, reason: e.message || String(e) };
  }
  trialSession.onCollectStarted(app, getMachineUid, activationStore, readConfigOut, sendToRendererWithTrialLog);
  return { ok: true };
});

ipcMain.handle('pc-stop-collect', async () => {
  trialSession.onCollectStopped();
  if (pcCollector) {
    try {
      pcCollector.stop();
    } catch (e) {
      console.error('[pc-stop-collect]', e.message);
    }
    pcCollector = null;
  }
  const weaknet = stopWeaknetTracking();
  try {
    if (pcPerfHistory.length > 0 && pcSession) {
      const payload = buildPcReportDataJsPayload(
        pcSession, pcPerfHistory, pcTags, getMachineUid(), pcSession.metricConfig,
      );
      payload.weaknet = weaknet || undefined;
      const dataJsPath = reportsDataJs.writeDataJs(payload);
      await _writeRunXlsxSafe(payload, dataJsPath, 'pc-collect-log');
    }
  } catch (e) {
    console.error('[reports/data.js]', e.message);
  }
  return { ok: true };
});

ipcMain.handle('pc-clear-history', async () => {
  pcPerfHistory = [];
  pcTags = [];
  return { ok: true };
});

ipcMain.handle('export-pc-data', async (_e, format) => {
  if (pcPerfHistory.length === 0) return { ok: false, reason: '没有数据可导出' };

  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: '导出 PC 性能数据',
    defaultPath: `pc_perf_${Date.now()}.${format || 'csv'}`,
    filters: [
      { name: 'CSV', extensions: ['csv'] },
      { name: 'JSON', extensions: ['json'] },
    ],
  });

  if (canceled || !filePath) return { ok: false, reason: '已取消' };

  try {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.json') {
      fs.writeFileSync(
        filePath,
        JSON.stringify({ perf: pcPerfHistory, tag: pcTags || [] }, null, 2),
        'utf8',
      );
    } else {
      fs.writeFileSync(filePath, Exporter.toCSV(pcPerfHistory), 'utf8');
    }
    return { ok: true, filePath };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

// ─── iOS IPC Handlers ─────────────────────────────────────────────────────────

const iosLog = require('./src/ios-logger');

ipcMain.handle('ios-get-devices', async () => {
  const iosBin = IosCollector.resolveIosBin();
  iosLog.write(`[get-devices] iosBin=${iosBin || 'NOT FOUND'}`);
  if (!iosBin) return [];
  return new Promise(resolve => {
    execFile(iosBin, ['list'], { timeout: 6000 }, (err, stdout, stderr) => {
      if (stderr) iosLog.write(`[get-devices stderr] ${stderr.trim()}`);
      if (err) {
        iosLog.write(`[get-devices error] ${err.message}`);
        return resolve([]);
      }
      iosLog.write(`[get-devices stdout] ${stdout.trim()}`);
      (async () => {
        try {
          const data = JSON.parse(stdout);
          const list = data.deviceList || [];
          const base = list.map((d) => {
            if (typeof d === 'string') return { udid: d, name: null };
            const udid = d.Udid || d.udid || d;
            const u = typeof udid === 'string' ? udid : String(udid || '');
            const name = d.DeviceName || d.deviceName || null;
            return { udid: u, name: name || null };
          });
          const enriched = await Promise.all(
            base.map(async (item) => {
              let name = item.name;
              if (!name) {
                try {
                  const info = await IosCollector.getLockdownDeviceInfo(item.udid);
                  if (info && info.name) name = info.name;
                } catch (_) {}
              }
              return { udid: item.udid, name: name || null };
            })
          );
          resolve(enriched);
        } catch (e) {
          iosLog.write(`[get-devices parse error] ${e.message}`);
          resolve([]);
        }
      })();
    });
  });
});

ipcMain.handle('ios-get-apps', async () => {
  const iosBin = IosCollector.resolveIosBin();
  iosLog.write(`[get-apps] iosBin=${iosBin || 'NOT FOUND'}`);
  if (!iosBin) {
    return [];
  }

  function resolveAppslistTxtPath() {
    for (const p of [
      path.join(process.resourcesPath || '', 'ios-tools', 'appslist.txt'),
      path.join(__dirname, 'ios-tools', 'appslist.txt'),
      path.join(__dirname, '..', 'ios-tools', 'appslist.txt'),
    ]) {
      try {
        if (p && fs.existsSync(p)) return p;
      } catch (_) {}
    }
    return null;
  }

  function parseAppslistTxt(raw) {
    return parseIrregularAppsStreamToApps(raw);
  }

  // 注意：ios-get-apps 可能产出超大 stdout；此处不再往“日志台”打印，避免卡顿。

  function parseIosExeAppsText(raw) {
    return parseIrregularAppsStreamToApps(raw);
  }

  /**
   * 解析 appslist.txt / ios.exe apps --all 的“不规则字符串”。
   *
   * 约束：不按 key-value 正则匹配（它不是 JSON、也不是数组），只按顺序扫描字符串并读取下一段引号内文本。
   *
   * 规则（按出现顺序）：
   * - 遇到 bundleKey（如 `"CFBundleIdentifier":"`）→ 作为新条目的 bundleID（会先 flush 上一个条目）
   * - 遇到 nameKey（如 `"CFBundleName":"` / `"CFBundleDisplayName":"`）→ 作为最近条目的 name（若尚未赋值）
   */
  function parseIrregularAppsStreamToApps(raw) {
    const out = [];
    if (!raw) return out;
    const s = String(raw);

    const BUNDLE_KEYS = [
      '"CFBundleIdentifier":"',
      '"BundleID":"',
      '"bundleID":"',
    ];
    const NAME_KEYS = [
      '"CFBundleDisplayName":"',
      '"CFBundleName":"',
      '"Name":"',
      '"name":"',
    ];

    function readQuotedValue(startIdx) {
      let j = startIdx;
      let val = '';
      while (j < s.length) {
        const ch = s[j];
        if (ch === '"') break;
        val += ch;
        j++;
      }
      return { value: val, endIdx: j < s.length ? j + 1 : j };
    }

    function findNextKey(fromIdx) {
      let bestIdx = -1;
      let bestKey = null;
      let bestKind = null;
      for (const k of BUNDLE_KEYS) {
        const idx = s.indexOf(k, fromIdx);
        if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) {
          bestIdx = idx;
          bestKey = k;
          bestKind = 'bundle';
        }
      }
      for (const k of NAME_KEYS) {
        const idx = s.indexOf(k, fromIdx);
        if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) {
          bestIdx = idx;
          bestKey = k;
          bestKind = 'name';
        }
      }
      return { idx: bestIdx, key: bestKey, kind: bestKind };
    }

    let pendingBundleID = '';
    let pendingName = '';
    function flush() {
      const bid = String(pendingBundleID || '').trim();
      if (!bid) return;
      out.push({ name: String(pendingName || '').trim(), bundleID: bid, execName: '' });
      pendingBundleID = '';
      pendingName = '';
    }

    let i = 0;
    while (i < s.length) {
      const { idx, key, kind } = findNextKey(i);
      if (idx < 0 || !key) break;
      const start = idx + key.length;
      const r = readQuotedValue(start);
      const v = String(r.value || '').trim();
      i = r.endIdx;
      if (!v) continue;
      if (kind === 'bundle') {
        flush();
        pendingBundleID = v;
        continue;
      }
      if (kind === 'name') {
        if (!pendingName) pendingName = v;
        continue;
      }
    }
    flush();

    // 去重（bundleID）但保序
    const dedup = [];
    const seen = new Set();
    for (const a of out) {
      const bid = a && a.bundleID ? String(a.bundleID).trim() : '';
      if (!bid || seen.has(bid)) continue;
      seen.add(bid);
      dedup.push({ name: a.name || '', bundleID: bid, execName: '' });
    }
    return dedup;
  }

  /** 流式解析：避免 stdout 过大导致 maxBuffer / 内存问题 */
  function createIrregularAppsStreamParser() {
    const BUNDLE_KEYS = [
      '"CFBundleIdentifier":"',
      '"BundleID":"',
      '"bundleID":"',
    ];
    const NAME_KEYS = [
      '"CFBundleDisplayName":"',
      '"CFBundleName":"',
      '"Name":"',
      '"name":"',
    ];
    let buf = '';
    let scanIdx = 0;
    let pendingBundleID = '';
    let pendingName = '';
    const out = [];

    function readQuotedValue(str, startIdx) {
      let j = startIdx;
      let val = '';
      while (j < str.length) {
        const ch = str[j];
        if (ch === '"') break;
        val += ch;
        j++;
      }
      if (j >= str.length) return null; // incomplete
      return { value: val, endIdx: j + 1 };
    }

    function findNextKey(str, fromIdx) {
      let bestIdx = -1;
      let bestKey = null;
      let bestKind = null;
      for (const k of BUNDLE_KEYS) {
        const idx = str.indexOf(k, fromIdx);
        if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) {
          bestIdx = idx;
          bestKey = k;
          bestKind = 'bundle';
        }
      }
      for (const k of NAME_KEYS) {
        const idx = str.indexOf(k, fromIdx);
        if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) {
          bestIdx = idx;
          bestKey = k;
          bestKind = 'name';
        }
      }
      return { idx: bestIdx, key: bestKey, kind: bestKind };
    }

    function flush() {
      const bid = String(pendingBundleID || '').trim();
      if (!bid) return;
      out.push({ name: String(pendingName || '').trim(), bundleID: bid, execName: '' });
      pendingBundleID = '';
      pendingName = '';
    }

    function process() {
      while (scanIdx < buf.length) {
        const { idx, key, kind } = findNextKey(buf, scanIdx);
        if (idx < 0 || !key) break;
        const start = idx + key.length;
        const r = readQuotedValue(buf, start);
        if (!r) {
          // value incomplete: keep from key start
          buf = buf.slice(idx);
          scanIdx = 0;
          return;
        }
        const v = String(r.value || '').trim();
        scanIdx = r.endIdx;
        if (!v) continue;
        if (kind === 'bundle') {
          flush();
          pendingBundleID = v;
        } else if (kind === 'name') {
          if (!pendingName) pendingName = v;
        }
      }
      // shrink buffer: keep a tail to handle split keys across chunks
      const KEEP = 8192;
      if (buf.length > KEEP) {
        buf = buf.slice(buf.length - KEEP);
        scanIdx = Math.max(0, scanIdx - (buf.length - KEEP));
      }
    }

    return {
      push: (chunk) => {
        buf += String(chunk || '');
        process();
      },
      finish: () => {
        flush();
        // dedup keep order
        const dedup = [];
        const seen = new Set();
        for (const a of out) {
          const bid = a && a.bundleID ? String(a.bundleID).trim() : '';
          if (!bid || seen.has(bid)) continue;
          seen.add(bid);
          dedup.push({ name: a.name || '', bundleID: bid, execName: '' });
        }
        return dedup;
      },
    };
  }

  return new Promise(resolve => {
    const parser = createIrregularAppsStreamParser();
    let stdoutLen = 0;
    let stderrLen = 0;
    let stderrBuf = '';

    const child = spawn(iosBin, ['apps', '--all'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (buf) => {
      const s = buf.toString('utf8');
      stdoutLen += s.length;
      parser.push(s);
    });

    child.stderr.on('data', (buf) => {
      const s = buf.toString('utf8');
      stderrLen += s.length;
      stderrBuf += s;
      // 控制 stderrBuf 增长，避免内存无限增大
      if (stderrBuf.length > 20000) stderrBuf = stderrBuf.slice(-20000);
    });

    child.on('error', (e) => {
      resolve([]);
    });

    child.on('close', (code) => {
      const apps = parser.finish();
      if (apps.length > 0) {
        return resolve(apps);
      }

      // 兜底 appslist.txt
      const p = resolveAppslistTxtPath();
      if (p) {
        try {
          const txt = fs.readFileSync(p, 'utf8');
          const fallbackApps = parseAppslistTxt(txt);
          if (fallbackApps.length > 0) {
            return resolve(fallbackApps);
          }
        } catch (e2) {
        }
      } else {
      }
      resolve([]);
    });
  });
});

// 未换设备/应用时不清空 iosPerfHistory；清空见 ios-clear-history
ipcMain.handle('ios-start-collect', async (_event, bundleId, execName, appName, udid, metricConfig) => {
  const trial = trialSession.canStartCollect(app, getMachineUid, activationStore, readConfigOut);
  if (!trial.ok) return { ok: false, reason: trial.reason };
  if (trial.remainingSec != null && mainWindow && !mainWindow.isDestroyed()) {
    const s = Math.max(0, Math.floor(Number(trial.remainingSec) || 0));
    mainWindow.webContents.send('ios-collect-log', `试用剩余: ${s}s`);
  }
  if (iosCollector) iosCollector.stop();
  const mc = metricConfig && typeof metricConfig === 'object'
    ? IosCollector.normalizeMetricConfig(metricConfig)
    : null;
  iosSession = {
    bundleId,
    execName: execName || '',
    appName: appName || bundleId,
    udid: udid != null ? String(udid).trim() : '',
    metricConfig: mc,
    metricOrder: extractMetricOrder(metricConfig),
  };
  iosLog.separator(`ios-start-collect bundleId=${bundleId} execName=${execName || ''}`);

  iosCollector = new IosCollector(bundleId, execName || '', mc);
  startWeaknetTracking('ios');
  _shotWarned.delete('ios');
  troughShots.beginRun(getBundledReportsDir(), 'ios', bundleId, Date.now());
  iosCollector.on('log', msg => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('ios-collect-log', msg);
  });
  iosCollector.on('data', data => {
    iosPerfHistory.push(data);
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('ios-perf-data', data);
    _pushTroughShot('ios', data, () => require('./src/ios-screen').captureIosScreen(iosSession.udid), 'ios-collect-log');
  });
  iosCollector.on('sysmon-missing', () => {
    iosLog.write('[ios] 收到 {"code":0}，未匹配到目标进程 — 停止采集');
    trialSession.onCollectStopped();
    iosCollector = null;
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('ios-collect-stopped', { reason: 'sysmon-missing' });
  });
  iosCollector.on('error', err => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('ios-collect-error', err.message);
  });

  try {
    await iosCollector.start();
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  trialSession.onCollectStarted(app, getMachineUid, activationStore, readConfigOut, sendToRendererWithTrialLog);
  return { ok: true };
});

ipcMain.handle('ios-clear-history', async () => {
  iosPerfHistory = [];
  iosTags = [];
  return { ok: true };
});

ipcMain.handle('ios-stop-collect', async () => {
  trialSession.onCollectStopped();
  if (iosCollector) {
    try {
      iosCollector.stop();
    } catch (e) {
      console.error('[ios-stop-collect]', e.message);
    }
    iosCollector = null;
  }
  const weaknet = stopWeaknetTracking();
  try {
    if (iosPerfHistory.length > 0 && iosSession) {
      const disp = reportsDataJs.formatReportAppId(
        iosSession.bundleId,
        iosSession.appName,
      );
      const payload = {
        device: {
          name: 'iPhone',
          bundleId: disp,
          appName: disp,
          category: 'ios',
          deviceId: '',
          udid: iosSession.udid || '',
        },
        perf: snapshotArr(iosPerfHistory),
        tag: snapshotArr(iosTags),
        metricConfig: iosSession.metricConfig || null,
        metricOrder: iosSession.metricOrder || null,
        shots: troughShots.getShots('ios'),
        weaknet: weaknet || undefined,
      };
      const dataJsPath = reportsDataJs.writeDataJs(payload);
      await _writeRunXlsxSafe(payload, dataJsPath, 'ios-collect-log');
    }
  } catch (e) {
    console.error('[reports/data.js]', e.message);
  }
  iosLog.write('[ios-stop-collect] stopped');
  return { ok: true };
});

ipcMain.handle('ios-export-data', async (_event, format) => {
  if (iosPerfHistory.length === 0) return { ok: false, reason: '没有数据可导出' };

  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: '导出 iOS 性能数据',
    defaultPath: `ios_perf_${Date.now()}.${format || 'csv'}`,
    filters: [
      { name: 'CSV', extensions: ['csv'] },
      { name: 'JSON', extensions: ['json'] },
    ],
  });

  if (canceled || !filePath) return { ok: false, reason: '已取消' };

  try {
    const ext = path.extname(filePath).toLowerCase();
    const content = ext === '.json'
      ? JSON.stringify({ perf: iosPerfHistory, tag: iosTags || [] }, null, 2)
      : _iosToCSV(iosPerfHistory);
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true, filePath };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

// ─── iOS GPU IPC Handlers ─────────────────────────────────────────────────────

ipcMain.handle('ios-gpu-clear-history', async () => {
  iosGpuHistory = [];
  iosGpuTags = [];
  return { ok: true };
});

// 同一页面未换设备/应用时不在此清空 iosGpuHistory，多次开始与图表均接续上一轮数据；清空见 ios-gpu-clear-history（换设备/换应用）
ipcMain.handle('ios-gpu-start-collect', async (_event, meta) => {
  const trial = trialSession.canStartCollect(app, getMachineUid, activationStore, readConfigOut);
  if (!trial.ok) return { ok: false, reason: trial.reason };
  if (trial.remainingSec != null && mainWindow && !mainWindow.isDestroyed()) {
    const s = Math.max(0, Math.floor(Number(trial.remainingSec) || 0));
    mainWindow.webContents.send('ios-gpu-log', `试用剩余: ${s}s`);
  }
  if (iosGpuCollector) iosGpuCollector.stop();
  iosGpuSession = meta && typeof meta === 'object'
    ? {
        bundleId: meta.bundleId || '',
        appName: meta.appName || meta.bundleId || '',
        udid: meta.udid || '',
        metricConfig: (meta.metricConfig && typeof meta.metricConfig === 'object')
          ? meta.metricConfig
          : null,
        metricOrder: extractMetricOrder(meta && meta.metricConfig),
      }
    : null;
  // iOS GPU 页只有一组指标：未勾选时无需采集（此时也没有任何可用数据）
  if (iosGpuSession && iosGpuSession.metricConfig && iosGpuSession.metricConfig.gpu === false) {
    iosGpuSession = null;
    return { ok: false, reason: '已在「采集参数」中移除 GPU，本次无可采集的参数' };
  }
  iosLog.separator('ios-gpu-start-collect');

  iosGpuCollector = new IosGpuCollector();
  startWeaknetTracking('ios_gpu');
  iosGpuCollector.on('log', msg => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('ios-gpu-log', msg);
  });
  iosGpuCollector.on('data-batch', batch => {
    if (!Array.isArray(batch)) return;
    for (const d of batch) iosGpuHistory.push(d);
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('ios-gpu-data-batch', batch);
  });
  iosGpuCollector.on('error', err => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('ios-gpu-error', err.message);
  });

  try {
    await iosGpuCollector.start(iosGpuSession);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  trialSession.onCollectStarted(app, getMachineUid, activationStore, readConfigOut, sendToRendererWithTrialLog);
  const m = iosGpuCollector.iosMajor;
  return { ok: true, iosGpuMajor: typeof m === 'number' ? m : 0 };
});

ipcMain.handle('ios-gpu-stop-collect', async () => {
  trialSession.onCollectStopped();
  // 先 stop 采集器：iOS17+ 会 flush 缓冲行并 emit data-batch，主进程才能把最后一段并入 iosGpuHistory
  if (iosGpuCollector) {
    try {
      iosGpuCollector.stop();
    } catch (e) {
      console.error('[ios-gpu-stop-collect]', e.message);
    }
    iosGpuCollector = null;
  }
  const weaknet = stopWeaknetTracking();
  try {
    if (iosGpuHistory.length > 0 && iosGpuSession) {
      const disp = reportsDataJs.formatReportAppId(
        iosGpuSession.bundleId,
        iosGpuSession.appName,
      );
      const payload = {
        device: {
          name: 'iPhone',
          bundleId: disp,
          appName: disp,
          category: 'ios_gpu',
          deviceId: '',
          udid: iosGpuSession.udid || '',
        },
        perf: snapshotArr(iosGpuHistory),
        tag: snapshotArr(iosGpuTags),
        metricConfig: iosGpuSession.metricConfig || null,
        metricOrder: iosGpuSession.metricOrder || null,
        weaknet: weaknet || undefined,
      };
      const dataJsPath = reportsDataJs.writeDataJs(payload);
      await _writeRunXlsxSafe(payload, dataJsPath, 'ios-collect-log');
    }
  } catch (e) {
    console.error('[reports/data.js]', e.message);
  }
  iosLog.write('[ios-gpu-stop-collect] stopped');
  return { ok: true };
});

ipcMain.handle('ios-gpu-export-data', async (_event, format) => {
  if (iosGpuHistory.length === 0) return { ok: false, reason: '没有数据可导出' };

  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: '导出 iOS GPU 性能数据',
    defaultPath: `ios_gpu_${Date.now()}.${format || 'csv'}`,
    filters: [
      { name: 'CSV', extensions: ['csv'] },
      { name: 'JSON', extensions: ['json'] },
    ],
  });

  if (canceled || !filePath) return { ok: false, reason: '已取消' };

  try {
    const ext = path.extname(filePath).toLowerCase();
    const content = ext === '.json'
      ? JSON.stringify({ perf: iosGpuHistory, tag: iosGpuTags || [] }, null, 2)
      : _iosGpuToCSV(iosGpuHistory);
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true, filePath };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

function _iosGpuToCSV(rows) {
  if (rows.length === 0) return '';
  // Collect all unique keys from all rows (GPU metrics vary by device)
  const keySet = new Set(['timestamp', 'time']);
  rows.forEach(r => Object.keys(r).forEach(k => keySet.add(k)));
  const keys = [...keySet];
  const header = keys.map(k => `"${k}"`).join(',');
  const lines  = rows.map(r => keys.map(k => {
    const v = r[k];
    return v == null ? '' : (typeof v === 'string' ? `"${v}"` : v);
  }).join(','));
  return [header, ...lines].join('\n');
}

// ─── Activation (perfPilot 激活码，与 generate_activation_code.py 一致) ───────


ipcMain.handle('get-app-name', () => ({ appname: readAppNameFromReports() }));

ipcMain.handle('get-config-out', () => {
  const c = readConfigOut();
  if (activationStore.isServerTrialDisabled(app)) {
    return { ...c, unactivatedTrialSec: 0 };
  }
  return c;
});

ipcMain.handle('get-machine-uid', () => getMachineUid());


/** 与 extraResources 中 reports 一致：开发为项目下 reports，打包后为 resources/reports */
function getBundledReportsDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'reports');
  }
  return path.join(__dirname, 'reports');
}

ipcMain.handle('get-reports-path-info', () => {
  const reportsDir = getBundledReportsDir();
  const defaultPath = path.join(reportsDir, 'perf.html');
  return {
    reportsDir,
    defaultFile: 'perf.html',
    defaultPath,
    defaultExists: fs.existsSync(defaultPath),
  };
});

ipcMain.handle('open-local-report', async (_e, fileName) => {
  const safe = path.basename(fileName || 'perf.html');
  const full = path.join(getBundledReportsDir(), safe);
  if (!fs.existsSync(full)) {
    return { ok: false, reason: `未找到文件：${full}` };
  }
  // 报告库是交互页面（要能删除归档），用独立窗口 + preload 打开；
  // 其他报告页只读，仍交给系统默认浏览器。
  if (safe === 'library.html') {
    return openLibraryWindow();
  }
  try {
    // file:// + openExternal：由系统用默认浏览器打开 HTML（openPath 可能关联到编辑器）
    await shell.openExternal(pathToFileURL(full).href);
    return { ok: true, path: full };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
});

// 顶部署名链接：地址写死在主进程，不接受渲染进程传入的 URL
const ATTRIBUTION_URL = 'https://github.com/charmingLitteDeveloper/perfara';
ipcMain.handle('open-attribution-link', async () => {
  try {
    await shell.openExternal(ATTRIBUTION_URL);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
});

/* ══════════════════════════════════════════════════════════════════
 * 弱网测试（WeakNet）—— 引擎随包携带、以无窗口方式运行，
 * 界面在采集窗口里（二级页面），请求统一经这里转发。
 *
 * 渲染进程不直接出网：控制接口没有 CORS 头，页面里 fetch 127.0.0.1 会被拦；
 * 而且端口可能顺延，得由这里拿到握手后的实际端口再转发。
 * ══════════════════════════════════════════════════════════════════ */

/** 弱网工具目录：打包后 resources/weaknet；开发态直接指向仓库里同一份（不进 asar） */
function getWeaknetDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'weaknet');
  }
  return path.join(__dirname, '..', '..', 'perfara', 'collector', 'resources', 'weaknet');
}

/** 让 WeakNet 用到本包自带的 adb：它按 PATH 找 adb.exe，这里只给子进程加目录 */
function weaknetEnv() {
  const env = { ...process.env };
  // 父进程带 ELECTRON_RUN_AS_NODE 时，Electron 系进程会退化；WeakNet 是普通 exe，
  // 但同一套环境变量可能被它的 pyinstaller 引导程序读取，统一清掉更稳。
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const adbDir = app.isPackaged
    ? path.join(process.resourcesPath, 'adb', 'win')
    : path.join(__dirname, '..', '..', 'perfara', 'collector', 'resources', 'adb', 'win');
  if (fs.existsSync(adbDir)) {
    env.PATH = adbDir + path.delimiter + (env.PATH || '');
  }
  return env;
}

/**
 * 启动规格：打包态用随包 WeakNet.exe；未打包时若 PERFARA_WEAKNET_SRC 指向 WeakNet
 * 源码目录，就跑 `python weaknet_gui.py`（改引擎时不必先重打 exe）。
 */
function weaknetLaunchSpec() {
  const dir = getWeaknetDir();
  const src = process.env.PERFARA_WEAKNET_SRC;
  if (!app.isPackaged && src) {
    const py = path.join(src, 'weaknet_gui.py');
    if (fs.existsSync(py)) {
      return { command: 'python', args: [py, '--headless'], cwd: src, env: weaknetEnv() };
    }
  }
  return { command: path.join(dir, 'WeakNet.exe'), args: ['--headless'], cwd: dir, env: weaknetEnv() };
}

/**
 * 引擎意外退出（崩溃/被杀）时告诉页面，别让界面一直显示过期的「限速中」。
 * 手机还指着这个引擎时先把手机代理还原：端口已经没人监听，不还原等于让手机断网。
 */
weaknetHost.setExitHandler((info, code) => {
  // 引擎死了，系统代理还指着它的端口就是整机断网：按开启前的快照还回去
  // （正常关闭时 shutdown 已经让引擎解除过、快照也已清掉，这里无事可做）
  try { sysproxy.restoreStale(sysproxyBackupFile()); } catch (_) {}
  phoneProxy.restoreAll().catch(() => {}).then(() => {
    try { weaknetTracker.setPhoneUsb(false); } catch (_) {}
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('weaknet-engine-exit', { ...info, code });
    }
  });
});

ipcMain.handle('weaknet-launch', async () => {
  try {
    return await weaknetHost.ensure(weaknetLaunchSpec());
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
});

/** 页面 → 主进程 → 引擎控制接口。path 走白名单，见 src/weaknet-host.js */
ipcMain.handle('weaknet-api', async (_e, req) => {
  const r = req && typeof req === 'object' ? req : {};
  try {
    const p = String(r.path || '');
    // 接管本机流量前存一份注册表原值：引擎被强杀时 atexit 不跑，
    // 没有这份快照整机代理就永远停在 127.0.0.1:<引擎端口>
    const togglingProxy = p === '/api/sysproxy';
    const enableProxy = !!(r.body && r.body.enable);
    if (togglingProxy && enableProxy) {
      const info = weaknetHost.currentInfo();
      try { sysproxy.snapshot(sysproxyBackupFile(), (info && info.proxyPort) || weaknetHost.DEFAULT_PROXY_PORT); } catch (_) {}
    }
    const data = await weaknetHost.call(p, r.body, { port: r.port });
    // 引擎自己已经还原并清好了，快照留着反而会在下次启动时误还原
    if (togglingProxy && !enableProxy) { try { sysproxy.clearBackup(sysproxyBackupFile()); } catch (_) {} }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
});

ipcMain.handle('weaknet-engine-stop', async () => {
  try {
    // 页面启动时会静默探一次已在跑的引擎（典型是上次没退干净的实例），那条路径不经过
    // ensure，主进程这边没有记录。用户点「停止弱网」就是要它停，先补一次接管再收。
    if (!weaknetHost.isAlive()) {
      try {
        await weaknetHost.adopt(weaknetHost.DEFAULT_CTRL_PORT, weaknetLaunchSpec().command);
      } catch (_) {}
    }
    const r = await weaknetHost.shutdown();
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
});

/**
 * 手机（USB）弱网接管：只用 adb，手机不装东西。
 * 代理端口取引擎握手后的实际值（被占时引擎会顺延），不能盲猜 8888。
 */
ipcMain.handle('weaknet-phone', async (_e, req) => {
  const r = req && typeof req === 'object' ? req : {};
  const action = String(r.action || 'status');
  // restore 一次还原所有被接管的手机，不带设备号；其余动作必须带合法设备号
  const bad = action === 'restore'
    ? null
    : invalidAdbArgs(r.deviceId == null ? '' : r.deviceId, null);
  if (bad) return { ok: false, stage: 'device', msg: bad };
  const deviceId = String(r.deviceId);
  try {
    // 采集期间接管/解除手机，报告里的来源标签要跟着变，不能停在开始采集那一刻
    const syncPhoneUsb = () => {
      try {
        const dev = androidSession && androidSession.deviceId;
        weaknetTracker.setPhoneUsb(!!(dev && phoneProxy.heldPort(dev)));
      } catch (_) {}
    };
    if (action === 'connect') {
      // 接管本来就要引擎在跑，不该让用户先跑去点别的按钮：不在就自己拉起来。
      // 拉不起来才报错，并把启动失败的原因原样带回去（多半是 exe 缺失 / 被杀软拦了）。
      let info = weaknetHost.currentInfo();
      if (!info || !(await weaknetHost.probe(info.ctrlPort))) {
        let started;
        try { started = await weaknetHost.ensure(weaknetLaunchSpec()); }
        catch (e) { started = { ok: false, reason: e.message || String(e) }; }
        info = weaknetHost.currentInfo();
        if (!started || !started.ok || !info || !(await weaknetHost.probe(info.ctrlPort))) {
          return {
            ok: false, stage: 'engine',
            msg: '弱网引擎没有在运行，自动启动也没成功',
            hint: ((started && (started.reason || started.msg)) || '')
              + '（引擎起不来，手机接管会把手机关进死端口，所以先拒绝；可先点「开启限速」排查引擎本身）',
          };
        }
      }
      const res = await phoneProxy.connect({ deviceId, proxyPort: info.proxyPort });
      if (res && res.ok) syncPhoneUsb();
      return res;
    }
    if (action === 'disconnect') {
      const res = await phoneProxy.disconnect({ deviceId });
      // 下拉框可能已经切到别的手机：账本里还挂着代理的那几台一起收干净，
      // 否则选中项一换，「解除」清的不是真正被接管的那台
      const rest = await phoneProxy.restoreAll();
      syncPhoneUsb();
      if (!rest.length) return res;
      const merged = Object.assign({}, res, {
        restoredOthers: rest.map((x) => ({ deviceId: x.deviceId, ok: !!(x && x.ok), msg: (x && x.msg) || '' })),
      });
      const failed = rest.find((x) => x && !x.ok);
      if (failed) {
        merged.ok = false;
        merged.stage = (res && res.stage) || failed.stage || 'verify';
        merged.msg = (merged.msg ? merged.msg + '；' : '') + '还有手机没还原干净（' + failed.deviceId
          + (failed.msg ? '：' + failed.msg : '') + '）';
        merged.hint = merged.hint || failed.hint || '';
      }
      return merged;
    }
    if (action === 'restore') {
      // 「停止弱网」要把所有接管过的手机一起还原：页面不知道接管过哪些设备
      const items = await phoneProxy.restoreAll();
      syncPhoneUsb();
      return { ok: true, items };
    }
    return await phoneProxy.status(deviceId);
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
});

/* ══════════════════════════════════════════════════════════════════
 * 本地报告库（history/）—— 独立窗口 + 删除能力
 * 报告库页面是 file:// 静态页，浏览器里没有 fs 权限，
 * 因此删除只能走这里：BrowserWindow + preload-library.js → IPC。
 * ══════════════════════════════════════════════════════════════════ */

let libraryWin = null;

function getHistoryDir() {
  return path.join(getBundledReportsDir(), 'history');
}

/** 报告 id 只允许字母数字下划线连字符，杜绝路径穿越 */
function safeReportId(id) {
  return String(id == null ? '' : id).replace(/[^A-Za-z0-9_\-]/g, '');
}

function readHistoryIndex() {
  const p = path.join(getHistoryDir(), 'index.json');
  if (!fs.existsSync(p)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

/** 同时写 index.json 与 index.js（后者供 file:// 页面用 <script> 直接读） */
function writeHistoryIndex(list) {
  const dir = getHistoryDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(list, null, 2);
  fs.writeFileSync(path.join(dir, 'index.json'), json, 'utf8');
  fs.writeFileSync(path.join(dir, 'index.js'), 'var reportIndex = ' + json + ';\n', 'utf8');
}

function openLibraryWindow() {
  const full = path.join(getBundledReportsDir(), 'library.html');
  if (!fs.existsSync(full)) {
    return { ok: false, reason: `未找到报告库页面：${full}` };
  }
  if (libraryWin && !libraryWin.isDestroyed()) {
    libraryWin.show();
    libraryWin.focus();
    return { ok: true, reused: true, path: full };
  }
  libraryWin = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Perfara离线版 · 报告库',
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-library.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try { libraryWin.setMenuBarVisibility(false); } catch (_) {}
  libraryWin.loadFile(full);
  libraryWin.on('closed', () => { libraryWin = null; });
  return { ok: true, path: full };
}

ipcMain.handle('library-open', async () => openLibraryWindow());

ipcMain.handle('library-history-dir', async () => getHistoryDir());

/** 删除指定报告：<id>.js / <id>.json / <id>.xlsx + 索引条目 */
ipcMain.handle('library-delete-reports', async (_e, ids) => {
  const dir = getHistoryDir();
  const list = (Array.isArray(ids) ? ids : [ids]).map(safeReportId).filter(Boolean);
  if (!list.length) {
    return { ok: false, reason: '未指定要删除的报告', removedIds: [], failed: [] };
  }

  const removedIds = [];
  const failed = [];

  for (const id of list) {
    let clean = true;
    // .xlsx 与报告同 id 同名（2026-11-20 起）：删报告必须连数据表一起删，
    // 否则 history/ 会残留只有 Excel 没有报告的孤立文件。
    for (const ext of ['.js', '.json', '.xlsx']) {
      const f = path.join(dir, id + ext);
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch (err) {
        // 数据表常被 Excel 占用（Windows 下 EBUSY）：它是可再生的附属文件，
        // 失败不能把报告卡在「.js 已删、索引还在」的半死状态，只跳过、不阻断。
        if (ext === '.xlsx') continue;
        clean = false;
        failed.push(path.basename(f) + '：' + (err && err.message ? err.message : String(err)));
      }
    }
    if (clean) removedIds.push(id);
  }

  if (removedIds.length) {
    try {
      const gone = new Set(removedIds);
      writeHistoryIndex(readHistoryIndex().filter(m => !gone.has(safeReportId(m && m.id))));
    } catch (err) {
      failed.push('索引更新失败：' + (err && err.message ? err.message : String(err)));
    }
  }

  return { ok: failed.length === 0, removedIds, failed };
});

/** 报告库里「打开详细报告」：交给系统浏览器，不占用报告库窗口 */
ipcMain.handle('library-open-report', async (_e, id) => {
  const safe = safeReportId(id);
  if (!safe) return { ok: false, reason: '报告 id 无效' };
  const full = path.join(getBundledReportsDir(), 'perf.html');
  if (!fs.existsSync(full)) return { ok: false, reason: `未找到报告页：${full}` };
  try {
    const url = pathToFileURL(full).href + '?r=' + encodeURIComponent(safe);
    await shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
});

/** 报告库里「打开报告位置」：用系统文件管理器打开该报告的存放目录（有文件则选中） */
ipcMain.handle('library-open-report-location', async (_e, id) => {
  const safe = safeReportId(id);
  if (!safe) return { ok: false, reason: '报告 id 无效' };
  const dir = getHistoryDir();
  const file = path.join(dir, safe + '.js');
  try {
    if (fs.existsSync(file)) {
      await shell.showItemInFolder(file);   // 打开目录并选中该报告文件
      return { ok: true, path: file };
    }
    if (!fs.existsSync(dir)) return { ok: false, reason: `目录不存在：${dir}` };
    await shell.openPath(dir);              // 文件缺失时至少打开目录
    return { ok: true, path: dir };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
});

/**
 * 报告库里「Excel」入口：用系统默认程序直接打开 history/<id>.xlsx。
 * 旧报告（改造前采集）没有同名 xlsx，返回 ok:false 由页面给出提示。
 */
ipcMain.handle('library-open-report-xlsx', async (_e, id) => {
  const safe = safeReportId(id);
  if (!safe) return { ok: false, reason: '报告 id 无效' };
  const file = path.join(getHistoryDir(), safe + '.xlsx');
  if (!fs.existsSync(file)) {
    return { ok: false, reason: '这份报告没有对应的 Excel（旧版本采集或导出失败）' };
  }
  try {
    const err = await shell.openPath(file);   // 返回空串表示成功
    if (err) return { ok: false, reason: err };
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
});

/** 报告库里哪些报告存在同名 Excel：页面据此决定是否显示「Excel」按钮 */
ipcMain.handle('library-xlsx-ids', async () => {
  try {
    const dir = getHistoryDir();
    if (!fs.existsSync(dir)) return { ok: true, ids: [] };
    const ids = fs.readdirSync(dir)
      .filter(f => /\.xlsx$/i.test(f))
      .map(f => f.replace(/\.xlsx$/i, ''))
      .filter(id => !!safeReportId(id));
    return { ok: true, ids };
  } catch (e) {
    return { ok: false, ids: [], reason: e.message || String(e) };
  }
});

/**
 * 报告库里「导出分享报告」：把该报告打包成一个自包含 HTML——
 * perf.html + echarts（内联）+ 该报告数据（内联），单文件即可离线打开、转发，无需任何外部依赖。
 */
function readReportPayload(id) {
  const safe = safeReportId(id);
  const file = path.join(getHistoryDir(), safe + '.js');
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s < 0 || e <= s) return null;
    return JSON.parse(raw.slice(s, e + 1));
  } catch (_) { return null; }
}

/**
 * 把 echarts 内联进报告 HTML，使其成为真正的「零外部依赖」单文件。
 *
 * 两种模板结构都要兼容：
 *   ① 标签式（library.html）：<script src="echarts.min.js"></script>
 *      —— 直接把这个标签替换成内联源码。
 *   ② 异步加载器式（perf.html）：<head> 里是 window.echartsReady 加载器，
 *      内部按「本地文件 → CDN → 空实现」顺序尝试，**没有** src="echarts.min.js" 标签。
 *      —— 把源码内联到 </head> 之前即可：加载器第一件事就是
 *      `if (typeof echarts !== 'undefined') return true;`，检测到内联的 echarts
 *      就不再发起任何网络请求，图表直接可用。
 *
 * 早期实现只认 ①，对 perf.html 完全失效 —— 导出的「单文件分享报告」仍然
 * 外链 cdn.jsdelivr.net，离线打开时图表一片空白（真机走查实测：
 * 体积仅 213KB、canvas 数 0、离线仍发起 CDN 请求）。
 *
 * @param {string} html  模板 HTML
 * @param {string} ecPath echarts.min.js 路径
 * @returns {{ html: string, inlined: boolean }}
 */
function inlineEcharts(html, ecPath) {
  if (!fs.existsSync(ecPath)) {
    // 本地没有 echarts：交给模板自带的 CDN 兜底，不改动 HTML
    return { html, inlined: false };
  }
  const ec = fs.readFileSync(ecPath, 'utf8').replace(/<\/script/gi, '<\\/script');
  const inlineTag = '<script>\n' + ec + '\n</script>';

  // ① 标签式：替换 src="echarts.min.js"
  const EC_TAG = '<script src="echarts.min.js"></script>';
  if (html.includes(EC_TAG)) {
    // 用函数式替换，避免 echarts 源码里的 $& / $' 等被当成替换模式
    return { html: html.replace(EC_TAG, () => inlineTag), inlined: true };
  }

  // ② 异步加载器式：插到 </head> 之前
  const headEnd = html.indexOf('</head>');
  if (headEnd >= 0) {
    return {
      html: html.slice(0, headEnd) + inlineTag + '\n' + html.slice(headEnd),
      inlined: true,
    };
  }
  return { html, inlined: false };
}

/**
 * 分享包脱敏：单文件 HTML 会被转发给同事或外部，设备唯一标识不能跟着走。
 * 只脱 deviceId / udid，不动机型与应用——否则报告失去「什么机器上测的」这个关键上下文。
 * 浅拷贝：perf 数组可能上万点，深拷贝既慢又没必要（只替换 device 这一层）。
 */
function redactSharedPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const out = Object.assign({}, payload);
  if (payload.device && typeof payload.device === 'object') {
    const d = Object.assign({}, payload.device);
    if (d.deviceId) d.deviceId = '已脱敏';
    if (d.udid) d.udid = '已脱敏';
    out.device = d;
  }
  return out;
}

function buildSharedReportHtml(id) {
  const payload = readReportPayload(id);
  if (!payload) return { ok: false, reason: '未找到该报告的数据文件' };
  const dir = getBundledReportsDir();
  const tpl = path.join(dir, 'perf.html');
  const ecPath = path.join(dir, 'echarts.min.js');
  if (!fs.existsSync(tpl)) return { ok: false, reason: `未找到报告模板：${tpl}` };

  let html = fs.readFileSync(tpl, 'utf8');

  // 1) 内联 echarts（本地文件优先；缺失则保留模板里的 CDN 兜底）
  const ec = inlineEcharts(html, ecPath);
  html = ec.html;

  // 2) 内联报告数据：移除「data.js / history/<id>.js」的外部加载
  const mark = '<!-- external: 全局 data';
  const mi = html.indexOf(mark);
  if (mi >= 0) {
    const tagStart = html.indexOf('<script>', mi);
    const tagEnd = tagStart >= 0 ? html.indexOf('</script>', tagStart) : -1;
    if (tagStart >= 0 && tagEnd > tagStart) {
      // 转义 </ 避免提前闭合 script；序列化前先脱敏设备唯一标识
      const json = JSON.stringify(redactSharedPayload(payload)).replace(/<\//g, '<\\/');
      html = html.slice(0, tagStart)
        + '<script>\nvar data = ' + json + ';\n</' + 'script>\n'
        + html.slice(tagEnd + '</script>'.length);
    }
  }

  // 3) 内联 Excel（若与该报告同 id 归档到 history/<id>.xlsx）
  //    分享出去的单文件是纯浏览器环境，不能静默启动本地程序，因此这里只带数据，
  //    由报告页的「↓ Excel」按钮触发下载（文件名沿用归档 id，便于与 .js 对应）。
  //    超长采集的数据表可能几十 MB，base64 再涨 1/3：超过上限就不内联，
  //    宁可少一个下载入口，也不生成一个打不开的巨型 HTML。
  const XLSX_INLINE_MAX = 12 * 1024 * 1024;
  let xlsxBytes = 0;
  try {
    const xlsxPath = path.join(getHistoryDir(), id + '.xlsx');
    if (fs.existsSync(xlsxPath)) {
      const buf = fs.readFileSync(xlsxPath);
      if (buf.length > XLSX_INLINE_MAX) {
        console.warn('[reports/shared] Excel 过大，跳过内联：' + buf.length + ' 字节（上限 '
          + XLSX_INLINE_MAX + '）');
      } else {
        xlsxBytes = buf.length;
        const inject = '<script>\nwindow.__PERFARA_XLSX__ = '
          + JSON.stringify({ name: 'Perfara数据_' + id + '.xlsx', b64: buf.toString('base64') })
          + ';\n</' + 'script>\n';
        const headEnd = html.indexOf('</head>');
        if (headEnd >= 0) html = html.slice(0, headEnd) + inject + html.slice(headEnd);
      }
    }
  } catch (e) {
    // Excel 读失败不能阻断分享包生成：报告本体仍然可看，只是少一个下载入口
    console.warn('[reports/shared] 内联 Excel 失败：', e && e.message ? e.message : e);
  }

  html = html.replace('<head>', () => '<head>\n  <!-- Perfara 单文件分享报告：echarts 与报告数据均已内联，离线双击即可查看 -->');
  return { ok: true, html, payload, xlsxBytes };
}

function suggestSharedName(payload, id) {
  const d = (payload && payload.device) || {};
  const dev = String(d.name || d.model || '').replace(/[\\/:*?"<>|]/g, '').trim();
  const stamp = String(id || '').replace(/[\\/:*?"<>|]/g, '');
  return `Perfara报告_${dev ? dev + '_' : ''}${stamp}.html`;
}

ipcMain.handle('library-export-shared-report', async (_e, id) => {
  const safe = safeReportId(id);
  if (!safe) return { ok: false, reason: '报告 id 无效' };
  const built = buildSharedReportHtml(safe);
  if (!built.ok) return built;

  const win = BrowserWindow.getFocusedWindow() || null;
  const res = await dialog.showSaveDialog(win, {
    title: '导出可分享的单文件报告',
    defaultPath: path.join(app.getPath('documents') || app.getPath('home') || '.', suggestSharedName(built.payload, safe)),
    filters: [{ name: 'HTML 报告', extensions: ['html'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };

  try {
    fs.writeFileSync(res.filePath, built.html, 'utf8');
    shell.showItemInFolder(res.filePath);   // 导出后直接定位到文件，便于转发
    return {
      ok: true, path: res.filePath, bytes: Buffer.byteLength(built.html, 'utf8'),
      // 分享包里是否带了 Excel（0 = 该报告没有同名 xlsx），页面据此提示用户
      xlsxBytes: built.xlsxBytes || 0,
    };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
});

/**
 * 报告库里「保存对比报告」：把当前那份「指标对比」整体打包成一个自包含 HTML。
 *
 * 做法是复用 library.html 本身的样式与对比渲染逻辑，把三样东西全部内联进去：
 *   ① echarts 图表库  ② 参与对比的几条报告索引  ③ 每一份报告的完整原始数据
 * 打开时脚本直接进入对比视图（隐藏报告库管理区），所以成品双击就能看，
 * 不需要客户端、不需要联网、也不依赖 reports 目录。
 */
const CMP_MAX = 6;   // 与 library.html 的 PALETTE 数量一致：最多同时对比 6 份

/** 取出某份报告的 payload：优先 history/<id>.js，次选 history/<id>.json */
function loadPayloadAny(id) {
  const p = readReportPayload(id);
  if (p) return p;
  try {
    const f = path.join(getHistoryDir(), id + '.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) { /* 落到下面返回 null */ }
  return null;
}

/** 内联到 <script> 里的 JSON：所有 '<' 转义成 \u003c，避免 '</script' 之类提前闭合脚本 */
function _inlineJson(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c');
}

function buildCompareMeta(reps) {
  const escape = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const platLabel = (p) => {
    const v = String(p || '').toLowerCase();
    return v === 'android' ? 'Android' : v === 'ios' ? 'iOS' : v === 'pc' ? 'PC' : (p || '—');
  };
  // 包名取最后一段，机型/时间已经足够区分，这里只为可读性
  const shortPkg = (a) => {
    const s = String(a || '');
    const seg = s.split('.');
    return seg.length > 1 ? seg[seg.length - 1] : s;
  };
  const devs = Array.from(new Set(reps.map(r => r.deviceName || '未知设备')));
  const apps = Array.from(new Set(reps.map(r => shortPkg(r.app)).filter(Boolean)));
  const title = devs.length === 1
    ? `Perfara 对比报告 · ${devs[0]}`
    : `Perfara 对比报告 · ${devs.slice(0, 2).join(' vs ')}${devs.length > 2 ? ' 等' : ''}`;
  const sub = reps.map((r, i) =>
    `${i + 1}. ${escape(platLabel(r.platform))} · ${escape(r.deviceName || '未知设备')}` +
    ` · ${escape(r.createdAtLocal || r.createdAt || r.id)}` +
    (r.app ? ` · ${escape(shortPkg(r.app))}` : '') +
    (r.samples ? ` · ${r.samples} 个采样` : '')
  ).join('<br>');
  return { title: escape(title), sub, appLine: apps.join('、') };
}

/** 导出对比报告时注入页面尾部、负责「直接跳到对比视图」的引导脚本 */
const CMP_BOOT_JS = [
  '(function () {',
  '  "use strict";',
  '  var M = window.__PERFARA_CMP__ || {};',
  '  var ids = M.ids || [], dat = M.data || {}, meta = M.meta || {};',
  '  var st = document.createElement("style");',
  '  st.textContent = [',
  '    ".hintbar, #filterbar, #grid, .topbar, #btn-export-compare, #btn-close-compare { display: none !important; }",',
  '    ".wrap { padding-top: 18px; }",',
  '    ".share-head { margin: 0 0 18px; padding: 14px 18px; background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); }",',
  '    ".share-head h2 { font-size: 15px; font-weight: 600; }",',
  '    ".share-head .sh-sub { margin-top: 6px; color: var(--text2); font-size: 12px; line-height: 1.9; }",',
  '    ".share-head .sh-tip { margin-top: 8px; color: var(--text2); font-size: 11px; }",',
  '    ".compare { margin-top: 0; }"',
  '  ].join("\\n");',
  '  document.head.appendChild(st);',
  '  if (meta.title) document.title = meta.title;',
  '  var wrap = document.querySelector(".wrap");',
  '  var cmp = document.getElementById("compare");',
  '  if (wrap && cmp) {',
  '    var head = document.createElement("div");',
  '    head.className = "share-head";',
  '    head.innerHTML = "<h2>" + (meta.title || "性能对比报告") + "</h2>" +',
  '      (meta.sub ? "<div class=\\"sh-sub\\">" + meta.sub + "</div>" : "") +',
  '      "<div class=\\"sh-tip\\">本文件由 Perfara 生成：图表库与全部数据都已内置，不联网、不装客户端也能查看。</div>";',
  '    wrap.insertBefore(head, cmp);',
  '  }',
  '  try {',
  '    state.reports = (typeof reportIndex !== "undefined" && Array.isArray(reportIndex)) ? reportIndex.slice() : [];',
  '    for (var i = 0; i < ids.length; i++) {',
  '      state.selected.add(ids[i]);',
  '      if (dat[ids[i]]) state.cache.set(ids[i], dat[ids[i]]);',
  '    }',
  '    if (cmp) cmp.classList.add("is-on");',
  '    runCompare();',
  '    window.scrollTo(0, 0);   // runCompare 会滚到对比区，分享报告先停在页首看标题',
  '  } catch (e) {',
  '    if (cmp) cmp.innerHTML = "<p style=\\"color:#f85151\\">对比渲染失败：" + ((e && e.message) || String(e)) + "</p>";',
  '  }',
  '})();',
].join('\n');

function buildSharedCompareHtml(ids) {
  const raw = Array.isArray(ids) ? ids.map(safeReportId).filter(Boolean) : [];
  const list = Array.from(new Set(raw)).slice(0, CMP_MAX);
  if (list.length < 2) return { ok: false, reason: '请至少勾选 2 份报告再保存对比（最多 6 份）' };

  const all = readHistoryIndex();
  const reps = list.map(id => all.find(r => r && r.id === id)).filter(Boolean);
  if (reps.length !== list.length) return { ok: false, reason: '部分报告的索引信息缺失，请刷新报告库后重试' };

  const data = {};
  for (const r of reps) {
    const p = loadPayloadAny(r.id);
    if (!p) return { ok: false, reason: `报告数据缺失：${r.id}` };
    // 对比包同样是「转发给别人」的产物：设备唯一标识一并脱敏
    data[r.id] = redactSharedPayload(p);
  }

  const dir = getBundledReportsDir();
  const tplPath = path.join(dir, 'library.html');
  const ecPath = path.join(dir, 'echarts.min.js');
  if (!fs.existsSync(tplPath)) return { ok: false, reason: `未找到报告库模板：${tplPath}` };

  let html = fs.readFileSync(tplPath, 'utf8');

  // 1) 内联 echarts（标签式与异步加载器式都兼容，见 inlineEcharts 注释）
  const ec = inlineEcharts(html, ecPath);
  html = ec.html;

  // 2) 用参与对比的这几条索引替换外部的 history/index.js
  //    索引条目里也带 deviceId，和 payload 一起脱敏，否则对比包仍能读出设备唯一标识
  const meta = buildCompareMeta(reps);
  const safeReps = reps.map(r => (r.deviceId ? Object.assign({}, r, { deviceId: '已脱敏' }) : r));
  const IDX_RE = /<script src="history\/index\.js"[^>]*>\s*<\/script>/;
  if (!IDX_RE.test(html)) return { ok: false, reason: '报告库模板缺少索引加载标记，无法生成对比报告' };
  html = html.replace(IDX_RE, () => '<script>\nvar reportIndex = ' + _inlineJson(safeReps) + ';\n</script>');

  // 3) 页面尾部注入「数据 + 引导脚本」，打开即直接进入对比视图
  const boot = '<script>\nwindow.__PERFARA_CMP__ = { ids: ' + _inlineJson(list) +
    ', data: ' + _inlineJson(data) + ', meta: ' + _inlineJson(meta) + ' };\n</' + 'script>\n' +
    '<script>\n' + CMP_BOOT_JS + '\n</' + 'script>';
  // 注意：必须替换「最后一个」</body>——echarts 源码里可能存在该字符串，替换第一个会打进库代码中间
  const bodyEnd = html.lastIndexOf('</body>');
  if (bodyEnd < 0) return { ok: false, reason: '报告库模板缺少 </body>，无法生成对比报告' };
  html = html.slice(0, bodyEnd) + boot + '\n' + html.slice(bodyEnd);

  // 4) 标题与自包含标记
  html = html.replace(/<title>[\s\S]*?<\/title>/, () => '<title>' + meta.title + '</title>');
  html = html.replace('<head>', () => '<head>\n  <!-- Perfara 单文件对比报告：echarts 与全部报告数据均已内联，离线双击即可查看 -->');

  return { ok: true, html, reps, meta, name: suggestCompareName(reps) };
}

function suggestCompareName(reps) {
  const clean = (s) => String(s == null ? '' : s).replace(/[\\/:*?"<>|]/g, '').trim();
  const devs = Array.from(new Set(reps.map(r => clean(r.deviceName) || '未知设备')));
  const devPart = devs.length === 1 ? devs[0] : devs.slice(0, 2).join('-') + (devs.length > 2 ? '等' : '');
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  return `Perfara对比报告_${devPart}_${reps.length}份_${stamp}.html`;
}

ipcMain.handle('library-export-compare-report', async (_e, ids) => {
  const built = buildSharedCompareHtml(ids);
  if (!built.ok) return built;

  const win = BrowserWindow.getFocusedWindow() || null;
  const res = await dialog.showSaveDialog(win, {
    title: '保存可分享的对比报告',
    defaultPath: path.join(app.getPath('documents') || app.getPath('home') || '.', built.name),
    filters: [{ name: 'HTML 报告', extensions: ['html'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };

  try {
    fs.writeFileSync(res.filePath, built.html, 'utf8');
    shell.showItemInFolder(res.filePath);   // 保存后直接定位到文件，便于转发
    return {
      ok: true, path: res.filePath,
      bytes: Buffer.byteLength(built.html, 'utf8'),
      count: built.reps.length,
    };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
});

function _iosToCSV(rows) {
  if (rows.length === 0) return '';
  const keys = ['timestamp', 'time', 'cpuUsage', 'cpuTotalSystem', 'cpuTotalUser',
    'physFootprint', 'memResidentSize', 'memVirtualSize', 'memRPrvt', 'memRShrd',
    'memAnon', 'memCompressed', 'memPurgeable', 'diskBytesRead', 'diskBytesWritten',
    'threadCount', 'machPortCount', 'msgSent', 'msgRecv', 'sysCallsMach',
    'ctxSwitch', 'intWakeups', 'vmPageIns', 'procStatus', '__arch', 'fps'];
  const header = keys.join(',');
  const lines  = rows.map(r => keys.map(k => r[k] ?? '').join(','));
  return [header, ...lines].join('\n');
}
