// 报告页大数据渲染基线：合成 data.js（1h / 3h / 10h @1s），量 DOM 完成与图表就位耗时
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright-core');

const REPORTS = 'E:\\WorkBuddy1\\2026-10-19-13-59-27\\perfara\\collector\\resources\\reports';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function synth(n) {
  const t0 = 1793242100000;
  const perf = [];
  for (let i = 0; i < n; i++) {
    const ts = t0 + i * 1000;
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    perf.push({
      timestamp: ts, time: `${hh}:${mm}:${ss}`, pid: 16308,
      cpu: { sysCpu: 20 + (i % 7), procCpu: 18 + (i % 5) },
      cpuCores: { usage: [30, 25, 20, 15, 40, 35, 22, 12], freq: [500, 500, 1000, 1000, 2507, 2200, 2200, 1108] },
      mem: { totalPss: 160 + (i % 20), nativeHeap: 19, javaHeap: 10, dalvikHeap: 10, code: 56, stack: 3, graphics: 40, system: 22, privateOther: 70, swapPss: 1 },
      fps: 58 + (i % 4), jank: i % 3, bigJank: 0, smallJank: i % 2, tinyJank: i % 5,
      jankRate: (i % 3) * 0.01, net: { rx: 1200 + i, tx: 800 + i },
      battery: 4, temperature: 33 + (i % 3), gpuTemp: 35, gpu: 12 + (i % 6),
    });
  }
  return { device: { name: 'SYNTH', bundleId: 'com.demo.synth', appName: 'com.demo.synth', category: 'android' },
    perf, tag: [], metricConfig: {}, shots: [] };
}

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  for (const n of [3600, 10800, 36000]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rep_' + n + '_'));
    for (const f of ['perf.html', 'echarts.min.js']) fs.copyFileSync(path.join(REPORTS, f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, 'data.js'), 'var data = ' + JSON.stringify(synth(n)) + ';', 'utf8');
    const size = fs.statSync(path.join(dir, 'data.js')).size / 1048576;
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const t0 = Date.now();
    await page.goto('file:///' + path.join(dir, 'perf.html').replace(/\\/g, '/'), { waitUntil: 'load', timeout: 120000 });
    const loadMs = Date.now() - t0;
    const t1 = Date.now();
    await page.waitForFunction(() => document.querySelectorAll('canvas').length > 0, null, { timeout: 120000 });
    const chartMs = Date.now() - t1;
    const info = await page.evaluate(() => ({
      canvases: document.querySelectorAll('canvas').length,
      rows: (window.data && window.data.perf) ? window.data.perf.length : -1,
      bodyH: document.body.scrollHeight,
    }));
    console.log(`rows=${n} data.js=${size.toFixed(1)}MB load=${loadMs}ms 图表=${chartMs}ms canvas=${info.canvases} bodyH=${info.bodyH}`);
    await page.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  await browser.close();
})();
