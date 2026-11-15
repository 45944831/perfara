'use strict';
/**
 * 采集时间基准守卫：所有「速率类」指标的分母 dt 必须走单调时钟。
 *
 * 背景（真实缺陷）：网络 KB/s、FPS、gfxinfo 帧增量的 dt 都用
 * `Math.max((Date.now() - prev.ts) / 1000, 下限)` 计算。Windows 时间同步 /
 * 用户改系统时间一旦把墙钟回拨，差值变成负数并被夹到下限（0.1s / 0.5s），
 * 而计数器增量仍是真实增长 —— 读数被凭空放大 2~10 倍，且偶发尖峰会污染
 * 峰值统计、1% Low 与报告结论。
 *
 * 修复：dt 一律用 monoMs()（process.hrtime.bigint 毫秒）；墙钟只保留给
 * 展示时间戳与「15s 重试节流」这类真的需要日期时间的语义。
 *
 * 全部离线，不依赖真机与 adb。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ADB_PATH = path.join(ROOT, '_client_src', 'app', 'src', 'adb.js');
const ADB = require(ADB_PATH);
const algo = ADB.__algo;

let pass = 0, fail = 0;
const FAILED = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; FAILED.push(name); console.log('  FAIL  ' + name + '  -> ' + JSON.stringify(detail)); }
}

const src = fs.readFileSync(ADB_PATH, 'utf8');

console.log('\n-- 单调时钟本身 --');
{
  check('monoMs 已导出供离线断言', typeof algo.monoMs === 'function', typeof algo.monoMs);

  const a = algo.monoMs();
  check('monoMs 返回有限数值', Number.isFinite(a), a);

  // 单调性：连续 1000 次调用不得回退（分辨率不足时允许相等）
  let prev = algo.monoMs();
  let regress = 0;
  for (let i = 0; i < 1000; i++) {
    const cur = algo.monoMs();
    if (cur < prev) regress++;
    prev = cur;
  }
  check('连续 1000 次调用无回退', regress === 0, regress);

  // 分辨率：两次调用间隔至少 1ms 时应能分辨（忙等 5ms）
  const t0 = algo.monoMs();
  while (algo.monoMs() - t0 < 5) { /* busy wait */ }
  check('5ms 忙等可被分辨（分辨率 <= 5ms）', algo.monoMs() - t0 >= 5, algo.monoMs() - t0);

  // 量级校验：hrtime 是「系统/进程启动以来的时长」，绝对值与 Unix 时间戳无关，
  // 但必须是毫秒量级 —— 误用纳秒会大 1e6 倍（dt 全部缩小、速率爆表），
  // 误用秒会小 1e3 倍（dt 全部放大、速率归零）。
  const mono = algo.monoMs();
  check('量级是毫秒（1 秒 ~ 300 年区间，排除纳秒/秒）',
    mono > 1e4 && mono < 1e13, mono);
  check('不是纳秒量级', mono < 1e15, mono);
}

console.log('\n-- 源码不再用墙钟做 dt 分母 --');
{
  // 旧写法：Math.max((now - prev.ts) / 1000, 0.1) / 0.5 —— 回拨时会把速率放大。
  // 只看代码行：monoMs 的文档注释里刻意保留了这个反例字符串，不能算命中。
  const codeLines = src.split(/\r?\n/)
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const wallDt = /Math\.max\(\s*\(\s*now\s*-\s*prev\.ts\s*\)\s*\/\s*1000\s*,/;
  const hits = codeLines.filter(l => wallDt.test(l));
  check('代码中不存在 Math.max((now - prev.ts)/1000, …) 墙钟兜底',
    hits.length === 0, hits);

  check('getNetStats 的读回时刻用 monoMs', /const readAt = monoMs\(\)/.test(src));
  check('getFps 定义了 mono 基准', /const mono = monoMs\(\)/.test(src));
  check('timestats 的 dt 用 prev.mono', /prev\.mono != null \? mono - prev\.mono/.test(src));
  // 只钉住意图：第 3 个实参必须是 mono（窗口过期判定与 fps 的 dt 同一基准）。
  // 第 4 个实参是「有效采样间隔」，变量名会随实现调整（intervalMs → effInterval），
  // 写死名字会让守卫在纯重命名时误报，反而掩盖真正的墙钟回流。
  check('framestats 窗口用 mono 判定',
    /selectFramestatsWindow\(\s*frames\s*,\s*_fsState\.get\(key\)\s*,\s*mono\s*,\s*[A-Za-z_$][\w$]*\s*\)/.test(src));
  check('gfxTotalDelta 由调用方传 mono', /gfxTotalDelta\(out, key, mono, log\)/.test(src));
  check('gfxTotalDelta 对非正 dt 返回 null', /const dtMs = now - gPrev\.ts;[\s\S]{0,120}if \(!\(dtMs > 0\)\) return null;/.test(src));
  check('getNetStats 对非正 dt 返回 null 而非夹下限',
    /const dtMs = readAt - prev\.ts;[\s\S]{0,200}if \(!\(dtMs > 0\)\)/.test(src));
  check('timestats 对非正间隔报 no-frames 并重建基线',
    /if \(!\(dtMs > 0\)\)[\s\S]{0,220}method: 'no-frames'/.test(src));
}

console.log('\n-- 墙钟仍保留在「需要真实日期时间」的位置 --');
{
  // 15s 重试节流要的是「距上次尝试多久」的真实时间，用墙钟是对的
  check('timestats 15s 节流仍用 Date.now', /skipUntil = Date\.now\(\) \+ TIMESTATS_SKIP_TICKS/.test(src));
  check('getFps 仍保留 now = Date.now() 供节流', /const now = Date\.now\(\);/.test(src));
  // 采样点的展示时间戳仍是墙钟
  const collectorSrc = fs.readFileSync(
    path.join(ROOT, '_client_src', 'app', 'src', 'collector.js'), 'utf8');
  check('采样点 timestamp 仍是墙钟（展示用）', /timestamp:\s+Date\.now\(\)/.test(collectorSrc));
}

console.log('\n-- framestats 窗口对异常 dt 的既有保护 --');
{
  const frames = [
    { vsync: 1e9, completed: 1 }, { vsync: 1.016e9, completed: 2 },
    { vsync: 1.033e9, completed: 3 }, { vsync: 1.05e9, completed: 4 },
  ];
  const prev = { ts: 5000, lastCompleted: 2, tail: [] };
  // 传一个比 prev.ts 更小的 now（模拟回拨）：应判 stale-window 而不是算出负 dt
  const w = algo.selectFramestatsWindow(frames, prev, 4000, 1000);
  check('now < prev.ts 时判为 stale-window（不出负 dt）',
    w.usable === false && w.reason === 'stale-window', { usable: w.usable, reason: w.reason });
  const ok = algo.selectFramestatsWindow(frames, prev, 6000, 1000);
  check('正常间隔仍可用', ok.usable === true && ok.dt === 1, { usable: ok.usable, dt: ok.dt });
}

console.log(`\n===== 时间基准守卫测试结果: ${pass} PASS / ${fail} FAIL =====`);
if (FAILED.length) console.log('失败项:\n   - ' + FAILED.join('\n   - '));
process.exit(fail ? 1 : 0);
