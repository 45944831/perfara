'use strict';
/**
 * 用「真机采集数据」驱动 perf.html 渲染的无头验证。
 * 与造数据的 fixture 不同：这里灌的是 adb/PC 真实采集结果，用于验证端到端渲染链路，
 * 重点覆盖 PC 端 temperature/battery 为 null（无传感器/无电池）时的显示是否正确。
 *
 * 用法: node render_real_report.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pw = require('playwright-core');

const REPORTS = path.resolve(__dirname, '..', '..', 'collector', 'resources', 'reports');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara-real-'));
for (const f of ['perf.html', 'echarts.min.js']) {
  fs.copyFileSync(path.join(REPORTS, f), path.join(ROOT, f));
}
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

let pass = 0, fail = 0;
const fails = [];
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; fails.push(name); console.log('  FAIL  ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
}

async function render(port, payload) {
  fs.writeFileSync(path.join(ROOT, 'data.js'), 'var data = ' + JSON.stringify(payload, null, 2) + ';\n');
  const page = await browser_.newPage();
  const errors = [];
  const consoleErrors = [];
  const failedUrls = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('requestfailed', req => failedUrls.push(req.url()));
  page.on('response', res => { if (res.status() >= 400) failedUrls.push(res.status() + ' ' + res.url()); });
  await page.goto(`http://127.0.0.1:${port}/perf.html`, { waitUntil: 'load' });
  await page.waitForTimeout(2800);
  const r = await page.evaluate(() => {
    const q = s => document.querySelector(s);
    const txt = s => { const el = q(s); return el ? (el.textContent || '').trim() : null; };
    return {
      pageCategory: (function () {
        if (typeof data === 'undefined' || !data) return 'no-data';
        return String((data.device && data.device.category) || data.category || '').toLowerCase() || '(empty)';
      })(),
      hasDiskCard: !!document.getElementById('card-disk'),
      hasDiskChart: !!document.getElementById('chart-disk'),
      diskCanvas: (function () {
        const el = document.getElementById('chart-disk');
        return !!(el && el.querySelector('canvas'));
      })(),
      hasBatteryCard: !!document.getElementById('card-battery'),
      bodyText: (document.body.innerText || '').slice(0, 4000),
      hasNaN: /NaN|undefined|Infinity/.test(document.body.innerText || ''),
      vFps: txt('#val-fps'), vCpu: txt('#val-cpu'), vMem: txt('#val-mem'),
      vTemp: txt('#val-temp') || txt('#val-temperature'),
      vGpu: txt('#val-gpu'), vBattery: txt('#val-battery'),
      vSysCpu: txt('#val-syscpu'), vProcCpu: txt('#val-proccpu'),
      vCpu: txt('#val-cpu'), vDisk: txt('#val-disk'),
      vJank: txt('#val-jank'), vBigJank: txt('#val-bigjank') || txt('#val-big-jank'),
      gpuLabel: (() => {
        const el = document.querySelector('#val-gpu');
        if (!el) return null;
        const card = el.closest('.card') || el.parentElement;
        const lb = card && card.querySelector('.card-label');
        return lb ? lb.textContent.trim().replace(/[!！]/g, '') : null;
      })(),
      chartCount: document.querySelectorAll('.chart-wrap').length,
      visibleCharts: Array.from(document.querySelectorAll('.chart-wrap')).filter(e => !e.hidden && e.style.display !== 'none').length,
      canvases: document.querySelectorAll('canvas').length,
      statRows: document.querySelectorAll('#tbl-global tbody tr').length,
      // 统计表里是否出现了各卡顿指标行
      statText: Array.from(document.querySelectorAll('#tbl-global tbody tr')).map(tr => tr.innerText.replace(/\s+/g, ' ').trim()).slice(0, 40),
      // 诊断：dump 所有指标卡（id → 标签 + 值），避免依赖猜测的选择器
      allCards: Array.from(document.querySelectorAll('[id^="val-"]')).map(el => ({
        id: el.id,
        text: (el.textContent || '').trim(),
        label: (() => {
          const card = el.closest('.card') || el.parentElement;
          const lb = card && card.querySelector('.card-label');
          return lb ? lb.textContent.trim().replace(/[!！]/g, '') : null;
        })(),
      })),
    };
  });
  await page.close();
  return { r, errors, consoleErrors, failedUrls };
}

let browser_;
(async () => {
  const androidPath = path.join(__dirname, '_real_android.json');
  const pcPath = path.join(__dirname, '_real_pc.json');
  if (!fs.existsSync(androidPath) || !fs.existsSync(pcPath)) {
    console.log('缺少 fixture，请先运行 capture_real_fixtures.js');
    process.exit(2);
  }

  const missing = [];
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'perf.html';
    // 浏览器会主动请求 favicon.ico，缺它会记一条 404 console error，与页面功能无关
    if (rel === 'favicon.ico') { res.writeHead(204); res.end(); return; }
    const p = path.join(ROOT, rel);
    try {
      const body = fs.readFileSync(p);
      // 禁止缓存：同一 URL 会被连续渲染多份不同的 data.js，缓存会导致后一次读到旧数据
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(p)] || 'application/octet-stream',
        'Cache-Control': 'no-store, must-revalidate',
      });
      res.end(body);
    } catch (e) {
      missing.push(rel);
      res.writeHead(404); res.end('nf');
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  browser_ = await pw.chromium.launch({ executablePath: EDGE, args: ['--no-sandbox', '--headless=new'] });

  // ── Android 真机数据 ──
  console.log('\n[A] Android 真机采集数据渲染');
  const A = await render(port, JSON.parse(fs.readFileSync(androidPath, 'utf8')));
  console.log(`  可见图表 ${A.r.visibleCharts}/${A.r.chartCount}，canvas ${A.r.canvases}，统计表行 ${A.r.statRows}`);
  console.log('  卡片:', A.r.allCards.map(c => `${c.id}[${c.label}]=${c.text}`).join('  '));
  if (A.failedUrls.length) console.log('  加载失败资源:', A.failedUrls.slice(0, 5));
  if (missing.length) console.log('  服务器 404 路径:', missing.slice(0, 5));
  check('无 JS 运行时错误', A.errors.length === 0, A.errors.slice(0, 3));
  const realConsoleErrors = A.consoleErrors;
  check('无 console error', realConsoleErrors.length === 0, realConsoleErrors.slice(0, 3));
  check('无资源加载失败', missing.length === 0, missing);
  check('页面无 NaN/undefined 文案', A.r.hasNaN === false, A.r.bodyText.slice(0, 200));
  check('渲染出 canvas 图表', A.r.canvases > 0, A.r.canvases);
  check('统计表有指标行', A.r.statRows > 5, A.r.statRows);
  check('FPS 卡片有值', A.r.vFps && A.r.vFps !== '--', A.r.vFps);
  // Android 模板的 CPU 卡片 id 是 val-syscpu / val-proccpu（不是 val-cpu）
  check('系统 CPU 卡片有值', A.r.vSysCpu && A.r.vSysCpu !== '--', A.r.vSysCpu);
  check('进程 CPU 卡片有值', A.r.vProcCpu && A.r.vProcCpu !== '--', A.r.vProcCpu);
  check('Jank 卡片有值（算法修复后可出数）', A.r.vJank && A.r.vJank !== '--', A.r.vJank);
  check('BigJank 卡片有值', A.r.vBigJank && A.r.vBigJank !== '--', A.r.vBigJank);
  check('内存卡片有值', A.r.vMem && A.r.vMem !== '--', A.r.vMem);
  check('温度卡片有值', A.r.vTemp && A.r.vTemp !== '--', A.r.vTemp);
  // 该机型读不到 GPU 利用率（gpu=null）→ 按设计「补位」为 GPU 温度，标签必须同步改名，
  // 否则用户会把 77.6 误读成「GPU 利用率 77.6%」
  console.log('  GPU 卡片:', JSON.stringify(A.r.gpuLabel), '=', JSON.stringify(A.r.vGpu));
  check('GPU 利用率缺失时补位为温度并改名', A.r.gpuLabel === 'GPU 温度', { label: A.r.gpuLabel, val: A.r.vGpu });
  const allStat = A.r.statText.join(' | ');
  check('统计表包含 Jank 行', /Jank/i.test(allStat), A.r.statText.slice(0, 6));
  check('统计表包含 BigJank 行', /BigJank/i.test(allStat), A.r.statText.slice(0, 8));

  // ── PC 真机数据（temperature / battery = null）──
  console.log('\n[B] PC 真机采集数据渲染（无温度/无电池 → null）');
  const B = await render(port, JSON.parse(fs.readFileSync(pcPath, 'utf8')));
  console.log(`  可见图表 ${B.r.visibleCharts}/${B.r.chartCount}，canvas ${B.r.canvases}，统计表行 ${B.r.statRows}`);
  console.log('  卡片:', B.r.allCards.map(c => `${c.id}[${c.label}]=${c.text}`).join('  '));
  console.log(`  页面判定 category=${B.r.pageCategory}  磁盘卡=${B.r.hasDiskCard}  电池卡=${B.r.hasBatteryCard}`);
  if (B.failedUrls.length) console.log('  加载失败资源:', B.failedUrls.slice(0, 5));
  console.log('  温度卡片值 =', JSON.stringify(B.r.vTemp), ' 电池卡片值 =', JSON.stringify(B.r.vBattery));
  check('无 JS 运行时错误', B.errors.length === 0, B.errors.slice(0, 3));
  check('无 console error', B.consoleErrors.length === 0, B.consoleErrors.slice(0, 3));
  check('页面无 NaN/undefined 文案', B.r.hasNaN === false, B.r.bodyText.slice(0, 200));
  check('渲染出 canvas 图表', B.r.canvases > 0, B.r.canvases);
  check('统计表有指标行', B.r.statRows > 5, B.r.statRows);
  // PC 模板的 CPU 卡片 id 是 val-cpu / val-syscpu
  check('CPU 卡片有值', (B.r.vCpu && B.r.vCpu !== '--') || (B.r.vSysCpu && B.r.vSysCpu !== '--'), { vCpu: B.r.vCpu, vSysCpu: B.r.vSysCpu });
  check('内存卡片有值', B.r.vMem && B.r.vMem !== '--', B.r.vMem);
  check('GPU 卡片有值', B.r.vGpu && B.r.vGpu !== '--', B.r.vGpu);
  // PC 模板由 TPL_ANDROID 派生而来，磁盘是「图表」chart-disk 而非卡片
  const diskEl = B.r.diskChart || null;
  check('PC 报告含磁盘 I/O 图', B.r.hasDiskChart === true, B.r.hasDiskChart);
  check('磁盘图已渲染 canvas', B.r.diskCanvas === true, B.r.diskCanvas);
  void diskEl;
  check('温度无数据不显示为 0°C', !(B.r.vTemp && /^0\s*(°C|℃|C)$/.test(B.r.vTemp.trim())), B.r.vTemp);
  check('电池无数据不显示为 0%', !(B.r.vBattery && /^0\s*%$/.test(B.r.vBattery.trim())), B.r.vBattery);

  await browser_.close();
  server.close();

  console.log(`\n===== 结果: ${pass} PASS / ${fail} FAIL =====`);
  if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('致命错误:', e); process.exit(2); });
