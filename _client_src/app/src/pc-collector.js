'use strict';

const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

/**
 * PC 采集参数组 → 字段映射（与 renderer/metric-settings.js 一致）。
 * 采集脚本一次输出全部字段，这里在入口按配置过滤。
 * pcExtra 为子对象：exe/name/fpsSource 恒保留（报告页设备信息用），
 * fpsFloat 归 fps 组，diskReadKBps/diskWriteKBps 归 disk 组。
 */
const PC_METRIC_KEYS = {
  fps:     ['fps', 'jank', 'bigJank', 'jankRate'],
  cpu:     ['cpu', 'cpuCores'],
  mem:     ['mem'],
  net:     ['net'],
  gpu:     ['gpu'],
  temp:    ['temperature'],
  battery: ['battery'],
  disk:    ['pcExtra'],
};

const PC_EXTRA_KEYS = {
  fps:  ['fpsFloat'],
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
    const noBattery = !b.level && !b.voltage && !b.temperature && !b.currentNow && !b.power;
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
   * Windows：用 `cmd /c start "" "<exe>"` 拉起目标进程，路径含空格时由 argv 单参数传递，不依赖手工引号。
   * 随后再由 Python 按绝对路径 attach；spawn(py, [..., exe]) 同样以单参数传递 exe，兼容空格。
   */
  async _winCmdStartExe(exePath) {
    return new Promise((resolve) => {
      const cmd = process.env.ComSpec || 'cmd.exe';
      const child = spawn(cmd, ['/d', '/c', 'start', '', exePath], {
        windowsHide: true,
        stdio: 'ignore',
        detached: true,
      });
      child.on('error', (err) => {
        this._log(`[PC] start 启动目标失败（将仍尝试采样）: ${err.message}`);
        resolve();
      });
      child.on('close', () => resolve());
    });
  }

  async start() {
    const py = resolveBundledPythonExe();
    let script = resolvePcScriptPyc();
    if (!fs.existsSync(py)) {
      throw new Error(`未找到内置 Python：${py}`);
    }
    if (!fs.existsSync(script)) {
      script = resolvePcScriptPy();
    }
    if (!fs.existsSync(script)) {
      throw new Error('未找到 collect_pc_perf.pyc / collect_pc_perf.py（Scripts 目录）');
    }
    const exe = path.normalize(String(this.exePath || '').trim());
    if (!exe || !fs.existsSync(exe)) {
      throw new Error('可执行文件不存在');
    }

    this._running = true;
    this._buf = '';
    this._fpsWarned = false;
    this._log(`启动 PC 采集脚本: ${script}`);
    this._log(`目标进程: ${exe}`);

    if (process.platform === 'win32') {
      this._log('[PC] cmd start 拉起目标 exe…');
      await this._winCmdStartExe(exe);
      await sleep(1200);
    }

    // -u：stdout 无缓冲，管道场景下尽快把每行 JSON 送到前端（否则可能长时间看不到曲线）
    // exe 作为 argv 单独一项传入 Python，路径中的空格无需再包引号
    this._proc = spawn(py, ['-u', script, exe], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.dirname(script),
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
          this.emit('data', filterPcData(obj, this._mc));
        } catch (e) {
          this._log(`JSON 解析跳过: ${line.slice(0, 80)}`);
        }
      }
    });

    this._proc.stderr.on('data', (chunk) => {
      const t = chunk.toString('utf8').trim();
      if (t) this._log(t);
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
};
