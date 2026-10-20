/**
 * 参数说明「!」标记 无头验证（playwright-core + Edge）
 *  A) perf.html（android）→ 卡片 / 图表标题 / 统计表 / 动态帧率卡 都带「!」，点击弹说明
 *  B) perf.html（ios）   → iOS 模板同样生效（含系统事件图）
 *  C) library.html       → 卡片 KPI / 对比表指标 / 对比图标题带「!」，点击弹说明
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pw = require('playwright-core');

const REPORTS = path.resolve(__dirname, '..', '..', 'collector', 'resources', 'reports');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara-info-'));
for (const f of ['perf.html', 'library.html', 'echarts.min.js']) {
  fs.copyFileSync(path.join(REPORTS, f), path.join(ROOT, f));
}
fs.mkdirSync(path.join(ROOT, 'history'), { recursive: true });
for (const f of fs.readdirSync(path.join(__dirname, 'fixtures_history'))) {
  fs.copyFileSync(path.join(__dirname, 'fixtures_history', f), path.join(ROOT, 'history', f));
}
// 夹具的归档 KPI 只有基础项，这里补齐帧率派生指标，用于验证卡片小字行（达帧率 / 均帧 / 1%Low …）
{
  const idxPath = path.join(ROOT, 'history', 'index.js');
  const raw = fs.readFileSync(idxPath, 'utf8');
  const sandbox = { reportIndex: null };
  new Function('sandbox', raw.replace('var reportIndex', 'sandbox.reportIndex') + '\nreturn sandbox.reportIndex;')(sandbox);
  const extras = (v) => ({ avg: v, min: v, max: v });
  for (const rep of sandbox.reportIndex) {
    Object.assign(rep.kpi, {
      fpsTarget: extras(60), fpsReach: extras(92), fpsFrameTime: extras(17.2),
      fpsLowPct: extras(4), fps1Low: extras(52), fpsGeTarget: extras(88), fpsMedRange: extras(75),
    });
  }
  fs.writeFileSync(idxPath, 'var reportIndex = ' + JSON.stringify(sandbox.reportIndex, null, 2) + ';\n');
}
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

function mkPerf(category) {
  const perf = [];
  for (let i = 0; i < 12; i++) {
    perf.push({
      timestamp: 1700000000000 + i * 1000, time: '12:00:' + String(i).padStart(2, '0'),
      fps: 55 + (i % 5), jank: i % 3, bigJank: 0, smallJank: 1, tinyJank: 2,
      mem: { totalPss: 1000 + i * 2, javaHeap: 10, nativeHeap: 5, code: 1, stack: 1, graphics: 2, privateOther: 1, system: 1 },
      cpu: { sysCpu: 20 + i, procCpu: 10 + i }, cpuCores: { usage: [10, 20], freq: [1000, 1200] },
      net: { rxKBps: 8 + i, txKBps: 3 }, gpu: 30 + i, gpuTemp: 40, temperature: 35 + i % 3,
      battery: { currentNow: 120, power: 500, level: 80, temperature: 34 },
      physFootprint: 400 + i, memResidentSize: 500 + i, cpuUsage: 12 + i,
      threadCount: 40, _diskReadKBps: 12 + i, _diskWriteKBps: 4,
      _ctxSwitchPs: 300 + i, _intWakeupsPs: 100 + i, _vmPageInsPs: 20 + i,
    });
  }
  return { device: { name: 'Pixel 7', category, appName: 'Demo' }, perf, tag: [[0, 5]] };
}

async function main() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'perf.html';
    const p = path.join(ROOT, rel);
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
    if (ok) { pass++; console.log('  PASS ' + name); }
    else { fail++; console.log('  FAIL ' + name, extra === undefined ? '' : JSON.stringify(extra)); }
  };

  // ─────────── A) perf.html android ───────────
  console.log('[A] perf.html · android');
  fs.writeFileSync(path.join(ROOT, 'data.js'), 'var data = ' + JSON.stringify(mkPerf('android'), null, 2) + ';\n');
  const p1 = await browser.newPage();
  const err1 = [];
  p1.on('pageerror', e => err1.push(e.message));
  await p1.goto(`http://127.0.0.1:${port}/perf.html`, { waitUntil: 'load' });
  await p1.waitForTimeout(2600);

  const a = await p1.evaluate(() => {
    const dot = el => (el ? !!el.querySelector('.info-dot') : false);
    const wrapOf = id => { const e = document.getElementById(id); return e && e.closest('.chart-wrap'); };
    return {
      library: typeof window.MetricInfo,
      cardFps: dot(document.getElementById('card-fps') && document.querySelector('#card-fps .card-label')),
      cardCpu: dot(document.querySelector('#card-cpu .card-label')),
      cardMem: dot(document.querySelector('#card-mem .card-label')),
      cardReach: dot(document.querySelector('#card-reach .card-label')),
      titleFps: dot(wrapOf('chart-fps') && wrapOf('chart-fps').querySelector('.chart-title')),
      titleCpu: dot(wrapOf('chart-cpu') && wrapOf('chart-cpu').querySelector('.chart-title')),
      titleCs: dot(wrapOf('chart-cswitch') && wrapOf('chart-cswitch').querySelector('.chart-title')),
      totalDots: document.querySelectorAll('.info-dot').length,
      statRows: Array.from(document.querySelectorAll('#tbl-global tbody tr td:first-child')).map(td => td.textContent.trim()),
      statDots: Array.from(document.querySelectorAll('#tbl-global tbody tr td:first-child')).filter(td => td.querySelector('.info-dot')).map(td => td.textContent.trim()),
      tagDots: Array.from(document.querySelectorAll('#tbl-tags tbody tr td:nth-child(2)')).filter(td => td.querySelector('.info-dot')).length,
      tagRows: document.querySelectorAll('#tbl-tags tbody tr').length,
    };
  });
  check('MetricInfo 已加载', a.library === 'object', a.library);
  check('FPS 卡片带「!」', a.cardFps === true);
  check('CPU 卡片带「!」', a.cardCpu === true);
  check('内存卡片带「!」', a.cardMem === true);
  check('动态卡片 达帧率 带「!」', a.cardReach === true);
  check('FPS 图标题带「!」', a.titleFps === true);
  check('CPU 图标题带「!」（标题被改写后仍在）', a.titleCpu === true);
  check('上下文切换图标题带「!」', a.titleCs === true);
  check('页面「!」总数 >= 30', a.totalDots >= 30, a.totalDots);
  check('统计表指标名带「!」', a.statDots.length >= 8, { rows: a.statRows.length, dots: a.statDots });
  check('子场景统计主指标带「!」', a.tagDots > 0 && a.tagDots <= a.tagRows, { tagRows: a.tagRows, tagDots: a.tagDots });

  // 点击 FPS 卡片的「!」 → 弹窗
  const modal1 = await p1.evaluate(() => {
    const d = document.querySelector('#card-fps .card-label .info-dot');
    d.click();
    const mask = document.querySelector('.mi-mask');
    return {
      visible: !mask.hidden,
      title: mask.querySelector('.mi-title').textContent.trim(),
      rows: Array.from(mask.querySelectorAll('.mi-row > i')).map(i => i.textContent.trim()),
      body: mask.querySelector('.mi-body').textContent.length,
    };
  });
  check('点击卡片「!」弹出说明', modal1.visible === true);
  check('弹窗标题为参数名', /FPS/.test(modal1.title), modal1.title);
  check('弹窗含三段说明', ['是什么', '来源与算法', '怎么看'].every(k => modal1.rows.includes(k)), modal1.rows);
  check('弹窗正文非空', modal1.body > 40, modal1.body);

  // ESC 关闭
  await p1.keyboard.press('Escape');
  const closed = await p1.evaluate(() => document.querySelector('.mi-mask').hidden);
  check('ESC 可关闭弹窗', closed === true);

  // 点击统计表里的「!」
  const modal2 = await p1.evaluate(() => {
    const td = Array.from(document.querySelectorAll('#tbl-global tbody tr td:first-child')).find(x => x.querySelector('.info-dot'));
    td.querySelector('.info-dot').click();
    const mask = document.querySelector('.mi-mask');
    return { visible: !mask.hidden, title: mask.querySelector('.mi-title').textContent.trim(), metric: td.textContent.trim() };
  });
  check('统计表「!」可弹出说明', modal2.visible === true, modal2);

  check('android 页无 JS 报错', err1.length === 0, err1);
  await p1.close();

  // ─────────── B) perf.html ios ───────────
  console.log('[B] perf.html · ios');
  fs.writeFileSync(path.join(ROOT, 'data.js'), 'var data = ' + JSON.stringify(mkPerf('ios'), null, 2) + ';\n');
  const p2 = await browser.newPage();
  const err2 = [];
  p2.on('pageerror', e => err2.push(e.message));
  await p2.goto(`http://127.0.0.1:${port}/perf.html`, { waitUntil: 'load' });
  await p2.waitForTimeout(2600);
  const b = await p2.evaluate(() => {
    const dot = el => (el ? !!el.querySelector('.info-dot') : false);
    const wrapOf = id => { const e = document.getElementById(id); return e && e.closest('.chart-wrap'); };
    return {
      cardThread: dot(document.querySelector('#card-thread .card-label')),
      cardStutter: dot(document.querySelector('#card-stutter .card-label')),
      titleEvents: dot(wrapOf('chart-events') && wrapOf('chart-events').querySelector('.chart-title')),
      titleDisk: dot(wrapOf('chart-disk') && wrapOf('chart-disk').querySelector('.chart-title')),
      totalDots: document.querySelectorAll('.info-dot').length,
    };
  });
  check('iOS 线程数卡片带「!」', b.cardThread === true);
  check('iOS Stutter 卡片带「!」', b.cardStutter === true);
  check('iOS 系统事件图带「!」', b.titleEvents === true);
  check('iOS 磁盘图带「!」', b.titleDisk === true);
  check('iOS 页「!」总数 >= 15', b.totalDots >= 15, b.totalDots);
  check('iOS 页无 JS 报错', err2.length === 0, err2);
  await p2.close();

  // ─────────── D) perf.html ios_gpu ───────────
  console.log('[D] perf.html · ios_gpu');
  {
    const perf = [];
    for (let i = 0; i < 10; i++) {
      perf.push({
        timestamp: 1700000000000 + i * 1000, time: '12:00:' + String(i).padStart(2, '0'),
        'ALU Utilization': 0.5 + i / 100, 'F32 Utilization': 0.4, 'F16 Utilization': 0.3, 'ALU Limiter': 0.2,
        'Vertex Occupancy': 0.6, 'Fragment Occupancy': 0.7, 'Compute Occupancy': 0.1,
        'Texture Sample Utilization': 0.45, 'Texture Filtering Limiter': 0.15,
        'GPU Read Bandwidth': 2000000 + i, 'GPU Write Bandwidth': 1000000 + i,
        'GPU Last Level Cache Utilization': 0.33, 'MMU Utilization': 0.22,
      });
    }
    fs.writeFileSync(path.join(ROOT, 'data.js'),
      'var data = ' + JSON.stringify({ device: { name: 'iPhone 15', category: 'ios_gpu', appName: 'Demo' }, perf, tag: null }, null, 2) + ';\n');
  }
  const p4 = await browser.newPage();
  const err4 = [];
  p4.on('pageerror', e => err4.push(e.message));
  await p4.goto(`http://127.0.0.1:${port}/perf.html`, { waitUntil: 'load' });
  await p4.waitForTimeout(2400);
  const d = await p4.evaluate(() => {
    const dot = el => (el ? !!el.querySelector('.info-dot') : false);
    const wrapOf = id => { const e = document.getElementById(id); return e && e.closest('.chart-wrap'); };
    return {
      cardAlu: dot(document.querySelector('#card-alu .card-label')),
      cardRbw: dot(document.querySelector('#card-rbw .card-label')),
      tOcc: dot(wrapOf('chart-occupancy') && wrapOf('chart-occupancy').querySelector('.chart-title')),
      tBw: dot(wrapOf('chart-bandwidth') && wrapOf('chart-bandwidth').querySelector('.chart-title')),
      total: document.querySelectorAll('.info-dot').length,
    };
  });
  check('iOS GPU ALU 卡片带「!」', d.cardAlu === true);
  check('iOS GPU 读带宽卡片带「!」', d.cardRbw === true);
  check('iOS GPU 占用率图带「!」', d.tOcc === true);
  check('iOS GPU 带宽图带「!」', d.tBw === true);
  check('iOS GPU 页无 JS 报错', err4.length === 0, err4);
  await p4.close();

  // ─────────── C) library.html ───────────
  console.log('[C] library.html · 对比');
  const p3 = await browser.newPage();
  const err3 = [];
  p3.on('pageerror', e => err3.push(e.message));
  await p3.goto(`http://127.0.0.1:${port}/library.html`, { waitUntil: 'load' });
  await p3.waitForTimeout(1500);

  const c1 = await p3.evaluate(() => ({
    kpiLabels: Array.from(document.querySelectorAll('.kpi-label')).map(e => e.textContent.trim()),
    kpiDots: document.querySelectorAll('.kpi-label .info-dot').length,
    extraDots: document.querySelectorAll('.kpis-extra .info-dot').length,
  }));
  check('报告卡片 KPI 带「!」', c1.kpiDots >= 12, { labels: c1.kpiLabels.length, dots: c1.kpiDots });
  check('卡片帧率小字行带「!」', c1.extraDots >= 4, c1.extraDots);

  const nCards = await p3.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('.card-check'));
    for (const bx of boxes.slice(0, 2)) {
      bx.checked = true;
      bx.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return boxes.length;
  });
  if (nCards < 2) { console.log('  FAIL 夹具报告数不足:', nCards); process.exit(1); }
  await p3.click('#btn-compare');
  await p3.waitForTimeout(2500);

  const c2 = await p3.evaluate(() => {
    // 采样数 / 时长 / 设备 是元信息行，不属于性能参数，不需要「!」
    const META = ['采样数', '时长', '设备'];
    const cells = Array.from(document.querySelectorAll('#cmp-body tr td.metric-name'))
      .filter(td => !META.some(k => td.textContent.includes(k)));
    return {
      metricCells: cells.length,
      metricNoDot: cells.filter(td => !td.querySelector('.info-dot')).map(td => td.textContent.trim()),
      chartTitles: Array.from(document.querySelectorAll('.chart-box h3')).map(h => h.textContent.trim().split(' ')[0]),
      chartDots: document.querySelectorAll('.chart-box h3 .info-dot').length,
    };
  });
  check('对比表指标名都带「!」', c2.metricCells > 0 && c2.metricNoDot.length === 0, c2);
  check('对比图标题都带「!」', c2.chartDots === c2.chartTitles.length && c2.chartDots > 0, c2);

  const modal3 = await p3.evaluate(() => {
    const td = document.querySelector('#cmp-body tr td.metric-name .info-dot');
    td.click();
    const mask = document.querySelector('.mi-mask');
    return { visible: !mask.hidden, title: mask.querySelector('.mi-title').textContent.trim() };
  });
  check('对比表「!」可弹出说明', modal3.visible === true, modal3);

  // 卡片上的「!」不应触发勾选
  const notToggle = await p3.evaluate(() => {
    document.querySelector('.mi-close').click();
    const before = document.querySelectorAll('.card.is-selected').length;
    const dot = document.querySelector('.kpi-label .info-dot');
    dot.click();
    const after = document.querySelectorAll('.card.is-selected').length;
    const mask = document.querySelector('.mi-mask');
    return { before, after, modal: !mask.hidden };
  });
  check('点卡片「!」不会误勾选/取消对比', notToggle.before === notToggle.after, notToggle);
  check('点卡片「!」能弹出说明', notToggle.modal === true, notToggle);
  check('library 页无 JS 报错', err3.length === 0, err3);
  await p3.close();

  await browser.close();
  server.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
