'use strict';

const EventEmitter = require('events');
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const http = require('http');
const iosLog = require('./ios-logger');

const MAX_HISTORY = 3600;

// ---------------------------------------------------------------------------
// Path resolution helpers
// ---------------------------------------------------------------------------
function resolvePath(candidates) {
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolveIosBin() {
  return resolvePath([
    path.join(process.resourcesPath || '', 'ios-tools', 'bin', 'ios.exe'),
    path.join(__dirname, '..', 'ios-tools', 'bin', 'ios.exe'),
  ]);
}

function resolvePython() {
  const bundledPy = path.join(
    'ios-tools', 'python', 'python', 'python.exe'
  );
  return resolvePath([
    path.join(process.resourcesPath || '', bundledPy),
    path.join(__dirname, '..', bundledPy),
    'python3',
    'python',
  ]);
}

function resolveScript() {
  return resolvePath([
    path.join(process.resourcesPath || '', 'ios-tools', 'python', 'python', 'Scripts', 'collect_ios.pyc'),
    path.join(__dirname, '..', 'ios-tools', 'python', 'python', 'Scripts', 'collect_ios.pyc'),
  ]);
}

function resolveLegacyScript() {
  return resolvePath([
    path.join(process.resourcesPath || '', 'ios-tools', 'python', 'python', 'Scripts', 'collect_ios_legacy.pyc'),
    path.join(__dirname, '..', 'ios-tools', 'python', 'python', 'Scripts', 'collect_ios_legacy.pyc'),
  ]);
}

// ---------------------------------------------------------------------------
// Tunnel helpers
// ---------------------------------------------------------------------------
function queryTunnels() {
  return new Promise((resolve, reject) => {
    const req = http.get('http://127.0.0.1:60105/tunnels', res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('tunnel query timeout')); });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Python collect_ios* 在 sysmon 未匹配到目标进程时仅输出的一行：{"code":0} */
function _isSysmonMissingSentinel(data) {
  return (
    data &&
    typeof data === 'object' &&
    !data.__log &&
    data.code === 0 &&
    Object.keys(data).length === 1
  );
}

// ---------------------------------------------------------------------------
// IosCollector
// ---------------------------------------------------------------------------
/**
 * iOS 采集参数组 → 原始字段映射（与 renderer/metric-settings.js 一致）。
 * 采集脚本一次性输出全部字段，这里在入口按配置过滤，被移除的组不进 history/上报。
 */
const IOS_METRIC_KEYS = {
  fps:    ['fps', 'jank', 'big_jank', 'bigjank', 'small_jank', 'smallJank', 'tiny_jank', 'tinyJank', 'stutter'],
  cpu:    ['cpuUsage', 'cpuTotalSystem', 'cpuTotalUser', 'cpuLimit'],
  mem:    ['physFootprint', 'memResidentSize', 'memVirtualSize', 'memRPrvt', 'memRShrd', 'memAnon', 'memCompressed', 'memPurgeable'],
  disk:   ['diskBytesRead', 'diskBytesWritten'],
  events: ['ctxSwitch', 'intWakeups', 'vmPageIns', 'cswitch'],
  proc:   ['threadCount', 'machPortCount', 'msgSent', 'msgRecv', 'sysCallsMach', 'procStatus', '__arch'],
};

/** 归一化配置：缺省全采；返回 {group: bool} */
function normalizeIosMetricConfig(cfg) {
  const out = {};
  for (const k of Object.keys(IOS_METRIC_KEYS)) out[k] = true;
  if (cfg && typeof cfg === 'object') {
    for (const k of Object.keys(out)) {
      if (Object.prototype.hasOwnProperty.call(cfg, k)) out[k] = !!cfg[k];
    }
  }
  return out;
}

/** 按配置过滤一条 iOS 采样：只保留启用组的字段（timestamp/time 恒保留） */
function filterIosData(data, mc) {
  if (!data || typeof data !== 'object') return data;
  const keep = new Set(['timestamp', 'time']);
  for (const [group, keys] of Object.entries(IOS_METRIC_KEYS)) {
    if (mc[group]) keys.forEach(k => keep.add(k));
  }
  const out = {};
  for (const k of Object.keys(data)) {
    if (keep.has(k)) out[k] = data[k];
  }
  return out;
}

class IosCollector extends EventEmitter {
  constructor(bundleId, execName, metricConfig = null) {
    super();
    this.bundleId    = bundleId;
    this.execName    = execName || '';
    this._tunnel     = null;
    this._collector  = null;
    this._running    = false;
    /** @type {Record<string, boolean>} 采集参数开关（默认全采） */
    this._mc = normalizeIosMetricConfig(metricConfig);
    this.history     = [];
  }

  _log(msg) {
    iosLog.write(msg);
    this.emit('log', msg);
  }

  async start() {
    this._running = true;
    iosLog.separator(`iOS 采集开始 bundleId=${this.bundleId}`);

    const iosBin = resolveIosBin();
    if (!iosBin) throw new Error('ios.exe not found — check ios-tools/bin/');

    const python = resolvePython();
    if (!python) throw new Error('Python not found — expected at ios-tools/python/python/python.exe');

    this._log('检测 iOS 版本…');
    const info = await this._deviceInfo(iosBin);
    const version = info.ProductVersion || info.productVersion || '0';
    const major   = parseInt(version.split('.')[0], 10);
    this._log(`设备: ${info.DeviceName || info.deviceName || 'iPhone'}, iOS ${version}`);

    const appName = this.execName || this.bundleId.split('.').pop();

    let args;
    if (major >= 17) {
      const script = resolveScript();
      if (!script) throw new Error('collect_ios.py not found — check ios-tools/');

      this._log('iOS 17+: 启动 tunnel (userspace)…');
      await this._startTunnel(iosBin);
      const tunnels = await queryTunnels();
      if (!tunnels || tunnels.length === 0) throw new Error('Tunnel 启动后未找到可用连接');
      const t = tunnels[0];
      this._log(`Tunnel OK: ${t.address}:${t.rsdPort}, userspace=${t.userspaceTunPort}`);
      args = [script, 'user', 'xdlj', this.bundleId, appName, 'tunnel', t.address, String(t.rsdPort), String(t.userspaceTunPort)];
    } else {
      const legacyScript = resolveLegacyScript();
      if (!legacyScript) throw new Error('collect_ios_legacy.py not found — check ios-tools/');

      this._log('iOS ≤16: 直连模式 (legacy) — 挂载开发者镜像…');
      await this._mountDeveloperImage(iosBin);
      args = [legacyScript, 'user', 'xdlj', this.bundleId, appName];
    }

    this._log('启动 Python 采集进程…');
    this._spawnCollector(python, args);
  }

  stop() {
    this._running = false;

    if (this._collector) {
      try { this._collector.kill('SIGTERM'); } catch (_) {}
      this._collector = null;
    }
    if (this._tunnel) {
      try { this._tunnel.kill('SIGTERM'); } catch (_) {}
      this._tunnel = null;
    }
    iosLog.separator('采集已停止');
    this.emit('log', '采集已停止');
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _deviceInfo(iosBin) {
    return new Promise((resolve, reject) => {
      execFile(iosBin, ['info', 'lockdown'], { timeout: 8000 }, (err, stdout) => {
        if (err) return reject(new Error(`ios.exe info 失败: ${err.message}`));
        try { resolve(JSON.parse(stdout)); }
        catch (e) { reject(new Error(`解析设备信息失败: ${e.message}`)); }
      });
    });
  }

  _mountDeveloperImage(iosBin) {
    // ios image auto downloads & mounts the correct DDI for iOS ≤16
    return new Promise((resolve) => {
      this._log('自动挂载开发者镜像 (ios image auto)…');
      execFile(iosBin, ['image', 'auto'], { timeout: 60000 }, (err, stdout, stderr) => {
        if (err) {
          // Already mounted is not a fatal error
          this._log(`[image auto] ${err.message}`);
        } else {
          this._log(`[image auto] 挂载成功`);
        }
        resolve(); // continue regardless
      });
    });
  }

  async _startTunnel(iosBin) {
    // Kill existing tunnel if any
    try {
      const existing = await queryTunnels().catch(() => []);
      if (existing && existing.length > 0) {
        this._log('发现已有 tunnel，直接复用');
        return;
      }
    } catch (_) {}

    this._tunnel = spawn(iosBin, ['tunnel', 'start', '--userspace'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this._tunnel.stdout.on('data', d => this._log(`[tunnel] ${d.toString().trim()}`));
    this._tunnel.stderr.on('data', d => this._log(`[tunnel] ${d.toString().trim()}`));
    this._tunnel.on('exit', code => {
      if (this._running && code !== 0 && code !== null) {
        this.emit('error', new Error(`tunnel 进程退出: ${code}`));
      }
    });

    // Wait for tunnel to be ready
    for (let i = 0; i < 10; i++) {
      await sleep(800);
      try {
        const tunnels = await queryTunnels();
        if (tunnels && tunnels.length > 0) return;
      } catch (_) {}
    }
    throw new Error('Tunnel 启动超时');
  }

  _spawnCollector(python, args) {
    // -u / PYTHONUNBUFFERED：管道下否则 stdout 块缓冲，__log/JSON 长时间进不了主进程，日志台空白
    const argv = Array.isArray(args) ? ['-u', ...args] : ['-u', args];
    this._collector = spawn(python, argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    this._collector.stdin.destroy();

    let buf = '';
    this._collector.stdout.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const data = JSON.parse(trimmed);
          // Python may emit {"__log": "..."} for debugging; do not forward to UI.
          if (data.__log) continue;
          if (_isSysmonMissingSentinel(data)) {
            this.stop();
            this.emit('sysmon-missing', data);
            continue;
          }
          // 按采集参数过滤：被移除的组不进 history / 不上报
          const filtered = filterIosData(data, this._mc);
          if (this.history.length >= MAX_HISTORY) this.history.shift();
          this.history.push(filtered);
          this.emit('data', filtered);
        } catch (_) {
          // Non-JSON line from Python — ignore (no UI log noise)
        }
      }
    });

    this._collector.stderr.on('data', d => {
      // Ignore Python stderr in UI (keep silent); error event will still fire on exit.
      // If needed for offline debugging, add file logging here.
      void d;
    });

    this._collector.on('exit', (code, signal) => {
      if (this._running) {
        this.emit('error', new Error(`Python 采集进程退出 code=${code} signal=${signal}`));
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Expose helpers for use in main.js
// ---------------------------------------------------------------------------
IosCollector.resolveIosBin = resolveIosBin;

/**
 * 从 lockdown 读取设备展示信息（名称 / 品牌 / 系统），无数据则字段省略。
 * @param {string} [udid] 多设备时建议传入
 */
function getLockdownDeviceInfo(udid) {
  const iosBin = resolveIosBin();
  if (!iosBin) return Promise.resolve(null);

  const normalize = (j) => {
    if (!j || typeof j !== 'object') return null;
    const name =
      j.DeviceName || j.deviceName ||
      j.HardwareModel || j.hardwareModel ||
      j.ProductType || j.productType || '';
    const ver = j.ProductVersion || j.productVersion;
    const info = {};
    if (name) info.name = String(name).trim();
    if (ver) info.system = `iOS ${ver}`;
    if (info.name || info.system) info.brand = 'Apple';
    return Object.keys(info).length ? info : null;
  };

  const run = (args) => new Promise((resolve) => {
    execFile(iosBin, args, { timeout: 12000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      try {
        resolve(normalize(JSON.parse(stdout)));
      } catch (_) {
        resolve(null);
      }
    });
  });

  return (async () => {
    if (udid) {
      let r = await run(['-u', udid, 'info', 'lockdown']);
      if (r) return r;
      r = await run(['info', 'lockdown', '-u', udid]);
      if (r) return r;
      r = await run(['info', 'lockdown', '--udid', udid]);
      if (r) return r;
    }
    return run(['info', 'lockdown']);
  })();
}

IosCollector.getLockdownDeviceInfo = getLockdownDeviceInfo;
IosCollector.normalizeMetricConfig = normalizeIosMetricConfig;
IosCollector.filterDataByConfig = filterIosData;
IosCollector.METRIC_KEYS = IOS_METRIC_KEYS;

module.exports = IosCollector;
