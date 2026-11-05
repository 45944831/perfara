'use strict';
/**
 * 性能参数「错误采集」专项离线回归。
 *
 * 背景：上一轮修的是「没测到却写 0」的语义问题；这一轮复查的是**参数本身算错**：
 *   ① /proc/<pid>/stat 的 comm 含空格 → utime/stime 下标错位 → 假 100% CPU
 *   ② 逐核使用率按下标对比 → 核心热插拔时拿 A 核基线减 B 核累计 → 假曲线
 *   ③ gpubusy 的 busy/total 是开机至今累计比率 → 冒充当前区间 GPU 利用率
 *   ④ gfxinfo framestats 是滚动窗口 → 旧帧被反复计入、窗口平均冒充这一秒 FPS
 *   ⑤ Jank 家族被 perSec() 额外除以 dt → 与「帧」标签 / Jank/10min / iOS·PC 通道冲突
 *   ⑥ sysfs 温度十分度值被整段丢弃；thermalservice die-only 时丢失结温
 *
 * 全部用纯函数 + 源码断言验证，不依赖真机、不启动 adb。
 * 用法: node perf_param_audit_test.js
 */
const fs = require('fs');
const path = require('path');
const ADB = require('../../../_client_src/app/src/adb');
const algo = ADB.__algo;

const ROOT = path.join(__dirname, '../../..');
const readSrc = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; fails.push(name); console.log(`  FAIL  ${name}  ${detail !== undefined ? JSON.stringify(detail) : ''}`); }
}

// ─── ① /proc/<pid>/stat 的 comm 含空格 ────────────────────────────────────────
console.log('\n===== 性能参数错误采集专项 =====\n');
console.log('-- ① 进程 CPU：comm 含空格 / 右括号时字段错位 --');

// 字段：pid (comm) state ppid pgrp session tty_nr tpgid flags minflt cminflt
//       majflt cmajflt utime stime priority nice ...
// ')' 后 rest[11]=utime(第14字段), rest[12]=stime(第15字段)
const STAT_TAIL = 'S 100 100 0 0 -1 1077952832 1000 0 0 0 250 80 20 0 1 0';
const statLine = (comm) => `1234 (${comm}) ${STAT_TAIL}`;

check('普通 comm 取到 utime=250 / stime=80 → 330',
  algo.parsePidStat(statLine('com.foo.bar')) === 330, algo.parsePidStat(statLine('com.foo.bar')));
check('comm 含空格仍取到 330（旧写法会错位成 250）',
  algo.parsePidStat(statLine('Render Thread')) === 330, algo.parsePidStat(statLine('Render Thread')));
check('comm 含右括号仍取到 330（必须用 lastIndexOf）',
  algo.parsePidStat(statLine('foo) bar')) === 330, algo.parsePidStat(statLine('foo) bar')));
check('字段被截断时返回 null，不拿错误下标硬算',
  algo.parsePidStat('1234 (x) S 1 2') === null);
check('没有 comm 括号 / 空输入返回 null',
  algo.parsePidStat('1234 S 1 2') === null && algo.parsePidStat('') === null);

// 旧算法复现，证明这条修复不是空转
function legacyPidStat(raw) {
  const p = raw.trim().split(/\s+/);
  const u = parseInt(p[13], 10), s = parseInt(p[14], 10);
  return (isFinite(u) && isFinite(s)) ? u + s : null;
}
check('旧 split 下标算法在含空格 comm 上确实算错（反例成立）',
  legacyPidStat(statLine('Render Thread')) !== 330, legacyPidStat(statLine('Render Thread')));

// ─── ② 逐核使用率按 cpuN 名称配对 ────────────────────────────────────────────
console.log('\n-- ② 逐核 CPU：核心热插拔时不能按下标配对 --');
const pair = algo.pairCoreUsage;
const prevCores = {
  ids: ['cpu0', 'cpu1', 'cpu2'],
  cores: [{ idle: 100, total: 200 }, { idle: 10, total: 20 }, { idle: 50, total: 100 }],
  ts: 0,
};
const currCores = {
  ids: ['cpu0', 'cpu1', 'cpu2'],
  cores: [{ idle: 110, total: 230 }, { idle: 15, total: 30 }, { idle: 60, total: 130 }],
  ts: 1000,
};
check('首帧全部为 null（未测量，不是 0%）',
  pair(null, currCores).every(v => v === null), pair(null, currCores));
check('核心集合不变时按名字算出 [67,50,67]',
  JSON.stringify(pair(prevCores, currCores)) === JSON.stringify([67, 50, 67]),
  pair(prevCores, currCores));

// cpu1 下线：curr 的第 2 个元素其实是 cpu2
const offline = {
  ids: ['cpu0', 'cpu2'],
  cores: [{ idle: 110, total: 230 }, { idle: 60, total: 130 }],
  ts: 1000,
};
const offUsage = pair(prevCores, offline);
check('中间核心下线后 cpu2 仍用自己的基线（67%），不串到 cpu1',
  offUsage[1] === 67, offUsage);
const legacyUsage = offline.cores.map((c, i) => {
  const p = prevCores.cores[i];
  const td = c.total - p.total, id = c.idle - p.idle;
  return td > 0 ? Math.round(((td - id) / td) * 100) : null;
});
check('旧按下标算法确实给出不同的错误值（反例成立）',
  legacyUsage[1] !== 67, legacyUsage);
check('新上线核心没有基线 → null',
  pair(prevCores, { ids: ['cpu0', 'cpu1', 'cpu2', 'cpu3'],
    cores: [...currCores.cores, { idle: 1, total: 9 }], ts: 1000 })[3] === null);
check('计数器回绕 → null',
  pair(prevCores, { ids: ['cpu0', 'cpu1', 'cpu2'],
    cores: [{ idle: 1, total: 2 }, { idle: 1, total: 2 }, { idle: 1, total: 2 }], ts: 1000 })[0] === null);

// ─── ③ GPU 累计比率 vs 区间利用率 ────────────────────────────────────────────
console.log('\n-- ③ GPU：gpubusy 是累计计数，必须做 delta --');
const parseBusy = algo.parseGpuBusyCounters;
const deltaPct = algo.gpuBusyDeltaPct;
const c1 = parseBusy('1000 10000');
const c2 = parseBusy('2000 11000');
check('累计比率只有 10%（开机至今平均）',
  algo.interpretGpuProbe('kgsl_busy', '1000 10000') === 10);
check('但本采样区间实际是 100% 占用',
  deltaPct(c1, c2) === 100, deltaPct(c1, c2));
check('零负载区间返回 0%（真实测量值）',
  deltaPct(c2, parseBusy('2000 12000')) === 0);
check('首帧无基线返回 null，不编造 0%',
  deltaPct(null, c1) === null);
check('计数器重置 / 设备重启返回 null',
  deltaPct(c2, parseBusy('10 100')) === null);
check('busy 增量超过 total 增量返回 null',
  deltaPct(c2, parseBusy('9000 11000')) === null);
check('空文本 / 单列 / 非数字返回 null',
  parseBusy('') === null && parseBusy('42') === null && parseBusy('a b') === null);

// ─── ④ framestats 滚动窗口只取本周期新帧 ─────────────────────────────────────
console.log('\n-- ④ FPS：PROFILEDATA 滚动窗口不再重复计入旧帧 --');
const STEP = 16666667; // 60Hz vsync ≈ 16.67ms (ns)
const mkFrame = (n) => ({ vsync: n * STEP, completed: n * STEP + 5000000 });
const win = algo.selectFramestatsWindow;
const first = Array.from({ length: 60 }, (_, i) => mkFrame(i + 1));
const t1 = 1000000;
const w1 = win(first, undefined, t1, 1000);
check('首帧不可用且标记为 init',
  !w1.usable && w1.reason === 'init', w1.reason);
check('首帧快照保留窗口末尾时间戳',
  w1.state.lastCompleted === first[59].completed);
check('首帧快照只留最后 4 帧做下一周期基准',
  w1.state.tail.length === 4);

// 第二次采样：窗口滚动，21~60 是旧帧，61~80 是本周期新帧
const second = Array.from({ length: 60 }, (_, i) => mkFrame(i + 21));
const w2 = win(second, w1.state, t1 + 1000, 1000);
check('只挑出本周期 20 帧，旧 40 帧不重复计入',
  w2.usable && w2.frames.length === 20, w2.frames.length);
check('新帧全部来自 61~80',
  w2.frames[0].vsync === 61 * STEP && w2.frames[19].vsync === 80 * STEP);
check('dt 为真实采样间隔 1s', w2.dt === 1, w2.dt);
check('旧实现会拿整个 60 帧窗口算 fps（反例：窗口长度 ≠ 新帧数）',
  second.length !== w2.frames.length);
const w3 = win(second, w2.state, t1 + 2000, 1000);
check('本周期无新帧 → no-frames，交给 gfxinfo 增量',
  !w3.usable && w3.reason === 'no-frames', w3.reason);
const w4 = win(second, w2.state, t1 + 11000, 1000);
check('中途切通道 / tick 被跳过导致窗口过期 → stale-window',
  !w4.usable && w4.reason === 'stale-window', w4.reason);

// ─── ⑤ calcJankFramestats 的 minVsyncNs 边界 ────────────────────────────────
console.log('\n-- ⑤ Jank：拼接旧帧只作基准，不重复计数 --');
function buildFrames(startNs, gapsMs) {
  let t = startNs;
  const out = [{ vsync: t, completed: t + 5e6 }];
  for (const g of gapsMs) {
    t += Math.round(g * 1e6);
    out.push({ vsync: t, completed: t + 5e6 });
  }
  return out;
}
const MS = 16.667;
const tailFrames = buildFrames(1e12, Array(6).fill(MS));
const neuStart = tailFrames[tailFrames.length - 1].vsync + Math.round(MS * 1e6);
const newFrames = buildFrames(neuStart, [MS, MS, MS, 200, MS, MS]); // 1 个 200ms 卡顿
const allFrames = tailFrames.concat(newFrames);
const withMin = algo.calcJankFramestats(allFrames, newFrames[0].vsync);
const withoutMin = algo.calcJankFramestats(allFrames);
const onlyNew = algo.calcJankFramestats(newFrames);
check('200ms 帧被判为 1 次 Jank',
  withMin.jank === 1 && onlyNew.jank === 1, { withMin, onlyNew });
check('200ms 帧同时是 BigJank / SmallJank / TinyJank',
  withMin.bigJank === 1 && withMin.smallJank === 1 && withMin.tinyJank === 1, withMin);
check('旧帧不进 evaluated 分母（jankRate 不被稀释）',
  withMin.evaluated < withoutMin.evaluated,
  { withMin: withMin.evaluated, withoutMin: withoutMin.evaluated });
check('不传 minVsyncNs 时行为与旧版一致（向后兼容）',
  withoutMin.evaluated === allFrames.length - 4,
  { evaluated: withoutMin.evaluated, frames: allFrames.length });

// ─── ⑥ sysfs 温度单位 ────────────────────────────────────────────────────────
console.log('\n-- ⑥ 温度：sysfs 毫度 / 十分度 / 度 三种口径 --');
const nTemp = algo.normalizeThermalSysfsTemp;
check('标准毫摄氏度 36500 → 36.5°C', nTemp(36500) === 36.5, nTemp(36500));
check('老 ROM 十分度 340 → 34°C（旧版会整段丢弃）', nTemp(340) === 34, nTemp(340));
check('直接摄氏度 36 → 36°C', nTemp(36) === 36, nTemp(36));
check('毫度小值 3650 → 3.65 → 3.7°C', nTemp(3650) === 3.7, nTemp(3650));
check('字符串带空格也能解析', nTemp(' 34000 ') === 34, nTemp(' 34000 '));
check('0 / 负温 / 超量程 / 非法值一律 null',
  [0, -5000, 120000, NaN, 'abc', null].every(v => nTemp(v) === null));

// ─── ⑦ 源码级一致性（防止后续改回去） ───────────────────────────────────────
console.log('\n-- ⑦ 源码一致性：单位 / 状态清理 / 展示层 --');
const adbSrc = readSrc('_client_src/app/src/adb.js');
const collectorSrc = readSrc('_client_src/app/src/collector.js');
const rendererSrc = readSrc('_client_src/app/renderer/renderer.js');
const cssSrc = readSrc('_client_src/app/renderer/style.css');
const perfHtml = readSrc('perfara/collector/resources/reports/perf.html');
const libHtml = readSrc('perfara/collector/resources/reports/library.html');
const injectPy = readSrc('tools/inject_metric_info.py');

check('timestats / framestats 不再用 perSec 归一化 Jank',
  !/perSec\s*\(/.test(adbSrc));
check('getFps 接收 intervalMs 且采集器传入',
  /function getFps\([^)]*intervalMs/.test(adbSrc)
  && /getFps\([^)]*this\.intervalMs/.test(collectorSrc));
check('resetDeviceState 清理 _fsState 与 _gpuBusyState',
  /_fsState,\s*_gpuBusyState/.test(adbSrc) || /_fsState[^\]]*_gpuBusyState/.test(adbSrc));
check('getThermalInfo 在 die-only 时仍保留结温（不再 r.main>0 才返回）',
  /dieOnlySource/.test(adbSrc) && !/if \(r && r\.main > 0\)/.test(adbSrc));
check('客户端 Jank 卡片 null 显示 --，不再折成 0',
  /d\.jank \?\? '--'/.test(rendererSrc) && !/d\.jank \?\? 0/.test(rendererSrc));
check('被关闭的图表 / 卡片确实隐藏',
  /\.chart-wrap\[hidden\]/.test(cssSrc));
for (const [name, src] of [['perf.html', perfHtml], ['library.html', libHtml],
                           ['inject_metric_info.py', injectPy]]) {
  check(`${name} 的 Jank 家族单位统一为「帧」`,
    /jank: \{ t: 'Jank 卡顿帧', u: '帧'/.test(src)
    && /tinyjank: \{ t: 'TinyJank 微卡顿帧', u: '帧'/.test(src));
}
check('报告页不再有「次/s」的 Jank 卡片',
  !/class="card-unit">次\/s<\/div>/.test(perfHtml));
check('Jank/10min 仍按累计次数折算（与「每采样点帧数」自洽）',
  /jank10[\s\S]{0,200}每 10 分钟折算/.test(perfHtml));

console.log('\n──────────────────────────────────────────');
console.log(`  ${pass} PASS / ${fail} FAIL`);
if (fails.length) console.log('  失败项:\n   - ' + fails.join('\n   - '));
console.log('──────────────────────────────────────────\n');
process.exit(fail ? 1 : 0);
