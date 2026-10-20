'use strict';
/**
 * FPS / Jank 判定算法离线回归测试。
 * 背景：真机（Android 13 中端机型 / Android 13）实测发现 detectVsync 取直方图最大桶，
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
console.log('-- calcJankFramestats --');
// 构造：稳定 16ms 帧 + 一帧 200ms
const frames = [];
let t = 1e9;
for (let i = 0; i < 10; i++) { frames.push({ vsync: t, completed: t + 16e6 }); t += 16e6; }
frames.push({ vsync: t, completed: t + 200e6 });
const fj = A.calcJankFramestats(frames);
console.log('   结果 =', JSON.stringify(fj));
check('200ms 帧计为 jank', fj.jank >= 1, fj);
check('200ms 帧计为 bigJank', fj.bigJank >= 1, fj);
check('稳定帧不误报 jank（无多余计数）', fj.jank <= 2, fj);

const stableFrames = [];
let t2 = 1e9;
for (let i = 0; i < 30; i++) { stableFrames.push({ vsync: t2, completed: t2 + 16e6 }); t2 += 16e6; }
const sj = A.calcJankFramestats(stableFrames);
console.log('   稳定帧 =', JSON.stringify(sj));
check('全稳定帧 jank=0', sj.jank === 0, sj);
check('全稳定帧 bigJank=0', sj.bigJank === 0, sj);

console.log(`\n===== 结果: ${pass} PASS / ${fail} FAIL =====`);
if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
process.exit(fail ? 1 : 0);
