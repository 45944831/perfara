#!/usr/bin/env node
/**
 * 一次性补丁：SPA bundle 注入「采集参数（metricConfig）」适配
 *   1) index-CX8C-b2E.js（详情页默认 perf 视图）：
 *      在图表配置 B 构建后，按 payload.metricConfig 删除被移除组的配置，
 *      并隐藏对应 chart-wrap 与指标卡片 → 不建图、不进统计表。
 *   2) Compare-CqE700DJ.js（对比页）：
 *      图表数据构建后，若某图表两侧序列全为 null（被移除组无数据），隐藏其包裹层。
 * 幂等：已注入则跳过。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, 'dist', 'assets');
const MARK = 'perfara-metric-config-patch-v1';

// ─── 补丁 1：主 bundle perf 视图 ────────────────────────────────────────────
const mainFile = path.join(ROOT, 'index-CX8C-b2E.js');
let main = fs.readFileSync(mainFile, 'utf8');

if (main.indexOf(MARK) !== -1) {
  console.log('[skip] main bundle already patched');
} else {
  const anchor = 'const j=H=>{var ve,Te;for(const ye of Object.values(B))';
  const at = main.indexOf(anchor);
  if (at === -1) throw new Error('anchor not found in main bundle');
  if (main.indexOf(anchor, at + 1) !== -1) throw new Error('anchor not unique in main bundle');

  const patch = `/*${MARK}*/;(function(){var mc=e.payload&&e.payload.metricConfig;if(!mc||typeof mc!=="object")return;var root=r.value;if(!root)return;var BG={cpu:["cpu","cpuCores","cpuFreq"],mem:["mem","memDetail","memdetail"],fps:["fps","jankRate"],net:["net"],gpu:["gpu","occupancy","aluPerf","texture","bandwidth","cache","shader"],temp:["temp"],battery:["current","power"],disk:["disk","pcDisk"],events:["events"],proc:["pid"]},CG={"chart-cpu":"cpu","chart-cpu-cores":"cpu","chart-cpu-freq":"cpu","chart-mem":"mem","chart-memdetail":"mem","chart-fps":"fps","chart-jankrate":"fps","chart-net":"net","chart-gpu":"gpu","chart-temp":"temp","chart-current":"battery","chart-power":"battery","chart-disk":"disk","chart-pc-disk":"disk","chart-events":"events","chart-pid":"proc","chart-occupancy":"gpu","chart-alu-perf":"gpu","chart-texture":"gpu","chart-bandwidth":"gpu","chart-cache":"gpu","chart-shader":"gpu"},KG={"card-cpu":"cpu","card-proccpu":"cpu","card-syscpu":"cpu","card-mem":"mem","card-fps":"fps","card-jank":"fps","card-bigjank":"fps","card-big-jank":"fps","card-stutter":"fps","card-jankrate":"fps","card-fpsfloat":"fps","card-net":"net","card-gpu":"gpu","card-temp":"temp","card-battery":"battery","card-disk":"disk","card-pcdisk":"disk","card-ctx":"events","card-status":"proc","card-ports":"proc","card-msg":"proc","card-syscall":"proc","card-thread":"proc","card-pid":"proc","card-alu":"gpu","card-frag":"gpu","card-vert":"gpu","card-tex":"gpu","card-rbw":"gpu","card-wbw":"gpu","card-f32":"gpu","card-f16":"gpu","card-llc":"gpu","card-mmu":"gpu","card-partial":"gpu"};for(var g in mc){if(!Object.prototype.hasOwnProperty.call(mc,g)||mc[g])continue;var ks=BG[g]||[];for(var i2=0;i2<ks.length;i2++)delete B[ks[i2]];for(var id in CG)if(CG[id]===g){var cw=root.querySelector("#"+id);if(cw&&cw.parentElement)cw.parentElement.style.display="none"}for(var kid in KG)if(KG[kid]===g){var kk=root.querySelector("#"+kid);if(kk)kk.style.display="none"}}})();`;

  main = main.slice(0, at) + patch + main.slice(at);
  fs.writeFileSync(mainFile, main, 'utf8');
  console.log('[ok] main bundle patched at', at);
}

// ─── 补丁 2：Compare bundle 两侧全空隐藏 ────────────────────────────────────
const cmpFile = path.join(ROOT, 'Compare-CqE700DJ.js');
let cmp = fs.readFileSync(cmpFile, 'utf8');

if (cmp.indexOf(MARK) !== -1) {
  console.log('[skip] compare bundle already patched');
} else {
  // 单侧序列是否含有效数据：全空的一侧不进图例与曲线；两侧全空则隐藏整张图
  const anchor2 = 'const j=[...c.series.map((f,_)=>J(`${p} · ${k.series[_].name}`,f,ie)),...y.map((f,_)=>J(`${t} · ${k.series[_].name}`,f,ce))]';
  const at2 = cmp.indexOf(anchor2);
  if (at2 === -1) throw new Error('anchor not found in compare bundle');
  if (cmp.indexOf(anchor2, at2 + 1) !== -1) throw new Error('anchor not unique in compare bundle');

  const patch2 =
    '/*' + MARK + '*/' +
    'var _hasA=c.series.some(function(sr){return sr.some(function(v){return v!=null})}),' +
    '_hasB=y.some(function(sr){return sr.some(function(v){return v!=null})});' +
    'if(!_hasA&&!_hasB&&h.parentElement)h.parentElement.style.display="none";' +
    'const j=[' +
    '...(_hasA?c.series.map((f,_)=>J(`${p} · ${k.series[_].name}`,f,ie)):[]),' +
    '...(_hasB?y.map((f,_)=>J(`${t} · ${k.series[_].name}`,f,ce)):[])' +
    ']';

  cmp = cmp.slice(0, at2) + patch2 + cmp.slice(at2 + anchor2.length);
  fs.writeFileSync(cmpFile, cmp, 'utf8');
  console.log('[ok] compare bundle patched at', at2);
}

// ─── 补丁 3：Trend bundle 全空图表隐藏 ──────────────────────────────────────
const trendFile = path.join(ROOT, 'Trend-D1yYXFi4.js');
let trend = fs.readFileSync(trendFile, 'utf8');

if (trend.indexOf(MARK) !== -1) {
  console.log('[skip] trend bundle already patched');
} else {
  const anchor3 = 'J.setOption(oe(ce,pe),{notMerge:!0})};';
  const at3 = trend.indexOf(anchor3);
  if (at3 === -1) throw new Error('anchor not found in trend bundle');
  if (trend.indexOf(anchor3, at3 + 1) !== -1) throw new Error('anchor not unique in trend bundle');

  // ce=均值序列，pe=峰值序列；全为 null（该参数已被移除/无数据）时隐藏整张卡片，有数据时恢复显示
  const patch3 = `/*${MARK}*/{var _b=D.value[o];if(_b&&_b.parentElement)_b.parentElement.style.display=ce.concat(pe).every(function(z){return z==null})?"none":"";}J.setOption(oe(ce,pe),{notMerge:!0})};`;

  trend = trend.slice(0, at3) + patch3 + trend.slice(at3 + anchor3.length);
  fs.writeFileSync(trendFile, trend, 'utf8');
  console.log('[ok] trend bundle patched at', at3);
}

// ─── 语法校验 ──────────────────────────────────────────────────────────────
const { execFileSync } = require('child_process');
for (const f of [mainFile, cmpFile, trendFile]) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    console.log('[check] syntax OK:', path.basename(f));
  } catch (e) {
    console.error('[check] SYNTAX ERROR:', path.basename(f));
    console.error(e.stderr && e.stderr.toString());
    process.exit(1);
  }
}
console.log('DONE');
