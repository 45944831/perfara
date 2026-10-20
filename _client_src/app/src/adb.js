'use strict';

const { execFile } = require('child_process');
const path = require('path');
const fs   = require('fs');

// Prefer bundled adb; fall back to system adb
function resolveAdb() {
  if (process.platform === 'win32') {
    const candidates = [
      path.join(__dirname, '../adb/win/adb.exe'),                      // dev
      path.join(process.resourcesPath || '', 'adb/win/adb.exe'),       // packaged
    ];
    for (const p of candidates) {
      try { if (fs.existsSync(p)) return p; } catch (_) {}
    }
    return 'adb.exe';
  }
  const localUnix = path.join(__dirname, '../adb/adb');
  try { if (fs.existsSync(localUnix)) return localUnix; } catch (_) {}
  return 'adb';
}

const ADB_BIN = resolveAdb();

// Track inflight adb child processes so we can cancel stale tasks
const _inflight = new Set();

function adb(args, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const child = execFile(ADB_BIN, args, { timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      // If we were cancelled, treat as silent failure for callers to handle.
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
    try {
      _inflight.add(child);
      child.once('exit', () => _inflight.delete(child));
      child.once('error', () => _inflight.delete(child));
    } catch (_) {}
  });
}

function adbShell(deviceId, cmd, timeout = 10000) {
  return adb(['-s', deviceId, 'shell', cmd], timeout);
}

function cancelAllInflight() {
  for (const child of Array.from(_inflight)) {
    try {
      // Best-effort: kill the process; callback will reject.
      child.kill();
    } catch (_) {}
    try { _inflight.delete(child); } catch (_) {}
  }
}

// ─── Devices ─────────────────────────────────────────────────────────────────

async function getDevices() {
  const out = await adb(['devices', '-l']);
  const devices = [];
  for (const line of out.split('\n').slice(1)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('*')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2 && parts[1] === 'device') {
      const id    = parts[0];
      const isWifi = id.includes(':');   // IP:PORT → wireless
      const model = ((trimmed.match(/model:(\S+)/) || [])[1] || id)
                      + (isWifi ? '-wifi' : '');
      devices.push({ id, model, wifi: isWifi });
    }
  }
  return devices;
}

/** 供 UI 展示：品牌 / 名称 / 系统（仅返回能读到的字段） */
async function getDeviceInfo(deviceId) {
  if (!deviceId) return null;
  const getProp = async (p) => {
    try {
      const v = (await adbShell(deviceId, `getprop ${p}`, 6000)).trim().replace(/\r/g, '');
      return v || null;
    } catch (_) {
      return null;
    }
  };
  const brand = await getProp('ro.product.brand');
  const manufacturer = await getProp('ro.product.manufacturer');
  const model = await getProp('ro.product.model');
  const marketName = await getProp('ro.product.marketname');
  const release = await getProp('ro.build.version.release');

  const info = {};
  const b = brand || manufacturer;
  if (b) info.brand = b;

  let name = marketName;
  if (!name && (b || model)) name = [b, model].filter(Boolean).join(' ').trim();
  if (name) info.name = name;

  if (release) info.system = `Android ${release}`;

  return Object.keys(info).length ? info : null;
}

async function connectWifi(ipPort) {
  try {
    const out = await adb(['connect', ipPort.trim()], 10000);
    const msg = out.trim();
    return { ok: msg.includes('connected'), msg };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

// Auto-detect device WiFi IP and connect wirelessly
async function autoConnectWifi(deviceId) {
  // Only works for USB-connected devices (no ':' in ID)
  if (!deviceId || deviceId.includes(':')) {
    return { ok: false, msg: '请先选择一个 USB 连接的设备' };
  }
  try {
    // Get WiFi IP via ip route or ip addr
    let ip = '';
    try {
      const out = await adb(['-s', deviceId, 'shell', 'ip route 2>/dev/null'], 8000);
      // e.g. "192.168.1.0/24 dev wlan0  proto kernel  scope link  src 192.168.1.100"
      const m = out.match(/src\s+([\d.]+)/);
      if (m) ip = m[1];
    } catch (_) {}

    if (!ip) {
      try {
        const out = await adb(['-s', deviceId, 'shell', 'ip addr show wlan0 2>/dev/null'], 8000);
        const m = out.match(/inet\s+([\d.]+)/);
        if (m) ip = m[1];
      } catch (_) {}
    }

    if (!ip) return { ok: false, msg: '无法获取设备 WiFi IP，请确认设备已连接 WiFi' };

    // Switch device to TCPIP mode on port 5555
    await adb(['-s', deviceId, 'tcpip', '5555'], 8000).catch(() => {});

    // Small delay for device to restart adbd in tcp mode
    await new Promise(r => setTimeout(r, 1500));

    // Connect
    const ipPort = `${ip}:5555`;
    const out = await adb(['connect', ipPort], 10000);
    const msg = out.trim();
    return { ok: msg.includes('connected'), msg, ipPort };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

async function disconnectWifi(ipPort) {
  try {
    await adb(['disconnect', ipPort.trim()], 5000);
    return { ok: true };
  } catch (e) {
    return { ok: false };
  }
}

async function getThirdPartyPackages(deviceId) {
  const pkgOut = await adbShell(deviceId, 'pm list packages -3', 15000);
  const packages = pkgOut.split('\n')
    .map(l => l.replace('package:', '').trim().replace(/\r/g, ''))
    .filter(Boolean).sort();
  return packages.map(pkg => ({ pkg, label: pkg }));
}

async function getPid(deviceId, packageName) {
  try {
    const out = await adbShell(deviceId, `pidof -s '${packageName}' 2>/dev/null`);
    const pid = parseInt(out.trim(), 10);
    if (!isNaN(pid) && pid > 0) return pid;
  } catch (_) {}
  try {
    const out = await adbShell(deviceId, `ps -A 2>/dev/null | grep '${packageName}' | head -1`);
    for (const line of out.split('\n')) {
      const cols = line.trim().split(/\s+/);
      const pid = parseInt(cols[1], 10);
      if (!isNaN(pid) && pid > 0) return pid;
    }
  } catch (_) {}
  return null;
}

/**
 * 若目标包无进程则尝试通过 adb 拉起；已在运行则直接返回。
 * @returns {{ ok: boolean, launched: boolean, pid: number|null, error?: string }}
 */
async function ensureAppRunning(deviceId, packageName, logFn) {
  const log = typeof logFn === 'function' ? logFn : () => {};
  if (!deviceId || !packageName) {
    return { ok: false, launched: false, pid: null, error: 'deviceId 或 packageName 为空' };
  }
  let pid = await getPid(deviceId, packageName).catch(() => null);
  if (pid) {
    log(`[adb] 应用已在运行，无需启动 (PID=${pid})`);
    return { ok: true, launched: false, pid };
  }
  log(`[adb] 未检测到进程，尝试启动应用: ${packageName}`);
  const pkg = packageName.replace(/'/g, "'\\''");
  try {
    await adbShell(
      deviceId,
      `monkey -p '${pkg}' -c android.intent.category.LAUNCHER 1 2>/dev/null`,
      20000
    );
  } catch (e) {
    log(`[adb] monkey 启动: ${e.message}`);
  }
  pid = await getPid(deviceId, packageName).catch(() => null);
  if (pid) {
    log(`[adb] 应用已启动 (PID=${pid})`);
    return { ok: true, launched: true, pid };
  }
  try {
    await adbShell(
      deviceId,
      `am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p '${pkg}' 2>/dev/null`,
      20000
    );
  } catch (e) {
    log(`[adb] am start: ${e.message}`);
  }
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    pid = await getPid(deviceId, packageName).catch(() => null);
    if (pid) {
      log(`[adb] 应用已启动 (PID=${pid})`);
      return { ok: true, launched: true, pid };
    }
  }
  return {
    ok: false,
    launched: true,
    pid: null,
    error: '应用未运行且启动后仍未检测到进程',
  };
}

async function getUid(deviceId, packageName) {
  try {
    const out = await adbShell(deviceId, `dumpsys package '${packageName}' 2>/dev/null | grep -m1 userId=`);
    const m = out.match(/userId=(\d+)/);
    if (m) return parseInt(m[1], 10);
  } catch (_) {}
  return null;
}

// ─── CPU ─────────────────────────────────────────────────────────────────────

const _cpuState = new Map();

async function getCpuStats(deviceId, pid) {
  const key = `${deviceId}_${pid || 'sys'}`;
  let sysRaw = '', pidRaw = '';
  try {
    const cmd = pid ? `cat /proc/stat /proc/${pid}/stat 2>/dev/null` : 'cat /proc/stat';
    const out = await adbShell(deviceId, cmd);
    const lines = out.split('\n');
    sysRaw = lines.find((l) => l.startsWith('cpu ')) || '';
    if (pid) {
      pidRaw = lines.find((l) => {
        const p = l.trim().split(/\s+/);
        return p.length > 14 && parseInt(p[0], 10) === pid;
      }) || '';
    }
  } catch (_) { return { sysCpu: 0, procCpu: 0 }; }

  const parseSys = (raw) => {
    const nums = raw.trim().split(/\s+/).slice(1).map(Number);
    return { idle: nums[3] + (nums[4] || 0), total: nums.reduce((a, b) => a + b, 0) };
  };
  const parsePid = (raw) => {
    const p = raw.trim().split(/\s+/);
    return (parseInt(p[13], 10) || 0) + (parseInt(p[14], 10) || 0);
  };

  const now = Date.now();
  const prev = _cpuState.get(key);
  const current = { sys: sysRaw ? parseSys(sysRaw) : null, pid: pid && pidRaw ? parsePid(pidRaw) : 0, ts: now };
  _cpuState.set(key, current);

  if (!prev || !prev.sys || !current.sys) return { sysCpu: 0, procCpu: 0 };
  const totalDelta = current.sys.total - prev.sys.total;
  const idleDelta  = current.sys.idle  - prev.sys.idle;
  const sysCpu  = totalDelta > 0 ? Math.round(((totalDelta - idleDelta) / totalDelta) * 100) : 0;
  const procCpu = totalDelta > 0 ? Math.round(((current.pid - prev.pid) / totalDelta) * 100) : 0;
  return { sysCpu: clamp(sysCpu, 0, 100), procCpu: clamp(procCpu, 0, 100) };
}

// ─── Memory ──────────────────────────────────────────────────────────────────

async function getMemInfo(deviceId, packageName) {
  try {
    const out = await adbShell(deviceId, `dumpsys meminfo '${packageName}' 2>/dev/null`);
    const totalMatch = out.match(/^\s*TOTAL\s+(\d+)/m);
    // label may appear as "Foo Bar:" or "Foo Bar" followed by whitespace and a number
    const getLine = (label) => {
      const m = out.match(new RegExp(`^\\s*${label}:?\\s+(\\d+)`, 'm'));
      return m ? Math.round(parseInt(m[1], 10) / 1024) : 0;
    };
    const javaHeap = getLine('Java Heap') || getLine('Dalvik Heap');
    // 整机内存（PerfDog: TotalAvailableMemorySize / TotalUsedMemorySize）——读 /proc/meminfo
    let memTotalMB = 0, memAvailableMB = 0;
    try {
      const mi = await adbShell(deviceId, 'cat /proc/meminfo 2>/dev/null');
      const mt = mi.match(/^MemTotal:\s+(\d+)/m);
      const ma = mi.match(/^MemAvailable:\s+(\d+)/m);
      if (mt) memTotalMB = Math.round(parseInt(mt[1], 10) / 1024);
      if (ma) memAvailableMB = Math.round(parseInt(ma[1], 10) / 1024);
    } catch (_) {}
    return {
      totalPss:     totalMatch ? Math.round(parseInt(totalMatch[1], 10) / 1024) : 0,
      nativeHeap:   getLine('Native Heap'),
      javaHeap,
      dalvikHeap:   javaHeap,   // legacy alias
      code:         getLine('Code'),
      stack:        getLine('Stack'),
      graphics:     getLine('Graphics'),
      privateOther: getLine('Private Other'),
      system:       getLine('System'),
      memTotalMB,
      memAvailableMB,
    };
  } catch (_) {
    return { totalPss: 0, nativeHeap: 0, javaHeap: 0, dalvikHeap: 0, code: 0, stack: 0, graphics: 0, privateOther: 0, system: 0, memTotalMB: 0, memAvailableMB: 0 };
  }
}

// ─── FPS + Jank + BigJank ─────────────────────────────────────────────────────
//
// Strategy (by priority):
//
//  Method 1 — SurfaceFlinger --timestats (BLAST/Unity, Android 11+)
//    ● Confirmed working on 某机型 (中端 SoC):
//        `adb shell dumpsys SurfaceFlinger --timestats -enable`
//        `adb shell dumpsys SurfaceFlinger --timestats -dump`
//    ● Fields used: totalFrames (delta→FPS), averageFPS, present2present histogram
//    ● Histogram enables accurate Jank / BigJank without per-frame data
//
//  Method 2 — gfxinfo framestats (View-based / non-Unity apps, Android 6+)
//    ● Per-frame timestamps: IntendedVsync, FrameCompleted
//    ● BigJank: frameTime > 2×avg(prev3) AND frameTime > 125ms (exact definition)
//
//  Method 3 — gfxinfo "Total frames" delta (broad fallback)
//
// BigJank definition:
//   Both conditions must hold:
//     1. DisplayFrameTime > 2 × avg(prev 3 frames)
//     2. DisplayFrameTime > 125 ms (= 1000/24 × 3 cinema frames)
//
// ─────────────────────────────────────────────────────────────────────────────

const _fpsState        = new Map();
const _timestatsEnabled = new Set();

// Parse "Xms=N Yms=M …" into { X: N, Y: M, … }
function parseHistogram(line) {
  const hist = {};
  const re = /(\d+)ms=(\d+)/g;
  let m;
  while ((m = re.exec(line)) !== null) hist[parseInt(m[1])] = parseInt(m[2]);
  return hist;
}

// Delta between two cumulative histograms → only positive increments
function histDelta(prev, curr) {
  const delta = {};
  for (const ms of new Set([...Object.keys(prev || {}), ...Object.keys(curr || {})])) {
    const d = (curr[ms] || 0) - (prev[ms] || 0);
    if (d > 0) delta[ms] = d;
  }
  return delta;
}

/** 常见屏幕刷新率档位（Hz） */
const REFRESH_RATES = [24, 30, 48, 60, 90, 100, 120, 144, 165, 240];
/** 2 个电影帧：1000/24×2 ≈ 83.34ms —— Jank 的绝对门槛（PerfDog 口径） */
const MOVIE_FRAME_X2_MS = 1000 / 24 * 2;
/** 3 个电影帧：1000/24×3 = 125ms —— BigJank 的绝对门槛（PerfDog 口径） */
const MOVIE_FRAME_X3_MS = 1000 / 24 * 3;

/**
 * 由屏幕刷新率推算 vsync 周期（ms，向下取整以对齐直方图的整数桶）。
 * 这是最可靠的来源：不能依赖 present2present 直方图的最大桶 —— 锁 30fps 的应用
 * 绝大多数帧落在 33ms，会把 60Hz 屏误判成 vsync=33ms，使所有卡顿阈值翻倍、
 * Jank/TinyJank 恒为 0（真机 Android 13 中端机型 / Android 13 实测复现）。
 */
function vsyncMsFromRefreshRate(refreshRate) {
  if (!refreshRate || !(refreshRate > 0)) return 0;
  let best = 60, bestDiff = Infinity;
  for (const rr of REFRESH_RATES) {
    const d = Math.abs(rr - refreshRate);
    if (d < bestDiff) { bestDiff = d; best = rr; }
  }
  return Math.floor(1000 / best);
}

/**
 * 无刷新率时的兜底：present2present 直方图的最大桶同样不可靠（锁帧时是 2×vsync），
 * 改为取「计数显著的最低桶」——单帧最快间隔才对应 1 个 vsync，再吸附到标准刷新率档。
 * @param {Object} hist present2present 直方图 { ms: count }
 * @param {number} [refreshRate] 若有，优先用它（唯一可信来源）
 */
function detectVsync(hist, refreshRate) {
  const fromRR = vsyncMsFromRefreshRate(refreshRate);
  if (fromRR) return fromRR;

  const entries = Object.entries(hist || {})
    .map(([ms, c]) => ({ ms: parseInt(ms, 10), c }))
    .filter(e => e.c > 0 && e.ms >= 1);
  if (!entries.length) return 16;

  const peak = Math.max(...entries.map(e => e.c));
  // 计数达到峰值 15% 的最低桶：能容纳抖动，又能排掉噪声桶
  const candidates = entries.filter(e => e.c >= peak * 0.15).sort((a, b) => a.ms - b.ms);
  const minMs = candidates.length ? candidates[0].ms : entries.sort((a, b) => a.ms - b.ms)[0].ms;

  // 吸附到最接近的标准刷新率
  let best = 60, bestDiff = Infinity;
  for (const rr of REFRESH_RATES) {
    const d = Math.abs(1000 / rr - minMs);
    if (d < bestDiff) { bestDiff = d; best = rr; }
  }
  return Math.floor(1000 / best);
}

// Analyse a (delta) present2present histogram → { jank, bigJank, smallJank, tinyJank, totalFrames }
// 卡顿分级（PerfDog 口径，逐级递进）：
//   TinyJank  极小卡顿：帧间隔 ≥ 1.5 × 基准（见下方 tinyMs 说明，锁帧时用实际帧节奏）
//   SmallJank 微小卡顿：帧间隔 ≥ 84ms（= 1000ms/24×2，PerfDog Jank 绝对档）
//   Jank              ：帧间隔 ≥ 2 × vsyncMs（missed ≥1 vsync，保持原口径）
//   BigJank           ：帧间隔 ≥ max(2×avgMs, 125)（PerfDog 精确双条件）
function analyseHistogram(hist, vsyncMs) {
  const entries = Object.entries(hist).map(([ms, c]) => ({ ms: +ms, c })).filter(e => e.c > 0);
  const totalFrames = entries.reduce((s, e) => s + e.c, 0);
  if (totalFrames === 0) return { jank: 0, bigJank: 0, smallJank: 0, tinyJank: 0, totalFrames: 0 };

  const avgMs = entries.reduce((s, e) => s + e.ms * e.c, 0) / totalFrames;

  // Jank: PerfDog 双条件的 OR → ft > 2×avgMs OR ft > 83.34ms
  //   报告文案为「> 前三帧平均 2 倍，且 > 2 个电影帧（83ms）」，与 BigJank 同为 AND 语义，
  //   此处按 AND 落地取 max（histogram 无法还原逐帧前三帧均值，用整段均值近似）。
  //   ⚠️ 原实现为 vsyncMs * 2：一旦 vsync 被误判放大，全部卡顿阈值随之失效、Jank 恒为 0。
  const jankMs  = Math.max(2 * avgMs, MOVIE_FRAME_X2_MS);
  // BigJank: 两个条件同时满足 → ft > max(2 × avgMs, 125ms)
  const bigMs   = Math.max(2 * avgMs, MOVIE_FRAME_X3_MS);
  // TinyJank 基准取「屏幕 vsync 与实际平均帧间隔的较大者」：
  //   锁低帧率的应用（典型如锁 30fps 的游戏）每帧恒定 ≈33ms，若仍以 60Hz 的 16ms 为基准，
  //   会把整段全部帧判成微卡顿、失去分辨力；此时应以实际帧节奏为基准。
  const tinyMs  = Math.max(vsyncMs || 0, avgMs) * 1.5;
  const smallMs = 84;              // 1000/24×2，PerfDog Jank 绝对档

  let jank = 0, bigJank = 0, smallJank = 0, tinyJank = 0;
  for (const { ms, c } of entries) {
    if (ms >= tinyMs)  tinyJank  += c;
    if (ms >= smallMs) smallJank += c;
    if (ms >= jankMs)  jank      += c;
    if (ms >= bigMs)   bigJank   += c;
  }
  return { jank, bigJank, smallJank, tinyJank, totalFrames, avgMs, vsyncMs };
}

// Per-frame Jank / BigJank / SmallJank / TinyJank from gfxinfo framestats timestamps
function calcJankFramestats(frames) {
  const SMALL_JANK_MS = 84;
  let jank = 0, bigJank = 0, smallJank = 0, tinyJank = 0;
  const ft = frames.map(f => (f.completed - f.vsync) / 1e6); // ns → ms
  // 估算 vsync：帧间隔中位数吸附到常见刷新率（用于 TinyJank 阈值）
  const sortedFt = ft.filter(v => v > 0).sort((a, b) => a - b);
  let vsyncMs = 16.67;
  if (sortedFt.length) {
    const med = sortedFt[Math.floor(sortedFt.length / 2)];
    if (med <= 10) vsyncMs = 8.33;        // 120Hz
    else if (med <= 13) vsyncMs = 11.11;  // 90Hz
    else vsyncMs = 16.67;                 // 60Hz
  }
  const TINY_JANK_MS = vsyncMs * 1.5;

  for (let i = 3; i < ft.length; i++) {
    const avg3 = (ft[i - 1] + ft[i - 2] + ft[i - 3]) / 3;
    // Jank：PerfDog 双条件（> 2×前三帧均值 且 > 83.34ms）→ 取 max，与 histogram 路径同口径。
    //   ⚠️ 原实现为 ft > 16.67ms：60Hz 下任何正常帧都会被计成 Jank，指标失真。
    if (ft[i] > Math.max(2 * avg3, MOVIE_FRAME_X2_MS)) jank++;
    // TinyJank / SmallJank：绝对阈值档
    if (ft[i] >= TINY_JANK_MS) tinyJank++;
    if (ft[i] >= SMALL_JANK_MS) smallJank++;
    // Exact BigJank definition: both conditions → max
    if (ft[i] > Math.max(2 * avg3, MOVIE_FRAME_X3_MS)) bigJank++;
  }
  return { jank, bigJank, smallJank, tinyJank };
}

// Main FPS entry point — returns { fps, jank, bigJank, jankRate, method }
async function getFps(deviceId, packageName, logFn) {
  const log = logFn || (() => {});
  const key = `${deviceId}_${packageName}_fps`;
  const now = Date.now();
  const prev = _fpsState.get(key);

  // ── Enable timestats once per device ──────────────────────────────────────
  if (!_timestatsEnabled.has(deviceId)) {
    try {
      await adbShell(deviceId, 'dumpsys SurfaceFlinger --timestats -enable -clear 2>/dev/null');
      _timestatsEnabled.add(deviceId);
      log('[FPS] timestats 已启用');
    } catch (e) { log(`[FPS] timestats 启用失败: ${e.message}`); }
  }

  // ── Method 1: --timestats (BLAST/Unity layers) ────────────────────────────
  try {
    const out = await adbShell(deviceId, 'dumpsys SurfaceFlinger --timestats -dump 2>/dev/null');
    const lines = out.split('\n');

    let inLayer = false, layerTag = '';
    let totalFrames = -1, droppedFrames = 0, averageFPS = 0;
    let present2presentHist = null;
    // 最近读到的 displayRefreshRate：timestats 在每个 layer 块之前输出所属显示的刷新率，
    // 这是判定 vsync 的唯一可信来源（详见 detectVsync 注释）。
    let lastRefreshRate = 0, layerRefreshRate = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('displayRefreshRate')) {
        const m = line.match(/([\d.]+)/);
        if (m) lastRefreshRate = +m[1];
        continue;
      }

      if (line.startsWith('layerName')) {
        // Commit previous layer result if it matched
        if (inLayer && totalFrames >= 0 && present2presentHist) break;
        inLayer = line.includes(packageName);
        layerTag = line;
        layerRefreshRate = inLayer ? lastRefreshRate : 0;
        totalFrames = -1; droppedFrames = 0; averageFPS = 0; present2presentHist = null;
        continue;
      }
      if (!inLayer) continue;

      const num = (field) => { const m = line.match(new RegExp(`${field}\\s*=\\s*([\\d.]+)`)); return m ? +m[1] : null; };

      if (line.startsWith('totalFrames'))        totalFrames  = num('totalFrames')  ?? totalFrames;
      if (line.startsWith('droppedFrames'))       droppedFrames = num('droppedFrames') ?? 0;
      if (line.startsWith('averageFPS'))          averageFPS   = num('averageFPS')   ?? 0;
      if (line.startsWith('present2present histogram')) {
        present2presentHist = parseHistogram(lines[i + 1] || '');
      }
    }

    if (inLayer && totalFrames >= 0) {
      const currState = { totalFrames, droppedFrames, hist: present2presentHist, ts: now, rr: layerRefreshRate };
      _fpsState.set(key, currState);

      if (prev && prev.totalFrames !== undefined) {
        const dt   = Math.max((now - prev.ts) / 1000, 0.1);
        const delta = Math.max(0, totalFrames - prev.totalFrames);
        const fps   = Math.min(Math.round(delta / dt), 120);

        let jank = 0, bigJank = 0, smallJank = 0, tinyJank = 0;

        if (present2presentHist && prev.hist) {
          const dHist  = histDelta(prev.hist, present2presentHist);
          const vsync  = detectVsync(present2presentHist, layerRefreshRate);
          const result = analyseHistogram(dHist, vsync);
          jank     = result.jank;
          bigJank  = result.bigJank;
          smallJank = result.smallJank;
          tinyJank  = result.tinyJank;
          log(`[FPS] timestats ✓ layer=${layerTag.split('=')[1]?.trim()} fps=${fps} avgFPS=${averageFPS.toFixed(1)} refreshRate=${layerRefreshRate || 'N/A'} vsync=${vsync}ms avgMs=${(result.avgMs ?? 0).toFixed(1)} jank=${jank} bigJank=${bigJank} smallJank=${smallJank} tinyJank=${tinyJank} δframes=${delta}`);
        } else {
          // Histogram not yet available — estimate from droppedFrames
          const dropped = Math.max(0, droppedFrames - (prev.droppedFrames || 0));
          jank = dropped;
          const framesPerBigJank = Math.ceil(125 / (1000 / Math.max(fps, 1)));
          bigJank = Math.floor(dropped / Math.max(framesPerBigJank, 1));
          // dropped 即丢帧档：与 TinyJank 同档估算；SmallJank 不外推（无 histogram 时不可靠）
          tinyJank = dropped;
          smallJank = 0;
          log(`[FPS] timestats (no hist) fps=${fps} dropped=${dropped} jank≈${jank} bigJank≈${bigJank} tinyJank≈${tinyJank}`);
        }

        // 计数归一化到「次/秒」：histogram 增量是整个采样周期的累计值，
        // 而 adb dump 有延迟时周期会拉长（实测可达数秒，出现 tinyJank=169 > 每秒帧数上限
        // 这种不可能成立的数字）。必须与 fps 一样除以实际 dt，否则单位「次/s」名不副实。
        const perSec = (n) => Math.max(0, Math.round(n / dt));
        const jankRate = delta > 0 ? Math.round((jank / delta) * 100) : 0;
        return {
          fps,
          jank: perSec(jank), bigJank: perSec(bigJank),
          smallJank: perSec(smallJank), tinyJank: perSec(tinyJank),
          jankRate, method: 'timestats',
        };
      }

      log(`[FPS] timestats 首次采样 layer=${layerTag.split('=')[1]?.trim()} totalFrames=${totalFrames}`);
      return { fps: 0, jank: 0, bigJank: 0, smallJank: 0, tinyJank: 0, jankRate: 0, method: 'timestats-init' };
    }

    log(`[FPS] timestats 未匹配层 "${packageName}"`);
  } catch (e) { log(`[FPS] timestats 异常: ${e.message}`); }

  // ── Method 2: gfxinfo framestats (View-based apps) ───────────────────────
  try {
    const out = await adbShell(deviceId, `dumpsys gfxinfo '${packageName}' framestats 2>/dev/null`);
    const frames = [];
    let inSection = false;

    for (const line of out.split('\n')) {
      if (line.includes('---PROFILEDATA---')) { inSection = !inSection; continue; }
      if (!inSection || /^Flags/i.test(line.trim())) continue;
      const cols = line.trim().split(',');
      if (cols.length < 14) continue;
      const vsync     = parseInt(cols[1],  10);
      const completed = parseInt(cols[13], 10);
      if (vsync > 1e9 && completed > vsync) frames.push({ vsync, completed });
    }

    if (frames.length >= 4) {
      frames.sort((a, b) => a.vsync - b.vsync);
      const durSec = (frames[frames.length - 1].completed - frames[0].vsync) / 1e9;
      const fps    = durSec > 0 ? Math.min(Math.round(frames.length / durSec), 120) : 0;
      const { jank, bigJank, smallJank, tinyJank } = calcJankFramestats(frames);
      const jankRate = frames.length > 0 ? Math.round((jank / frames.length) * 100) : 0;
      // 同样归一化到「次/秒」：frames 是窗口内的累计帧，窗口不一定是 1 秒
      const perSec = (n) => (durSec > 0 ? Math.max(0, Math.round(n / durSec)) : n);
      log(`[FPS] gfxinfo framestats ✓ frames=${frames.length} dur=${durSec.toFixed(2)}s fps=${fps} jank=${jank} bigJank=${bigJank} smallJank=${smallJank} tinyJank=${tinyJank}`);
      return {
        fps,
        jank: perSec(jank), bigJank: perSec(bigJank),
        smallJank: perSec(smallJank), tinyJank: perSec(tinyJank),
        jankRate, method: 'framestats',
      };
    }
    log(`[FPS] gfxinfo framestats 帧数不足 (${frames.length})`);
  } catch (e) { log(`[FPS] gfxinfo 异常: ${e.message}`); }

  // ── Method 3: gfxinfo "Total frames" delta (broad fallback) ───────────────
  try {
    const out = await adbShell(deviceId, `dumpsys gfxinfo '${packageName}' 2>/dev/null`);
    const m = out.match(/Total frames rendered:\s*(\d+)/);
    if (m) {
      const total = parseInt(m[1], 10);
      const gKey  = key + '_gfx';
      const gPrev = _fpsState.get(gKey);
      _fpsState.set(gKey, { total, ts: now });
      if (gPrev && total !== gPrev.total) {
        const dt  = Math.max((now - gPrev.ts) / 1000, 0.5);
        const fps = Math.min(Math.round((total - gPrev.total) / dt), 120);
        log(`[FPS] gfxinfo delta ✓ fps=${fps}`);
        return { fps, jank: 0, bigJank: 0, smallJank: 0, tinyJank: 0, jankRate: 0, method: 'gfxinfo-delta' };
      }
      log(`[FPS] gfxinfo delta 首次或无变化 total=${total}`);
    } else {
      log(`[FPS] gfxinfo 无渲染数据（未取到 "Total frames rendered"）`);
    }
  } catch (e) { log(`[FPS] gfxinfo-delta 异常: ${e.message}`); }

  // 所有方案都失败：明确告知用户原因，避免「FPS=0 但不知道为什么」
  log(`[FPS] 未取到 ${packageName} 的帧数据：该应用当前无可见渲染层（未在前台 / 无 Surface / 非 View 渲染）。若正在测试游戏或前台应用请检查是否已切到前台`);
  return { fps: 0, jank: 0, bigJank: 0, smallJank: 0, tinyJank: 0, jankRate: 0, method: 'none' };
}

// ─── Network ─────────────────────────────────────────────────────────────────

const _netState = new Map();

async function getNetStats(deviceId) {
  const key = `${deviceId}_net`;
  try {
    const out = await adbShell(deviceId, 'cat /proc/net/dev 2>/dev/null');
    let rx = 0, tx = 0;
    for (const line of out.split('\n')) {
      if (!/^(wlan\d|rmnet_data\d+):/.test(line.trim())) continue;
      const cols = line.trim().split(/\s+/);
      rx += parseInt(cols[1], 10) || 0;
      tx += parseInt(cols[9], 10) || 0;
    }
    const now  = Date.now();
    const prev = _netState.get(key);
    _netState.set(key, { rx, tx, ts: now });
    if (!prev) return { rxKBps: 0, txKBps: 0 };
    const dt = Math.max((now - prev.ts) / 1000, 0.1);
    return {
      rxKBps: Math.max(0, Math.round(((rx - prev.rx) / 1024) / dt)),
      txKBps: Math.max(0, Math.round(((tx - prev.tx) / 1024) / dt)),
    };
  } catch (_) { return { rxKBps: 0, txKBps: 0 }; }
}

// ─── Battery ─────────────────────────────────────────────────────────────────

async function getBatteryInfo(deviceId) {
  try {
    const out = await adbShell(deviceId, 'dumpsys battery 2>/dev/null');
    const get = (k) => { const m = out.match(new RegExp(`${k}:\\s*([\\d.]+)`)); return m ? parseFloat(m[1]) : 0; };
    const level       = get('level');
    const voltage     = get('voltage');           // mV
    const temperature = Math.round((get('temperature') / 10) * 10) / 10;

    let currentNow = 0;

    // Primary: batt_current_ua_now (explicitly µA, Samsung-specific)
    try {
      const s = await adbShell(deviceId, 'cat /sys/class/power_supply/battery/batt_current_ua_now 2>/dev/null');
      const v = parseInt(s.trim());
      if (!isNaN(v) && v !== 0) {
        currentNow = Math.round(Math.abs(v) / 1000); // µA → mA
      }
    } catch (_) {}

    // Fallback: "current now:" in dumpsys battery — Samsung reports this in mA directly
    if (currentNow === 0) {
      const curMatch = out.match(/current now:\s*(-?\d+)/i);
      if (curMatch) {
        const raw = Math.abs(parseInt(curMatch[1]));
        // If value > 10000, assume µA (standard Android); otherwise already mA (Samsung)
        currentNow = raw > 10000 ? Math.round(raw / 1000) : raw;
      }
    }

    // Last resort: sysfs current_now — on Samsung also in mA, not µA
    if (currentNow === 0) {
      try {
        const s = await adbShell(deviceId, 'cat /sys/class/power_supply/battery/current_now 2>/dev/null');
        const v = parseInt(s.trim());
        if (!isNaN(v) && v !== 0) {
          currentNow = Math.abs(v) > 10000 ? Math.round(Math.abs(v) / 1000) : Math.abs(v);
        }
      } catch (_) {}
    }

    // Power in mW = current_mA × voltage_mV / 1000
    const power = (currentNow > 0 && voltage > 0)
      ? Math.round(currentNow * voltage / 1000) : 0;

    return { level, voltage, temperature, currentNow, power };
  } catch (_) { return { level: 0, voltage: 0, temperature: 0, currentNow: 0, power: 0 }; }
}

// ─── Temperature ─────────────────────────────────────────────────────────────
// 多级兜底：很多机型（部分厂商 ROM 等）对 shell 关闭了 thermal_zone 读取权限，
// 此时退回 dumpsys thermalservice（Android 10+ 免 root），最后才用电池温度。

/** 从 dumpsys thermalservice 里取温度；优先 CPU，其次 SKIN / BATTERY，最后取平均 */
/**
 * 解析 dumpsys thermalservice。
 * 返回 { main, gpu }：main = 整机温度（CPU/SKIN/BATTERY 优先），gpu = TYPE_GPU 的读数（没有则 null）。
 * GPU 利用率在多数 MTK 机型上只有 root 能读，但 GPU 温度是 shell 可读的，
 * 报告页在拿不到利用率时用温度补位，避免 GPU 区域整块空白。
 */
function parseThermalService(out) {
  if (!out) return null;
  // 优先用 HAL 实时值，其次用 cached
  const halIdx = out.indexOf('Current temperatures from HAL');
  const cachedIdx = out.indexOf('Cached temperatures');
  let section = '';
  if (halIdx >= 0) section = out.slice(halIdx);
  else if (cachedIdx >= 0) section = out.slice(cachedIdx);
  else section = out;
  if (halIdx >= 0 && cachedIdx > halIdx) section = out.slice(halIdx, cachedIdx);

  const rows = [];
  const re = /Temperature\{mValue=([\d.]+),\s*mType=(\d+),\s*mName=([A-Z_]+)/g;
  let m;
  while ((m = re.exec(section)) !== null) {
    const v = parseFloat(m[1]);
    if (isFinite(v) && v > 0 && v < 150) rows.push({ value: v, name: m[3] });
  }
  if (!rows.length) return null;

  const pick = (name) => rows.find((r) => r.name === name);
  const preferred = pick('CPU') || pick('SKIN') || pick('BATTERY');
  const main = preferred
    ? preferred.value
    : rows.reduce((s, r) => s + r.value, 0) / rows.length;
  const gpuRow = pick('GPU');

  return {
    main: Math.round(main * 10) / 10,
    gpu: gpuRow ? Math.round(gpuRow.value * 10) / 10 : null,
  };
}

/**
 * 温度采集：返回 { temperature, gpuTemp }。
 * temperature 为整机温度（0 表示没采到），gpuTemp 为 GPU 温度（null 表示该机型没暴露）。
 */
async function getThermalInfo(deviceId) {
  // 1) /sys/class/thermal/thermal_zone*/temp（老机型 / 有 root 时可用）
  try {
    const out = await adbShell(deviceId,
      "for f in /sys/class/thermal/thermal_zone*/temp; do cat \"$f\" 2>/dev/null; echo; done");
    const temps = out.split('\n').map(l => parseInt(l.trim(), 10)).filter(t => !isNaN(t) && t > 0);
    if (temps.length) {
      const norm = temps.map(t => t > 1000 ? t / 1000 : t).filter(t => t > 0 && t < 150);
      // sysfs 的分区没有名字，无法区分哪个是 GPU，只能给整机温度
      if (norm.length) {
        return {
          temperature: Math.round(norm.reduce((a, b) => a + b, 0) / norm.length * 10) / 10,
          gpuTemp: null,
        };
      }
    }
  } catch (_) {}

  // 2) dumpsys thermalservice（Android 10+，无需 root，能拿到 GPU 分区）
  try {
    const out = await adbShell(deviceId, 'dumpsys thermalservice 2>/dev/null');
    const r = parseThermalService(out);
    if (r && r.main > 0) return { temperature: r.main, gpuTemp: r.gpu };
  } catch (_) {}

  // 3) 电池温度（最低兜底，几乎所有机型可读）
  try {
    const out = await adbShell(deviceId, 'dumpsys battery 2>/dev/null');
    const m = out.match(/temperature:\s*(\d+)/);
    if (m) {
      const t = parseInt(m[1], 10) / 10;
      if (t > 0 && t < 150) return { temperature: Math.round(t * 10) / 10, gpuTemp: null };
    }
  } catch (_) {}

  return { temperature: 0, gpuTemp: null };
}

// ─── GPU ─────────────────────────────────────────────────────────────────────
// GPU (某机型 confirmed):
//   gpu_busy_percentage → "89 %"   (primary)
//   gpubusy            → "N M"     (fallback ratio)
// 注意：不少机型（如 MTK 平台的 定制 ROM）对 shell 全部关闭了这些节点，
// 此时返回 null 表示「设备未提供」，由报告页显示为无数据，而不是误导性的 0。

/**
 * GPU 利用率读取。
 *
 * 各厂商开放方式完全不同，而且多数节点默认只有 root 能读，所以这里按三层来：
 *   1) 把所有候选节点拼进「一条」shell 脚本一次下发 —— 一次 adb 往返，避免逐条探测时
 *      每次都要等 timeout，把 1s 的采样周期拖垮（旧实现是 4 次串行 adb，这是取不到数的主因之一）；
 *   2) 命中即用，按可靠性从高到低排列，命中后不再尝试后面的；
 *   3) 全部失败且设备有 su 时，走 root 再读一遍（MTK 的 /proc/mtk_mali、GED 节点都是 root-only）。
 *
 * 仍失败返回 null —— 不返回 0。0 会被当成「GPU 占用 0%」画出一条贴底直线，
 * 比没有数据更容易误导；null 由报告页显式标注「该机型未开放」。
 */
const GPU_NODE_PROBES = [
  // Qualcomm Adreno
  ['kgsl_pct',    'cat /sys/class/kgsl/kgsl-3d0/gpu_busy_percentage'],
  ['kgsl_busy',   'cat /sys/class/kgsl/kgsl-3d0/gpubusy'],
  ['kgsl_load',   'cat /sys/class/kgsl/kgsl-3d0/devfreq/gpu_load'],
  // ARM Mali（通用路径 / MTK 变体）
  ['mali_util',   'cat /sys/class/misc/mali0/device/utilization'],
  ['mtk_mali',    'cat /proc/mtk_mali/utilization'],
  ['mtk_mali_alt','cat /proc/mali/utilization'],
  ['mali_load',   'cat /sys/class/devfreq/*.mali/load'],
  // MTK GED（debugfs，通常 root-only）
  ['ged_hal',     'cat /sys/kernel/debug/ged/hal/gpu_utilization'],
  ['ged_proc',    'cat /proc/ged/hal/gpu_utilization'],
  // MTK gpufreq（root-only，文本里带 util/loading 字段）
  ['mtk_gpufreq', 'cat /proc/gpufreq/gpufreq_var_dump'],
  ['mtk_opp',     'cat /proc/gpufreq/gpufreq_opp_dump'],
  // Samsung Exynos / PowerVR / 通用
  ['exynos',      'cat /sys/kernel/gpu/gpu_busy'],
  ['pvr',         'cat /sys/devices/platform/*.gpu/utilisation'],
  ['generic',     'cat /sys/class/gpu/gpu_busy_percentage'],
];

/** 每条探针前打一个 @@tag 分隔符，便于回读时切段 */
function buildGpuProbeScript() {
  return GPU_NODE_PROBES
    .map(([tag, cmd]) => `echo "@@${tag}"; ${cmd} 2>/dev/null`)
    .join('; ');
}

function splitProbeOutput(out) {
  const parts = {};
  let cur = null;
  for (const line of String(out || '').split('\n')) {
    const m = /^@@(\w+)$/.exec(line.trim());
    if (m) { cur = m[1]; parts[cur] = ''; continue; }
    if (cur) parts[cur] += line + '\n';
  }
  return parts;
}

/** 从一段文本里取第一个 0~100 的整数（带不带 % 都行） */
function pctFromText(txt) {
  const m = String(txt || '').match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const v = Math.round(parseFloat(m[1]));
  return (v >= 0 && v <= 100) ? v : null;
}

/** 按探针名把原始文本解释成百分比；解释不了返回 null */
function interpretGpuProbe(tag, txt) {
  const raw = String(txt || '').trim();
  if (!raw) return null;

  if (tag === 'kgsl_busy') {
    // 两个计数：busy total → 百分比
    const p = raw.split(/\s+/).map(Number);
    if (p.length >= 2 && p[1] > 0) {
      const v = Math.round((p[0] / p[1]) * 100);
      return (v >= 0 && v <= 100) ? v : null;
    }
    return null;
  }

  if (tag === 'mtk_gpufreq' || tag === 'mtk_opp') {
    // 形如 "gpu_util = 37" / "loading: 37" / "utilization 37"
    const m = raw.match(/(?:util\w*|loading)\s*[:=]?\s*(\d+(?:\.\d+)?)/i);
    return m ? pctFromText(m[1]) : null;
  }

  // 其余节点都是「直接一个 0~100 的数」，但可能夹着 45% 这种写法
  const first = raw.split('\n')[0];
  return pctFromText(first);
}

/** 该设备是否可用 su（结果缓存，一次采集会话内只探一次） */
const _rootState = new Map();

async function hasRoot(deviceId) {
  if (_rootState.has(deviceId)) return _rootState.get(deviceId);
  let ok = false;
  try {
    const out = await adbShell(deviceId, 'su -c id', 3000);
    ok = /uid=0/.test(out);
  } catch (_) {
    ok = false;
  }
  _rootState.set(deviceId, ok);
  return ok;
}

/** root 兜底：只试最可能有效的几个 root-only 节点 */
async function readGpuUsageViaRoot(deviceId) {
  const probes = [
    ['mtk_mali',    'cat /proc/mtk_mali/utilization'],
    ['ged_hal',     'cat /sys/kernel/debug/ged/hal/gpu_utilization'],
    ['mtk_gpufreq', 'cat /proc/gpufreq/gpufreq_var_dump'],
    ['kgsl_pct',    'cat /sys/class/kgsl/kgsl-3d0/gpu_busy_percentage'],
    ['mali_util',   'cat /sys/class/misc/mali0/device/utilization'],
  ];
  // 脚本内没有单引号，整体用单引号包住交给 su -c
  const script = probes.map(([tag, cmd]) => `echo "@@${tag}"; ${cmd} 2>/dev/null`).join('; ');
  try {
    const out = await adbShell(deviceId, `su -c '${script}'`, 4000);
    const parts = splitProbeOutput(out);
    for (const [tag] of probes) {
      const v = interpretGpuProbe(tag, parts[tag]);
      if (v != null) return v;
    }
  } catch (_) {}
  return null;
}

async function getGpuUsage(deviceId) {
  try {
    const out = await adbShell(deviceId, buildGpuProbeScript(), 6000);
    const parts = splitProbeOutput(out);
    for (const [tag] of GPU_NODE_PROBES) {
      const v = interpretGpuProbe(tag, parts[tag]);
      if (v != null) return v;
    }
  } catch (_) {}

  // 普通权限全灭：设备有 su 的话再试一次
  if (await hasRoot(deviceId)) {
    const v = await readGpuUsageViaRoot(deviceId);
    if (v != null) return v;
  }
  return null;
}

// ─── Per-core CPU usage + frequency ──────────────────────────────────────────

const _coreState = new Map();

async function getCpuCoreStats(deviceId) {
  const key = `${deviceId}_cores`;
  const now = Date.now();
  try {
    // Single shell: all cpuN lines from /proc/stat + per-core frequencies
    const cmd =
      "cat /proc/stat; echo '---FREQ---';" +
      "for f in /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq;" +
      " do cat \"$f\" 2>/dev/null || echo 0; done";
    const out = await adbShell(deviceId, cmd, 6000);
    const sep = out.indexOf('---FREQ---');
    const statPart = sep >= 0 ? out.slice(0, sep) : out;
    const freqPart = sep >= 0 ? out.slice(sep + 10)  : '';

    // Parse cpu0, cpu1, … lines
    const coreLines = statPart.split('\n').filter(l => /^cpu\d/.test(l));
    const coreData  = coreLines.map(line => {
      const nums = line.trim().split(/\s+/).slice(1).map(Number);
      return {
        idle:  nums[3] + (nums[4] || 0),
        total: nums.reduce((a, b) => a + b, 0),
      };
    });

    // Frequencies: kHz → MHz
    const freq = freqPart.trim().split('\n')
      .map(l => { const v = parseInt(l.trim(), 10); return isNaN(v) ? 0 : Math.round(v / 1000); });

    const prev = _coreState.get(key);
    _coreState.set(key, { cores: coreData, ts: now });

    if (!prev) return { usage: coreData.map(() => 0), freq };

    const usage = coreData.map((curr, i) => {
      const p = prev.cores[i];
      if (!p) return 0;
      const td = curr.total - p.total;
      const id = curr.idle  - p.idle;
      return td > 0 ? clamp(Math.round(((td - id) / td) * 100), 0, 100) : 0;
    });

    return { usage, freq };
  } catch (_) {
    return { usage: [], freq: [] };
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

function resetDeviceState(deviceId) {
  _timestatsEnabled.delete(deviceId);
  for (const map of [_cpuState, _netState, _fpsState, _coreState]) {
    for (const k of map.keys()) { if (k.startsWith(deviceId)) map.delete(k); }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// ─── Perfara.apk：安装与广播应用列表 ─────────────────────────────────────────

const PERFARA_PKG = 'com.example.perfara';

/** adb.exe 同目录下的 perfara.apk（与 Win 打包 adb/win 布局一致） */
function resolvePerfaraApkPath() {
  const dir = path.dirname(ADB_BIN);
  const p = path.join(dir, 'perfara.apk');
  try {
    if (fs.existsSync(p)) return p;
  } catch (_) {}
  return null;
}

async function isPackageInstalled(deviceId, pkg) {
  if (!deviceId || !pkg) return false;
  try {
    const safe = String(pkg).replace(/[^a-zA-Z0-9._]/g, '');
    if (!safe) return false;
    const out = await adbShell(deviceId, `pm path ${safe} 2>/dev/null`, 10000);
    return /package:/.test(out);
  } catch (_) {
    return false;
  }
}

/**
 * 解析 am broadcast 输出中 data="…" 内多行「应用名 | 包名」
 */
function parsePerfaraBroadcastAppList(stdout) {
  const text = String(stdout || '');
  let inner = '';
  const m = text.match(/data="([\s\S]*?)"/);
  if (m) {
    inner = m[1];
  } else {
    const idx = text.indexOf('Broadcast completed');
    if (idx >= 0) {
      const sub = text.slice(idx);
      const q = sub.indexOf('data="');
      if (q >= 0) {
        const rest = sub.slice(q + 6);
        const end = rest.indexOf('"');
        inner = end >= 0 ? rest.slice(0, end) : rest;
      }
    }
  }
  const lines = inner.split(/\r?\n/);
  const apps = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s*\|\s*/).map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const pkg = parts[parts.length - 1];
    const label = parts.slice(0, -1).join(' | ');
    if (!pkg || !/^[a-zA-Z][a-zA-Z0-9._]*$/.test(pkg)) continue;
    apps.push({ pkg, label: label || pkg });
  }
  return apps;
}

async function getAppListFromPerfaraBroadcast(deviceId) {
  const out = await adb(
    [
      '-s',
      deviceId,
      'shell',
      'am',
      'broadcast',
      '-a',
      'com.example.perfara.GET_APP_LIST',
      '-n',
      'com.example.perfara/.AppListReceiver',
    ],
    30000,
  );
  return parsePerfaraBroadcastAppList(out);
}

/**
 * apk 模式：必要时单次尝试安装 perfara，再尝试广播。安装/检测/广播任一步异常或失败均忽略，直接按 config.apk=false 同逻辑拉取 pm list -3。
 * @returns {{ ok: true, packages, perfaraAlreadyInstalled, usedPmListFallback?: boolean } | { ok: false, reason: string }}
 */
async function prepareAndroidPerfaraPackages(deviceId) {
  if (!deviceId) {
    return { ok: false, reason: '未选择设备' };
  }

  async function loadPackagesLikeNonApkMode() {
    try {
      const packages = await getThirdPartyPackages(deviceId);
      if (!packages.length) {
        return { ok: false, reason: '未获取到应用列表' };
      }
      return {
        ok: true,
        packages,
        perfaraAlreadyInstalled: false,
        usedPmListFallback: true,
      };
    } catch (e) {
      return {
        ok: false,
        reason: `获取第三方应用列表失败: ${e.message || e}`,
      };
    }
  }

  try {
    const alreadyHadPerfara = await isPackageInstalled(deviceId, PERFARA_PKG);
    const apkPath = resolvePerfaraApkPath();
    if (!alreadyHadPerfara && apkPath) {
      try {
        await adb(['-s', deviceId, 'install', '-r', apkPath], 180000);
      } catch (_) {
        /* 安装失败忽略 */
      }
    }
    const hasPerfara = await isPackageInstalled(deviceId, PERFARA_PKG);
    let broadcastOk = false;
    let packages = [];
    if (hasPerfara) {
      try {
        packages = await getAppListFromPerfaraBroadcast(deviceId);
        broadcastOk = Array.isArray(packages) && packages.length > 0;
      } catch (_) {
        packages = [];
      }
    }
    if (!broadcastOk) {
      return await loadPackagesLikeNonApkMode();
    }
    return {
      ok: true,
      packages,
      perfaraAlreadyInstalled: alreadyHadPerfara,
      usedPmListFallback: false,
    };
  } catch (_) {
    return await loadPackagesLikeNonApkMode();
  }
}

module.exports = {
  getDevices, getDeviceInfo, getThirdPartyPackages, getPid, getUid, ensureAppRunning,
  getCpuStats, getMemInfo, getFps,
  getNetStats, getBatteryInfo, getThermalInfo, getGpuUsage,
  getCpuCoreStats,
  resetDeviceState, connectWifi, autoConnectWifi, disconnectWifi,
  resolvePerfaraApkPath, isPackageInstalled, prepareAndroidPerfaraPackages,
  parsePerfaraBroadcastAppList, getAppListFromPerfaraBroadcast,
  cancelAllInflight,
  // 纯算法导出：供离线回归测试锁定 FPS/Jank 判定口径（不影响运行时行为）
  __algo: {
    parseHistogram, histDelta, detectVsync, analyseHistogram,
    calcJankFramestats, vsyncMsFromRefreshRate,
    MOVIE_FRAME_X2_MS, MOVIE_FRAME_X3_MS,
  },
};
