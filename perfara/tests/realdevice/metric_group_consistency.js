'use strict';
/**
 * 采集参数组一致性测试（离线静态检查）。
 * 目的：UI 上勾选/取消的分组必须与各平台采集器真正认的分组完全一致。
 * 历史故障：iOS GPU 页漏接、ios_gpu 的 applyToPage 漏传 platform，都是「两边定义漂移」导致。
 *
 * 用法: node metric_group_consistency.js
 */
const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '../../../_client_src/app');
const ui = fs.readFileSync(path.join(APP, 'renderer', 'metric-settings.js'), 'utf8');

let pass = 0, fail = 0;
const fails = [];
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; fails.push(name); console.log('  FAIL  ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
}

// 从源码里抽出 PLATFORM_METRICS / *_METRIC_KEYS 的分组名列表
function extractGroups(src, varName) {
  const i = src.indexOf(varName);
  if (i < 0) return null;
  const start = src.indexOf('{', i);
  let depth = 0, end = start;
  for (let k = start; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  const body = src.slice(start + 1, end);
  // 取顶层 key（行首的 "xxx:"）
  const out = [];
  for (const m of body.matchAll(/(?:^|\n)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) out.push(m[1]);
  return out;
}

function extractPlatformMetrics(src) {
  const i = src.indexOf('PLATFORM_METRICS');
  const start = src.indexOf('{', i);
  let depth = 0, end = start;
  for (let k = start; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  const body = src.slice(start + 1, end);
  const out = {};
  // platform: ['a','b',...]
  for (const m of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\[([^\]]*)\]/g)) {
    const key = m[1];
    const arr = [...m[2].matchAll(/'([^']+)'/g)].map(x => x[1]);
    out[key] = arr;
  }
  return out;
}

console.log('\n===== 采集参数组一致性 =====\n');

const uiMetrics = extractPlatformMetrics(ui);
console.log('UI PLATFORM_METRICS =', JSON.stringify(uiMetrics));
check('UI 定义了 4 个平台', Object.keys(uiMetrics).length === 4, Object.keys(uiMetrics));

const collectors = [
  ['android', 'src/collector.js', 'ANDROID_METRIC_KEYS'],
  ['ios', 'src/ios-collector.js', 'IOS_METRIC_KEYS'],
  ['pc', 'src/pc-collector.js', 'PC_METRIC_KEYS'],
];

for (const [platform, rel, varName] of collectors) {
  const src = fs.readFileSync(path.join(APP, rel), 'utf8');
  const keys = extractGroups(src, varName);
  const uiKeys = uiMetrics[platform] || [];
  console.log(`  ${platform}: UI=[${uiKeys}]  采集器(${varName})=[${keys}]`);
  check(`${platform}: UI 分组与采集器分组完全一致`,
    uiKeys.length === keys.length && uiKeys.every(k => keys.includes(k)),
    { ui: uiKeys, collector: keys });
  check(`${platform}: 采集器无 UI 之外的多余分组`,
    keys.every(k => uiKeys.includes(k)), { ui: uiKeys, collector: keys });
}

// ios_gpu：只有 gpu 一组，且无人意外加分支
const uiGpu = uiMetrics.ios_gpu || [];
console.log(`  ios_gpu: UI=[${uiGpu}]`);
check('ios_gpu 只有 gpu 一组', uiGpu.length === 1 && uiGpu[0] === 'gpu', uiGpu);

// reports-data-js 的 KPI_GROUP：分组名必须是已知组（不能有拼写漂移）
const rsrc = fs.readFileSync(path.join(APP, 'src', 'reports-data-js.js'), 'utf8');
const kgStart = rsrc.indexOf('const KPI_GROUP');
const kgBlock = rsrc.slice(kgStart, rsrc.indexOf('};', kgStart));
const kpiGroups = [...new Set([...kgBlock.matchAll(/:\s*'([a-zA-Z_]+)'/g)].map(m => m[1]))];
const allKnown = ['fps', 'cpu', 'mem', 'net', 'gpu', 'temp', 'battery', 'disk', 'events', 'proc'];
console.log('  reports-data-js KPI_GROUP 引用分组 =', kpiGroups);
check('KPI_GROUP 引用的都是合法分组',
  kpiGroups.every(g => allKnown.includes(g)), kpiGroups.filter(g => !allKnown.includes(g)));

// 四个采集页都必须引入 metric-settings.js
console.log('\n-- 采集页接入 --');
const pages = [
  ['index.html', 'renderer.js', 'android'],
  ['iphone.html', 'iphone.js', 'ios'],
  ['pc.html', 'pc.js', 'pc'],
  ['iphone_gpu.html', 'iphone_gpu.js', 'ios_gpu'],
];
for (const [html, js, platform] of pages) {
  let hasInclude = false;
  try {
    // HTML 位于 renderer/ 下
    const h = fs.readFileSync(path.join(APP, 'renderer', html), 'utf8');
    hasInclude = h.includes('metric-settings.js');
  } catch (_) {}
  let hasInit = false, hasApply = false;
  try {
    const j = fs.readFileSync(path.join(APP, 'renderer', js), 'utf8');
    // PC 页是内联写法（直接 load + applyToPage），其余三页封装为 initMetricSettingsUI
    hasInit = /initMetricSettingsUI|MetricSettings\.load\(/.test(j);
    hasApply = /applyToPage\(/.test(j);
  } catch (_) {}
  check(`${platform} 页引入 metric-settings.js`, hasInclude, html);
  check(`${platform} renderer 初始化采集参数`, hasInit, js);
  check(`${platform} renderer 调用 applyToPage`, hasApply, js);
}

// applyToPage 首参必须是 platform（历史 bug：ios_gpu 漏传，导致 17 个元素不隐藏）
console.log('\n-- applyToPage 调用约定 --');
for (const [html, js, platform] of pages) {
  const j = fs.readFileSync(path.join(APP, 'renderer', js), 'utf8');
  const calls = [...j.matchAll(/applyToPage\(([^)]*)\)/g)].map(m => m[1].trim());
  // 历史 bug：applyToPage(_metricConfig) 漏传 platform → 首参必须是 platform（字面量或平台变量）
  const bad = calls.filter(c => {
    const parts = c.split(',').map(s => s.trim());
    return parts.length < 2;
  });
  check(`${platform}: applyToPage 传入两个参数(platform, cfg)`, calls.length > 0 && bad.length === 0, { calls, bad });
  // 若在 DOMContentLoaded 内调用且页面是 PC/ios_gpu，校验 platform 取值正确
  const inline = calls.filter(c => /^'[a-z_]+'/.test(c));
  if (inline.length) {
    const wrong = inline.filter(c => !new RegExp(`^'${platform}'`).test(c));
    check(`${platform}: applyToPage 的 platform 取值正确`, wrong.length === 0, wrong);
  }
}

console.log(`\n===== 结果: ${pass} PASS / ${fail} FAIL =====`);
if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
process.exit(fail ? 1 : 0);
