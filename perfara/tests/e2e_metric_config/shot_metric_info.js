/** 截图取证：perf.html（含弹窗）+ library.html（含弹窗） */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pw = require('playwright-core');

const REPORTS = path.resolve(__dirname, '..', '..', 'collector', 'resources', 'reports');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara-shot-'));
const FIX = path.resolve(__dirname, 'fixtures_history');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

// 造一份 android 报告数据（图形更饱满，便于观察）
const perf = [];
for (let i = 0; i < 90; i++) {
  const t = 1700000000000 + i * 1000;
  perf.push({
    timestamp: t, time: '12:' + String(Math.floor(i / 60)).padStart(2, '0') + ':' + String(i % 60).padStart(2, '0'),
    fps: Math.max(30, 60 - (i % 17) * 2 + (i > 60 ? -6 : 0)),
    jank: i % 7, bigJank: i % 23 === 0 ? 1 : 0, smallJank: i % 3, tinyJank: i % 2,
    mem: { totalPss: 900 + i * 1.2, javaHeap: 120 + i, nativeHeap: 200 + i % 7, code: 40, stack: 8, graphics: 150 + i % 5, privateOther: 30, system: 60 },
    cpu: { sysCpu: 30 + (i % 20), procCpu: 15 + (i % 13) },
    cpuCores: { usage: [20 + i % 40, 10 + i % 30, 5 + i % 20, 3 + i % 15], freq: [1800000, 1600000, 1400000, 1200000] },
    net: { rxKBps: 20 + (i % 25), txKBps: 5 + (i % 9) },
    gpu: 40 + (i % 30), gpuTemp: 42, temperature: 36 + (i % 6),
    battery: { currentNow: 130 + i % 20, power: 520 + i % 40, level: 80 - Math.floor(i / 30), temperature: 35 },
  });
}
const payload = {
  device: { name: 'Pixel 8 Pro', model: 'Pixel 8 Pro', category: 'android', appName: 'com.demo.game', deviceId: 'ABC123', osVersion: '14' },
  perf, tag: [[10, 30], [55, 75]],
};

async function main() {
  fs.writeFileSync(path.join(OUT, 'perf.html'), fs.readFileSync(path.join(REPORTS, 'perf.html')));
  fs.copyFileSync(path.join(REPORTS, 'echarts.min.js'), path.join(OUT, 'echarts.min.js'));
  fs.copyFileSync(path.join(REPORTS, 'library.html'), path.join(OUT, 'library.html'));
  fs.mkdirSync(path.join(OUT, 'history'), { recursive: true });
  for (const f of fs.readdirSync(FIX)) fs.copyFileSync(path.join(FIX, f), path.join(OUT, 'history', f));
  fs.writeFileSync(path.join(OUT, 'data.js'), 'var data = ' + JSON.stringify(payload) + ';\n');

  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'perf.html';
    try {
      const body = fs.readFileSync(path.join(OUT, rel));
      res.writeHead(200, { 'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream' });
      res.end(body);
    } catch (e) { res.writeHead(404); res.end('nf'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await pw.chromium.launch({ executablePath: EDGE, args: ['--no-sandbox', '--headless=new'] });

  const p = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await p.goto(`http://127.0.0.1:${port}/perf.html`, { waitUntil: 'load' });
  await p.waitForTimeout(3000);
  const shotDir = process.argv[2] || OUT;
  await p.screenshot({ path: path.join(shotDir, 'info-perf-full.png'), fullPage: true });
  await p.evaluate(() => document.querySelector('#card-fps .card-label .info-dot').click());
  await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(shotDir, 'info-perf-modal.png') });
  await p.close();

  const q = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await q.goto(`http://127.0.0.1:${port}/library.html`, { waitUntil: 'load' });
  await q.waitForTimeout(1500);
  await q.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('.card-check'));
    for (const b of boxes.slice(0, 2)) { b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await q.click('#btn-compare');
  await q.waitForTimeout(2500);
  await q.screenshot({ path: path.join(shotDir, 'info-library-full.png'), fullPage: true });
  await q.evaluate(() => document.querySelector('#cmp-body tr td.metric-name .info-dot').click());
  await q.waitForTimeout(400);
  await q.screenshot({ path: path.join(shotDir, 'info-library-modal.png') });
  await q.close();

  await browser.close();
  server.close();
  console.log('截图输出：' + shotDir);
}

main().catch(e => { console.error(e); process.exit(1); });
