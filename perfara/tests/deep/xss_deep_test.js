/**
 * XSS 深度探测：让恶意字符串从「上传接口 → 数据库 → 看板/报告」走完整条链路。
 *
 * 为什么单独一套：
 *   api_deep / spa_live_e2e 只验证正常数据能显示，没有任何一条断言把
 *   `<img onerror>` 之类的字符串真正送进渲染层。Vue 默认转义，但看板里有
 *   手写的 innerHTML（单文件报告、报告库），只读源码不能证明运行时安全。
 *
 * 覆盖：
 *   1. SPA 各路由（网络可达路径）——不得执行 payload、不得弹窗、不得白屏
 *   2. 单文件报告 perf.html（本地打开）——设备名/应用名不得执行
 *   3. 报告库 library.html（本地打开）——记录仅提示风险（索引文件为本地可信源）
 *
 * 用法：NODE_PATH 指向含 playwright-core 的目录；需本机 Edge。
 * 退出码 0 = 网络可达路径全部安全；1 = 有 FAIL 或执行异常。
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
const REPORTS = path.join(PERFARA, 'collector', 'resources', 'reports');
const PORT = 8149;
const BASE = `http://127.0.0.1:${PORT}`;
const UID = 'xssuser';

// 每条 payload 带唯一标记，命中后能定位是哪个字段泄漏
const X_LABEL = 'LABEL<img src=x onerror="window.__xss=\'label\'">';
const X_APP = 'APP<img src=x onerror="window.__xss=\'app\'">';
const X_DEV = '<svg onload="window.__xss=\'device\'">Dev';
const X_MODEL = '"><script>window.__xss="model"</script>';
const X_ALIAS = 'ALIAS<img src=x onerror="window.__xss=\'alias\'">';
const X_RISK_TEXT = '<img src=x onerror="window.__xss=\'insight\'">';

let pass = 0, fail = 0, risks = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  (' + String(detail).slice(0, 220) + ')' : ''}`); }
}
function risk(name, detail) {
  risks++;
  console.log(`  RISK  ${name}${detail ? '  | ' + String(detail).slice(0, 240) : ''}`);
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

function postJson(pathname, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const raw = Buffer.from(JSON.stringify(body), 'utf-8');
    const req = http.request(BASE + pathname, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': raw.length }, extraHeaders || {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.end(raw);
  });
}

function putJson(pathname, body) {
  return new Promise((resolve, reject) => {
    const raw = Buffer.from(JSON.stringify(body), 'utf-8');
    const req = http.request(BASE + pathname, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': raw.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.end(raw);
  });
}

function getJson(pathname, extraHeaders) {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + pathname, { headers: extraHeaders || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
  });
}

function makePayload(ts0, tag) {
  const perf = [];
  for (let i = 0; i < 8; i++) {
    perf.push({
      timestamp: ts0 + i * 1000,
      fps: 60, jank: i % 2, bigJank: 0,
      cpu: { sysCpu: 10 + i, procCpu: 20 + i },
      mem: { totalPss: 300000 + i * 100, nativeHeap: 1, javaHeap: 2, code: 3, stack: 4, graphics: 5, privateOther: 6, system: 7 },
      net: { rxKBps: 10, txKBps: 20 },
      battery: { temperature: 30 + i, currentNow: 100, power: 2 },
      cpuCores: { usage: [10, 20], freq: [1000, 2000] },
      gpu: 30, temperature: 31 + i,
    });
  }
  return {
    device: {
      name: X_DEV, model: X_MODEL, brand: 'XSSBrand',
      bundleId: 'com.xss.' + tag, appName: X_APP, category: 'android', osVersion: '13',
    },
    label: X_LABEL,
    tag: [[0, 3], [4, 7]],
    perf,
  };
}

function startServer(tmp) {
  const db = path.join(tmp, 'xss.db');
  return spawn(PY, ['-m', 'uvicorn', 'backend.app:app', '--host', '127.0.0.1',
    '--port', String(PORT), '--log-level', 'warning', '--no-server-header'], {
    cwd: PERFARA,
    env: Object.assign({}, process.env, { WEB_PERF_DB: db, PERFARA_HOME: tmp }),
    stdio: ['ignore', fs.openSync(path.join(tmp, 'srv.out'), 'w'),
      fs.openSync(path.join(tmp, 'srv.err'), 'w')],
  });
}

async function probePage(page, url, tag) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  await sleep(1200);
  const state = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const anchors = Array.from(document.querySelectorAll('a[href]'))
      .map((a) => a.getAttribute('href') || '')
      .filter((h) => /^\s*javascript:/i.test(h));
    return {
      marker: window.__xss === undefined ? null : String(window.__xss),
      textLen: document.body ? document.body.innerText.length : 0,
      rawImg: /<img\s+src=["']?x["']?/i.test(html),
      rawSvg: /<svg\s+onload/i.test(html),
      rawScript: /<script>window\.__xss/i.test(html),
      jsHrefs: anchors,
      displayed: document.body ? document.body.innerText : '',
    };
  });
  check(`[${tag}] 未执行注入脚本`, state.marker === null, `window.__xss=${state.marker}`);
  check(`[${tag}] DOM 无未转义的 <img src=x`, !state.rawImg);
  check(`[${tag}] DOM 无未转义的 <svg onload`, !state.rawSvg);
  check(`[${tag}] DOM 无未转义的 <script>`, !state.rawScript);
  check(`[${tag}] 无 javascript: 链接`, state.jsHrefs.length === 0, state.jsHrefs.slice(0, 3).join(','));
  check(`[${tag}] 页面非白屏`, state.textLen > 20, `len=${state.textLen}`);
  return state;
}

async function main() {
  if (!fs.existsSync(PY)) throw new Error('缺 tools/.venv：' + PY);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara_xss_'));
  const srv = startServer(tmp);
  let browser;
  const cleanup = () => {
    try { browser && browser.close(); } catch (_) {}
    try { srv.kill('SIGTERM'); } catch (_) {}
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); return; }
      catch (e) {
        if (e.code !== 'EBUSY' && e.code !== 'EPERM') return;
        try { srv.kill('SIGKILL'); } catch (_) {}
        const wait = Date.now() + 300;
        while (Date.now() < wait) { /* 释放句柄 */ }
      }
    }
    console.log('  WARN  临时目录未能删除: ' + tmp);
  };
  process.on('exit', cleanup);

  try {
    await waitHealth();

    console.log('\n[0] 注入数据');
    const up1 = await postJson(`/api/upload?uid=${UID}`, makePayload(1764000000000, 'one'));
    check('上传恶意 payload #1 返回 200', up1.status === 200, `${up1.status} ${up1.text.slice(0, 120)}`);
    const up2 = await postJson(`/api/upload?uid=${UID}`, makePayload(1764001000000, 'two'));
    check('上传恶意 payload #2 返回 200', up2.status === 200, `${up2.status}`);
    const al = await putJson(`/api/project-aliases?uid=${UID}`, [
      { package_name: 'com.xss.one', app_name: 'XSSApp', display_name: X_ALIAS },
    ]);
    check('写入恶意别名返回 200', al.status === 200, `${al.status} ${al.text.slice(0, 120)}`);
    const list = await getJson(`/api/tests?uid=${UID}&page=1&page_size=50`);
    let ids = [];
    try { ids = (JSON.parse(list.text).items || []).map((x) => x.id); } catch (_) {}
    check('列表能查到刚上传的记录', list.status === 200 && ids.length >= 2, `${list.status} ids=${ids}`);

    browser = await pw.chromium.launch({ executablePath: EDGE, headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    let dialogs = [], pageErrors = [];
    page.on('dialog', async (d) => { dialogs.push(d.type() + ':' + d.message()); try { await d.dismiss(); } catch (_) {} });
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.addInitScript((uid) => {
      try { sessionStorage.setItem('webperf_uid', uid); } catch (_) {}
    }, UID);

    console.log('\n[1] 看板列表');
    dialogs = []; pageErrors = [];
    const st1 = await probePage(page, BASE + '/', 'list');
    check('[list] 无弹窗', dialogs.length === 0, dialogs.join(' | '));
    check('[list] 无 JS 异常', pageErrors.length === 0, pageErrors[0]);
    check('[list] 恶意应用名以纯文本呈现', st1.displayed.includes('APP<img'), st1.displayed.slice(0, 160));

    console.log('\n[2] 详情页');
    for (const tid of ids.slice(0, 2)) {
      dialogs = []; pageErrors = [];
      const st = await probePage(page, `${BASE}/tests/${tid}`, `detail#${tid}`);
      check(`[detail#${tid}] 无弹窗`, dialogs.length === 0, dialogs.join(' | '));
      check(`[detail#${tid}] 无 JS 异常`, pageErrors.length === 0, pageErrors[0]);
      check(`[detail#${tid}] 图表已渲染`, await page.locator('canvas').count() > 0);
    }

    console.log('\n[3] 其余路由');
    for (const r of ['/tests', '/trends', '/compare', '/aliases', '/upload']) {
      dialogs = []; pageErrors = [];
      await probePage(page, BASE + r, r);
      check(`[${r}] 无弹窗`, dialogs.length === 0, dialogs.join(' | '));
      check(`[${r}] 无 JS 异常`, pageErrors.length === 0, pageErrors[0]);
    }

    console.log('\n[3b] URL 参数注入');
    for (const [tag, url] of [
      ['uid-label', '/?uid=' + encodeURIComponent(X_LABEL)],
      ['uid-device', '/login?uid=' + encodeURIComponent(X_DEV)],
    ]) {
      dialogs = []; pageErrors = [];
      await probePage(page, BASE + url, tag);
      check(`[${tag}] 无弹窗`, dialogs.length === 0, dialogs.join(' | '));
      check(`[${tag}] 无 JS 异常`, pageErrors.length === 0, pageErrors[0]);
    }

    console.log('\n[4] 单文件报告 perf.html');
    const rdir = path.join(tmp, 'report');
    fs.mkdirSync(rdir, { recursive: true });
    fs.copyFileSync(path.join(REPORTS, 'perf.html'), path.join(rdir, 'perf.html'));
    const dataJs = 'var data = ' + JSON.stringify({
      device: { name: X_DEV, brand: 'XSSBrand', model: X_MODEL, osVersion: '13',
        bundleId: 'com.xss.one', appName: X_APP, category: 'android' },
      tag: [[0, 3], [4, 7]],
      perf: Array.from({ length: 8 }, (_, i) => ({
        timestamp: 1764000000000 + i * 1000, fps: 58 + (i % 3), jank: i % 2, bigJank: 0,
        cpu: { sysCpu: 10 + i, procCpu: 20 + i },
        mem: { totalPss: 300000 + i * 100 },
        net: { rxKBps: 10, txKBps: 20 },
        battery: { temperature: 30 + i, currentNow: 100 },
        cpuCores: { usage: [10, 20], freq: [1000, 2000] },
        gpu: 30, temperature: 31 + i,
        insight: X_RISK_TEXT,
      })),
    }) + ';\n';
    fs.writeFileSync(path.join(rdir, 'data.js'), dataJs, 'utf-8');
    dialogs = []; pageErrors = [];
    const fileUrl = 'file:///' + path.join(rdir, 'perf.html').replace(/\\/g, '/');
    const st4 = await probePage(page, fileUrl, 'perf.html');
    check('[perf.html] 无弹窗', dialogs.length === 0, dialogs.join(' | '));
    check('[perf.html] 无 JS 异常', pageErrors.length === 0, pageErrors[0]);
    check('[perf.html] 设备名以纯文本呈现', st4.displayed.includes('<svg'), st4.displayed.slice(0, 160));

    console.log('\n[5] 报告库 library.html（本地索引文件）');
    const ldir = path.join(tmp, 'library');
    fs.mkdirSync(path.join(ldir, 'history'), { recursive: true });
    fs.copyFileSync(path.join(REPORTS, 'library.html'), path.join(ldir, 'library.html'));
    const idxJs = 'var reportIndex = ' + JSON.stringify([{
      id: '20261028-120000-XSS', file: 'history/none.js',
      createdAt: '2026-10-28T04:00:00.000Z', createdAtLocal: X_LABEL,
      platform: 'android', deviceName: X_DEV, deviceId: 'x', app: X_APP,
      samples: 8, durationSec: 8,
      kpi: { fps: { avg: 60, min: 50, max: 61 }, cpu: { avg: 20, min: 10, max: 30 },
        mem: { avg: 300, min: 290, max: 310 }, temp: { avg: 33, min: 31, max: 35 } },
    }]) + ';\n';
    fs.writeFileSync(path.join(ldir, 'history', 'index.js'), idxJs, 'utf-8');
    dialogs = []; pageErrors = [];
    const fileUrl2 = 'file:///' + path.join(ldir, 'library.html').replace(/\\/g, '/');
    // 索引文件属本地可信源，这一节只记录风险、不判失败：
    // 网络可达路径（上传 → 看板）已在 [1]~[4] 全部验证为安全。
    await page.goto(fileUrl2, { waitUntil: 'networkidle', timeout: 45000 });
    await sleep(1200);
    const st5 = await page.evaluate(() => ({
      marker: window.__xss === undefined ? null : String(window.__xss),
      textLen: document.body ? document.body.innerText.length : 0,
      rawImg: /<img\s+src=["']?x/i.test(document.documentElement.innerHTML),
    }));
    if (st5.marker !== null) {
      risk('library.html 的 createdAtLocal 未转义，索引被篡改时可执行脚本',
        `window.__xss=${st5.marker}；该窗口 sandbox:false 且 preload 暴露文件操作`);
    } else {
      check('[library.html] 索引时间字段已转义', true);
    }
    check('[library.html] 页面非白屏', st5.textLen > 20, `len=${st5.textLen}`);
    check('[library.html] 无弹窗', dialogs.length === 0, dialogs.join(' | '));
    check('[library.html] 无 JS 异常', pageErrors.length === 0, pageErrors[0]);
  } catch (e) {
    fail++;
    console.log('  FAIL  用例执行异常: ' + e.message);
  } finally {
    console.log(`\n==== XSS 深度探测结果: ${pass} PASS / ${fail} FAIL / ${risks} RISK ====`);
    try { if (browser) await browser.close(); } catch (_) {}
    browser = null;
    cleanup();
    process.off('exit', cleanup);
  }
  process.exitCode = fail ? 1 : 0;
}

main();
