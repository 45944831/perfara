'use strict';
/** 用真机采集数据渲染 perf.html 并截图（产线报告模板验证留证）。 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pw = require('playwright-core');

const REPORTS = path.resolve(__dirname, '..', '..', 'collector', 'resources', 'reports');
const OUT = process.argv[2] || path.join(os.tmpdir(), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara-shot-'));
for (const f of ['perf.html', 'echarts.min.js']) fs.copyFileSync(path.join(REPORTS, f), path.join(ROOT, f));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };

(async () => {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'perf.html';
    if (rel === 'favicon.ico') { res.writeHead(204); res.end(); return; }
    const p = path.join(ROOT, rel);
    try {
      const body = fs.readFileSync(p);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch (e) { res.writeHead(404); res.end('nf'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await pw.chromium.launch({ executablePath: EDGE, args: ['--no-sandbox', '--headless=new'] });

  for (const [file, name] of [['_real_android.json', 'android'], ['_real_pc.json', 'pc']]) {
    const src = path.join(__dirname, file);
    if (!fs.existsSync(src)) continue;
    fs.writeFileSync(path.join(ROOT, 'data.js'), 'var data = ' + fs.readFileSync(src, 'utf8') + ';\n');
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    await page.goto(`http://127.0.0.1:${port}/perf.html`, { waitUntil: 'load' });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(OUT, `real-${name}-top.png`) });
    await page.evaluate(() => window.scrollTo(0, 1150));
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, `real-${name}-charts.png`) });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, `real-${name}-stats.png`) });
    await page.close();
    console.log('shot:', name);
  }
  await browser.close();
  server.close();
  console.log('OUT =', OUT);
})();
