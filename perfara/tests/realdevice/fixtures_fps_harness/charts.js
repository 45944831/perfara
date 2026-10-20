'use strict';

const COLORS = {
  cpu:       ['#4f8ef7', '#79d4f7'],
  mem:       ['#3ecf8e'],
  memDetail: ['#3ecf8e', '#4f8ef7', '#f5d020', '#c77dff', '#f5a623', '#ff79a8', '#79d4f7'],
  fps:       ['#f5d020', '#f5a623', '#f85151'],  // fps, jank, bigJank
  net:       ['#c77dff', '#ff79a8'],
  gpu:       ['#f5a623'],
  temp:      ['#f85151'],
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
    series: [{ name: '温度', key: d => d.temperature || d.battery.temperature }],
    type: 'line',
    fmt: v => v + '°C',
  },
  current: {
    el: 'chart-current',
    series: [{ name: '电流', key: d => d.battery.currentNow ?? 0 }],
    type: 'line',
    fmt: v => v + ' mA',
  },
  power: {
    el: 'chart-power',
    series: [{ name: '功耗', key: d => d.battery.power ?? 0 }],
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
  }

  init() {
    requestAnimationFrame(() => setTimeout(() => this._doInit(), 120));
  }

  _doInit() {
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

    const ro = new ResizeObserver(() => {
      for (const c of Object.values(this._charts)) c.resize();
    });
    const grid = document.querySelector('.charts-grid');
    if (grid) ro.observe(grid);
    window.addEventListener('resize', () => {
      for (const c of Object.values(this._charts)) c.resize();
    });
  }

  update(d) {
    if (!this._ready) return;
    for (const [name, cfg] of Object.entries(CHART_CONFIGS)) {
      try {
        this._updateOne(name, cfg, d);
      } catch (_) {
        // isolate per-chart errors
      }
    }
  }

  setTags(tags) {
    this._tags = Array.isArray(tags) ? tags : [];
    if (!this._ready) return;
    // Re-apply tag backgrounds without adding new points
    for (const [name, cfg] of Object.entries(CHART_CONFIGS)) {
      const state = this._data[name];
      const chart = this._charts[name];
      if (!state || !chart) continue;
      try { this._applyTagMarkAreas(cfg, state, chart); } catch (_) {}
    }
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
    chart.setOption({ series: patch });
  }

  _updateOne(name, cfg, d) {
    const state = this._data[name];
    const chart = this._charts[name];
    if (!state || !chart) return;

    if (cfg.dynamic) {
      let vals = [];
      try {
        vals = cfg.keyFn(d) || [];
      } catch (_) {
        vals = [];
      }
      const count = vals.length;
      if (count === 0) return;

      // Re-init series when core count is first known or changes
      if (state.series.length !== count) {
        cfg.series   = Array.from({ length: count }, (_, i) => ({ name: `Core ${i}` }));
        state.times  = [];
        state.series = Array.from({ length: count }, () => []);
        // Use merge (no notMerge flag) to safely build full option
        chart.setOption(this._buildLineOption(name, cfg));
      }

      const t = d && d.time != null ? d.time : '';
      state.times.push(t);
      vals.forEach((v, i) => {
        state.series[i].push((v === undefined || v === null || isNaN(+v)) ? 0 : +v);
      });
      chart.setOption({
        xAxis:  [{ data: state.times }],
        yAxis:  [{ min: 0 }],
        series: state.series.map(s => ({ data: s })),
      });
      this._applyTagMarkAreas(cfg, state, chart);
      return;
    }

    // Normal static-series charts
    const t = d && d.time != null ? d.time : '';
    state.times.push(t);
    cfg.series.forEach((s, i) => {
      let v;
      try {
        v = s.key(d);
      } catch (_) {
        v = null;
      }
      state.series[i].push((v === undefined || v === null || isNaN(+v)) ? 0 : +v);
    });
    const yAxisPatch = cfg.mixed
      ? [{ min: 0 }, { min: 0 }]
      : [{ min: 0 }];
    chart.setOption({
      xAxis:  [{ data: state.times }],
      yAxis:  yAxisPatch,
      series: cfg.series.map((_, i) => ({ data: state.series[i] })),
    });
    this._applyTagMarkAreas(cfg, state, chart);
  }

  reset() {
    this._tags = [];
    for (const [name, cfg] of Object.entries(CHART_CONFIGS)) {
      const state = this._data[name];
      const chart = this._charts[name];
      if (!state) continue;

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
  }

  /**
   * 当前曲线的最后一个 x 轴索引（基于 times.length - 1）。
   * 若还没有任何数据点，返回 -1。
   */
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
        { type: 'inside', xAxisIndex: 0, moveOnMouseWheel: true, zoomOnMouseWheel: 'shift' },
      ],
      tooltip: {
        trigger: 'axis',
        formatter: p => p.map(x => `${x.marker}${x.seriesName}: ${cfg.fmt(x.value)}`).join('<br>'),
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
        { type: 'inside', xAxisIndex: 0, moveOnMouseWheel: true, zoomOnMouseWheel: 'shift' },
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
            return `${p.marker}${p.seriesName}: <b>${p.value}</b>${suf}`;
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
