/**
 * 采集页设置弹窗无头验证（playwright-core + Edge）：
 *  每个页面（android / ios / pc）：
 *   1. ⚙ 采集参数按钮存在
 *   2. 打开弹窗 → 复选框数量 = 该平台组数
 *   3. 取消勾选首组 → 保存 → 对应 data-metric 元素 hidden，其余可见
 *   4. localStorage 写入；刷新后配置仍生效
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const pw = require('playwright-core');

const ROOT = path.resolve(__dirname, '..', '..', '..', '_client_src', 'app', 'renderer');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

// mock preload：采集页 renderer 启动时会调用 window.perfAPI。
// activationGetState 返回「已激活」——否则 activation-ui 的 document 捕获级点击拦截
// （未激活且无试用时长时阻止一切点击）会拦住设置按钮的真实鼠标点击。
const MOCK = `
window.perfAPI = new Proxy({}, { get: (t, k) => {
  if (k === 'then') return undefined;
  if (k === 'activationGetState') return async () => ({ activated: true, expiryLabel: '2099-12-31', hideActivationHints: true });
  return async () => ({ ok: false, reason: 'mock' });
}});
`;

const CASES = [
  { page: 'index.html', platform: 'android', groups: ['fps', 'cpu', 'mem', 'net', 'gpu', 'temp', 'battery'] },
  { page: 'iphone.html', platform: 'ios', groups: ['fps', 'cpu', 'mem', 'disk', 'events', 'proc'] },
  { page: 'pc.html', platform: 'pc', groups: ['fps', 'cpu', 'mem', 'net', 'gpu', 'temp', 'battery', 'disk'] },
  { page: 'iphone_gpu.html', platform: 'ios_gpu', groups: ['gpu'] },
];

async function main() {
  const server = http.createServer((req, res) => {
    // 采集页的 "../node_modules/echarts" 在浏览器侧会被规范化为 "/node_modules/...",
    // 这里把它映射回 app 根目录，保证 echarts 可加载
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
  const port = server.address().port;
  const browser = await pw.chromium.launch({ executablePath: EDGE, args: ['--no-sandbox', '--headless=new'] });

  let pass = 0, fail = 0;
  const check = (name, ok, extra) => {
    if (ok) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name, extra || ''); }
  };

  for (const c of CASES) {
    console.log(`[${c.page}] platform=${c.platform}`);
    const context = await browser.newContext();
    await context.addInitScript(MOCK);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/${c.page}`, { waitUntil: 'load' });
    await page.waitForTimeout(1200);

    // 1) 按钮
    check('设置按钮存在', await page.$('#btn-metric-settings') !== null);

    // 2) 弹窗 + 复选框数
    await page.click('#btn-metric-settings');
    await page.waitForTimeout(300);
    const dlgInfo = await page.evaluate(() => {
      const root = document.getElementById('metric-settings-root');
      const cbs = root ? root.querySelectorAll('input[type=checkbox]') : [];
      return { open: !!(root && root.querySelector('.ms-box')), count: cbs.length, allChecked: Array.from(cbs).every(b => b.checked) };
    });
    check('弹窗打开', dlgInfo.open === true);
    check(`复选框数=${c.groups.length}`, dlgInfo.count === c.groups.length, 'got ' + dlgInfo.count);
    check('默认全选', dlgInfo.allChecked === true);

    // 3) 取消勾选首组 → 保存
    await page.evaluate(() => {
      const root = document.getElementById('metric-settings-root');
      const cb = root.querySelector('input[type=checkbox]');
      cb.checked = false;
    });
    await page.evaluate(() => {
      const root = document.getElementById('metric-settings-root');
      const btns = Array.from(root.querySelectorAll('button'));
      btns.find(b => b.textContent === '保存').click();
    });
    await page.waitForTimeout(300);

    const after = await page.evaluate((g0) => {
      const vis = el => !!(el && !el.hidden && el.style.display !== 'none');
      const off = Array.from(document.querySelectorAll(`[data-metric="${g0}"]`));
      const on = Array.from(document.querySelectorAll('[data-metric]')).filter(el => el.getAttribute('data-metric') !== g0);
      const keys = Object.keys(localStorage).filter(k => k.startsWith('perfara.metricConfig.'));
      const saved = keys.map(k => ({ k, v: JSON.parse(localStorage.getItem(k) || '{}') }));
      return {
        offAllHidden: off.length > 0 && off.every(el => !vis(el)),
        offCount: off.length,
        onAllVisible: on.every(el => vis(el)),
        saved,
      };
    }, c.groups[0]);
    check(`移除 ${c.groups[0]} 后对应元素全部隐藏(${after.offCount}个)`, after.offAllHidden === true);
    check('其余组元素仍可见', after.onAllVisible === true);
    check('localStorage 已写入', after.saved.some(s => s.v[c.groups[0]] === false), JSON.stringify(after.saved));

    // 4) 刷新后配置仍生效
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(1000);
    const persisted = await page.evaluate((g0) => {
      const vis = el => !!(el && !el.hidden && el.style.display !== 'none');
      const off = Array.from(document.querySelectorAll(`[data-metric="${g0}"]`));
      return off.length > 0 && off.every(el => !vis(el));
    }, c.groups[0]);
    check('刷新后移除组仍隐藏', persisted === true);
    check('无 JS 报错', errors.length === 0, errors.slice(0, 3).join(';'));

    await context.close();
  }

  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
