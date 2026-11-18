/**
 * 会话级指标（冷启动 / 帧归因 / 退出原因）离线回归测试。
 *
 * 覆盖 2026-11-16 落地的三项：
 *   1. 冷启动：`am start -W` 的 LaunchState / TotalTime 解析；
 *   2. 帧归因：`dumpsys gfxinfo <pkg> framestats` 的 FLAGS 列提取（位掩码语义在
 *      trace_capture_test 里用 countJankTypes 锁定）；
 *   3. 退出原因：`dumpsys activity exit-info <pkg>` 的 ANR / 崩溃统计与「基线差集」。
 *
 * 全部用真机样本（已脱敏：包名统一换 com.example.app、uid 换成 10000 段），
 * 不连设备、不写盘、不依赖 electron。
 */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ADB_PATH = path.join(ROOT, '_client_src', 'app', 'src', 'adb.js');
const COLLECTOR_PATH = path.join(ROOT, '_client_src', 'app', 'src', 'collector.js');
const MAIN_PATH = path.join(ROOT, '_client_src', 'app', 'main.js');
const PERF_HTML = path.join(ROOT, 'perfara', 'collector', 'resources', 'reports', 'perf.html');
const RUN_XLSX = path.join(ROOT, '_client_src', 'app', 'src', 'run-xlsx.js');

const ADB = require(ADB_PATH);
const A = ADB.__algo;
const Collector = require(COLLECTOR_PATH);

let passed = 0, failed = 0;
const FAILED = [];
function check(name, cond, detail) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '  -> ' + JSON.stringify(detail)));
  cond ? passed++ : (failed++, FAILED.push(name));
}

// ── 真机样本（脱敏）─────────────────────────────────────────────────────────
// Android 13 / `am start -W` 冷启动输出的真实形状
const AM_COLD = [
  'Starting: Intent { cmp=com.example.app/.ui.Welcome }',
  'Status: ok',
  'LaunchState: COLD',
  'Activity: com.example.app/.ui.Main',
  'TotalTime: 757',
  'WaitTime: 760',
  'Complete',
].join('\n');

const AM_WARM = AM_COLD.replace('LaunchState: COLD', 'LaunchState: WARM')
  .replace('TotalTime: 757', 'TotalTime: 312').replace('WaitTime: 760', 'WaitTime: 315');

// 没有 -W 时 am 只打印 Starting/Warning，没有任何计时字段
const AM_NO_FLAG = [
  'Starting: Intent { cmp=com.example.app/.ui.Welcome }',
  'Warning: Activity not started, its current task has been brought to the front',
].join('\n');

const AM_ERROR = 'Error: Activity not started, unable to resolve Intent { act=android.intent.action.MAIN }';

// `dumpsys gfxinfo <pkg> framestats` 的真实形状：表头以 Flags, 开头，之后每行一帧。
// 列数随 ROM 变化，所以只依赖「表头定位 + 第一列」。
const FRAMESTATS = [
  'Applications Graphics Acceleration Info:',
  'Uptime: 1234567 Realtime: 7654321',
  '',
  '** Graphics info for pid 12345 [com.example.app] **',
  '',
  'Stats since: 624339629617039ns',
  'Total frames rendered: 6',
  'Janky frames: 2 (33.33%)',
  '',
  '---PROFILEDATA---',
  'Flags,FrameTimelineVsyncId,IntendedVsync,Vsync,InputEventId,HandleInputStart',
  '1,207390689,624339629617039,624339662682625,0,624339676809279,',
  '0,207390908,624339778379450,624339960219768,0,624339967108498,',
  '0,207391109,624339976730880,624340059381345,0,624340073197612,',
  '1,207391256,624340092469757,624340109001588,0,624340125217404,',
  '0,207391323,624340158580557,624340191641971,0,624340195475321,',
  '0,207391400,624340200000000,624340210000000,0,624340220000000,',
  '---PROFILEDATA---',
  '',
  'View hierarchy:',
  '  com.example.app/com.example.app.ui.Main{1a2b3c4}',
].join('\n');

// `dumpsys activity exit-info <pkg>` 的真实形状（Android 13 / SDK 33）
const EXIT_INFO = [
  'ACTIVITY MANAGER PROCESS EXIT INFO (dumpsys activity exit-info)',
  'Last Timestamp of Persistence Into Persistent Storage: 2026-11-16 19:19:16.830',
  '  package: com.example.app',
  '    Historical Process Exit for uid=10123',
  '        ApplicationExitInfo #0:',
  '          timestamp=2026-11-16 17:59:46.536 pid=22600 realUid=10123 packageUid=10123',
  '          process=com.example.app:channel reason=10 (USER REQUESTED) subreason=21 (FORCE STOP) status=0',
  '          importance=300 pss=0.00 rss=0.00 description=stop com.example.app due to SwipeUpClean state=empty trace=null',
  '        ApplicationExitInfo #1:',
  '          timestamp=2026-11-16 18:10:02.101 pid=22777 realUid=10123 packageUid=10123',
  '          process=com.example.app reason=6 (ANR) subreason=0 (UNKNOWN) status=0',
  '          importance=300 pss=512.00 rss=700.00 description=ANR in com.example.app state=empty trace=/data/anr/traces.txt',
  '        ApplicationExitInfo #2:',
  '          timestamp=2026-11-16 18:20:11.220 pid=22888 realUid=10123 packageUid=10123',
  '          process=com.example.app reason=4 (CRASH) subreason=0 (UNKNOWN) status=0',
  '          importance=300 pss=0.00 rss=0.00 description=crash state=empty trace=null',
  '        ApplicationExitInfo #3:',
  '          timestamp=2026-11-16 18:30:00.000 pid=22999 realUid=99910 packageUid=10123',
  '          process=com.google.android.webview:sandboxed_process0 reason=13 (OTHER KILLS BY SYSTEM) subreason=17 (ISOLATED NOT NEEDED) status=0',
  '          importance=300 pss=0.00 rss=0.00 description=isolated not needed state=empty trace=null',
].join('\n');

const EXIT_UNSUPPORTED = [
  'Unknown command: exit-info',
  'Activity manager dump options:',
  '  [-a] [-c] [-p PACKAGE] ...',
].join('\n');

async function main() {
  // ── 1. 冷启动解析 ────────────────────────────────────────────────────────
  {
    const c = A.parseAmStartTimings(AM_COLD);
    check('冷启动：识别 COLD', c && c.state === 'COLD', c);
    check('冷启动：TotalTime=757', c && c.totalTimeMs === 757, c);
    check('冷启动：WaitTime=760', c && c.waitTimeMs === 760, c);
    const w = A.parseAmStartTimings(AM_WARM);
    check('温启动：state=WARM / 312ms', w && w.state === 'WARM' && w.totalTimeMs === 312, w);
    check('不带 -W 时返回 null（不编 0ms）', A.parseAmStartTimings(AM_NO_FLAG) === null,
      A.parseAmStartTimings(AM_NO_FLAG));
    check('启动失败输出返回 null', A.parseAmStartTimings(AM_ERROR) === null,
      A.parseAmStartTimings(AM_ERROR));
    check('空输入不炸', A.parseAmStartTimings('') === null && A.parseAmStartTimings(null) === null, true);
  }

  // ── 2. 帧归因：FLAGS 列提取 ──────────────────────────────────────────────
  {
    const p = A.parseFramestatsFlags(FRAMESTATS);
    check('FLAGS：取到 6 帧', p.total === 6, p.total);
    check('FLAGS：位掩码原样', JSON.stringify(p.flags) === JSON.stringify([1, 0, 0, 1, 0, 0]),
      p.flags);
    check('FLAGS：遇到 PROFILEDATA 结束标记停止', p.total === 6, p.total);
    check('FLAGS：无表头返回空', A.parseFramestatsFlags('Total frames rendered: 10').total === 0, true);
    check('FLAGS：空输入不炸', A.parseFramestatsFlags(null).total === 0, true);
    // 表头改名也照样取数：只认「首列是数字」，不依赖表头字段名
    const alt = ['---PROFILEDATA---', 'FlagsNaoAlgo,Other', '1,2', '0,3', '---PROFILEDATA---'].join('\n');
    check('FLAGS：表头改名不影响取数（不数表头本身）',
      A.parseFramestatsFlags(alt).total === 2, A.parseFramestatsFlags(alt));
    // 真机实测：一段输出里有多个 PROFILEDATA 区块（第一段 3 行、第二段 120 行）。
    // 只读第一段会把「120 帧里卡 7 帧」读成「3 帧里卡 1 帧」。
    // 结构上 ---PROFILEDATA--- 是成对出现的开关标记（4 个标记 = 2 段）。
    const twoSections = [
      '---PROFILEDATA---',
      'Flags,a,',
      '1,x,', '0,x,', '0,x,',
      '---PROFILEDATA---',
      '---PROFILEDATA---',
      'Flags,a,',
      '1,x,', '1,x,', '0,x,', '0,x,', '0,x,',
      '---PROFILEDATA---',
      'View hierarchy:',
    ].join('\n');
    const ms = A.parseFramestatsFlags(twoSections);
    check('FLAGS：多区块合并（3+5=8 帧）', ms.total === 8, ms);
    check('FLAGS：多区块顺序保留', JSON.stringify(ms.flags) === JSON.stringify([1, 0, 0, 1, 1, 0, 0, 0]),
      ms.flags);
    // 帧窗口上限：不能因为异常 ROM 吐出十万行就把内存吃光
    const many = ['---PROFILEDATA---', 'Flags,a,']
      .concat(Array.from({ length: 500 }, () => '0,x,'))
      .concat(['---PROFILEDATA---']).join('\n');
    check('FLAGS：上限 360 帧', A.parseFramestatsFlags(many).total === 360,
      A.parseFramestatsFlags(many).total);
  }

  // ── 3. 退出原因解析 ──────────────────────────────────────────────────────
  {
    const r = A.parseExitInfo(EXIT_INFO);
    check('exit-info：识别支持', r.supported === true, r.supported);    check('exit-info：解析出 4 条记录', r.entries.length === 4, r.entries.length);
    const e0 = r.entries[0], e1 = r.entries[1], e2 = r.entries[2];
    check('exit-info：timestamp 原样保留', e0.timestamp === '2026-11-16 17:59:46.536', e0.timestamp);
    check('exit-info：pid 解析', e0.pid === 22600 && e1.pid === 22777, [e0.pid, e1.pid]);
    check('exit-info：reason 码 + 标签', e1.reasonCode === 6 && e1.reasonLabel === 'ANR',
      [e1.reasonCode, e1.reasonLabel]);
    check('exit-info：崩溃 reason=4', e2.reasonCode === 4 && e2.reasonLabel === 'CRASH',
      [e2.reasonCode, e2.reasonLabel]);
    check('exit-info：子进程 process 保留', r.entries[3].process === 'com.google.android.webview:sandboxed_process0',
      r.entries[3].process);
    check('exit-info：description 只取本行（不吞后续字段）',
      /SwipeUpClean/.test(e0.description) && !/state=/.test(e0.description), e0.description);
    check('exit-info：key 唯一（timestamp#pid）',
      new Set(r.entries.map((e) => e.key)).size === r.entries.length, r.entries.map((e) => e.key));
    const u = A.parseExitInfo(EXIT_UNSUPPORTED);
    check('exit-info：老系统标不支持（不是 0 次 ANR）', u.supported === false && u.entries.length === 0, u);
    check('exit-info：空输入不炸', A.parseExitInfo('').supported === false, true);
  }

  // ── 3.5 timestats 自带归因：字段表 + 累计计数差分 ────────────────────────
  {
    const F = A.JANK_TS_FIELDS;
    // 真机（Android 13/14）timestats「Jank payload for this layer」的字段名，逐字锁定。
    // 改错一个字母不会有异常，只会静默拿不到归因 —— 所以用等值断言而不是 includes。
    check('timestats 字段：应用侧未细分', F.appUnattributedJankyFrames === 'AppDeadlineMissed', F);
    check('timestats 字段：缓冲堆积', F.appBufferStuffingJankyFrames === 'BufferStuffing', F);
    check('timestats 字段：SF CPU', F.sfLongCpuJankyFrames === 'SurfaceFlingerCpuDeadlineMissed', F);
    check('timestats 字段：SF GPU', F.sfLongGpuJankyFrames === 'SurfaceFlingerGpuDeadlineMissed', F);
    check('timestats 字段：SF 调度', F.sfSchedulingJankyFrames === 'SurfaceFlingerScheduling', F);
    check('timestats 字段：预测偏差', F.sfPredictionErrorJankyFrames === 'PredictionError', F);
    check('timestats 字段：归属不明', F.sfUnattributedJankyFrames === 'Unknown', F);
    check('timestats 元数据：窗口帧数/卡顿帧数', A.JANK_TS_META.totalTimelineFrames === '_frames'
      && A.JANK_TS_META.jankyFrames === '_total', A.JANK_TS_META);

    const prev = { AppDeadlineMissed: 3, BufferStuffing: 0, _frames: 100, _total: 3 };
    const curr = { AppDeadlineMissed: 5, BufferStuffing: 2, _frames: 160, _total: 7 };
    const d = A.jankAttrDelta(prev, curr);
    check('差分：逐字段作差', d && d.AppDeadlineMissed === 2 && d.BufferStuffing === 2
      && d._frames === 60 && d._total === 4, d);
    check('差分：首次采样（无基线）不编 0', A.jankAttrDelta(null, curr) === null,
      A.jankAttrDelta(null, curr));
    check('差分：本拍无归因块返回 null', A.jankAttrDelta(prev, null) === null, true);
    // 计数器变小 = 图层重建 / timestats 被 -clear → 整拍作废，不把绝对值当增量
    check('差分：计数器回退判为未测量',
      A.jankAttrDelta(prev, { AppDeadlineMissed: 1, BufferStuffing: 0, _frames: 60, _total: 1 }) === null,
      true);
    check('差分：字段缺失不猜', A.jankAttrDelta({ AppDeadlineMissed: 1 }, curr) === null, true);
    // 恒 0 的类型不落字段：43200 点 × 9 个恒 0 键会白占约 8MB，缺失即 0
    const compact = A.jankAttrDelta(
      { AppDeadlineMissed: 1, BufferStuffing: 0, _frames: 10, _total: 1 },
      { AppDeadlineMissed: 1, BufferStuffing: 0, _frames: 70, _total: 1 });
    check('差分：恒 0 类型不占字段（元数据保留）',
      compact && !('BufferStuffing' in compact) && compact._frames === 60
      && compact._total === 0, compact);
  }

  // ── 4. 采集器 / 接线层的静态守卫 ─────────────────────────────────────────
  {
    const ADB_SRC = fs.readFileSync(ADB_PATH, 'utf8');
    const COL_SRC = fs.readFileSync(COLLECTOR_PATH, 'utf8');
    const MAIN_SRC = fs.readFileSync(MAIN_PATH, 'utf8');
    const HTML = fs.readFileSync(PERF_HTML, 'utf8');
    const XLSX = fs.readFileSync(RUN_XLSX, 'utf8');

    check('adb.js：冷启动才加 -W（进程已存在时不加）',
      /let useWait = !hadProcess;/.test(ADB_SRC), true);
    // -W 会一直等首帧：熄屏/设备忙时曾把 start() 拖到 17.9s。必须「短超时 + 只给一次机会」。
    check('adb.js：-W 用短超时（不能沿用 10s 主超时）',
      /const WAIT_TIMEOUT_MS = 4000;/.test(ADB_SRC)
      && /w \? WAIT_TIMEOUT_MS : 10000/.test(ADB_SRC), true);
    check('adb.js：-W 超时后兜底路径不再带 -W',
      /useWait = false;/.test(ADB_SRC) && /放弃启动计时/.test(ADB_SRC), true);
    check('adb.js：ensureAppRunning 返回 launch 字段',
      /launch: launch \}/.test(ADB_SRC) && /launch: null \}/.test(ADB_SRC), true);
    check('adb.js：导出 getJankSnapshot / getAppExitInfo',
      /getJankSnapshot, getAppExitInfo,/.test(ADB_SRC), true);
    check('adb.js：exit-info 只统计应用自身进程（排除 webview 沙箱）',
      /indexOf\(packageName \+ ':'\) === 0/.test(ADB_SRC), true);

    check('collector：诊断里带 launch', /launch: this\._launch \?/.test(COL_SRC), true);
    check('collector：stopped 载荷带 launch', /launch: this\._launch \? Object\.assign/.test(COL_SRC), true);
    check('collector：start 时清空上一轮 launch', /this\._launch = null;/.test(COL_SRC), true);

    check('main：注入 snapshotJank 给旁路取证', /snapshotJank: async \(pkg\) => \{/.test(MAIN_SRC), true);
    check('main：采集走 framestats 通道时跳过归因（避免重置帧缓冲）',
      /framestats-channel-in-use/.test(MAIN_SRC)
      && /method === 'framestats' \|\| method === 'gfxinfo-delta'/.test(MAIN_SRC), true);
    check('main：开始采集前取退出原因基线', /getAppExitInfo\(deviceId, packageName\)/.test(MAIN_SRC), true);
    check('main：保存报告时按差集统计退出原因',
      /getAppExitInfo\(\s*androidSession\.deviceId, androidSession\.packageName, androidSession\.exitBaseline\)/.test(MAIN_SRC), true);
    check('main：payload 带 session 段', /session: \(sessionInfo\.launch \|\| sessionInfo\.exit\)/.test(MAIN_SRC), true);

    check('perf.html：帧归因按计数渲染', /r\.jankCounts\[k\]/.test(HTML), true);
    check('perf.html：会话级区块（启动/稳定性）', /id = 'session-metrics'/.test(HTML)
      && /会话级指标（启动 \/ 稳定性）/.test(HTML), true);
    check('run-xlsx：汇总页写入冷启动与 ANR/崩溃',
      /本轮 ANR \/ 崩溃 \/ 其它退出/.test(XLSX) && /耗时 \(ms\)/.test(XLSX), true);

    // 归因主链路：timestats（零额外开销）优先，gfxinfo 只做兜底
    check('adb.js：timestats 里解析 Jank payload',
      /Jank payload for this layer:/.test(ADB_SRC), true);
    check('adb.js：逐拍产出 jankAttr', /jankAttr: jankAttrDelta\(prev\.jank, jankRaw\)/.test(ADB_SRC), true);
    check('collector：采样点带 jankAttr', /data\.jankAttr = \(fpsData/.test(COL_SRC), true);
    check('collector：低频拍清空 jankAttr（1 帧无统计意义）',
      /data\.fpsMethod = 'low-activity';\s*\n\s*\/\/ 归因同理/.test(COL_SRC), true);
    check('main：归因优先取最近一拍的 timestats 结果',
      /source: 'timestats', counts: attr/.test(MAIN_SRC), true);
    check('perf.html：卡顿归因区块', /id = 'jank-attr'/.test(HTML)
      && /卡顿归因（FrameTimeline）/.test(HTML), true);
    check('perf.html：BufferStuffing 不参与卡顿占比（它不在 jankyFrames 子集里）',
      /var CORE = \['AppDeadlineMissed'/.test(HTML) && !/CORE = \[[^\]]*BufferStuffing/.test(HTML), true);
    check('run-xlsx：汇总页写入卡顿归因分布', /卡顿归因（FrameTimeline）/.test(XLSX), true);
    check('run-xlsx：BufferStuffing 单列不相加', /不与卡顿相加/.test(XLSX), true);

    // 分析解读（buildInsight）必须与下方独立区块同步：曾出现「区块写着 ANR 1、
    // 解读却说未发现明显风险」的自相矛盾。四项新指标都要在解读里能读到。
    check('解读总结：读取 data.session 会话级指标',
      /const sess = \(typeof data !== 'undefined' && data && data\.session\)/.test(HTML), true);
    check('解读总结：启动耗时进分项解读', /push\('启动', label/.test(HTML), true);
    check('解读总结：卡顿归因进分项解读', /push\('卡顿归因', jankyFrames/.test(HTML), true);
    check('解读总结：ANR / 崩溃进风险提示',
      /exitInfo\.anr/.test(HTML) && /crashN > 0/.test(HTML), true);
    check('解读总结：取帧通道命中率保留在解读副标题',
      /FIX-03：取帧通道命中率/.test(HTML), true);
    check('perf.html：jankAttr 进 pts 归一化（否则解读永远读不到）',
      /jankAttr: it\.jankAttr \?\? null,/.test(HTML), true);
    check('perf.html：加载段剔除时同步清掉 jankAttr（口径一致）',
      /jankAttr: null,/.test(HTML), true);
    // 成因可重叠：真机实测出现过「应用侧超时 4 + SF CPU 超时 2 > 卡顿 4 帧」，
    // 各类计数不能当互斥构成相加，两个出口都必须把这件事说出来。
    check('perf.html：成因重叠时提示占比之和可超 100%',
      /各类占比之和大于 100%/.test(HTML) && /coreTotal > janky/.test(HTML), true);
    check('perf.html：老系统取不到退出原因时明说「不支持」（不能静默成「没发生」）',
      /E\.supported === false/.test(HTML) && /本机不支持/.test(HTML), true);
    check('run-xlsx：成因重叠时提示勿按占比相加',
      /成因可重叠/.test(XLSX) && /勿按占比相加/.test(XLSX), true);

    // 2026-11-17 全网核查后的口径诚实性：解读结论不能比原始数据更确定。
    check('评分：缺失维度不再填中性值（旧写法不得复活）',
      !/jankMean == null \?/.test(HTML) && !/fpsP5 != null \?/.test(HTML), true);
    check('评分：缺 Jank / P5 时列出缺失维度并拒绝出指数',
      /scoreMissing\.push\('Jank'\)/.test(HTML)
        && /scoreMissing\.push\('FPS P5'\)/.test(HTML)
        && /!scoreMissing\.length/.test(HTML), true);
    check('评分：缺测分支明说「不以估计值代替实测」',
      /不以估计值代替实测/.test(HTML), true);
    check('评分：综合指数改名并公开权重公式',
      /综合性能指数（参考）/.test(HTML)
        && /帧率 50% \+ 卡顿 28% \+ 稳定 22%/.test(HTML), true);
    // 真实数据复算发现：BigJank「次/分」的 Math.max(1, durSec/60) 把所有 <60s 的
    // 采集分母钳成 1 分钟——51s 采到 7 帧会显示 7.0 次/分（正确 8.24），
    // 综合指数罚分也被低估 14 vs 16.5（分数虚高 3 分）。三处一律按实际分钟数折算，
    // 与 Drop/时（durSec/3600）同口径，杜绝短采集把原始计数当速率。
    check('解读：BigJank 次/分按实际时长折算（无 1 分钟钳位）',
      !/Math\.max\(1,\s*durSec\s*\/\s*60\)/.test(HTML)
        && (HTML.match(/\(durSec \/ 60\)/g) || []).length >= 3, true);
    // 复合指数可信度分层：分数本身无法靠调权重变客观（无 MOS 标定），
    // 代码能做的是把「这次能信到什么程度」写明，禁止把短采集显示成精确分数。
    check('评分：新增可信度分层函数 iScoreConfidence（样本/时长/目标来源）',
      /function iScoreConfidence\(n, durSec, targetFromDevice\)/.test(HTML)
        && /样本仅 ' \+ n \+ ' 个（<60/.test(HTML)
        && /有效时长 ' \+ iDurationText\(durSec\) \+ '（<1 分钟）/.test(HTML), true);
    check('评分：可信度接进 buildInsight 并在解读里显示（但不改分数）',
      /out\.scoreConfidence = conf/.test(HTML)
        && /本次指数可信度 <b>' \+ c\.text/.test(HTML)
        && /指数未经主观体验打分（MOS）标定/.test(HTML), true);
    check('评分：注明平均 FPS 反映吞吐而非主观流畅度',
      /平均 FPS 反映吞吐而非主观流畅度/.test(HTML), true);
    check('解读：大卡顿不再确定性归因 GC/IO',
      !/严重卡顿多与 GC、IO/.test(HTML)
        && /不能仅凭阈值断定是 GC/.test(HTML), true);
    check('解读：14000/s 注明 iOS 单核来源且不再断言会 kill',
      /iOS 单核经验阈值/.test(HTML)
        && !/进程可能被系统终止/.test(HTML), true);
    check('解读：温度以热节流为准，绝对阈值不再判 bad',
      /thermalThrottling/.test(HTML)
        && /绝对阈值跨机型不可比/.test(HTML), true);
    check('解读：1%Low 标注采样点口径（非逐帧）',
      /采样点口径/.test(HTML) && !/业界主流流畅度指标/.test(HTML), true);
    check('解读：小样本给出置信度提示',
      /样本仅/.test(HTML) && /分位数与占比不稳定/.test(HTML), true);
    check('解读：CPU/内存/帧率不再确定性归因',
      /可能成为瓶颈（需区分系统与其他进程占用）/.test(HTML)
        && /需更长时段才能区分泄漏与正常缓存/.test(HTML)
        && /请结合逐帧指标与卡顿归因定位/.test(HTML), true);
    check('解读：「无风险」不再等于「所有场景都没问题」',
      /这不等于应用没有性能问题/.test(HTML)
        && /不等同于所有场景都没有问题/.test(HTML), true);

    // library.html（历史对比页）必须与单页报告同口径，不能只修一半：
    // 上一轮只改了 perf.html，对比页仍用 85/0.85 填分、仍断言「进程被 kill」。
    const LIB = fs.readFileSync(
      path.join(ROOT, 'perfara', 'collector', 'resources', 'reports', 'library.html'), 'utf8');
    check('对比页：缺失维度不再填 85 / 0.85',
      !/jankRate == null \? 85/.test(LIB) && !/: 0\.85/.test(LIB), true);
    check('对比页：缺 Jank / P5 不出参考指数',
      /s\.scoreMissing\.push\('Jank'\)/.test(LIB)
        && /s\.scoreMissing\.push\('FPS P5'\)/.test(LIB)
        && /s\.scoreMissing\.length/.test(LIB), true);
    // 第五次筛查：跨报告排名同样受样本量影响，短采集的 P5/Jank 波动可能盖过 1~2 分之差。
    check('对比页：排名提示短采集样本不足 + 无 MOS 标定',
      /样本不足 60 个（分位数不稳）/.test(LIB)
        && /权重未经主观体验打分标定/.test(LIB), true);
    check('对比页：改称参考指数并声明非主观流畅度',
      /内部经验参考指数/.test(LIB) && /不是用户感知流畅度/.test(LIB)
        && /不代表主观流畅度/.test(LIB), true);
    check('对比页：14000/s 不再断言被 kill',
      /iOS 单核经验阈值/.test(LIB) && !/被系统 kill/.test(LIB), true);
    check('对比页：温度不再由极差推断降频',
      /热阈值跨机型不可比/.test(LIB), true);
    check('对比页：多份偏低不再断言"问题来自应用而非环境"',
      /并不能区分是应用自身还是共同的测试环境/.test(LIB)
        && !/问题更可能来自应用本身，而非某一次的测试环境/.test(LIB), true);
  }

  // ── 4b. 三次审计：指标说明气泡 + GPU 专项分支的口径必须同步解读层 ────────
  {
    const P = fs.readFileSync(PERF_HTML, 'utf8');
    check('指标说明：温度不再用 45/50°C 断言降频，改指向热节流',
      /热阈值因机型\/厂商策略而异/.test(P)
        && /是否真的降频请看「热节流」条目/.test(P)
        && !/超过 45°C 通常会开始降频/.test(P), true);
    check('指标说明：达帧率低不再确定性归因主线程',
      /达帧率低本身不指向具体原因/.test(P)
        && !/低于 80% 需要优化渲染或主线程/.test(P), true);
    check('指标说明：CPU 限频/各核频率不再断言温控降频',
      /温控或功耗策略均可能/.test(P)
        && /是否温控所致请对照「热节流」条目/.test(P)
        && !/说明触发了温控降频/.test(P), true);
    check('指标说明：内存增长/CPU 瓶颈/GPU 瓶颈去掉确定性措辞',
      /需更长时段才能区分泄漏与正常缓存积累/.test(P)
        && /需结合线程\/Trace 才能确认/.test(P)
        && /GPU 可能成为瓶颈，可从分辨率/.test(P)
        && !/说明 GPU 已成瓶颈/.test(P), true);
    check('iOS GPU 专项：明确"不含 FPS/CPU/内存、不代表整体流畅度"',
      /本页为 GPU 专项采集，不含 FPS \/ CPU \/ 内存/.test(P)
        && /不代表应用整体无性能问题/.test(P)
        && !/未发现明显 GPU 瓶颈，各阶段占用处于合理区间/.test(P), true);
  }

  // ── 4c. 「!」指标说明三处一致：perf.html / library.html / 注入源 ────────────
  // 2026-11-17 审计发现 library.html 与注入源仍是初版说明，故加守卫防止再次回退。
  {
    const LIB_HTML = path.join(ROOT, 'perfara', 'collector', 'resources', 'reports', 'library.html');
    const INJECT_PY = path.join(ROOT, 'tools', 'inject_metric_info.py');
    const P = fs.readFileSync(PERF_HTML, 'utf8');
    const L = fs.readFileSync(LIB_HTML, 'utf8');
    const T = fs.readFileSync(INJECT_PY, 'utf8');

    // 抽取 `var INFO = { ... };` 与 `var ALIAS = { ... };` 块做逐字比对
    const block = (s, name) => {
      const m = new RegExp('  var ' + name + ' = \\{[\\s\\S]*?\\n  \\};').exec(s);
      return m ? m[0] : null;
    };
    const keys = ['INFO', 'ALIAS'];
    keys.forEach((k) => {
      const p = block(P, k), l = block(L, k), t = block(T, k);
      check('指标说明 ' + k + '：三处均已注入', !!(p && l && t),
        { perf: !!p, lib: !!l, tool: !!t });
      check('指标说明 ' + k + '：library.html 与 perf.html 一致', l === p,
        { perfLen: p && p.length, libLen: l && l.length });
      check('指标说明 ' + k + '：注入源与 perf.html 一致', t === p,
        { perfLen: p && p.length, toolLen: t && t.length });
    });

    // 新指标与新口径必须出现在说明里（perf.html 为准，另两处靠上面的一致性守卫覆盖）
    const NEW_INFO = ['ftP50', 'ftP95', 'ftP99', 'overrunMax', 'jankyr', 'hitch',
      'thermal', 'session', 'jankAttr', 'fpsChannel', 'overhead'];
    NEW_INFO.forEach((k) => {
      check('指标说明含新条目 ' + k,
        new RegExp('\\n    ' + k + ': \\{').test(P), k);
    });
    check('指标说明：网络改为 netstats 按 UID 口径',
      /dumpsys netstats/.test(P) && !/Android \/proc\/net\/dev/.test(P), true);
    check('指标说明：卡顿归因注明 BufferStuffing 非子集、占比可 >100%',
      /BufferStuffing（缓冲堆积）不是 jankyFrames 的子集/.test(P)
        && /占比之和可能 >100%/.test(P), true);
    check('指标说明：1%Low 标注秒级采样点、非逐帧 PresentMon 口径',
      /秒级采样点口径，不是行业的逐帧 1% Low/.test(P), true);

    // 注入源口径版本与清单必须跟 metric-schema.js 对齐（SCHEMA_VERSION=9，34 项）
    const SCHEMA = require(path.join(ROOT, '_client_src', 'app', 'src', 'metric-schema.js'));
    check('注入源 SCHEMA_VERSION 与 metric-schema.js 一致',
      new RegExp("SCHEMA_VERSION = '" + SCHEMA.SCHEMA_VERSION + "'").test(T),
      SCHEMA.SCHEMA_VERSION);
    const defs = SCHEMA.metricDefinitions();
    check('注入源 METRIC_DEFINITIONS 条目数 = ' + defs.length,
      (T.match(/\{\s*"key":/g) || []).length === defs.length,
      (T.match(/\{\s*"key":/g) || []).length);
  }

  // ── 5. Collector 实例行为（不连设备）─────────────────────────────────────
  {
    const c = new Collector('generic-device', 'com.example.app', 1000, null);
    check('Collector：初始 launch 为 null（未测量，不是 0ms）',
      c.getDiagnostics().launch === null, c.getDiagnostics().launch);
    let payload = null;
    c.on('stopped', (p) => { payload = p; });
    c.stop('test');
    check('Collector：stopped 载荷含 launch 键', payload && Object.prototype.hasOwnProperty.call(payload, 'launch'),
      payload);
    check('Collector：未冷启动时 launch=null', payload && payload.launch === null, payload && payload.launch);
  }

  console.log(`\n===== 会话级指标测试结果: ${passed} PASS / ${failed} FAIL =====`);
  if (FAILED.length) console.log('失败项: ' + FAILED.join(' | '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试异常: ' + (e && e.stack || e));
  process.exit(1);
});
