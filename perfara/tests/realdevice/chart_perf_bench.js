'use strict';
/**
 * 图表渲染性能基准：量化「每次采样刷 11 张图」的成本。
 *
 * 对比两种行为：
 *   A 优化后   —— 每次采样只刷数据（lazyUpdate 合并 + silent），markArea 仅在 tag 变化时重画
 *   B 模拟旧版 —— 每次采样额外再刷一次全量 markArea（旧代码无条件调用 _applyTagMarkAreas）
 *
 * 降采样（长时采集防劣化）单独用单测验证：直接构造超阈值 state，检查抽稀与 tag 下标同步。
 * （不真跑上万点，是因为 headless 无 GPU 环境下全量重绘太慢，会拖到分钟级。）
 */
const path = require('path');
const pw = require('playwright-core');

const PROJ = path.resolve(__dirname, '..', '..', '..');
const RENDERER = path.join(PROJ, '_client_src', 'app', 'renderer');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  (' + extra + ')' : '')); }
}

(async () => {
  const browser = await pw.chromium.launch({ executablePath: EDGE, args: ['--no-sandbox', '--headless=new'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));

  await page.addInitScript(() => {
    // pc.js 依赖 preload 注入的 perfAPI，这里给个静默 mock
    window.perfAPI = new Proxy({}, { get: () => (() => Promise.resolve({ ok: true })) });
  });
  await page.goto('file:///' + path.join(RENDERER, 'pc.html').replace(/\\/g, '/'), { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  const ready = await page.evaluate(() => !!(typeof chartMgr !== 'undefined' && chartMgr._ready));
  check('图表管理器已就绪', ready);

  /** @param mode 'new' | 'old'  @param n 采样点数 */
  async function bench(mode, n) {
    return page.evaluate(({ mode, n }) => {
      chartMgr.reset();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        chartMgr.update({
          time: String(i), cpu: { sysCpu: 10 + (i % 30), procCpu: 5 + (i % 20) },
          mem: { totalPss: 200 + (i % 100), nativeHeap: 50, javaHeap: 30, code: 20, stack: 5, graphics: 40, privateOther: 15, system: 25 },
          fps: 55 + (i % 10), jank: i % 7, bigJank: i % 3,
          net: { rxKBps: i % 200, txKBps: i % 90 }, gpu: i % 40, temperature: 35 + (i % 8),
          battery: { temperature: 36, currentNow: 300, power: 1200 },
          cpuCores: { usage: [10, 20, 30, 40, 50, 60, 70, 80], freq: [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400] },
        });
        if (mode === 'old') {
          // 复刻旧行为：每次采样对每张图再刷一次 markArea
          for (const [name, cfg] of Object.entries(CHART_CONFIGS)) {
            const st = chartMgr._data[name], c = chartMgr._charts[name];
            if (st && c) { try { chartMgr._applyTagMarkAreas(cfg, st, c); } catch (_) {} }
          }
        }
      }
      // 强制把 lazyUpdate 攒下的重绘刷完，才能量到真实成本
      // （headless 下 rAF 可能被节流，必须加 setTimeout 兜底，否则整个 bench 会挂住）
      return new Promise(res => {
        let done = false;
        const fin = () => {
          if (done) return;
          done = true;
          let maxLen = 0;
          for (const st of Object.values(chartMgr._data)) {
            if (st && Array.isArray(st.times)) maxLen = Math.max(maxLen, st.times.length);
          }
          res({ ms: performance.now() - t0, points: maxLen });
        };
        requestAnimationFrame(() => requestAnimationFrame(fin));
        setTimeout(fin, 2000);
      });
    }, { mode, n });
  }

  const N = 500;
  console.log(`\n── ${N} 个采样点（约 8 分钟采集） ──`);
  const a = await bench('new', N);
  const b = await bench('old', N);
  console.log(`  优化后 ${a.ms.toFixed(0)}ms（${(a.ms / N).toFixed(1)}ms/次采样）`);
  console.log(`  旧行为 ${b.ms.toFixed(0)}ms（${(b.ms / N).toFixed(1)}ms/次采样）`);
  check('优化后单次采样成本显著下降（≥3 倍）', b.ms > a.ms * 3,
    `${(b.ms / Math.max(a.ms, 1)).toFixed(1)}×`);
  check('优化后单次采样 < 25ms（1s 采样下占用 <2.5%）', a.ms / N < 25,
    `${(a.ms / N).toFixed(1)}ms`);
  check(`${N} 点以内不抽稀（保留全量）`, a.points === N, a.points);

  // ── 降采样单测 ────────────────────────────────────────────────────────────
  console.log('\n── 降采样（长时采集防劣化）单测 ──');
  const dec = await page.evaluate(() => {
    const state = {
      times: Array.from({ length: 9000 }, (_, i) => String(i)),
      series: [Array.from({ length: 9000 }, (_, i) => i)],
    };
    chartMgr._tags = [[0, 8999], [100, 200]];
    const changed = chartMgr._decimateIfNeeded(state);
    return {
      changed,
      len: state.times.length,
      first: state.times[0],
      second: state.times[1],
      seriesLen: state.series[0].length,
      tags: chartMgr._tags,
    };
  });
  console.log('  抽稀后：点数', dec.len, 'tag', JSON.stringify(dec.tags));
  check('超阈值（9000）触发抽稀', dec.changed === true && dec.len === 4500, dec.len);
  check('抽稀保留首点、隔点取样', dec.first === '0' && dec.second === '2', `${dec.first},${dec.second}`);
  check('各 series 同步抽稀', dec.seriesLen === 4500, dec.seriesLen);
  check('tag 下标同步减半（[0,8999]→[0,4499]）',
    dec.tags[0][0] === 0 && dec.tags[0][1] === 4499, JSON.stringify(dec.tags[0]));

  // 未超阈值不应抽稀
  const noDec = await page.evaluate(() => {
    const state = { times: Array.from({ length: 3000 }, (_, i) => String(i)), series: [[1]] };
    return { changed: chartMgr._decimateIfNeeded(state), len: state.times.length };
  });
  check('未超阈值（3000）不抽稀', noDec.changed === false && noDec.len === 3000, noDec.len);

  // tag 区间在抽稀后仍能正确画出 markArea
  const area = await page.evaluate(() => {
    const state = { times: Array.from({ length: 4500 }, (_, i) => String(i)), series: [[]] };
    chartMgr._tags = [[0, 4499]];
    return chartMgr._buildTagMarkAreaData(state.times).length;
  });
  check('抽稀后 tag 仍能生成 markArea', area === 1, area);

  check('全程无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));

  await page.screenshot({ path: path.join(__dirname, '_shots', 'chart-perf-bench.png') });
  await browser.close();

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
