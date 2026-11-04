/**
 * 采集参数「展示顺序」回归（playwright-core + Edge）：
 *  A) 采集页：↑↓ 调整顺序 → 保存 → localStorage.__order 与页面 CSS order 同步变化；刷新后仍生效
 *  B) 采集页：恢复默认顺序按钮生效；取消不落盘
 *  C) perf.html：payload.metricOrder 让指标卡与图表按新顺序排列；旧报告无该字段时不改动
 *  D) library.html：orderedByGroup 按组稳定重排（同组内保持原相对顺序）
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const pw = require('playwright-core');

const APP = path.resolve(__dirname, '..', '..', '..', '_client_src', 'app');
const RENDERER = path.join(APP, 'renderer');
const REPORTS = path.resolve(__dirname, '..', '..', 'collector', 'resources', 'reports');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const MOCK = `
window.perfAPI = new Proxy({}, { get: (t, k) => {
  if (k === 'then') return undefined;
  return async () => ({ ok: false, reason: 'mock' });
}});
`;

function serve(root, extra) {
  return http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const base = rel.startsWith('node_modules/') ? path.resolve(root, '..') : root;
    let p = path.join(base, rel);
    if (extra && extra[rel]) p = extra[rel];
    try {
      const body = fs.readFileSync(p);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      res.end(body);
    } catch (e) { res.writeHead(404); res.end('nf'); }
  });
}

/** 取容器里每组第一个 [data-metric] 元素的 CSS order，按 order 升序返回组序列 */
const READ_ORDER = `(() => {
  const out = {};
  document.querySelectorAll('section.cards > [data-metric], .charts-grid > [data-metric]').forEach(el => {
    const g = el.getAttribute('data-metric');
    const o = Number(el.style.order || 0);
    if (!(g in out) || o < out[g]) out[g] = o;
  });
  return Object.keys(out).sort((a, b) => out[a] - out[b]);
})()`;

function mkAndroid(order, legacy) {
  const perf = [];
  for (let i = 0; i < 8; i++) {
    perf.push({
      timestamp: 1700000000000 + i * 1000, time: '12:00:0' + i,
      mem: { totalPss: 1000 + i, javaHeap: 10, nativeHeap: 5, code: 1, stack: 1, graphics: 1, privateOther: 1, system: 1 },
      net: { rxKBps: 5, txKBps: 2 }, gpu: 3, temperature: 30,
      battery: { currentNow: 100, power: 2, level: 80, temperature: 29 },
      fps: 60, jank: 1, bigJank: 0, cpu: { sysCpu: 10, procCpu: 5 }, cpuCores: { usage: [1, 2], freq: [100, 200] },
    });
  }
  const p = {
    device: { name: 'Pixel 7', model: 'Pixel', category: 'android', deviceId: 'ABC', appName: 'Demo' },
    perf, tag: null,
    metricConfig: { fps: true, cpu: true, mem: true, net: true, gpu: true, temp: true, battery: true },
  };
  if (order) {
    if (legacy) p.metricConfig.__order = order;
    else p.metricOrder = order;
  }
  return p;
}

async function main() {
  let pass = 0, fail = 0;
  const check = (name, ok, extra) => {
    if (ok) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); }
  };
  const browser = await pw.chromium.launch({ executablePath: EDGE, args: ['--no-sandbox', '--headless=new'] });

  // ── A/B 采集页 ────────────────────────────────────────────────────────────
  const srvApp = serve(RENDERER);
  await new Promise(r => srvApp.listen(0, '127.0.0.1', r));
  const appPort = srvApp.address().port;
  const ctx = await browser.newContext();
  await ctx.addInitScript(MOCK);
  const page = await ctx.newPage();
  const appErrors = [];
  page.on('pageerror', e => appErrors.push(e.message));
  await page.goto(`http://127.0.0.1:${appPort}/index.html`, { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  console.log('[A] 采集页：上移 → 保存 → 顺序固化');
  await page.click('#btn-metric-settings');
  await page.waitForTimeout(200);
  const dlg = await page.evaluate(() => {
    const root = document.getElementById('metric-settings-root');
    return {
      rows: root.querySelectorAll('.ms-row').length,
      ups: root.querySelectorAll('.ms-up').length,
      downs: root.querySelectorAll('.ms-down').length,
      firstUpDisabled: root.querySelector('.ms-up').disabled,
      lastDownDisabled: root.querySelectorAll('.ms-down')[6].disabled,
      initial: [...root.querySelectorAll('.ms-row')].map(r => r.getAttribute('data-group')),
    };
  });
  check('每组都有上下移按钮', dlg.ups === 7 && dlg.downs === 7, dlg);
  check('首行↑/末行↓禁用', dlg.firstUpDisabled === true && dlg.lastDownDisabled === true, dlg);
  check('初始为默认顺序', dlg.initial.join(',') === 'fps,cpu,mem,net,gpu,temp,battery', dlg.initial);

  // 把第 2 行（cpu）上移到第 1 位
  await page.evaluate(() => {
    const root = document.getElementById('metric-settings-root');
    root.querySelectorAll('.ms-row')[1].querySelector('.ms-up').click();
  });
  const moved = await page.evaluate(() => {
    const root = document.getElementById('metric-settings-root');
    return [...root.querySelectorAll('.ms-row')].map(r => r.getAttribute('data-group'));
  });
  check('上移后 cpu 到首位', moved.join(',') === 'cpu,fps,mem,net,gpu,temp,battery', moved);

  await page.evaluate(() => {
    const root = document.getElementById('metric-settings-root');
    [...root.querySelectorAll('button')].find(b => b.textContent === '保存').click();
  });
  await page.waitForTimeout(300);
  const saved = await page.evaluate((expr) => {
    const cfg = JSON.parse(localStorage.getItem('perfara.metricConfig.android') || '{}');
    return { order: cfg.__order, pageOrder: eval(expr) };
  }, READ_ORDER);
  check('localStorage 保存新顺序', saved.order && saved.order.join(',') === 'cpu,fps,mem,net,gpu,temp,battery', saved.order);
  const expected = ['cpu', 'fps', 'mem', 'net', 'gpu', 'temp', 'battery'].filter(g => saved.pageOrder.indexOf(g) !== -1);
  const got = saved.pageOrder.filter(g => expected.indexOf(g) !== -1);
  check('采集界面卡片/图表按新顺序', got.join(',') === expected.join(','), { got, expected, raw: saved.pageOrder });

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(900);
  const persisted = await page.evaluate((expr) => {
    const cfg = JSON.parse(localStorage.getItem('perfara.metricConfig.android') || '{}');
    return { order: cfg.__order, pageOrder: eval(expr) };
  }, READ_ORDER);
  check('刷新后顺序仍生效', persisted.pageOrder.filter(g => expected.indexOf(g) !== -1).join(',') === expected.join(','), persisted);

  console.log('[B] 恢复默认顺序 / 取消不落盘');
  await page.click('#btn-metric-settings');
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const root = document.getElementById('metric-settings-root');
    [...root.querySelectorAll('button')].find(b => b.textContent === '恢复默认顺序').click();
  });
  const reset = await page.evaluate(() => {
    const root = document.getElementById('metric-settings-root');
    return [...root.querySelectorAll('.ms-row')].map(r => r.getAttribute('data-group'));
  });
  check('恢复默认顺序按钮生效', reset.join(',') === 'fps,cpu,mem,net,gpu,temp,battery', reset);
  await page.evaluate(() => {
    const root = document.getElementById('metric-settings-root');
    [...root.querySelectorAll('button')].find(b => b.textContent === '取消').click();
  });
  const afterCancel = await page.evaluate(() => JSON.parse(localStorage.getItem('perfara.metricConfig.android') || '{}').__order);
  check('取消不改动已保存顺序', afterCancel && afterCancel.join(',') === 'cpu,fps,mem,net,gpu,temp,battery', afterCancel);
  check('采集页无 JS 报错', appErrors.length === 0, appErrors.slice(0, 3));
  await ctx.close();
  srvApp.close();

  // ── C perf.html ───────────────────────────────────────────────────────────
  console.log('[C] perf.html：payload.metricOrder 驱动报告顺序');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara-order-'));
  for (const f of ['perf.html', 'echarts.min.js']) fs.copyFileSync(path.join(REPORTS, f), path.join(tmp, f));
  const srvRep = serve(tmp);
  await new Promise(r => srvRep.listen(0, '127.0.0.1', r));
  const repPort = srvRep.address().port;

  async function reportOrder(payload) {
    fs.writeFileSync(path.join(tmp, 'data.js'), 'var data = ' + JSON.stringify(payload) + ';\n');
    const p = await browser.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    await p.goto(`http://127.0.0.1:${repPort}/perf.html`, { waitUntil: 'load' });
    await p.waitForTimeout(1800);
    const r = await p.evaluate((expr) => ({
      groups: eval(expr),
      touched: [...document.querySelectorAll('.charts-grid > [data-metric]')].filter(el => el.style.order !== '').length,
    }), READ_ORDER);
    await p.close();
    return { ...r, errs };
  }

  const newOrder = ['mem', 'gpu', 'fps', 'cpu', 'net', 'temp', 'battery'];
  const c1 = await reportOrder(mkAndroid(newOrder));
  const exp1 = newOrder.filter(g => c1.groups.indexOf(g) !== -1);
  check('报告按 metricOrder 重排', c1.groups.filter(g => exp1.indexOf(g) !== -1).join(',') === exp1.join(','), c1);
  check('图表确实被设置了 order', c1.touched > 0, c1.touched);
  check('报告无 JS 报错', c1.errs.length === 0, c1.errs.slice(0, 3));

  const c2 = await reportOrder(mkAndroid(null));
  check('旧报告无 metricOrder 时不改动顺序', c2.touched === 0, c2);
  const c3 = await reportOrder(mkAndroid(newOrder, true));
  check('兼容 metricConfig.__order', c3.groups.filter(g => exp1.indexOf(g) !== -1).join(',') === exp1.join(','), c3.groups);
  srvRep.close();

  // ── D library.html 的纯函数 ──────────────────────────────────────────────
  console.log('[D] library.html：orderedByGroup 稳定分组排序');
  const lib = fs.readFileSync(path.join(REPORTS, 'library.html'), 'utf8');
  const start = lib.indexOf('function orderedByGroup(');
  // library.html 可能是 CRLF，用正则找函数结尾（行首单独的 }）
  const tail = /\r?\n\}\r?\n/.exec(lib.slice(start));
  const src = lib.slice(start, start + tail.index + tail[0].length);
  const orderedByGroup = vm.runInNewContext(src + '\norderedByGroup;', {});
  const items = [
    { key: 'fps', g: 'fps' }, { key: 'cpu', g: 'cpu' }, { key: 'mem', g: 'mem' },
    { key: 'fpsStd', g: 'fps' }, { key: 'jank', g: 'fps' },
  ];
  const sorted = orderedByGroup(items, ['mem', 'fps', 'cpu'], x => x.g).map(x => x.key);
  check('按组重排且组内稳定', sorted.join(',') === 'mem,fps,fpsStd,jank,cpu', sorted);
  const unchanged = orderedByGroup(items, null, x => x.g).map(x => x.key);
  check('无顺序配置时原样返回', unchanged.join(',') === 'fps,cpu,mem,fpsStd,jank', unchanged);

  // ── E Web 看板 SPA ───────────────────────────────────────────────────────
  console.log('[E] SPA 看板：注入补丁按 payload.metricOrder 重排');
  const bundlePath = path.resolve(__dirname, '..', '..', 'frontend', 'dist', 'assets', 'index-CX8C-b2E.js');
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  const mStart = bundle.indexOf('/*perfara-metric-order-patch-v1*/');
  const mEnd = bundle.indexOf('/*perfara-metric-order-patch-end*/');
  check('SPA 已注入顺序补丁', mStart !== -1 && mEnd > mStart);
  if (mStart !== -1 && mEnd > mStart) {
    const snippet = bundle.slice(mStart, mEnd + '/*perfara-metric-order-patch-end*/'.length);
    const spa = await browser.newPage();
    const spaErrors = [];
    spa.on('pageerror', e => spaErrors.push(e.message));
    await spa.setContent(`
      <section class="cards">
        <div class="card" id="card-cpu"></div><div class="card" id="card-mem"></div>
        <div class="card" id="card-fps"></div>
      </section>
      <section class="charts-grid">
        <div class="chart-wrap"><div id="chart-cpu" class="chart"></div></div>
        <div class="chart-wrap"><div id="chart-mem" class="chart"></div></div>
        <div class="chart-wrap"><div id="chart-fps" class="chart"></div></div>
        <div class="chart-wrap"><div id="chart-net" class="chart"></div></div>
      </section>`);
    const spaOrder = await spa.evaluate(({ code, order }) => {
      const e = { payload: { metricOrder: order } };
      const r = { value: document.body };
      // 注入片段引用模块作用域的 e / r，用 Function 把两者作为形参送进去
      new Function('e', 'r', code)(e, r);
      const out = {};
      document.querySelectorAll('section.cards > [id]').forEach(el => { out[el.id] = el.style.order; });
      document.querySelectorAll('.charts-grid > .chart-wrap').forEach(el => {
        out[el.querySelector('[id]').id] = el.style.order;
      });
      return out;
    }, { code: snippet, order: ['mem', 'fps', 'cpu', 'net'] });
    check('SPA 卡片按新顺序', spaOrder['card-mem'] === '0' && spaOrder['card-fps'] === '1000' && spaOrder['card-cpu'] === '2000', spaOrder);
    check('SPA 图表按新顺序', spaOrder['chart-mem'] === '0' && spaOrder['chart-fps'] === '1000' && spaOrder['chart-cpu'] === '2000' && spaOrder['chart-net'] === '3000', spaOrder);
    check('SPA 补丁无 JS 报错', spaErrors.length === 0, spaErrors.slice(0, 2));
    await spa.close();
  }

  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
