'use strict';
/**
 * 渲染端三处改动的 UI 级验证（playwright-core + Edge，无需真机）：
 * 采集页（android）「点开始」之后的界面行为，对应真机暴露的三类「点了没反应」：
 *   A. 采集准备中：日志实时透到提示条（不再是干等一句「准备中」）
 *   B. fps=null 连续 5 秒：告警条亮起（假 0 修复后这里曾经被 return 吃掉）
 *   C. 熔断停止（device_stall）：主界面直接给出原因，不只写进日志面板
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const pw = require('playwright-core');

const ROOT = path.resolve(__dirname, '..', '..', '..', '_client_src', 'app', 'renderer');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const MOCK = `
window.__cbs = {};
window.perfAPI = new Proxy({}, { get: (t, k) => {
  if (k === 'then') return undefined;
  if (k === 'onPerfData' || k === 'onCollectLog' || k === 'onCollectError' || k === 'onCollectStopped')
    return (cb) => { (window.__cbs[k] = window.__cbs[k] || []).push(cb); };
  if (k === 'activationGetState') return async () => ({ activated: true, expiryLabel: '2099-12-31', hideActivationHints: true });
  if (k === 'getDevices') return async () => [{ id: 'dev-1', model: 'TEST-DEVICE', wifi: false }];
  if (k === 'getAndroidDeviceInfo') return async () => ({ brand: 'TestBrand', name: 'TEST-DEVICE', system: 'Android 13' });
  if (k === 'getPackages') return async () => [{ pkg: 'com.demo.app', label: '演示应用' }];
  if (k === 'startCollect') return async () => ({ ok: true });
  return async () => ({ ok: true });
}});
`;

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  (' + extra + ')' : '')); }
}

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
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const browser = await pw.chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.addInitScript(MOCK);
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  // 选好设备/应用，点开始
  await page.selectOption('#sel-device', 'dev-1').catch(() => {});
  await page.waitForTimeout(400);
  await page.selectOption('#sel-app', 'com.demo.app').catch(() => {});
  await page.click('#btn-start');
  await page.waitForTimeout(600);

  const prepVisible = await page.isVisible('#prep-hint');
  const prepText = (await page.textContent('#prep-hint').catch(() => '')) || '';
  check('A1 点开始后显示准备中提示', prepVisible && /准备中/.test(prepText), prepText.trim());

  // ① 日志透传到提示条
  await page.evaluate(() => {
    window.__cbs.onCollectLog.forEach(cb => cb('[adb] 应用已在前台运行，无需启动 (PID=4242)'));
  });
  await page.waitForTimeout(150);
  const prepText2 = (await page.textContent('#prep-hint').catch(() => '')) || '';
  check('A2 准备中提示跟随日志更新', /PID=4242/.test(prepText2), prepText2.trim());

  // ② fps=null 连续 6 秒 → 告警条亮
  const dataTpl = (fps) => ({
    timestamp: Date.now(), time: '03:00:00', pid: 4242,
    cpu: { sysCpu: 30, procCpu: 12 }, cpuCores: { usage: [], freq: [] },
    mem: { totalPss: 320, nativeHeap: 40, javaHeap: 60 },
    fps, jank: null, bigJank: null, smallJank: null, tinyJank: null, jankRate: null,
    net: { rxKBps: 1, txKBps: 1 }, battery: { level: 80, voltage: 3800, temperature: 30, currentNow: 100, power: 1 },
    temperature: 35, gpuTemp: null, gpu: null,
  });
  for (let i = 0; i < 6; i++) {
    await page.evaluate((d) => window.__cbs.onPerfData.forEach(cb => cb(d)), dataTpl(null));
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(200);
  const warnVisible = await page.isVisible('#fps-warn-bar');
  const warnText = (await page.textContent('#fps-warn-text').catch(() => '')) || '';
  check('B1 null 连续 6 秒后告警条亮起', warnVisible, warnText.trim().slice(0, 30) + '…');
  check('B2 告警文案说明可能原因', /不在前台|屏幕熄灭|渲染层/.test(warnText), warnText.trim().slice(0, 40) + '…');

  // 有真实帧率后告警条收起
  await page.evaluate((d) => window.__cbs.onPerfData.forEach(cb => cb(d)), dataTpl(58));
  await page.waitForTimeout(200);
  check('B3 有帧数据后告警条收起', !(await page.isVisible('#fps-warn-bar')));

  // ③ 熔断停止
  await page.evaluate(() => {
    window.__cbs.onCollectStopped.forEach(cb => cb({ reason: 'device_stall', deviceId: 'dev-1', packageName: 'com.demo.app' }));
  });
  await page.waitForTimeout(300);
  const hintVisible = await page.isVisible('#start-hint');
  const hintText = (await page.textContent('#start-hint').catch(() => '')) || '';
  check('C1 熔断后主界面给出提示', hintVisible && /设备响应异常/.test(hintText), hintText.trim());
  const badge = (await page.textContent('#status-badge').catch(() => '')) || '';
  check('C3 状态徽标为已停止', badge.trim() === '已停止', badge.trim());
  check('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

  await browser.close();
  server.close();
  console.log(`\n合计: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('执行异常:', e); process.exit(1); });
