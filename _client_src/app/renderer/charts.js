'use strict';

const COLORS = {
  cpu:       ['#4f8ef7', '#79d4f7'],
  mem:       ['#3ecf8e'],
  memDetail: ['#3ecf8e', '#4f8ef7', '#f5d020', '#c77dff', '#f5a623', '#ff79a8', '#79d4f7'],
  fps:       ['#f5d020', '#f5a623', '#f85151'],  // fps, jank, bigJank
  net:       ['#c77dff', '#ff79a8'],
  gpu:       ['#f5a623'],
  temp:      ['#f85151', '#f5a623'],  // 机身温度（红）/ CPU 结温（橙）：两条线必须异色可辨
  current:   ['#79d4f7'],
  power:     ['#f5a623'],
  // Per-core: up to 16 cores (cycles if fewer defined)
  cpuCores:  ['#4f8ef7','#79d4f7','#3ecf8e','#a8e6cf','#f5a623','#f5d020','#f85151','#c77dff',
               '#ff79a8','#b5e853','#53e8e8','#ffa552','#e87bff','#5effd6','#ff5e5e','#b0b8ff'],
  cpuFreq:   ['#4f8ef7','#79d4f7','#3ecf8e','#a8e6cf','#f5a623','#f5d020','#f85151','#c77dff',
               '#ff79a8','#b5e853','#53e8e8','#ffa552','#e87bff','#5effd6','#ff5e5e','#b0b8ff'],
};

/** PC 页 body.platform-pc：内存曲线为 Windows 工作集（RSS），非 Android PSS */
function patchChartConfigsForPcPlatform() {
  try {
    if (
      typeof document !== 'undefined' &&
      document.body &&
      document.body.classList.contains('platform-pc') &&
      CHART_CONFIGS.mem &&
      CHART_CONFIGS.mem.series &&
      CHART_CONFIGS.mem.series[0]
    ) {
      const k = CHART_CONFIGS.mem.series[0].key;
      CHART_CONFIGS.mem = {
        ...CHART_CONFIGS.mem,
        series: [{ name: '工作集内存', key: k }],
      };
    }
  } catch (_) {}
}

/**
 * 单张曲线最多保留的渲染点数。
 * 采集是每秒一个点，每次 setOption 都要回传全量数组；点数越多 echarts 的重绘越贵，
 * 长时间跑（>1 小时）会累计成 O(n²)。超过本阈值的 2 倍时隔点抽稀一次，
 * 把渲染点数稳定在 [N, 2N] 区间。
 * 900 / 1800 足够在 ~600px 宽的图上判读趋势；完整分辨率数据仍在 CSV / 报告里，
 * 实时曲线不需要保留上万个点。
 */
const MAX_RENDER_POINTS = 900;

/**
 * 用 lazyUpdate 把同一帧内的多次 setOption 合并成一次真实重绘，
 * silent 跳过无谓的事件派发。
 */
const LAZY_OPT = { lazyUpdate: true, silent: true };

/** 滚动 / 滚轮停止多久后才允许重绘（ms）：滚动期间不跟手势抢主线程 */
const RENDER_IDLE_MS = 120;
/** 两次批量重绘之间的最小间隔（ms）：防止高频采集源把主线程打满 */
const RENDER_MIN_GAP_MS = 200;
/** 即使用户一直在滚，最多压后这么久也必须补画一次，避免曲线长期不更新 */
const RENDER_MAX_DEFER_MS = 1000;

/**
 * 「没测到」和「实测为 0」必须区分：写 0 会画出一条假的 0 线，
 * 也会让曲线在缺失点之间连成连续密线。返回 null 让 echarts 断线。
 */
function toNumOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = +v;
  return (isNaN(n) || !isFinite(n)) ? null : n;
}

/** 'HH:MM:SS' → 当日秒数；无法解析返回 null（曲线 x 轴与截图时间都是这个格式） */
function hmsToSec(s) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}

const TROUGH_MARK_SIZE = [36, 80];
const TROUGH_MARK_OFFSET = [0, -46];
const TROUGH_MARK_MAX_DRIFT_SEC = 20;

// For each chart: what series to render and how to extract from a data point
const CHART_CONFIGS = {
  cpu: {
    el: 'chart-cpu',
    series: [
      { name: '系统CPU', key: d => d.cpu.sysCpu },
      { name: '进程CPU', key: d => d.cpu.procCpu },
    ],
    type: 'line',
    fmt: v => v + '%',
  },
  mem: {
    el: 'chart-mem',
    series: [{ name: 'PSS', key: d => d.mem.totalPss }],
    type: 'line',
    fmt: v => v + ' MB',
  },
  memDetail: {
    el: 'chart-memdetail',
    series: [
      { name: 'NativeHeap',   key: d => d.mem.nativeHeap },
      { name: 'JavaHeap',     key: d => d.mem.javaHeap },
      { name: 'Code',         key: d => d.mem.code },
      { name: 'Stack',        key: d => d.mem.stack },
      { name: 'Graphics',     key: d => d.mem.graphics },
      { name: 'PrivateOther', key: d => d.mem.privateOther },
      { name: 'System',       key: d => d.mem.system },
    ],
    type: 'line',
    fmt: v => v + ' MB',
  },
  fps: {
    el: 'chart-fps',
    // Mixed: line for fps (left axis), bar for jank & bigJank (right axis)
    series: [
      { name: 'FPS',     key: d => d.fps,     type: 'line', yAxisIndex: 0 },
      { name: 'Jank',    key: d => d.jank,    type: 'bar',  yAxisIndex: 1 },
      { name: 'BigJank', key: d => d.bigJank, type: 'bar',  yAxisIndex: 1 },
    ],
    fmt: v => v,
    mixed: true,
  },
  net: {
    el: 'chart-net',
    series: [
      { name: '下行', key: d => d.net.rxKBps },
      { name: '上行', key: d => d.net.txKBps },
    ],
    type: 'line',
    fmt: v => v + ' KB/s',
  },
  gpu: {
    el: 'chart-gpu',
    series: [{ name: 'GPU', key: d => d.gpu }],
    type: 'line',
    fmt: v => v + '%',
  },
  temp: {
    el: 'chart-temp',
    // 机身温度与 CPU 结温分列两条线：旧写法 d.temperature || d.battery.temperature
    // 会把 0/null 混为一谈，且老数据里 battery.temperature 可能是芯片结温。
    // 这里只接受正的机身/电池温度，回退源同样来自 dumpsys battery（语义相同）。
    series: [
      { name: '机身温度', key: d => {
        if (typeof d.temperature === 'number' && d.temperature > 0) return d.temperature;
        const b = d.battery && d.battery.temperature;
        return (typeof b === 'number' && b > 0) ? b : null;
      } },
      { name: 'CPU 结温', key: d => (typeof d.cpuTemp === 'number' && d.cpuTemp > 0) ? d.cpuTemp : null },
    ],
    type: 'line',
    fmt: v => v + '°C',
  },
  current: {
    el: 'chart-current',
    // 无电池 / 读不到电流时断线，不画 0 线冒充「实测 0mA」；
    // PC 侧 battery 整组为 null，取值前必须判空
    series: [{ name: '电流', key: d => (d.battery ? d.battery.currentNow : null) ?? null }],
    type: 'line',
    fmt: v => v + ' mA',
  },
  power: {
    el: 'chart-power',
    series: [{ name: '功耗', key: d => (d.battery ? d.battery.power : null) ?? null }],
    type: 'line',
    fmt: v => v + ' mW',
  },
  cpuCores: {
    el: 'chart-cpu-cores',
    series: [],          // populated dynamically on first data
    dynamic: true,
    keyFn: d => d.cpuCores ? d.cpuCores.usage : [],
    fmt: v => v + '%',
  },
  cpuFreq: {
    el: 'chart-cpu-freq',
    series: [],
    dynamic: true,
    keyFn: d => d.cpuCores ? d.cpuCores.freq : [],
    fmt: v => v + ' MHz',
  },
};

class ChartManager {
  constructor() {
    this._charts = {};
    this._data   = {};
    this._ready  = false;
    this._tags = [];
    this._troughShots = [];
    this._onTroughShotClick = null;

    // ─── 滚动期渲染节流 / 可见性门控 ──────────────────────────────────────────
    // .charts-grid 是纵向滚动容器，一屏只可见 2~3 张图；旧实现每秒给全部 11 张
    // 回传全量数组 setOption，滚动时与合成/布局抢主线程，表现为「上下滑动卡顿」。
    this._visible       = new Set();   // 当前在视口（含预取边距）内的图表名
    this._elToName      = new Map();   // chart DOM → 图表名，供 IntersectionObserver 反查
    this._dirty         = new Set();   // 有新数据待 setOption 的图表名
    this._flushTimer    = null;
    this._lastFlushAt   = 0;
    this._lastScrollAt  = 0;
    this._firstDirtyAt  = 0;
    this._fpsMarksDirty = false;
    this._io            = null;
    this._ro            = null;
    // 各页面的 main 脚本各建一个实例；trough-shots.js 通过 window.chartMgr 接线
    window.chartMgr = this;
  }

  init() {
    const boot = () => requestAnimationFrame(() => setTimeout(() => this._doInit(), 120));
    // echarts 由页面内联脚本异步注入（见 *.html 的 window.echartsReady）：
    // 等它就绪再建图表，窗口与日志面板不必等 1MB 库解析完才显示。
    if (typeof window.echartsReady === 'function') {
      window.echartsReady().then(boot, boot);
    } else {
      boot();
    }
  }

  _doInit() {
    // 加载失败时静默降级：不建图表，其余 UI 照常（日志/按钮/上传都不依赖 echarts）
    if (typeof echarts === 'undefined') return;
    patchChartConfigsForPcPlatform();
    for (const [name, cfg] of Object.entries(CHART_CONFIGS)) {
      const el = document.getElementById(cfg.el);
      if (!el) continue;
      if (el.offsetHeight === 0) el.style.minHeight = '120px';

      const chart = echarts.init(el, 'dark');
      this._charts[name] = chart;
      this._data[name]   = { times: [], series: cfg.series.map(() => []) };
      if (!cfg.dynamic) chart.setOption(this._buildOption(name, cfg));
    }
    this._ready = true;

    const fpsChart = this._charts.fps;
    if (fpsChart) {
      fpsChart.on('click', (p) => {
        if (!p || p.componentType !== 'markPoint' || !p.data) return;
        const shot = this._troughShots[p.data.shotIdx];
        if (shot && this._onTroughShotClick) this._onTroughShotClick(shot);
      });
    }
    if (this._troughShots.length) this._renderTroughMarks();

    const grid = document.querySelector('.charts-grid');

    // 旧实现：ResizeObserver 一回调就给 11 张图全部 resize()。滚动、指标显隐、
    // 布局抖动都会触发，等价于每帧一次全量重排。这里改成：
    //   ① debounce；② 容器宽高没真的变化就整批跳过（滚动本身不改变容器尺寸）。
    let lastW = -1, lastH = -1, resizeTimer = null;
    const resizeAll = () => {
      resizeTimer = null;
      const g = document.querySelector('.charts-grid');
      const w = g ? g.clientWidth  : (window.innerWidth  | 0);
      const h = g ? g.clientHeight : (window.innerHeight | 0);
      if (w === lastW && h === lastH) return;
      lastW = w; lastH = h;
      for (const c of Object.values(this._charts)) {
        try { c.resize(); } catch (_) {}
      }
    };
    const scheduleResize = () => {
      if (resizeTimer != null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resizeAll, 120);
    };
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(scheduleResize);
      if (grid) this._ro.observe(grid);
    }
    window.addEventListener('resize', scheduleResize, { passive: true });

    this._bindScrollIdle();
    this._setupVisibility();
    scheduleResize();   // 建立初始尺寸基线，顺带修正 init 时 0 尺寸的画布
  }

  /** 把滚轮 / 触摸 / 滚动都记为「正在滚动」，重绘统一压到滚动空闲后 */
  _bindScrollIdle() {
    const grid = document.querySelector('.charts-grid');
    let endTimer = null;
    const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const onActivity = () => {
      this._lastScrollAt = nowMs();
      // 滚动停止后补一次刷新：滚动期间攒下的点不能一直不画
      if (endTimer != null) clearTimeout(endTimer);
      endTimer = setTimeout(() => {
        endTimer = null;
        this._scheduleFlush();
      }, RENDER_IDLE_MS + 40);
    };
    const opts = { passive: true };
    // wheel / touchmove 会在图表 canvas 上冒泡到 window，能覆盖 11 张图的任意位置
    window.addEventListener('wheel', onActivity, opts);
    window.addEventListener('touchmove', onActivity, opts);
    (grid || window).addEventListener('scroll', onActivity, opts);
  }

  /** 只跟踪视口内的图表；老 webview 无 IntersectionObserver 时退回「全部可见」 */
  _setupVisibility() {
    const grid = document.querySelector('.charts-grid');
    for (const [name, cfg] of Object.entries(CHART_CONFIGS)) {
      const el = document.getElementById(cfg.el);
      if (el) this._elToName.set(el, name);
    }
    if (!grid || typeof IntersectionObserver === 'undefined') {
      for (const name of Object.keys(this._charts)) this._visible.add(name);
      return;
    }
    this._io = new IntersectionObserver((entries) => {
      let changed = false;
      for (const e of entries) {
        const name = this._elToName.get(e.target);
        if (!name) continue;
        const state = this._data[name];
        if (e.isIntersecting) {
          if (!this._visible.has(name)) {
            this._visible.add(name);
            // 隐藏期间攒下的点要一次性补画；hidden→shown 后画布尺寸也变了
            this._dirty.add(name);
            if (state) { state.needTags = true; state.needResize = true; }
            changed = true;
          }
        } else if (this._visible.delete(name)) {
          changed = true;
        }
      }
      if (changed) this._scheduleFlush();
    }, { root: grid, rootMargin: '160px 0px', threshold: 0 });
    for (const el of this._elToName.keys()) this._io.observe(el);
  }

  /** 合并一帧内的所有刷新请求：滚动中压后，空闲后一次性只刷可见图表 */
  _scheduleFlush() {
    if (!this._ready) return;
    const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const now = nowMs();
    if (!this._firstDirtyAt) this._firstDirtyAt = now;
    if (this._flushTimer != null) return;
    const wait = Math.max(RENDER_IDLE_MS, RENDER_MIN_GAP_MS - (now - this._lastFlushAt));
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      const t = nowMs();
      const scrolling = (t - this._lastScrollAt) < RENDER_IDLE_MS;
      const starving  = (t - this._firstDirtyAt) >= RENDER_MAX_DEFER_MS;
      if (scrolling && !starving) { this._scheduleFlush(); return; }
      this._firstDirtyAt = 0;
      this._lastFlushAt  = t;
      this._flushVisible();
    }, wait);
  }

  _flushVisible() {
    for (const name of this._visible) {
      const cfg = CHART_CONFIGS[name];
      if (cfg) this._flushOne(name, cfg);
    }
  }

  update(d) {
    if (!this._ready) return;
    // 数据始终写进内部 state（纯数组 push，11 张图一帧也只有几十次赋值，开销可忽略），
    // 保证不错点；真正的 setOption 由 _scheduleFlush 合并后「只刷可见图表」。
    let decimated = false;
    for (const [name, cfg] of Object.entries(CHART_CONFIGS)) {
      try {
        if (this._appendPoint(name, cfg, d)) decimated = true;
      } catch (_) {
        // isolate per-chart errors
      }
    }
    if (decimated) {
      // tag 下标是按 times 下标记的：一次采样里所有图同时抽稀，只能整体缩放一次。
      // 旧实现把缩放放在 _decimateIfNeeded 里逐图执行，11 张图会连除 11 次，
      // 场景标记区间会直接塌成 0。
      this._halveTags();
      for (const state of Object.values(this._data)) state.needTags = true;
      // 抽稀删掉了一半类目，截图锚点必须重新投影到保留下来的点（否则整张不显示）
      this._renderTroughMarks();
    }
    this._scheduleFlush();
  }

  setTags(tags) {
    const src = Array.isArray(tags) ? tags : [];
    // 存内部副本：抽稀时要把下标按比例缩小，不能直接改调用方数组
    // （renderer 的 _sceneTags 同一份数据还要上报给主进程写进报告）。
    this._tags = src.map(seg => (Array.isArray(seg) ? [seg[0], seg[1]] : seg));
    if (!this._ready) return;
    // 只打脏标记，同样走批量 flush：避免为了一个标记给 11 张图各来一次 setOption
    for (const state of Object.values(this._data)) state.needTags = true;
    this._scheduleFlush();
  }

  _buildTagMarkAreaData(times) {
    if (!Array.isArray(times) || times.length === 0) return [];
    const out = [];
    const tags = Array.isArray(this._tags) ? this._tags : [];
    for (const seg of tags) {
      if (!Array.isArray(seg) || seg.length < 2) continue;
      let s = seg[0], e = seg[1];
      if (s == null || e == null) continue;
      s = Math.max(0, Math.min(times.length - 1, s | 0));
      e = Math.max(0, Math.min(times.length - 1, e | 0));
      if (e < s) continue;
      out.push([{ xAxis: times[s] }, { xAxis: times[e] }]);
    }
    return out;
  }

  _applyTagMarkAreas(cfg, state, chart) {
    const data = this._buildTagMarkAreaData(state.times);
    const markArea = data.length
      ? {
          silent: true,
          itemStyle: { color: 'rgba(121, 212, 247, 0.14)' }, // light blue
          data,
        }
      : null;

    const patch = cfg.series.map(() => ({
      markArea: markArea || { data: [] },
    }));
    chart.setOption({ series: patch }, LAZY_OPT);
  }

  /**
   * 只追加一个采样点到内部 state，不碰 echarts。
   * @returns {boolean} 本次是否发生抽稀（调用方据此整体缩放一次 tag 下标）
   */
  _appendPoint(name, cfg, d) {
    const state = this._data[name];
    if (!state || !this._charts[name]) return false;

    if (cfg.dynamic) {
      let vals = [];
      try {
        vals = cfg.keyFn(d) || [];
      } catch (_) {
        vals = [];
      }
      const count = vals.length;
      if (count === 0) return false;   // 没读到核心数就不追加，避免时间轴空转

      // 核心数首次已知 / 变化时重建整张 option，但延后到「可见时」再做
      if (state.series.length !== count) {
        cfg.series   = Array.from({ length: count }, (_, i) => ({ name: `Core ${i}` }));
        state.times  = [];
        state.series = Array.from({ length: count }, () => []);
        state.needRebuild = true;
      }

      state.times.push(d && d.time != null ? d.time : '');
      vals.forEach((v, i) => {
        if (!state.series[i]) state.series[i] = [];
        state.series[i].push(toNumOrNull(v));
      });
      this._dirty.add(name);
      return this._decimateIfNeeded(state);
    }

    // 静态序列图
    state.times.push(d && d.time != null ? d.time : '');
    cfg.series.forEach((s, i) => {
      let v;
      try {
        v = s.key(d);
      } catch (_) {
        v = null;
      }
      if (!state.series[i]) state.series[i] = [];
      state.series[i].push(toNumOrNull(v));
    });
    this._dirty.add(name);
    return this._decimateIfNeeded(state);
  }

  /** 真正把 state 刷进 echarts；只由 _flushVisible 对可见图表调用 */
  _flushOne(name, cfg) {
    const state = this._data[name];
    const chart = this._charts[name];
    if (!state || !chart) return;

    const wantData    = this._dirty.has(name);
    const wantRebuild = !!state.needRebuild;
    const wantTags    = !!state.needTags;
    const wantMarks   = (name === 'fps' && this._fpsMarksDirty);
    if (!wantData && !wantRebuild && !wantTags && !wantMarks) return;

    try {
      if (state.needResize) {
        chart.resize();
        state.needResize = false;
      }
      if (wantRebuild) {
        // notMerge 清掉旧序列，避免核心数变少时残留上一条曲线
        chart.setOption(this._buildLineOption(name, cfg),
          { notMerge: true, lazyUpdate: true, silent: true });
        state.needRebuild = false;
        state.needTags = true;   // 重建会连带清掉 markArea
      }
      if (wantData || wantRebuild) {
        const yAxisPatch = cfg.mixed ? [{ min: 0 }, { min: 0 }] : [{ min: 0 }];
        chart.setOption({
          xAxis:  [{ data: state.times }],
          yAxis:  yAxisPatch,
          series: state.series.map(s => ({ data: s })),
        }, LAZY_OPT);
        this._dirty.delete(name);
      }
      if (wantTags || state.needTags) {
        this._applyTagMarkAreas(cfg, state, chart);
        state.needTags = false;
      }
      if (wantMarks) this._applyTroughMarksNow();
    } catch (_) {
      // isolate per-chart errors
    }
  }

  /**
   * 点数超过 2×MAX_RENDER_POINTS 时隔点抽稀，把渲染成本从「随采集时长线性增长」
   * 拉回恒定。
   * tag 下标缩放刻意不在这里做：每张图都会各自调用本方法，放在这里会被执行 11 次。
   * @returns {boolean} 本次是否发生了抽稀
   */
  _decimateIfNeeded(state) {
    const n = state.times.length;
    if (n <= MAX_RENDER_POINTS * 2) return false;
    const half = Math.ceil(n / 2);
    const times = new Array(half);
    const series = state.series.map(() => new Array(half));
    for (let i = 0, k = 0; i < n; i += 2, k++) {
      times[k] = state.times[i];
      for (let s = 0; s < series.length; s++) series[s][k] = state.series[s][i];
    }
    state.times = times;
    state.series = series;
    return true;
  }

  /** 一次采样内所有图同时抽稀，tag 下标整体减半且只减一次（内部副本） */
  _halveTags() {
    if (!Array.isArray(this._tags) || !this._tags.length) return;
    this._tags = this._tags.map(seg => (
      Array.isArray(seg) ? [Math.floor(seg[0] / 2), Math.floor(seg[1] / 2)] : seg
    ));
  }

  reset() {
    // 清掉排队中的批量刷新与所有脏标记，避免 reset 之后旧数据又被补画回去
    if (this._flushTimer != null) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    this._firstDirtyAt = 0;
    this._dirty.clear();
    this._fpsMarksDirty = false;
    this._tags = [];
    this._troughShots = [];
    for (const [name, cfg] of Object.entries(CHART_CONFIGS)) {
      const state = this._data[name];
      const chart = this._charts[name];
      if (!state) continue;
      state.needRebuild = false;
      state.needTags    = false;
      state.needResize  = false;

      if (cfg.dynamic) {
        state.times  = [];
        state.series = [];
        cfg.series   = [];
        if (chart) chart.clear();   // wipe rendered content, keep instance alive
        continue;
      }

      state.times  = [];
      state.series = cfg.series.map(() => []);
      if (chart) chart.setOption({
        xAxis:    [{ data: [] }],
        series:   cfg.series.map(() => ({ data: [] })),
        dataZoom: [{ start: 0, end: 100 }],
      });
    }
    if (this._charts.fps) this._applyTroughMarksNow();   // reset 要立刻抹掉截图标记
  }

  /** 当前曲线的最后一个 x 轴索引（基于 times.length - 1）。若还没有数据点，返回 -1。 */
  // ─── 低谷截图标记 ──────────────────────────────────────────────────────────

  /** 整批替换（报告/回放用）；传入项需含 {time, fps, thumb|url|file} */
  setTroughShots(list) {
    this._troughShots = Array.isArray(list) ? list.slice() : [];
    // 整批替换只在报告/回放时发生，不是高频路径，同步画完避免「标记迟到」
    this._applyTroughMarksNow();
  }

  /** 采集时每命中一次低谷追加一张 */
  pushTroughShot(shot) {
    if (!shot || !(shot.thumb || shot.url || shot.file)) return;
    this._troughShots.push(shot);
    this._renderTroughMarks();
  }

  clearTroughShots() {
    this._troughShots = [];
    // 清空是用户显式动作，必须立刻从曲线上消失：只打脏标记会让标记多留一帧以上，
    // 看起来像「点了没反应」。
    this._applyTroughMarksNow();
  }

  /** 点击曲线上的截图标记时回调（参数为 pushTroughShot 传入的对象） */
  onTroughShotClick(cb) {
    this._onTroughShotClick = typeof cb === 'function' ? cb : null;
  }

  /** 只打脏标记，等下一次批量 flush 再画；采集期命中低谷时不再同步 setOption */
  _renderTroughMarks() {
    this._fpsMarksDirty = true;
    this._scheduleFlush();
  }

  _applyTroughMarksNow() {
    this._fpsMarksDirty = false;
    const chart = this._charts.fps;
    const state = this._data.fps;
    if (!chart || !state) return;
    try {
      chart.setOption({
        series: [{
          name: 'FPS',
          markPoint: {
            silent: false,
            animation: false,
            label: { show: false },
            data: this._buildTroughMarkPoints(state.times),
          },
        }],
      }, LAZY_OPT);
    } catch (_) {}
  }

  /**
   * 把截图时间投影到当前渲染时间轴上（长跑抽稀后会删掉一半类目，
   * 直接拿原始时间当 category 会整张不渲染）。
   */
  _buildTroughMarkPoints(times) {
    if (!Array.isArray(times) || !times.length || !this._troughShots.length) return [];
    const secs = times.map(hmsToSec);
    const marks = [];
    this._troughShots.forEach((s, i) => {
      const target = hmsToSec(s.time);
      if (target == null) return;
      let best = -1;
      let bestDrift = Infinity;
      for (let k = 0; k < secs.length; k++) {
        if (secs[k] == null) continue;
        const drift = Math.abs(secs[k] - target);
        if (drift < bestDrift) { bestDrift = drift; best = k; }
      }
      if (best < 0 || bestDrift > TROUGH_MARK_MAX_DRIFT_SEC) return;
      marks.push({
        name: 'trough' + i,
        shotIdx: i,
        coord: [times[best], s.fps],
        value: s.fps,
        symbol: 'image://' + (s.thumb || s.url || s.file),
        symbolSize: TROUGH_MARK_SIZE,
        symbolOffset: TROUGH_MARK_OFFSET,
        itemStyle: { shadowBlur: 10, shadowColor: 'rgba(77,163,255,.85)' },
      });
    });
    return marks;
  }


  getLastXIndex() {
    let maxLen = 0;
    for (const st of Object.values(this._data || {})) {
      const len = (st && Array.isArray(st.times)) ? st.times.length : 0;
      if (len > maxLen) maxLen = len;
    }
    return maxLen > 0 ? (maxLen - 1) : -1;
  }

  // ─── Option builders ───────────────────────────────────────────────────────

  _buildOption(name, cfg) {
    return cfg.mixed ? this._buildFpsOption(cfg) : this._buildLineOption(name, cfg);
  }

  _buildLineOption(name, cfg) {
    const colors = COLORS[name] || ['#4f8ef7'];
    return {
      backgroundColor: 'transparent',
      color: colors,
      animation: false,
      grid: { top: 18, right: 12, bottom: 44, left: 44 },
      dataZoom: [
        { type: 'slider', xAxisIndex: 0, bottom: 4, height: 16, start: 0, end: 100,
          textStyle: { color: '#8a90a0', fontSize: 9 },
          backgroundColor: '#1e2230', fillerColor: 'rgba(79,142,247,0.15)',
          borderColor: '#2a2f3d', handleStyle: { color: '#4f8ef7' } },
        // 原来 moveOnMouseWheel:true 会让「每一个」滚轮事件都变成 dataZoom 平移：
        //  ① echarts 的 RoamController 调 eventTool.stop(e.event) 吞掉页面滚动；
        //  ② 每次滚轮都触发整张图（数千点）重排重绘，采集期 11 张图叠加 → 上下滑动严重卡顿。
        // 现在普通滚轮 / 双指滑动交还给 .charts-grid 滚页面；
        // 需要缩放请按 Shift + 滚轮，或直接拖底部 slider / 拖两端手柄。
        { type: 'inside', xAxisIndex: 0,
          moveOnMouseWheel: false, moveOnMouseMove: false, zoomOnMouseWheel: 'shift' },
      ],
      tooltip: {
        trigger: 'axis',
        formatter: p => p.map(x => `${x.marker}${x.seriesName}: ${x.value == null ? '--' : cfg.fmt(x.value)}`).join('<br>'),
        backgroundColor: '#1e2230', borderColor: '#2a2f3d',
        textStyle: { color: '#e0e4ef', fontSize: 11 },
      },
      legend: cfg.series.length > 1
        ? { data: cfg.series.map(s => s.name), top: 0, right: 4, textStyle: { color: '#8a90a0', fontSize: 10 } }
        : { show: false },
      xAxis: [{ type: 'category', data: [], boundaryGap: false,
        axisLine: { lineStyle: { color: '#2a2f3d' } },
        axisLabel: { color: '#8a90a0', fontSize: 10 },
        splitLine: { show: false } }],
      yAxis: [{
        type: 'value',
        min: 0,
        // 不设置 max：随当前序列数据自适应纵轴范围（三种平台共用此逻辑）
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: '#8a90a0', fontSize: 10 },
        splitLine: { lineStyle: { color: '#1e2230' } },
      }],
      series: cfg.series.map((s, i) => ({
        name: s.name, type: 'line', data: [], smooth: true, symbol: 'none',
        lineStyle: { width: 2, color: colors[i] || colors[0] },
        areaStyle: { color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: hexA(colors[i] || colors[0], 0.35) },
            { offset: 1, color: hexA(colors[i] || colors[0], 0.02) },
          ],
        }},
      })),
    };
  }

  // FPS chart: mixed line (FPS, left axis) + bar (Jank/BigJank, right axis)
  _buildFpsOption(cfg) {
    const [cFps, cJank, cBig] = COLORS.fps;
    return {
      backgroundColor: 'transparent',
      animation: false,
      grid: { top: 20, right: 48, bottom: 44, left: 44 },
      dataZoom: [
        { type: 'slider', xAxisIndex: 0, bottom: 4, height: 16, start: 0, end: 100,
          textStyle: { color: '#8a90a0', fontSize: 9 },
          backgroundColor: '#1e2230', fillerColor: 'rgba(79,142,247,0.15)',
          borderColor: '#2a2f3d', handleStyle: { color: '#4f8ef7' } },
        // 原来 moveOnMouseWheel:true 会让「每一个」滚轮事件都变成 dataZoom 平移：
        //  ① echarts 的 RoamController 调 eventTool.stop(e.event) 吞掉页面滚动；
        //  ② 每次滚轮都触发整张图（数千点）重排重绘，采集期 11 张图叠加 → 上下滑动严重卡顿。
        // 现在普通滚轮 / 双指滑动交还给 .charts-grid 滚页面；
        // 需要缩放请按 Shift + 滚轮，或直接拖底部 slider / 拖两端手柄。
        { type: 'inside', xAxisIndex: 0,
          moveOnMouseWheel: false, moveOnMouseMove: false, zoomOnMouseWheel: 'shift' },
      ],
      legend: {
        data: ['FPS', 'Jank', 'BigJank'],
        // 居中：right:4 会压在右 y 轴名称「卡顿」（轴顶渲染）上
        top: 0, left: 'center',
        textStyle: { color: '#8a90a0', fontSize: 10 },
      },
      tooltip: {
        trigger: 'axis',
        formatter: params => {
          return params.map(p => {
            const suf = p.seriesName === 'FPS' ? ' fps'
                      : p.seriesName === 'Jank' ? ' 帧'
                      : ' 帧';
            const shown = p.value == null ? '--' : `<b>${p.value}</b>${suf}`;
            return `${p.marker}${p.seriesName}: ${shown}`;
          }).join('<br>');
        },
        backgroundColor: '#1e2230', borderColor: '#2a2f3d',
        textStyle: { color: '#e0e4ef', fontSize: 11 },
      },
      xAxis: [{ type: 'category', data: [], boundaryGap: true,
        axisLine: { lineStyle: { color: '#2a2f3d' } },
        axisLabel: { color: '#8a90a0', fontSize: 10 },
        splitLine: { show: false } }],
      yAxis: [
        // left: FPS（不固定上限，随数据自适应）
        { type: 'value', name: 'FPS', min: 0,
          nameTextStyle: { color: '#8a90a0', fontSize: 10 },
          axisLine: { show: false }, axisTick: { show: false },
          axisLabel: { color: cFps, fontSize: 10 },
          splitLine: { lineStyle: { color: '#1e2230' } } },
        // right: Jank / BigJank（上限随数据自适应）
        { type: 'value', name: '卡顿', min: 0,
          nameTextStyle: { color: '#8a90a0', fontSize: 10 },
          axisLine: { show: false }, axisTick: { show: false },
          axisLabel: { color: cJank, fontSize: 10 },
          splitLine: { show: false } },
      ],
      series: [
        // FPS line
        {
          name: 'FPS', type: 'line', yAxisIndex: 0, data: [],
          smooth: true, symbol: 'none',
          lineStyle: { width: 2, color: cFps },
          areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [{ offset: 0, color: hexA(cFps, 0.3) }, { offset: 1, color: hexA(cFps, 0.02) }] } },
        },
        // Jank bar
        {
          name: 'Jank', type: 'bar', yAxisIndex: 1, data: [],
          barMaxWidth: 8,
          itemStyle: { color: cJank, borderRadius: [2, 2, 0, 0] },
        },
        // BigJank bar
        {
          name: 'BigJank', type: 'bar', yAxisIndex: 1, data: [],
          barMaxWidth: 8,
          itemStyle: { color: cBig, borderRadius: [2, 2, 0, 0] },
        },
      ],
    };
  }
}

function hexA(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

window.ChartManager = ChartManager;
