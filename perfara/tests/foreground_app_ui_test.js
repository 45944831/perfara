/**
 * 启动时自动选中真机前台应用：无头界面验证（playwright-core + Edge）
 *  A) 真机已运行应用 → 自动选中并显示应用名，可直接点「开始」
 *  B) 停在系统桌面 / 读不到前台 → 完全保持原样式（无选中、无多余选项、无提示）
 *  C) 前台是系统应用（不在第三方列表）→ 补一个可选项并异步补显示名
 *  D) 用户已手动选过 / 采集中 → 绝不覆盖
 *  E) 点「开始」确实把自动选中的包名传给主进程
 *
 * 全程用示例包名，不接触真机、不含任何真实设备标识。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const pw = require('playwright-core');

const ROOT = path.resolve(__dirname, '..', '..', '_client_src', 'app', 'renderer');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const PACKAGES = [
  { pkg: 'com.example.game', label: '示例游戏', versionCode: 1 },
  { pkg: 'com.example.other', label: 'com.example.other', versionCode: 2 },
];

function mockScript(opts) {
  return `
window.__fgOpts = ${JSON.stringify(opts)};
window.__startCalls = [];
window.__fgDone = false;
window.perfAPI = new Proxy({}, { get: (t, k) => {
  if (k === 'then') return undefined;
  if (k === 'getWindowTitle') return async () => ({ title: 'Perfara - 移动端性能工具  v1.0', version: '1.0' });
  if (k === 'getAppUpdate') return async () => null;
  if (k === 'onAppUpdate') return () => {};
  if (k === 'getDevices') return async () => [{ id: 'dev-1', displayName: '示例设备' }];
  if (k === 'getPackages') return async () => window.__fgOpts.packages;
  if (k === 'getAndroidDeviceInfo') return async () => null;
  if (k === 'getConfigOut') return async () => ({});
  if (k === 'onAppLabels') return () => {};
  if (k === 'getForegroundApp') return async () => {
    if (window.__fgOpts.delay) await new Promise(r => setTimeout(r, window.__fgOpts.delay));
    window.__fgDone = true;
    return window.__fgOpts.fg;
  };
  if (k === 'getForegroundAppLabel') return async () => window.__fgOpts.label || '';
  if (k === 'startCollect') return async (...a) => { window.__startCalls.push(a); return { ok: true }; };
  return async () => ({ ok: true });
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
    } catch (_) { res.writeHead(404); res.end('nf'); }
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

  // 等「前台查询真的返回 + 渲染回调链跑完」，而不是赌一个固定毫秒数：
  // 批量回归时浏览器冷启动 + CPU 争用会让固定 700ms 不够，曾偶发整片 FAIL。
  async function waitFgDone(page) {
    await page.waitForFunction(() => window.__fgDone === true, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(120);
  }

  async function open(opts) {
    const ctx = await browser.newContext();
    await ctx.addInitScript(mockScript({ packages: PACKAGES, fg: null, label: '', delay: 0, ...opts }));
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
    await waitFgDone(page);
    return { ctx, page };
  }
  const readSel = (page) => page.$eval('#sel-app', el => ({
    value: el.value,
    options: el.options.length,
    text: el.options[el.selectedIndex] ? el.options[el.selectedIndex].textContent.trim() : '',
    disabled: el.disabled,
  }));
  const readLog = (page) => page.$eval('#log-output', el => el.textContent || '');

  try {
    // A) 真机已运行第三方应用
    {
      const { ctx, page } = await open({ fg: { pkg: 'com.example.game', isDesktop: false, label: '示例游戏' } });
      const s = await readSel(page);
      check('A1 自动选中前台应用', s.value === 'com.example.game', s);
      check('A2 显示应用名而非裸包名', s.text.indexOf('示例游戏') !== -1, s);
      check('A3 下拉框仍可操作', s.disabled === false, s);
      check('A4 日志告知可直接开始', (await readLog(page)).indexOf('已自动选中') !== -1);
      check('A5 没有多补选项', s.options === PACKAGES.length + 1, s);

      await page.click('#btn-start');
      await page.waitForFunction(() => window.__startCalls.length >= 1, { timeout: 10000 }).catch(() => {});
      const calls = await page.evaluate(() => window.__startCalls);
      check('A6 点开始把选中包名传出去', calls.length === 1 && calls[0][1] === 'com.example.game', calls);
      await ctx.close();
    }

    // B) 系统桌面：保持当前样式
    {
      const { ctx, page } = await open({ fg: { pkg: 'com.android.launcher', isDesktop: true, reason: 'desktop-home' } });
      const s = await readSel(page);
      check('B1 桌面时不自动选中', s.value === '', s);
      check('B2 桌面时选项数量不变', s.options === PACKAGES.length + 1, s);
      check('B3 桌面时不打自动选中提示', (await readLog(page)).indexOf('已自动选中') === -1);
      check('B4 桌面时占位文案保留', s.text === '-- 选择应用 --', s);
      await ctx.close();
    }

    // B') 读不到前台
    {
      const { ctx, page } = await open({ fg: null });
      const s = await readSel(page);
      check('B5 无前台结果时保持原样', s.value === '' && s.options === PACKAGES.length + 1, s);
      await ctx.close();
    }

    // C) 前台是系统应用（浏览器 / 设置等不在 pm list -3 里）
    {
      const { ctx, page } = await open({
        fg: { pkg: 'com.example.browser', isDesktop: false },
        label: '示例浏览器',
      });
      await page.waitForFunction(() => {
        const el = document.getElementById('sel-app');
        const o = el && el.options[el.selectedIndex];
        return !!(o && o.textContent.indexOf('示例浏览器') !== -1);
      }, { timeout: 10000 }).catch(() => {});
      const s = await readSel(page);
      check('C1 补全系统应用可选项', s.options === PACKAGES.length + 2, s);
      check('C2 自动选中系统应用', s.value === 'com.example.browser', s);
      check('C3 异步补上桌面显示名', s.text.indexOf('示例浏览器') !== -1, s);
      await ctx.close();
    }

    // D) 用户已手动选过：晚到的检测结果不得覆盖
    //    用长延迟 + 等条件，确保「用户先选、前台结果后到」这个顺序在慢机器上也成立
    {
      const ctx = await browser.newContext();
      await ctx.addInitScript(mockScript({ packages: PACKAGES, fg: { pkg: 'com.example.game', isDesktop: false }, label: '', delay: 2000 }));
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
      // 先等应用列表到位（值必须存在于 options 里才设得上），此时前台结果还没返回
      await page.waitForFunction(
        () => document.getElementById('sel-app').options.length > 1,
        { timeout: 20000 },
      ).catch(() => {});
      const beforeDone = await page.evaluate(() => window.__fgDone === true);
      await page.evaluate(() => { document.getElementById('sel-app').value = 'com.example.other'; });
      await waitFgDone(page);
      const s = await readSel(page);
      check('D0 设值时前台结果尚未返回（顺序确定）', beforeDone === false, beforeDone);
      check('D1 不覆盖用户手动选择', s.value === 'com.example.other', s);
      check('D2 不追加自动选中提示', (await readLog(page)).indexOf('已自动选中') === -1);
      await ctx.close();
    }
  } finally {
    await browser.close();
    await new Promise(r => server.close(r));
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
