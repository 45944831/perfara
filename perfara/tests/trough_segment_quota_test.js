'use strict';

/**
 * 低谷截图「分段配额」守卫（离线，不需要真机）。
 *
 * 背景（2026-11-19 采集参数优化 P2b）：
 *   真实报告 30 张低谷截图全集中在前 11 分钟，16:41 的场景切换拐点
 *   （FPS ~38 → ~20）没有一张截图可归因 —— 全局 maxShots 被前段用光。
 *
 * 策略：
 *   TroughDetector 新增可选 segmentSamples/perSegment。启用后每 segmentSamples 拍
 *   最多 perSegment 张，前段不再耗尽后段额度；全局 maxShots 仍作硬上限兜底。
 *   默认 segmentSamples=0 关闭 → 行为与旧版完全一致（旧单测全绿）。
 *
 * 用法: node perfara/tests/trough_segment_quota_test.js
 */
const fs = require('fs');
const path = require('path');
const { TroughDetector, DEFAULTS } = require(
  path.resolve(__dirname, '..', '..', '_client_src', 'app', 'src', 'trough-detector.js'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log(' FAIL  ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : '')); }
}

console.log('\n===== 低谷截图分段配额（P2b） =====\n');

check('DEFAULTS 默认关闭分段（segmentSamples=0）', DEFAULTS.segmentSamples === 0);
check('DEFAULTS perSegment 为正', DEFAULTS.perSegment > 0);

// 构造"跌落→截图"序列：先 10 拍正常 60，再若干拍低 30（带 jank 避免被静置过滤）。
// 冷却设 0，让段配额成为唯一限制（隔离 cooldown 影响）。
const JAM = { jank: 3, bigJank: 1, smallJank: 2, tinyJank: 4, jankRate: 0.2 };
function dropSeries(normalCount, lowCount) {
  const out = [];
  for (let i = 0; i < normalCount; i++) out.push([60, JAM]);
  for (let i = 0; i < lowCount; i++) out.push([30, JAM]);
  return out;
}
function feed(d, list, startTs) {
  const hits = [];
  list.forEach((it, i) => {
    const h = d.push(it[0], (startTs || 0) + i * 1000, it[1]);
    if (h) hits.push(h);
  });
  return hits;
}

// ── 默认行为不变（与旧版逐点一致）──────────────────────────────────────────
// 默认上限/冷却/稳态等断言由既有的 trough_shots_test.js 完整覆盖；
// 这里只锁「分段关闭时 _segmentAllows 不影响任何 shot 计数」这一条接线事实。
{
  const d = new TroughDetector({ cooldownMs: 500 });
  const list = [...Array(10).fill(0).map(() => [60, JAM]), [30, JAM], [30, JAM]];
  const hits = feed(d, list, 1_000_000);
  check('默认构造：连续2拍跌落仍触发且只截一张（与旧版一致）', hits.length === 1, hits.length);
}

// ── 分段配额生效：每段最多 perSegment 张 ────────────────────────────────────
{
  // segmentSamples=20，perSegment=2。构造 4 个段（80 拍），每段内反复跌落。
  // 每段应最多 2 张；总全局上限设很高（100）以隔离 maxShots。
  const d = new TroughDetector({ maxShots: 100, cooldownMs: 0, segmentSamples: 20, perSegment: 2 });
  const list = [];
  for (let seg = 0; seg < 4; seg++) {
    // 每段 20 拍：3 正常 + 跌落若干 + 填充，制造多次"恢复→跌落"
    for (let cyc = 0; cyc < 5; cyc++) {
      list.push(...dropSeries(2, 2)); // 4 拍一个循环
    }
  }
  const hits = feed(d, list);
  // 直接读 detector 内部按段记录的配额表（最精确的判据，与放行逻辑同源）
  const segCounts = d._shotSegmentCounts;
  check('启用分段后产生截图', hits.length > 0, hits.length);
  check('分段总张数 < 全局 maxShots=100（段配额先于全局上限生效）', hits.length < 100, hits.length);
  let allWithinQuota = true;
  for (const [seg, cnt] of segCounts) if (cnt > 2) allWithinQuota = false;
  check('每个样本段截图数 <= perSegment(2)', allWithinQuota, Object.fromEntries(segCounts));
  check('截图分布在多个段（后段不再被前段用光）', segCounts.size >= 2, Object.fromEntries(segCounts));
  check('内部记录段数与总截图数一致',
    [...segCounts.values()].reduce((a, b) => a + b, 0) === hits.length,
    { segTotal: [...segCounts.values()].reduce((a, b) => a + b, 0), hits: hits.length });
}

// ── 纯逻辑：_segmentAllows / _recordSegmentShot ─────────────────────────────
{
  const d = new TroughDetector({ segmentSamples: 10, perSegment: 2 });
  d._fps = new Array(5).fill(60);  // 段 0
  check('段0 初始允许', d._segmentAllows() === true);
  d._recordSegmentShot(); d._recordSegmentShot();
  check('段0 达配额后拒绝', d._segmentAllows() === false);
  d._fps = new Array(15).fill(60); // 段 1
  check('段1 有独立配额', d._segmentAllows() === true);
  d.reset();
  check('reset 清空段配额', d.shots === 0 && d._shotSegmentCounts.size === 0);
}
{
  const d = new TroughDetector(); // 关闭分段
  d._fps = new Array(999).fill(60);
  d._recordSegmentShot(); d._recordSegmentShot(); d._recordSegmentShot();
  check('分段关闭时 _segmentAllows 恒为 true', d._segmentAllows() === true);
}

// ── 源码守卫：beginRun 已启用分段配额 ──────────────────────────────────────
const shotsSrc = fs.readFileSync(
  path.resolve(__dirname, '..', '..', '_client_src', 'app', 'src', 'trough-shots.js'), 'utf8');
check('beginRun 传 maxShots/segmentSamples/perSegment',
  /new TroughDetector\(\{\s*maxShots:\s*\d+,\s*segmentSamples:\s*\d+,\s*perSegment:\s*\d+/.test(shotsSrc));
const detSrc = fs.readFileSync(
  path.resolve(__dirname, '..', '..', '_client_src', 'app', 'src', 'trough-detector.js'), 'utf8');
check('两处截图放行点都过 _segmentAllows', (detSrc.match(/_segmentAllows\(\)/g) || []).length >= 3);
check('两处成功后都记 _recordSegmentShot', (detSrc.match(/_recordSegmentShot\(\)/g) || []).length >= 2);

console.log('\n===== 结果: ' + pass + ' PASS / ' + fail + ' FAIL =====\n');
process.exitCode = fail ? 1 : 0;
