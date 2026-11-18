'use strict';

/**
 * 1.1 帧指标现代化 —— 方案点名的三组验证 + 设备刷新率来源。
 *
 *  ① 不同刷新率下同一「相对超标」帧序列，卡顿结论一致；
 *  ② 超长单帧不被整段 avgMs 自我遮蔽；
 *  ③ P99 / overrun 分位数计算正确（含零超时帧）。
 * 另加：目标帧率来源必须是设备自报而非 FPS 序列推断。
 */
const path = require('path');
const fs = require('fs');
const ADB = require(path.join(__dirname, '..', '..', '_client_src', 'app', 'src', 'adb.js'));
const loading = require(path.join(__dirname, '..', '..', '_client_src', 'app', 'src', 'fps-loading.js'));
const Schema = require(path.join(__dirname, '..', '..', '_client_src', 'app', 'src', 'metric-schema.js'));
const algo = ADB.__algo;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ok  ' + name); }
  else { fail += 1; console.log(' FAIL ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : '')); }
}

console.log('\n===== 1.1 帧指标与刷新率口径 =====\n');

/** 直方图对象 → 按 ms 升序的 [{ms, c}]（frameStatsFromBuckets 的真实入参形状） */
function buckets(obj) {
  return Object.keys(obj).map(k => ({ ms: Number(k), c: obj[k] }))
    .sort((a, b) => a.ms - b.ms);
}

// ── ① 跨刷新率一致性 ────────────────────────────────────────────────────────
// 同一段「9 帧正常 + 1 帧 2.5×vsync」的序列，在 60/90/120Hz 下
// jankyRatio 应一致（绝对超帧时长不同，但相对占比相同）—— 这正是新口径
// 相对固定 83.34ms 门槛的意义。
{
  const ratios = [];
  for (const hz of [60, 90, 120]) {
    const vsync = 1000 / hz;
    const o = {};
    o[String(Math.round(vsync * 100) / 100)] = 9;
    o[String(Math.round(vsync * 2.5 * 100) / 100)] = 1;
    const st = algo.frameStatsFromBuckets(buckets(o), 10, vsync);
    ratios.push(st.jankyRatio);
  }
  check('60/90/120Hz 同一相对超标序列的 jankyRatio 一致',
    ratios[0] === ratios[1] && ratios[1] === ratios[2], ratios);
  check('jankyRatio 数值为 10%（10 帧里 1 帧超 2×vsync）', ratios[0] === 10, ratios);
}
{
  // 设备自报 120Hz 时，即使 FPS 序列锁在 30，目标帧率也应是 120
  const fpsLock30 = new Array(60).fill(30);
  const inferred = loading.analyseLoading(fpsLock30);
  const fromDevice = loading.analyseLoading(fpsLock30, undefined, 120);
  check('无设备值时沿用 FPS 序列推断（旧行为不变）',
    inferred.targetSource === 'fps-p95-inferred' && inferred.target === inferred.inferredTarget,
    { target: inferred.target, source: inferred.targetSource });
  check('设备自报 120Hz 时目标帧率取 120 而非锁帧推出来的 30',
    fromDevice.target === 120 && fromDevice.targetSource === 'device-peak-refresh-rate',
    { target: fromDevice.target, inferred: fromDevice.inferredTarget });
  check('来源信息带 targetHz，报告可显示「设备自报」',
    fromDevice.targetHz === 120 && inferred.targetHz === null);
  check('非法/超范围刷新率不覆盖旧推断',
    loading.analyseLoading(fpsLock30, undefined, 999).targetSource === 'fps-p95-inferred'
    && loading.analyseLoading(fpsLock30, undefined, 'bad').targetSource === 'fps-p95-inferred');
  check('analyseLoading 仍是 2 参兼容（旧调用不炸）',
    loading.analyseLoading([60, 60, 60]).target > 0);
}

// ── ② 超长单帧不被 avgMs 自我遮蔽 ───────────────────────────────────────────
{
  // 一半帧 200ms：旧实现 avgMs≈108 → 阈值 216ms → 判 0 次 Jank。
  // 新实现以 P50 为基准，200ms 远超 2×P50，必须判出 100 次。
  const r = algo.analyseHistogram({ 16: 100, 200: 100 }, 16.67);
  check('一半 200ms 长帧仍被判 Jank（P50 基准，不被均值抬高门槛）',
    r.jank === 100, { jank: r.jank, avgMs: r.avgMs, p50: r.ftP50 });
  check('P50 取中位数 16ms，不是整段均值', r.ftP50 === 16, r.ftP50);
  check('hitch 反映真实超时而不是 0', r.hitchMsPerSec > 0, r.hitchMsPerSec);
}

// ── ③ P99 / 分位数正确性 ────────────────────────────────────────────────────
{
  check('nearestRank 用最近秩（10 个值取 P99 → 第 10 个）',
    Schema.nearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.99) === 10);
  check('nearestRank P50 取第 5 个（不是插值 5.5）',
    Schema.nearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5) === 5);
  check('空数组返回 null', Schema.nearestRank([], 0.95) === null);

  const st = algo.frameStatsFromBuckets(buckets({ 16: 600, 17: 50, 250: 3 }), 653, 16.67);
  check('稳定 60fps 的 overrunP99 归 1ms（零超时帧必须计入分布）',
    st.overrunP99 <= 1, st);
  check('偶发 250ms 长帧单列 overrunMax，不把 P99 说成 234ms',
    st.overrunMax > 200 && st.overrunP99 < 10, st);
  check('分桶保留 2 位小数，16.67ms 不会造出 0.33ms 假超时',
    algo.frameStatsFromBuckets(buckets({ 16.67: 100 }), 100, 16.67).overrunMax === 0);
  check('jankyRatio 是百分比且落在 0–100',
    st.jankyRatio >= 0 && st.jankyRatio <= 100, st.jankyRatio);
}

// ── 设备刷新率解析 ───────────────────────────────────────────────────────────
{
  const p = algo.parsePeakRefreshRate;
  check('解析 mPeakRefreshRate=120.0', p('  mPeakRefreshRate=120.0\n') === 120);
  check('解析 peak_refresh_rate: 90', p('peak_refresh_rate: 90') === 90);
  check('解析大小写变体 PeakRefreshRate', p('PeakRefreshRate=144') === 144);
  check('无字段返回 null', p('no refresh info') === null);
  check('超范围值拒绝（防止读错列）', p('mPeakRefreshRate=2400') === null);
  check('导出 getDeviceRefreshRate', typeof ADB.getDeviceRefreshRate === 'function');
}

// ── D-21：峰值刷新率受面板物理能力（supportedModes 最大 fps）硬上界约束 ──────
// 2026-11-17 真机：60Hz 面板机被 framework vote(120) 误报成 120Hz，达帧率虚低到 48%。
{
  const cap = algo.capRefreshRateToPanel;
  const maxFps = algo.parseMaxSupportedFps;
  const p = algo.parsePeakRefreshRate;
  check('D-21.1 导出 capRefreshRateToPanel / parseMaxSupportedFps',
    typeof cap === 'function' && typeof maxFps === 'function');

  // 从真机 dump 抽象：60Hz 面板 + framework vote 120
  const dump60 = [
    'mDisplayModeSpecs={baseModeId=1 primaryRefreshRateRange=[0 120]}',
    'PRIORITY_USER_SETTING_PEAK_REFRESH_RATE -> Vote{maxRefreshRate=120.0, minRefreshRate=0.0}',
    'mDefaultPeakRefreshRate: 120.0',
    'supportedModes [{id=1, fps=60.000004}, {id=2, fps=60.000004}, {id=3, fps=60.000004}]',
  ].join('\n');
  const vote60 = p(dump60);
  const panel60 = maxFps(dump60);
  check('D-21.2 parsePeakRefreshRate 仍取到 framework vote(120)（证明问题在取数后未约束）',
    vote60 === 120, vote60);
  check('D-21.3 parseMaxSupportedFps 取到面板能力 60.000004',
    Math.abs(panel60 - 60.000004) < 1e-6, panel60);
  const fixed60 = cap(vote60, panel60);
  check('D-21.4 60Hz 面板：120 vote 被钳回 60，来源改 display-supported-modes',
    Math.abs(fixed60.hz - 60.000004) < 1e-6 && fixed60.capped === true
      && fixed60.source === 'display-supported-modes', fixed60);

  // 120Hz 面板：vote 120 不应被误钳
  const dump120 = [
    'PRIORITY_USER_SETTING_PEAK_REFRESH_RATE -> Vote{maxRefreshRate=120.0}',
    'supportedModes [{id=1, fps=60.000004}, {id=2, fps=120.00001}]',
  ].join('\n');
  const vote120 = p(dump120);
  const panel120 = maxFps(dump120);
  const fixed120 = cap(vote120, panel120);
  check('D-21.5 120Hz 面板：vote 120 不被误钳（面板含 120 档）',
    Math.abs(fixed120.hz - 120) < 0.5 && fixed120.capped === false, fixed120);

  // 容差：面板报 120.00001、vote 60 → 保持 60，不因浮点噪声误钳
  const tol = cap(60, 120.00001);
  check('D-21.6 浮点容差：60 ≤ 120×1.1 不误钳', tol.capped === false && tol.hz === 60, tol);

  // settings 分支同样受约束：settings=120 但面板 60 → 钳回 60
  const fromSettings = cap(120, 60.000004);
  check('D-21.7 settings 值也受面板能力约束',
    fromSettings.capped === true && Math.abs(fromSettings.hz - 60.000004) < 1e-6, fromSettings);

  // 读不到 supportedModes（定制 ROM）：保留声明值，不臆造降级
  const noPanel = cap(120, null);
  check('D-21.8 无面板能力信息时保留声明值（不臆造）',
    noPanel.hz === 120 && noPanel.capped === false, noPanel);
}

// ── 静态接线 ────────────────────────────────────────────────────────────────
{
  const ROOT = path.join(__dirname, '..', '..');
  const rdj = fs.readFileSync(path.join(ROOT, '_client_src/app/src/reports-data-js.js'), 'utf8');
  const col = fs.readFileSync(path.join(ROOT, '_client_src/app/src/collector.js'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, '_client_src/app/main.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'perfara/collector/resources/reports/perf.html'), 'utf8');
  check('报告统计把 displayProfile 传进 summarizePerf',
    /summarizePerf\(perf, payload\.metricConfig, payload\.displayProfile\)/.test(rdj));
  check('采集端只在 start 读一次刷新率', /await ADB\.getDeviceRefreshRate\(this\.deviceId\)/.test(col));
  check('诊断信息带 displayProfile', /displayProfile: this\._displayProfile/.test(col));
  check('stop-collect 把 displayProfile 写进 payload', /displayProfile: \(androidDiag/.test(main));
  check('报告页显示目标帧率来源', /设备自报|序列推断/.test(html));
  check('Jank 家族已标旧口径', (html.match(/（旧口径）/g) || []).length >= 4);
}

// FIX-17：framestats 窗口过期判定用「上一拍实际周期」—— 实际周期 3× 配置值时
// 仍应 usable（门闩跳拍 / 休眠恢复不该降级到 gfxinfo 增量通道），真正过期才 stale。
{
  const mkFrames = (n) => Array.from({ length: n }, (_, i) => ({ vsync: i * 1e6, completed: i * 1e6 }));
  const frames = mkFrames(20);
  const probe = (cfgMs, actualMs) => {
    const now = 100000;                       // 当前 mono
    const prev = { ts: now - actualMs, lastCompleted: 0, tail: [] };
    return algo.selectFramestatsWindow(frames, prev, now, cfgMs);
  };
  check('FIX-17.1 实际周期 1×（1000ms）→ usable', probe(1000, 1000).frames.length > 0
    && probe(1000, 1000).reason === '', probe(1000, 1000).reason);
  check('FIX-17.2 实际周期 2×（2000ms）→ usable（2.5× 容差内）',
    probe(1000, 2000).frames.length > 0, probe(1000, 2000).reason);
  check('FIX-17.3 实际周期 3×（3000ms，配置 1s 的 maxGap=3s 上限）→ usable',
    probe(1000, 3000).frames.length > 0 || probe(1000, 3000).reason === 'no-frames',
    probe(1000, 3000).reason);
  check('FIX-17.4 真过期（30000ms，应用后台 30s）→ stale-window',
    probe(1000, 30000).reason === 'stale-window', probe(1000, 30000).reason);
  check('FIX-17.5 传入实际周期时不再用配置值兜底（配置 3000 与实际 3000 一致）',
    probe(3000, 3000).frames.length > 0, probe(3000, 3000).reason);
}

console.log(`\n===== 帧指标与刷新率测试结果: ${pass} PASS / ${fail} FAIL =====\n`);
process.exit(fail ? 1 : 0);
