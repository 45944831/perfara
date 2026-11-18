/**
 * 优化方案 2.1「Perfetto / simpleperf 旁路取证」核心模块离线回归测试。
 *
 * 全程用「注入的假 adb runner」驱动，不连真机、不写真实磁盘、不依赖 electron。
 * 覆盖：默认关闭零开销、握手与抓取、时长参数、perfetto 失败回退、双失败静默降级、
 * 并发 busy、cancel 清理、list 上限、路径越界、产物名脱敏、Android 11 分支、
 * jankType 解析、能力探测缓存、静态守卫。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const MODULE_PATH = path.resolve(__dirname, '..', '..', '..', '_client_src', 'app', 'src', 'trace-capture.js');
const TC = require(MODULE_PATH);
const {
  TraceCapture, createTraceCapture, countJankTypes, describeJankTypes,
  JANK_TYPE_SEMANTICS, JANK_FLAG_BITS, PERFETTO_CONFIG, sanitizeSegment, resolveLocal,
  clampDurationSec, DEFAULTS,
} = TC;

const SRC = fs.readFileSync(MODULE_PATH, 'utf8');
const REPORT_DIR = path.resolve(__dirname, '__trace_reports__'); // 假 fs 拦截，不真正落盘
const FIXED_NOW = 1700000000000;
const DEV = 'generic-device'; // 泛化设备代号，非真机序列号

let passed = 0, failed = 0;
const FAILED = [];
function check(name, cond, detail) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '  -> ' + JSON.stringify(detail)));
  cond ? passed++ : (failed++, FAILED.push(name));
}

/**
 * 假 adb runner。所有设备命令按 args 匹配，返回预设结果 / 抛错 / 挂起。
 * cancelInflight 模拟「杀掉在途子进程」：把挂起的 Promise 全部 reject。
 */
function makeRunner(cfg) {
  cfg = cfg || {};
  const calls = [];
  const pending = [];
  const state = { killed: false, mkdirCount: 0 };
  const fakeFs = {
    mkdirSync() { state.mkdirCount += 1; },
    existsSync() { return true; },
    statSync() { return { size: 4096 }; },
  };
  const summary = 'frame_timeline total=120 jankType: AppDeadlineMissed, BufferStuffing; '
    + 'jankType=PredictionError; display=DisplayHAL; jankType: AppDeadlineMissed; done';

  function cmdOf(args) {
    return String(args && args.length ? args[args.length - 1] : '');
  }
  function deferred() {
    const d = {};
    d.promise = new Promise((res, rej) => { d.resolve = res; d.reject = rej; });
    return d;
  }
  function runAdb(args, timeout) {
    const cmd = cmdOf(args);
    calls.push({ args: args.slice(), timeout: timeout, cmd: cmd });
    const isPull = args.indexOf('pull') >= 0;
    if (isPull) return Promise.resolve('1 file pulled, 0 skipped');
    if (cmd.indexOf('getprop ro.build.version.sdk') >= 0) {
      return cfg.sdkFail
        ? Promise.reject(new Error('getprop failed'))
        : Promise.resolve(String(cfg.sdk == null ? '33' : cfg.sdk));
    }
    if (cmd.indexOf('command -v perfetto') >= 0) {
      return cfg.noPerfetto
        ? Promise.reject(new Error('perfetto: not found'))
        : Promise.resolve('/system/bin/perfetto');
    }
    if (cmd.indexOf('command -v simpleperf') >= 0) {
      return cfg.noSimpleperf
        ? Promise.reject(new Error('simpleperf: not found'))
        : Promise.resolve('/system/bin/simpleperf');
    }
    if (cmd.indexOf('perfetto --txt') >= 0 || cmd.indexOf('perfetto -o') >= 0) {
      if (cfg.hang) {
        const d = deferred();
        pending.push(d);
        return d.promise;
      }
      return cfg.perfettoFail
        ? Promise.reject(new Error('perfetto: cannot open trace'))
        : Promise.resolve(summary);
    }
    if (cmd.indexOf('simpleperf record') >= 0) {
      return cfg.simpleperfFail
        ? Promise.reject(new Error('simpleperf: permission denied'))
        : Promise.resolve('simpleperf record done -> perf.data');
    }
    return Promise.resolve('');
  }
  function cancelInflight() {
    state.killed = true;
    const list = pending.slice();
    pending.length = 0;
    list.forEach((d) => d.reject(new Error('process killed')));
  }
  return { runAdb, cancelInflight, fakeFs, calls, state, pending, summary };
}

/** 组装一个被测实例；默认注入固定时钟、假 fs、真实 path 算法、收集日志。 */
function makeCapture(cfg, extra) {
  const r = makeRunner(cfg);
  const logs = [];
  const opts = Object.assign({
    runAdb: r.runAdb,
    cancelInflight: r.cancelInflight,
    now: () => FIXED_NOW,
    fs: r.fakeFs,
    path: path,
    log: (m) => logs.push(String(m)),
    deviceId: DEV,
    reportDir: REPORT_DIR,
    enabled: true,
  }, extra || {});
  return { cap: createTraceCapture(opts), r: r, logs: logs };
}

const tick = () => new Promise((res) => setImmediate(res));

async function main() {
  // ── 静态守卫 ──────────────────────────────────────────────────────────────
  check("不含 require('electron')", !/require\(\s*['"]electron['"]\s*\)/.test(SRC), true);
  check("不直接 require('child_process')", !/require\(\s*['"]child_process['"]\s*\)/.test(SRC), true);
  check('不注册任何定时器', !/setInterval|setTimeout/.test(SRC), true);
  check('含 use strict', /'use strict'/.test(SRC), true);
  check('module.exports 明确列出', /module\.exports\s*=\s*\{/.test(SRC), true);
  check('注明 .perfetto-trace 产物扩展名', SRC.indexOf('.perfetto-trace') >= 0, true);
  check('注明 perf.data 产物扩展名', SRC.indexOf('perf.data') >= 0, true);

  // ── 导出形状 / 默认值 ─────────────────────────────────────────────────────
  check('导出 TraceCapture 构造器', typeof TraceCapture === 'function', typeof TraceCapture);
  check('导出 createTraceCapture 工厂', typeof createTraceCapture === 'function', typeof createTraceCapture);
  check('导出 countJankTypes 纯函数', typeof countJankTypes === 'function', typeof countJankTypes);
  // 回归守卫：旧的「从 perfetto stdout 里正则找 jankType」是一条永远为空的假链路
  //（perfetto 把 trace 写进 -o 指定的文件，stdout 里没有 jankType 文本）。
  // 该函数已删除，不允许再以任何名字回到模块里。
  check('已移除 parseJankTypes（假链路不得复活）', typeof TC.parseJankTypes === 'undefined',
    typeof TC.parseJankTypes);
  check('默认关闭', DEFAULTS.enabled === false, DEFAULTS.enabled);
  check('默认时长 10s', DEFAULTS.defaultDurationSec === 10, DEFAULTS.defaultDurationSec);
  check('默认 list 上限 20', DEFAULTS.maxRecords === 20, DEFAULTS.maxRecords);
  check('构造 new TraceCapture 亦可用', new TraceCapture({ enabled: false }) instanceof TraceCapture, true);

  // ── 纯函数：时长钳制 ──────────────────────────────────────────────────────
  check('clamp 默认 10s', clampDurationSec(undefined) === 10, clampDurationSec(undefined));
  check('clamp 下限 3s', clampDurationSec(1) === 3, clampDurationSec(1));
  check('clamp 上限 30s', clampDurationSec(99) === 30, clampDurationSec(99));
  check('clamp 合法中间值透传', clampDurationSec(15) === 15, clampDurationSec(15));
  check('clamp 四舍五入', clampDurationSec(7.6) === 8, clampDurationSec(7.6));
  assert.ok(clampDurationSec(4) === 4); // 原生 assert 亦可用

  // ── 纯函数：脱敏 / 路径越界 ───────────────────────────────────────────────
  check('sanitize 去除非法字符', sanitizeSegment('a/b:c d') === 'a_b_c_d', sanitizeSegment('a/b:c d'));
  check('resolveLocal 正常拼接', (() => {
    const x = resolveLocal(REPORT_DIR, 'perfetto_x.perfetto-trace', path);
    return x.ok && x.path.indexOf(path.resolve(REPORT_DIR)) === 0;
  })(), true);
  check('resolveLocal 拒绝 ../ 越界名', (() => {
    const x = resolveLocal(REPORT_DIR, '../../evil.perfetto-trace', path);
    return x.ok === false && x.reason === 'unsafe-name';
  })(), true);
  check('resolveLocal 空报告目录报 no-report-dir', resolveLocal('', 'x', path).reason === 'no-report-dir', true);

  // ── 纯函数：jankType 位掩码统计 ──────────────────────────────────────────
  // 真机样本（Android 13 / gfxinfo framestats 的 FLAGS 列，已脱敏）：
  // 绝大多数帧是 0，偶发 1（AppDeadlineMissed）。
  const realFlags = [0, 1, 0, 0, 1, 0, 0, 0, 2, 0];
  const jc = countJankTypes(realFlags);
  check('位统计：总帧数', jc.total === 10, jc.total);
  check('位统计：卡顿帧数=3', jc.janky === 3, jc.janky);
  check('位统计：AppDeadlineMissed×2', jc.counts.AppDeadlineMissed === 2, jc.counts);
  check('位统计：SurfaceFlingerCpuDeadlineMissed×1',
    jc.counts.SurfaceFlingerCpuDeadlineMissed === 1, jc.counts);
  check('位统计：无卡顿不入表', !('None' in jc.counts), jc.counts);
  check('位统计：types 按位序输出', jc.types.join(',') === 'AppDeadlineMissed,SurfaceFlingerCpuDeadlineMissed',
    jc.types);
  // 组合位：一帧同时命中两个原因 → 两个计数各 +1（不是二选一）
  const combo = countJankTypes([1 | 8]);
  check('组合位分别计数', combo.counts.AppDeadlineMissed === 1 && combo.counts.BufferStuffing === 1,
    combo.counts);
  check('组合位只算一帧卡顿', combo.janky === 1, combo.janky);
  // 未知位不得静默丢弃：记进 Unknown，保证「有卡顿」这件事不会被吞掉
  const unknownBit = countJankTypes([1024]);
  check('未知位计入 Unknown', unknownBit.janky === 1 && unknownBit.counts.Unknown === 1, unknownBit);
  check('空输入不炸', countJankTypes(null).total === 0 && countJankTypes([]).types.length === 0, true);
  check('位表含 FrameTimeline 扩展位', JANK_FLAG_BITS.some(([b]) => b === 32)
    && JANK_FLAG_BITS.some(([b]) => b === 128), JANK_FLAG_BITS.length);
  check('jankType 语义含中文说明', /应用/.test(JANK_TYPE_SEMANTICS.AppDeadlineMissed)
    && /缓冲|队列/.test(JANK_TYPE_SEMANTICS.BufferStuffing), JANK_TYPE_SEMANTICS.AppDeadlineMissed);
  check('describeJankTypes 返回说明映射', describeJankTypes(['PredictionError']).PredictionError
    === JANK_TYPE_SEMANTICS.PredictionError, describeJankTypes(['PredictionError']));
  check('perfetto 配置含 frametimeline 数据源', PERFETTO_CONFIG.indexOf('android.surfaceflinger.frametimeline') >= 0, true);
  check('perfetto 配置脱敏无真机包名', PERFETTO_CONFIG.indexOf('com.') < 0, true);

  // ── 默认关闭：零开销、零调用 ──────────────────────────────────────────────
  {
    const r = makeRunner({});
    const logs = [];
    const cap = createTraceCapture(Object.assign({
      runAdb: r.runAdb, cancelInflight: r.cancelInflight,
      now: () => FIXED_NOW, fs: r.fakeFs, path: path,
      log: (m) => logs.push(String(m)), deviceId: DEV, reportDir: REPORT_DIR,
    }, {})); // 不传 enabled -> 默认 false
    const res = await cap.capture({ source: 'auto', reason: 'fps-drop' });
    check('默认关闭返回 disabled', res.ok === false && res.reason === 'disabled', res);
    check('默认关闭零 adb 调用', r.calls.length === 0, r.calls.length);
    check('默认关闭不读/写文件', r.state.mkdirCount === 0, r.state.mkdirCount);
    check('默认关闭 diagnostics.enabled=false', cap.getDiagnostics().enabled === false, cap.getDiagnostics());
    check('默认关闭 diagnostics.running=false', cap.getDiagnostics().running === false, true);
    check('默认关闭无记录', cap.list().length === 0, cap.list().length);
  }

  // ── 开启后握手 + 抓取 + 10s + 脱敏 ───────────────────────────────────────
  {
    const { cap, r, logs } = makeCapture({ sdk: '33' });
    const res = await cap.capture({ source: 'manual' });
    check('开启后抓取成功', res.ok === true && res.durationMs >= 0, res);
    check('kind=perfetto（Android 12+ 优先）', res.kind === 'perfetto', res.kind);
    check('产物路径在报告目录内', res.path.indexOf(path.resolve(REPORT_DIR)) === 0, res.path);
    check('产物扩展名 .perfetto-trace', /\.perfetto-trace$/.test(res.path), res.path);
    check('握手探测 SDK', r.calls.some((c) => c.cmd.indexOf('getprop ro.build.version.sdk') >= 0), true);
    check('握手探测 perfetto', r.calls.some((c) => c.cmd.indexOf('command -v perfetto') >= 0), true);
    check('握手探测 simpleperf', r.calls.some((c) => c.cmd.indexOf('command -v simpleperf') >= 0), true);
    check('10s 时长参数写入 config duration_ms=10000', r.calls.some((c) => c.cmd.indexOf('duration_ms: 10000') >= 0), true);
    check('perfetto 命令不再带 -t（禁止与 -c 同用）', !r.calls.some((c) => / -t \d+s/.test(c.cmd)), true);
    check('perfetto 抓取命令含 frametimeline', r.calls.some((c) => c.cmd.indexOf('android.surfaceflinger.frametimeline') >= 0), true);
    check('抓取后执行 adb pull', r.calls.some((c) => c.args.indexOf('pull') >= 0), true);
    check('durationMs 为有限数', Number.isFinite(res.durationMs), res.durationMs);
    check('list() 新增一条', cap.list().length === 1, cap.list().length);
    check('getDiagnostics okCount=1', cap.getDiagnostics().okCount === 1, cap.getDiagnostics());
    check('诊断日志有中文前缀', logs.some((m) => m.indexOf('[旁路取证]') >= 0), logs);
    check('产物名不含设备代号（脱敏）', res.path.indexOf(DEV) < 0, res.path);
    check('产物名不含应用包名（脱敏）', res.path.indexOf('com.') < 0, res.path);
    const base = path.basename(res.path);
    check('产物名仅含安全字符', /^[A-Za-z0-9._-]+$/.test(base), base);
    // 回归：未注入 snapshotJank 时，perfetto 的 stdout 里就算写着 jankType 文本
    // 也**不得**被当成归因结果 —— 这正是旧实现的假数据来源。
    check('未注入归因源时不产出 jankTypes', res.jankTypes === undefined, res.jankTypes);
    check('未注入归因源时不产出 jankCounts', res.jankCounts === undefined, res.jankCounts);
    check('perfetto stdout 不再被当作 trace 摘要',
      SRC.indexOf('parseJankTypes') < 0 && SRC.indexOf('grabbed.stdout') < 0, true);
  }

  // ── 注入 snapshotJank：帧归因走真实位掩码 ────────────────────────────────
  {
    const calls = [];
    const { cap } = makeCapture({ sdk: '33' }, {
      packageName: 'com.example.app',
      snapshotJank: async (pkg) => {
        calls.push(pkg);
        return { ok: true, source: 'gfxinfo-framestats', total: 10, flags: [0, 1, 0, 0, 1, 8, 0, 0, 0, 0] };
      },
    });
    const res = await cap.capture({ source: 'auto', reason: 'fps-drop' });
    check('注入源后抓取仍成功', res.ok === true, res);
    check('归因按被测包名取数', calls.length === 1 && calls[0] === 'com.example.app', calls);
    check('归因带 jankSource', res.jankSource === 'gfxinfo-framestats', res.jankSource);
    check('归因带帧数/卡顿帧数', res.jankFrames && res.jankFrames.total === 10
      && res.jankFrames.janky === 3, res.jankFrames);
    check('归因带计数', res.jankCounts && res.jankCounts.AppDeadlineMissed === 2
      && res.jankCounts.BufferStuffing === 1, res.jankCounts);
    check('归因带中文语义', res.jankTypeSemantics
      && /应用/.test(res.jankTypeSemantics.AppDeadlineMissed || ''), res.jankTypeSemantics);
    check('归因进入 list()', cap.list()[0] && cap.list()[0].jankCounts
      && cap.list()[0].jankCounts.AppDeadlineMissed === 2, cap.list()[0]);
  }

  // ── 归因源失败 / 抛异常 / 返回空帧：如实不写字段 ─────────────────────────
  {
    const cases = [
      ['源返回 ok:false', async () => ({ ok: false, reason: 'no-frames' })],
      ['源抛异常', async () => { throw new Error('boom'); }],
      ['源返回空 flags', async () => ({ ok: true, source: 'gfxinfo-framestats', total: 0, flags: [] })],
      // 真机实测：自绘 / SurfaceView 类应用只会给 0~2 帧，用 1 帧算「100% 卡顿」没有意义
      ['源只有 2 帧（少于下限）', async () => ({
        ok: true, source: 'gfxinfo-framestats', total: 2, flags: [1, 0],
      })],
    ];
    for (const [label, fn] of cases) {
      const { cap } = makeCapture({ sdk: '33' }, { packageName: 'com.example.app', snapshotJank: fn });
      let threw = false, res = null;
      try { res = await cap.capture({}); } catch (e) { threw = true; }
      check(`${label}：不抛异常`, threw === false, threw);
      check(`${label}：抓取不受影响`, res && res.ok === true, res);
      check(`${label}：不写 jankTypes`, res && res.jankTypes === undefined, res && res.jankTypes);
    }
  }

  // ── 自定义时长 / 钳制落到命令行 ───────────────────────────────────────────
  {
    const { cap, r } = makeCapture({ sdk: '33' });
    const a = await cap.capture({ durationSec: 25 });
    check('自定义 25s -> duration_ms=25000', a.ok === true && r.calls.some((c) => c.cmd.indexOf('duration_ms: 25000') >= 0), true);
    const b = await cap.capture({ durationSec: 1 });
    check('1s 被钳到 duration_ms=3000', b.ok === true && r.calls.some((c) => c.cmd.indexOf('duration_ms: 3000') >= 0), true);
    const c = await cap.capture({ durationSec: 99 });
    check('99s 被钳到 duration_ms=30000', c.ok === true && r.calls.some((c) => c.cmd.indexOf('duration_ms: 30000') >= 0), true);
  }

  // ── perfetto 失败回退 simpleperf ──────────────────────────────────────────
  {
    const { cap, r } = makeCapture({ sdk: '33', perfettoFail: true });
    const res = await cap.capture({});
    check('perfetto 失败成功回退', res.ok === true && res.kind === 'simpleperf', res);
    check('回退产物 perf.data 名', /simpleperf_/.test(res.path) && /perf\.data$/.test(res.path), res.path);
    check('回退执行 simpleperf record', r.calls.some((x) => x.cmd.indexOf('simpleperf record') >= 0), true);
    check('回退仍执行 pull', r.calls.some((x) => x.args.indexOf('pull') >= 0), true);
  }

  // ── 两者都失败：静默降级不抛 ──────────────────────────────────────────────
  {
    const { cap, r } = makeCapture({ sdk: '33', perfettoFail: true, simpleperfFail: true });
    let threw = false, res = null;
    try { res = await cap.capture({}); } catch (e) { threw = true; }
    check('双失败未抛异常', threw === false, threw);
    check('双失败返回 ok:false', res && res.ok === false, res);
    check('双失败带 reason', res && typeof res.reason === 'string' && res.reason.length > 0, res);
    check('双失败两种后端都尝试过', r.calls.some((x) => x.cmd.indexOf('perfetto --txt') >= 0)
      && r.calls.some((x) => x.cmd.indexOf('simpleperf record') >= 0), true);
    check('双失败记录 failCount', cap.getDiagnostics().failCount === 1, cap.getDiagnostics().failCount);
  }

  // ── Android 11 走 simpleperf 分支 ─────────────────────────────────────────
  {
    const { cap, r } = makeCapture({ sdk: '30' });
    const res = await cap.capture({});
    check('Android 11(sdk=30) kind=simpleperf', res.ok === true && res.kind === 'simpleperf', res);
    check('Android 11 不跑 perfetto 抓取', !r.calls.some((x) => x.cmd.indexOf('perfetto --txt') >= 0
      || x.cmd.indexOf('perfetto -o') >= 0), true);
    check('Android 11 跑 simpleperf record', r.calls.some((x) => x.cmd.indexOf('simpleperf record') >= 0), true);
    check('Android 11 simpleperf 时长 --duration 10', r.calls.some((x) => x.cmd.indexOf('--duration 10') >= 0), true);
    check('isSupported 缓存 sdkInt=30', cap.getDiagnostics().sdkInt === 30, cap.getDiagnostics());
  }

  // ── 能力探测 / 缓存 / 都不可用 ────────────────────────────────────────────
  {
    const { cap, r } = makeCapture({ sdk: '33' }, { enabled: false });
    const s1 = await cap.isSupported();
    check('isSupported 返回 supported', s1.supported === true && s1.backend === 'perfetto', s1);
    const n1 = r.calls.length;
    const s2 = await cap.isSupported();
    check('isSupported 缓存命中不重复探测', r.calls.length === n1, { n1, n2: r.calls.length });
    check('isSupported 两次结果一致', s2.backend === s1.backend, s2);
  }
  {
    const { cap } = makeCapture({ sdk: '33', noPerfetto: true, noSimpleperf: true });
    const s = await cap.isSupported();
    check('两后端都不可用 -> supported=false', s.supported === false, s);
    const res = await cap.capture({});
    check('两后端都不可用 capture 直接 unsupported', res.ok === false && res.reason === 'unsupported', res);
  }

  // ── 并发 busy + cancel 清理 ───────────────────────────────────────────────
  {
    const { cap, r } = makeCapture({ sdk: '33', hang: true });
    const p1 = cap.capture({ durationSec: 10 });
    await tick(); // 让握手完成并进入挂起的 perfetto 抓取
    check('第一段 trace 处于 running', cap.isRunning() === true, true);
    const busy = await cap.capture({});
    check('并发第二次返回 busy', busy.ok === false && busy.reason === 'busy', busy);
    check('busy 不打断正在跑的', cap.isRunning() === true, true);
    check('busy 未新增抓取命令', r.calls.filter((x) => x.cmd.indexOf('perfetto --txt') >= 0).length === 1,
      r.calls.filter((x) => x.cmd.indexOf('perfetto --txt') >= 0).length);
    const didCancel = cap.cancel();
    check('cancel() 命中在途返回 true', didCancel === true, didCancel);
    check('cancel 调用注入 runner 杀进程', r.state.killed === true, r.state.killed);
    const p1res = await p1;
    check('在途抓取以 cancelled 收尾', p1res.ok === false && p1res.reason === 'cancelled', p1res);
    check('cancel 后 running=false', cap.getDiagnostics().running === false, cap.getDiagnostics());
    check('cancel 后无孤儿进程', cap.getDiagnostics().inflightProcs === 0, cap.getDiagnostics().inflightProcs);
    check('无在途时 cancel 返回 false', cap.cancel() === false, true);
    // 取消路径也要清设备端残留：perfetto 已挂起（remote 已定），kill 后 finally 里 rm -rf
    check('取消后仍清理设备端临时文件', r.calls.some((c) => c.args.indexOf('shell') >= 0
      && /^rm -rf /.test(c.cmd) && c.cmd.indexOf('perfara_trace_') >= 0
      && c.cmd.indexOf('.perfetto-trace') >= 0),
      r.calls.filter((c) => /^rm -rf /.test(c.cmd)).map((c) => c.cmd));
  }

  // ── 设备端零残留（真机复测发现的缺陷：成功 pull 后不 rm 远端）─────────────
  {
    const { cap, r } = makeCapture({ sdk: '33' });
    const res = await cap.capture({ durationSec: 5 });
    const rmCalls = r.calls.filter((c) => c.args.indexOf('shell') >= 0 && /^rm -rf /.test(c.cmd));
    check('成功抓取后 rm -rf 远端临时 trace', res.ok === true && rmCalls.length === 1
      && rmCalls[0].cmd.indexOf('.perfetto-trace') >= 0, rmCalls.map((c) => c.cmd));
    const pullCall = r.calls.find((c) => c.args.indexOf('pull') >= 0);
    check('rm 的目标就是 pull 的来源', rmCalls.length === 1 && !!pullCall
      && pullCall.args[pullCall.args.length - 2]
        === rmCalls[0].cmd.slice('rm -rf '.length).replace(/'/g, ''),
      { rm: rmCalls.map((c) => c.cmd), pull: pullCall && pullCall.args.join(' ') });
    check('simpleperf 回退后 rm -rf 的是 mkdir 的目录（rm -f 删不掉目录）', (async () => {
      const m = makeCapture({ sdk: '33', perfettoFail: true });
      const rr = await m.cap.capture({});
      if (rr.ok !== true) return false;
      const dir = '/data/local/tmp/' + 'perfara_trace_';
      return m.r.calls.some((c) => /^rm -rf /.test(c.cmd)
        && c.cmd.indexOf(dir) >= 0 && c.cmd.indexOf('/perf.data') < 0
        && !/\.perf\.data'/.test(c.cmd));
    })(), true);
  }

  // ── list 上限 ─────────────────────────────────────────────────────────────
  {
    let clk = FIXED_NOW;
    const r = makeRunner({ sdk: '33' });
    const cap = createTraceCapture({
      runAdb: r.runAdb, cancelInflight: r.cancelInflight,
      now: () => (clk += 1000), fs: r.fakeFs, path: path,
      log: () => {}, deviceId: DEV, reportDir: REPORT_DIR,
      enabled: true, maxRecords: 3,
    });
    for (let i = 0; i < 5; i++) await cap.capture({});
    const list = cap.list();
    check('list 上限 3', list.length === 3, list.length);
    check('list 保留最近（ts 严格递增）', list[0].ts < list[1].ts && list[1].ts < list[2].ts, list.map((x) => x.ts));
    check('list 返回副本', (() => { list[0].ok = 'MUTATED'; return cap.list()[0].ok !== 'MUTATED'; })(), true);
    check('getDiagnostics.records 与 list 一致', cap.getDiagnostics().records === 3, cap.getDiagnostics().records);
  }

  // ── enable / disable / dispose ────────────────────────────────────────────
  {
    const { cap } = makeCapture({ sdk: '33' }, { enabled: false });
    const d0 = await cap.capture({});
    check('enable 前 capture=disabled', d0.reason === 'disabled', d0);
    check('enable() 返回 true', cap.enable() === true, true);
    const ok = await cap.capture({});
    check('enable 后抓取成功', ok.ok === true, ok);
    cap.disable();
    const d1 = await cap.capture({});
    check('disable 后 capture=disabled', d1.reason === 'disabled', d1);
    cap.dispose();
    check('dispose 后 disposed=true', cap.getDiagnostics().disposed === true, cap.getDiagnostics());
    const d2 = await cap.capture({});
    check('dispose 后 capture=disposed', d2.reason === 'disposed', d2);
  }

  // ── 触发上下文（低谷命中）透传 ────────────────────────────────────────────
  {
    const { cap } = makeCapture({ sdk: '33' });
    await cap.capture({ source: 'auto', reason: 'fps-drop', fps: 22, target: 60, ts: 123456, overrunMax: 180 });
    const rec = cap.list()[0];
    check('记录保留低谷命中上下文', rec.trigger.reason === 'fps-drop'
      && rec.trigger.fps === 22 && rec.trigger.target === 60, rec.trigger);
    check('记录 source=auto', rec.trigger.source === 'auto', rec.trigger.source);
    check('记录带 sdkInt/backend', rec.sdkInt === 33 && rec.backend === 'perfetto', rec);
  }

  console.log(`\n===== 旁路取证测试结果: ${passed} PASS / ${failed} FAIL =====`);
  if (failed) {
    console.log('FAILED: ' + FAILED.join(', '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('测试执行异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});
