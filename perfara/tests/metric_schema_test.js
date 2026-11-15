/**
 * 口径版本与指标溯源（批次 1.3 / 1.6）离线回归。
 *
 * 这一层要锁死两件事：
 *   1. 每个指标都要能回答「从哪来、什么口径、覆盖多少、是否降级」；
 *   2. 报告必须带 schemaVersion，跨版本对比前能被告知「不可比」。
 *
 * 顺便锁住帧指标的两个关键修复：
 *   - 稳定 60fps 的 hitch 必须为 0（不能被取整误差造出 19 ms/s 的假卡顿）；
 *   - jank 阈值不能再用整段均值（卡顿越多阈值越高，自我遮蔽）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..', '..', '_client_src', 'app');
const S = require(path.join(APP, 'src', 'metric-schema'));
const A = require(path.join(APP, 'src', 'adb'));
const al = A.__algo;

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '  -> ' + JSON.stringify(detail)));
  cond ? pass++ : (fail++, fails.push(name));
}

// ── 1. 定义表 ───────────────────────────────────────────────────────────────
console.log('-- 指标定义表 --');
check('口径版本为 7', S.SCHEMA_VERSION === '7', S.SCHEMA_VERSION);
const defs = S.metricDefinitions();
check('定义清单非空且字段齐全',
  defs.length >= 15 && defs.every(d => d.key && d.label && d.unit && d.group && d.scope), defs.length);
check('帧指标含分位数与 hitch',
  ['ftP50', 'ftP95', 'ftP99', 'jankyRatio', 'hitchMsPerSec', 'overrunMax']
    .every(k => defs.some(d => d.key === k)), defs.map(d => d.key).slice(0, 8));
check('网络期望口径是应用级（app）',
  (defs.find(d => d.key === 'net.rxKBps') || {}).scope === 'app', defs.find(d => d.key === 'net.rxKBps'));
check('v3 新增 ADPF 节流信号与 PC 帧延迟定义',
  ['thermalStatus', 'coolingValue', 'pc.frameDisplayChangeMs', 'pc.frameUntilDisplayedMs',
   'pc.framePresentApiMs', 'pc.frameRenderLatencyMs', 'pc.frameAppStartGapMs']
    .every(k => defs.some(d => d.key === k)), defs.length);

// ── 2. provenance ───────────────────────────────────────────────────────────
console.log('-- 指标溯源 --');
function row(over) {
  return Object.assign({
    fps: 60, fpsMethod: 'timestats',
    ftP50: 16, ftP95: 18, ftP99: 30, jankyRatio: 2, hitchMsPerSec: 12, overrunP99: 14, overrunMax: 15,
    jank: 0, cpu: { sysCpu: 20, procCpu: 15 }, mem: { totalPss: 300 },
    net: { rxKBps: 10, txKBps: 2, netScope: 'app', netSource: 'qtaguid' },
    gpu: 40, temperature: 36, tempSource: 'battery', battery: { level: 80 },
  }, over || {});
}
const appRows = [row(), row({ fps: 59 })];
const pApp = S.buildProvenance(appRows, 'android');
check('采样数与覆盖率正确', pApp.samples === 2 && pApp.metrics.fps.coverage === 1, pApp.metrics.fps);
check('应用口径的网络不降级', pApp.metrics['net.rxKBps'].quality === 'ok', pApp.metrics['net.rxKBps']);
check('来源被计数', pApp.metrics.fps.sources.timestats === 2, pApp.metrics.fps.sources);
check('温度来源被识别为电池兜底',
  pApp.metrics.temperature.sources.battery === 2, pApp.metrics.temperature.sources);

const devRows = [row({ net: { rxKBps: 10, txKBps: 2, netScope: 'device', netSource: 'proc-net-dev' } })];
const pDev = S.buildProvenance(devRows, 'android');
check('整机口径被标为 degraded', pDev.metrics['net.rxKBps'].quality === 'degraded', pDev.metrics['net.rxKBps']);
check('降级项进入 degraded 列表且带说明',
  pDev.degraded.some(d => d.key === 'net.rxKBps' && /整机流量/.test(d.note)), pDev.degraded);

const halfRows = [row(), row({ gpu: null, temperature: null, battery: null })];
const pHalf = S.buildProvenance(halfRows, 'android');
check('覆盖一半记为 partial', pHalf.metrics.gpu.quality === 'partial' && pHalf.metrics.gpu.coverage === 0.5,
  pHalf.metrics.gpu);
check('完全未采到记为 missing', S.buildProvenance([row({ gpu: null })], 'android').metrics.gpu.quality === 'missing',
  S.buildProvenance([row({ gpu: null })], 'android').metrics.gpu);

const mixed = S.buildProvenance([row(), row({ fpsMethod: 'framestats' })], 'android');
check('一次采集用了两条通道时降级为 partial 并说明',
  mixed.metrics.fps.quality === 'partial' && /2 条通道/.test(mixed.metrics.fps.note), mixed.metrics.fps);

// 采集开销与截断：有就写，没有就绝不编造
const withExtra = S.buildProvenance([row()], 'android', { tickMs: [100, 300, 200], truncated: 5 });
check('采集耗时 P50/P95 正确', withExtra.overhead.p50Ms === 200 && withExtra.overhead.maxMs === 300, withExtra.overhead);
check('截断点数被记录', withExtra.truncatedSamples === 5, withExtra.truncatedSamples);
check('没有耗时数据时不生成 overhead', S.buildProvenance([row()], 'android').overhead === undefined, true);

// ── 3. 跨版本可比性判断 ─────────────────────────────────────────────────────
console.log('-- 口径版本判断 --');
// 这条测的是 checkSchema 的判定逻辑本身，不是版本号数值 —— 用常量避免每次升版都误红
check('同版本可比', S.checkSchema(S.SCHEMA_VERSION).comparable === true
  && S.checkSchema(S.SCHEMA_VERSION).level === 'ok');
check('旧报告无版本 → legacy', S.checkSchema(undefined).level === 'legacy'
  && S.checkSchema(undefined).comparable === false);
check('版本不同 → mismatch', S.checkSchema('1').level === 'mismatch'
  && /不建议直接对比/.test(S.checkSchema('1').message), S.checkSchema('1'));

// ── 4. 帧指标：hitch / overrun / 阈值不自我遮蔽 ──────────────────────────────
console.log('-- 帧指标口径 --');
function mkFrames(intervals, latency = 33.6) {
  const out = [];
  let t = 1e9;
  out.push({ vsync: t, completed: t + latency * 1e6 });
  for (const iv of intervals) {
    t += iv * 1e6;
    out.push({ vsync: t, completed: t + latency * 1e6 });
  }
  return out;
}
const stable = al.calcJankFramestats(mkFrames(new Array(40).fill(16.67)));
check('稳定 60fps：hitch = 0（无取整假卡顿）', stable.hitchMsPerSec === 0, stable.hitchMsPerSec);
check('稳定 60fps：overrun P99 与 max 都为 0', stable.overrunP99 === 0 && stable.overrunMax === 0, stable);
check('稳定 60fps：jankyRatio = 0', stable.jankyRatio === 0, stable.jankyRatio);
check('帧耗时分位数落在 16.67', stable.ftP50 === 16.67 && stable.ftP99 === 16.67, stable);

const locked = al.calcJankFramestats(mkFrames(new Array(30).fill(33.3)));
check('锁 30fps 不算卡顿帧（jankyRatio=0）', locked.jankyRatio === 0, locked.jankyRatio);
check('锁 30fps 的 overrun 小于 50ms（不触发低谷截图）', locked.overrunMax < 50, locked.overrunMax);

const hitch = al.calcJankFramestats(mkFrames([...new Array(10).fill(16.67), 200, ...new Array(10).fill(16.67)]));
check('200ms 长帧的 overrunMax ≈183ms', hitch.overrunMax > 180 && hitch.overrunMax < 190, hitch.overrunMax);
check('200ms 长帧的 hitch 明显抬升', hitch.hitchMsPerSec > 300, hitch.hitchMsPerSec);
check('200ms 长帧计入 jankyRatio', hitch.jankyRatio > 0, hitch.jankyRatio);

// 自我遮蔽回归：整段一半是 200ms 的极端段，旧实现 avgMs≈108 → 阈值 216ms → jank=0
const masking = al.analyseHistogram({ 16: 100, 200: 100 }, 16);
check('整段均值不再抬高 jank 阈值（50% 长帧必须全部计为 jank）',
  masking.jank === 100, masking);
check('同段 bigJank 也全部计入', masking.bigJank === 100, masking.bigJank);

const stable60Buckets = al.analyseHistogram({ 16: 1000, 17: 30 }, 16);
check('稳定 60fps 直方图 hitch 接近 0', stable60Buckets.hitchMsPerSec <= 2, stable60Buckets.hitchMsPerSec);
check('直方图 overrunMax 反映最差桶', stable60Buckets.overrunMax === 1, stable60Buckets.overrunMax);

// ── 5. 网络按 UID 统计的解析器 ──────────────────────────────────────────────
console.log('-- 网络 qtaguid 解析 --');
const QTAG = [
  'idx iface acct_tag_hex uid_tag_int cnt_set rx_bytes rx_packets tx_bytes tx_packets',
  '1 wlan0 0x0 10123 0 5000 5 900 9',
  '2 wlan0 0x0 10123 1 100 1 10 1',
  '3 wlan0 0x0 99999 0 777 1 777 1',
  '4 lo 0x0 10123 0 999 1 999 1',
].join('\n');
const q = al.parseQtaguidStats(QTAG, 10123);
check('按 UID 汇总前后台字节数', q && q.rx === 5100 && q.tx === 910, q);
check('忽略其它 UID', !q || q.rx !== 5100 + 777, q);
check('忽略回环接口', q && q.rx !== 5100 + 999, q);
check('文件为空时返回 null', al.parseQtaguidStats('', 10123) === null, true);
check('UID 非法时返回 null', al.parseQtaguidStats(QTAG, null) === null, true);

// ── 5b. netstats 按 UID 解析（真机 Android 13 真实格式） ────────────────────
// 真实输出用**缩写字段** rb/tb，且 uid 头行与计数行**分离**：
//   ident=[{...}] uid=N set=FOREGROUND tag=0x0
//     NetworkStatsHistory: bucketDuration=7200
//       st=1794556800 rb=21933612 rp=17545 tb=1207429 tp=7519 op=0
// 旧解析器只认「同行 rxBytes=/txBytes=」，在真机上**完全命中不了**。
console.log('-- 网络 netstats 解析（真机格式） --');
const NET_ABBR = [
  '  ident=[{type=1, ratType=COMBINED, metered=false, defaultNetwork=true}] uid=10001 set=DEFAULT tag=0x0',
  '    NetworkStatsHistory: bucketDuration=7200',
  '      st=1794556800 rb=13889 rp=48 tb=50648 tp=120 op=0',
  '      st=1794564000 rb=4409 rp=57 tb=38181 tp=93 op=0',
  '  ident=[{type=1, ratType=COMBINED, metered=false, defaultNetwork=true}] uid=10001 set=FOREGROUND tag=0x0',
  '    NetworkStatsHistory: bucketDuration=7200',
  '      st=1794556800 rb=21933612 rp=17545 tb=1207429 tp=7519 op=0',
  '      st=1794564000 rb=785096 rp=1527 tb=554275 tp=1462 op=0',
  '  ident=[{type=1}] uid=10001 set=FOREGROUND tag=0x4001804',
  '    NetworkStatsHistory: bucketDuration=7200',
  '      st=1794564000 rb=31784 rp=100 tb=5926 tp=20 op=0',
  '  ident=[{type=1}] uid=10001 set=DEFAULT tag=0x4000401',
  '    NetworkStatsHistory: bucketDuration=7200',
  '      st=1794564000 rb=0 rp=0 tb=1962 tp=5 op=0',
  '  ident=[{type=1}] uid=-1 set=ALL tag=0x0',
  '    NetworkStatsHistory: bucketDuration=3600',
  '      st=1794373200 rb=846 rp=8 tb=2372 tp=16 op=0',
].join('\n');
const ns = al.parseNetstatsUid(NET_ABBR, 10001);
// ⚠️ 口径：bucket 是固定窗口（真机 7200s）累计，不是全局累计。只取每个 set 段
// st 最大的「当前进行中」桶当累计值 —— 若把全部桶相加，桶边界处差值会把
// 「过去 2h 平均」瞬间算成 1s 速率（7200 倍假尖峰）。
// DEFAULT(0x0)=4409/38181；FG(0x0)=785096/554275；FG(0x4001804)=31784/5926；DEFAULT(0x4000401)=0/1962
check('缩写格式 rb/tb 只取当前桶（防跨桶假尖峰）',
  ns && ns.rx === 4409 + 785096 + 31784 + 0, ns);
check('缩写格式 txBytes 同样正确',
  ns && ns.tx === 38181 + 554275 + 5926 + 1962, ns);
check('set 之间互斥相加（不只取 DEFAULT，避免漏掉前台流量）',
  ns && ns.rx > 785096 && ns.rx < 900000, ns);
check('uid=-1 的系统级 ALL 不被算进目标 UID',
  ns && ns.rx !== 4409 + 785096 + 31784 + 846, ns);
check('输出为空时返回 null', al.parseNetstatsUid('', 10001) === null, true);
check('UID 非法时返回 null', al.parseNetstatsUid(NET_ABBR, null) === null, true);
check('输出里没有该 UID 时返回 null', al.parseNetstatsUid(NET_ABBR, 99999) === null, true);

const NET_LONG = [
  'uid=10001 set=DEFAULT rxBytes=1000 rxPackets=2 txBytes=200 txPackets=1',
  'uid=10001 set=FOREGROUND rxBytes=3000 rxPackets=4 txBytes=600 txPackets=2',
  'uid=10001 set=BACKGROUND rxBytes=500 rxPackets=1 txBytes=100 txPackets=1',
  'uid=10002 set=DEFAULT rxBytes=9999 rxPackets=9 txBytes=9999 txPackets=9',
].join('\n');
const nl = al.parseNetstatsUid(NET_LONG, 10001);
check('旧格式（同行 rxBytes=/txBytes=）仍能解析', nl && nl.rx === 4500 && nl.tx === 900, nl);
check('旧格式下忽略其它 UID', nl && nl.rx !== 4500 + 9999, nl);

const NET_ALL = [
  '  ident=[{type=1}] uid=10001 set=DEFAULT tag=0x0',
  '      st=1 rb=100 rp=1 tb=10 tp=1 op=0',
  '  ident=[{type=1}] uid=10001 set=ALL tag=0x0',
  '      st=1 rb=9999 rp=1 tb=8888 tp=1 op=0',
].join('\n');
const na = al.parseNetstatsUid(NET_ALL, 10001);
check('存在 uid 级 ALL 时只用 ALL（混加会重复计数）',
  na && na.rx === 9999 && na.tx === 8888, na);
const adbSrc = fs.readFileSync(path.join(APP, 'src', 'adb.js'), 'utf8');
check('getNetStats 的 netstats 通道带 --uid 过滤（默认视图无 per-UID 计数行）',
  /dumpsys netstats --uid/.test(adbSrc), true);

// ── 6. 接线（静态） ─────────────────────────────────────────────────────────
console.log('-- 接线 --');
const rd = fs.readFileSync(path.join(APP, 'src', 'reports-data-js.js'), 'utf8');
check('写报告时注入 schemaVersion 与 provenance',
  /schemaVersion:\s*Schema\.SCHEMA_VERSION/.test(rd) && /provenance:\s*provenance/.test(rd), true);
const col = fs.readFileSync(path.join(APP, 'src', 'collector.js'), 'utf8');
check('采集器把 UID 传给网络采集（允许后续可选参数，FIX-13 动态阈值）',
  /getNetStats\(this\.deviceId,\s*this\._uid(,|\))/.test(col), true);
check('采集器记录每拍耗时', /data\.tickMs\s*=\s*Date\.now\(\)\s*-\s*tickStart/.test(col), true);
// 1.5 升级为「分段落盘 + 报告合并」：到上限不再丢弃，
// 只有写盘也失败才显式计数 + 日志，主进程停止时把分片合并回报告。
const seg = fs.readFileSync(path.join(APP, 'src', 'segmented-history.js'), 'utf8');
check('历史点超限改为分段落盘，不再静默 shift',
  /this\.segments\.push\(this\.history, data\)/.test(col)
  && /已落盘分片/.test(seg) && !/this\.history\.shift\(\)/.test(col), true);
check('写盘失败才计数并显式提醒（不静默）',
  /this\.segments\.droppedPoints/.test(col) && /分段写盘失败/.test(col), true);
check('停止采集时合并分片再出报告', /drainHistory\(\)/.test(col), true);
check('采集器提供诊断信息', /getDiagnostics\(\)/.test(col), true);
const xl = fs.readFileSync(path.join(APP, 'src', 'run-xlsx.js'), 'utf8');
check('Excel 含数据质量页', /name:\s*'数据质量'/.test(xl), true);
check('Excel 汇总标注网络口径', /网络口径/.test(xl), true);
const perf = fs.readFileSync(path.resolve(__dirname, '..', 'collector', 'resources', 'reports', 'perf.html'), 'utf8');
check('报告页提示跨版本不可比', /口径版本为/.test(perf) && /不建议与其它版本直接对比/.test(perf), true);
check('报告页提示整机流量口径', /网络指标为整机流量/.test(perf), true);
const lib = fs.readFileSync(path.resolve(__dirname, '..', 'collector', 'resources', 'reports', 'library.html'), 'utf8');
check('对比页在口径不一致时提示', /renderCompareNotice/.test(lib) && /口径版本不一致/.test(lib), true);
const td = fs.readFileSync(path.join(APP, 'src', 'trough-detector.js'), 'utf8');
check('低谷判定接入帧耗时证据', /overrunSeverity/.test(td) && /overrunMax/.test(td), true);

console.log(`\n===== 结果: ${pass} PASS / ${fail} FAIL =====`);
if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
process.exit(fail ? 1 : 0);
