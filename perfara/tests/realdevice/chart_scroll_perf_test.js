'use strict';

/**
 * 采集期「上下滑动曲线图卡顿」修复的离线回归测试。
 *
 * 不依赖 playwright / 真实浏览器：用最小 DOM + echarts 桩在 vm 里加载
 * _client_src/app/renderer/charts.js，用可控假时钟驱动定时器，验证：
 *   1) dataZoom inside 不再抢滚轮 / 触摸拖动（页面滚动交还给 .charts-grid）
 *   2) update() 只写内部 state，setOption 只发给视口内可见的图表
 *   3) 滚动活跃期不重绘；滚动停止后补画；持续滚动有兜底上限，不会饿死数据
 *   4) 未测量值为 null 而不是 0
 *   5) 抽稀有上界，且 tag 下标在一次采样里只减半一次（旧实现会连除 11 次）
 *   6) 隐藏图表重新进入视口时会一次性补齐数据
 *   7) reset 清空所有脏状态，不会在之后补画旧数据
 *
 * 运行：node perfara/tests/realdevice/chart_scroll_perf_test.js
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
}

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC  = path.join(ROOT, '_client_src', 'app', 'renderer', 'charts.js');

const CHART_IDS = [
  'chart-cpu', 'chart-mem', 'chart-memdetail', 'chart-fps', 'chart-net', 'chart-gpu',
  'chart-temp', 'chart-current', 'chart-power', 'chart-cpu-cores', 'chart-cpu-freq',
];

function makeSample(n) {
  const t = String(Math.floor(n / 3600)).padStart(2, '0') + ':'
          + String(Math.floor(n / 60) % 60).padStart(2, '0') + ':'
          + String(n % 60).padStart(2, '0');
  return {
    time: t,
    cpu: { sysCpu: 12 + n % 7, procCpu: 3 },
    mem: { totalPss: 100 + n, nativeHeap: 10, javaHeap: 20, code: 5,
           stack: 1, graphics: 8, privateOther: 2, system: 3 },
    fps: 58, jank: 1, bigJank: 0,
    net: { rxKBps: 3, txKBps: 1 },
    gpu: 20,
    temperature: 34, cpuTemp: 60,
    battery: { currentNow: -36, power: 144 },
    cpuCores: { usage: [10, 20, 30, 40], freq: [500, 600, 700, 800] },
  };
}

/** 每个用例一份全新沙箱，避免 ChartManager 之间共享 CHART_CONFIGS 的动态序列状态 */
function createEnv() {
  let clock = 10000;
  let nextTimerId = 1;
  let timers = [];
  const fakeSetTimeout = (fn, ms) => {
    const id = nextTimerId++;
    timers.push({ id, at: clock + (ms || 0), fn });
    return id;
  };
  const fakeClearTimeout = (id) => {
    const i = timers.findIndex(t => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
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
  for (const id of CHART_IDS) {
    elements.set(id, {
      id, style: {}, offsetHeight: 200, dataset: {},
      clientWidth: 600, clientHeight: 200,
    });
  }
  const listeners = { window: {}, grid: {} };
  const addTo = (bag) => (type, fn) => { (bag[type] || (bag[type] = [])).push(fn); };
  const grid = { clientWidth: 1000, clientHeight: 700, addEventListener: addTo(listeners.grid) };

  const charts = {};
  const echarts = {
    init(el) {
      const c = {
        el, calls: [], resizes: 0, clears: 0,
        setOption(opt, flags) { c.calls.push({ opt, flags }); return c; },
        resize() { c.resizes++; },
        clear() { c.clears++; },
        on() {},
      };
      charts[el.id] = c;
      return c;
    },
  };

  let ioCb = null;
  class IntersectionObserverStub {
    constructor(cb, opts) { ioCb = cb; this.opts = opts; this.observed = []; }
    observe(el) { this.observed.push(el); }
    disconnect() {}
  }
  class ResizeObserverStub {
    constructor(cb) { this.cb = cb; }
    observe() {}
    disconnect() {}
  }

  const win = { addEventListener: addTo(listeners.window), innerWidth: 1200, innerHeight: 800 };
  const doc = {
    getElementById: id => elements.get(id) || null,
    querySelector: sel => (sel === '.charts-grid' ? grid : null),
    body: { classList: { contains: () => false } },
  };

  const sandbox = {
    window: win,
    document: doc,
    echarts,
    IntersectionObserver: IntersectionObserverStub,
    ResizeObserver: ResizeObserverStub,
    requestAnimationFrame: cb => fakeSetTimeout(cb, 0),
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    performance: { now: () => clock },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });

  return {
    Mgr: win.ChartManager,
    charts,
    elements,
    advance,
    now: () => clock,
    emit(scope, type, evt) {
      for (const fn of (listeners[scope] && listeners[scope][type]) || []) fn(evt || {});
    },
    fireIO(pairs) {
      ioCb(pairs.map(([id, visible]) => ({ target: elements.get(id), isIntersecting: visible })));
    },
    clearCalls() { for (const c of Object.values(charts)) c.calls.length = 0; },
    totalCalls() { return Object.values(charts).reduce((n, c) => n + c.calls.length, 0); },
  };
}

/** 起一个已完成初始化、且只有 cpu / fps 可见的 manager */
function readyEnv(visibleIds) {
  const env = createEnv();
  const mgr = new env.Mgr();
  mgr._doInit();
  env.advance(300);   // 让初始 resize 基线落地
  env.fireIO(CHART_IDS.map(id => [id, visibleIds.includes(id)]));
  env.advance(400);   // 让可见性变化触发的首轮 flush 落地
  env.clearCalls();
  return { env, mgr };
}

// ─── 1. 滚轮不再被 dataZoom 抢走 ──────────────────────────────────────────────
console.log('\n[1] 滚轮 / 触摸滚动不再被图表劫持');
{
  const env = createEnv();
  const mgr = new env.Mgr();
  const line = mgr._buildLineOption('cpu', { series: [{ name: '系统CPU' }] });
  const fps  = mgr._buildFpsOption({ series: [] });
  for (const [label, opt] of [['普通曲线图', line], ['FPS 混合图', fps]]) {
    const inside = opt.dataZoom.find(z => z.type === 'inside');
    check(label + '：moveOnMouseWheel=false', inside.moveOnMouseWheel === false, inside);
    check(label + '：moveOnMouseMove=false（触摸拖动也不抢）', inside.moveOnMouseMove === false, inside);
    check(label + '：保留 Shift+滚轮缩放', inside.zoomOnMouseWheel === 'shift', inside);
    check(label + '：保留 slider 可拖拽缩放', opt.dataZoom.some(z => z.type === 'slider'));
  }
}

// ─── 2. 只刷可见图表 ──────────────────────────────────────────────────────────
console.log('\n[2] update() 只写 state，setOption 只发给可见图表');
{
  const { env, mgr } = readyEnv(['chart-cpu', 'chart-fps']);
  mgr.update(makeSample(1));
  check('update() 同步阶段一次 setOption 都不做', env.totalCalls() === 0, env.totalCalls());
  check('11 张图的内部 state 都收到了数据点',
    Object.keys(mgr._data).length === 11 &&
    Object.values(mgr._data).every(st => st.times.length === 1));

  env.advance(300);
  check('可见的 CPU 图被刷新', env.charts['chart-cpu'].calls.length > 0);
  check('可见的 FPS 图被刷新', env.charts['chart-fps'].calls.length > 0);
  const hidden = CHART_IDS.filter(id => id !== 'chart-cpu' && id !== 'chart-fps');
  check('9 张不可见的图完全不 setOption',
    hidden.every(id => env.charts[id].calls.length === 0),
    hidden.map(id => [id, env.charts[id].calls.length]));
}

// ─── 3. 滚动期不重绘 / 滚动后补画 / 持续滚动有兜底 ─────────────────────────────
console.log('\n[3] 滚动空闲节流与饿死兜底');
{
  const { env, mgr } = readyEnv(['chart-cpu']);
  env.emit('window', 'wheel');
  mgr.update(makeSample(1));
  env.advance(40);
  env.emit('window', 'wheel');
  env.advance(60);
  check('滚动活跃期不做 setOption', env.totalCalls() === 0, env.totalCalls());

  env.advance(1500);   // 滚动停止
  check('滚动停止后补画可见图表', env.charts['chart-cpu'].calls.length > 0);
  check('隐藏图表仍不重绘',
    CHART_IDS.filter(id => id !== 'chart-cpu').every(id => env.charts[id].calls.length === 0));
}
{
  const { env, mgr } = readyEnv(['chart-cpu']);
  // 模拟「用户一直匀速滚」：每 50ms 一次 wheel，每 200ms 一个采样点
  for (let i = 0; i < 24; i++) {
    env.emit('window', 'wheel');
    if (i % 4 === 0) mgr.update(makeSample(i));
    env.advance(50);
  }
  check('持续滚动超过 1s 仍会兜底补画（数据不饿死）',
    env.charts['chart-cpu'].calls.length > 0, env.charts['chart-cpu'].calls.length);
}

// ─── 4. null 语义 ────────────────────────────────────────────────────────────
console.log('\n[4] 未测量值写 null，不画假 0 线');
{
  const { env, mgr } = readyEnv(['chart-cpu']);
  const s = makeSample(1);
  s.cpu.sysCpu = null;
  s.net.rxKBps = undefined;
  s.gpu = NaN;
  s.battery.currentNow = null;
  mgr.update(s);
  const last = arr => arr[arr.length - 1];
  check('CPU 未测量 → null', last(mgr._data.cpu.series[0]) === null, last(mgr._data.cpu.series[0]));
  check('下行速率未测量 → null', last(mgr._data.net.series[0]) === null, last(mgr._data.net.series[0]));
  check('GPU NaN → null', last(mgr._data.gpu.series[0]) === null, last(mgr._data.gpu.series[0]));
  check('电流未测量 → null', last(mgr._data.current.series[0]) === null, last(mgr._data.current.series[0]));
  check('正常数值仍保留', last(mgr._data.cpu.series[1]) === 3, last(mgr._data.cpu.series[1]));
}

// ─── 5. 抽稀上界与 tag 下标只减半一次 ─────────────────────────────────────────
console.log('\n[5] 抽稀上界与场景标记下标');
{
  const { env, mgr } = readyEnv(['chart-cpu']);
  mgr.setTags([[10, 20]]);
  env.advance(300);
  check('setTags 后标记区间原样保留', JSON.stringify(mgr._tags) === '[[10,20]]', mgr._tags);

  // MAX_RENDER_POINTS=900 → 超过 1800 点时抽稀
  for (let i = 0; i < 1801; i++) mgr.update(makeSample(i));
  check('抽稀后渲染点数有上界（<=1800）',
    mgr._data.cpu.times.length <= 1800, mgr._data.cpu.times.length);
  check('隐藏的图表同样被抽稀', mgr._data.mem.times.length <= 1800, mgr._data.mem.times.length);
  check('一次采样里 tag 下标只减半一次（旧实现会连除 11 次塌成 0）',
    JSON.stringify(mgr._tags) === '[[5,10]]', mgr._tags);
}

// ─── 6. 隐藏图表进入视口后补齐 ───────────────────────────────────────────────
console.log('\n[6] 图表滚入视口后一次性补齐');
{
  const { env, mgr } = readyEnv(['chart-cpu']);
  for (let i = 0; i < 8; i++) mgr.update(makeSample(i));
  env.advance(300);
  check('不可见的 GPU 图期间没有 setOption', env.charts['chart-gpu'].calls.length === 0);

  env.clearCalls();
  const resizeBaseline = env.charts['chart-gpu'].resizes;
  env.fireIO(CHART_IDS.map(id => [id, id === 'chart-cpu' || id === 'chart-gpu']));
  env.advance(300);
  check('GPU 图滚入视口后被补齐', env.charts['chart-gpu'].calls.length > 0);
  check('滚入视口时画布尺寸被重算（hidden→shown 后不会是 0 尺寸）',
    env.charts['chart-gpu'].resizes > resizeBaseline,
    { before: resizeBaseline, after: env.charts['chart-gpu'].resizes });
  const call = env.charts['chart-gpu'].calls.find(c => c.opt && c.opt.xAxis);
  const xLen = call ? call.opt.xAxis[0].data.length : null;
  check('补齐的是全量历史而非只补最后一个点', xLen === 8, xLen);
}

// ─── 7. reset 清空脏状态 ─────────────────────────────────────────────────────
console.log('\n[7] reset 不残留待补画的旧数据');
{
  const { env, mgr } = readyEnv(['chart-cpu']);
  mgr.update(makeSample(1));
  mgr.reset();
  check('reset 后 dirty 集合为空', mgr._dirty.size === 0, [...mgr._dirty]);
  check('reset 后没有排队中的 flush', mgr._flushTimer === null);
  check('reset 后 fps 截图标记脏位清空', mgr._fpsMarksDirty === false);
  env.clearCalls();
  env.advance(2000);
  check('reset 之后不会再把旧数据补画回去', env.totalCalls() === 0, env.totalCalls());
}

console.log('\n──────────────────────────────────────────');
console.log(`  ${pass} PASS / ${fail} FAIL`);
console.log('──────────────────────────────────────────');
process.exit(fail ? 1 : 0);
