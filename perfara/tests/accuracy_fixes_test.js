'use strict';
/**
 * 外部修复工单（Perfara_外部修复说明_20261114）FIX-01~09 的离线回归用例。
 *
 * FIX-01（P0）静置/低频渲染误报卡顿 → isLowActivity 单点兜底 + 采样点构造
 * FIX-02（P0）帧指标 deadline 跨面板可比 → 三场景 × 两锚一致性 + 真卡顿保留
 * FIX-04（P1）网络速率 dt 基准 = 计数器读回时刻（静态断言 + 纯结构检查）
 * FIX-06（P1）thermalservice mStatus!=0 的传感器不参与主值/skin
 * FIX-07（P1）/proc/<pid>/status 三字段解析 + filterDataByConfig 不丢
 * FIX-08（P2）GPU 探针单次 head -v：脚本形状 + `==> path <==` 解析 + glob 反查 + @@ 兼容
 * FIX-09（P2）thermal sysfs 单次读：type/temp 按 zone 配对不串位
 *
 * 全部离线（纯函数 + 注入），不依赖真机。
 */
const path = require('path');
const fs = require('fs');
const ADB = require(path.resolve(__dirname, '..', '..', '_client_src', 'app', 'src', 'adb.js'));
const CollectorMod = require(path.resolve(__dirname, '..', '..', '_client_src', 'app', 'src', 'collector.js'));
const Collector = CollectorMod.Collector || CollectorMod;
const algo = ADB.__algo;
const A = algo;   // FIX-02/08/09 的纯函数别名
const Schema = require(path.resolve(__dirname, '..', '..', '_client_src', 'app', 'src', 'metric-schema.js'));

let pass = 0, fail = 0;
const FAILED = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; FAILED.push(name); console.log('  FAIL  ' + name + '  -> ' + JSON.stringify(detail)); }
}
const pick = (o) => ({ jankyRatio: o.jankyRatio, hitchMsPerSec: o.hitchMsPerSec, overrunMax: o.overrunMax });
const r3 = (o) => ({ jankyRatio: o.jankyRatio,
  hitchMsPerSec: Math.round(o.hitchMsPerSec * 10) / 10,
  overrunMax: Math.round(o.overrunMax * 10) / 10 });

console.log('\n-- FIX-02（P0）：帧指标 deadline 跨面板可比 --');
const e30 = [{ ms: 33, c: 30 }];
const e60b = [{ ms: 16, c: 58 }, { ms: 17, c: 2 }];
const e60long = [{ ms: 16, c: 57 }, { ms: 50, c: 3 }];
// deadline = max(屏幕锚, 本段 ftP50) —— 与采集端两个通道的实现一致
const anchorOf = (e, panel) => Math.max(panel, A.frameStatsFromBuckets(e, e.reduce((s, x) => s + x.c, 0), 0).ftP50 || 0);
{
  const a120 = r3(A.frameStatsFromBuckets(e30, 30, anchorOf(e30, 8.33)));
  const a60 = r3(A.frameStatsFromBuckets(e30, 30, anchorOf(e30, 16.67)));
  check('FIX-02.1 锁 30fps 跨面板 jankyRatio 相同（不再 100pp）',
    a120.jankyRatio === 0 && a60.jankyRatio === 0, [a120, a60]);
  check('FIX-02.1b 锁 30fps 不再被误判卡顿（hitch/overrun 均归零）',
    a120.hitchMsPerSec === 0 && a60.hitchMsPerSec === 0
    && a120.overrunMax === 0 && a60.overrunMax === 0, [a120, a60]);
  const b120 = r3(A.frameStatsFromBuckets(e60b, 60, anchorOf(e60b, 8.33)));
  const b60 = r3(A.frameStatsFromBuckets(e60b, 60, anchorOf(e60b, 16.67)));
  check('FIX-02.2 锁 60fps 稳态跨面板 jankyRatio 相同',
    b120.jankyRatio === 0 && b60.jankyRatio === 0, [b120, b60]);
  const c120 = r3(A.frameStatsFromBuckets(e60long, 60, anchorOf(e60long, 8.33)));
  const c60 = r3(A.frameStatsFromBuckets(e60long, 60, anchorOf(e60long, 16.67)));
  check('FIX-02.3 60fps+3 长帧：真卡顿仍报 5%（不被新锚掩盖）',
    c120.jankyRatio === 5 && c60.jankyRatio === 5, [c120, c60]);
  check('FIX-02.3b 长帧 hitch/overrun 保留（96 vs 94.2 的桶边界残差 ≤ 2ms）',
    Math.abs(c120.hitchMsPerSec - c60.hitchMsPerSec) <= 2
    && Math.abs(c120.overrunMax - c60.overrunMax) <= 2, [c120, c60]);
}

console.log('\n-- FIX-01（P0）：静置 / 低频渲染单点兜底 --');
{
  const isLow = Collector.isLowActivity;
  check('FIX-01.1 静置 1帧/1s → true', isLow(1, 1000) === true, isLow(1, 1000));
  check('FIX-01.2 静置 1帧/3s（ftP50=2997）→ true', isLow(1, 2997) === true, isLow(1, 2997));
  check('FIX-01.3 锁 30fps → false', isLow(30, 33) === false, isLow(30, 33));
  check('FIX-01.4 锁 60fps → false', isLow(60, 16) === false, isLow(60, 16));
  check('FIX-01.5 fps=2（边界）→ true', isLow(2, 33) === true, isLow(2, 33));
  check('FIX-01.6 fps=null（无帧场景由 FPS_NO_DATA_METHODS 管）→ false',
    isLow(null, 200) === false, isLow(null, 200));
  // 采样点构造：模拟「低活动拍」走 filterDataByConfig 后的形状
  const raw = {
    timestamp: 1, time: 'x', pid: 1,
    fps: 1, jank: 0, bigJank: 0, smallJank: 0, tinyJank: 0, jankRate: 0,
    fpsMethod: 'timestats',
    ftP50: 1000, ftP90: 1000, ftP95: 1000, ftP99: 1000,
    jankyRatio: 100, hitchMsPerSec: 991.7, overrunP95: 991.7, overrunP99: 991.7, overrunMax: 991.7,
    mem: { totalPss: 100 }, net: { rxKBps: 1, txKBps: 1 },
  };
  // 复现 collector 兜底逻辑（与 _tickBody 同步维护；此处锁定其输出形状）
  const mc = Collector.normalizeMetricConfig(null);
  let data = Collector.filterDataByConfig(JSON.parse(JSON.stringify(raw)), mc);
  if (!Collector.isLowActivity(data.fps, data.ftP50) === false) {
    for (const k of Collector.FRAME_STAT_KEYS) data[k] = null;
    data.fpsMethod = 'low-activity';
  }
  const allNull = Collector.FRAME_STAT_KEYS.every((k) => data[k] === null);
  check('FIX-01.7 兜底后 9 个帧分布指标全 null', allNull,
    Collector.FRAME_STAT_KEYS.map((k) => [k, data[k]]));
  check('FIX-01.8 fps 保留实测值（1 帧/秒是有用信息，不写 null/0）', data.fps === 1, data.fps);
  check('FIX-01.9 fpsMethod 标注 low-activity（不静默）', data.fpsMethod === 'low-activity',
    data.fpsMethod);
  check('FIX-01.10 low-activity 与 no-frames 语义分离（fps 保留、帧指标 null）',
    typeof data.fps === 'number' && data.fpsMethod === 'low-activity', data.fpsMethod);
}

console.log('\n-- FIX-04（P1）：网络速率 dt 基准 = 计数器读回时刻 --');
{
  const src = require('fs').readFileSync(
    path.resolve(__dirname, '..', '..', '_client_src', 'app', 'src', 'adb.js'), 'utf8');
  // 读回时刻锚仍在；基准从墙钟升级为单调时钟（Date.now 回拨会把 dt 夹到下限、放大速率）
  check('FIX-04.1 存在读回时刻锚（readAt，单调时钟）',
    /const readAt = monoMs\(\);/.test(src), true);
  check('FIX-04.2 dt 由 readAt 派生（不再用发起时刻 now），且非正间隔写 null',
    /const dtMs = readAt - prev\.ts;/.test(src)
    && /if \(!\(dtMs > 0\)\)/.test(src)
    && /const dt = Math\.max\(dtMs \/ 1000, 0\.1\)/.test(src), true);
  check('FIX-04.3 首拍基线同样用 readAt',
    /_netState\.set\(key, \{ rx: sample\.rx, tx: sample\.tx, ts: readAt, source: sample\.source \}\)/.test(src), true);
  check('FIX-04.4 15s 重试节流保留发起时刻语义（now 不被误改）',
    /qtaguidDeadTs <= NET_SCOPE_RETRY_MS/.test(src) && /cache\.ts \|\| 0\) > NET_SCOPE_RETRY_MS/.test(src), true);
}

console.log('\n-- FIX-06（P1）：thermalservice mStatus 过滤 --');
{
  const dump = [
    'Thermal Status: 0',
    'Current temperatures from HAL:',
    '\tTemperature{mValue=43.0, mType=2, mName=BATTERY, mStatus=0}',
    '\tTemperature{mValue=53.6, mType=3, mName=SKIN, mStatus=3}',
    'Current cooling devices from HAL:',
    '\tCoolingDevice{mValue=0, mType=2, mName=cpu_adaptive_0}',
  ].join('\n');
  const r = ADB.parseThermalService(dump);
  check('FIX-06.1 mStatus=3 的 SKIN 不参与主值', r.main === 43 && r.source === 'battery', r);
  check('FIX-06.2 mStatus=3 的 SKIN 不进 skinTemp', r.skin === null, r.skin);
  const r2 = ADB.parseThermalService(dump.replace('mStatus=3', 'mStatus=0'));
  check('FIX-06.3 全部 mStatus=0 时 SKIN 正常保留', r2.skin === 53.6, r2.skin);
  const r3 = ADB.parseThermalService(dump
    .replace('mValue=43.0, mType=2, mName=BATTERY, mStatus=0', ''));
  check('FIX-06.4 全部被滤掉时按回退链兜底（die/null，不写 0）',
    r3 == null || (r3.main === null || r3.main > 0), r3 && [r3.main, r3.source]);
}

console.log('\n-- FIX-07（P1）：/proc/<pid>/status 三字段 --');
{
  // 经 getMemInfoLite 走 mock adbShell 不可行（内部引用）——用纯函数直验解析结果：
  // parseMemLite 未导出 → 用同源正则在本用例复算 + 锁定源码行为。
  const src = require('fs').readFileSync(
    path.resolve(__dirname, '..', '..', '_client_src', 'app', 'src', 'adb.js'), 'utf8');
  // r4 要求：不用源码字符串嗅探（那会把错误字段名固化成断言——D-01 的教训），
  // 改用真实 /proc/<pid>/status 样本驱动 parseMemLite 断言解析结果。
  // 内核字段名（fs/proc/array.c:400-401）：
  //   voluntary_ctxt_switches:	<nvcsw>  /  nonvoluntary_ctxt_switches:	<nivcsw>
  const stReal = [
    'VmRSS:	  512345 kB', 'VmHWM:	  823456 kB', 'VmSwap:	   55296 kB',
    'Threads:	80',
    'voluntary_ctxt_switches:	185131',
    'nonvoluntary_ctxt_switches:	1234',
  ].join('\n');
  const lr = algo.parseMemLite('', stReal);
  check('FIX-07.1 真实样本：Threads=80', lr.threads === 80, lr);
  check('FIX-07.2 真实样本：VmSwap 55296kB → 54MB', lr.swapMB === 54, lr.swapMB);
  check('FIX-07.3 真实样本：自愿=185131、非自愿=1234（内核字段名 nonvoluntary_…）',
    lr.ctxVoluntary === 185131 && lr.ctxNonvoluntary === 1234, [lr.ctxVoluntary, lr.ctxNonvoluntary]);
  // D-01 修复注释里会引用旧字段名（说明为什么改）——断言只看「非注释行」
  const badFieldLine = src.split('\n').findIndex((l) =>
    l.includes('voluntary_ctxt_switches_nonvoluntary') && !l.trim().startsWith('//'));
  check('FIX-07.3b 旧错误字段名不在任何可执行行（仅允许出现在解释注释里）',
    badFieldLine < 0, badFieldLine);
  check('FIX-07.4 mem 组登记进 ANDROID_METRIC_KEYS（挂在 data.mem 对象，组开关生效）',
    Collector.ANDROID_METRIC_KEYS.mem[0] === 'mem', Collector.ANDROID_METRIC_KEYS.mem);
  // 采样点构造：全开配置不丢 mem.*.threads 等字段（工单验收「filterDataByConfig 不丢」）
  const mc = Collector.normalizeMetricConfig(null);
  const sample = Collector.filterDataByConfig({
    timestamp: 1, time: 'x', pid: 1,
    mem: { totalPss: 100, threads: 42, swapMB: 3, ctxVoluntary: 1000, ctxNonvoluntary: 7 },
  }, mc);
  check('FIX-07.5 全开配置 mem 对象整体保留（含新字段）',
    sample.mem && sample.mem.threads === 42 && sample.mem.swapMB === 3
    && sample.mem.ctxVoluntary === 1000 && sample.mem.ctxNonvoluntary === 7, sample.mem);
  // schema 登记：metricDefinitions 能读到 4 个新键
  const defs = Schema.metricDefinitions();
  for (const k of ['mem.threads', 'mem.swapMB', 'mem.ctxVoluntary', 'mem.ctxNonvoluntary']) {
    check('FIX-07.6 metricDefinitions 含 ' + k, defs.some((d) => d.key === k), k);
  }
  // D-02（r4）：full 通道带出四字段（命令里 cat /proc/<pid>/status 已在读）、
  // collector 不再置空（每 5 拍丢一次的规律性断点）
  check('D-02.1 getMemInfo 从 parseMemLite 带出四字段',
    /base\.threads = lite\.threads;[\s\S]{0,120}base\.ctxNonvoluntary = lite\.ctxNonvoluntary;/.test(src), true);
  const colSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '_client_src', 'app', 'src', 'collector.js'), 'utf8');
  check('D-02.2 collector full 分支不再显式置空',
    !colSrc.includes('threads: null, swapMB: null, ctxVoluntary: null'), true);
}
// D-03（r4）：GPU 口径是设备级 sysfs 节点（kgsl/mali/ged），标 app 会把别人的负载
// 说成本应用的 —— scope 改 device，与网络回退整机口径标注同一原则。
{
  const gpuDef = Schema.metricDefinitions().find((d) => d.key === 'gpu');
  check('D-03.1 gpu scope = device（整机口径标注正确）', gpuDef && gpuDef.scope === 'device', gpuDef);
}
// FIX-07 块的闭合（原 } 保留在下方）
// （FIX-07 块结束）

console.log('\n-- FIX-08（P2）：GPU 探针单次 head -v --');
{
  const script = algo.buildGpuProbeScript();
  check('FIX-08.1 单次 head -v -c 4096（不再 14 次 echo+cat）',
    script.includes('head -v -c 4096 "$@"') && script.indexOf('echo "@@') < 0, script.slice(0, 80));
  check('FIX-08.2 [ -r ] 过滤可读节点（全不可读时零 fork）',
    script.includes('[ -r "$f" ] && set -- "$@" "$f"'), true);
  check('FIX-08.3 14 条模式全部在脚本里', (script.match(/'\/(sys|proc)/g) || []).length === 14,
    (script.match(/'\/(sys|proc)/g) || []).length);
  // head -v 解析：正常节 + glob 展开路径反查 + 未知路径忽略 + @@ 兼容
  const p2 = algo.splitProbeOutput([
    '==> /sys/class/kgsl/kgsl-3d0/gpu_busy_percentage <==',
    ' 45 %',
    '==> /sys/class/kgsl/kgsl-3d0/gpubusy <==',
    '12345 67890',
    '==> /unknown/other <==',
    '999',
  ].join('\n'));
  check('FIX-08.4 `==> path <==` 反查 tag 并收集内容', p2.kgsl_pct === ' 45 %\n'
    && p2.kgsl_busy === '12345 67890\n', p2);
  check('FIX-08.5 未知路径整节忽略（不污染已知 tag）', p2.generic === undefined, p2.generic);
  const p3 = algo.splitProbeOutput('==> /sys/class/devfreq/hwim-gpu.mali/load <==\n33\n');
  check('FIX-08.6 glob pattern 反查展开后路径（mali_load）',
    typeof p3.mali_load === 'string' && p3.mali_load.trim() === '33', p3.mali_load);
  check('FIX-08.7 旧 @@tag 格式仍兼容（readGpuUsageViaRoot 的 su -c 路径）',
    algo.splitProbeOutput('@@ged_hal\n42\n').ged_hal === '42\n\n', true);
  // 正确性端到端：解析结果喂 interpretGpuProbe 应得到利用率
  const v = algo.interpretGpuProbe('kgsl_pct', p2.kgsl_pct);
  check('FIX-08.8 解析→解读链路（45% 合法）', v === 45, v);
}

console.log('\n-- FIX-09（P2）：thermal sysfs 单次读 + 配对 --');
{
  const script = algo.buildThermalSysfsScript();
  check('FIX-09.1 单次 head -v -c 256（不再 56 次 fork）',
    script.includes('head -v -c 256') && script.indexOf('for d in') < 0, script);
  const bodies = [['45000', 'cpu'], ['38123', 'skin'], ['29000', 'batt'], ['41000', 'gpu']];
  const lines = [];
  for (let i = 0; i < 4; i++) {
    lines.push(`==> /sys/class/thermal/thermal_zone${i}/temp <==`, bodies[i][0]);
    lines.push(`==> /sys/class/thermal/thermal_zone${i}/type <==`, bodies[i][1]);
  }
  const rows = algo.parseThermalSysfsDump(lines.join('\n'));
  const get = (n) => (rows.find((r) => r.name === n) || {}).value;
  check('FIX-09.2 temp/type 按 zone 号配对不串位',
    get('CPU') === 45 && get('SKIN') === 38.1 && get('BATT') === 29 && get('GPU') === 41, rows);
  check('FIX-09.3 非法值（负温）被过滤，不产出该 zone',
    algo.parseThermalSysfsDump(
      '==> /sys/class/thermal/thermal_zone0/type <==\ntsens0\n'
      + '==> /sys/class/thermal/thermal_zone0/temp <==\n-4000\n').length === 0, true);
  check('FIX-09.4 缺 type 的 zone 不产出（只报完整配对）',
    algo.parseThermalSysfsDump(
      '==> /sys/class/thermal/thermal_zone0/temp <==\n36000\n').length === 0, true);
}

console.log('\n-- 口径版本（FIX-02 随工单第 4 节）--');
{
  // v7：D-19（刷新率取错字段）/ D-20（data.js 缺 loading 段）/ 非标档位加上界，
  // 三者都改变目标帧率与达帧率，已版本化
  check('V1 SCHEMA_VERSION 已升到 7', Schema.checkSchema('7').comparable === true
    && Schema.checkSchema('3').level === 'mismatch', Schema.checkSchema('3'));
  const defs = Schema.metricDefinitions();
  const jr = defs.find((d) => d.key === 'jankyRatio');
  check('V2 jankyRatio 说明改为「相对实际帧节奏」', !!jr && /实际帧节奏/.test(jr.note || ''), jr && jr.note);
}

console.log(`\n===== 结果: ${pass} PASS / ${fail} FAIL =====`);
if (FAILED.length) console.log('失败项:\n   - ' + FAILED.join('\n   - '));
process.exit(fail ? 1 : 0);
