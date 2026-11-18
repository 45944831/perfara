'use strict';

/**
 * 优化方案 2.1 —— Perfetto / simpleperf 旁路取证（核心模块，不含接线）。
 *
 * 定位：主采集链之外的「旁路」。低谷命中（见 trough-detector.push 返回的
 * { fps, target, ts, reason }）或用户手动触发时，抓一段 3~30s 的系统级 trace
 * 落到报告目录，供事后分析掉帧根因。它永远不参与主采集的判定，也绝不能把
 * 任何异常抛回主采集链：所有错误一律吞掉并返回 { ok:false, reason }。
 *
 * 设计要点：
 *   - 默认完全关闭（enabled=false）。未开启时 capture() 直接短路，不拉起任何进程、
 *     不占端口、不注册定时器、不读文件、不写文件，零开销。
 *   - 一切设备命令都经「注入的 runAdb」执行，本模块不直接拉起子进程、不依赖真机，
 *     也不 require electron。离线测试用假 runner 即可驱动全流程。
 *   - Android 12+（SDK>=31）优先 perfetto；perfetto 抓失败 / 低版本回退 simpleperf；
 *     再失败静默降级。
 *   - 同一时刻只允许一段 trace（第二次触发返回 busy），cancel/dispose 会杀掉在途进程。
 *   - 设备端临时文件零残留：pull 之后（以及取消 / 失败）都会 rm 掉
 *     /data/local/tmp 下的远端产物，避免反复取证塞满设备临时分区。
 *
 * 产物扩展名：perfetto -> .perfetto-trace；simpleperf -> perf.data。
 * 这两类产物体积较大、只用于离线分析，打包排除规则由接线方在发布脚本里追加，
 * 本模块只负责生成与登记，不负责打包。
 *
 * 依赖注入接口（构造参数，均为可选，见 createTraceCapture）：
 *   runAdb(args, timeoutMs) -> Promise<string>  设备命令；resolve=stdout，reject=失败/超时。
 *                                             对应 adb.js 底层 adb(args, timeout) 的形状。
 *                                             返回值若挂有 .kill() 亦可被 cancel 调用。
 *   cancelInflight()        -> void            杀掉在途子进程，对应 adb.js cancelAllInflight()。
 *   now()                   -> number         时钟，默认 Date.now。
 *   fs                      -> object         文件系统替身（需 mkdirSync），缺省惰性用内置 fs。
 *   path                    -> object         路径替身（需 resolve/sep/join），缺省惰性用内置 path。
 *   log(msg)                -> void           诊断日志回调，风格同 collector._log（中文方括号前缀）。
 *
 * 语法：ES2018（async/await + Promise.allSettled 运行时 API），无第三方依赖。
 */

// 内置模块惰性加载：默认关闭路径下完全不触碰文件系统/路径运算。
let _builtinFs = null;
let _builtinPath = null;
function builtinFs() {
  if (!_builtinFs) _builtinFs = require('fs');
  return _builtinFs;
}
function builtinPath() {
  if (!_builtinPath) _builtinPath = require('path');
  return _builtinPath;
}

/** 采集口径默认值。deviceId 为泛化代号，仅用于 adb -s 参数，绝不写进产物文件名。 */
const DEFAULTS = {
  enabled: false,
  deviceId: 'generic-device',
  reportDir: '',
  maxRecords: 20,
  defaultDurationSec: 10,
  minDurationSec: 3,
  maxDurationSec: 30,
  perfettoMinSdk: 31, // Android 12
};

/**
 * SurfaceFlinger FrameTimeline 的 jankType 语义。
 * perfetto 配置里启用了 android.surfaceflinger.frametimeline 数据源，其帧记录会带
 * jankType 位；下面把常见取值翻成中文，供报告页解释「为什么这一帧算卡顿」。
 * 位含义参考 AOSP FrameTimeline：应用侧 / SF CPU / SF GPU / 缓冲堆积 / 预测偏差等。
 */
const JANK_TYPE_SEMANTICS = {
  None: '无卡顿，帧在 vsync 截止前送达',
  AppDeadlineMissed: '应用侧未在 vsync 截止前完成渲染与提交',
  SurfaceFlingerCpuDeadlineMissed: 'SurfaceFlinger CPU 合成超时',
  SurfaceFlingerGpuDeadlineMissed: 'SurfaceFlinger GPU / HWC 合成超时',
  BufferStuffing: '应用连续提交缓冲导致队列堆积（生产过快）',
  BufferStarvation: '缓冲不足，消费端拿不到新帧',
  SurfaceFlingerScheduling: 'SurfaceFlinger 调度延迟（合成线程未被及时唤醒）',
  PredictionError: '帧时长预测偏差导致调度错位',
  DisplayHAL: '显示 HAL 层延迟',
  DroppedFrame: '帧被丢弃',
  Unknown: '未归类的卡顿',
};

/**
 * gfxinfo framestats `FLAGS` 列 → jankType 名称。
 *
 * 低 5 位是 HWUI `FrameInfo.h` 的 JankType（Android 8 起稳定，语义与
 * FrameTimeline 一致）；32 以上是 Android 12 FrameTimeline 的扩展位。
 * 真机只观察到 0 / 1（AppDeadlineMissed），扩展位按 AOSP
 * `libgui/FrameTimeline.h` 的位序登记 —— 未观测到的位不臆测语义，
 * 命中时按表给名，超出表范围的残余位统一记 Unknown，绝不静默丢掉。
 */
const JANK_FLAG_BITS = [
  [1, 'AppDeadlineMissed'],
  [2, 'SurfaceFlingerCpuDeadlineMissed'],
  [4, 'SurfaceFlingerGpuDeadlineMissed'],
  [8, 'BufferStuffing'],
  [16, 'Unknown'],
  [32, 'SurfaceFlingerScheduling'],
  [64, 'PredictionError'],
  [128, 'DisplayHAL'],
  [256, 'DroppedFrame'],
];
const JANK_FLAG_KNOWN_MASK = JANK_FLAG_BITS.reduce((a, [bit]) => a | bit, 0);

/**
 * 归因要求的最小帧数。
 *
 * 真机实测：`dumpsys gfxinfo <pkg> framestats` 每次调用都会重置帧缓冲，
 * 走 HWUI 窗口渲染的应用一次能给到几十~120 帧；而自绘 / SurfaceView 类应用
 * （游戏、部分 IM 的 Web 容器）只会给 0~2 帧。用 1 帧算出来的「100% 卡顿」
 * 在物理上无从解释，不如如实不给结论。
 */
const JANK_MIN_FRAMES = 8;

/**
 * 最小 perfetto 文本配置（单行，避免设备端 sh 把换行当命令分隔符）。
 * 含 android.surfaceflinger.frametimeline：trace 文件里会带每一帧的 timeline 片，
 * 供离线分析工具（ui.perfetto.dev）直接看「这一帧等的是谁」。
 * 注意：jankType 归因**不从 trace 文件里解析**（proto 二进制，本模块不引 trace_processor），
 * 而是另外读一次 gfxinfo framestats 的 FLAGS 位掩码，见 countJankTypes。
 * 时长由命令行 -t <sec>s 控制，配置里不写死。
 */
const PERFETTO_CONFIG =
  'buffers: { size_kb: 8192 fill_policy: RING_BUFFER } ' +
  'data_sources: { config { name: "linux.ftrace" ftrace_config { ' +
  'ftrace_events: "sched/sched_switch" atrace_categories: "gfx" ' +
  'atrace_categories: "view" } } } ' +
  'data_sources: { config { name: "android.surfaceflinger.frametimeline" } }';

function clampDurationSec(n, dflt) {
  const base = (dflt == null ? DEFAULTS.defaultDurationSec : dflt);
  const v = Number(n);
  const raw = (!Number.isFinite(v) || v <= 0) ? base : Math.round(v);
  const lo = DEFAULTS.minDurationSec;
  const hi = DEFAULTS.maxDurationSec;
  return Math.min(hi, Math.max(lo, raw | 0));
}

/** 只保留安全文件名字符，杜绝 ../ 与设备信息混入产物名。 */
function sanitizeSegment(s) {
  return String(s == null ? '' : s).replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * 把报告目录与产物名拼成绝对路径，并校验不越出报告目录。
 * @returns {{ok:boolean, path?:string, reason?:string}}
 */
function resolveLocal(reportDir, filename, P) {
  const p = P || builtinPath();
  if (!reportDir) return { ok: false, reason: 'no-report-dir' };
  if (sanitizeSegment(filename) !== String(filename)) {
    return { ok: false, reason: 'unsafe-name' };
  }
  const base = p.resolve(reportDir);
  const full = p.resolve(base, String(filename));
  const sep = p.sep || '/';
  const inBase = full === base
    || full.indexOf(base + sep) === 0
    || full.indexOf(base + '/') === 0;
  if (!inBase) return { ok: false, reason: 'unsafe-path' };
  return { ok: true, path: full };
}

/**
 * 把 FLAGS 位掩码数组统计成 jankType 计数。
 *
 * ⚠️ 这里替换掉了旧实现的一段**假数据链路**：旧代码把 `perfetto --txt -c - -o <file>`
 * 的 stdout 当 trace 摘要去正则匹配 jankType —— 而 perfetto 把 trace 写进文件、
 * stdout 只有零星日志，那段正则永远匹配不到，`jankTypes` 字段实际上从未产出过。
 * 现在归因只认 gfxinfo framestats 的 FLAGS（FrameTimeline 真实位掩码），
 * 拿不到就如实留空，不再「看起来有能力、实际永远为空」。
 *
 * @param {number[]} flags 每帧一个位掩码
 * @returns {{total:number, janky:number, counts:Object, types:string[]}}
 */
function countJankTypes(flags) {
  const list = Array.isArray(flags) ? flags : [];
  const counts = Object.create(null);
  let janky = 0;
  for (let i = 0; i < list.length; i++) {
    const v = Number(list[i]) | 0;
    if (!v) continue;
    janky += 1;
    let matched = false;
    for (let j = 0; j < JANK_FLAG_BITS.length; j++) {
      const bit = JANK_FLAG_BITS[j][0];
      if (v & bit) {
        const name = JANK_FLAG_BITS[j][1];
        counts[name] = (counts[name] || 0) + 1;
        matched = true;
      }
    }
    if (!matched || (v & ~JANK_FLAG_KNOWN_MASK) !== 0) {
      counts.Unknown = (counts.Unknown || 0) + 1;
    }
  }
  // 按位序输出，保证同一份帧序列在不同运行里字段顺序一致（报告/测试可对比）
  const types = [];
  for (let j = 0; j < JANK_FLAG_BITS.length; j++) {
    const name = JANK_FLAG_BITS[j][1];
    if (counts[name]) types.push(name);
  }
  return { total: list.length, janky: janky, counts: Object.assign({}, counts), types: types };
}

/** 把 jankType 数组翻成 名->中文说明 的映射，供报告页展示。 */
function describeJankTypes(types) {
  const out = {};
  const list = Array.isArray(types) ? types : [];
  for (let i = 0; i < list.length; i++) {
    out[list[i]] = JANK_TYPE_SEMANTICS[list[i]] || '未归类';
  }
  return out;
}

function errText(e) {
  if (e && e.message) return String(e.message);
  return String(e == null ? '' : e);
}

/** 设备侧 shell 单引号安全包裹（同 adb.js shellArg 口径）。 */
function sq(v) {
  return "'" + String(v == null ? '' : v).replace(/'/g, "'\\''") + "'";
}

function stampOf(ms) {
  const d = new Date(Number(ms) || 0);
  const p2 = (n) => String(n).padStart(2, '0');
  return String(d.getUTCFullYear())
    + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) + '-'
    + p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + p2(d.getUTCSeconds());
}

class TraceCapture {
  constructor(options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    this._runAdb = typeof o.runAdb === 'function' ? o.runAdb : null;
    this._cancelInflight = typeof o.cancelInflight === 'function' ? o.cancelInflight : null;
    // 帧归因数据源（由接线方注入，通常是 adb.getJankSnapshot）。不注入 = 不做归因，
    // 绝不退化成「从 trace 文本里猜」——那条路永远是空的（见 countJankTypes 注释）。
    this._snapshotJank = typeof o.snapshotJank === 'function' ? o.snapshotJank : null;
    this._packageName = String(o.packageName || '');
    this._now = typeof o.now === 'function' ? o.now : Date.now;
    this._fsImpl = o.fs || null;
    this._pImpl = o.path || null;
    this._log = typeof o.log === 'function' ? o.log : function () {};

    this._enabled = !!o.enabled;
    this._deviceId = String(o.deviceId || DEFAULTS.deviceId);
    this._reportDir = String(o.reportDir || '');
    this._maxRecords = Math.max(1, o.maxRecords | 0);
    this._defaultDurationSec = clampDurationSec(o.defaultDurationSec, DEFAULTS.defaultDurationSec);

    this._records = [];
    this._seq = 0;
    this._tokenSeq = 0;
    this._running = false;
    this._activeToken = null;
    this._disposed = false;
    this._cancelledTokens = new Set();
    this._activeProcs = new Set();

    this._support = null;
    this._supportPromise = null;
    this._diag = {
      totalCaptures: 0,
      okCount: 0,
      failCount: 0,
      lastReason: null,
      lastError: null,
    };
  }

  _fs() { return this._fsImpl || builtinFs(); }
  _path() { return this._pImpl || builtinPath(); }

  enable() {
    if (this._disposed) return false;
    this._enabled = true;
    this._log('[旁路取证] 已启用');
    return true;
  }

  disable() {
    this._enabled = false;
    this._log('[旁路取证] 已停用（在途抓取不受影响）');
    return true;
  }

  setEnabled(v) { return v ? this.enable() : this.disable(); }
  isEnabled() { return this._enabled; }
  isRunning() { return this._running; }

  /** 被测包名：帧归因要按包读 gfxinfo framestats（切换应用时由接线方更新）。 */
  setPackageName(p) {
    this._packageName = String(p || '');
    return this._packageName;
  }

  /**
   * 读一次帧归因快照。
   *
   * 数据源由注入方决定，本模块只认两种载荷：
   *   { counts: {AppDeadlineMissed: 5, _frames: 60, _total: 5} }  —— timestats 差分（首选，零额外 adb）
   *   { flags: [0,1,0,...] }                                      —— gfxinfo framestats 位掩码（兜底）
   *
   * 任何失败（未注入 / 通道冲突 / 无帧 / 命令失败 / 帧数太少）都返回 null，
   * 由 capture() 如实不写 jank 字段 —— 这个模块的约定是「宁缺勿假」。
   */
  async _readJank() {
    if (!this._snapshotJank || !this._packageName) return null;
    try {
      const r = await this._snapshotJank(this._packageName);
      if (!r || r.ok !== true) return null;

      let source = String(r.source || 'gfxinfo-framestats');
      let total = null;
      let janky = null;
      let counts = null;

      if (r.counts && typeof r.counts === 'object') {
        // timestats 差分载荷：下划线前缀是元数据（窗口帧数 / 卡顿帧数），不当类型渲染
        total = typeof r.counts._frames === 'number' ? r.counts._frames : null;
        janky = typeof r.counts._total === 'number' ? r.counts._total : null;
        counts = Object.create(null);
        for (const k of Object.keys(r.counts)) {
          if (k.charAt(0) === '_') continue;
          const v = Number(r.counts[k]);
          if (Number.isFinite(v) && v > 0) counts[k] = v;
        }
        counts = Object.assign({}, counts);
      } else if (Array.isArray(r.flags) && r.flags.length) {
        const c = countJankTypes(r.flags);
        total = c.total;
        janky = c.janky;
        counts = c.counts;
      } else {
        return null;
      }

      // 帧数太少不下结论：见 JANK_MIN_FRAMES（自绘应用只给 0~2 帧）
      if (total != null && total < JANK_MIN_FRAMES) {
        this._log('[旁路取证] 帧归因跳过：本窗口只有 ' + total + ' 帧（少于 '
          + JANK_MIN_FRAMES + ' 帧，样本不足以说明卡顿构成）');
        return null;
      }

      // 类型按固定位序输出，保证不同来源/不同运行的字段顺序一致
      const order = JANK_FLAG_BITS.map(([, name]) => name);
      const types = Object.keys(counts).sort((a, b) => {
        const ia = order.indexOf(a);
        const ib = order.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      return {
        source: source,
        total: total,
        janky: janky == null ? null : janky,
        counts: counts,
        types: types,
      };
    } catch (_) {
      return null;
    }
  }

  /** 轻量能力探测（只读）；结果缓存，重复调用不再跑探测命令。 */
  isSupported() {
    return this._probeSupport().then((r) => ({
      supported: r.supported,
      backend: r.backend,
      sdkInt: r.sdkInt,
      perfetto: r.perfetto,
      simpleperf: r.simpleperf,
      reason: r.reason,
      cached: true,
    }));
  }

  clearSupportCache() {
    this._support = null;
    this._supportPromise = null;
  }

  _isCancelled(token) {
    return this._disposed || this._cancelledTokens.has(token);
  }

  _callAdb(args, timeoutMs) {
    let raw;
    try {
      raw = this._runAdb(args, timeoutMs);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(errText(e)));
    }
    const promise = (raw && typeof raw.then === 'function') ? raw : Promise.resolve(raw);
    this._activeProcs.add(promise);
    const cleanup = () => this._activeProcs.delete(promise);
    promise.then(cleanup, cleanup);
    return promise;
  }

  _probeSupport() {
    if (this._support) return Promise.resolve(this._support);
    if (this._supportPromise) return this._supportPromise;
    this._supportPromise = this._detect().then((r) => {
      this._support = r;
      this._supportPromise = null;
      return r;
    });
    return this._supportPromise;
  }

  async _detect() {
    if (typeof this._runAdb !== 'function') {
      return {
        supported: false, backend: null, sdkInt: null,
        perfetto: false, simpleperf: false,
        reason: 'no-runner', checkedAt: this._now(),
      };
    }
    const shellArgs = (cmd) => ['-s', this._deviceId, 'shell', cmd];
    // 三条只读探测并发跑，任一失败都不影响其它（旁路语义：绝不因探测抛错）。
    const settled = await Promise.allSettled([
      this._callAdb(shellArgs('getprop ro.build.version.sdk'), 4000),
      this._callAdb(shellArgs('command -v perfetto'), 4000),
      this._callAdb(shellArgs('command -v simpleperf'), 4000),
    ]);
    const sdk = settled[0].status === 'fulfilled'
      ? parseInt(String(settled[0].value == null ? '' : settled[0].value).trim(), 10)
      : NaN;
    const sdkInt = Number.isFinite(sdk) ? sdk : null;
    const perfetto = settled[1].status === 'fulfilled'
      && String(settled[1].value == null ? '' : settled[1].value).trim().length > 0;
    const simpleperf = settled[2].status === 'fulfilled'
      && String(settled[2].value == null ? '' : settled[2].value).trim().length > 0;

    let backend = null;
    const lowVersion = (sdkInt != null && sdkInt < DEFAULTS.perfettoMinSdk);
    if (simpleperf && (!perfetto || lowVersion)) backend = 'simpleperf';
    else if (perfetto) backend = 'perfetto';
    else if (simpleperf) backend = 'simpleperf';

    const supported = backend != null;
    const result = {
      supported: supported,
      backend: backend,
      sdkInt: sdkInt,
      perfetto: perfetto,
      simpleperf: simpleperf,
      reason: supported ? 'ok' : 'no-backend',
      checkedAt: this._now(),
    };
    this._log('[旁路取证] 能力探测 sdk=' + sdkInt + ' perfetto=' + perfetto
      + ' simpleperf=' + simpleperf + ' backend=' + backend);
    return result;
  }

  _stem(token) {
    return 'perfara_trace_' + stampOf(this._now()) + '_' + token;
  }

  _localName(kind, token) {
    const stem = stampOf(this._now()) + '_' + (++this._seq);
    if (kind === 'perfetto') return 'perfetto_' + stem + '.perfetto-trace';
    return 'simpleperf_' + stem + '.perf.data';
  }

  async _grab(kind, sec, token) {
    const stem = this._stem(token);
    let args;
    let remote;
    let cleanPath; // 设备端要清理的目标（perfetto=trace 文件；simpleperf=mkdir 的目录）
    let timeout;
    try {
      if (kind === 'perfetto') {
        // ⚠️ 输出必须落 /data/misc/perfetto-traces/（perfetto_traces_data_file 上下文）：
        // 写 /data/local/tmp 会被 SELinux 拒绝（真机实测 errno 13 Permission denied）——
        // shell 用户 touch 能写，但 perfetto 进程的策略只放行官方 traces 目录。
        remote = '/data/misc/perfetto-traces/' + stem + '.perfetto-trace';
        cleanPath = remote;
        // ⚠️ 时长必须写进 config 的 duration_ms：perfetto 禁止 -c 与 -t/--time 同用
        //（真机实测 perfetto_cmd.cc:587 "Cannot specify both -c/--config and --time"）。
        const config = 'duration_ms: ' + Math.round(sec * 1000) + ' ' + PERFETTO_CONFIG;
        const cmd = 'printf \'%s\' ' + sq(config)
          + ' | perfetto --txt -c - -o ' + sq(remote);
        args = ['-s', this._deviceId, 'shell', cmd];
        timeout = (sec + 8) * 1000;
      } else {
        const dir = '/data/local/tmp/' + stem;
        remote = dir + '/perf.data';
        cleanPath = dir; // rm -f 删不掉 mkdir 出来的目录（真机实测残留），要 rm -rf 整个目录
        const cmd = 'mkdir -p ' + sq(dir)
          + ' && simpleperf record -o ' + sq(remote) + ' --duration ' + sec + ' -a';
        args = ['-s', this._deviceId, 'shell', cmd];
        timeout = (sec + 12) * 1000;
      }
      this._log('[旁路取证] 尝试 ' + kind + '（' + sec + 's）');
      // 不再收集 stdout：perfetto / simpleperf 都把产物写进 -o 指定的文件，
      // stdout 只有零星日志。旧实现拿它当 trace 摘要去正则找 jankType，
      // 永远匹配不到（假链路），归因已改为 gfxinfo framestats 的真实位掩码。
      await this._callAdb(args, timeout);
      if (this._isCancelled(token)) return { ok: false, error: 'cancelled', remote: remote, cleanPath: cleanPath };
      return { ok: true, kind: kind, remote: remote, cleanPath: cleanPath };
    } catch (e) {
      this._log('[旁路取证] ' + kind + ' 失败，准备降级');
      return { ok: false, error: errText(e), remote: remote, cleanPath: cleanPath };
    }
  }

  /**
   * 清掉设备端临时 trace：pull 完成、失败、取消后都要调用。
   * 一段 10s 的 perfetto trace 约 1~5MB，不清理的话反复取证会把
   * /data/local/tmp 塞满（真机复测发现的残留缺陷）。用 rm -rf：
   * simpleperf 的清理目标是 mkdir 出来的目录，rm -f 删不掉。
   * 失败静默，不影响主流程。
   */
  _cleanupRemote(cleanPath) {
    if (!cleanPath) return;
    this._callAdb(['-s', this._deviceId, 'shell', 'rm -rf ' + sq(cleanPath)], 8000)
      .catch(() => {});
  }

  async _pull(grabbed, token) {
    const filename = this._localName(grabbed.kind, token);
    const resolved = resolveLocal(this._reportDir, filename, this._path());
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    try {
      const F = this._fs();
      if (F && typeof F.mkdirSync === 'function' && this._reportDir) {
        F.mkdirSync(this._reportDir, { recursive: true });
      }
    } catch (e) {
      return { ok: false, reason: 'fs-mkdir-failed' };
    }
    try {
      await this._callAdb(
        ['-s', this._deviceId, 'pull', grabbed.remote, resolved.path], 30000);
    } catch (e) {
      return { ok: false, reason: 'pull-failed' };
    }
    if (this._isCancelled(token)) return { ok: false, reason: 'cancelled' };
    return { ok: true, path: resolved.path };
  }

  _fail(reason) {
    this._diag.failCount += 1;
    this._diag.lastReason = reason;
    this._log('[旁路取证] 未取证 reason=' + reason);
    return { ok: false, reason: reason };
  }

  _record(result, trigger, sup) {
    const rec = Object.assign({}, result, {
      ts: this._now(),
      trigger: trigger,
      sdkInt: sup.sdkInt == null ? null : sup.sdkInt,
      backend: sup.backend,
    });
    this._records.push(rec);
    while (this._records.length > this._maxRecords) this._records.shift();
  }

  /**
   * 触发一次短 trace（手动 / 自动低谷命中都走这里）。
   * @param {object} [opts] { durationSec, source:'manual'|'auto', reason, fps, target, ts, overrunMax }
   * @returns {Promise<{ok:boolean,path?:string,kind?:string,durationMs?:number,
   *   jankTypes?:string[],jankCounts?:Object,jankFrames?:{total:number,janky:number},
   *   jankSource?:string,reason?:string}>}
   *   永不抛异常；失败一律 { ok:false, reason }。
   *   帧归因（jankTypes/jankCounts）只在注入的 snapshotJank 真的给出帧掩码时出现。
   */
  async capture(opts) {
    if (this._disposed) return { ok: false, reason: 'disposed' };
    if (!this._enabled) return { ok: false, reason: 'disabled' };
    if (this._running) return { ok: false, reason: 'busy' };

    const o = opts || {};
    const sec = clampDurationSec(o.durationSec, this._defaultDurationSec);
    const token = ++this._tokenSeq;
    const started = this._now();
    const trigger = {
      source: o.source || (o.reason ? 'auto' : 'manual'),
      reason: o.reason || null,
      fps: o.fps == null ? null : o.fps,
      target: o.target == null ? null : o.target,
      ts: o.ts == null ? null : o.ts,
      overrunMax: o.overrunMax == null ? null : o.overrunMax,
    };

    this._running = true;
    this._activeToken = token;
    this._diag.totalCaptures += 1;
    const remotes = []; // 本次尝试过的设备端清理目标（文件或目录），finally 统一 rm -rf
    try {
      const sup = await this._probeSupport();
      if (this._isCancelled(token)) return this._fail('cancelled');
      if (!sup.supported) return this._fail('unsupported');

      // 帧归因必须取在抓 trace **之前**：它回答的是「触发这一刻为什么卡」，
      // 抓完 10s 后 gfxinfo 的帧窗口早被后续帧刷掉了。
      const jank = await this._readJank();
      if (this._isCancelled(token)) return this._fail('cancelled');

      const order = sup.backend === 'simpleperf'
        ? ['simpleperf'] : ['perfetto', 'simpleperf'];
      let grabbed = null;
      for (let i = 0; i < order.length; i++) {
        if (this._isCancelled(token)) return this._fail('cancelled');
        const attempt = await this._grab(order[i], sec, token);
        if (attempt.cleanPath) remotes.push(attempt.cleanPath);
        if (this._isCancelled(token)) return this._fail('cancelled');
        if (attempt.ok) { grabbed = attempt; break; }
        this._diag.lastError = attempt.error || null;
      }
      if (!grabbed) return this._fail('capture-failed');

      const pulled = await this._pull(grabbed, token);
      if (this._isCancelled(token)) return this._fail('cancelled');
      if (!pulled.ok) return this._fail(pulled.reason);

      const durationMs = Math.max(0, this._now() - started);
      const result = {
        ok: true,
        path: pulled.path,
        kind: grabbed.kind,
        durationMs: durationMs,
      };
      if (jank) {
        // 有归因才写字段：拿不到就一个字段都不写，报告页不会出现空块。
        result.jankSource = jank.source;
        result.jankFrames = { total: jank.total, janky: jank.janky };
        if (jank.types.length) {
          result.jankTypes = jank.types;
          result.jankCounts = jank.counts;
          result.jankTypeSemantics = describeJankTypes(jank.types);
        }
      }
      this._record(result, trigger, sup);
      this._diag.okCount += 1;
      this._diag.lastReason = null;
      this._log('[旁路取证] 抓取完成 kind=' + grabbed.kind
        + ' durationMs=' + durationMs + ' path=' + pulled.path);
      return result;
    } catch (e) {
      this._diag.lastError = errText(e);
      return this._fail('exception');
    } finally {
      // 无论成功 / 失败 / 取消：本轮碰过的设备端临时文件一律收掉（见 _cleanupRemote）。
      for (let i = 0; i < remotes.length; i++) this._cleanupRemote(remotes[i]);
      this._running = false;
      if (this._activeToken === token) this._activeToken = null;
      this._cancelledTokens.delete(token);
    }
  }

  /** 取消在途 trace：置取消标志 + 杀掉在途子进程，不留下孤儿。 */
  cancel() {
    if (!this._running) return false;
    const token = this._activeToken;
    if (token != null) this._cancelledTokens.add(token);
    for (const p of Array.from(this._activeProcs)) {
      try {
        if (p && typeof p.kill === 'function') p.kill();
      } catch (_) {}
    }
    if (typeof this._cancelInflight === 'function') {
      try { this._cancelInflight(); } catch (_) {}
    }
    this._running = false; // 立即释放 busy，不等在途 Promise 收尾
    this._log('[旁路取证] 已取消在途抓取');
    return true;
  }

  /** 供报告页读取：最近 N 条取证记录（副本，外部修改不影响内部）。 */
  list() {
    return this._records.map((r) => Object.assign({}, r));
  }

  /** 供报告页 / 诊断面板读取的汇总信息。 */
  getDiagnostics() {
    const s = this._support;
    return {
      enabled: this._enabled,
      running: this._running,
      disposed: this._disposed,
      supported: s ? s.supported : null,
      backend: s ? s.backend : null,
      sdkInt: s ? s.sdkInt : null,
      inflightProcs: this._activeProcs.size,
      records: this._records.length,
      maxRecords: this._maxRecords,
      totalCaptures: this._diag.totalCaptures,
      okCount: this._diag.okCount,
      failCount: this._diag.failCount,
      lastReason: this._diag.lastReason,
      lastError: this._diag.lastError,
    };
  }

  /** 释放：取消在途、清空记录与缓存，之后 capture 一律返回 disposed。 */
  dispose() {
    if (this._disposed) return;
    this.cancel();
    this._enabled = false;
    this._disposed = true;
    this._records.length = 0;
    this._activeProcs.clear();
    this.clearSupportCache();
    this._log('[旁路取证] 已释放');
  }
}

function createTraceCapture(options) {
  return new TraceCapture(options);
}

module.exports = {
  TraceCapture,
  createTraceCapture,
  countJankTypes,
  describeJankTypes,
  JANK_TYPE_SEMANTICS,
  JANK_FLAG_BITS,
  JANK_MIN_FRAMES,
  PERFETTO_CONFIG,
  sanitizeSegment,
  resolveLocal,
  clampDurationSec,
  DEFAULTS,
};
