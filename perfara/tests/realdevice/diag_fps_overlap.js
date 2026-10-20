'use strict';
/** 复现 FPS 图右上角元素重叠：渲染 perf.html，截取 FPS 图顶部区域并列出相关 DOM。 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pw = require('playwright-core');

const REPORTS = path.resolve(__dirname, '..', '..', 'collector', 'resources', 'reports');
const OUT = process.argv[2] || path.join(os.tmpdir(), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara-diag-'));
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
  fs.writeFileSync(path.join(ROOT, 'data.js'), 'var data = ' + fs.readFileSync(path.join(__dirname, '_real_android.json'), 'utf8') + ';\n');
  const browser = await pw.chromium.launch({ executablePath: EDGE, args: ['--no-sandbox', '--headless=new'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  await page.goto(`http://127.0.0.1:${port}/perf.html`, { waitUntil: 'load' });
  await page.waitForTimeout(3000);

  const info = await page.evaluate(() => {
    const wrap = document.querySelector('#chart-fps') && document.querySelector('#chart-fps').closest('.chart-wrap');
    if (!wrap) return { err: 'no fps wrap' };
    wrap.scrollIntoView({ block: 'center' });
    const wr = wrap.getBoundingClientRect();
    // 收集 wrap 内所有可见文本元素及其位置
    const items = [];
    wrap.querySelectorAll('*').forEach(el => {
      if (!el.textContent || !el.textContent.trim()) return;
      if (el.children.length && el.tagName !== 'CANVAS') return;
      const r = el.getBoundingClientRect();
      if (r.width === 0) return;
      items.push({
        tag: el.tagName, cls: el.className && el.className.baseVal !== undefined ? 'svg' : (el.className || ''),
        x: Math.round(r.left - wr.left), y: Math.round(r.top - wr.top), w: Math.round(r.width),
        text: el.textContent.trim().slice(0, 40),
      });
    });
    return { wrapW: Math.round(wr.width), items: items.filter(i => i.y < 40) };
  });
  console.log(JSON.stringify(info, null, 1));

  await page.waitForTimeout(500);
  const wrap = await page.$('#chart-fps');
  const box = await wrap.boundingBox();
  await page.screenshot({ path: path.join(OUT, 'fps-top.png'), clip: { x: box.x - 8, y: box.y - 40, width: box.width + 16, height: 130 } });
  await browser.close();
  server.close();
  console.log('saved:', path.join(OUT, 'fps-top.png'));
})();
