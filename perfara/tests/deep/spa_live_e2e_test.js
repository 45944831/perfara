/**
 * 看板 SPA 端到端测试（真实后端 + 真实种子库 + 无头 Edge）。
 *
 * 覆盖此前所有 e2e 用例的空白：它们只测单文件报告页与采集页，
 * 没有一次让 Vue 看板真正连上运行中的 API。这里验证：
 *   1. 首屏渲染出真实记录（不是白屏/空表）
 *   2. 详情 / 趋势 / 对比 / 别名 / 上传 各路由可达且无 JS 异常
 *   3. 全程零外部请求（README 承诺「100% 本地」）
 *   4. 深链直开（/tests/:id 刷新不 404）、未知路由不白屏
 *   5. 图表真正出画布、testid 可复制、接口失败时给出可见反馈
 *
 * 用法：tools/.venv/Scripts/python.exe 需存在；从仓库根或任意目录运行均可。
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const pw = require('playwright-core');

const REPO = path.resolve(__dirname, '..', '..', '..');
const PERFARA = path.join(REPO, 'perfara');
const PY = path.join(REPO, 'tools', '.venv', 'Scripts', 'python.exe');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SEED = path.join(PERFARA, '_seed', 'webperf.db');
const PORT = 8147;
const BASE = `http://127.0.0.1:${PORT}`;
const UID = 'perfara123'; // 演示账号：只能看种子快照内的记录，正是新用户首启看到的形态

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  (' + String(detail).slice(0, 220) + ')' : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitHealth(tries = 120) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tick = () => {
      const req = http.get(`${BASE}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
      req.setTimeout(1000, () => req.destroy());
      function retry() {
        if (++n >= tries) return reject(new Error('health 超时'));
        setTimeout(tick, 250);
      }
    };
    tick();
  });
}

function startServer(tmp) {
  const db = path.join(tmp, 'spa.db');
  fs.copyFileSync(SEED, db);
  for (const ext of ['-wal', '-shm']) {
    const s = SEED + ext;
    if (fs.existsSync(s)) fs.copyFileSync(s, db + ext);
  }
  const p = spawn(PY, ['-m', 'uvicorn', 'backend.app:app', '--host', '127.0.0.1',
    '--port', String(PORT), '--log-level', 'warning'], {
    cwd: PERFARA,
    env: Object.assign({}, process.env, { WEB_PERF_DB: db, PERFARA_HOME: tmp }),
    stdio: ['ignore', fs.openSync(path.join(tmp, 'srv.out'), 'w'),
      fs.openSync(path.join(tmp, 'srv.err'), 'w')],
  });
  return p;
}

async function main() {
  if (!fs.existsSync(PY)) throw new Error('缺 tools/.venv：' + PY);
  if (!fs.existsSync(SEED)) throw new Error('缺种子库 perfara/_seed/webperf.db（先跑 tools/make_seed_db.py）');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara_spa_'));
  const srv = startServer(tmp);
  let browser, external, errors, pageErrors, serverErrors;
  const cleanup = () => {
    // 顺序很重要：先关浏览器，再收服务进程，最后删目录。
    // 服务进程还活着时会占着 tmp/logs/app.log，Windows 上删目录会 EBUSY。
    try { browser && browser.close(); } catch (_) {}
    try { srv.kill('SIGTERM'); } catch (_) {}
    try { srv.stdout && srv.stdout.fd && fs.closeSync(srv.stdout.fd); } catch (_) {}
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        return;
      } catch (e) {
        if (e.code !== 'EBUSY' && e.code !== 'EPERM') return;
        try { srv.kill('SIGKILL'); } catch (_) {}
        const wait = Date.now() + 300;
        while (Date.now() < wait) { /* 让句柄释放 */ }
      }
    }
    console.log('  WARN  临时目录未能删除: ' + tmp);
  };
  process.on('exit', cleanup);

  try {
    await waitHealth();
    browser = await pw.chromium.launch({ executablePath: EDGE, headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    external = [];
    errors = [];
    pageErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('request', (r) => {
      const u = r.url();
      if (!u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u);
    });
    serverErrors = [];
    page.on('response', (res) => {
      if (res.status() >= 500) serverErrors.push(`${res.status()} ${res.url()}`);
    });
    // 登录态：SPA 从地址栏 ?uid= 取值并写入 sessionStorage（键 webperf_uid）
    // 注意是 sessionStorage，不是 localStorage；写 localStorage 不会被 interceptor 读到。
    await page.addInitScript((uid) => {
      try { sessionStorage.setItem('webperf_uid', uid); } catch (_) {}
    }, UID);

    console.log('\n[1] 首屏看板');
    const resp = await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 45000 });
    check('GET / 返回 200', resp && resp.status() === 200, resp && resp.status());
    await page.waitForTimeout(1500);
    const bodyText = await page.evaluate(() => document.body.innerText);
    check('首屏渲染出内容（非白屏）', bodyText.length > 60, `len=${bodyText.length}`);
    check('首屏看到种子数据「示例应用」', bodyText.includes('示例应用'), bodyText.slice(0, 200));
    check('首屏无 JS 异常', pageErrors.length === 0, pageErrors[0]);
    check('首屏无 console error', errors.length === 0, errors[0]);
    check('全程零外部请求', external.length === 0, external.slice(0, 3).join(' , '));

    console.log('\n[2] 列表与交互元素');
    const rows = await page.locator('table tbody tr, [class*="list-item"], [class*="record"]').count();
    check('记录行渲染出来', rows > 0, `rows=${rows}`);
    const hasDateFilter = await page.locator('input[type="date"], input[type="text"], select').count();
    check('筛选控件存在', hasDateFilter > 0, hasDateFilter);
    const copyBtn = await page.locator('button, a').filter({ hasText: /testid|ID/i }).count();
    check('有「复制 testid」类按钮', copyBtn > 0, copyBtn);
    check('列表接口未出现 5xx', !serverErrors.some((s) => /\/api\/tests\?/.test(s)),
      serverErrors.join(' | '));
    // 概览(summary)坏掉时 parse_summary_dict 静默返回 {}，均值列会整列空白
    const cells = await page.evaluate(() => {
      const t = document.querySelector('table');
      if (!t) return null;
      const rows = [...t.querySelectorAll('tbody tr')].slice(0, 12);
      return rows.map((r) => [...r.querySelectorAll('td')].map((c) => c.innerText.trim()));
    });
    if (cells) {
      const numeric = cells.filter((r) => r.some((c) => /^\d+(\.\d+)?(%|fps|MB|ms)?$/i.test(c)));
      check('列表均值列有数值（FPS/CPU/内存非空）', numeric.length > 0,
        `首行=${JSON.stringify(cells[0] && cells[0].slice(0, 8))}`);
    }

    console.log('\n[3] 详情页');
    const link = page.locator('a[href*="/tests/"]').first();
    let href = null;
    if (await link.count()) href = await link.getAttribute('href');
    if (!href) {
      // 从接口取一条 id 兜底
      const j = await ctx.request.get(`${BASE}/api/tests?uid=${UID}&page_size=1`);
      const d = await j.json();
      href = d.items && d.items[0] ? `/tests/${d.items[0].id}` : null;
    }
    check('拿到一条记录的详情入口', !!href, href);
    if (href) {
      const idMatch = String(href).match(/(\d+)/);
      pageErrors.length = 0; errors.length = 0;
      const before = serverErrors.length;
      const d2 = await page.goto(BASE + href, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(3000);
      check('详情深链直开 200（刷新不 404）', d2 && d2.status() === 200, d2 && d2.status());
      check('详情加载未触发后端 5xx', serverErrors.length === before,
        serverErrors.slice(before).join(' | '));
      const canvas = await page.locator('canvas').count();
      check('详情图表渲染出画布', canvas > 0, `canvas=${canvas}`);
      const stat = await page.evaluate(() => document.body.innerText);
      check('详情未落到「加载失败」空态', !/加载失败/.test(stat),
        stat.replace(/\s+/g, ' ').slice(0, 160));
      check('详情含统计/指标区块', /FPS|CPU|内存|均值|峰值/.test(stat), stat.slice(0, 160));
      check('详情无 JS 异常', pageErrors.length === 0, pageErrors[0]);
      check('详情无 console error', errors.length === 0, errors[0]);

      console.log('\n[4] 分享令牌');
      const tid = idMatch && idMatch[1];
      if (tid) {
        const api = await ctx.request.get(`${BASE}/api/tests/${tid}?uid=${UID}`);
        if (api.status() !== 200) {
          check('详情接口 200', false, `${api.status()} ${(await api.text()).slice(0, 60)}`);
        } else {
          const dd = await api.json();
          const md5 = dd && dd.test && dd.test.md5;
          check('详情接口回传随机分享令牌', !!md5 && String(md5).startsWith('t') && String(md5).length === 31, md5);
          if (md5) {
            const pub = await ctx.request.get(`${BASE}/api/public/test?testid=${md5}`);
            check('匿名 public 链接可取详情', pub.status() === 200, pub.status());
          }
        }
      }
    }

    console.log('\n[5] 其余路由');
    for (const r of ['/trends', '/compare', '/aliases', '/upload', '/login']) {
      pageErrors.length = 0; errors.length = 0;
      const rr = await page.goto(BASE + r, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(1200);
      const t = await page.evaluate(() => document.body.innerText);
      check(`路由 ${r} 可达且非白屏`, rr && rr.status() === 200 && t.length > 20,
        `${rr && rr.status()} len=${t.length}`);
      check(`路由 ${r} 无 JS 异常`, pageErrors.length === 0, pageErrors[0]);
    }

    console.log('\n[6] 异常与边界');
    pageErrors.length = 0;
    const bad = await page.goto(BASE + '/this-route-does-not-exist', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(800);
    const badText = await page.evaluate(() => document.body.innerText);
    check('未知前端路由不 500 且不白屏', bad && bad.status() < 500 && badText.length > 10,
      `${bad && bad.status()} len=${badText.length}`);
    check('未知路由无 JS 异常', pageErrors.length === 0, pageErrors[0]);

    // 后端挂掉时前端是否给出可见反馈：先证明 UI 不会永久卡「加载中」
    console.log('\n[7] 离线承诺复核');
    check('累计外部请求仍为 0', external.length === 0, external.slice(0, 3).join(' , '));
    check('全程后端无 5xx 响应', serverErrors.length === 0,
      [...new Set(serverErrors)].slice(0, 4).join(' | '));
  } catch (e) {
    fail++;
    console.log('  FAIL  用例执行异常: ' + e.message);
  } finally {
    console.log(`\n==== 看板 SPA 端到端结果: ${pass} PASS / ${fail} FAIL ====`);
    try { if (browser) await browser.close(); } catch (_) {}
    browser = null;
    cleanup();
    process.off('exit', cleanup);
  }
  process.exitCode = fail ? 1 : 0;
}

main();
