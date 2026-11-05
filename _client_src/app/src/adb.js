'use strict';

const { execFile } = require('child_process');
const path = require('path');
const fs   = require('fs');
const net  = require('net');

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

/**
 * 单指标 adb 调用超时。
 * 必须显著小于采样间隔（1 s），否则设备一卡就会出现 tick 叠加：
 * 旧值 10 s 意味着最多叠 10 个 tick × 9 个 adb 进程 = 90 个进程，越卡越卡。
 * 配合 collector.js 的重入门闩，两处一起才能根除雪崩。
 */
const SHELL_TIMEOUT_MS = 4000;
/**
 * dumpsys 类大命令超时。这类命令输出几 KB~几十 KB，慢机型要 2~3 s，
 * 用 4 s 容易误判超时、直接丢样本（表现为 FPS 曲线断点），故单独放宽。
 */
const DUMPSYS_TIMEOUT_MS = 10000;
/** FPS 上限：需覆盖 144 / 165 / 240Hz 高刷机；旧值 120 会把高刷帧率削平，误报掉帧 */
const FPS_CAP = 240;

// Track inflight adb child processes so we can cancel stale tasks
const _inflight = new Set();

/* ─── adb server 归属：退出时「该不该收」────────────────────────────────────
   adb 客户端执行任意命令时会自动 fork 一个常驻的 adb server（`fork-server server`），
   它**不随客户端退出**。本工具是「开着采完就关」的用法，如果不管它，adb.exe 就会以
   孤儿进程常驻：既占着 5037，又把便携包里的 adb.exe 文件锁住（整个目录都移不走 / 删不掉）。

   但 5037 是全局共享的（Escrcpy、Android Studio、用户自己的 adb 都连它），无脑
   `kill-server` 会打断别人。所以只在「本进程第一次调 adb 之前 5037 没人监听」时，
   认定这个 server 是我们拉起来的；退出时也只收自己拉起的那个。 */
const ADB_SERVER_PORT = resolveServerPort();
let _serverProbe = null;        // Promise<boolean>，整个进程只探测一次
let _serverStartedByUs = false;

/**
 * adb 客户端认 `ANDROID_ADB_SERVER_PORT`（多设备/多工具共存时常用）。
 * 探测必须跟它走同一个端口，否则要么探测不到自己拉起的 server，要么去杀别人的。
 */
function resolveServerPort() {
  const raw = parseInt(process.env.ANDROID_ADB_SERVER_PORT || '', 10);
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : 5037;
}

function _probeServerRunning() {
  return new Promise((resolve) => {
    let sock = null;
    let done = false;
    const finish = (running) => {
      if (done) return;
      done = true;
      try { if (sock) sock.destroy(); } catch (_) {}
      resolve(running);
    };
    try {
      sock = net.connect({ host: '127.0.0.1', port: ADB_SERVER_PORT });
    } catch (_) {
      return resolve(false);
    }
    sock.setTimeout(700);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

// 测试注入点（离线套件不碰真实 5037，也不真的去杀 server）
let _probeFn = _probeServerRunning;
let _killFn = (cb) => execFile(
  ADB_BIN, ['kill-server'], { timeout: 3000, windowsHide: true }, (err) => cb(err));

/**
 * 首个 adb 命令之前探一次 5037。必须 await 在真正 spawn 之前，否则等第一条命令
 * 把 server 拉起来就分辨不出「本来就有」和「我们起的」。
 */
function ensureServerOwnership() {
  if (!_serverProbe) {
    _serverProbe = Promise.resolve()
      .then(() => _probeFn())
      .then((running) => {
        if (!running) _serverStartedByUs = true;
        return !!running;
      })
      .catch(() => false);
  }
  return _serverProbe;
}

/**
 * 退出清理：只收本进程拉起的 adb server。
 * 直连 execFile 而不是走 adb()：kill 期间不该再登记 inflight，也别被探测/门闩顺序卡住。
 * 拿不到结果就放弃（最多 timeout+0.5 s），绝不拖住退出。
 * @returns {Promise<{ok:boolean, killed:boolean, reason?:string}>}
 */
function killServerIfOwned(timeout = 3000) {
  return ensureServerOwnership().then(() => {
    if (!_serverStartedByUs) return { ok: true, killed: false, reason: 'not-ours' };
    return new Promise((resolve) => {
      let settled = false;
      let child = null;
      const finish = (killed) => {
        if (settled) return;
        settled = true;
        resolve({ ok: true, killed });
      };
      // 不要 unref：这个定时器就是「kill 卡住时的唯一出路」。unref 之后一旦事件循环
      // 没有别的句柄，计时器不会触发，promise 永远不 resolve —— 退出链又变成死等。
      const guard = setTimeout(() => {
        try { if (child) child.kill(); } catch (_) {}
        finish(false);
      }, timeout + 500);
      try {
        child = _killFn((err) => { clearTimeout(guard); finish(!err); });
      } catch (_) {
        clearTimeout(guard);
        finish(false);
      }
    });
  }).then((res) => {
    if (res && res.killed) _serverStartedByUs = false;
    return res;
  }).catch(() => ({ ok: false, killed: false }));
}

/** 测试用：替换探测/结束器，并在用例之间重置状态 */
function __setServerRunner(runner) {
  const r = runner || {};
  _probeFn = typeof r.probe === 'function' ? r.probe : _probeServerRunning;
  _killFn = typeof r.kill === 'function' ? r.kill : ((cb) => execFile(
    ADB_BIN, ['kill-server'], { timeout: 3000, windowsHide: true }, (err) => cb(err)));
  _serverProbe = null;
  _serverStartedByUs = false;
}

function adb(args, timeout = 10000) {
  // 先确认 server 归属再 spawn：顺序不能反（见 ensureServerOwnership）
  return ensureServerOwnership().then(() => new Promise((resolve, reject) => {
    const child = execFile(ADB_BIN, args, { timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      // If we were cancelled, treat as silent failure for callers to handle.
      if (err) {
        // 设备端的真实结论在 **stdout**（如 monkey 的 "No activities found to run"、
        // am start 的 "unable to resolve Intent"），而 adb 自身的报错在 stderr。
        // 只取 stderr 会把关键判据丢掉，导致上层误判为「启动失败但不知道原因」，
        // 进而白等满轮询时间。两者都带上，调用方按需匹配。
        const parts = [];
        if (stdout && String(stdout).trim()) parts.push(String(stdout).trim());
        if (stderr && String(stderr).trim()) parts.push(String(stderr).trim());
        const detail = parts.join('\n') || err.message;
        return reject(new Error(detail));
      }
      resolve(stdout);
    });
    try {
      _inflight.add(child);
      child.once('exit', () => _inflight.delete(child));
      child.once('error', () => _inflight.delete(child));
    } catch (_) {}
  }));
}

function adbShell(deviceId, cmd, timeout = SHELL_TIMEOUT_MS) {
  return adb(['-s', deviceId, 'shell', cmd], timeout);
}

/**
 * 截取设备当前画面（PNG 原始字节）。
 * 必须用 exec-out：`shell screencap -p` 在 Windows 上会被 adb 的换行转换破坏 PNG。
 * 1080×2400 PNG 约 1~3 MB，maxBuffer 给 32 MB 余量。
 */
function captureScreen(deviceId, timeout = 8000) {
  return ensureServerOwnership().then(() => new Promise((resolve, reject) => {
    const child = execFile(
      ADB_BIN,
      ['-s', deviceId, 'exec-out', 'screencap', '-p'],
      { timeout, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr && String(stderr).trim()) || err.message;
          return reject(new Error(msg));
        }
        const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '');
        if (buf.length < 100 || buf.slice(0, 8).toString('binary') !== '\x89PNG\r\n\x1a\n') {
          return reject(new Error(`screencap 返回非法 PNG（${buf.length} B）`));
        }
        resolve(buf);
      }
    );
    try {
      _inflight.add(child);
      child.once('exit', () => _inflight.delete(child));
      child.once('error', () => _inflight.delete(child));
    } catch (_) {}
  }));
}

/**
 * 设备侧 shell 的单引号安全包裹。
 * adb shell 的参数在 PC 端走 execFile（不过本地 shell），但到了设备端会被
 * /system/bin/sh 重新解析一次 —— 包名/组件名里混进单引号就能改写设备上的命令。
 * 包名来自渲染进程的 IPC，组件名来自设备输出，两者都不能当可信字符串。
 */
function shellArg(value) {
  return "'" + String(value == null ? '' : value).replace(/'/g, "'\\''") + "'";
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

/**
 * 反向转发：手机上的 127.0.0.1:phonePort 落到本机 pcPort（省略则为同号端口）。
 * 手机接管弱网靠它 —— 手机系统代理指向 127.0.0.1:port 时，流量经 USB 进到
 * 本机的 WeakNet 代理；全程只用 adb，手机不需要装任何东西。
 */
async function reverseTcp(deviceId, phonePort, pcPort) {
  const remote = pcPort || phonePort;
  await adb(['-s', deviceId, 'reverse', `tcp:${phonePort}`, `tcp:${remote}`], 6000);
}

/** 撤掉 reverseTcp；映射不存在时 adb 会报错，交给调用方忽略 */
async function removeReverse(deviceId, port) {
  await adb(['-s', deviceId, 'reverse', '--remove', `tcp:${port}`], 6000);
}

/** 当前设备上的反向映射列表（`adb reverse --list` 的原文行） */
async function listReverses(deviceId) {
  const out = await adb(['-s', deviceId, 'reverse', '--list'], 6000);
  return String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** 把本机文件推到手机上（弱网守护脚本用；脚本里必须保留 LF，不能走 shell 重定向） */
async function pushFile(deviceId, localPath, remotePath, timeout = 15000) {
  await adb(['-s', deviceId, 'push', localPath, remotePath], timeout);
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

/**
 * 第三方应用列表。带 versionCode 是为了给「应用名缓存」做失效键：
 * 应用一升级，缓存的桌面名就可能过期，必须重解。
 * Android 7 以下没有 --show-versioncode，退回纯包名（versionCode=null）。
 */
async function getThirdPartyPackages(deviceId) {
  let pkgOut = '';
  try {
    pkgOut = await adbShell(deviceId, 'pm list packages -3 --show-versioncode', 15000);
  } catch (_) {}
  if (!/versionCode:/.test(pkgOut)) {
    pkgOut = await adbShell(deviceId, 'pm list packages -3', 15000);
  }
  const rows = [];
  for (const line of pkgOut.split('\n')) {
    const s = line.replace(/\r/g, '').trim();
    const m = /^package:(\S+?)(?:\s+versionCode:(\d+))?$/.exec(s);
    if (!m) continue;
    rows.push({ pkg: m[1], label: m[1], versionCode: m[2] ? parseInt(m[2], 10) : null });
  }
  rows.sort((a, b) => (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0));
  return rows;
}

/** 设备界面语言（取 resources.arsc 里对应语言的 string），拿不到返回 null */
async function getDeviceLocale(deviceId) {
  try {
    const out = await adbShell(
      deviceId,
      'getprop persist.sys.locale; getprop persist.sys.language; getprop persist.sys.country',
      4000,
    );
    const [localeRaw = '', langRaw = '', countryRaw = ''] = out
      .split('\n').map(s => s.trim().toLowerCase());
    const m = /^([a-z]{2,3})(?:[-_]([a-z0-9]{2,4}))?$/.exec(localeRaw);
    if (m) return { lang: m[1], country: m[2] || '' };
    if (/^[a-z]{2,3}$/.test(langRaw)) return { lang: langRaw, country: countryRaw };
    return null;
  } catch (_) {
    return null;
  }
}

/** 包的 base.apk 路径；未安装/取不到返回 null */
async function getApkPath(deviceId, packageName) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const out = await adbShell(deviceId, `pm path ${shellArg(packageName)}`, 8000);
      const paths = out.split('\n')
        .map(l => l.replace(/^package:/, '').trim().replace(/\r/g, ''))
        .filter(Boolean);
      if (paths.length > 0) return paths.find(p => /base\.apk$/i.test(p)) || paths[0];
    } catch (_) {}
    // 一次失败可能只是 adb 通道抖动（实测偶发 device not found），等一下再问
    await new Promise(r => setTimeout(r, 400));
  }
  return null;
}

/**
 * 从设备 APK 里直接读一个条目的原始字节（exec-out + 设备端 unzip）。
 * 不把整个 APK 拉回 PC：一个 resources.arsc 就有 1.8~6.4 MB，整包只会更大。
 */
function readApkEntry(deviceId, apkPath, entry, timeout = 25000, maxBytes = 32 * 1024 * 1024) {
  return ensureServerOwnership().then(() => new Promise((resolve, reject) => {
    const child = execFile(
      ADB_BIN,
      ['-s', deviceId, 'exec-out', `unzip -p ${shellArg(apkPath)} ${shellArg(entry)}`],
      { timeout, encoding: 'buffer', maxBuffer: maxBytes },
      (err, stdout) => {
        const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '');
        if (err) {
          // 撑满缓冲说明是被截断的，宁可当失败下次再取，也别拿半个资源表当「没有名字」
          if (buf.length >= maxBytes) return reject(new Error('entry 超过缓冲上限，已截断'));
          if (buf.length > 0) return resolve(buf); // 部分 ROM 的 unzip 退出码非 0 但数据完整
          return reject(err);
        }
        resolve(buf);
      },
    );
    try {
      _inflight.add(child);
      child.once('exit', () => _inflight.delete(child));
      child.once('error', () => _inflight.delete(child));
    } catch (_) {}
  }));
}

/**
 * 解析包的桌面显示名。
 * @returns {Promise<string|null|undefined>} 名字；'' = 确认没有名字（可缓存）；
 *          null/undefined = 这次没成功（adb 抖动等），不要缓存，下次重试
 */
async function resolveAppLabel(deviceId, packageName, locale) {
  const { readManifestLabel, readArscString } = require('./apk-label');
  try {
    const apk = await getApkPath(deviceId, packageName);
    if (!apk) return null;
    const manifest = await readApkEntry(deviceId, apk, 'AndroidManifest.xml', 15000);
    const m = readManifestLabel(manifest);
    if (!m) return '';
    if (m.text) return String(m.text).trim();
    if (!m.resId) return '';
    // 个别 APK 的资源表能到 47 MB（booking），缓冲给足，不然会静默截断
    const arsc = await readApkEntry(deviceId, apk, 'resources.arsc', 40000, 64 * 1024 * 1024);
    const label = readArscString(arsc, m.resId, locale);
    return label ? String(label).trim() : '';
  } catch (_) {
    return null;
  }
}

/**
 * 判断包是否安装在设备上。
 *
 * `pm path <pkg>` 无输出即未安装（真机实测 ~90ms），
 * 比逐条尝试启动命令再轮询 PID 快两个数量级。
 */
async function isPackageInstalled(deviceId, packageName) {
  if (!packageName) return false;
  try {
    const out = await adbShell(deviceId, `pm path ${shellArg(packageName)} 2>/dev/null`, 6000);
    return /package:/.test(out);
  } catch (_) {
    return false;
  }
}

async function getPid(deviceId, packageName) {
  try {
    const out = await adbShell(deviceId, `pidof -s ${shellArg(packageName)} 2>/dev/null`);
    const pid = parseInt(out.trim(), 10);
    if (!isNaN(pid) && pid > 0) return pid;
  } catch (_) {}
  try {
    const out = await adbShell(deviceId, `ps -A 2>/dev/null | grep ${shellArg(packageName)} | head -1`);
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
/**
 * 解析包的 Launcher 组件（形如 `pkg/cls`），解析不到返回 null。
 *
 * 为什么必须解析组件：部分定制 ROM / Android 13（真机）上
 * `am start -a MAIN -c LAUNCHER -p <pkg>` 会直接返回
 *   `Error: Activity not started, unable to resolve Intent { ... pkg=... }`
 * 但同一个包 `cmd package resolve-activity` 能正常解析出组件，
 * 用 `am start -n <pkg/cls>` 也一定能起来。Unity 游戏（SurfaceView/BLAST）
 * 普遍是这个表现 —— 不解析组件就等于「所有游戏都无法从界面启动」。
 */
async function resolveLauncherComponent(deviceId, packageName) {
  const pkg = shellArg(packageName);
  // 1) Android 8+：cmd package resolve-activity（输出最后一行就是 pkg/cls）
  try {
    const out = await adbShell(deviceId,
      `cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${pkg} 2>/dev/null`, 6000);
    const hit = out.split('\n').map((s) => s.trim()).filter(Boolean)
      .find((s) => s.startsWith(packageName + '/'));
    if (hit) return hit;
  } catch (_) {}
  // 2) 老机型兜底：dumpsys package 里 LAUNCHER 分类附近的 activity 名
  try {
    const out = await adbShell(deviceId, `dumpsys package ${pkg} 2>/dev/null`, DUMPSYS_TIMEOUT_MS);
    const lines = out.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/android\.intent\.category\.LAUNCHER/.test(lines[i])) continue;
      for (let j = i; j >= Math.max(0, i - 15); j--) {
        const m = lines[j].match(/^\s*([\w.]+)\/([\w.$]+)\s/);
        if (m && m[1] === packageName) return `${m[1]}/${m[2]}`;
      }
    }
  } catch (_) {}
  return null;
}

/**
 * 判断包是否在前台（resumed activity）。
 * 性能采集的取帧通道都依赖**可见渲染层**：应用进程活着但在后台时，
 * timestats 匹配不到层、gfxinfo 也没有新帧，三条通道全废 → 采到的 fps 全是 null。
 * 真机实测：目标游戏在后台时 method=none，整段曲线没有 FPS。
 */
async function isAppForeground(deviceId, packageName) {
  try {
    const out = await adbShell(deviceId,
      'dumpsys activity activities 2>/dev/null | grep -m1 ResumedActivity', 6000);
    return out.includes(packageName);
  } catch (_) {
    return false;
  }
}

/**
 * 采集「启动时要不要自动选中前台应用」所需的三路原始输出。
 * 判定逻辑全在 src/foreground-app.js（纯函数），这里只负责取数：
 *   - dumpsys 两路互为兜底（部分 ROM 只在 window 里写 mCurrentFocus）
 *   - HOME resolver 给出设备自己的桌面包名，避免硬编码厂商 launcher 清单
 * 三路并行、各自吞异常；任何一路失败都只是少一个判据，绝不让启动卡住。
 */
async function getForegroundSnapshot(deviceId) {
  const quiet = (p) => p.catch(() => '');
  const [activityDump, windowDump, homeResolve] = await Promise.all([
    quiet(adbShell(deviceId,
      "dumpsys activity activities 2>/dev/null | grep -m2 -E 'ResumedActivity'", DUMPSYS_TIMEOUT_MS)),
    quiet(adbShell(deviceId,
      "dumpsys window 2>/dev/null | grep -m2 -E 'mCurrentFocus|mFocusedApp'", DUMPSYS_TIMEOUT_MS)),
    quiet(adbShell(deviceId,
      'cmd package resolve-activity --brief -a android.intent.action.MAIN'
      + ' -c android.intent.category.HOME 2>/dev/null', 6000)),
  ]);
  return { activityDump, windowDump, homeResolve };
}

async function ensureAppRunning(deviceId, packageName, logFn) {
  const log = typeof logFn === 'function' ? logFn : () => {};
  if (!deviceId || !packageName) {
    return { ok: false, launched: false, pid: null, error: 'deviceId 或 packageName 为空' };
  }

  // ── 前置检查：包是否装在设备上 ──────────────────────────────────────────
  // 必须在尝试启动之前做：包根本没装时，任何启动命令都不可能成功，
  // 逐条尝试 + 轮询 PID 会白白耗掉 20+ 秒才报错（真机实测 23.5s），
  // 用户看到的就是「点了开始没反应」。
  const installed = await isPackageInstalled(deviceId, packageName);
  if (!installed) {
    log(`[adb] 设备上未安装该应用: ${packageName}`);
    return {
      ok: false, launched: false, pid: null,
      error: `该应用未安装在设备上：${packageName}。请先在设备上安装后再开始采集。`,
    };
  }

  let pid = await getPid(deviceId, packageName).catch(() => null);
  /** 进程在本次调用之前就已经存在 —— 用于区分「真启动」与「复用已有进程」 */
  const hadProcess = !!pid;
  if (pid) {
    // 进程活着还不够：必须在**前台**才有可见图层可供取帧，否则整段 FPS 都是 null
    if (await isAppForeground(deviceId, packageName)) {
      log(`[adb] 应用已在前台运行，无需启动 (PID=${pid})`);
      return { ok: true, launched: false, pid };
    }
    log(`[adb] 应用在后台运行 (PID=${pid})，切到前台以便取帧`);
  } else {
    log(`[adb] 未检测到进程，尝试启动应用: ${packageName}`);
  }
  const pkg = shellArg(packageName);

  // 启动方式按可靠性从高到低排：
  //   ① am start -n <组件>   —— 先解析出 Launcher 组件再精确启动，最可靠
  //   ② am start -p <包>     —— 老路径，部分定制 ROM 解析不到隐式 Intent
  //   ③ monkey -p <包>       —— 老设备兜底（Android 10 以下 am start 不支持 -p）
  const comp = await resolveLauncherComponent(deviceId, packageName);
  if (comp) log(`[adb] Launcher 组件: ${comp}`);
  const attempts = [];
  if (comp) attempts.push(['am start -n', `am start -n ${shellArg(comp)} 2>&1`]);
  attempts.push(
    ['am start -p', `am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ${pkg} 2>&1`],
    ['monkey', `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1 2>&1`],
  );

  /** 本次尝试是否明确报「解析不到入口」 */
  const isNoEntry = (s) => /unable to resolve|No activity found|Error type 3|not found|No activities found to run/i.test(s);
  let noEntryCount = 0;

  for (const [label, cmd] of attempts) {
    let out = '';
    try {
      out = await adbShell(deviceId, cmd, 10000);
    } catch (e) {
      // execFile 在退出码非 0 时 reject，错误信息里带着设备端输出
      out = String((e && e.message) || '');
    }
    const noEntry = isNoEntry(out);
    // 累计计数，**不要**在非 noEntry 时清零：
    // 之前写成 `else noEntry = 0`，导致「三种方式都报无入口」的判定永远不成立，
    // 无入口应用会白等满 3 轮轮询（真机实测 24s）才落到通用错误文案。
    if (noEntry) noEntryCount++;
    log(`[adb] ${label}: ${out.trim().split('\n').slice(0, 2).join(' / ').slice(0, 160)}`);

    // 明确报「无入口」时不再空转轮询 —— 该方式不可能成功，直接换下一种。
    // （此前这里无条件轮询 5s × 3 种方式 = 15~24 秒，是「点了没反应」的根因）
    if (noEntry) {
      log(`[adb] ${label}: 无可启动入口，跳过等待`);
      continue;
    }

    // 应用启动通常 1~3 秒；轮询 5 秒足够
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      pid = await getPid(deviceId, packageName).catch(() => null);
      if (pid) {
        // 进程本来就活着时，系统只是把已有任务带到前台
        // （输出 "Warning: Activity not started, its current task has been brought to the front"）。
        // 这**不是**新启动，没必要再等 5 秒稳定期 —— 之前误报 launched=true，
        // 会让采集白白晚 5 秒才开始，日志也误导成「应用已启动」。
        if (hadProcess) {
          log(`[adb] 应用已切换到前台 (PID=${pid})`);
          return { ok: true, launched: false, switched: true, pid };
        }
        log(`[adb] 应用已启动 (PID=${pid})`);
        return { ok: true, launched: true, pid };
      }
    }
  }

  // 三种方式都没起来：只有「组件解析不到」且「每种方式都报无入口」才判定没有入口
  if (!comp && noEntryCount >= attempts.length) {
    return {
      ok: false,
      launched: false,
      pid: null,
      error: `该应用没有可启动入口（无 Launcher Activity），无法自动拉起：${packageName}。`
        + '请换选一个应用，或先在手机上打开它再点开始。',
    };
  }
  return {
    ok: false,
    launched: true,
    pid: null,
    error: '未能拉起该应用：请先在手机上手动打开它再点开始。'
      + '若需自动拉起，请在系统设置中允许该应用「自启动/后台弹出界面」，'
      + '并关闭省电限制（部分厂商 ROM 默认会拦截 adb 拉起）。',
  };
}

async function getUid(deviceId, packageName) {
  try {
    const out = await adbShell(deviceId, `dumpsys package ${shellArg(packageName)} 2>/dev/null | grep -m1 userId=`, DUMPSYS_TIMEOUT_MS);
    const m = out.match(/userId=(\d+)/);
    if (m) return parseInt(m[1], 10);
  } catch (_) {}
  return null;
}

// ─── CPU ─────────────────────────────────────────────────────────────────────

const _cpuState = new Map();

/**
 * 解析 /proc/<pid>/stat 的 utime + stime（累计 jiffies）。
 *
 * 不能按 split(/\s+/) 的固定下标 p[13]/p[14] 取：第 2 字段 comm 是用括号包住的
 * 进程名，内核允许它含空格甚至右括号（"Render Thread"、"foo) bar"）。按空格切
 * 会让后续字段整体右移，把 ppid / minflt 之类当成 CPU 时间，下一帧算出的增量
 * 被 clamp 成 100%，看起来像「应用吃满 CPU」——典型的错误采集。
 *
 * 正确做法：找最后一个 ')'，从它之后重新编号。')' 后第 1 个字段是 state
 * （/proc/<pid>/stat 的第 3 字段），于是 utime(第 14 字段) = rest[11]、
 * stime(第 15 字段) = rest[12]。
 * 抽成纯函数并导出，便于用「带空格 comm」的原始 stat 行离线锁定口径。
 */
function parsePidStat(raw) {
  const s = String(raw || '');
  const close = s.lastIndexOf(')');
  if (close < 0) return null;
  const rest = s.slice(close + 1).trim().split(/\s+/);
  if (rest.length < 13) return null;
  const utime = parseInt(rest[11], 10);
  const stime = parseInt(rest[12], 10);
  return (isFinite(utime) && isFinite(stime)) ? utime + stime : null;
}

/**
 * 由两次快照算 CPU 使用率（纯函数，便于离线锁定口径）。
 *   sysCpu  = 整机占用，0~100
 *   procCpu = 进程占用，**按单核百分比**（单核跑满 = 100，N 核可到 N×100）
 * 分母必须是「单核平均总时长」= 整机总增量 ÷ 在线核数；直接除以整机总增量
 * 得到的是「占整机百分比」，8 核机上会只剩 1/8，系统性低估。
 */
function calcCpuPct(prevPid, currPid, totalDelta, idleDelta, coreCount) {
  const n = Math.max(coreCount || 1, 1);
  let sysCpu = null, procCpu = null;
  if (!(totalDelta > 0)) return { sysCpu, procCpu };
  sysCpu = clamp(Math.round(((totalDelta - idleDelta) / totalDelta) * 100), 0, 100);
  const singleCoreTotal = totalDelta / n;
  if (prevPid != null && currPid != null && singleCoreTotal > 0) {
    procCpu = clamp(Math.round(((currPid - prevPid) / singleCoreTotal) * 100), 0, n * 100);
  }
  return { sysCpu, procCpu };
}

/**
 * 一次 shell 取「整机 + 进程 + 逐核」的完整 CPU 快照。
 *
 * 合并原因（重复采集）：旧实现 getCpuStats 与 getCpuCoreStats 各自 `cat /proc/stat`，
 * 同一 tick 读两次同一文件 —— 两次读数相隔几毫秒到上百毫秒，整机使用率与逐核均值
 * 对不上（同源不同刻），而且每 tick 多起一个 adb 进程（实测 60~120 ms）。
 * 合并后三个结果出自同一份 /proc/stat，口径与时刻都一致，还少一次往返。
 *
 * 进程 CPU 口径（必须对齐文档「utime+stime 差值 ÷ 间隔时长」）：
 *   /proc/stat 的 `cpu ` 行是**所有核**的 jiffies 之和。直接拿它当分母得到的是
 *   「占整机百分比」——8 核机上单核跑满只有 12.5%，与 PerfDog / 任务管理器的
 *   「占单核百分比」（单核跑满 = 100%，多线程可超 100%）差一个核数倍，属系统性低估。
 *   这里除以在线核数还原成单核口径，上限放宽到 N×100%。
 */
async function getCpuSnapshot(deviceId, pid) {
  const key = `${deviceId}_${pid || 'sys'}`;
  const coreKey = `${deviceId}_cores`;
  const now = Date.now();
  const cmd = 'cat /proc/stat 2>/dev/null; echo "---PIDSTAT---"; '
    + (pid ? `cat /proc/${pid}/stat 2>/dev/null; ` : '')
    + 'echo "---FREQ---"; '
    + 'for f in /sys/devices/system/cpu/cpu[0-9]*/cpufreq/scaling_cur_freq; do '
    + 'n=${f#/sys/devices/system/cpu/}; n=${n%%/*}; '
    + 'echo "$n $(cat "$f" 2>/dev/null || echo 0)"; done';

  let out = '';
  try {
    out = await adbShell(deviceId, cmd, 6000);
  } catch (_) {
    return { sysCpu: null, procCpu: null, cores: { usage: [], freq: [] }, coreCount: 0 };
  }

  const PID_MARK = '---PIDSTAT---';
  const FREQ_MARK = '---FREQ---';
  const pIdx = out.indexOf(PID_MARK);
  const fIdx = out.indexOf(FREQ_MARK);
  const statPart = pIdx >= 0 ? out.slice(0, pIdx) : (fIdx >= 0 ? out.slice(0, fIdx) : out);
  const pidPart  = pIdx >= 0 ? out.slice(pIdx + PID_MARK.length, fIdx >= 0 ? fIdx : out.length) : '';
  const freqPart = fIdx >= 0 ? out.slice(fIdx + FREQ_MARK.length) : '';

  const parseSys = (raw) => {
    const nums = raw.trim().split(/\s+/).slice(1).map(Number);
    if (nums.length < 5 || nums.some((n) => !isFinite(n))) return null;
    return { idle: nums[3] + (nums[4] || 0), total: nums.reduce((a, b) => a + b, 0) };
  };

  // 整机汇总行（`cpu `，注意带空格）与逐核行（`cpuN`）来自同一份输出
  const sysLine = statPart.split('\n').find((l) => l.startsWith('cpu ')) || '';
  const coreLines = statPart.split('\n').filter((l) => /^cpu\d+/.test(l));
  const coreIds = coreLines.map((l) => l.trim().split(/\s+/)[0]);
  const coreData = coreLines.map((line) => {
    const nums = line.trim().split(/\s+/).slice(1).map(Number);
    return { idle: nums[3] + (nums[4] || 0), total: nums.reduce((a, b) => a + b, 0) };
  });
  const coreCount = coreIds.length;

  let pidRaw = '';
  if (pid && pidPart) {
    pidRaw = pidPart.split('\n').find((l) => {
      const p = l.trim().split(/\s+/);
      return p.length > 14 && parseInt(p[0], 10) === pid;
    }) || '';
  }

  // 频率按 cpuN 名称配对：glob 顺序是 cpu0,cpu1,cpu10,…,cpu2，按下标硬对齐会张冠李戴
  const freqMap = new Map();
  for (const line of freqPart.split('\n')) {
    const m = line.trim().match(/^(cpu\d+)\s+(-?\d+)/);
    if (!m) continue;
    const v = parseInt(m[2], 10);
    freqMap.set(m[1], isFinite(v) && v > 0 ? Math.round(v / 1000) : null);
  }
  const freq = coreIds.map((id) => (freqMap.has(id) ? freqMap.get(id) : null));

  const curr = { sys: sysLine ? parseSys(sysLine) : null,
                 pid: (pid && pidRaw) ? parsePidStat(pidRaw) : null, ts: now };
  const prev = _cpuState.get(key);
  _cpuState.set(key, curr);

  const currCores = { ids: coreIds, cores: coreData, ts: now };
  const prevCores = _coreState.get(coreKey);
  _coreState.set(coreKey, currCores);
  const usage = coreCount ? pairCoreUsage(prevCores, currCores) : [];

  // 首帧没有基线、或本次读失败：使用率「未测量」，不是 0%
  let pct = { sysCpu: null, procCpu: null };
  if (prev && prev.sys && curr.sys) {
    pct = calcCpuPct(prev.pid, curr.pid,
      curr.sys.total - prev.sys.total,
      curr.sys.idle - prev.sys.idle,
      coreCount);
  }
  return { sysCpu: pct.sysCpu, procCpu: pct.procCpu, cores: { usage, freq }, coreCount };
}

/** 兼容包装：只取整机 / 进程两项。采集主循环请直接用 getCpuSnapshot 避免重复读。 */
async function getCpuStats(deviceId, pid) {
  const s = await getCpuSnapshot(deviceId, pid);
  return { sysCpu: s.sysCpu, procCpu: s.procCpu };
}

// ─── Memory ──────────────────────────────────────────────────────────────────

/**
 * 解析 dumpsys meminfo + /proc/meminfo（纯函数，便于离线锁定分项口径）。
 * 分项统一取 App Summary 区块（形如 "Native Heap:  1360"，带冒号、纯 Pss）；
 * 取不到才回退明细表（"Native Heap  1901"）。两者可差数 MB，混用会让同一张表
 * 出现两种口径（旧实现正是 nativeHeap 走明细表、其余走汇总表）。
 */
function parseMemInfoSections(out, mi) {
  const text = String(out || '');
  const mem  = String(mi || '');
  const totalMatch = text.match(/^\s*TOTAL\s+(\d+)/m);
  const summary = (label) => {
    const m = text.match(new RegExp(`^\\s*${label}:\\s+(\\d+)`, 'm'));
    return m ? Math.round(parseInt(m[1], 10) / 1024) : null;
  };
  const detail = (label) => {
    const m = text.match(new RegExp(`^\\s*${label}\\s{2,}(\\d+)`, 'm'));
    return m ? Math.round(parseInt(m[1], 10) / 1024) : null;
  };
  const nativeHeap = summary('Native Heap') ?? detail('Native Heap');
  // 老 ROM 的汇总行叫 Dalvik Heap，明细表同样叫 Dalvik Heap
  const javaHeap = summary('Java Heap') ?? summary('Dalvik Heap') ?? detail('Dalvik Heap');

  let memTotalMB = null, memAvailableMB = null;
  const mt = mem.match(/^MemTotal:\s+(\d+)/m);
  const ma = mem.match(/^MemAvailable:\s+(\d+)/m);
  if (mt) memTotalMB = Math.round(parseInt(mt[1], 10) / 1024);
  if (ma) memAvailableMB = Math.round(parseInt(ma[1], 10) / 1024);

  return {
    totalPss:     totalMatch ? Math.round(parseInt(totalMatch[1], 10) / 1024) : null,
    nativeHeap,
    javaHeap,
    dalvikHeap:   javaHeap,   // legacy alias
    code:         summary('Code') ?? detail('Code'),
    stack:        summary('Stack') ?? detail('Stack'),
    graphics:     summary('Graphics') ?? detail('Graphics'),
    privateOther: summary('Private Other'),
    system:       summary('System'),
    memTotalMB,
    memAvailableMB,
  };
}

async function getMemInfo(deviceId, packageName) {
  // 一次 shell 取两段：dumpsys meminfo（进程） + /proc/meminfo（整机）。
  // 旧实现分两次 adb，两个值来自不同时刻；合并后只解析同一份输出。
  const cmd = `dumpsys meminfo ${shellArg(packageName)} 2>/dev/null; `
    + 'echo "---PROCMEM---"; cat /proc/meminfo 2>/dev/null';
  try {
    const raw = await adbShell(deviceId, cmd, DUMPSYS_TIMEOUT_MS);
    const MARK = '---PROCMEM---';
    const idx = raw.indexOf(MARK);
    const out = idx >= 0 ? raw.slice(0, idx) : raw;
    const mi  = idx >= 0 ? raw.slice(idx + MARK.length) : '';
    return parseMemInfoSections(out, mi);
  } catch (_) {
    return { totalPss: null, nativeHeap: null, javaHeap: null, dalvikHeap: null, code: null, stack: null,
             graphics: null, privateOther: null, system: null, memTotalMB: null, memAvailableMB: null };
  }
}

// ─── 采集前健康检查（preflight） ──────────────────────────────────────────────
//
// 要解决的事：设备卡住时，旧链路会把「卡」一路传导到 PC 界面 —— 点开始之后
// ensureAppRunning 逐条尝试启动命令 + 轮询 PID，最坏要等 20 多秒才有反应，
// 用户看到的就是「点了没反应」；即便最后启动了，采到的也可能是一段整段 0/null
// 的废数据。这一层在**动应用之前**用 3 个有界检查把设备状态探清楚，任一项
// 不健康都立刻给出可操作的失败原因，而不是让用户干等：
//
//   responsive —— adb 通道是否还通（设备离线 / 锁屏认证 / USB 抖动 / adb server 卡死）
//   memory     —— 整机可用内存（见底时目标进程会被 LMK 杀，数据没有意义）
//   gpu        —— GPU 负载（已满载说明有别的应用占着 GPU，测到的是别人的负载）
//   screen     —— 屏幕是否点亮（灭屏时没有可见渲染层，三条取帧通道全废；
//                真机实测熄屏时 ResumedActivity 仍是目标应用，不查这一项
//                就会「采集中」跑满全程、曲线一片空白）
//
// 设计约束：
//   * 三项并行执行、各自有硬超时，总耗时有界（最坏 ~3s）；
//   * 读不到一律降级成「未知」，**不**因此判失败 —— 机型/权限差异太大，
//     误判失败比漏判更糟（会把本来能测的用户挡在门外）；
//   * 只读不写，不改变设备任何状态。

const PREFLIGHT_RESPONSE_TIMEOUT_MS = 2500;
const PREFLIGHT_MEM_TIMEOUT_MS     = 3000;
const PREFLIGHT_GPU_TIMEOUT_MS     = 3000;
const PREFLIGHT_SCREEN_TIMEOUT_MS  = 2500;
/** 唤醒后等渲染层恢复的时间 */
const SCREEN_WAKE_SETTLE_MS        = 600;
/** 可用内存低于此值判失败（MB）—— LMK 随时会杀目标进程，测了也白测 */
const MEM_CRITICAL_MB = 200;
/** 可用内存低于此值给警告（MB） */
const MEM_LOW_MB = 600;
/** GPU 负载高于此值给警告（%） */
const GPU_BUSY_PCT = 95;

/** 读整机内存；读不到返回 null（降级为未知，不判失败） */
async function probeDeviceMemory(deviceId, shell) {
  try {
    const out = await shell(deviceId, 'cat /proc/meminfo 2>/dev/null', PREFLIGHT_MEM_TIMEOUT_MS);
    const mt = out.match(/^MemTotal:\s+(\d+)/m);
    const ma = out.match(/^MemAvailable:\s+(\d+)/m);
    if (!mt || !ma) return null;
    const totalMB = Math.round(parseInt(mt[1], 10) / 1024);
    const availMB = Math.round(parseInt(ma[1], 10) / 1024);
    if (!(totalMB > 0) || !(availMB >= 0)) return null;
    return { totalMB, availMB, availPct: Math.round((availMB / totalMB) * 100) };
  } catch (_) {
    return null;
  }
}

/**
 * 读 GPU 负载（%）；节点不开放返回 null。
 * 不带 root 兜底（getGpuUsage 才有）：健康检查必须快，不能为一次 root 探测
 * 再多等几秒——那正是要消灭的「点了没反应」。
 */
async function probeGpuLoad(deviceId, shell) {
  try {
    const out = await shell(deviceId, buildGpuProbeScript(), PREFLIGHT_GPU_TIMEOUT_MS);
    const parts = splitProbeOutput(out);
    for (const [tag] of GPU_NODE_PROBES) {
      // gpubusy 是开机至今的累计平均，拿它判断「此刻是否被别人占满」没有意义
      if (tag === 'kgsl_busy') continue;
      const v = interpretGpuProbe(tag, parts[tag]);
      if (v != null) return v;
    }
  } catch (_) {}
  return null;
}

/**
 * 屏幕/锁屏状态探测。
 *
 * 真机实测的坑：熄屏时 `ResumedActivity` 仍然是目标应用，isAppForeground 返回
 * true、ensureAppRunning 认为「已在前台」直接放行；但屏幕熄灭就没有可见渲染层，
 * timestats/gfxinfo 都取不到帧 → 每个采样点都是 null。用户点开始后看到「采集中」，
 * 曲线却全程空白——这就是「点了没反应」最隐蔽的一种形态。
 *
 * @returns {Promise<{known:boolean, awake:boolean, locked:boolean|null, woke:boolean, wake:string}>}
 *   known=false 表示读不到（机型差异），调用方不得据此判失败
 */
async function probeScreenState(deviceId, shell) {
  const readWake = async () => {
    try {
      const out = await shell(deviceId, 'dumpsys power 2>/dev/null | grep -m1 mWakefulness', PREFLIGHT_SCREEN_TIMEOUT_MS);
      const m = String(out).match(/mWakefulness=(\w+)/);
      return m ? m[1] : '';
    } catch (_) {
      return '';
    }
  };

  let wake = await readWake();
  if (!wake) return { known: false, awake: true, locked: null, woke: false, wake: '' };

  let woke = false;
  if (wake !== 'Awake') {
    // 熄屏/休眠：用户刚在 PC 上点了「开始」，意图明确，直接替它点亮
    // （KEYCODE_WAKEUP）。点不亮再报错，别让用户对着一屏空数据猜原因。
    try { await shell(deviceId, 'input keyevent 224', PREFLIGHT_SCREEN_TIMEOUT_MS); } catch (_) {}
    await new Promise((r) => setTimeout(r, SCREEN_WAKE_SETTLE_MS));
    const after = await readWake();
    if (after) { woke = after === 'Awake'; wake = after; }
  }

  // 锁屏：亮着但被 keyguard 挡住，应用同样不可见
  let locked = null;
  try {
    const out = await shell(deviceId,
      'dumpsys window 2>/dev/null | grep -m1 -E "mShowingLockscreen|mDreamingLockscreen"',
      PREFLIGHT_SCREEN_TIMEOUT_MS);
    if (/mShowingLockscreen=true/.test(out)) locked = true;
    else if (/mShowingLockscreen=false/.test(out)) locked = false;
  } catch (_) {}

  return { known: true, awake: wake === 'Awake', locked, woke, wake };
}

/**
 * 采集前健康检查。
 * @param {string} deviceId
 * @param {Function} [shellFn] 依赖注入：底层 shell 执行器，默认 adbShell。
 *   离线测试用它喂假输出，验证阈值/降级/fail-fast 判定（不依赖真机）。
 * @returns {Promise<{level:'ok'|'warn'|'fail', ok:boolean, reason:string|null,
 *                    warnings:string[], notes:string[], summary:string, checks:Object}>}
 */
/**
 * 轻量通道探活：adb 能否在 timeout 内正常返回。
 *
 * 用途：getPid 在「应用被杀」和「adb 连接断了」两种情况下**都返回 null**，
 * 采集器据此直接报「应用进程已退出」会把 USB 掉线误诊成应用崩溃 ——
 * 用户会去重启应用，而不是检查线缆。这里用一次 echo 把两者区分开。
 *
 * @returns {Promise<boolean>} true=通道可用；false=不可用（或超时）
 */
async function probeChannel(deviceId, timeoutMs = 1500) {
  if (!deviceId) return false;
  try {
    const out = await adbShell(deviceId, 'echo __perfara_ok__', timeoutMs);
    return String(out).includes('__perfara_ok__');
  } catch (_) {
    return false;
  }
}

async function preflightCheck(deviceId, shellFn) {
  const shell = typeof shellFn === 'function' ? shellFn : adbShell;
  const result = {
    level: 'ok',
    ok: true,
    reason: null,
    warnings: [],
    notes: [],
    summary: '',
    checks: {},
  };
  if (!deviceId) {
    result.level = 'fail';
    result.ok = false;
    result.reason = '未选择设备，无法开始采集。';
    return result;
  }

  // ① 设备响应：最便宜也最关键的一项，单独跑，失败就不再往下探
  let responsive = false;
  let responseErr = '';
  try {
    const out = await shell(deviceId, 'echo __perfara_ok__', PREFLIGHT_RESPONSE_TIMEOUT_MS);
    responsive = String(out).includes('__perfara_ok__');
  } catch (e) {
    responsive = false;
    responseErr = String((e && e.message) || '').trim();
  }
  result.checks.responsive = responsive;
  if (!responsive) {
    result.level = 'fail';
    result.ok = false;
    result.reason = `设备无响应（${PREFLIGHT_RESPONSE_TIMEOUT_MS / 1000}s 内 adb 命令未返回）。`
      + '请检查：USB 线是否松动、屏幕是否已解锁并在弹窗中允许 USB 调试、'
      + '是否误触了「仅充电」以外的 USB 模式；无线连接请确认手机与电脑在同一网段。'
      // 带上设备端原文（如 "device not found" / "device offline"），排错时能少绕一圈
      + (responseErr ? `\n（adb 返回：${responseErr.split('\n')[0].slice(0, 120)}）` : '');
    return result;
  }

  // ②③④ 内存 / GPU / 屏幕 并行探（响应已确认，这里不会长时间挂起）
  const [mem, gpu, screen] = await Promise.all([
    probeDeviceMemory(deviceId, shell),
    probeGpuLoad(deviceId, shell),
    probeScreenState(deviceId, shell),
  ]);
  result.checks.memory = mem;
  result.checks.gpu = gpu;
  result.checks.screen = screen;

  // ④ 屏幕：熄灭且唤不醒 → 失败（帧数据依赖可见渲染层，此时采集必然全 null）
  if (screen.known && !screen.awake) {
    result.level = 'fail';
    result.ok = false;
    result.reason = `设备屏幕处于熄灭/休眠状态（mWakefulness=${screen.wake}），已尝试自动唤醒但未成功。`
      + '灭屏时没有可见渲染层，采不到任何帧数据。请手动点亮屏幕后重新开始。';
    return result;
  }
  if (screen.woke) {
    result.notes.push('检测到屏幕处于熄灭状态，已自动唤醒');
  }
  if (screen.locked === true) {
    result.warnings.push('设备处于锁屏状态，应用可能不可见，建议先解锁再采集');
  }

  // ② 内存
  if (mem) {
    if (mem.availMB < MEM_CRITICAL_MB) {
      result.level = 'fail';
      result.ok = false;
      result.reason = `设备可用内存仅剩 ${mem.availMB}MB（共 ${mem.totalMB}MB），`
        + '系统随时会杀掉目标进程，此时采到的数据不可用。'
        + '请先关闭后台应用或重启手机，再开始采集。';
      return result;
    }
    if (mem.availMB < MEM_LOW_MB) {
      result.warnings.push(`设备可用内存偏低（${mem.availMB}MB / 共 ${mem.totalMB}MB），建议先清理后台应用`);
    }
  } else {
    result.notes.push('未读到整机内存信息（/proc/meminfo 不可用），已跳过内存检查');
  }

  // ③ GPU
  if (gpu != null) {
    if (gpu >= GPU_BUSY_PCT) {
      result.warnings.push(`设备 GPU 负载 ${gpu}%，可能有其他应用正在占用 GPU，本次结果会偏高`);
    }
  } else {
    result.notes.push('该机型未开放 GPU 负载节点，报告页 GPU 利用率将显示为无数据');
  }

  const memTxt = mem ? `可用内存 ${(mem.availMB / 1024).toFixed(1)}G/${(mem.totalMB / 1024).toFixed(0)}G` : '内存不可读';
  const gpuTxt = gpu != null ? `GPU ${gpu}%` : 'GPU 负载不可读';
  const scrTxt = !screen.known ? '屏幕状态不可读' : (screen.awake ? '屏幕已点亮' : '屏幕熄灭');
  result.summary = `设备响应正常 · ${memTxt} · ${gpuTxt} · ${scrTxt}`;
  result.level = result.warnings.length ? 'warn' : 'ok';
  return result;
}

// ─── FPS + Jank + BigJank ─────────────────────────────────────────────────────
//
// Strategy (by priority):
//
//  Method 1 — SurfaceFlinger --timestats (BLAST/Unity, Android 11+)
//    ● Confirmed working on 某机型（中端 SoC）:
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
/**
 * framestats 通道的上一帧快照（按 device_pkg 缓存）。
 * PROFILEDATA 是「最近 N 帧」的**滚动窗口**，同一帧会在连续多个采样点里反复出现。
 * 旧实现直接拿整个窗口算 frames/dur：每个点报的都是「过去 N 帧的平均值」，
 * 旧帧被反复计入卡顿、帧率无法反映这一秒（真机 48 帧 / 190.56s → fps 恒 0）。
 * 这里保存上次窗口末尾的 completed 时间戳与尾部帧，本帧只统计新产生的帧。
 */
const _fsState = new Map();

/** 两次采样间隔超过「采样周期 × 该系数」即认为窗口已过期（中途切通道 / tick 被跳过） */
const FRAMESTATS_MAX_GAP_FACTOR = 2.5;

/**
 * 从 PROFILEDATA 滚动窗口里挑出「本次采样周期新产生」的帧。
 * @param {Array<{vsync:number,completed:number}>} frames 已按 vsync 升序
 * @param {{ts:number,lastCompleted:number,tail:Array}|undefined} prev 上次快照
 * @param {number} now 本次采样开始时间
 * @param {number} intervalMs 采样周期
 * @returns {{frames:Array, dt:number|null, tail:Array, usable:boolean,
 *            reason:string, state:Object}}
 */
function selectFramestatsWindow(frames, prev, now, intervalMs) {
  const state = {
    ts: now,
    lastCompleted: frames.length ? frames[frames.length - 1].completed : 0,
    tail: frames.slice(-4),          // 给下一帧的「前三帧均值」留基准
  };
  const dt = prev ? (now - prev.ts) / 1000 : null;
  const maxGap = Math.max((intervalMs / 1000) * FRAMESTATS_MAX_GAP_FACTOR, 3);
  const usableDt = dt != null && dt > 0 && dt <= maxGap;
  const fresh = (prev && usableDt)
    ? frames.filter(f => f.completed > prev.lastCompleted)
    : [];
  const reason = !prev ? 'init' : (!usableDt ? 'stale-window' : (!fresh.length ? 'no-frames' : ''));
  return {
    frames: fresh,
    dt,
    tail: prev ? (prev.tail || []) : [],
    usable: fresh.length > 0,
    reason,
    state,
  };
}

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
 * Jank/TinyJank 恒为 0（真机 / Android 13 实测复现）。
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

// 解析 `dumpsys gfxinfo <pkg> framestats` 的 ---PROFILEDATA--- 段 → [{ vsync, completed }]
// 抽成纯函数：既方便单测，也让真机用例能直接拿原始 dump 验算算法口径。
//
// 列索引必须**按表头名**取，不能写死。
// Android 10+ 在 Flags 之后插入了 FrameTimelineVsyncId / InputEventId /
// FrameInterval 等列（18 列 → 22 列），写死 cols[1]=vsync、cols[13]=completed
// 在 Android 13 上 cols[1] 是 FrameTimelineVsyncId（如 20368018），
// 会被 `vsync > 1e9` 全部丢掉 → 解析出 0 帧，Method 2 静默失效（真机 / Android 13 实测复现）。
function parseFramestats(out) {
  const frames = [];
  let inSection = false;
  let iVsync = 2;        // 18 列（Android 6~9）的默认位置
  let iCompleted = 15;
  let sawHeader = false;

  for (const line of String(out || '').split('\n')) {
    if (line.includes('---PROFILEDATA---')) { inSection = !inSection; continue; }
    if (!inSection) continue;
    const t = line.trim();
    if (/^Flags/i.test(t)) {
      const h = t.split(',');
      const vi = h.indexOf('Vsync');            // 精确匹配，避开 IntendedVsync
      const ci = h.indexOf('FrameCompleted');
      if (vi >= 0 && ci >= 0 && ci > vi) { iVsync = vi; iCompleted = ci; sawHeader = true; }
      continue;
    }
    const cols = t.split(',');
    if (cols.length <= iCompleted) continue;
    const vsync     = parseInt(cols[iVsync],     10);
    const completed = parseInt(cols[iCompleted], 10);
    if (vsync > 1e9 && completed > vsync) frames.push({ vsync, completed });
  }
  return { frames, iVsync, iCompleted, sawHeader };
}

// Per-frame Jank / BigJank / SmallJank / TinyJank from gfxinfo framestats timestamps
// minVsyncNs：只统计结束时间不早于该 vsync 的帧间隔。调用方会把上一周期尾部几帧
// 拼在 frames 前面给 avg3 提供基准，靠这个参数避免把旧帧再数一遍。
function calcJankFramestats(frames, minVsyncNs = 0) {
  const SMALL_JANK_MS = 84;
  let jank = 0, bigJank = 0, smallJank = 0, tinyJank = 0, evaluated = 0;

  // ── 帧间隔必须用相邻帧 Vsync 的差值 ────────────────────────────────────────
  // ⚠️ 不能用 FrameCompleted − Vsync：那是「本帧从 vsync 到渲染完成」的**呈现延迟**，
  //    跟帧节奏无关，且随缓冲深度/刷新率变化（真机实测：60Hz 三缓冲 ≈33.6ms，
  //    120Hz 设置页 ≈7.6ms）。一旦该值 ≥ 1.5×vsync（TinyJank 阈值），
  //    每一帧都会被判成微卡顿 → TinyJank ≈ 总帧数，指标彻底失去分辨力
  //    （真机复现，见报告第八节）。
  // 同一 vsync 内提交的多帧（Vsync 值相同）先去重，避免造出 0ms 的假间隔。
  const vsyncs = Array.from(new Set(frames.map(f => f.vsync))).sort((a, b) => a - b);
  const ft = [];
  for (let i = 1; i < vsyncs.length; i++) ft.push((vsyncs[i] - vsyncs[i - 1]) / 1e6); // ns → ms
  if (ft.length < 4) return { jank, bigJank, smallJank, tinyJank, evaluated };

  // 估算 vsync：帧间隔中位数吸附到常见刷新率
  const sortedFt = ft.filter(v => v > 0).sort((a, b) => a - b);
  let vsyncMs = 16.67;
  if (sortedFt.length) {
    const med = sortedFt[Math.floor(sortedFt.length / 2)];
    if (med <= 10) vsyncMs = 8.33;        // 120Hz
    else if (med <= 13) vsyncMs = 11.11;  // 90Hz
    else vsyncMs = 16.67;                 // 60Hz
  }
  // TinyJank 基准与 analyseHistogram 保持同一口径：
  //   取「屏幕 vsync」与「段内实际平均帧间隔」的较大者 —— 锁 30fps 的应用每帧恒定 ≈33ms，
  //   若仍以 16.67ms 为基准，整段帧都会被判成微卡顿。
  const avgMs = ft.reduce((s, v) => s + v, 0) / ft.length;
  const TINY_JANK_MS = Math.max(vsyncMs, avgMs) * 1.5;

  for (let i = 3; i < ft.length; i++) {
    // ft[i] 的结束时刻是 vsyncs[i + 1]；早于 minVsyncNs 的间隔属于上一周期，
    // 只用来算 avg3 基准，不计入本周期的卡顿次数 / evaluated 分母。
    if (minVsyncNs && vsyncs[i + 1] < minVsyncNs) continue;
    const avg3 = (ft[i - 1] + ft[i - 2] + ft[i - 3]) / 3;
    evaluated++;
    // Jank：PerfDog 双条件（> 2×前三帧均值 且 > 83.34ms）→ 取 max，与 histogram 路径同口径。
    //   ⚠️ 原实现为 ft > 16.67ms：60Hz 下任何正常帧都会被计成 Jank，指标失真。
    if (ft[i] > Math.max(2 * avg3, MOVIE_FRAME_X2_MS)) jank++;
    // TinyJank / SmallJank：绝对阈值档
    if (ft[i] >= TINY_JANK_MS) tinyJank++;
    if (ft[i] >= SMALL_JANK_MS) smallJank++;
    // Exact BigJank definition: both conditions → max
    if (ft[i] > Math.max(2 * avg3, MOVIE_FRAME_X3_MS)) bigJank++;
  }
  return { jank, bigJank, smallJank, tinyJank, evaluated };
}

// Main FPS entry point — returns { fps, jank, bigJank, jankRate, method }
// intervalMs 由采集器传入：framestats 要据此判断「上次快照是否已过期」。
/**
 * 从 gfxinfo 输出里取 "Total frames rendered" 做增量。
 * framestats 的输出是普通 gfxinfo 的超集，同一行就在里面 ——
 * 帧窗口不可用时直接复用它，不必再跑一遍 `dumpsys gfxinfo`（那是重复采集）。
 * 返回完整结果对象；无可用增量返回 null。
 */
function gfxTotalDelta(out, key, now, log) {
  const m = String(out || '').match(/^\s*Total frames rendered:\s*(\d+)/m);
  if (!m) return null;
  const total = parseInt(m[1], 10);
  const gKey = key + '_gfx';
  const gPrev = _fpsState.get(gKey);
  _fpsState.set(gKey, { total, ts: now });
  if (!gPrev || total === gPrev.total) return null;
  const dt = Math.max((now - gPrev.ts) / 1000, 0.5);
  // 计数器被重置 / 应用重启时 delta 可能为负，钳到 0 而不是报负帧率
  const fps = Math.min(Math.round(Math.max(0, total - gPrev.total) / dt), FPS_CAP);
  log(`[FPS] gfxinfo delta ✓ fps=${fps}`);
  // 这条通道只数得出帧，测不到卡顿分级：未测量写 null，不能报「零卡顿」
  return { fps, jank: null, bigJank: null, smallJank: null, tinyJank: null,
           jankRate: null, method: 'gfxinfo-delta' };
}

async function getFps(deviceId, packageName, logFn, intervalMs = 1000) {
  const log = logFn || (() => {});
  const key = `${deviceId}_${packageName}_fps`;
  const now = Date.now();
  const prev = _fpsState.get(key);

  // ── Enable timestats once per device ──────────────────────────────────────
  if (!_timestatsEnabled.has(deviceId)) {
    try {
      await adbShell(deviceId, 'dumpsys SurfaceFlinger --timestats -enable -clear 2>/dev/null', DUMPSYS_TIMEOUT_MS);
      _timestatsEnabled.add(deviceId);
      log('[FPS] timestats 已启用');
    } catch (e) { log(`[FPS] timestats 启用失败: ${e.message}`); }
  }

  // ── Method 1: --timestats (BLAST/Unity layers) ────────────────────────────
  try {
    const out = await adbShell(deviceId, 'dumpsys SurfaceFlinger --timestats -dump 2>/dev/null', DUMPSYS_TIMEOUT_MS);
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

        // 本采样周期一帧都没产出（delta=0）：说明应用当前没有可见渲染 ——
        // 静止页面、被遮挡、已切到后台等。这**不是**「真的掉到 0 帧」，
        // 写成 fps=0 会把报告里的 FPS 均值、1%Low 全部拉低，是假数据。
        // 判为无数据（method='no-frames'），由采集端写 null、曲线断开。
        if (delta === 0) {
          log(`[FPS] timestats 本周期无新帧（应用无可见渲染/已静止）→ 记为无数据`);
          return {
            fps: 0, jank: 0, bigJank: 0, smallJank: 0, tinyJank: 0, jankRate: 0,
            method: 'no-frames',
          };
        }

        const fps   = Math.min(Math.round(delta / dt), FPS_CAP);

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

        // Jank 家族是「本采样周期的卡顿次数（帧）」，与卡片上的「帧」、报告页
        // Jank/10min 派生指标（累计次数 ÷ 时长）、iOS/PC 通道是同一口径。
        // 旧实现在这里额外除以 dt 归一化成「次/秒」：adb 一慢（实测 dt 可达数秒），
        // 同一次卡顿就被缩小 dt 倍，而 jank10 又把累计值按时长折算一次 —— 等于多除
        // 一次，数值随设备响应速度漂移，跨机型不可比。dt 只用于 fps。
        const jankRate = delta > 0 ? Math.round((jank / delta) * 100) : 0;
        return {
          fps,
          jank, bigJank, smallJank, tinyJank,
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
    const out = await adbShell(deviceId, `dumpsys gfxinfo ${shellArg(packageName)} framestats 2>/dev/null`, DUMPSYS_TIMEOUT_MS);
    const parsed = parseFramestats(out);
    const frames = parsed.frames;
    const iCompleted = parsed.iCompleted;
    const sawHeader = parsed.sawHeader;

    if (frames.length >= 4) {
      frames.sort((a, b) => a.vsync - b.vsync);
      const win = selectFramestatsWindow(frames, _fsState.get(key), now, intervalMs);
      _fsState.set(key, win.state);
      if (win.usable) {
        // 只统计本周期新帧：fps = 新帧数 / 真实采样间隔，不再拿滚动窗口的
        // 「过去 N 帧平均」冒充这一秒的帧率，也不把旧帧的卡顿重复计入。
        const fps = Math.min(Math.round(win.frames.length / win.dt), FPS_CAP);
        // 上一周期尾部几帧只为 avg3 提供基准，calcJankFramestats 不会把它们计入。
        const seq = win.tail.concat(win.frames);
        const { jank, bigJank, smallJank, tinyJank, evaluated } =
          calcJankFramestats(seq, win.frames[0].vsync);
        // 分母用「实际参与判定的帧数」，不是原始行数
        const jankRate = evaluated > 0 ? Math.round((jank / evaluated) * 100) : 0;
        log(`[FPS] gfxinfo framestats ✓ new=${win.frames.length} dt=${win.dt.toFixed(2)}s fps=${fps} jank=${jank} bigJank=${bigJank} smallJank=${smallJank} tinyJank=${tinyJank} cols=${iCompleted + 1}${sawHeader ? '(按表头)' : '(默认索引)'}`);
        return {
          fps, jank, bigJank, smallJank, tinyJank,
          jankRate, method: 'framestats',
        };
      }
      // 首帧 / 窗口过期 / 本周期无新帧：framestats 的输出里已经带着
      // 「Total frames rendered」，直接用它做真实增量即可。再跑一次
      // `dumpsys gfxinfo` 只是把同一条命令重复执行一遍（framestats 是其超集）。
      log(`[FPS] gfxinfo framestats 本周期无可用新帧（${win.reason}，窗口 ${frames.length} 帧）→ 复用同一份输出的总帧数增量`);
      const d = gfxTotalDelta(out, key, now, log);
      if (d) return d;
    } else {
      log(`[FPS] gfxinfo framestats 帧数不足 (${frames.length}) → 复用同一份输出的总帧数增量`);
      const d = gfxTotalDelta(out, key, now, log);
      if (d) return d;
    }
  } catch (e) { log(`[FPS] gfxinfo 异常: ${e.message}`); }

  // ── Method 3: gfxinfo "Total frames" delta（framestats 本身抛异常时的兜底） ──
  try {
    const out = await adbShell(deviceId, `dumpsys gfxinfo ${shellArg(packageName)} 2>/dev/null`, DUMPSYS_TIMEOUT_MS);
    const d = gfxTotalDelta(out, key, now, log);
    if (d) return d;
    log(`[FPS] gfxinfo 无可用帧增量（未取到 "Total frames rendered" 或无变化）`);
  } catch (e) { log(`[FPS] gfxinfo-delta 异常: ${e.message}`); }

  // 所有方案都失败：明确告知用户原因，避免「FPS=0 但不知道为什么」
  log(`[FPS] 未取到 ${packageName} 的帧数据：该应用当前无可见渲染层（未在前台 / 无 Surface / 非 View 渲染）。若正在测试游戏或前台应用请检查是否已切到前台`);
  return { fps: 0, jank: 0, bigJank: 0, smallJank: 0, tinyJank: 0, jankRate: 0, method: 'none' };
}

// ─── Network ─────────────────────────────────────────────────────────────────

/**
 * 该网络接口是否计入「应用流量」。
 *
 * 只统计真正承载被测应用流量的物理/蜂窝接口：
 *   wlan*    Wi-Fi
 *   rmnet*   高通 / 部分 MTK 蜂窝（rmnet_data0、rmnet0）
 *   ccmni*   MTK 蜂窝
 *   clat*    464xlat 的 IPv4→IPv6 转换接口（clat4）
 *   v4-*     同上，部分 ROM 命名 v4-wlan0
 *   eth* / rndis*   USB 共享
 * lo / ifb / dummy / sit0 / tunl0 / ip6tnl0 是回环与隧道，计入会重复或虚高，
 * 明确排除。漏掉 clat/v4- 会让 464xlat 机型的 IPv4 流量整段丢失（显示 0 KB/s）。
 */
const METERED_IFACE_RE = /^(?:wlan\d+|rmnet[\w]*|ccmni[\w-]*|clat\d*|v4-[\w.-]+|eth\d+|rndis\d+)$/;

function isMeteredIface(name) {
  return METERED_IFACE_RE.test(String(name || '').trim());
}

const _netState = new Map();

async function getNetStats(deviceId) {
  const key = `${deviceId}_net`;
  try {
    const out = await adbShell(deviceId, 'cat /proc/net/dev 2>/dev/null');
    let rx = 0, tx = 0;
    for (const line of out.split('\n')) {
      // 接口白名单集中在 isMeteredIface（含 clat / v4-* 等 464xlat 接口）：
      // 旧实现内联正则只有 wlan/rmnet_data，MTK 的 ccmni*、USB 共享的 rndis* 全被漏掉。
      const iface = line.trim().split(':')[0];
      if (!isMeteredIface(iface)) continue;
      const cols = line.trim().split(/\s+/);
      rx += parseInt(cols[1], 10) || 0;
      tx += parseInt(cols[9], 10) || 0;
    }
    const now  = Date.now();
    const prev = _netState.get(key);
    _netState.set(key, { rx, tx, ts: now });
    // 速率必须由两帧差值推出：首帧 / 读取失败都是「未测量」，写 0 会被读成「无流量」
    if (!prev) return { rxKBps: null, txKBps: null };
    // 计数器回绕或接口重置 → 本帧差值不可信，同样不编造 0 KB/s
    if (rx < prev.rx || tx < prev.tx) return { rxKBps: null, txKBps: null };
    const dt = Math.max((now - prev.ts) / 1000, 0.1);
    return {
      rxKBps: Math.max(0, Math.round(((rx - prev.rx) / 1024) / dt)),
      txKBps: Math.max(0, Math.round(((tx - prev.tx) / 1024) / dt)),
    };
  } catch (_) { return { rxKBps: null, txKBps: null }; }
}

// ─── Battery ─────────────────────────────────────────────────────────────────

/**
 * 电池电压统一成 mV。三种 ROM 口径：标准 mV(4200)、OPLUS V(4)、少数 µV(4200000)。
 * 读不到 / 非法一律 null，不能写 0V 冒充实测。
 * 抽成纯函数，让单位换算能被离线回归测试锁定（不依赖真机）。
 */
function normalizeBatteryVoltageMv(raw) {
  const v = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!isFinite(v) || v <= 0) return null;
  if (v > 100000) return Math.round(v / 1000);   // µV → mV
  if (v < 20)     return Math.round(v * 1000);   // V  → mV
  return Math.round(v);                          // mV
}

/**
 * 电池电流统一成 mA，保留符号（负 = 充电 / 正 = 放电）。
 * unitMicroAmp 由设备自报的 current_max 量级给出；为 null 时用「|v| > 10000」兜底。
 */
function normalizeCurrentMa(raw, unitMicroAmp) {
  const v = typeof raw === 'number' ? raw : parseInt(raw, 10);
  if (!isFinite(v)) return null;
  const ua = unitMicroAmp != null ? !!unitMicroAmp : Math.abs(v) > 10000;
  return ua ? Math.round(v / 100) / 10 : v;
}

/**
 * 解析「dumpsys battery + 三个电流节点」的合并输出（纯函数，便于离线锁定单位换算）。
 * 段标记由 getBatteryInfo 下发的同一条命令写入：---CMAX--- / ---CUA--- / ---CNOW---。
 */
function parseBatteryDump(raw) {
  const text = String(raw || '');
  const seg = (startMark, endMark) => {
    const from = startMark ? text.indexOf(startMark) : 0;
    if (from < 0) return '';
    const begin = startMark ? from + startMark.length : 0;
    const end = endMark ? text.indexOf(endMark, begin) : -1;
    return text.slice(begin, end >= 0 ? end : text.length);
  };
  const out     = seg(null, '---CMAX---');
  const cmaxRaw = seg('---CMAX---', '---CUA---').trim();
  const cuaRaw  = seg('---CUA---', '---CNOW---').trim();
  const cnowRaw = seg('---CNOW---', null).trim();

  // 只匹配行首字段：部分 ROM 会先输出 "Max charging voltage: 5000000"（µV），
  // 不加 ^ 会把它当成电池电压，进而算出荒谬的功耗。
  const get = (k) => {
    const m = out.match(new RegExp(`^\\s*${k}:\\s+([\\d.]+)`, 'm'));
    return m ? parseFloat(m[1]) : null;
  };
  const level = get('level');
  const voltage = normalizeBatteryVoltageMv(get('voltage'));
  // temperature 为十分度 °C
  const tRaw = get('temperature');
  const temperature = (tRaw != null && tRaw > 0) ? Math.round(tRaw) / 10 : null;

  // 电流统一 mA 并保留符号（负 = 充电 / 正 = 放电）。单位不能只看数值猜：
  // 部分机型 current_now=-227、current_max=2000 是 mA，AOSP 标准是 µA。
  // 以设备自报 current_max 的量级为主判据，数值阈值仅兜底。
  let isMicroAmp = null;
  const mx = Math.abs(parseInt(cmaxRaw, 10));
  if (isFinite(mx) && mx > 0) isMicroAmp = mx >= 100000;
  const toMa = (v) => normalizeCurrentMa(v, isMicroAmp);

  let currentNow = null;
  // ① 节点名自带单位：batt_current_ua_now 明确是 µA（三星等）
  if (cuaRaw) {
    const v = parseInt(cuaRaw, 10);
    if (isFinite(v) && v !== 0) currentNow = normalizeCurrentMa(v, true);
  }
  // ② dumpsys battery 的 "current now:"（部分 ROM 会省略该字段）
  if (currentNow == null) {
    const curMatch = out.match(/^\s*current now:\s*(-?\d+)/im);
    if (curMatch) currentNow = toMa(curMatch[1]);
  }
  // ③ sysfs current_now（无 dumpsys 电流字段的机型走这里）
  if (currentNow == null && cnowRaw) currentNow = toMa(cnowRaw);

  // 功耗 mW = |电流 mA| × 电压 mV / 1000；任一输入无效就不编造 0mW
  const power = (currentNow != null && voltage != null)
    ? Math.round(Math.abs(currentNow) * voltage / 1000) : null;

  return { level, voltage, temperature, currentNow, power };
}

async function getBatteryInfo(deviceId) {
  // 一次 shell 取全部电池源。旧实现每读一个节点起一次 adb
  //（dumpsys battery + current_max + batt_current_ua_now + current_now，最坏 4 次
  // 进程创建、150~350 ms），四个值还来自四个不同时刻。合并后只解析同一份快照。
  const cmd = 'dumpsys battery 2>/dev/null; echo "---CMAX---"; '
    + 'cat /sys/class/power_supply/battery/current_max 2>/dev/null; echo "---CUA---"; '
    + 'cat /sys/class/power_supply/battery/batt_current_ua_now 2>/dev/null; echo "---CNOW---"; '
    + 'cat /sys/class/power_supply/battery/current_now 2>/dev/null';
  try {
    const raw = await adbShell(deviceId, cmd, DUMPSYS_TIMEOUT_MS);
    return parseBatteryDump(raw);
  } catch (_) {
    return { level: null, voltage: null, temperature: null, currentNow: null, power: null };
  }
}

// ─── Temperature ─────────────────────────────────────────────────────────────
// 语义分层（务必区分，否则会出现「手摸不热却显示 60 多度」的假高温）：
//   SKIN / BATTERY  = 机身（外壳）/ 电池温度，接近手感，是「温度」卡片该显示的值
//   CPU / GPU / NPU = SoC 芯片结温（die temperature），轻载下也常年在 55~70°C，
//                     比外壳高 20~30°C，不能冒充机身温度。
// 采集顺序：dumpsys thermalservice（Android 10+，具名、免 root）
//           → sysfs 具名机身/电池热区（老机型）→ dumpsys battery → 无数据。
// 结温不丢弃，单独写入 cpuTemp / gpuTemp，供降频分析使用。

/** 芯片结温类传感器：不得作为主温度来源 */
const DIE_TEMP_NAMES = new Set([
  'CPU', 'GPU', 'NPU', 'MODEM', 'DSP', 'BSP', 'CHARGER', 'WIFI', 'WLAN',
  'CAMERA', 'POWER_AMPLIFIER', 'USB', 'DDR', 'PMIC', 'SOC',
]);
/** 机身 / 电池类传感器：主温度只从这里取 */
const BODY_TEMP_NAMES = new Set([
  'SKIN', 'BATTERY', 'BOARD', 'SHELL', 'CASE', 'BACK', 'PANEL', 'SURFACE', 'AMBIENT',
]);

const _r1 = (v) => Math.round(v * 10) / 10;
const _avgRows = (rows) => rows.reduce((s, r) => s + r.value, 0) / rows.length;

/**
 * sysfs 热区 temp 节点（thermal_zoneN/temp）的单位并不统一：
 *   标准 Linux thermal sysfs 是**毫摄氏度**（36500 → 36.5°C）；
 *   部分老 ROM / 厂商 HAL 写**十分度**（345 → 34.5°C）；
 *   少数直接写摄氏度（36 → 36°C）。
 * 旧实现只有 `if (v > 1000) v /= 1000`，十分度值 340 既没换算、又被随后的
 * `v < 120` 判为非法丢弃 —— 这类机型整段机身温度都是「无数据」。
 * 按数量级判定（与电池电压同思路），换算后仍落在 (0,120) 才接受。
 */
function normalizeThermalSysfsTemp(raw) {
  const v = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!isFinite(v) || v <= 0) return null;
  let c;
  if (v >= 1000)      c = v / 1000;   // 毫摄氏度（标准 sysfs）
  else if (v >= 100)  c = v / 10;     // 十分度（老 ROM）
  else                c = v;          // 摄氏度
  return (c > 0 && c < 120) ? _r1(c) : null;
}

/**
 * 解析 dumpsys thermalservice。
 * 返回 { main, gpu, cpu, battery, skin, source }：
 *   main    = 机身/电池温度（BATTERY 优先，其次 SKIN），不再取 CPU 结温
 *   source  = battery | skin | body | board | die（die 表示只有结温可读，数值偏高）
 *   cpu/gpu/skin/battery = 各路传感器原始读数，单独返回，不与机身温度混用
 */
function parseThermalService(out) {
  if (!out) return null;
  // HAL 是实时读数；Cached 是上一次采样（实测可低 10°C 以上），仅在无 HAL 时使用
  const halIdx = out.indexOf('Current temperatures from HAL');
  const cachedIdx = out.indexOf('Cached temperatures');
  let section;
  if (halIdx >= 0) section = out.slice(halIdx, cachedIdx > halIdx ? cachedIdx : out.length);
  else if (cachedIdx >= 0) section = out.slice(cachedIdx);
  else section = out;

  const rows = [];
  const re = /Temperature\{mValue=([\d.]+),\s*mType=(\d+),\s*mName=([A-Z_]+)/g;
  let m;
  while ((m = re.exec(section)) !== null) {
    const v = parseFloat(m[1]);
    if (isFinite(v) && v > 0 && v < 150) rows.push({ value: v, name: m[3] });
  }
  if (!rows.length) return null;

  const pick = (name) => rows.find((r) => r.name === name);
  const skin = pick('SKIN');
  const battery = pick('BATTERY');
  const bodyRows = rows.filter((r) => BODY_TEMP_NAMES.has(r.name));
  const nonDieRows = rows.filter((r) => !DIE_TEMP_NAMES.has(r.name));

  // 电池热敏电阻是真实、稳定、最贴近手感的读数，优先于厂商算法估算的 SKIN
  let main, source;
  if (battery)                { main = battery.value;    source = 'battery'; }
  else if (skin)              { main = skin.value;       source = 'skin'; }
  else if (bodyRows.length)   { main = _avgRows(bodyRows);   source = 'body'; }
  else if (nonDieRows.length) { main = _avgRows(nonDieRows); source = 'board'; }
  // 只有芯片结温可读时不编造「机身温度」：返回 null，交给下一级（电池）兜底，
  // 否则又会复现「手摸不热却 60 多度」。结温仍在 cpu/gpu 字段里完整保留。
  else                        { main = null;                 source = 'die'; }

  const cpu = pick('CPU');
  const gpu = pick('GPU');
  return {
    main: main == null ? null : _r1(main),
    source,
    gpu: gpu ? _r1(gpu.value) : null,
    cpu: cpu ? _r1(cpu.value) : null,
    battery: battery ? _r1(battery.value) : null,
    skin: skin ? _r1(skin.value) : null,
  };
}

/**
 * 温度采集：返回 { temperature, tempSource, gpuTemp, cpuTemp, batteryTemp, skinTemp }。
 * temperature 为机身/电池温度（null = 采不到）；cpuTemp / gpuTemp 为芯片结温，
 * skinTemp 为厂商估算的外壳温度，三者互不混用。
 */
async function getThermalInfo(deviceId, opts = {}) {
  // 分项读数单独保存：即使采不到机身温度，thermalservice 已读到的 CPU/GPU 结温、
  // SKIN 估算值也不能丢。旧实现只在 r.main > 0 时返回整个 r，die-only 机型
  // （只有结温可读）会把 cpuTemp/gpuTemp 一起变成 null，白白丢掉可用数据。
  const extra = { gpuTemp: null, cpuTemp: null, batteryTemp: null, skinTemp: null };
  let dieOnlySource = null;
  const pack = (temperature, tempSource) =>
    Object.assign({ temperature, tempSource }, extra);

  // 1) dumpsys thermalservice：具名传感器，语义最可靠（Android 10+ 免 root）
  try {
    const out = await adbShell(deviceId, 'dumpsys thermalservice 2>/dev/null', DUMPSYS_TIMEOUT_MS);
    const r = parseThermalService(out);
    if (r) {
      extra.gpuTemp = r.gpu;
      extra.cpuTemp = r.cpu;
      extra.batteryTemp = r.battery;
      extra.skinTemp = r.skin;
      if (r.main > 0) return pack(r.main, r.source);
      // 只有芯片结温：机身温度留空，但标记来源，卡片才会显示「仅结温」而非 0°C
      if (r.source === 'die') dieOnlySource = 'die';
    }
  } catch (_) {}

  // 2) sysfs：老机型 / root 可读。只读「具名」机身与电池热区；
  //    匿名 thermal_zone 大多是 CPU 各核结温，无差别求平均会系统性偏高，宁可放弃。
  try {
    const out = await adbShell(deviceId,
      'for d in /sys/class/thermal/thermal_zone*; do t=$(cat "$d/type" 2>/dev/null); ' +
      'v=$(cat "$d/temp" 2>/dev/null); if [ -n "$t" ] && [ -n "$v" ]; then echo "$t=$v"; fi; done');
    const rows = [];
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^([A-Za-z0-9_\- ]+)=(-?\d+(?:\.\d+)?)$/);
      if (!m) continue;
      const value = normalizeThermalSysfsTemp(m[2]);
      if (value == null) continue;   // 负温 / 异常单位 / 超量程：不猜
      const name = m[1].trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
      rows.push({ name, value });
    }
    const isBody = (r) => /(SKIN|SHELL|CASE|BACK|SURFACE|PANEL|BATT|BOARD|AMBIENT)/.test(r.name)
      && !/(CPU|GPU|NPU|MODEM|DSP|CHG|WIFI|WLAN|CAM|DDR|PMIC|USB)/.test(r.name);
    const body = rows.filter(isBody);
    // sysfs 与 thermalservice 同为实时读数，同级覆盖；结温同样保留
    const die = rows.find(r => /(^|_)CPU(_|$)/.test(r.name));
    const gpuDie = rows.find(r => /(^|_)GPU(_|$)/.test(r.name));
    if (die) extra.cpuTemp = die.value;
    if (gpuDie) extra.gpuTemp = gpuDie.value;
    if (body.length) {
      const batt = body.find(r => /BATT/.test(r.name));
      const shell = body.find(r => /SKIN|SHELL|CASE|BACK|SURFACE|PANEL/.test(r.name));
      const main = batt || shell || body[0];
      if (batt) extra.batteryTemp = batt.value;
      if (shell) extra.skinTemp = shell.value;
      return pack(main.value, /BATT/.test(main.name) ? 'battery' : 'skin');
    }
  } catch (_) {}

  // 3) 电池温度（最低兜底，几乎所有机型可读；dumpsys battery 单位为十分度）
  //    注意：采集主循环同一 tick 已经通过 getBatteryInfo 读过电池温度，这里再读一次
  //    = 同一条命令跑两遍，两次读数还可能差 0.1°C，导致 temperature 与
  //    battery.temperature 两个字段互相矛盾（典型的重复采集）。
  //    调用方传 { noBatteryRead: true } 时跳过本段，由采集器用同一 tick 的
  //    battery 结果合并兜底，保证只有一个来源、一个值。
  if (!opts.noBatteryRead) {
    try {
      const out = await adbShell(deviceId, 'dumpsys battery 2>/dev/null', DUMPSYS_TIMEOUT_MS);
      const m = out.match(/^\s*temperature:\s*(\d+)/m);
      if (m) {
        const t = _r1(parseInt(m[1], 10) / 10);
        if (t > 0 && t < 120) {
          extra.batteryTemp = t;
          return pack(t, 'battery');
        }
      }
    } catch (_) {}
  }

  // 全部数据源都失败：机身温度 null（0°C 会被当成实测值计入均值），结温仍保留
  return pack(null, dieOnlySource);
}

// ─── GPU ─────────────────────────────────────────────────────────────────────
// GPU（某机型确认）:
//   gpu_busy_percentage → "89 %"   (primary)
//   gpubusy            → "N M"     (fallback ratio)
// 注意：不少机型（部分厂商 ROM）对 shell 全部关闭了这些节点，
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

/** 每台设备上一帧的 gpubusy 累计计数，用于算区间增量 */
const _gpuBusyState = new Map();

/**
 * kgsl-3d0/gpubusy 输出的是「busy total」两个**累计**计数（自驱动加载起）。
 * 抽成纯函数，让区间 delta 能被离线测试锁定。
 */
function parseGpuBusyCounters(txt) {
  const p = String(txt || '').trim().split(/\s+/).map(Number);
  if (p.length < 2 || !(p[0] >= 0) || !(p[1] > 0)) return null;
  return { busy: p[0], total: p[1] };
}

/**
 * 两次累计计数的差值才是本采样区间的 GPU 利用率。
 * 首帧 / 计数器重置 / 设备重启 → null（未测量），绝不编造 0% 或沿用旧的累计均值。
 */
function gpuBusyDeltaPct(prev, curr) {
  if (!prev || !curr) return null;
  const dBusy  = curr.busy  - prev.busy;
  const dTotal = curr.total - prev.total;
  if (!(dTotal > 0) || dBusy < 0 || dBusy > dTotal) return null;
  return Math.round((dBusy / dTotal) * 100);
}

/** 按探针名把原始文本解释成百分比；解释不了返回 null */
function interpretGpuProbe(tag, txt) {
  const raw = String(txt || '').trim();
  if (!raw) return null;

  if (tag === 'kgsl_busy') {
    // 注意：这是「开机至今的累计平均占用」，只能给一次性健康检查当粗参考，
    // 不能当实时 GPU 利用率逐帧上报（getGpuUsage 会改用区间 delta）。
    const c = parseGpuBusyCounters(raw);
    if (!c) return null;
    const v = Math.round((c.busy / c.total) * 100);
    return (v >= 0 && v <= 100) ? v : null;
  }

  if (tag === 'mtk_gpufreq' || tag === 'mtk_opp') {
    // 形如 "gpu_util = 37" / "loading: 37" / "utilization 37"
    // 精确字段名 + 边界：旧写法 util\\w* 会命中 utilization_max=100 这类
    // 「上限常量」，把 GPU 显示成假满载。
    const m = raw.match(/(?:^|[^\w])(?:gpu_util|utilization|util|loading)\s*[:=]?\s*(\d+(?:\.\d+)?)/i);
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

    // gpubusy 的 busy/total 是**开机至今的累计值**：直接相除得到的是「设备启动以来
    // 的平均 GPU 占用」，画出来是一条几乎不动的线（常见恒定 10~20%），完全不能反映
    // 当前负载。只有两次采样的 Δbusy / Δtotal 才是本周期的利用率。
    // 即使本帧命中了更可靠的瞬时节点也照常记录基线，保证切回 gpubusy 时立刻有值。
    const busy = parseGpuBusyCounters(parts.kgsl_busy);
    let busyDelta = null;
    if (busy) {
      busyDelta = gpuBusyDeltaPct(_gpuBusyState.get(deviceId), busy);
      _gpuBusyState.set(deviceId, busy);
    }

    for (const [tag] of GPU_NODE_PROBES) {
      if (tag === 'kgsl_busy') {
        if (busyDelta != null) return busyDelta;
        continue;   // 首帧 / 计数器回绕 → 未测量，继续找别的瞬时节点
      }
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

/**
 * 用 cpuN 名称把两次 /proc/stat 快照配对后算逐核使用率。
 *
 * 旧写法 prev.cores[i] 按下标对比：核心热插拔（关核 / 开核）时 /proc/stat 的
 * cpuN 行集合会变化，下标 i 指向的已经不是同一个核心，算出的 delta 是
 * 「A 核累计 tick 减 B 核累计 tick」的随机数，再 clamp 成 0~100% 的假曲线。
 * 按名字配对后，本次新上线、上次已下线、或计数器回绕的核心一律记 null（未测量）。
 */
function pairCoreUsage(prev, curr) {
  if (!prev) return curr.cores.map(() => null);       // 首帧无基线
  const pmap = new Map(prev.ids.map((id, i) => [id, prev.cores[i]]));
  return curr.ids.map((id, i) => {
    const p = pmap.get(id);
    if (!p) return null;
    const td = curr.cores[i].total - p.total;
    const idl = curr.cores[i].idle - p.idle;
    return td > 0 ? clamp(Math.round(((td - idl) / td) * 100), 0, 100) : null;
  });
}

/**
 * 兼容包装：只取逐核使用率与频率。
 * 采集主循环请直接用 getCpuSnapshot —— 它与整机 / 进程 CPU 共用一次 /proc/stat 读取；
 * 这里若与 getCpuStats 同时调用，就会退回到「一个 tick 读两次」的旧行为。
 */
async function getCpuCoreStats(deviceId) {
  const s = await getCpuSnapshot(deviceId, null);
  return { usage: s.cores.usage, freq: s.cores.freq };
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

function resetDeviceState(deviceId) {
  _timestatsEnabled.delete(deviceId);
  // _fsState 也必须清：framestats 的窗口基线若跨采集会话残留（应用重启后
  // PROFILEDATA 窗口会重置），首帧就会被判成「无新帧 / 窗口过期」，白白丢点。
  // _gpuBusyState 同理：不清会用上一轮结束时的累计计数算出一个跨越整段停机
  // 时间的「平均 GPU 占用」当作本轮第一帧的利用率。
  // _rootState 是有意的会话级缓存（清了每轮都要多探一次 su）。
  for (const map of [_cpuState, _netState, _fpsState, _coreState, _fsState, _gpuBusyState]) {
    for (const k of map.keys()) { if (k.startsWith(deviceId)) map.delete(k); }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

module.exports = {
  shell: adbShell,
  getDevices, getDeviceInfo, getThirdPartyPackages, getPid, getUid, ensureAppRunning,
  getDeviceLocale, getApkPath, resolveAppLabel, readApkEntry,
  resolveLauncherComponent, isAppForeground, getForegroundSnapshot,
  getCpuStats, getCpuSnapshot, getMemInfo, getFps,
  getNetStats, getBatteryInfo, getThermalInfo, parseThermalService, getGpuUsage,
  getCpuCoreStats, captureScreen,
  preflightCheck, probeChannel,
  resetDeviceState, connectWifi, autoConnectWifi, disconnectWifi,
  reverseTcp, removeReverse, listReverses, pushFile,
  cancelAllInflight,
  // 退出清理：只收本进程拉起的 adb server（见 ensureServerOwnership）
  killServerIfOwned, ensureServerOwnership, ADB_SERVER_PORT,
  __setServerRunner,
  // 纯算法导出：供离线回归测试锁定采集口径（不影响运行时行为）
  __algo: {
    parseHistogram, histDelta, detectVsync, analyseHistogram,
    parseFramestats, calcJankFramestats, vsyncMsFromRefreshRate,
    selectFramestatsWindow, FRAMESTATS_MAX_GAP_FACTOR,
    normalizeBatteryVoltageMv, normalizeCurrentMa,
    normalizeThermalSysfsTemp,
    parsePidStat, pairCoreUsage,
    // 采集口径纯函数：整机/单核 CPU、meminfo 分项、电池单位、网络接口白名单
    calcCpuPct, parseMemInfoSections, parseBatteryDump, isMeteredIface,
    parseGpuBusyCounters, gpuBusyDeltaPct, interpretGpuProbe,
    MOVIE_FRAME_X2_MS, MOVIE_FRAME_X3_MS,
  },
};
