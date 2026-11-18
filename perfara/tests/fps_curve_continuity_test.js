'use strict';

/**
 * FPS 实时曲线「无帧点连续显示」守卫（离线，不需要真机）。
 *
 * 背景：
 *   采集端对本周期没有可见渲染帧的拍写 null（method=no-frames/none/none），
 *   统计层据此跳过、不污染均值与 1%Low —— 这个口径绝不能改。
 *   但实时曲线遇到 null 就断线，尤其在低谷截图附近（截屏短暂占用设备，
 *   取帧那拍容易 delta=0）会连出好几个断口，用户看着像「曲线坏了」。
 *
 * 修复（展示层，仅画图）：
 *   charts.js 新增纯函数 fpsPlotValue(v)：把 null/NaN 映射成 {value:0,noFrame:true}
 *   贴地 0 点让曲线连续；FPS 线注入 series 时走它，tooltip 依 noFrame 标注
 *   「无帧（本周期无渲染）」。data.js / 报告统计仍保留 null，口径不变。
 *
 * 本测试直接从产品源码提取真实函数验证，避免测副本。
 *
 * 用法: node perfara/tests/fps_curve_continuity_test.js
 */
const fs = require('fs');
const path = require('path');

const CHARTS = path.join(__dirname, '..', '..', '_client_src', 'app', 'renderer', 'charts.js');
const src = fs.readFileSync(CHARTS, 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log(' FAIL  ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : '')); }
}

console.log('\n===== FPS 曲线连续性（展示层） =====\n');

// 从真实源码里截取 fpsPlotValue 函数体并求值（不执行整个浏览器脚本）
function extractFn(source, name) {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) return null;
  // 用大括号配平找函数结尾
  let i = source.indexOf('{', start), depth = 0, end = -1;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) return null;
  return source.slice(start, end);
}

const fnSrc = extractFn(src, 'fpsPlotValue');
check('源码中存在 fpsPlotValue 函数', !!fnSrc);
const constSrc = src.match(/const FPS_NOFRAME_VALUE\s*=\s*[\d.]+;/);
check('源码中存在 FPS_NOFRAME_VALUE 常量', !!constSrc);

let fpsPlotValue = null;
if (fnSrc && constSrc) {
  // eslint-disable-next-line no-new-func
  fpsPlotValue = new Function(constSrc[0] + '\n' + fnSrc + '\nreturn fpsPlotValue;')();
}

if (fpsPlotValue) {
  // null / undefined / 空串 → 贴地 0 且带 noFrame 标记
  for (const bad of [null, undefined, '', NaN, Infinity, -Infinity, 'abc']) {
    const r = fpsPlotValue(bad);
    check(`无帧值 ${String(bad)} → {value:0,noFrame:true}`,
      r && r.value === 0 && r.noFrame === true, r);
  }
  // 真实数值 → {value:n}，不带 noFrame（避免 tooltip 误标）
  for (const good of [0, 30, 59.7, 120]) {
    const r = fpsPlotValue(good);
    check(`有效值 ${good} → {value:${good}} 且无 noFrame`,
      r && r.value === good && !r.noFrame, r);
  }
  // 数值字符串
  check('数值字符串 "45" → {value:45}',
    (() => { const r = fpsPlotValue('45'); return r.value === 45 && !r.noFrame; })());
}

// 结构守卫：FPS 线注入走 fpsPlotValue，tooltip 标注 noFrame，统计层未动
check('FPS 线 series 注入调用 fpsPlotValue', /state\.series\[0\]\.map\(fpsPlotValue\)/.test(src));
check('tooltip 识别 noFrame 标记', /d\.noFrame\s*===\s*true/.test(src));
check('tooltip 无帧文案存在', /无帧（本周期无渲染）/.test(src));
check('其余图表仍用原值（未全局对象化）', /state\.series\.map\(s\s*=>\s*\(\{\s*data:\s*s\s*\}\)\)/.test(src));

// 口径守卫：collector 仍写 null（统计跳过），未被改成 0
const COLLECTOR = path.join(__dirname, '..', '..', '_client_src', 'app', 'src', 'collector.js');
const csrc = fs.readFileSync(COLLECTOR, 'utf8');
check('采集端 no-frames 仍写 data.fps = null（统计口径未变）',
  /data\.fps\s*=\s*null/.test(csrc) && /FPS_NO_DATA_METHODS/.test(csrc));
check('无需升 SCHEMA_VERSION：采集层未把无帧写成 0',
  !/data\.fps\s*=\s*0\s*\/\/\s*no-frames/.test(csrc));

// ── 端到端：真实 charts.js 在沙箱里渲染含 null 的 FPS 序列 ──────────────────
// 复用 chart_scroll_perf_test 的沙箱思路：最小 DOM + echarts 桩，捕获 setOption，
// 断言注入 echarts 的 FPS 线数据里无帧点已变成贴地 0（带 noFrame），曲线不再有洞。
console.log('\n[端到端] 沙箱渲染真实 charts.js');
try {
  const vm = require('vm');
  const CHART_IDS = ['chart-cpu', 'chart-mem', 'chart-memdetail', 'chart-fps', 'chart-net',
    'chart-gpu', 'chart-temp', 'chart-current', 'chart-power', 'chart-cpu-cores', 'chart-cpu-freq'];
  let clock = 10000, tid = 1;
  const timers = [];
  const setT = (fn, ms) => { const id = tid++; timers.push({ id, at: clock + (ms || 0), fn }); return id; };
  const clearT = (id) => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); };
  const advance = (ms) => {
    const end = clock + ms;
    for (;;) {
      const due = timers.filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock = Math.max(clock, due.at);
      timers.splice(timers.indexOf(due), 1);
      due.fn();
    }
    clock = end;
  };
  const elements = new Map();
  CHART_IDS.forEach(id => elements.set(id, { id, style: {}, offsetHeight: 200, dataset: {},
    clientWidth: 600, clientHeight: 200 }));
  const listeners = {};
  const addTo = (bag) => (type, fn) => { (bag[type] || (bag[type] = [])).push(fn); };
  const grid = { clientWidth: 1000, clientHeight: 700, addEventListener: addTo(listeners) };
  const charts = {};
  const echarts = {
    init(el) {
      const c = { calls: [], setOption(o) { c.calls.push(o); return c; }, resize() {}, clear() {}, on() {} };
      charts[el.id] = c; return c;
    },
  };
  let ioCb = null;
  class IO { constructor(cb) { ioCb = cb; } observe() {} disconnect() {} }
  class RO { constructor() {} observe() {} disconnect() {} }
  const sandbox = {
    window: { addEventListener: addTo(listeners), innerWidth: 1200, innerHeight: 800 },
    document: { getElementById: id => elements.get(id) || null,
      querySelector: sel => (sel === '.charts-grid' ? grid : null),
      body: { classList: { contains: () => false } } },
    echarts, IntersectionObserver: IO, ResizeObserver: RO,
    requestAnimationFrame: cb => setT(cb, 0), setTimeout: setT, clearTimeout: clearT,
    performance: { now: () => clock }, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: CHARTS });
  const Mgr = sandbox.window.ChartManager;
  const mgr = new Mgr();
  mgr._doInit();
  advance(300);
  ioCb(CHART_IDS.map(id => ({ target: elements.get(id), isIntersecting: id === 'chart-fps' })));
  advance(400);
  charts['chart-fps'].calls.length = 0;

  const sample = (n, fps) => ({
    time: `00:00:${String(n).padStart(2, '0')}`,
    cpu: { sysCpu: 10, procCpu: 2 }, mem: { totalPss: 100 },
    fps, jank: 0, bigJank: 0,
    net: { rxKBps: 1, txKBps: 1 }, gpu: 10,
    temperature: 34, cpuTemp: 50, battery: { currentNow: -30, power: 120 },
    cpuCores: { usage: [10], freq: [500] },
  });
  // 正常30 → 无帧null → 无帧null → 正常30
  [30, null, null, 30].forEach((f, i) => mgr.update(sample(i, f)));
  advance(1500);
  const fpsCalls = charts['chart-fps'].calls;
  check('FPS 图发生了 setOption', fpsCalls.length > 0);
  const last = fpsCalls[fpsCalls.length - 1];
  const lineData = last && last.series && last.series[0] && last.series[0].data;
  check('FPS 线注入了 4 个数据点', Array.isArray(lineData) && lineData.length === 4,
    lineData && lineData.length);
  if (Array.isArray(lineData) && lineData.length >= 4) {
    check('正常点保留数值 30', lineData[0].value === 30 && lineData[3].value === 30);
    check('无帧点1 → {value:0,noFrame:true}',
      lineData[1].value === 0 && lineData[1].noFrame === true, lineData[1]);
    check('无帧点2 → {value:0,noFrame:true}',
      lineData[2].value === 0 && lineData[2].noFrame === true, lineData[2]);
    check('全序列无空洞（每个点都有数值，曲线连续）',
      lineData.every(d => typeof d.value === 'number'));
  }
  const fpsOpt = mgr._buildFpsOption({ series: [] });
  check('FPS tooltip formatter 存在', typeof fpsOpt.tooltip.formatter === 'function');
  const tip = fpsOpt.tooltip.formatter([{
    seriesName: 'FPS', marker: '<span>', value: 0, data: { value: 0, noFrame: true },
  }]);
  check('tooltip 对无帧点显示「无帧（本周期无渲染）」', /无帧（本周期无渲染）/.test(tip), tip);
} catch (e) {
  fail += 1;
  console.log(' FAIL  端到端沙箱渲染异常: ' + (e && e.stack || e));
}

console.log(`\n结果：${pass} PASS / ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
