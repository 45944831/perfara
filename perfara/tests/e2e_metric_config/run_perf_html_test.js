/**
 * perf.html 无头验证（playwright-core + Edge）：
 *  A) android + metricConfig(fps/cpu 移除) → 图表与卡片按配置隐藏，其余正常
 *  B) android 无 metricConfig（旧报告） → 全部显示，行为不回退
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pw = require('playwright-core');

const REPORTS = path.resolve(__dirname, '..', '..', 'collector', 'resources', 'reports');
// 用临时目录跑：data.js 会被脚本改写，避免污染真实报告目录
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara-perf-'));
for (const f of ['perf.html', 'echarts.min.js']) {
  fs.copyFileSync(path.join(REPORTS, f), path.join(ROOT, f));
}
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

function mkAndroid(mc) {
  const perf = [];
  for (let i = 0; i < 8; i++) {
    perf.push({
      timestamp: 1700000000000 + i * 1000, time: '12:00:0' + i,
      mem: { totalPss: 1000 + i, javaHeap: 10, nativeHeap: 5, code: 1, stack: 1, graphics: 1, privateOther: 1, system: 1 },
      net: { rxKBps: 5, txKBps: 2 }, gpu: 3, temperature: 30,
      battery: { currentNow: 100, power: 2, level: 80, temperature: 29 },
      fps: 60, jank: 1, bigJank: 0, cpu: { sysCpu: 10, procCpu: 5 }, cpuCores: { usage: [1, 2], freq: [100, 200] },
    });
  }
  const p = { device: { name: 'Pixel 7', model: 'Pixel', category: 'android', deviceId: 'ABC', appName: 'Demo' }, perf, tag: null };
  if (mc) p.metricConfig = mc;
  return p;
}

async function runCase(browser, port, dataJs, label) {
  fs.writeFileSync(path.join(ROOT, 'data.js'), 'var data = ' + JSON.stringify(dataJs, null, 2) + ';\n');
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/perf.html`, { waitUntil: 'load' });
  await page.waitForTimeout(2200);
  const r = await page.evaluate(() => {
    const q = s => document.querySelector(s);
    const vis = el => !!(el && !el.hidden && el.style.display !== 'none');
    return {
      wrapFps: vis(q('#chart-fps') && q('#chart-fps').closest('.chart-wrap')),
      wrapCpu: vis(q('#chart-cpu') && q('#chart-cpu').closest('.chart-wrap')),
      wrapMem: vis(q('#chart-mem') && q('#chart-mem').closest('.chart-wrap')),
      wrapNet: vis(q('#chart-net') && q('#chart-net').closest('.chart-wrap')),
      cardFps: vis(q('#card-fps')), cardCpu: vis(q('#card-cpu')),
      cardMem: vis(q('#card-mem')), cardNet: vis(q('#card-net')),
      valMem: (q('#val-mem') || {}).textContent,
    };
  });
  await page.close();
  return { r, errors };
}

async function main() {
  const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'perf.html');
    try {
      const body = fs.readFileSync(p);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      res.end(body);
    } catch (e) { res.writeHead(404); res.end('nf'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await pw.chromium.launch({ executablePath: EDGE, args: ['--no-sandbox', '--headless=new'] });

  let pass = 0, fail = 0;
  const check = (name, ok, extra) => {
    if (ok) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name, extra || ''); }
  };

  console.log('[A] android + metricConfig(fps/cpu 移除)');
  const a = await runCase(browser, port, mkAndroid({ fps: false, cpu: false, mem: true, net: true, gpu: true, temp: true, battery: true }), 'A');
  check('fps 图隐藏', a.r.wrapFps === false, JSON.stringify(a.r));
  check('cpu 图隐藏', a.r.wrapCpu === false);
  check('mem 图可见', a.r.wrapMem === true);
  check('net 图可见', a.r.wrapNet === true);
  check('fps 卡隐藏', a.r.cardFps === false);
  check('cpu 卡隐藏', a.r.cardCpu === false);
  check('mem 卡可见', a.r.cardMem === true);
  check('mem 卡有数值', a.r.valMem && a.r.valMem !== '--');
  check('无 JS 报错', a.errors.length === 0, a.errors.join(';'));

  console.log('[B] android 无 metricConfig（旧报告回归）');
  const b = await runCase(browser, port, mkAndroid(null), 'B');
  check('fps 图可见', b.r.wrapFps === true, JSON.stringify(b.r));
  check('cpu 图可见', b.r.wrapCpu === true);
  check('mem 图可见', b.r.wrapMem === true);
  check('fps 卡可见', b.r.cardFps === true);
  check('cpu 卡可见', b.r.cardCpu === true);
  check('mem 卡有数值', b.r.valMem && b.r.valMem !== '--');
  check('无 JS 报错', b.errors.length === 0, b.errors.join(';'));

  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
