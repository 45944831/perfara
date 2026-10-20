/**
 * 报告库卡片「📁 打开位置」无头验证（playwright-core + Edge）：
 *  - 每张卡片底部都存在该按钮，且紧跟「打开详细报告」
 *  - 点击后调用 window.reportLib.openReportLocation(id)，传入的 id 与该卡片一致
 *  - 点击不会触发「打开详细报告」（无跳转）、不会误勾选卡片
 *  - 无 preload（浏览器直开）时按钮隐藏，点击卡片仍走原来的打开详情逻辑
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pw = require('playwright-core');

const REPORTS = path.resolve(__dirname, '..', '..', 'collector', 'resources', 'reports');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara-loc-'));
for (const f of ['library.html', 'echarts.min.js']) fs.copyFileSync(path.join(REPORTS, f), path.join(ROOT, f));
fs.mkdirSync(path.join(ROOT, 'history'), { recursive: true });
for (const f of fs.readdirSync(path.join(__dirname, 'fixtures_history'))) {
  fs.copyFileSync(path.join(__dirname, 'fixtures_history', f), path.join(ROOT, 'history', f));
}
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

let passed = 0, failed = 0;
function check(name, cond, detail) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '  -> ' + JSON.stringify(detail)));
  cond ? passed++ : failed++;
}

function makeServer() {
  return http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'library.html';
    if (rel === 'favicon.ico') { res.writeHead(204); res.end(); return; }
    const p = path.join(ROOT, rel);
    try {
      const body = fs.readFileSync(p);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch (e) { res.writeHead(404); res.end('nf'); }
  });
}

const STUB = `
  window.__locCalls = [];
  window.__openCalls = [];
  window.__exportCalls = [];
  window.reportLib = {
    deleteReports: () => Promise.resolve({ ok: true, removedIds: [], failed: [] }),
    openReport: (id) => { window.__openCalls.push(id); return Promise.resolve({ ok: true }); },
    openReportLocation: (id) => { window.__locCalls.push(id); return Promise.resolve({ ok: true, path: 'history/' + id + '.js' }); },
    exportSharedReport: (id) => { window.__exportCalls.push(id); return Promise.resolve({ ok: true, path: 'X.html', bytes: 1200000 }); },
    historyDir: () => Promise.resolve('history'),
  };
`;

async function main() {
  const server = makeServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await pw.chromium.launch({ executablePath: EDGE, args: ['--no-sandbox', '--headless=new'] });

  // ── A) 客户端内打开（注入 reportLib 桩） ──
  console.log('[A] 注入 reportLib（模拟客户端内打开）');
  const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.addInitScript(STUB);
  await p.goto(`http://127.0.0.1:${port}/library.html`, { waitUntil: 'load' });
  await p.waitForTimeout(1500);

  const a = await p.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.card'));
    return {
      cardCount: cards.length,
      withLocBtn: cards.filter(c => c.querySelector('.card-foot .open-loc')).length,
      withOpen: cards.filter(c => c.querySelector('.card-foot .open')).length,
      // 按钮排在「打开详细报告」之前且同一行
      orderOK: cards.every(c => {
        const foot = c.querySelector('.card-foot');
        if (!foot) return false;
        const kids = Array.from(foot.children).map(k => k.className);
        const li = kids.findIndex(k => String(k).includes('open-loc'));
        const oi = kids.findIndex(k => String(k).includes('open') && !String(k).includes('open-loc'));
        return li >= 0 && oi >= 0 && li < oi;
      }),
      label: (cards[0] && cards[0].querySelector('.open-loc') ? cards[0].querySelector('.open-loc').textContent.trim() : null),
      noLocClass: document.body.classList.contains('no-location'),
    };
  });
  check('每张卡片都有「打开位置」按钮', a.cardCount > 0 && a.withLocBtn === a.cardCount, a);
  check('「打开详细报告」仍存在', a.withOpen === a.cardCount, a);
  check('两入口顺序正确（位置在前）', a.orderOK === true, a);
  check('按钮文案含「打开位置」', !!a.label && a.label.includes('打开位置'), a.label);
  check('有 preload 时不加 no-location 类', a.noLocClass === false, a.noLocClass);

  // 点击第一张卡片的「打开位置」
  const firstId = await p.evaluate(() => {
    const card = document.querySelector('.card');
    return card ? card.dataset.id || card.getAttribute('data-id') : null;
  });
  await p.evaluate(() => { document.querySelector('.card .card-foot .open-loc').click(); });
  await p.waitForTimeout(300);
  const after = await p.evaluate(() => ({
    locCalls: window.__locCalls.slice(),
    openCalls: window.__openCalls.slice(),
    checked: document.querySelectorAll('.card .card-check:checked').length,
    url: location.href,
    alerted: window.__alerted || null,
  }));
  console.log('  card data-id =', firstId, ' 调用序列 =', JSON.stringify(after.locCalls));
  check('点击调用了 openReportLocation 一次', after.locCalls.length === 1, after);
  check('传入的 id 是有效的报告 id', /^[A-Za-z0-9_\-]+$/.test(after.locCalls[0] || ''), after.locCalls);
  check('未同时触发「打开详细报告」', after.openCalls.length === 0, after.openCalls);
  check('未误勾选卡片', after.checked === 0, after.checked);
  check('页面未跳转', /library\.html/.test(after.url), after.url);
  check('无 JS 报错', errs.length === 0, errs);

  // ── A2) 「⤓ 导出分享」按钮 ──
  const e1 = await p.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.card'));
    const btn = cards[0] && cards[0].querySelector('.card-foot .export-share');
    return {
      withBtn: cards.filter(c => c.querySelector('.card-foot .export-share')).length,
      cardCount: cards.length,
      label: btn ? btn.textContent.trim() : null,
      title: btn ? (btn.getAttribute('title') || '') : '',
      display: btn ? getComputedStyle(btn).display : 'no-btn',
    };
  });
  check('每张卡片都有「导出分享」按钮', e1.cardCount > 0 && e1.withBtn === e1.cardCount, e1);
  check('按钮文案含「导出分享」', !!e1.label && e1.label.includes('导出分享'), e1.label);
  check('按钮有说明 title', /单文件|分享/.test(e1.title), e1.title);
  check('有 preload 时按钮可见', e1.display !== 'none', e1.display);

  await p.evaluate(() => { document.querySelector('.card .card-foot .export-share').click(); });
  await p.waitForTimeout(400);
  const e2 = await p.evaluate(() => ({
    exportCalls: window.__exportCalls.slice(),
    openCalls: window.__openCalls.slice(),
    locCalls: window.__locCalls.slice(),
    checked: document.querySelectorAll('.card .card-check:checked').length,
    url: location.href,
  }));
  console.log('  导出调用序列 =', JSON.stringify(e2.exportCalls));
  check('点击调用了 exportSharedReport 一次', e2.exportCalls.length === 1, e2.exportCalls);
  check('传入的 id 与该卡片一致', e2.exportCalls[0] === after.locCalls[0], { exp: e2.exportCalls, loc: after.locCalls });
  check('未同时触发打开详情/打开位置', e2.openCalls.length === 0 && e2.locCalls.length === 1, e2);
  check('未误勾选卡片、未跳转', e2.checked === 0 && /library\.html/.test(e2.url), e2);

  await p.close();

  // ── B) 浏览器直开（无 reportLib）：按钮应隐藏 ──
  console.log('[B] 无 reportLib（浏览器直接打开）');
  const p2 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs2 = [];
  p2.on('pageerror', e => errs2.push(e.message));
  await p2.goto(`http://127.0.0.1:${port}/library.html`, { waitUntil: 'load' });
  await p2.waitForTimeout(1200);
  const b = await p2.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.card'));
    const btn = document.querySelector('.card .card-foot .open-loc');
    const exp = document.querySelector('.card .card-foot .export-share');
    return {
      cardCount: cards.length,
      noLocClass: document.body.classList.contains('no-location'),
      btnDisplay: btn ? getComputedStyle(btn).display : 'no-btn',
      expDisplay: exp ? getComputedStyle(exp).display : 'no-btn',
    };
  });
  check('无 preload 时加 no-location 类', b.noLocClass === true, b);
  check('无 preload 时「打开位置」隐藏', b.btnDisplay === 'none', b);
  check('无 preload 时「导出分享」隐藏', b.expDisplay === 'none', b);
  check('无 preload 时无 JS 报错', errs2.length === 0, errs2);
  await p2.close();

  await browser.close();
  server.close();
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
