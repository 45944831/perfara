'use strict';

const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const SampleMeta = require('./sample-meta');

/**
 * PC 采集参数组 → 字段映射（与 renderer/metric-settings.js 一致）。
 * 采集脚本一次输出全部字段，这里在入口按配置过滤。
 * pcExtra 为子对象：exe/name/fpsSource 恒保留（报告页设备信息用），
 * fpsFloat 与 5 个帧延迟分解字段（PresentMon v1 列）归 fps 组，
 * diskReadKBps/diskWriteKBps 归 disk 组。
 */
const PC_METRIC_KEYS = {
  fps:     ['fps', 'jank', 'bigJank', 'jankRate'],
  cpu:     ['cpu', 'cpuCores'],
  mem:     ['mem'],
  net:     ['net'],
  gpu:     ['gpu'],
  temp:    ['temperature', 'cpuTemp'],
  battery: ['battery'],
  disk:    ['pcExtra'],
};

const PC_EXTRA_KEYS = {
  fps:  ['fpsFloat', 'frameDisplayChangeMs', 'frameUntilDisplayedMs', 'framePresentApiMs',
         'frameRenderLatencyMs', 'frameAppStartGapMs'],
  disk: ['diskReadKBps', 'diskWriteKBps'],
};

/** 归一化配置：缺省全采；返回 {group: bool} */
function normalizePcMetricConfig(cfg) {
  const out = {};
  for (const k of Object.keys(PC_METRIC_KEYS)) out[k] = true;
  if (cfg && typeof cfg === 'object') {
    for (const k of Object.keys(out)) {
      if (Object.prototype.hasOwnProperty.call(cfg, k)) out[k] = !!cfg[k];
    }
  }
  return out;
}

/**
 * 采集脚本对「本机不支持/读不到」的指标一律输出 0（台式机无电池、无温度传感器、
 * 未外接测温设备等）。报告页会把 0 当成真实数值显示成「0°C / 电量 0%」，属于误导；
 * 这里统一折成 null，沿用 GPU 的既有约定：null = 无数据。
 */
function nullIfUnavailable(data) {
  // 浅拷贝后再改写：emit 出去的对象同时被 history / CSV 等链路引用，
  // 直接改入参会污染调用方持有的同一份数据。
  const d = Object.assign({}, data);
  if (d.temperature !== undefined && !d.temperature) d.temperature = null;
  const b = d.battery;
  if (b && typeof b === 'object') {
    // 电池存在性只看电量/电压/电流/功耗，不能拿 temperature 当证据：
    // 旧采集端把 CPU 结温写进 battery.temperature，台式机无电池时该值非 0，
    // 会让 noBattery 恒为 false，把「电量 0% / 电流 0mA」当成实测值显示。
    const noBattery = !b.level && !b.voltage && !b.currentNow && !b.power;
    if (noBattery) d.battery = null;
  }
  return d;
}

/** 按配置过滤一条 PC 采样：只保留启用组的字段（timestamp/time/pid/pcExtra 基础信息恒保留） */
function filterPcData(data, mc) {
  if (!data || typeof data !== 'object') return data;
  data = nullIfUnavailable(data);
  const keep = new Set(['timestamp', 'time', 'pid']);
  for (const [group, keys] of Object.entries(PC_METRIC_KEYS)) {
    if (mc[group]) keys.forEach(k => keep.add(k));
  }
  const out = {};
  for (const k of Object.keys(data)) {
    if (k === 'pcExtra') {
      const px = data.pcExtra;
      if (!px || typeof px !== 'object') continue;
      const extraKeep = new Set(['exe', 'name', 'fpsSource']);
      for (const [group, keys] of Object.entries(PC_EXTRA_KEYS)) {
        if (mc[group]) keys.forEach(k2 => extraKeep.add(k2));
      }
      const pxOut = {};
      for (const k2 of Object.keys(px)) {
        if (extraKeep.has(k2)) pxOut[k2] = px[k2];
      }
      out.pcExtra = pxOut;
      continue;
    }
    if (keep.has(k)) out[k] = data[k];
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveBundledPythonExe() {
  if (process.resourcesPath) {
    const p = path.join(process.resourcesPath, 'ios-tools', 'python', 'python', 'python.exe');
    if (fs.existsSync(p)) return p;
  }
  return path.join(__dirname, '..', 'ios-tools', 'python', 'python', 'python.exe');
}

function resolvePcScriptPyc() {
  const name = 'collect_pc_perf.pyc';
  if (process.resourcesPath) {
    const p = path.join(process.resourcesPath, 'ios-tools', 'python', 'python', 'Scripts', name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(__dirname, '..', 'ios-tools', 'python', 'python', 'Scripts', name);
}

function resolvePcScriptPy() {
  const name = 'collect_pc_perf.py';
  if (process.resourcesPath) {
    const p = path.join(process.resourcesPath, 'ios-tools', 'python', 'python', 'Scripts', name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(__dirname, '..', 'ios-tools', 'python', 'python', 'Scripts', name);
}

/**
 * 「源码 vs 字节码」按修改时间选较新者。
 *
 * 历史坑：发布包里只有 `collect_pc_perf.pyc`，`start()` 无脑优先 pyc；
 * 开发态改完 `collect_pc_perf.py` 忘了重编，运行期仍旧跑旧逻辑，现象极难定位。
 * 现在构建时由 `tools/compile_pc_collector.py` 统一重编（已挂到 build_app.py），
 * 运行期再做一次兜底：.py 明显比 .pyc 新就改用 .py 并打日志提醒重编。
 * 抽成纯函数是为了能注入假的 exists/stat 做离线断言。
 */
function pickNewerScript(paths, exists, stat) {
  const pyc = paths.pyc, py = paths.py;
  const hasPyc = !!exists(pyc), hasPy = !!exists(py);
  if (!hasPyc && !hasPy) return { path: null, stale: false, reason: 'missing' };
  if (!hasPyc) return { path: py, stale: false, reason: 'py-only' };
  if (!hasPy) return { path: pyc, stale: false, reason: 'pyc-only' };
  let pycMs = 0, pyMs = 0;
  try { pycMs = stat(pyc).mtimeMs || 0; } catch (_) {}
  try { pyMs = stat(py).mtimeMs || 0; } catch (_) {}
  // 1s 容差：Windows 时间戳精度 + 复制/解压会改写 mtime，别把同一次构建判成过期
  const stale = pyMs > pycMs + 1000;
  return { path: stale ? py : pyc, stale, reason: stale ? 'py-newer' : 'pyc-current' };
}

function resolvePcScript() {
  return pickNewerScript(
    { pyc: resolvePcScriptPyc(), py: resolvePcScriptPy() },
    (p) => fs.existsSync(p),
    (p) => fs.statSync(p)
  );
}

class PcCollector extends EventEmitter {
  constructor(exePath, metricConfig = null) {
    super();
    this.exePath = exePath;
    this._proc = null;
    this._running = false;
    this._buf = '';
    this._stopReason = null;
    /** @type {Record<string, boolean>} 采集参数开关（默认全采） */
    this._mc = normalizePcMetricConfig(metricConfig);
    /** PresentMon 无权限时只提示一次，避免每帧刷屏 */
    this._fpsWarned = false;
  }

  _log(msg) {
    this.emit('log', msg);
  }

  /**
   * 拉起目标进程：直接 CreateProcess(exePath)，不再经 `cmd /c start`。
   * 旧写法把路径交给 cmd 再解析一次，而 cmd 会先把 `^&` 还原成 `&` ——
   * 于是 `Game.exe^&calc.exe` 这类文件名能在用户机器上多执行一条命令。
   * Node 不带 shell 的 spawn 只做「引号包空格」，& | ^ 都是路径里的字面字符，注入面就此消失。
   */
  async _spawnTargetExe(exePath) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(exePath, [], {
          windowsHide: true,
          stdio: 'ignore',
          detached: true,
          cwd: path.dirname(exePath),
        });
      } catch (e) {
        this._log(`[PC] 启动目标失败（将仍尝试采样）: ${e.message}`);
        resolve();
        return;
      }
      child.on('error', (err) => {
        this._log(`[PC] 启动目标失败（将仍尝试采样）: ${err.message}`);
        resolve();
      });
      child.on('close', () => resolve());
      try { child.unref(); } catch (_) {}
    });
  }

  async start() {
    const py = resolveBundledPythonExe();
    const resolved = resolvePcScript();
    if (!fs.existsSync(py)) {
      throw new Error(`未找到内置 Python：${py}`);
    }
    if (!script) {
      throw new Error('未找到 collect_pc_perf.pyc / collect_pc_perf.py（Scripts 目录）');
    }
    if (resolved.stale) {
      this._log('[PC] 采集源码 .py 比 .pyc 新，本次改用源码运行；'
        + '发布前请执行 python tools/compile_pc_collector.py 统一重编');
    }
    // FIX-15：pyc magic 错配 / 损坏时的自动回退（一次性）。resolvePcScript 仍会
    // 选 pyc（mtime 没变），这里显式改用 .py 重跑，并打可见日志提示重编。
    let scriptPath = resolved.path;
    if (this._pyFallback && /\.pyc$/i.test(scriptPath)
        && fs.existsSync(scriptPath.replace(/\.pyc$/i, '.py'))) {
      scriptPath = scriptPath.replace(/\.pyc$/i, '.py');
      this._log('[PC] 字节码不可用，已回退源码 .py 运行；'
        + '发布前请用内置解释器执行 tools/compile_pc_collector.py 重编');
    }
    const exe = path.normalize(String(this.exePath || '').trim());
    if (!exe || !fs.existsSync(exe)) {
      throw new Error('可执行文件不存在');
    }

    this._running = true;
    this._buf = '';
    this._fpsWarned = false;
    this._log(`启动 PC 采集脚本: ${scriptPath}`);
    this._log(`目标进程: ${exe}`);

    if (process.platform === 'win32') {
      this._log('[PC] 直接拉起目标 exe…');
      await this._spawnTargetExe(exe);
      await sleep(1200);
    }

    // -u：stdout 无缓冲，管道场景下尽快把每行 JSON 送到前端（否则可能长时间看不到曲线）
    // exe 作为 argv 单独一项传入 Python，路径中的空格无需再包引号
    this._proc = spawn(py, ['-u', scriptPath, exe], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.dirname(scriptPath),
    });

    this._proc.stdout.on('data', (chunk) => {
      this._buf += chunk.toString('utf8');
      let idx;
      while ((idx = this._buf.indexOf('\n')) >= 0) {
        const line = this._buf.slice(0, idx).trim();
        this._buf = this._buf.slice(idx + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.error) {
            if (obj.error === 'process_gone') {
              this._log('目标进程已退出');
              this.stop('process_gone');
              return;
            }
            this._log(`脚本错误: ${obj.message || obj.error}`);
            this.emit('script-error', obj.message || obj.error || 'script_error');
            this.stop('script_error');
            return;
          }
          if (obj.pcExtra && obj.pcExtra.fpsSource === 'none' && !this._fpsWarned) {
            this._fpsWarned = true;
            this._log('[PC] 未能获取帧率数据：PresentMon 需要管理员权限才能查询该进程。'
              + '请以管理员身份重新运行本工具后再采 FPS；CPU / 内存 / GPU 等指标不受影响。');
          }
          // 按采集参数过滤：被移除的组不上报
          const d = filterPcData(obj, this._mc);
          if (d && typeof d === 'object') d.meta = SampleMeta.makeSampleMeta('pc', d);
          this.emit('data', d);
        } catch (e) {
          this._log(`JSON 解析跳过: ${line.slice(0, 80)}`);
        }
      }
    });

    this._proc.stderr.on('data', (chunk) => {
      const t = chunk.toString('utf8').trim();
      if (t) this._log(t);
      // FIX-15：pyc 加载即崩（magic 错配 / 文件损坏）→ 自动用 .py 重跑一次，
      // 不留「采集页显示采集中但一个数都没有」的静默失效。只回退一次，防循环。
      if (!this._pyFallback
          && /Bad magic number|ImportError|Source code string cannot be null|SyntaxError/i.test(t)
          && /\.pyc$/i.test(scriptPath)) {
        this._pyFallback = true;
        this._log('[PC] 检测到字节码不可用，自动回退源码 .py …');
        try { this.stop('pyc_broken'); } catch (_) {}
        setTimeout(() => { this.start().catch(() => {}); }, 300);
        return;
      }
    });

    this._proc.on('error', (err) => {
      this.emit('script-error', err.message || String(err));
      this.stop('spawn_error');
    });

    this._proc.on('close', () => {
      this._proc = null;
      this._running = false;
      const r = this._stopReason || 'exit';
      this._stopReason = null;
      this._log('PC 采集已停止');
      this.emit('stopped', { reason: r, ts: Date.now() });
    });
  }

  stop(reason = 'manual') {
    this._stopReason = reason;
    this._running = false;
    if (this._proc) {
      const child = this._proc;
      try {
        child.kill('SIGTERM');
      } catch (_) {}
      try {
        if (process.platform === 'win32' && child.pid) {
          require('child_process').exec(`taskkill /PID ${child.pid} /T /F`, () => {});
        }
      } catch (_) {}
    } else {
      this.emit('stopped', { reason, ts: Date.now() });
    }
  }
}

module.exports = {
  PcCollector,
  normalizePcMetricConfig,
  filterPcData,
  nullIfUnavailable,
  PC_METRIC_KEYS,
  resolveBundledPythonExe,
  resolvePcScriptPyc,
  resolvePcScriptPy,
  resolvePcScript,
  pickNewerScript,
};
