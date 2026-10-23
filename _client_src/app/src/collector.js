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
/**
 * 应用从后台切到前台后的稳定期。
 * 切前台后渲染层要重新出帧，timestats 首帧增量此刻尚未建立，
 * 立刻采样只会拿到 method='timestats-init' 的假零点。
 * 比冷启动短：进程本来就在跑，只需等渲染恢复。
 */
const SWITCH_STABILIZE_MS = 1500;
/** 冷启动后再给一段时间，避免 pid 短暂拿不到就自动停采 */
const POST_LAUNCH_PID_GRACE_MS = 5000;
/**
 * PID 刷新间隔（tick 数）。
 * PID 变化极慢，每 tick 都查等于每 5 秒多付 4 次 adb 进程创建；
 * 但完全缓存又会在应用被杀后迟迟不发现，故按 5 tick 刷新，异常时立即重查。
 */
const PID_REFRESH_EVERY = 5;

/**
 * 采集期的时间常量。集中放在一个对象里，一是便于单测按比例缩小验证熔断逻辑，
 * 二是避免「16s」「20s」这类魔数散落在代码各处说不清来历。
 */
const TIMINGS = {
  /**
   * 单轮采样的硬超时（看门狗）。
   * 单个 adb 调用已有 4s/10s 超时，一轮最多 14s；超过 16s 说明 adb 通道本身
   * 卡死了（execFile 的 timeout 依赖子进程响应 SIGTERM，卡死时不会触发）。
   * 此时中止本轮、清掉 inflight adb 进程，把门闩交还给下一轮。
   */
  TICK_TIMEOUT_MS: 16000,
  /**
   * 无数据熔断：连续这么久没有产出任何采样点（含 fps=null 的「无帧数据」点），
   * 就认为设备侧已经卡死，自动停止采集并告知用户。
   * 正常最坏情况一轮 14s 仍会产出数据点，故 20s 不会误判。
   */
  STALL_MS: 20000,
  /** 熔断巡检间隔 */
  STALL_CHECK_MS: 2000,
  /**
   * start() 全流程硬超时（含拉起应用、稳定期等待）。
   * 正常路径 6~10s；健康检查 + 安装检查 + 无入口快速失败已把常见卡点砍掉，
   * 超过 30s 只能说明设备/应用迟迟不就绪——继续等只是让用户对着「准备中」发呆。
   */
  START_TIMEOUT_MS: 30000,
};
/** 连续这么多轮采样被看门狗中止就熔断（两轮 ≈ 用户已干等 30s+） */
const DEAD_TICK_LIMIT = 2;
/**
 * 连续这么多轮「所有采集调用全失败」就熔断。
 * 与 DEAD_TICK_LIMIT 不同：那是「慢到卡住」，这是「通道直接断了」——
 * 每次调用都快速失败，轮次间隔正常，只有全失败计数能识别出来。
 * 3 轮 ≈ 3s，用户几乎立刻拿到「连接可能已断开」的结论。
 */
const ALL_FAIL_TICK_LIMIT = 3;

/**
 * getFps 的 method 取值中，这些表示「本次没取到帧数据」，而不是「真实 0 帧」：
 *   none           —— 三条取帧通道全部失败（应用不在前台 / 无 Surface / 非 View 渲染）
 *   error          —— 取帧过程抛异常
 *   timestats-init —— timestats 首个采样点，还没有 totalFrames 增量
 *   no-frames      —— timestats 匹配到图层，但本周期一帧都没产出
 *                     （应用静止/被遮挡/已切后台）。这不是「掉到 0 帧」，
 *                     写成 0 会把 FPS 均值与 1%Low 全部拉低。
 * 这些点若写成 fps=0，会被下游当成真实掉帧：均值被拉低、1%Low 直接归零。
 * 一律写 null（曲线断开），由报告页的加载段识别与统计剔除接手。
 */
const FPS_NO_DATA_METHODS = new Set(['none', 'error', 'timestats-init', 'no-frames']);

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
    /** @type {number} 最近一次成功产出采样点的时间戳（熔断判定用） */
    this._lastDataTs = 0;
    /** @type {NodeJS.Timeout|null} 无数据熔断巡检定时器 */
    this._stallTimer = null;
    /** @type {boolean} 是否已触发过熔断（防止重复 stop） */
    this._breakerTripped = false;
    /** @type {number} tick 序号：看门狗据此把「已中止」精准通知到对应那一轮 */
    this._tickSeq = 0;
    /** @type {number} 被看门狗中止的 tick 序号 */
    this._tickAbortSeq = 0;
    /** @type {number} 连续被看门狗中止的轮数 */
    this._deadTicks = 0;
    /** @type {number} 连续「所有采集调用全失败」的轮数（通道断开判定） */
    this._allFailTicks = 0;
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
    this._breakerTripped = false;
    this._deadTicks = 0;
    this._allFailTicks = 0;
    // Cancel any previous inflight adb tasks before starting new run
    try { ADB.cancelAllInflight(); } catch (_) {}
    this._log(`开始采集: ${this.packageName} @ ${this.deviceId}`, token);

    // 全流程硬超时：无论卡在「设备无响应」「应用拉不起来」还是「稳定期等待」，
    // 都要在有限时间内给用户一个明确结论，不能让 PC 端一直转圈。
    let guard = null;
    try {
      await Promise.race([
        this._startSequence(token),
        new Promise((_resolve, reject) => {
          guard = setTimeout(() => reject(new Error(
            `启动超时（超过 ${TIMINGS.START_TIMEOUT_MS / 1000}s 设备或应用仍未就绪）。`
            + '请检查设备是否卡顿、屏幕是否解锁，然后重试；'
            + '必要时先在手机上手动打开目标应用再点开始。'
          )), TIMINGS.START_TIMEOUT_MS);
        }),
      ]);
    } catch (e) {
      // 超时或启动失败：收尾必须干净，否则残留 timer 会继续采样、
      // 残留 adb 进程会继续拖慢设备，下一次开始又会叠加
      this._runToken++;                       // 作废仍在跑的 _startSequence
      this._running = false;
      this._tickBusy = false;
      this._processGoneGraceUntil = 0;
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      this._stopStallWatchdog();
      try { ADB.cancelAllInflight(); } catch (_) {}
      throw e;
    } finally {
      if (guard) clearTimeout(guard);
    }
  }

  /** start() 的主体：健康检查 → 拉起/切前台 → 稳定期 → 首个 tick。
   *  拆出来是为了让 start() 能给整段流程套一个有界超时。 */
  async _startSequence(token) {
    // ── 采集前健康检查 ────────────────────────────────────────────────────
    // 设备没响应 / 内存见底 / GPU 被别人占满时，后面每一步都只会更慢、数据也更没意义。
    // 在动应用之前先探清楚，失败就直接给出可操作的原因。
    let preflight = null;
    try {
      preflight = await ADB.preflightCheck(this.deviceId);
    } catch (e) {
      // 检查本身出错不阻断采集（可能是权限/机型差异），按「未知」继续
      this._log(`[健康检查] 检查过程异常，已跳过：${e.message}`, token);
    }
    if (!this._running || token !== this._runToken) return;
    if (preflight) {
      (preflight.notes || []).forEach((n) => this._log(`[健康检查] ${n}`, token));
      (preflight.warnings || []).forEach((w) => this._log(`[健康检查] 警告：${w}`, token));
      if (preflight.level === 'fail') {
        this._running = false;
        throw new Error(preflight.reason || '设备健康检查未通过');
      }
      this._log(`[健康检查] ${preflight.summary || '通过'}`, token);
    }

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
    } else if (ensure.switched) {
      // 应用本来就在后台，这次只是被切到前台。
      // 切前台后渲染层要重新出帧，timestats 的首帧增量此刻还没建立，
      // 立刻采样会拿到 method='timestats-init'（fps=0）的假零点。
      // 给一个较短的稳定期即可（不必像冷启动那样等 5 秒）。
      this._log(`应用已切到前台，等待 ${SWITCH_STABILIZE_MS / 1000}s 让渲染层恢复后再采样…`, token);
      await new Promise((r) => setTimeout(r, SWITCH_STABILIZE_MS));
      if (!this._running || token !== this._runToken) return;
    }
    const uid = await ADB.getUid(this.deviceId, this.packageName).catch(() => null);
    if (!this._running || token !== this._runToken) return;
    this._log(`PID=${this._pid ?? 'N/A'}, UID=${uid ?? 'N/A'}`, token);
    this._tick();
    this._timer = setInterval(() => this._tick(), this.intervalMs);
    // 无数据熔断巡检：从「本应开始出数据」这一刻起算
    this._startStallWatchdog();
  }

  stop(reason = 'manual') {
    // invalidate any inflight async steps and kill inflight adb calls
    this._runToken++;
    this._running = false;
    this._processGoneGraceUntil = 0;
    this._deadTicks = 0;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._stopStallWatchdog();
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

  // ─── 超时熔断 ────────────────────────────────────────────────────────────
  //
  // 目标：设备卡死时**主动**停，并且把原因说清楚。
  // 没有这一层，用户面对的是「状态栏显示采集中、曲线却再也不动」的假活状态，
  // 既不知道是该等还是该重试，也不敢随便点停止（怕丢数据）。
  //
  // 两级防线：
  //   ① 单轮看门狗（_tick）——某一轮卡住超过 TICK_TIMEOUT_MS 就中止本轮、
  //      清掉 inflight adb 进程、把门闩交还下一轮（否则 _tickBody 里
  //      永不 resolve 的 promise 会把门闩焊死，后面再也采不动）；
  //   ② 无数据巡检（_stallTimer）——连续 STALL_MS 没有任何采样点产出
  //      （含 fps=null 的无帧点）就熔断，直接回答「用户多久没看到新数据了」。

  /** 启动无数据巡检（每次 start 重新起，stop 时清） */
  _startStallWatchdog() {
    this._stopStallWatchdog();
    this._lastDataTs = Date.now();
    this._stallTimer = setInterval(() => {
      if (!this._running || this._breakerTripped) return;
      const idle = Date.now() - this._lastDataTs;
      if (idle < TIMINGS.STALL_MS) return;
      this._tripBreaker(`已连续超过 ${TIMINGS.STALL_MS / 1000}s 没有新的采样数据`);
    }, TIMINGS.STALL_CHECK_MS);
  }

  _stopStallWatchdog() {
    if (this._stallTimer) { clearInterval(this._stallTimer); this._stallTimer = null; }
  }

  /** 熔断：停止采集 + 把可操作的原因送到界面 */
  _tripBreaker(detail) {
    if (this._breakerTripped || !this._running) return;
    this._breakerTripped = true;
    this._log(`设备响应异常，已自动停止采集（${detail}）`);
    this.stop('device_stall');
    this.emit('error', new Error(
      `设备响应异常，采集已自动停止（${detail}）。`
      + '请检查设备是否卡顿、USB 连接是否稳定，或关闭后台应用后重试。'
    ));
  }

  /**
   * 采样周期入口：防叠加 + 单轮看门狗。
   *
   * setInterval 不等待上一次完成，而单次 tick 要起 8~9 个 adb 进程（实测 290–450 ms）。
   * 设备一卡（dumpsys 慢）单个调用可挂到超时，于是 10 s 内能叠 10 个 tick = 90 个 adb 进程，
   * 越卡越卡。这里用布尔门闩把并发钉死在 1 个 tick。
   *
   * 门闩只解决「叠加」，解决不了「焊死」：_tickBody 里一旦出现永不 resolve 的
   * promise（adb 通道卡死、子进程不响应 SIGTERM），await 永远不返回，门闩就再也
   * 不会打开。看门狗到点强制收尾并清掉 inflight adb 进程，把门闩交还下一轮。
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
    const seq = ++this._tickSeq;
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      this._tickAbortSeq = seq;   // 通知这一轮：结果作废，别再往 history 里写
      this._log(`本轮采样超过 ${TIMINGS.TICK_TIMEOUT_MS / 1000}s 未完成，设备可能已卡住；已中止本轮并清理 adb 进程`);
      try { ADB.cancelAllInflight(); } catch (_) {}
    }, TIMINGS.TICK_TIMEOUT_MS);
    try {
      await this._tickBody(seq);
    } catch (err) {
      this.emit('error', err);
    } finally {
      clearTimeout(watchdog);
      this._tickBusy = false;
    }
    if (!watchdogFired) return;
    this._deadTicks++;
    // 连续两轮都采不动 ≈ 用户已经干等了 30s+：直接熔断，
    // 别把「设备卡」演变成「无限等待 + 一段空白曲线」
    if (this._deadTicks >= DEAD_TICK_LIMIT) {
      this._tripBreaker(`连续 ${this._deadTicks} 轮采样超过 ${TIMINGS.TICK_TIMEOUT_MS / 1000}s 未完成`);
    }
  }

  async _tickBody(seq = 0) {
    if (!this._running) return;
    // 已被本轮看门狗中止：不要再发起新的 adb 调用
    if (this._tickAbortSeq === seq) return;
    const token = this._runToken;
    this._tickCount++;

    // PID 每 PID_REFRESH_EVERY 个 tick 刷新一次，其余 tick 复用缓存：
    // 应用被杀最多延迟 5 s 被发现（配合 _processGoneGraceUntil 不会误停）。
    const needPid = !this._pid || this._tickCount % PID_REFRESH_EVERY === 1;
    if (needPid) {
      const pidNow = await ADB.getPid(this.deviceId, this.packageName).catch(() => null);
      // 被 stop() / 被看门狗中止：立刻收手，别再发起后续 adb 调用
      if (!this._running || token !== this._runToken || this._tickAbortSeq === seq) return;
      if (!pidNow) {
        if (this._processGoneGraceUntil && Date.now() < this._processGoneGraceUntil) {
          return;
        }
        // getPid 在「应用被杀」和「adb 连接断了」两种情况下都返回 null。
        // 直接报「应用进程已退出」会把 USB 掉线/设备离线误诊成应用崩溃，
        // 用户会去重启应用而不是检查连接。先花一次 echo 探活把两者分开。
        const channelAlive = await ADB.probeChannel(this.deviceId).catch(() => false);
        if (!this._running || token !== this._runToken || this._tickAbortSeq === seq) return;
        if (!channelAlive) {
          this._allFailTicks = (this._allFailTicks || 0) + 1;
          this._log(`设备通信失败（第 ${this._allFailTicks} 轮）：adb 无响应，应用状态未知`);
          if (this._allFailTicks >= ALL_FAIL_TICK_LIMIT) {
            this._tripBreaker(
              `连续 ${this._allFailTicks} 轮无法与设备通信，连接可能已断开（USB 松动 / adb 无响应 / 设备离线）`
            );
          }
          return;
        }
        this._allFailTicks = 0;
        this._log(`检测到应用未运行（可能被系统杀死）：${this.packageName}，已自动停止采集`);
        this.stop('process_gone');
        return;
      }
      this._allFailTicks = 0;
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
      // 采集期间被 stop() / 被看门狗中止：结果直接丢弃，不写入 history、不 emit
      if (!this._running || token !== this._runToken || this._tickAbortSeq === seq) return;

      // ── 通道整体失效判定 ────────────────────────────────────────────────
      // 真机实测：adb 通道断开（USB 松动 / adb server 挂掉 / 设备离线）时，
      // 每个采集调用都会**快速失败**。旧逻辑用 0 兜底后照样 emit 一条样本，
      // 于是 _lastDataTs 一直被刷新，「无数据熔断」永远不触发 —— 界面显示
      // 「采集中」、曲线是一条零线，用户以为在测，其实一个字节都没采到。
      // 这里把「本轮所有调用全失败」视为无效轮次：不写样本（让无数据巡检
      // 也能兜住），连续多轮全失败则立刻熔断并说明是连接问题。
      const okCount = settled.filter(r => r.status === 'fulfilled').length;
      if (jobs.length > 0 && okCount === 0) {
        this._allFailTicks = (this._allFailTicks || 0) + 1;
        if (this._allFailTicks >= ALL_FAIL_TICK_LIMIT) {
          this._tripBreaker(
            `连续 ${this._allFailTicks} 轮采集调用全部失败，设备连接可能已断开（USB 松动 / adb 无响应）`
          );
        }
        return;
      }
      this._allFailTicks = 0;

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
      // 本轮产出了数据（哪怕是 fps=null 的无帧点）：重置熔断计数与无数据计时
      this._deadTicks = 0;
      this._lastDataTs = Date.now();
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
// 供单测按比例缩小验证熔断逻辑（生产走默认值）
module.exports.__timings = TIMINGS;
