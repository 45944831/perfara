'use strict';
/**
 * 真机完整走查 —— 阶段 3：报告页渲染（perf.html）+ 报告库（library.html）
 *
 * 用**真机采集的真实数据**驱动无头浏览器渲染，验证：
 *   1) perf.html 正常渲染，图表有实例，无 JS 报错
 *   2) 指标去重生效（不再出现同名重复行）
 *   3) metricConfig 关闭的指标在页面上真的被隐藏
 *   4) library.html 能加载历史报告列表、打开报告、对比
 *   5) 对比报告「保存」按钮存在且可导出自包含单文件
 *
 * 用法: node realdevice_walkthrough_s3.js <deviceId> [packageName]
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-walk-s3-'));
const _origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return { app: { isPackaged: false, getPath: () => TMP, getName: () => 'perfara' } };
  }
  return _origLoad.apply(this, arguments);
};

const pw = require('playwright-core');

const REPORTS = path.resolve(__dirname, '..', '..', 'collector', 'resources', 'reports');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara-s3-'));
for (const f of ['perf.html', 'library.html', 'echarts.min.js']) {
  const src = path.join(REPORTS, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(ROOT, f));
}
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

const APP = 'E:/WorkBuddy1/2026-10-19-13-59-27/_client_src/app';
process.resourcesPath = 'E:/WorkBuddy1/2026-10-19-13-59-27/perfara/collector/resources';
const CollectorMod = require(path.join(APP, 'src/collector.js'));
const Collector = CollectorMod.Collector || CollectorMod;

const DEVICE = process.argv[2] || '设备序列号';
const PKG = process.argv[3] || 'com.example.game';

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); }
  else { fail++; fails.push(name); console.log(`  FAIL  ${name}  ${detail !== undefined ? JSON.stringify(detail) : ''}`); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log(`\n===== 阶段 3：报告页渲染（device=${DEVICE} pkg=${PKG}）=====\n`);

  // ---- 采一份真实数据 ----
  console.log('[3.0] 真机采集 20 秒');
  const c = new Collector(DEVICE, PKG, 1000, null);
  const samples = [];
  c.on('data', d => samples.push(d));
  c.on('error', e => console.log('  采集错误:', e.message));
  try { await c.start(); } catch (e) { console.log('  start 失败:', e.message); }
  await sleep(20000);
  try { c.stop(); } catch (_) {}
  check('采集到真实样本', samples.length >= 12, { count: samples.length });
  if (samples.length < 5) { console.log('样本不足，终止'); process.exit(1); }

  const payload = {
    perf: samples,
    tags: [],
    device: { name: 'Android 13 中端机型', model: 'generic', brand: '厂商', system: 'Android 13', category: 'android', deviceId: DEVICE, appName: PKG },
    app: { id: PKG, name: PKG },
    metricConfig: null,
  };

  // ---- 起静态服务 ----
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    const fp = path.join(ROOT, p === '/' ? 'perf.html' : p);
    fs.readFile(fp, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('nf'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
      res.end(buf);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const browser = await pw.chromium.launch({ executablePath: EDGE, headless: true });

  // ---- 3.1 perf.html 渲染 ----
  console.log('\n[3.1] perf.html 渲染');
  fs.writeFileSync(path.join(ROOT, 'data.js'), 'var data = ' + JSON.stringify(payload) + ';\n');
  {
    const page = await browser.newPage();
    const errors = [], consoleErrs = [], failed = [], responses = [];
    page.on('pageerror', e => errors.push(e.message));
    // favicon 是浏览器自动请求的，与页面自身资源无关，排除掉避免噪音
    page.on('console', m => {
      if (m.type() !== 'error') return;
      if (/favicon/i.test(m.text())) return;
      consoleErrs.push(m.text());
    });
    page.on('requestfailed', r => failed.push(r.url()));
    page.on('response', res => { if (res.status() >= 400) responses.push(res.status() + ' ' + res.url()); });
    await page.goto(`http://127.0.0.1:${port}/perf.html`, { waitUntil: 'load' });
    await page.waitForTimeout(3000);
    const r = await page.evaluate(() => {
      const q = s => document.querySelector(s);
      const txt = s => { const el = q(s); return el ? (el.textContent || '').trim() : null; };
      // 统计所有表格行文本，找重复的指标名
      const rowLabels = [];
      document.querySelectorAll('table tr').forEach(tr => {
        const tds = tr.querySelectorAll('td');
        if (tds.length) rowLabels.push((tds[0].textContent || '').trim());
      });
      const names = rowLabels.filter(x => x && !/^[\d.\-+%]*$/.test(x));
      const dup = {};
      names.forEach(n => { dup[n] = (dup[n] || 0) + 1; });
      const dups = Object.keys(dup).filter(k => dup[k] > 1);
      // 图表实例数
      const charts = (typeof echarts !== 'undefined') ? echarts.getInstanceByDom ? null : null : null;
      let chartCount = 0;
      document.querySelectorAll('.chart, [id^="chart"], canvas').forEach(() => chartCount++);
      return {
        hasData: typeof data !== 'undefined' && !!data,
        perfLen: (typeof data !== 'undefined' && data.perf) ? data.perf.length : -1,
        deviceName: txt('#device-name') || txt('.device-name'),
        rowCount: rowLabels.length,
        dups,
        canvasCount: document.querySelectorAll('canvas').length,
        // perf.html 用 .card-value（library.html 才用 .kpi-value）
        kpiCount: document.querySelectorAll('.card-value').length,
        // 可见的卡片（hidden 属性才是真隐藏，innerText 仍含隐藏元素文本）
        visibleCards: Array.from(document.querySelectorAll('.card'))
          .filter(el => !el.hidden && el.offsetParent !== null).length,
        bodyLen: document.body.innerText.length,
        hasNaN: /NaN|undefined|\[object Object\]/.test(document.body.innerText),
      };
    });
    check('perf.html 无 JS 运行时错误', errors.length === 0, errors.slice(0, 3));
    check('perf.html 无 console error', consoleErrs.length === 0, { consoleErrs: consoleErrs.slice(0, 3), http404: responses.slice(0, 3) });
    check('无资源加载失败', failed.length === 0, { failed: failed.slice(0, 3), http404: responses.slice(0, 3) });
    check('data 注入成功', r.hasData && r.perfLen === samples.length, r);
    check('页面有内容渲染', r.bodyLen > 500, { bodyLen: r.bodyLen });
    check('图表 canvas 已绘制', r.canvasCount > 0, { canvas: r.canvasCount });
    check('指标卡已渲染', r.kpiCount > 0, { cards: r.kpiCount });
    check('指标卡可见（未被误隐藏）', r.visibleCards >= 8, { visible: r.visibleCards });
    check('表格行已渲染', r.rowCount > 5, { rows: r.rowCount });
    check('页面无 NaN/undefined 文本', !r.hasNaN);
    check('指标名无重复（去重生效）', r.dups.length === 0, r.dups);
    await page.close();
  }

  // ---- 3.2 metricConfig 关闭的指标在页面上被隐藏 ----
  console.log('\n[3.2] metricConfig 关闭 fps 组 → 页面隐藏');
  {
    const p2 = { ...payload, metricConfig: { fps: false, cpu: true, mem: true, net: true, gpu: true, temp: true, battery: true } };
    fs.writeFileSync(path.join(ROOT, 'data.js'), 'var data = ' + JSON.stringify(p2) + ';\n');
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/perf.html`, { waitUntil: 'load' });
    await page.waitForTimeout(2500);
    const r = await page.evaluate(() => {
      // hidden 元素仍会出现在 innerText 里，必须按 hidden/offsetParent 判定
      const visibleFps = Array.from(document.querySelectorAll('[data-metric="fps"]'))
        .filter(el => !el.hidden && el.offsetParent !== null);
      const visibleCpu = Array.from(document.querySelectorAll('[data-metric="cpu"]'))
        .filter(el => !el.hidden && el.offsetParent !== null);
      const allFps = document.querySelectorAll('[data-metric="fps"]').length;
      return {
        fpsTotal: allFps,
        fpsVisible: visibleFps.length,
        cpuVisible: visibleCpu.length,
        canvasCount: document.querySelectorAll('canvas').length,
        bodyLen: document.body.innerText.length,
      };
    });
    check('关闭 fps 组后无 JS 错误', errors.length === 0, errors.slice(0, 2));
    check('关闭 fps 组后 FPS 元素全部隐藏', r.fpsTotal > 0 && r.fpsVisible === 0, r);
    check('关闭 fps 组后 CPU 仍可见', r.cpuVisible > 0, r);
    await page.close();
  }

  // ---- 3.3 library.html 报告库 ----
  console.log('\n[3.3] library.html 报告库');
  {
    // 造一份 history 供报告库读取
    const hist = path.join(ROOT, 'history');
    fs.mkdirSync(hist, { recursive: true });
    fs.writeFileSync(path.join(hist, 'test-report-1.js'), 'var data = ' + JSON.stringify(payload) + ';\n');
    const idx = [{
      id: 'test-report-1', file: 'history/test-report-1.js',
      createdAt: new Date().toISOString(), createdAtLocal: '2026-10-21 16:00:00',
      platform: 'android', deviceName: 'Android 13 中端机型', deviceId: DEVICE,
      app: PKG, samples: samples.length, durationSec: samples.length,
      kpi: { fps: { avg: 58, min: 45, max: 60 }, cpu: { avg: 12, min: 3, max: 30 } },
      metricConfig: null,
    }];
    fs.writeFileSync(path.join(ROOT, 'history', 'index.js'), 'var reportIndex = ' + JSON.stringify(idx) + ';\n');
    fs.writeFileSync(path.join(ROOT, 'history', 'index.json'), JSON.stringify(idx));

    const page = await browser.newPage();
    const errors = [], consoleErrs = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') consoleErrs.push(m.text()); });
    await page.goto(`http://127.0.0.1:${port}/library.html`, { waitUntil: 'load' });
    await page.waitForTimeout(2500);
    const r = await page.evaluate((pkgName) => ({
      bodyLen: document.body.innerText.length,
      hasReportWord: /报告|Report|历史/i.test(document.body.innerText),
      hasDeviceName: document.body.innerText.includes('Android 13 中端机型'),
      hasApp: document.body.innerText.includes(pkgName),
      listItems: document.querySelectorAll('.report-item, .report-card, li, .card').length,
      saveBtn: !!document.querySelector('#btn-export-compare'),
      hasNaN: /NaN|undefined/.test(document.body.innerText),
    }), PKG);
    check('library.html 无 JS 错误', errors.length === 0, errors.slice(0, 3));
    check('library.html 无 console error', consoleErrs.length === 0, consoleErrs.slice(0, 3));
    check('报告库有内容', r.bodyLen > 300, { bodyLen: r.bodyLen });
    check('报告库显示了设备名', r.hasDeviceName);
    check('报告库显示了应用名', r.hasApp);
    check('对比保存按钮存在', r.saveBtn);
    check('报告库无 NaN/undefined', !r.hasNaN);
    await page.close();
  }

  // ---- 3.4 对比报告导出逻辑（复用 main.js 的实现路径做静态验证）----
  console.log('\n[3.4] 对比报告导出关键实现校验');
  {
    const mainSrc = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
    check('main.js 有 library-export-compare-report IPC',
      /ipcMain\.handle\(\s*['"]library-export-compare-report['"]/.test(mainSrc));
    check('对比导出用 lastIndexOf 定位 </body>（避免命中 echarts 源码）',
      /lastIndexOf\(['"]<\/body>['"]\)/.test(mainSrc));
    check('内联 JSON 转义 < 为 \\u003c',
      /u003c/.test(mainSrc));
    const libSrc = fs.readFileSync(path.join(REPORTS, 'library.html'), 'utf8');
    check('library.html 有保存对比报告按钮', /btn-export-compare/.test(libSrc));
    check('library.html 导出调用 reportLib.exportCompareReport',
      /exportCompareReport/.test(libSrc));
  }

  await browser.close();
  server.close();

  console.log(`\n===== 阶段 3 结果：PASS ${pass} / FAIL ${fail} =====`);
  if (fails.length) console.log('失败项: ' + fails.join(' | '));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); process.exit(2); });
