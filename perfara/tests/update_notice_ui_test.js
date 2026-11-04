/**
 * 顶栏「新版本」提示：无头界面验证（playwright-core + Edge）
 *  A) 4 个采集页都注入了标签，且无更新时默认隐藏（CSS [hidden] 真的生效）
 *  B) 有更新时显示「新版本」文字，点击只调 openAppUpdate，不弹窗、不自动跳转
 *  C) 后台检查晚于页面加载时，事件推送能补显示；推送空值能重新隐藏
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const pw = require('playwright-core');

const ROOT = path.resolve(__dirname, '..', '..', '_client_src', 'app', 'renderer');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const GOOD = 'https://github.com/45944831/perfara/releases/tag/v1.1';

// 每个 context 用一个初始值；其余接口一律返回安全的空对象，避免牵动采集页主逻辑
function mockScript(initial) {
  return `
window.__updateCalls = 0;
window.__updatePush = null;
window.__mockUpdate = ${JSON.stringify(initial)};
window.perfAPI = new Proxy({}, { get: (t, k) => {
  if (k === 'then') return undefined;
  if (k === 'getWindowTitle') return async () => ({ title: 'Perfara - 移动端性能工具  v1.0', version: '1.0', hasUpdate: false });
  if (k === 'getAppUpdate') return async () => window.__mockUpdate;
  if (k === 'onAppUpdate') return (cb) => { window.__updatePush = cb; };
  if (k === 'openAppUpdate') return async () => { window.__updateCalls++; return { ok: true }; };
  return async () => ({ ok: false, reason: 'mock' });
}});
`;
}

async function main() {
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
  const port = server.address().port;
  const browser = await pw.chromium.launch({ executablePath: EDGE, args: ['--no-sandbox', '--headless=new'] });

  let pass = 0;
  let fail = 0;
  const check = (name, ok, extra) => {
    if (ok) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); }
  };
  const readBtn = (page) => page.$eval('#btn-app-update', el => ({
    hidden: el.hidden,
    visible: el.offsetParent !== null,
    text: (el.textContent || '').trim(),
    title: el.title || '',
  }));

  async function open(pageName, initial) {
    const ctx = await browser.newContext();
    await ctx.addInitScript(mockScript(initial));
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/${pageName}`, { waitUntil: 'load' });
    await page.waitForTimeout(350);
    return { ctx, page };
  }

  // A) 无更新：4 个页面都有标签，但都不可见
  for (const f of ['index.html', 'pc.html', 'iphone.html', 'iphone_gpu.html']) {
    const { ctx, page } = await open(f, null);
    const exists = await page.$('#btn-app-update') !== null;
    check(`${f} 注入标签`, exists);
    if (exists) {
      const s = await readBtn(page);
      check(`${f} 无更新时隐藏`, s.hidden === true && s.visible === false, s);
    }
    await ctx.close();
  }

  // B) 有更新：显示 + 点击
  {
    const { ctx, page } = await open('index.html', { tag: 'v1.1', url: GOOD, currentVersion: '1.0' });
    const s = await readBtn(page);
    check('有更新时可见', s.hidden === false && s.visible === true, s);
    check('文字是「新版本」', s.text === '新版本', s);
    check('title 带目标版本号', s.title.indexOf('v1.1') !== -1, s);
    check('title 带当前版本号', s.title.indexOf('当前 v1.0') !== -1, s);
    check('页面标题同步主进程版本号', (await page.title()).indexOf('v1.0') !== -1);
    await page.click('#btn-app-update');
    await page.waitForTimeout(80);
    check('点击触发跳转', await page.evaluate(() => window.__updateCalls) === 1);
    check('页面未被导航走', page.url().indexOf('index.html') !== -1, page.url());
    await ctx.close();
  }

  // C) 事件推送补显示 / 再隐藏
  {
    const { ctx, page } = await open('index.html', null);
    check('推送回调已注册', await page.evaluate(() => typeof window.__updatePush === 'function'));
    await page.evaluate((url) => window.__updatePush({ tag: 'v1.2', url }), GOOD);
    await page.waitForTimeout(60);
    let s = await readBtn(page);
    check('推送后显示', s.hidden === false && s.visible === true, s);
    check('推送后 title 更新', s.title.indexOf('v1.2') !== -1, s);
    await page.evaluate(() => window.__updatePush(null));
    await page.waitForTimeout(60);
    s = await readBtn(page);
    check('推送空值后重新隐藏', s.hidden === true && s.visible === false && s.title === '', s);
    check('隐藏时点击不跳转', await page.evaluate(() => window.__updateCalls) === 0);
    await ctx.close();
  }

  await browser.close();
  server.close();
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('测试自身异常:', e);
  process.exit(1);
});
