/**
 * 采集顶栏布局守卫：窄窗口下「设备」和「应用」两个控制组必须保持同一行。
 *
 * 背景（2026-11-17）：用户截图显示采集时设备/应用分成两行。根因是 1024~1200px
 * 窗口下 .topbar-controls 被 left/right 挤成 ~420px，放不下设备组+应用组，
 * flex-wrap 把应用组挤到下一行。修复是在 @media(max-width:1200px) 让 controls
 * 独占整行（flex-basis:100%）并重排 order。本用例锁这个行为。
 *
 * 用 playwright-core + Edge 加载真实 index.html + 假 perfAPI，量各 control-group
 * 的 y 坐标；不依赖真机。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const pw = require('playwright-core');

const ROOT = path.resolve(__dirname, '..', '..', '..', '_client_src', 'app', 'renderer');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const MOCK = `
window.perfAPI = new Proxy({}, { get: (t, k) => {
  if (k === 'then') return undefined;
  if (/^on(PerfData|CollectLog|CollectError|CollectStopped)$/.test(k)) return () => {};
  if (k === 'activationGetState') return async () => ({ activated: true, expiryLabel: '2099-12-31', hideActivationHints: true });
  if (k === 'getDevices') return async () => [{ id: 'dev-1', model: 'TEST-DEVICE', wifi: false }];
  if (k === 'getAndroidDeviceInfo') return async () => ({ brand: 'TestBrand', name: 'TEST-DEVICE', system: 'Android 13' });
  if (k === 'getPackages') return async () => [{ pkg: 'com.demo.app', label: '演示应用' }];
  return async () => ({ ok: true });
}});
`;

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
};

(async () => {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const base = rel.startsWith('node_modules/') ? path.resolve(ROOT, '..') : ROOT;
    const p = path.join(base, rel);
    try {
      const body = fs.readFileSync(p);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      res.end(body);
    } catch (e) { res.writeHead(404); res.end('nf'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await pw.chromium.launch({ executablePath: EDGE, args: ['--no-sandbox', '--headless=new'] });

  for (const W of [1280, 1150, 1100, 1024]) {
    const page = await browser.newPage({ viewport: { width: W, height: 800 } });
    await page.addInitScript(MOCK);
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: 'load' });
    await page.waitForTimeout(450);
    const m = await page.evaluate(() => {
      const groups = [...document.querySelectorAll('.topbar-controls > .control-group')]
        .filter(g => getComputedStyle(g).display !== 'none');
      const find = (label) => groups.find(g => (g.querySelector('label')?.textContent || '').trim() === label);
      const Y = (el) => el ? Math.round(el.getBoundingClientRect().y) : null;
      const dev = find('设备'), app = find('应用');
      return { devY: Y(dev), appY: Y(app), same: dev && app && Math.abs(Y(dev) - Y(app)) < 2 };
    });
    check(`@${W}px 设备/应用同一行`, m.same, m);
    await page.close();
  }

  await browser.close();
  server.close();
  console.log(`\n==== topbar_layout_test: ${pass} PASS / ${fail} FAIL ====\n`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
