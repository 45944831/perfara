'use strict';

const EventEmitter = require('events');
const ADB = require('./adb');

/**
 * 内存里保留的采样点上限。
 * 1 Hz 采集时 3600 点正好 1 小时，跑更久会静默丢掉开头（历史曲线缺失）。
 * 单样本约 600 B，14400 点（4 小时）约 9 MB，代价可接受。
 */
const MAX_HISTORY = 14400;
/** adb 冷启动后等待再开始采样；此期间不判定「进程消失」停止采集 */
const ADB_LAUNCH_STABILIZE_MS = 5000;
/** 冷启动后再给一段时间，避免 pid 短暂拿不到就自动停采 */
const POST_LAUNCH_PID_GRACE_MS = 5000;
/**
 * PID 刷新间隔（tick 数）。
 * PID 变化极慢，每 tick 都查等于每 5 秒多付 4 次 adb 进程创建；
 * 但完全缓存又会在应用被杀后迟迟不发现，故按 5 tick 刷新，异常时立即重查。
 */
const PID_REFRESH_EVERY = 5;

/**
 * getFps 的 method 取值中，这些表示「本次没取到帧数据」，而不是「真实 0 帧」：
 *   none           —— 三条取帧通道全部失败（应用不在前台 / 无 Surface / 非 View 渲染）
 *   error          —— 取帧过程抛异常
 *   timestats-init —— timestats 首个采样点，还没有 totalFrames 增量
 * 这些点若写成 fps=0，会被下游当成真实掉帧：均值被拉低、1%Low 直接归零。
 * 一律写 null（曲线断开），由报告页的加载段识别与统计剔除接手。
 */
const FPS_NO_DATA_METHODS = new Set(['none', 'error', 'timestats-init']);

/**
 * 采集参数配置 → 采集器内部开关。
 * 与 renderer/metric-settings.js 的组定义保持一致；缺省一律采集（兼容旧调用）。
 */
const ANDROID_METRIC_KEYS = {
  fps: ['fps', 'jank', 'bigJank', 'smallJank', 'tinyJank', 'jankRate'],
  cpu: ['cpu', 'cpuCores'],
  mem: ['mem'],
  net: ['net'],
  gpu: ['gpu'],
  temp: ['temperature', 'gpuTemp'],
  battery: ['battery'],
};

function normalizeMetricConfig(cfg) {
  const out = {};
  for (const k of Object.keys(ANDROID_METRIC_KEYS)) out[k] = true;
  if (cfg && typeof cfg === 'object') {
    for (const k of Object.keys(out)) {
      if (Object.prototype.hasOwnProperty.call(cfg, k)) out[k] = !!cfg[k];
    }
  }
  return out;
}

/** 按配置过滤数据对象：只保留启用组的字段（timestamp/time/pid 恒保留） */
function filterDataByConfig(data, mc) {
  const keep = new Set(['timestamp', 'time', 'pid']);
  for (const [group, keys] of Object.entries(ANDROID_METRIC_KEYS)) {
    if (mc[group]) keys.forEach(k => keep.add(k));
  }
  const out = {};
  for (const k of Object.keys(data)) {
    if (keep.has(k) && data[k] !== undefined) out[k] = data[k];
  }
  return out;
}

class Collector extends EventEmitter {
  constructor(deviceId, packageName, intervalMs = 1000, metricConfig = null) {
    super();
    this.deviceId = deviceId;
    this.packageName = packageName;
    this.intervalMs = intervalMs;
    this._timer = null;
    this._running = false;
    this._pid = null;
    /** @type {number} 在此时间戳之前，_tick 不因 getPid 为空而 stop（仅 Android） */
    this._processGoneGraceUntil = 0;
    /** @type {number} 每次 start/stop 自增，用于丢弃上一轮残留 async */
    this._runToken = 0;
    /** @type {Record<string, boolean>} 采集参数开关（默认全采） */
    this._mc = normalizeMetricConfig(metricConfig);
    this.history = [];
    /** @type {boolean} 上一 tick 是否仍在跑（重入门闩） */
    this._tickBusy = false;
    /** @type {number} 本轮已执行的 tick 数，用于 PID 刷新节流 */
    this._tickCount = 0;
    /** @type {number} 连续跳过的重叠 tick 数（只用于日志降噪） */
    this._skippedTicks = 0;
  }

  _log(msg, token = this._runToken) {
    // Do not emit logs from stale runs
    if (!this._running) return;
    if (token !== this._runToken) return;
    this.emit('log', msg);
  }

  async start() {
    const token = ++this._runToken;
    this._running = true;
    this._processGoneGraceUntil = 0;
    this._tickBusy = false;
    this._tickCount = 0;
    this._skippedTicks = 0;
    // Cancel any previous inflight adb tasks before starting new run
    try { ADB.cancelAllInflight(); } catch (_) {}
    this._log(`开始采集: ${this.packageName} @ ${this.deviceId}`, token);
    const ensure = await ADB.ensureAppRunning(this.deviceId, this.packageName, (m) => this._log(m, token));
    if (!this._running || token !== this._runToken) return;
    this._pid = ensure.pid;
    if (!this._pid) {
      this._running = false;
      throw new Error(ensure.error || '应用未运行且启动失败');
    }
    if (ensure.launched) {
      this._log(`应用已由 adb 启动，等待 ${ADB_LAUNCH_STABILIZE_MS / 1000}s 后再开始采样…`, token);
      await new Promise((r) => setTimeout(r, ADB_LAUNCH_STABILIZE_MS));
      if (!this._running || token !== this._runToken) return;
      this._pid = await ADB.getPid(this.deviceId, this.packageName).catch(() => null);
      if (!this._pid) {
        this._running = false;
        throw new Error('等待后仍未检测到应用进程，已取消采集');
      }
      this._processGoneGraceUntil = Date.now() + POST_LAUNCH_PID_GRACE_MS;
    }
    const uid = await ADB.getUid(this.deviceId, this.packageName).catch(() => null);
    if (!this._running || token !== this._runToken) return;
    this._log(`PID=${this._pid ?? 'N/A'}, UID=${uid ?? 'N/A'}`, token);
    this._tick();
    this._timer = setInterval(() => this._tick(), this.intervalMs);
  }

  stop(reason = 'manual') {
    // invalidate any inflight async steps and kill inflight adb calls
    this._runToken++;
    this._running = false;
    this._processGoneGraceUntil = 0;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    try { ADB.cancelAllInflight(); } catch (_) {}
    ADB.resetDeviceState(this.deviceId);
    // Avoid emitting "stopped" logs from stale tasks; this is a direct stop call.
    this.emit('log', '采集已停止');
    this.emit('stopped', {
      reason,
      deviceId: this.deviceId,
      packageName: this.packageName,
      pid: this._pid,
      ts: Date.now(),
    });
  }

  /**
   * 采样周期入口：只做「防叠加」这一件事。
   *
   * setInterval 不等待上一次完成，而单次 tick 要起 8~9 个 adb 进程（实测 290–450 ms）。
   * 设备一卡（dumpsys 慢）单个调用可挂到超时，于是 10 s 内能叠 10 个 tick = 90 个 adb 进程，
   * 越卡越卡。这里用布尔门闩把并发钉死在 1 个 tick。
   */
  async _tick() {
    if (!this._running) return;
    if (this._tickBusy) {
      this._skippedTicks++;
      // 只在前几次和每 10 次报一次，避免日志被刷屏
      if (this._skippedTicks === 1 || this._skippedTicks % 10 === 0) {
        this._log(`上一采样周期尚未完成，已跳过 ${this._skippedTicks} 次重叠采样（设备响应偏慢）`);
      }
      return;
    }
    this._tickBusy = true;
    this._skippedTicks = 0;
    try {
      await this._tickBody();
    } catch (err) {
      this.emit('error', err);
    } finally {
      this._tickBusy = false;
    }
  }

  async _tickBody() {
    if (!this._running) return;
    const token = this._runToken;
    this._tickCount++;

    // PID 每 PID_REFRESH_EVERY 个 tick 刷新一次，其余 tick 复用缓存：
    // 应用被杀最多延迟 5 s 被发现（配合 _processGoneGraceUntil 不会误停）。
    const needPid = !this._pid || this._tickCount % PID_REFRESH_EVERY === 1;
    if (needPid) {
      const pidNow = await ADB.getPid(this.deviceId, this.packageName).catch(() => null);
      if (!this._running || token !== this._runToken) return;
      if (!pidNow) {
        if (this._processGoneGraceUntil && Date.now() < this._processGoneGraceUntil) {
          return;
        }
        this._log(`检测到应用未运行（可能被系统杀死）：${this.packageName}，已自动停止采集`);
        this.stop('process_gone');
        return;
      }
      this._pid = pidNow;
      if (this._processGoneGraceUntil) this._processGoneGraceUntil = 0;
    }

    const logFn = (msg) => this._log(msg);
    const mc = this._mc;

    try {
      // 按采集参数只调用启用的采集项：被移除的参数完全不采（省 adb 开销）
      const jobs = [];
      if (mc.cpu)   jobs.push(['cpu',     ADB.getCpuStats(this.deviceId, this._pid)]);
      if (mc.cpu)   jobs.push(['cores',   ADB.getCpuCoreStats(this.deviceId)]);
      if (mc.mem)   jobs.push(['mem',     ADB.getMemInfo(this.deviceId, this.packageName)]);
      if (mc.fps)   jobs.push(['fps',     ADB.getFps(this.deviceId, this.packageName, logFn)]);
      if (mc.net)   jobs.push(['net',     ADB.getNetStats(this.deviceId)]);
      if (mc.battery) jobs.push(['battery', ADB.getBatteryInfo(this.deviceId)]);
      if (mc.temp)  jobs.push(['thermal', ADB.getThermalInfo(this.deviceId)]);
      if (mc.gpu)   jobs.push(['gpu',     ADB.getGpuUsage(this.deviceId)]);
      const settled = await Promise.allSettled(jobs.map(j => j[1]));
      // 采集期间被 stop()：结果直接丢弃，不写入 history、不 emit
      if (!this._running || token !== this._runToken) return;

      const val = {};
      jobs.forEach((j, i) => {
        const r = settled[i];
        val[j[0]] = r.status === 'fulfilled' ? r.value : undefined;
      });

      // getThermalInfo 返回 { temperature, gpuTemp }
      const thermalVal = val.thermal || { temperature: 0, gpuTemp: null };
      const thermalMain = thermalVal && typeof thermalVal.temperature === 'number' ? thermalVal.temperature : 0;
      const gpuTemp = thermalVal && typeof thermalVal.gpuTemp === 'number' ? thermalVal.gpuTemp : null;

      // getFps returns { fps, jank, bigJank, smallJank, tinyJank, jankRate, method } or falls back to number 0
      const fpsData = val.fps || { fps: 0, jank: 0, bigJank: 0, smallJank: 0, tinyJank: 0, jankRate: 0, method: 'error' };
      const fps     = typeof fpsData === 'object' ? fpsData.fps     : fpsData;
      const jank    = typeof fpsData === 'object' ? fpsData.jank    : 0;
      const bigJank = typeof fpsData === 'object' ? fpsData.bigJank : 0;
      const smallJank = typeof fpsData === 'object' ? (fpsData.smallJank || 0) : 0;  // PerfDog 微小卡顿（≥84ms 档）
      const tinyJank  = typeof fpsData === 'object' ? (fpsData.tinyJank  || 0) : 0;  // PerfDog 极小卡顿（≥1.5×vsync 档）
      const jankRate= typeof fpsData === 'object' ? fpsData.jankRate: 0;
      // 没取到帧数据（加载中 / 不在前台 / 首帧未就绪）→ 写 null，不写 0
      const fpsNoData = typeof fpsData === 'object'
        ? FPS_NO_DATA_METHODS.has(String(fpsData.method || ''))
        : false;

      const data = {
        timestamp:   Date.now(),
        time:        new Date().toLocaleTimeString(),
        pid:         this._pid,
      };
      if (mc.cpu) {
        data.cpu = val.cpu || { sysCpu: 0, procCpu: 0 };
        data.cpuCores = val.cores || { usage: [], freq: [] };
      }
      if (mc.mem)   data.mem = val.mem || { totalPss: 0, nativeHeap: 0, dalvikHeap: 0 };
      if (mc.fps) {
        if (fpsNoData) {
          // 无数据 ≠ 0 帧：写成 null，让曲线断开、统计跳过
          data.fps = null; data.jank = null; data.bigJank = null;
          data.smallJank = null; data.tinyJank = null; data.jankRate = null;
        } else {
          data.fps = fps; data.jank = jank; data.bigJank = bigJank;
          data.smallJank = smallJank; data.tinyJank = tinyJank; data.jankRate = jankRate;
        }
      }
      if (mc.net)   data.net = val.net || { rxKBps: 0, txKBps: 0 };
      if (mc.battery) data.battery = val.battery || { level: 0, voltage: 0, temperature: 0, currentNow: 0, power: 0 };
      if (mc.temp) {
        data.temperature = thermalMain;
        data.gpuTemp = gpuTemp;   // GPU 温度；利用率读不到时报告页用它补位
      }
      if (mc.gpu)   data.gpu = val.gpu ?? null; // null = 该机型未提供，报告页显示为无数据

      if (this.history.length >= MAX_HISTORY) this.history.shift();
      this.history.push(data);
      this.emit('data', data);
    } catch (err) {
      this.emit('error', err);
    }
  }
}

module.exports = Collector;
module.exports.normalizeMetricConfig = normalizeMetricConfig;
module.exports.filterDataByConfig = filterDataByConfig;
module.exports.ANDROID_METRIC_KEYS = ANDROID_METRIC_KEYS;
