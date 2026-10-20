'use strict';

const EventEmitter = require('events');
const util = require('util');
const { execFile, spawn } = require('child_process');
const execFileAsync = util.promisify(execFile);
const path = require('path');
const fs   = require('fs');
const http = require('http');
const IosCollector = require('./ios-collector');
const iosLog = require('./ios-logger');
const { readUsePreGpuIos17FromReports } = require('./reports-config');

const USE_PRE_IOS17_GPU_SCRIPT = readUsePreGpuIos17FromReports();

const MAX_HISTORY = 3600;
/** 无数据 / 解析失败 / spawn 失败时稍后再试，避免空转占满 CPU */
const LOW_GPU_RETRY_MS = 1000;

// ── Group keys in lowgpu.json output ─────────────────────────────────────────
const LOW_GPU_GROUPS = ['texture', 'bandwidth', 'compute', 'cache', 'buffer', 'threadgroup', 'fragment'];

function resolvePython() {
  const bundledPy = path.join(
    'ios-tools', 'python', 'python', 'python.exe'
  );
  for (const p of [
    path.join(process.resourcesPath || '', bundledPy),
    path.join(__dirname, '..', bundledPy),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return 'python';
}

function resolveGpuScript() {
  for (const p of [
    path.join(process.resourcesPath || '', 'ios-tools', 'python', 'python', 'Scripts', 'collect_ios_gpu.pyc'),
    path.join(__dirname, '..', 'ios-tools', 'python', 'python', 'Scripts', 'collect_ios_gpu.pyc'),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolveLowGpuBin() {
  for (const p of [
    path.join(process.resourcesPath || '', 'ios-tools', 'bin', 'ios_gpulow.exe'),
    path.join(__dirname, '..', 'ios-tools', 'bin', 'ios_gpulow.exe'),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolvePreIos17GpuScript() {
  for (const p of [
    path.join(process.resourcesPath || '', 'ios-tools', 'python', 'python', 'Scripts', 'gpu_counters_pre_ios17.pyc'),
    path.join(__dirname, '..', 'ios-tools', 'python', 'python', 'Scripts', 'gpu_counters_pre_ios17.pyc'),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

// ── Flatten a single lowgpu entry into a flat metric object ──────────────────
function flattenLowGpuEntry(entry, nowMs, timeStr) {
  const flat = { timestamp: nowMs, time: timeStr };
  for (const g of LOW_GPU_GROUPS) {
    if (entry[g] && typeof entry[g] === 'object') {
      Object.assign(flat, entry[g]);
    }
  }
  return flat;
}

// iOS <17 (ios_gpulow.exe) 会一次性吐出多帧，这里做采样上限。
// 前端按 0.33s/组渲染，希望单轮至少覆盖 2min+，并允许更长的批次。
const MAX_SAMPLES_BATCH = 600;

/** iOS 17+：stdout 按行缓冲，每批至少凑满 N 条再下发，便于前端一组一组渲染并与下一轮采集并行 */
const IOS17_MIN_BATCH = 600;

// ── Sample up to MAX_SAMPLES_BATCH evenly-spaced entries from an array ───────
function sampleEntries(entries) {
  if (entries.length <= MAX_SAMPLES_BATCH) return entries;
  const step = entries.length / MAX_SAMPLES_BATCH;
  return Array.from({ length: MAX_SAMPLES_BATCH }, (_, i) => entries[Math.floor(i * step)]);
}

// ---------------------------------------------------------------------------
// IosGpuCollector
// ---------------------------------------------------------------------------
class IosGpuCollector extends EventEmitter {
  constructor() {
    super();
    this._tunnel    = null;
    this._collector = null;
    this._loopTimer = null;
    this._running   = false;
    this.history    = [];
    /** iOS 17+：短延迟聚合 stdout 行再发 batch；间隔短于旧版以便与前端逐点渲染并行 */
    this._ios17LineBuffer = [];
    this._ios17FlushTimer = null;
    /** 主进程返回给渲染进程，用于 iOS17+ 专用播放策略 */
    this.iosMajor = null;
    /** 与 iOS 性能页一致：采集前若进程未运行则启动（Python 或 go-ios） */
    this._bundleId = '';
  }

  _log(msg) {
    iosLog.write(msg);
    this.emit('log', msg);
  }

  /**
   * @param {{ bundleId?: string, appName?: string, udid?: string } | null} [session]
   */
  async start(session = null) {
    this._running = true;
    iosLog.separator('iOS GPU 采集开始');

    const iosBin = IosCollector.resolveIosBin();
    if (!iosBin) throw new Error('ios.exe not found — check ios-tools/bin/');

    this._bundleId = (session && session.bundleId)
      ? String(session.bundleId).trim()
      : '';

    this._log('检测 iOS 版本…');
    const info    = await this._deviceInfo(iosBin);
    const version = info.ProductVersion || info.productVersion || '0';
    const major   = parseInt(version.split('.')[0], 10);
    this.iosMajor = Number.isFinite(major) ? major : 0;
    this._log(`设备: ${info.DeviceName || info.deviceName || 'iPhone'}, iOS ${version}`);

    if (major >= 17) {
      // ── iOS 17+: tunnel → Python script ─────────────────────────────────
      const python = resolvePython();
      const script = resolveGpuScript();
      if (!script) throw new Error('collect_ios_gpu.py not found — check ios-tools/');

      this._log('iOS 17+: 启动 tunnel (userspace)…');
      await this._startTunnel(iosBin);
      const tunnels = await queryTunnels();
      if (!tunnels || tunnels.length === 0) throw new Error('Tunnel 启动后未找到可用连接');
      const t = tunnels[0];
      this._log(`Tunnel OK: ${t.address}:${t.rsdPort}, userspace=${t.userspaceTunPort}`);
      const args = [script, 'user', 'xdlj', 'tunnel', t.address, String(t.rsdPort), String(t.userspaceTunPort)];
      if (this._bundleId) args.push(this._bundleId);
      this._log('启动 GPU 采集进程…');
      this._spawnCollector(python, args);

    } else {
      const udid = info.UniqueDeviceID || info.uniqueDeviceID || '';
      if (!udid) throw new Error('无法获取设备 UDID');

      if (USE_PRE_IOS17_GPU_SCRIPT) {
        const python = resolvePython();
        const script = resolvePreIos17GpuScript();
        if (!script) throw new Error('gpu_counters_pre_ios17.py not found — check ios-tools/');
        this._log(`iOS <17: 使用 gpu_counters_pre_ios17.py (UDID: ${udid})`);
        const args = [script, 'user', 'xdlj', '--udid', udid, '--json-lines', '--duration', '0'];
        if (this._bundleId) args.push('--bundle-id', this._bundleId);
        this._spawnCollector(python, args);
      } else {
        const lowGpuBin = resolveLowGpuBin();
        if (!lowGpuBin) throw new Error('ios_gpulow.exe not found — check ios-tools/bin/');
        this._log(`iOS <17: 使用 ios_gpulow.exe (UDID: ${udid})`);
        // 可选：仅缺进程时 ios launch；无论是否 launch，下面都照常采 GPU
        if (this._bundleId) {
          await this._ensureAppRunningWithGoIos(iosBin, udid, this._bundleId);
        }
        this._startLowGpuLoop(lowGpuBin, udid);
      }
    }
  }

  stop() {
    this._running = false;
    if (this._ios17FlushTimer) {
      clearTimeout(this._ios17FlushTimer);
      this._ios17FlushTimer = null;
    }
    this._flushIos17PendingOnStop();
    if (this._loopTimer) { clearTimeout(this._loopTimer); this._loopTimer = null; }
    if (this._collector) {
      try { this._collector.kill('SIGTERM'); } catch (_) {}
      this._collector = null;
    }
    if (this._tunnel) {
      try { this._tunnel.kill('SIGTERM'); } catch (_) {}
      this._tunnel = null;
    }
    iosLog.separator('GPU 采集已停止');
    this.emit('log', 'GPU 采集已停止');
  }

  // ── iOS ≤16: 反复执行 ios_gpulow.exe；有数据时尽快排下一轮，与前端逐点渲染并行 ──
  _startLowGpuLoop(bin, udid) {
    const run = () => {
      if (!this._running) return;

      let stdout = '';
      const proc = spawn(bin, [udid], { stdio: ['ignore', 'pipe', 'pipe'] });
      this._collector = proc;

      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => {
        const msg = d.toString().trim();
        if (msg) iosLog.write(`[lowgpu stderr] ${msg}`);
      });

      proc.on('close', (code) => {
        if (!this._running) return;
        iosLog.write(`[lowgpu] exe exited code=${code}, stdout ${stdout.length} bytes`);

        let gotBatch = false;
        try {
          const entries = JSON.parse(stdout.trim());
          if (Array.isArray(entries) && entries.length > 0) {
            gotBatch = true;
            const nowMs   = Date.now();
            const sampled = sampleEntries(entries);
            this._log(`[lowgpu] ${entries.length} 帧 → 采样 ${sampled.length} 条`);
            const batch = sampled.map((entry, i) => {
              const ms = nowMs + i;
              const t = new Date(ms);
              const timeStr = `${t.toTimeString().slice(0, 8)}.${String(i).padStart(3, '0')}`;
              return flattenLowGpuEntry(entry, ms, timeStr);
            });
            for (const flat of batch) {
              if (this.history.length >= MAX_HISTORY) this.history.shift();
              this.history.push(flat);
            }
            this.emit('data-batch', batch);
          } else {
            this._log('[lowgpu] 本次无数据');
          }
        } catch (e) {
          this._log(`[lowgpu] JSON 解析失败: ${e.message}`);
        }

        const scheduleNext = () => {
          if (!this._running) return;
          this._log('[lowgpu] 采集中');
          run();
        };

        // 有数据：下一事件循环即启动下一轮采集，不等待前端把第一波画完
        if (gotBatch) {
          this._loopTimer = setTimeout(scheduleNext, 0);
        } else {
          this._log(`[lowgpu] ${LOW_GPU_RETRY_MS}ms 后重试`);
          this._loopTimer = setTimeout(scheduleNext, LOW_GPU_RETRY_MS);
        }
      });

      proc.on('error', (e) => {
        this._log(`[lowgpu] spawn 失败: ${e.message}`);
        if (this._running) this._loopTimer = setTimeout(run, LOW_GPU_RETRY_MS);
      });
    };

    run();
  }

  /**
   * iOS <17 且走 ios_gpulow.exe：用 go-ios 判断应用是否在跑；仅在未运行时可 launch。
   * 不启动应用时也会正常返回，随后仍会执行 _startLowGpuLoop（数据采集不跳过）。
   */
  async _ensureAppRunningWithGoIos(iosBin, udid, bundleId) {
    if (!bundleId || !udid) return;
    let running = false;
    try {
      const { stdout } = await execFileAsync(
        iosBin,
        ['ps', '--apps', `--udid=${udid}`],
        { timeout: 15000, maxBuffer: 10 * 1024 * 1024 },
      );
      const s = typeof stdout === 'string' ? stdout : String(stdout);
      if (s.includes(bundleId)) {
        const esc = bundleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        running = new RegExp(`["']${esc}["']`).test(s)
          || new RegExp(`(?:BundleID|bundleId|bundleID)\\s*[:=]\\s*["']?${esc}`, 'i').test(s);
      }
    } catch (e) {
      this._log(`[gpu] ps --apps 检查失败，仍将尝试 launch: ${e.message}`);
    }
    if (running) {
      return;
    }
    try {
      await execFileAsync(
        iosBin,
        ['launch', bundleId, `--udid=${udid}`],
        { timeout: 60000 },
      );
      this._log(`[gpu] 已启动应用: ${bundleId}`);
    } catch (e) {
      this._log(`[gpu] ios launch 失败（请手动打开应用）: ${e.message}`);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  _deviceInfo(iosBin) {
    return new Promise((resolve, reject) => {
      execFile(iosBin, ['info', 'lockdown'], { timeout: 8000 }, (err, stdout) => {
        if (err) return reject(new Error(`ios.exe info 失败: ${err.message}`));
        try { resolve(JSON.parse(stdout)); }
        catch (e) { reject(new Error(`解析设备信息失败: ${e.message}`)); }
      });
    });
  }

  async _startTunnel(iosBin) {
    // Check if a tunnel server is already listening on :60105
    let serverAlreadyUp = false;
    try {
      const existing = await queryTunnels().catch(() => null);
      if (existing !== null) {
        serverAlreadyUp = true;
        if (existing.length > 0) {
          this._log('发现已有 tunnel，直接复用');
          return;
        }
        // Server is up but has no tunnels yet — wait for it instead of spawning
        this._log('Tunnel 服务已在运行，等待 tunnel 建立…');
      }
    } catch (_) {}

    if (!serverAlreadyUp) {
      this._tunnel = spawn(iosBin, ['tunnel', 'start', '--userspace'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this._tunnel.stdout.on('data', d => this._log(`[tunnel] ${d.toString().trim()}`));
      this._tunnel.stderr.on('data', d => this._log(`[tunnel] ${d.toString().trim()}`));
      this._tunnel.on('exit', code => {
        if (this._running && code !== 0 && code !== null)
          this.emit('error', new Error(`tunnel 进程退出: ${code}`));
      });
    }

    for (let i = 0; i < 15; i++) {
      await sleep(800);
      try {
        const tunnels = await queryTunnels();
        if (tunnels && tunnels.length > 0) return;
      } catch (_) {}
    }
    throw new Error('Tunnel 启动超时');
  }

  /**
   * iOS 17+：stdout 按行缓冲后下发。
   * 尽量按 IOS17_MIN_BATCH 条拆成多包；不足一批的剩余也会在每次防抖 flush 时发出，
   * 否则若采集速率低于「凑满 600 行」的速度，缓冲永远不调度定时器，前端会一直无数据。
   */
  _flushIos17BufferedLines() {
    while (this._ios17LineBuffer.length >= IOS17_MIN_BATCH) {
      const batch = this._ios17LineBuffer.splice(0, IOS17_MIN_BATCH);
      for (const d of batch) {
        if (this.history.length >= MAX_HISTORY) this.history.shift();
        this.history.push(d);
      }
      this.emit('data-batch', batch);
    }
    if (this._ios17LineBuffer.length === 0) return;
    const batch = this._ios17LineBuffer.splice(0);
    for (const d of batch) {
      if (this.history.length >= MAX_HISTORY) this.history.shift();
      this.history.push(d);
    }
    this.emit('data-batch', batch);
  }

  _flushIos17PendingOnStop() {
    this._flushIos17BufferedLines();
  }

  // ── iOS 17+: spawn Python script, parse JSON lines (auto-restart on exit) ──
  _spawnCollector(python, args) {
    if (!this._running) return;

    const argv = Array.isArray(args) ? ['-u', ...args] : ['-u', args];
    this._collector = spawn(python, argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    this._collector.stdin.destroy();

    let buf = '';
    const scheduleIos17Flush = () => {
      if (this._ios17FlushTimer) clearTimeout(this._ios17FlushTimer);
      this._ios17FlushTimer = setTimeout(() => {
        this._ios17FlushTimer = null;
        if (this._ios17LineBuffer.length === 0) return;
        this._flushIos17BufferedLines();
      }, 50);
    };
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
          const ms = typeof data.timestamp === 'number' ? data.timestamp : Date.now();
          const t = new Date(ms);
          const timeStr = data.time || `${t.toTimeString().slice(0, 8)}`;
          const row = Object.assign({}, data, { timestamp: ms, time: timeStr });
          this._ios17LineBuffer.push(row);
          scheduleIos17Flush();
        } catch (_) {
          // Non-JSON line from Python — ignore (no UI log noise)
        }
      }
    });

    this._collector.stderr.on('data', d => {
      // Ignore Python stderr in UI (keep silent); error event will still fire on exit.
      void d;
    });

    this._collector.on('exit', (code, signal) => {
      if (this._ios17FlushTimer) {
        clearTimeout(this._ios17FlushTimer);
        this._ios17FlushTimer = null;
      }
      this._flushIos17PendingOnStop();
      if (!this._running) return;
      this._log(`[gpu] 采集进程退出 code=${code}，立即尝试重启…`);
      this._loopTimer = setTimeout(() => this._spawnCollector(python, args), 0);
    });
  }
}

module.exports = IosGpuCollector;
