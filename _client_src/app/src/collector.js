'use strict';

const EventEmitter = require('events');
const ADB = require('./adb');
const SampleMeta = require('./sample-meta');
const { SegmentedHistory } = require('./segmented-history');

/**
 * 1.4 采集开销判定的纯函数（可离线注入慢 shell 验证告警触发）。
 * 判定用最近窗口的 P50：偶发一次慢 adb 不该刷屏，持续偏慢才是观测者效应。
 */
function assessTickCost(msValues, intervalMs) {
  const arr = (Array.isArray(msValues) ? msValues : [])
    .filter(v => typeof v === 'number' && isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  if (arr.length < 30) return { ready: false, p50: null, limit: null, over: false };
  const p50 = arr[Math.floor(arr.length / 2)];
  const limit = Math.max(200, (Number(intervalMs) || 1000) * TICK_COST_RATIO);
  return { ready: true, p50, limit, over: p50 > limit };
}

/**
 * 内存里保留的采样点上限。
 * 1 Hz 采集时 43200 点 = 12 小时；单样本约 650 B，满载约 28 MB，仍在可接受范围。
 *
 * 超出后**不静默丢弃**：每丢一个都会计数，第一次丢弃即写日志提醒，
 * 并把 droppedSamples 带进报告元数据（见 getDiagnostics）。
 * 旧实现 14400 点（4 小时）后直接 shift() 且不作声，用户会以为报告里
 * 就是全部数据 —— 这是最容易被误读的一类数据缺失。
 */
const MAX_HISTORY = 43200;
/** 采集开销监控窗口（拍数）：约 2 分钟 @1Hz，足够避开偶发抖动 */
const TICK_COST_WINDOW = 120;
/** 采集耗时占采样周期超过这个比例就告警（会实质影响被测应用） */
const TICK_COST_RATIO = 0.3;
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
 * 内存「重通道」的最小采样间隔。
 *
 * dumpsys meminfo 要遍历被测进程的全部 VMA 并统计 smaps，期间持有该进程的
 * mm 锁 —— 真机 A/B 实测（游戏 30fps、帧间隔 33.3ms 的场景）：
 *   每拍都跑 meminfo  → 被测应用帧间隔 P95 +12.5ms / P99 +20.1ms
 *   降频到 5s 一次    → P95 +4.3ms / P99 +5.4ms
 * 而同期其它五个通道的增量都在 ±1~2ms（噪声内），即采集干扰几乎全部来自这一条。
 *
 * 因此把 PSS 家族降频到 5s，中间的拍子改读 /proc/<pid>/status 的 RSS
 * （内核计数字段，不遍历地址空间，实测干扰为 0）。降频点沿用上次实测值并
 * 打 src:'full' 标记，报告侧据此说明「总 PSS 不是逐拍实测」。
 */
const MEM_FULL_REFRESH_MS = 5000;

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
 * 现代帧指标字段（与 adb.js 的 EMPTY_FRAME_STATS 一致）。
 * 单独列出来是为了「无帧数据」时统一写 null —— 漏掉任何一个都会在报告里
 * 变成一条 0 线，把「未测量」伪装成「测得 0」。
 */
const FRAME_STAT_KEYS = [
  'ftP50', 'ftP90', 'ftP95', 'ftP99',
  'jankyRatio', 'hitchMsPerSec', 'overrunP95', 'overrunP99', 'overrunMax',
];

/**
 * FIX-01：静置 / 低频渲染判定（抽成纯函数，供离线用例直接断言）。
 *
 * 触发条件（满足其一）：
 *   - fps ≤ 2：1s 采样窗口里最多 2 帧，帧分布没有任何统计意义；
 *   - ftP50 > 500ms：本段「典型帧」超过半秒 —— 只可能来自静置期的长间隔
 *     被计进帧分布（1 帧/3s 的直方图 [{2997,c:1}]），不是真实渲染节奏。
 *
 * 阈值依据：锁 30fps 的 P50 ≈ 33ms、锁 60fps ≈ 16ms，均远低于 500ms，
 * 不会被误伤；静置场景实测 ftP50 = 1000 / 2997ms（工单 FIX-01 表）。
 * ⚠️ 500ms 是工程约定（比 Android Vitals 的冻结帧门槛 700ms 更保守），
 * 不是行业标准值——Vitals 口径：16~700ms 慢帧、700ms~5s 冻结帧、>5s ANR。
 * 若要与 Vitals 直接对照，可改用 700ms（需同步离线用例 FIX-01 断言）。
 * 纯函数复现：[{ms:1000,c:1}] → jankyRatio=100% / hitch≈992ms/s，物理上
 * 「1 秒采样窗口里一帧卡了 3 秒」不可能，因此低活动拍的 9 个帧分布指标
 * 一律写 null，fps 保留实测值（「1 帧/秒」本身就是有用信息）。
 */
function isLowActivity(fps, ftP50) {
  return (typeof fps === 'number' && fps <= 2) ||
         (typeof ftP50 === 'number' && ftP50 > 500);
}

/**
 * 采集参数配置 → 采集器内部开关。
 * 与 renderer/metric-settings.js 的组定义保持一致；缺省一律采集（兼容旧调用）。
 */
const ANDROID_METRIC_KEYS = {
  fps: ['fps', 'jank', 'bigJank', 'smallJank', 'tinyJank', 'jankRate',
    'ftP50', 'ftP90', 'ftP95', 'ftP99', 'jankyRatio', 'hitchMsPerSec',
    'overrunP95', 'overrunP99', 'overrunMax', 'fpsMethod'],
  cpu: ['cpu', 'cpuCores', 'freqSource'],
  mem: ['mem'],  // FIX-07：threads/swapMB/ctxVoluntary/ctxNonvoluntary 随 mem 组开关
  // （它们挂在 data.mem 对象里，组开关只控制 mem 对象整体，无需单列键）
  net: ['net'],
  gpu: ['gpu'],
  temp: ['temperature', 'gpuTemp', 'cpuTemp', 'batteryTemp', 'skinTemp', 'tempSource',
    'thermalStatus', 'coolingName', 'coolingValue'],
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
  // meta / shellMs 是逐拍诊断元数据，不是性能指标，但要随样本传到报告层
  const keep = new Set(['timestamp', 'time', 'pid', 'meta', 'shellMs', 'tickMs', 'tickStartTs', 'dtMs']);
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
    /** @type {string|null} 被测应用 UID：网络按 UID 统计需要它（拿不到则回退整机口径） */
    this._uid = null;
    /** @type {object|null} 最近一次完整 dumpsys meminfo 的结果（PSS 家族降频复用的底本） */
    this._memFullCache = null;
    /** @type {number} 最近一次完整内存采样的时间戳（ms） */
    this._memFullAt = 0;
    /** @type {number[]} 最近若干拍的单轮采集耗时（ms），用于开销自监控 */
    this._tickMs = [];
    /** @type {number} 因历史上限被丢弃的采样点数（绝不静默） */
    this._droppedSamples = 0;
    /** 1.5 分段溢出：到上限写临时分片，停止时合并回报告，不再丢数据 */
    this.segments = new SegmentedHistory({
      max: MAX_HISTORY,
      chunkSize: 3600,
      log: (m) => this._log(m),
    });
    /** @type {boolean} 本轮是否已提示过采集开销偏高 */
    this._overheadWarned = false;
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
    this._uid = null;
    this._memFullCache = null;
    this._memFullAt = 0;
    this._displayProfile = null;
    this._tickMs = [];
    this._droppedSamples = 0;
    this._overheadWarned = false;
    // 新一轮采集用全新的分段账本，避免把上一轮临时分片混进本次报告
    this.segments = new SegmentedHistory({
      max: MAX_HISTORY, chunkSize: 3600, log: (m) => this._log(m),
    });
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
    // 网络口径：有 UID 才能按应用统计，否则只能回退整机（报告里会标注 scope）
    this._uid = (typeof uid === 'number' && uid > 0) ? uid : null;
    // 1.1 目标帧率取设备峰值刷新率：整轮只读一次，不进每拍的 adb 并发组。
    // 读不到就留 null，报告会明确标成「由 FPS 序列推断」，不会假装是设备值。
    try {
      const rr = await ADB.getDeviceRefreshRate(this.deviceId);
      this._displayProfile = (rr && rr.hz != null)
        ? { refreshRateHz: rr.hz, source: rr.source } : null;
      if (this._displayProfile) {
        this._log(`目标帧率来源：设备自报 ${rr.hz}Hz（${rr.source}）`, token);
      }
    } catch (_) { this._displayProfile = null; }
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
   * 采集开销自监控。
   * ETW / atrace 的公开资料都强调「观测者效应」：采集配置过重会把被测对象拖慢，
   * 测出来的卡顿其实是采集器造成的。这里用最近 120 拍的 P50 判定，
   * 超过采样周期的 30%（且绝对耗时 >200ms）就提示一次，不重复刷屏。
   */
  _recordTickCost(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return;
    this._tickMs.push(ms);
    if (this._tickMs.length > TICK_COST_WINDOW) this._tickMs.shift();
    if (this._overheadWarned) return;
    const a = assessTickCost(this._tickMs, this.intervalMs);
    if (!a.ready || !a.over) return;
    this._overheadWarned = true;
    this._log(
      `采集自身耗时偏高：P50 ${a.p50}ms（采样周期 ${this.intervalMs}ms，占比 `
      + `${Math.round(a.p50 / this.intervalMs * 100)}%）；可能影响被测应用，`
      + '建议降低采样频率或减少采集项'
    );
  }

  /** 本轮诊断信息：写报告元数据用（采集开销、历史截断、UID） */
  getDiagnostics() {
    return {
      tickMs: this._tickMs.slice(),
      droppedSamples: this._droppedSamples,
      intervalMs: this.intervalMs,
      uid: this._uid,
      displayProfile: this._displayProfile,
      segments: this.segments.diagnostics(),
    };
  }

  /**
   * 1.5 报告合并：把落盘分片与内存尾部按时间顺序拼成完整历史。
   * 必须在 stop() 之前调用（此后分片文件会被清理）。
   */
  drainHistory() {
    return this.segments.drain(this.history);
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

  /**
   * 内存通道分流：到点走完整 dumpsys meminfo（PSS 家族），其余拍子只读轻量
   * RSS / 整机水位，PSS 家族沿用上一次实测值并标 src:'full'。
   *
   * 为什么不是「每拍都测」：meminfo 遍历被测进程的 VMA 会持有 mm 锁，
   * 实测让被测应用帧间隔 P99 恶化 20ms（详见 MEM_FULL_REFRESH_MS 注释）。
   * 为什么不是「干脆不测 PSS」：总 PSS 是内存口径的主指标，报告与 Excel 都依赖它，
   * 所以保留但降频，并由报告侧注明「不是逐拍实测」，不静默伪装成每拍实测。
   */
  async _collectMem() {
    const now = Date.now();
    const dueFull = !this._memFullCache || (now - this._memFullAt >= MEM_FULL_REFRESH_MS);
    if (dueFull) {
      const full = await ADB.getMemInfo(this.deviceId, this.packageName, this._pid);
      // 完整采样失败（设备抖动）：继续用上一次底本，但不刷新时间戳，
      // 下一次 tick 会立刻重试，避免把「一次失败」放大成 5 秒空窗。
      if (full && full.totalPss != null) {
        this._memFullCache = full;
        this._memFullAt = now;
        // D-02（r4）：full 通道的命令本身就含 cat /proc/<pid>/status，
        // getMemInfo 已把 threads/swap/ctx 带出 —— 这里**透传**，不再置空。
        // 旧注释「dumpsys meminfo 没有这些字段」与事实相反（那是另一条命令），
        // 置空造成每 5 拍有 1 拍四项为 null、上下文切换速率曲线规律性断点。
        // 字段读不到时 getMemInfo 已给 null（未测到写 null 的约定不变）。
        return Object.assign({}, full, { src: 'full' });
      }
      if (this._memFullCache) {
        // 完整采样这拍失败了：PSS 沿用上次实测值，必须标 lite，
        // 否则 Excel 里这行看起来像「本拍实测」，口径失真。
        return Object.assign({}, this._memFullCache,
          { rss: full && full.rss, hwm: full && full.hwm, src: 'lite' });
      }
      return full;
    }
    const lite = await ADB.getMemInfoLite(this.deviceId, this._pid);
    const base = this._memFullCache || {};
    return Object.assign({}, base, {
      memTotalMB:     lite.memTotalMB     != null ? lite.memTotalMB     : (base.memTotalMB ?? null),
      memAvailableMB: lite.memAvailableMB != null ? lite.memAvailableMB : (base.memAvailableMB ?? null),
      rss: lite.rss,
      hwm: lite.hwm,
      // FIX-07：/proc/<pid>/status 现成字段（零额外 adb 开销）；读不到写 null
      threads:        lite.threads ?? null,
      swapMB:         lite.swapMB ?? null,
      ctxVoluntary:   lite.ctxVoluntary ?? null,
      ctxNonvoluntary: lite.ctxNonvoluntary ?? null,
      // PSS 来自上次实测，本拍只有 RSS/HWM 是新的
      src: 'lite',
    });
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
    // 采集开销自监控：从本轮第一个 adb 调用算到结果回来
    const tickStart = Date.now();
    // r3 遗留项闭环：长间隔阈值按实际采样周期推导（可配间隔 >3s 时跟随，不误杀）
    const staleGap = Math.max(3 * this.intervalMs, 3000);

    try {
      // 按采集参数只调用启用的采集项：被移除的参数完全不采（省 adb 开销）
      const jobs = [];
      if (mc.cpu)   jobs.push(['cpu',     ADB.getCpuSnapshot(this.deviceId, this._pid, staleGap)]);
      if (mc.mem)   jobs.push(['mem',     this._collectMem()]);
      if (mc.fps)   jobs.push(['fps',     ADB.getFps(this.deviceId, this.packageName, logFn, this.intervalMs,
        // FIX-17：上一拍实际周期（门闩跳拍 / 休眠时远大于配置值），首拍 null 走配置
        this._lastTickStart != null ? Math.max(1, tickStart - this._lastTickStart) : null)]);
      if (mc.net)   jobs.push(['net',     ADB.getNetStats(this.deviceId, this._uid, staleGap)]);
      if (mc.battery) jobs.push(['battery', ADB.getBatteryInfo(this.deviceId)]);
      // 采了电池就让 thermal 别再读一次 dumpsys battery（后面的兜底会复用这份结果）
      if (mc.temp)  jobs.push(['thermal', ADB.getThermalInfo(this.deviceId, { noBatteryRead: !!mc.battery })]);
      if (mc.gpu)   jobs.push(['gpu',     ADB.getGpuUsage(this.deviceId, staleGap)]);
      // 1.4 每个采集通道各记一份 shell 耗时：总耗时高时，能直接看出是哪一个
      // adb 命令拖慢了整拍（而不是只知道「这拍慢」）。
      const shellMs = {};
      const timed = jobs.map((j) => {
        const t0 = Date.now();
        return Promise.resolve(j[1]).finally(() => { shellMs[j[0]] = Date.now() - t0; });
      });
      const settled = await Promise.allSettled(timed);
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

      // getThermalInfo 返回 { temperature, tempSource, gpuTemp, cpuTemp, batteryTemp, skinTemp }
      // temperature = 机身/电池温度；cpuTemp / gpuTemp = 芯片结温，不可混用
      const thermalVal = val.thermal || {};
      const batVal = val.battery || {};
      const thermalMainRaw = typeof thermalVal.temperature === 'number' && thermalVal.temperature > 0
        ? thermalVal.temperature : null;
      const batTemp = typeof batVal.temperature === 'number' && batVal.temperature > 0
        ? batVal.temperature : null;
      // 机身温度兜底：thermal 三段（thermalservice / sysfs / 电池）都没取到时，
      // 复用同一 tick 已经采到的电池温度 —— 旧实现让 thermal 自己再跑一遍
      // dumpsys battery，同一条命令两次读数还可能差 0.1°C，两个字段互相矛盾。
      // 采不到时写 null（不是 0°C），展示层显示「--」。
      const thermalMain = thermalMainRaw != null ? thermalMainRaw : batTemp;
      const gpuTemp = typeof thermalVal.gpuTemp === 'number' ? thermalVal.gpuTemp : null;
      const cpuTemp = typeof thermalVal.cpuTemp === 'number' ? thermalVal.cpuTemp : null;
      const skinTemp = typeof thermalVal.skinTemp === 'number' ? thermalVal.skinTemp : null;
      const batteryTemp = typeof thermalVal.batteryTemp === 'number' ? thermalVal.batteryTemp : batTemp;
      const tempSource = typeof thermalVal.tempSource === 'string'
        ? thermalVal.tempSource
        : (thermalMain != null && thermalMain === batTemp ? 'battery' : null);
      // ADPF 节流信号（optimization 2.0 真机扫描落地）：Status>0 = 系统正在限频，
      // 掉帧归因时与温度曲线一起看。读不到写 null，不编 0。
      const thermalStatus = (mc.temp && typeof thermalVal.thermalStatus === 'number')
        ? thermalVal.thermalStatus : null;
      const coolingName = (mc.temp && typeof thermalVal.coolingName === 'string')
        ? thermalVal.coolingName : null;
      const coolingValue = (mc.temp && typeof thermalVal.coolingValue === 'number')
        ? thermalVal.coolingValue : null;

      // getFps 返回 { fps, jank, bigJank, smallJank, tinyJank, jankRate, method }。
      // 用 ?? 而不是 ||：gfxinfo-delta 等通道测不到卡顿分级时返回的是 null（未测量），
      // 旧写法 || 0 会把它折成「0 次卡顿」，把没测的事实伪装成测得零卡顿。
      const fpsData = val.fps || { fps: null, jank: null, bigJank: null, smallJank: null,
                                   tinyJank: null, jankRate: null, method: 'error' };
      const fps     = typeof fpsData === 'object' ? fpsData.fps     : fpsData;
      const jank    = typeof fpsData === 'object' ? (fpsData.jank    ?? null) : null;
      const bigJank = typeof fpsData === 'object' ? (fpsData.bigJank ?? null) : null;
      const smallJank = typeof fpsData === 'object' ? (fpsData.smallJank ?? null) : null;  // PerfDog 微小卡顿（≥84ms 档）
      const tinyJank  = typeof fpsData === 'object' ? (fpsData.tinyJank  ?? null) : null;  // PerfDog 极小卡顿（≥1.5×vsync 档）
      const jankRate  = typeof fpsData === 'object' ? (fpsData.jankRate  ?? null) : null;
      // 没取到帧数据（加载中 / 不在前台 / 首帧未就绪）→ 写 null，不写 0
      const fpsNoData = typeof fpsData === 'object'
        ? FPS_NO_DATA_METHODS.has(String(fpsData.method || ''))
        : false;

      const data = {
        timestamp:   Date.now(),
        time:        new Date().toLocaleTimeString(),
        pid:         this._pid,
      };
      const cpuSnap = val.cpu || {};
      if (mc.cpu) {
        data.cpu = { sysCpu: cpuSnap.sysCpu ?? null, procCpu: cpuSnap.procCpu ?? null };
        data.cpuCores = (cpuSnap.cores && typeof cpuSnap.cores === 'object')
          ? cpuSnap.cores : { usage: [], freq: [] };
        // FIX-14：频率来源（cpuinfo=实际运行频率 / scaling=governor 目标 / null=未读到）
        data.freqSource = cpuSnap.freqSource ?? null;
      }
      if (mc.mem)   data.mem = val.mem || { totalPss: null, nativeHeap: null, dalvikHeap: null };
      if (mc.fps) {
        if (fpsNoData) {
          // 无数据 ≠ 0 帧：写成 null，让曲线断开、统计跳过
          data.fps = null; data.jank = null; data.bigJank = null;
          data.smallJank = null; data.tinyJank = null; data.jankRate = null;
          for (const k of FRAME_STAT_KEYS) data[k] = null;
        } else {
          data.fps = fps; data.jank = jank; data.bigJank = bigJank;
          data.smallJank = smallJank; data.tinyJank = tinyJank; data.jankRate = jankRate;
          const fo = (fpsData && typeof fpsData === 'object') ? fpsData : {};
          for (const k of FRAME_STAT_KEYS) {
            data[k] = (typeof fo[k] === 'number' && isFinite(fo[k])) ? fo[k] : null;
          }
        }
        // 本拍的取帧通道（timestats / framestats / gfxinfo-delta / none…）。
        // 写进采样点才能让报告说清「这个 FPS 是怎么来的」，也才能统计通道命中率。
        data.fpsMethod = (fpsData && typeof fpsData === 'object' && fpsData.method)
          ? String(fpsData.method) : null;
      }
      // FIX-01（schema v4）：静置 / 低频渲染的单点兜底。
      // 「1 帧/秒」是真实测到的信息，fps 保留；但 1s 采样窗口里的一帧撑不起
      // 帧分布统计 —— 旧逻辑会算出 jankyRatio=100%、overrunMax≈1000ms 甚至
      // 3000ms（把两次采样间的静置时长当成一帧的耗时），物理上不可能。
      // 各取帧通道逐个判定必然漏（6 种 method），所以在 data 构造完成后
      // 统一兜底：只清 9 个帧分布指标，fps 保留，并显式标注 low-activity。
      // 与 no-frames（一帧都没产出 → fps 也写 null）是两种不同语义。
      if (mc.fps && !fpsNoData && isLowActivity(data.fps, data.ftP50)) {
        for (const k of FRAME_STAT_KEYS) data[k] = null;
        data.fpsMethod = 'low-activity';
      }
      if (mc.net) {
        data.net = val.net || { rxKBps: null, txKBps: null, netScope: null, netSource: null };
      }
      if (mc.battery) data.battery = val.battery || { level: null, voltage: null, temperature: null, currentNow: null, power: null };
      if (mc.temp) {
        data.temperature = thermalMain;
        data.gpuTemp = gpuTemp;          // GPU 结温；利用率读不到时报告页用它补位
        data.cpuTemp = cpuTemp;          // CPU 结温：供降频分析，不参与「机身温度」展示
        data.batteryTemp = batteryTemp;
        data.skinTemp = skinTemp;        // 厂商估算的外壳温度（SKIN），仅作参考
        data.tempSource = tempSource;    // battery | skin | body | board | die | null
        // ADPF 节流信号：thermalStatus 0~6（NONE~SHUTDOWN），
        // coolingXxx = 动作量最大的冷却设备（cpu_adaptive 等）
        data.thermalStatus = thermalStatus;
        data.coolingName = coolingName;
        data.coolingValue = coolingValue;
      }
      if (mc.gpu)   data.gpu = val.gpu ?? null; // null = 该机型未提供，报告页显示为无数据

      // 单轮采集耗时：既是「采集器有没有拖慢被测应用」的证据，
      // 也是解释「采样点变稀」的第一手材料
      data.tickMs = Date.now() - tickStart;
      data.shellMs = shellMs;
      // FIX-05：采样窗口起点。timestamp 是「采集结束」时刻；各指标读数横跨
      // [tickStartTs, timestamp] 整个窗口。报告层用两者可还原真实采样间隔
      // （不恒定，708~1575ms 实测），长采集时的卡顿定位不再被等距 category 轴拉偏。
      data.tickStartTs = tickStart;
      // FIX-13：与上一拍采样窗口起点的间隔。长间隔（休眠/跳拍）的拍，各瞬时
      // 指标会被通道层写 null（长窗口平均不冒充当前值），dtMs 让报告层能解释
      // 「这里为什么断了一截」。
      data.dtMs = this._lastTickStart != null ? tickStart - this._lastTickStart : null;
      this._lastTickStart = tickStart;
      // 1.3 逐拍溯源：四端共用 sample-meta 的同一形状，报告层据此聚合质量
      data.meta = SampleMeta.makeSampleMeta('android', data);

      // 1.5 到上限不再静默 shift()：最早一段落盘为临时分片，停止时合并回报告。
      // 只有写盘也失败时才真的丢，并且照样计数 + 提醒。
      this.segments.push(this.history, data);
      if (this.segments.droppedPoints > 0
        && (this.segments.droppedPoints === 1 || this.segments.droppedPoints % 1800 === 0)) {
        this._log(`分段写盘失败，已有 ${this.segments.droppedPoints} 个点无法落盘；`
          + '长时测试建议缩短单次时长');
      }
      this._droppedSamples = this.segments.droppedPoints;
      this._recordTickCost(data.tickMs);
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
// FIX-01：低活动判定纯函数（离线用例直接断言）
module.exports.isLowActivity = isLowActivity;
module.exports.FRAME_STAT_KEYS = FRAME_STAT_KEYS;
// 供单测按比例缩小验证熔断逻辑（生产走默认值）
module.exports.__timings = TIMINGS;
// 1.4 注入慢 shell 的纯函数守卫
module.exports.assessTickCost = assessTickCost;
module.exports.MAX_HISTORY = MAX_HISTORY;
