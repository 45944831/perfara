'use strict';
/**
 * FPS / Jank 判定算法离线回归测试。
 * 背景：真机（Android 13）实测发现 detectVsync 取直方图最大桶，
 * 在锁 30fps 的游戏上把 60Hz 屏误判为 vsync=33ms，导致 Jank/TinyJank 恒为 0。
 * 本测试锁定修复后的口径：既要能识别真实卡顿，又不能把锁帧场景整体误报。
 *
 * 用法: node jank_algo_test.js
 */
const A = require('../../../_client_src/app/src/adb').__algo;

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; fails.push(name); console.log(`  FAIL  ${name}  ${detail !== undefined ? JSON.stringify(detail) : ''}`); }
}

// 用 buckets 构造 histogram 对象 { ms: count }
function H(obj) { return obj; }

console.log('\n===== FPS / Jank 算法回归 =====\n');

// ── 1. vsync 判定：优先刷新率 ────────────────────────────────────────────────
console.log('-- detectVsync 以屏幕刷新率为准 --');
check('60Hz → 16ms', A.detectVsync(H({ 33: 929, 16: 501, 50: 7 }), 60) === 16,
  A.detectVsync(H({ 33: 929, 16: 501, 50: 7 }), 60));
check('90Hz → 11ms', A.detectVsync(H({ 11: 900, 22: 100 }), 90) === 11,
  A.detectVsync(H({ 11: 900, 22: 100 }), 90));
check('120Hz → 8ms', A.detectVsync(H({ 8: 900, 16: 100 }), 120) === 8,
  A.detectVsync(H({ 8: 900, 16: 100 }), 120));
check('30Hz → 33ms', A.detectVsync(H({ 33: 900 }), 30) === 33,
  A.detectVsync(H({ 33: 900 }), 30));

// ── 2. vsync 兜底：不得把 2×vsync 的最大桶当成 vsync ─────────────────────────
console.log('-- detectVsync 无刷新率时的兜底 --');
// 真实数据：锁 30fps 游戏在 60Hz 屏上，33ms 桶最多但 16ms 桶同样显著
const lock30 = H({ 16: 501, 17: 0, 32: 1, 33: 929, 34: 0, 50: 7 });
check('锁 30fps（60Hz 屏）不误判为 33ms', A.detectVsync(lock30) === 16, A.detectVsync(lock30));
// 纯 60fps 渲染
const pure60 = H({ 16: 1000, 17: 20, 33: 5 });
check('纯 60fps → 16ms', A.detectVsync(pure60) === 16, A.detectVsync(pure60));
// 纯锁 30fps（无 16ms 桶）：无法分辨，但不应崩
const only33 = H({ 33: 500 });
check('仅 33ms 桶时有合理输出', A.detectVsync(only33) > 0, A.detectVsync(only33));
check('空直方图的默认值', A.detectVsync(H({})) === 16, A.detectVsync(H({})));

// ── 3. Jank：真实卡顿必须被抓到 ────────────────────────────────────────────
console.log('-- analyseHistogram 识别真实卡顿 --');
// 60fps 稳定 + 3 次 250ms 长卡顿
const withStall = A.analyseHistogram(H({ 16: 600, 17: 50, 250: 3 }), 16);
console.log('   结果 =', JSON.stringify(withStall));
check('250ms 卡顿计入 bigJank', withStall.bigJank === 3, withStall);
check('250ms 卡顿计入 jank', withStall.jank === 3, withStall);
check('250ms 卡顿计入 smallJank', withStall.smallJank === 3, withStall);
check('250ms 卡顿计入 tinyJank', withStall.tinyJank === 3, withStall);
check('jank ≤ tinyJank（层级成立）', withStall.jank <= withStall.tinyJank, withStall);
check('bigJank ≤ jank（层级成立）', withStall.bigJank <= withStall.jank, withStall);

// 中等卡顿：120ms 帧应计 jank 但不计 bigJank（未过 125ms）
const mid = A.analyseHistogram(H({ 16: 600, 120: 2 }), 16);
console.log('   120ms 结果 =', JSON.stringify(mid));
check('120ms 计入 jank', mid.jank === 2, mid);
check('120ms 不计入 bigJank（<125ms）', mid.bigJank === 0, mid);

// ── 4. Jank：锁帧场景不得整体误报 ──────────────────────────────────────────
console.log('-- analyseHistogram 锁帧场景不误报 --');
const stable30 = A.analyseHistogram(H({ 16: 501, 33: 929, 50: 7 }), 16);
console.log('   锁 30fps =', JSON.stringify(stable30));
check('稳定锁 30fps 不计 jank', stable30.jank === 0, stable30);
check('稳定锁 30fps 不计 bigJank', stable30.bigJank === 0, stable30);
check('稳定锁 30fps tinyJank 不应等于全部帧', stable30.tinyJank < stable30.totalFrames,
  { tinyJank: stable30.tinyJank, totalFrames: stable30.totalFrames });

const stable60 = A.analyseHistogram(H({ 16: 1000, 17: 30 }), 16);
console.log('   稳定 60fps =', JSON.stringify(stable60));
check('稳定 60fps 不计 jank', stable60.jank === 0, stable60);
check('稳定 60fps 不计 tinyJank', stable60.tinyJank === 0, stable60);

// ── 5. 阈值常量与文案一致 ──────────────────────────────────────────────────
console.log('-- PerfDog 阈值常量 --');
check('Jank 绝对门槛 ≈83.34ms', Math.abs(A.MOVIE_FRAME_X2_MS - 83.3333) < 0.01, A.MOVIE_FRAME_X2_MS);
check('BigJank 绝对门槛 =125ms', Math.abs(A.MOVIE_FRAME_X3_MS - 125) < 0.01, A.MOVIE_FRAME_X3_MS);

// ── 6. histDelta 增量正确性 ────────────────────────────────────────────────
console.log('-- histDelta --');
const d = A.histDelta(H({ 16: 100, 33: 50 }), H({ 16: 130, 33: 55 }));
check('只保留正向增量', d[16] === 30 && d[33] === 5, d);
check('负增量被丢弃', A.histDelta(H({ 16: 100 }), H({ 16: 90 }))[16] === undefined,
  A.histDelta(H({ 16: 100 }), H({ 16: 90 })));

// ── 7. calcJankFramestats 口径 ─────────────────────────────────────────────
// 帧间隔取「相邻 Vsync 差值」；completed 只表示渲染完成时刻。
// 真机上 completed − vsync 恒 ≈33.6ms（三缓冲呈现延迟），与帧节奏无关 —— 构造数据必须
// 同时给出这两个量，才能复现真机形态。
console.log('-- calcJankFramestats --');

// 构造器：intervals 为相邻帧的 vsync 间隔（ms），latency 为呈现延迟（ms）
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

// 7.1 真机实测形态：60Hz 稳定渲染，呈现延迟恒 33.6ms
//     旧实现 ft = completed−vsync = 33.6ms ≥ 25ms → TinyJank = 总帧数（本次修复的核心场景）
const real60 = mkFrames(new Array(40).fill(16.67), 33.6);
const r60 = A.calcJankFramestats(real60);
console.log('   60Hz+33.6ms 延迟 =', JSON.stringify(r60));
check('呈现延迟不被当成帧间隔（TinyJank=0）', r60.tinyJank === 0, r60);
check('稳定 60Hz 不误报 jank', r60.jank === 0, r60);
check('稳定 60Hz 不误报 bigJank', r60.bigJank === 0, r60);
// 41 帧 → 40 个帧间隔，判定从第 4 个间隔开始 → 37 次
check('evaluated 反映实际判定帧数', r60.evaluated === real60.length - 4, r60);

// 7.2 锁 30fps 游戏：帧间隔 33.3ms，延迟同为 33.6ms
//     若基准仍按 16.67ms 算（阈值 25ms），全部帧都会被判微卡顿
const lock30Frames = mkFrames(new Array(30).fill(33.3), 33.6);
const l30 = A.calcJankFramestats(lock30Frames);
console.log('   锁 30fps =', JSON.stringify(l30));
check('锁 30fps 不整体误报 tinyJank', l30.tinyJank === 0, l30);
check('锁 30fps 不计 jank', l30.jank === 0, l30);

// 7.3 真实长卡顿：vsync 直接跳过 200ms，必须被抓到
const hitch = mkFrames([...new Array(10).fill(16.67), 200, ...new Array(10).fill(16.67)]);
const hj = A.calcJankFramestats(hitch);
console.log('   200ms 卡顿 =', JSON.stringify(hj));
check('200ms 帧计为 jank', hj.jank >= 1, hj);
check('200ms 帧计为 bigJank', hj.bigJank >= 1, hj);
check('200ms 帧计为 smallJank', hj.smallJank >= 1, hj);
check('200ms 帧计为 tinyJank', hj.tinyJank >= 1, hj);
check('卡顿只计一次，不连坐相邻帧', hj.jank <= 2, hj);

// 7.4 层级关系：bigJank ≤ jank ≤ tinyJank
check('bigJank ≤ jank', hj.bigJank <= hj.jank, hj);
check('jank ≤ tinyJank', hj.jank <= hj.tinyJank, hj);

// 7.5 同一 vsync 内提交多帧（vsync 值重复）不应造出 0ms 假间隔
const dup = [];
let td = 1e9;
for (let i = 0; i < 20; i++) {
  dup.push({ vsync: td, completed: td + 33.6e6 });
  dup.push({ vsync: td, completed: td + 34.6e6 }); // 同 vsync 第二帧
  td += 16.67e6;
}
const dj = A.calcJankFramestats(dup);
console.log('   重复 vsync =', JSON.stringify(dj));
check('重复 vsync 去重后不产生 jank', dj.jank === 0, dj);
check('重复 vsync 去重后不产生 tinyJank', dj.tinyJank === 0, dj);

// 7.6 帧数不足时安全返回
const few = A.calcJankFramestats(mkFrames([16.67, 16.67]));
check('帧数不足时全部为 0', few.jank === 0 && few.tinyJank === 0 && few.evaluated === 0, few);

console.log(`\n===== 结果: ${pass} PASS / ${fail} FAIL =====`);
if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
process.exit(fail ? 1 : 0);
