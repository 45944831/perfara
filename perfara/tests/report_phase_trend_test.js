'use strict';

/**
 * 报告「时段趋势」解读守卫（离线，不需要浏览器）。
 *
 * 背景（2026-11-19 报告解读优化）：
 *   buildInsight 只有整段均值视角，真机报告里 16:41 后 FPS 从 ~38 掉到 ~20、
 *   全程均值仍显示 29.5 —— 后段劣化被均值掩盖，用户看不出「后半段明显变差」。
 *
 * 优化：新增纯函数 iPhaseTrend(fps, dropRatio, minDropFps) 比较前后半均值，
 * 显著劣化（≥20% 且绝对差≥5fps）时，在分项解读和风险提示两处同步点出。
 *
 * 本测试从产品 perf.html 提取真实函数验证（不测副本），并静态守卫两处接线同步。
 * 用法: node perfara/tests/report_phase_trend_test.js
 */
const fs = require('fs');
const path = require('path');

const PERF = path.resolve(__dirname, '..', '..', 'perfara', 'collector', 'resources', 'reports', 'perf.html');
const src = fs.readFileSync(PERF, 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log(' FAIL  ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : '')); }
}

console.log('\n===== 报告时段趋势解读（P-解读优化） =====\n');

// 用大括号配平从源码提取函数（与 fps_curve_continuity_test.js 同法）
function extractFn(source, name) {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) return null;
  let i = source.indexOf('{', start), depth = 0, end = -1;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  return end < 0 ? null : source.slice(start, end);
}

const fnSrc = extractFn(src, 'iPhaseTrend');
const numsSrc = extractFn(src, 'iNums');
check('perf.html 中存在 iPhaseTrend 函数', !!fnSrc);
check('perf.html 中存在 iNums 函数', !!numsSrc);

let iPhaseTrend = null;
if (fnSrc && numsSrc) {
  // eslint-disable-next-line no-new-func
  iPhaseTrend = new Function(numsSrc + '\n' + fnSrc + '\nreturn iPhaseTrend;')();
}

if (iPhaseTrend) {
  // 样本不足 → 不给结论（避免制造趋势）
  check('少于 10 点返回 null', iPhaseTrend([30, 28, 26]) === null);
  check('空数组返回 null', iPhaseTrend([]) === null);
  check('恰好 10 点（每半5点）可判定', iPhaseTrend([40, 40, 40, 40, 40, 20, 20, 20, 20, 20]) !== null);

  // 平稳序列：不判显著
  const flat = iPhaseTrend(Array.from({ length: 40 }, () => 30));
  check('全程平稳不判显著', flat && flat.significant === false, flat);
  check('全程平稳 dropPct≈0', flat && Math.abs(flat.dropPct) < 0.001, flat);

  // 后段劣化：判显著（复刻真机报告形态：前段 ~38，后段 ~20）
  const degraded = iPhaseTrend([...Array(20).fill(38), ...Array(20).fill(20)]);
  check('前38→后20 判显著劣化', degraded && degraded.significant === true, degraded);
  check('前38→后20 dropPct≈47%', degraded && Math.abs(degraded.dropPct - 47.37) < 1, degraded);
  check('前38→后20 dropAbs=18', degraded && Math.abs(degraded.dropAbs - 18) < 0.001, degraded);

  // 后段变好：不报劣化（dropPct 为负）
  const better = iPhaseTrend([...Array(20).fill(20), ...Array(20).fill(38)]);
  check('后段变好不判劣化', better && better.significant === false, better);

  // 小幅下降（<20% 或 <5fps）：不报
  const tiny = iPhaseTrend([...Array(20).fill(30), ...Array(20).fill(28)]);
  check('小幅下降不判显著（绝对差<5）', tiny && tiny.significant === false, tiny);
  const smallPct = iPhaseTrend([...Array(20).fill(30), ...Array(20).fill(26)]);
  check('下降13%但绝对差=4<5 不判显著', smallPct && smallPct.significant === false, smallPct);

  // 自定义阈值
  const custom = iPhaseTrend([...Array(20).fill(30), ...Array(20).fill(27)], 0.05, 2);
  check('自定义阈值(5%,2fps)可判显著', custom && custom.significant === true, custom);

  // null/NaN 被 iNums 过滤，不污染前后半均值
  const withNull = iPhaseTrend([40, null, 40, NaN, 40, 40, 40, 20, null, 20, 20, 20, 20, 20]);
  check('null/NaN 被过滤后仍能判定', withNull && withNull.early > withNull.late, withNull);
}

// ── 接线守卫：分项 + 风险两处都必须用 phase.significant（同步，防自相矛盾）──
const phaseCalc = /const phase = iPhaseTrend\(iNums\(fpsCol\)\);/;
check('buildInsight 计算 phase', phaseCalc.test(src));
check('phase 暴露到 out（out.phaseTrend = phase）', /out\.phaseTrend\s*=\s*phase/.test(src));
const significantUses = (src.match(/phase\s*&&\s*phase\.significant/g) || []).length;
check('分项与风险两处都用 phase.significant 守卫（>=2）', significantUses >= 2, significantUses);
check('分项 push 了「时段趋势」条目', /push\('时段趋势'/.test(src));
check('风险文案点出「全程均值掩盖」', /全程均值掩盖了这次劣化/.test(src));

console.log('\n===== 结果: ' + pass + ' PASS / ' + fail + ' FAIL =====\n');
process.exitCode = fail ? 1 : 0;
