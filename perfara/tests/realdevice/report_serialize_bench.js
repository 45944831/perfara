'use strict';
/**
 * 报告落盘性能基准 + 正确性回归（第二轮性能优化的验收脚本）。
 *
 * 覆盖三处改动：
 *   1) summarizePerf：11 遍 map + 3 遍 filter  →  单趟循环求 sum/min/max
 *   2) 统计里的 Math.min/max.apply(null, 大数组) → 循环求极值（>6.5 万点原会 RangeError）
 *   3) 报告 JSON 去掉 indent=2（data.js / history/*.js|json）
 *
 * 正确性：把改动前的 summarizePerf 原样复刻一份（oldSummarizePerf），
 * 与新实现对同一份样本逐字段比对，必须完全一致（含 null / 缺字段 / iOS snake_case）。
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const Module = require('module');

const PROJ = path.resolve(__dirname, '..', '..', '..');
const APP = path.join(PROJ, '_client_src', 'app');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  (' + extra + ')' : '')); }
}

// ── 用假的 electron.app 加载 reports-data-js.js ──────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara-bench-'));
const origLoad = Module._load;
// isPackaged=true + resourcesPath 指向临时目录：让落盘一律写 TMP，不污染源码树
// （isPackaged=false 时模块会用 __dirname/.. 即 _client_src/app，测试会留下 data.js）
process.resourcesPath = TMP;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') {
    return { app: { isPackaged: true, getPath: () => TMP } };
  }
  return origLoad.apply(this, arguments);
};
const rdj = require(path.join(APP, 'src', 'reports-data-js.js'));
Module._load = origLoad;

// ── 改动前的 summarizePerf（原样复刻，作为正确性基准）───────────────────────
function _nums(arr) { return (arr || []).filter(v => typeof v === 'number' && isFinite(v)); }
function _round(v, d) {
  if (v == null || !isFinite(v)) return null;
  const p = Math.pow(10, d == null ? 1 : d);
  return Math.round(v * p) / p;
}
function _avg(arr) { const n = _nums(arr); return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null; }
function _pick(obj, ...paths) {
  for (const p of paths) {
    let cur = obj, ok = true;
    for (const k of p.split('.')) {
      if (cur == null || typeof cur !== 'object') { ok = false; break; }
      cur = cur[k];
    }
    if (ok && typeof cur === 'number' && isFinite(cur)) return cur;
  }
  return null;
}
function oldSummarizePerf(perf, metricConfig) {
  const rows = Array.isArray(perf) ? perf : [];
  const series = {
    fps: rows.map(r => _pick(r, 'fps', 'fps.fps')),
    cpu: rows.map(r => _pick(r, 'cpu.procCpu', 'cpu.cpu', 'procCpu', 'cpuUsage')),
    mem: rows.map(r => _pick(r, 'mem.totalPss', 'mem.pss', 'mem.physic', 'physFootprint')),
    temp: rows.map(r => _pick(r, 'temperature', 'temp')),
    gpu: rows.map(r => _pick(r, 'gpu', 'gpu.utilization')),
    gpuTemp: rows.map(r => _pick(r, 'gpuTemp', 'gpu_temp')),
    jank: rows.map(r => _pick(r, 'jank', 'jankRate')),
    bigJank: rows.map(r => _pick(r, 'bigJank', 'big_jank', 'bigJankRate')),
    smallJank: rows.map(r => _pick(r, 'smallJank', 'small_jank')),
    tinyJank: rows.map(r => _pick(r, 'tinyJank', 'tiny_jank')),
  };
  const kpi = {};
  for (const [k, arr] of Object.entries(series)) {
    const n = _nums(arr);
    kpi[k] = {
      avg: _round(_avg(arr), 1),
      min: n.length ? _round(Math.min.apply(null, n), 1) : null,
      max: n.length ? _round(Math.max.apply(null, n), 1) : null,
    };
  }
  const ts = rows.map(r => _pick(r, 'timestamp')).filter(v => v != null);

  const fpsNums = _nums(series.fps);
  let durSec = ts.length >= 2 ? _round((Math.max.apply(null, ts) - Math.min.apply(null, ts)) / 1000, 1) : null;
  if (fpsNums.length) {
    const sorted = fpsNums.slice().sort((a, b) => a - b);
    const i = (sorted.length - 1) * 0.95;
    const lo = Math.floor(i), hi = Math.ceil(i);
    const p95 = lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
    let target = null;
    for (const c of [30, 45, 60, 90, 120, 144, 165]) { if (c >= p95 * 0.97) { target = c; break; } }
    if (target == null) target = Math.ceil(p95 / 30) * 30;
    if (target > 0) {
      const avg = _avg(series.fps);
      const moving = fpsNums.filter(v => v > 0);
      const frameTime = moving.length ? _avg(moving.map(v => 1000 / v)) : null;
      const low = fpsNums.filter(v => v < target * 0.8).length;
      kpi.fpsTarget = { avg: target, min: target, max: target };
      kpi.fpsReach = { avg: _round((avg / target) * 100, 1), min: null, max: null };
      kpi.fpsFrameTime = { avg: _round(frameTime, 1), min: null, max: null };
      kpi.fpsLowPct = { avg: _round((low / fpsNums.length) * 100, 1), min: null, max: null };
      if (moving.length) {
        const ftList = moving.map(v => 1000 / v).sort((a, b) => b - a);
        const k = Math.max(1, Math.round(ftList.length * 0.01));
        const worstFt = ftList.slice(0, k).reduce((a, b) => a + b, 0) / k;
        kpi.fps1Low = { avg: _round(1000 / worstFt, 1), min: null, max: null };
      }
      const ge = fpsNums.filter(v => v >= target).length;
      kpi.fpsGeTarget = { avg: _round((ge / fpsNums.length) * 100, 1), min: null, max: null };
      const mi = (sorted.length - 1) / 2;
      const median = sorted.length % 2 ? sorted[mi] : (sorted[Math.floor(mi)] + sorted[Math.ceil(mi)]) / 2;
      const inMed = fpsNums.filter(v => Math.abs(v - median) <= median * 0.2).length;
      kpi.fpsMedRange = { avg: _round((inMed / fpsNums.length) * 100, 1), min: null, max: null };
      const variance = fpsNums.reduce((a, v) => a + (v - avg) * (v - avg), 0) / fpsNums.length;
      kpi.fpsStd = { avg: _round(Math.sqrt(variance), 2), min: null, max: null };
      const targetFt = 1000 / target;
      let slow = 0, total = 0;
      for (const v of moving) { const t = 1000 / v; total += t; if (t > targetFt * 2) slow += t; }
      if (total > 0) kpi.fpsStutter = { avg: _round((slow / total) * 100, 1), min: null, max: null };
      const durHour = durSec ? durSec / 3600 : null;
      let drop = 0;
      for (let i2 = 1; i2 < fpsNums.length; i2++) if (fpsNums[i2 - 1] - fpsNums[i2] > 8) drop++;
      kpi.fpsDrop = { avg: _round(durHour ? drop / durHour : drop, 1), min: null, max: null };
    }
  }
  const durMin = durSec ? durSec / 60 : null;
  const per10 = (key) => {
    const n = _nums(series[key]);
    if (!n.length) return;
    const sum = n.reduce((a, b) => a + b, 0);
    kpi[key + '10'] = { avg: _round(durMin > 0 ? sum / durMin * 10 : sum, 1), min: null, max: null };
  };
  per10('jank'); per10('bigJank'); per10('smallJank'); per10('tinyJank');

  const mc = rdj.normalizeMetricConfig(metricConfig);
  for (const k of Object.keys(kpi)) {
    const g = rdj.KPI_GROUP[k];
    if (g && !mc[g]) delete kpi[k];
  }
  return { samples: rows.length, durationSec: durSec, kpi };
}

// ── 样本构造 ────────────────────────────────────────────────────────────────
function makeSamples(n, style) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const fps = 58 + Math.sin(i / 37) * 6 + (i % 11 === 0 ? -22 : 0);
    if (style === 'ios') {
      out.push({
        timestamp: 1700000000000 + i * 1000,
        fps: i % 97 === 0 ? null : fps,
        cpu_usage: 12 + (i % 30),
        physFootprint: 180 + (i % 90),
        temp: 34 + (i % 7),
        gpu_utilization: i % 55,
        gpu_temp: 38 + (i % 5),
        jank: i % 5,
        big_jank: i % 2,
        small_jank: i % 3,
        tiny_jank: i % 4,
      });
    } else if (style === 'sparse') {
      // 缺字段 / 全 null：验证 null 分支与旧实现一致
      out.push(i % 3 === 0 ? { timestamp: 1700000000000 + i * 1000, fps: 60 } : {});
    } else {
      out.push({
        timestamp: 1700000000000 + i * 1000,
        fps: i % 97 === 0 ? null : fps,
        cpu: { sysCpu: 20 + (i % 25), procCpu: 8 + (i % 18) },
        mem: { totalPss: 210 + (i % 120), nativeHeap: 40 + (i % 20) },
        temperature: 35 + (i % 8),
        gpu: i % 45,
        gpuTemp: 39 + (i % 6),
        jank: i % 6,
        bigJank: i % 3,
        smallJank: i % 4,
        tinyJank: i % 5,
      });
    }
  }
  return out;
}

function kpiEqual(a, b) {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.join(',') !== kb.join(',')) return false;
  for (const k of ka) {
    const x = a[k], y = b[k];
    if (Object.is(x, null) !== Object.is(y, null)) return false;
    if (x == null) continue;
    if (x.avg !== y.avg || x.min !== y.min || x.max !== y.max) return false;
  }
  return true;
}

(async () => {
  console.log('=== 报告落盘性能基准 + 正确性回归 ===\n');

  // 1) 正确性：三种数据形态，新实现必须与改动前逐字段一致
  for (const [style, n] of [['android', 900], ['ios', 600], ['sparse', 400]]) {
    const rows = makeSamples(n, style);
    const a = rdj.summarizePerf(rows, null);
    const b = oldSummarizePerf(rows, null);
    check(`KPI 与改动前一致（${style}, ${n} 点）`,
      a.samples === b.samples && a.durationSec === b.durationSec && kpiEqual(a.kpi, b.kpi),
      `durationSec=${a.durationSec}`);
  }
  // metricConfig 过滤路径
  const rowsF = makeSamples(500, 'android');
  const cfg = { fps: true, cpu: false, mem: true, temp: false, gpu: true };
  check('KPI 与改动前一致（带 metricConfig 过滤）',
    kpiEqual(rdj.summarizePerf(rowsF, cfg).kpi, oldSummarizePerf(rowsF, cfg).kpi));

  // 2) 性能：summarizePerf 单趟 vs 旧的多趟
  const big = makeSamples(6000, 'android');
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 3; i++) rdj.summarizePerf(big, null);
  const tNew = Number(process.hrtime.bigint() - t0) / 3e6;
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 3; i++) oldSummarizePerf(big, null);
  const tOld = Number(process.hrtime.bigint() - t1) / 3e6;
  console.log(`  · summarizePerf 6000 点：改动前 ${tOld.toFixed(1)}ms → 改动后 ${tNew.toFixed(1)}ms`
    + `（快 ${(tOld / Math.max(tNew, 0.001)).toFixed(1)}×）`);
  check('summarizePerf 有提速', tNew < tOld, `${tNew.toFixed(1)}ms < ${tOld.toFixed(1)}ms`);

  // 3) 大数据不崩：原 Math.min.apply 在 >6.5 万点会 RangeError
  let crashed = null;
  try { rdj.summarizePerf(makeSamples(70000, 'android'), null); } catch (e) { crashed = e.message; }
  check('7 万点统计不抛 RangeError', crashed === null, crashed || 'ok');

  // 4) 序列化：indent=2 vs 无缩进
  const payload = {
    device: { name: 'Pixel 8', bundleId: 'com.demo.app(演示)', appName: 'com.demo.app(演示)', category: 'android', deviceId: 'abc123', udid: '' },
    perf: big,
    tag: [{ t: 1, category: 'scene', name: '战斗' }, { t: 2, category: 'scene', name: '加载' }],
    metricConfig: { fps: true, cpu: true, mem: true, temp: true, gpu: true },
  };
  const s0 = process.hrtime.bigint();
  const pretty = JSON.stringify(payload, null, 2);
  const tPretty = Number(process.hrtime.bigint() - s0) / 1e6;
  const s1 = process.hrtime.bigint();
  const compact = JSON.stringify(payload);
  const tCompact = Number(process.hrtime.bigint() - s1) / 1e6;
  const shrink = (1 - compact.length / pretty.length) * 100;
  console.log(`  · data.js 序列化 6000 点：indent=2 ${tPretty.toFixed(1)}ms / ${(pretty.length / 1048576).toFixed(2)}MB`
    + `  →  无缩进 ${tCompact.toFixed(1)}ms / ${(compact.length / 1048576).toFixed(2)}MB（省 ${shrink.toFixed(0)}%）`);
  check('无缩进体积显著更小', shrink > 20, `省 ${shrink.toFixed(0)}%`);
  check('无缩进序列化更快', tCompact < tPretty, `${tCompact.toFixed(1)}ms < ${tPretty.toFixed(1)}ms`);
  check('无缩进内容等价', JSON.parse(compact).perf.length === payload.perf.length);

  // 5) 端到端：writeDataJs 落到临时目录，读回来必须一致
  const written = rdj.writeDataJs(payload);
  const back = rdj.readReportDataJs();
  check('writeDataJs 写读一致', !!back && back.perf.length === payload.perf.length,
    `${(fs.statSync(written).size / 1048576).toFixed(2)}MB -> ${written}`);
  const rawTxt = fs.readFileSync(written, 'utf8');
  check('data.js 无缩进（不含 2 空格缩进的 perf 数组）', !rawTxt.includes('{\n      "timestamp"'));

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
