/**
 * 报告页可读性：量化验证（无视觉依赖）
 *  - 字号 / 颜色对比度（WCAG）
 *  - 布局不溢出、同排卡片等宽、图块高度、表头吸顶
 *  - 无 JS 报错
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pw = require('playwright-core');

const REPORTS = path.resolve(__dirname, '..', '..', 'collector', 'resources', 'reports');
const FIX = path.join(__dirname, 'fixtures_history');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara-read-'));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

const perf = [];
for (let i = 0; i < 90; i++) {
  perf.push({
    timestamp: 1700000000000 + i * 1000, time: '12:00:' + String(i).padStart(2, '0'),
    fps: Math.max(30, 60 - (i % 17) * 2), jank: i % 7, bigJank: i % 23 === 0 ? 1 : 0, smallJank: i % 3, tinyJank: i % 2,
    mem: { totalPss: 900 + i * 1.2, javaHeap: 120 + i, nativeHeap: 200, code: 40, stack: 8, graphics: 150, privateOther: 30, system: 60 },
    cpu: { sysCpu: 30 + (i % 20), procCpu: 15 + (i % 13) },
    cpuCores: { usage: [20, 12, 8, 4], freq: [1800000, 1600000, 1400000, 1200000] },
    net: { rxKBps: 20 + (i % 25), txKBps: 5 + (i % 9) },
    gpu: 40 + (i % 30), gpuTemp: 42, temperature: 36 + (i % 6),
    battery: { currentNow: 130, power: 520, level: 80, temperature: 35 },
  });
}

// WCAG 相对亮度 / 对比度
function lum(rgb) {
  const a = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
function parseRGB(s) {
  const m = /rgba?\(([^)]+)\)/.exec(s || '');
  if (!m) return [0, 0, 0];
  return m[1].split(',').slice(0, 3).map(x => parseFloat(x));
}
function contrast(fg, bg) {
  const l1 = lum(parseRGB(fg)), l2 = lum(parseRGB(bg));
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

async function main() {
  for (const f of ['perf.html', 'library.html', 'echarts.min.js']) fs.copyFileSync(path.join(REPORTS, f), path.join(ROOT, f));
  fs.mkdirSync(path.join(ROOT, 'history'), { recursive: true });
  for (const f of fs.readdirSync(FIX)) fs.copyFileSync(path.join(FIX, f), path.join(ROOT, 'history', f));
  fs.writeFileSync(path.join(ROOT, 'data.js'), 'var data = ' + JSON.stringify({
    device: { name: 'Pixel 8 Pro', model: 'Pixel 8 Pro', category: 'android', appName: 'com.demo.game', deviceId: 'ABC123', osVersion: '14' },
    perf, tag: [[10, 30], [55, 75]],
  }) + ';\n');

  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'perf.html';
    try {
      const body = fs.readFileSync(path.join(ROOT, rel));
      res.writeHead(200, { 'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream' });
      res.end(body);
    } catch (e) { res.writeHead(404); res.end('nf'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await pw.chromium.launch({ executablePath: EDGE, args: ['--no-sandbox', '--headless=new'] });

  let pass = 0, fail = 0;
  const check = (name, ok, extra) => {
    if (ok) { pass++; console.log('  PASS ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
    else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
  };

  // ── perf.html ──
  console.log('[perf.html]');
  const p = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto(`http://127.0.0.1:${port}/perf.html`, { waitUntil: 'load' });
  await p.waitForTimeout(2600);

  const m = await p.evaluate(() => {
    const cs = (sel, prop) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el)[prop] : null;
    };
    const cards = Array.from(document.querySelectorAll('section.cards .card')).filter(c => !c.hidden);
    const rows = new Map();
    for (const c of cards) {
      const top = Math.round(c.getBoundingClientRect().top);
      if (!rows.has(top)) rows.set(top, []);
      rows.get(top).push(Math.round(c.getBoundingClientRect().width));
    }
    const firstRow = Array.from(rows.values())[0] || [];
    const wrappers = Array.from(document.querySelectorAll('.chart-wrap')).filter(w => !w.hidden && !w.classList.contains('stats'));
    return {
      fs: {
        cardLabel: cs('.card-label', 'fontSize'), cardValue: cs('.card-value', 'fontSize'),
        cardUnit: cs('.card-unit', 'fontSize'), chartTitle: cs('.chart-title', 'fontSize'),
        table: cs('.stats-table', 'fontSize'), lead: cs('.insight-lead', 'fontSize'),
        risk: cs('.insight-risk', 'fontSize'), device: cs('.rm-device', 'fontSize'),
      },
      colors: {
        cardLabel: cs('.card-label', 'color'), chartTitle: cs('.chart-title', 'color'),
        bodyBg: cs('body', 'backgroundColor'), wrapBg: cs('.chart-wrap', 'backgroundColor'),
        tableBg: cs('.stats-table', 'backgroundColor'),
      },
      layout: {
        docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        cardRowWidths: firstRow,
        chartHeight: wrappers.length ? Math.round(wrappers[0].getBoundingClientRect().height) : null,
        gridScrollable: (() => { const g = document.querySelector('.charts-grid'); return g ? g.scrollHeight > g.clientHeight : false; })(),
        pageScrollable: document.documentElement.scrollHeight > window.innerHeight + 100,
        cardsDisplay: cs('section.cards', 'display'),
      },
      sticky: (() => { const th = document.querySelector('#tbl-global thead th'); return th ? getComputedStyle(th).position : null; })(),
      rows: Array.from(rows.keys()).length,
    };
  });

  const cCardLabel = contrast(m.colors.cardLabel, m.colors.wrapBg);
  const cTitle = contrast(m.colors.chartTitle, m.colors.wrapBg);
  console.log('    字号：', JSON.stringify(m.fs));
  console.log('    对比度：card-label ' + cCardLabel.toFixed(2) + ':1   chart-title ' + cTitle.toFixed(2) + ':1');
  check('指标卡标签 ≥12px', parseFloat(m.fs.cardLabel) >= 12, m.fs.cardLabel);
  check('指标卡数值 ≥22px', parseFloat(m.fs.cardValue) >= 22, m.fs.cardValue);
  check('卡片单位 ≥11px', parseFloat(m.fs.cardUnit) >= 11, m.fs.cardUnit);
  check('图表标题 ≥12.5px', parseFloat(m.fs.chartTitle) >= 12.5, m.fs.chartTitle);
  check('统计表 ≥12.5px', parseFloat(m.fs.table) >= 12.5, m.fs.table);
  check('解读正文 ≥13px', parseFloat(m.fs.lead) >= 13, m.fs.lead);
  check('设备名 ≥15px', parseFloat(m.fs.device) >= 15, m.fs.device);
  check('卡片标签对比度 ≥4.5:1', cCardLabel >= 4.5, cCardLabel.toFixed(2));
  check('图表标题对比度 ≥7:1', cTitle >= 7, cTitle.toFixed(2));
  check('页面无横向溢出', m.layout.docOverflowX <= 1, m.layout.docOverflowX);
  check('卡片区为网格且同排等宽', m.layout.cardsDisplay === 'grid' && new Set(m.layout.cardRowWidths).size === 1, m.layout.cardRowWidths);
  check('图块高度 ≥240px', (m.layout.chartHeight || 0) >= 240, m.layout.chartHeight);
  check('整页可滚动（body 滚动，非内部容器）', m.layout.pageScrollable === true, m.layout);
  check('统计表表头吸顶', m.sticky === 'sticky', m.sticky);
  check('perf 页无 JS 报错', errs.length === 0, errs);

  // 整页滚动过表头自然位置后：顶栏吸顶，统计表表头应吸在顶栏下方（top:37px）
  const stick = await p.evaluate(async () => {
    const th = document.querySelector('#tbl-global thead th');
    const topbar = document.querySelector('.topbar');
    // 计算表头距文档顶部的绝对偏移
    let off = 0, el = th;
    while (el) { off += el.offsetTop; el = el.offsetParent; }
    window.scrollTo(0, off - 37 + 10); // 滚过吸顶点 10px
    await new Promise(r => setTimeout(r, 250));
    const res = {
      thTop: Math.round(th.getBoundingClientRect().top),
      topbarTop: Math.round(topbar.getBoundingClientRect().top),
      scrolledTo: off - 37 + 10,
    };
    window.scrollTo(0, 0);
    return res;
  });
  check('顶栏吸顶（滚动后 top=0）', stick.topbarTop === 0, stick);
  check('滚动后统计表表头吸在顶栏下方(top≈37)', Math.abs(stick.thTop - 37) <= 2, stick);
  // 不同分辨率下不溢出、卡片不过窄
  for (const w of [1280, 1440, 1920]) {
    const vp = await browser.newPage({ viewport: { width: w, height: 900 } });
    await vp.goto(`http://127.0.0.1:${port}/perf.html`, { waitUntil: 'load' });
    await vp.waitForTimeout(1800);
    const r = await vp.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('section.cards .card')).filter(c => !c.hidden);
      const wmin = Math.min.apply(null, cards.map(c => Math.round(c.getBoundingClientRect().width)));
      return {
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        cardMinWidth: cards.length ? wmin : 0,
        chartCols: (() => { const g = document.querySelector('.charts-grid'); return g ? Math.round(g.getBoundingClientRect().width) : 0; })(),
      };
    });
    check(`${w}px 宽：无横向溢出`, r.overflowX <= 1, r.overflowX);
    check(`${w}px 宽：卡片宽度 ≥90px`, r.cardMinWidth >= 90, r.cardMinWidth);
    await vp.close();
  }
  await p.close();

  // ── library.html ──
  console.log('[library.html]');
  const q = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs2 = [];
  q.on('pageerror', e => errs2.push(e.message));
  await q.goto(`http://127.0.0.1:${port}/library.html`, { waitUntil: 'load' });
  await q.waitForTimeout(1400);
  await q.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('.card-check'));
    for (const b of boxes.slice(0, 2)) { b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await q.click('#btn-compare');
  await q.waitForTimeout(2400);

  const l = await q.evaluate(() => {
    const cs = (sel, prop) => { const el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : null; };
    const best = document.querySelector('#cmp-body td.best');
    return {
      fs: {
        table: cs('#cmp-table', 'fontSize'), kpiLabel: cs('.kpi-label', 'fontSize'),
        kpiValue: cs('.kpi-value', 'fontSize'), h3: cs('.chart-box h3', 'fontSize'),
      },
      colors: { h3: cs('.chart-box h3', 'color'), boxBg: cs('.chart-box', 'backgroundColor'), tdBg: cs('#cmp-body td', 'backgroundColor') },
      bestAfter: best ? getComputedStyle(best, '::after').content : null,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      chartH: (() => { const c = document.querySelector('.chart'); return c ? Math.round(c.getBoundingClientRect().height) : null; })(),
      stickyHead: cs('#cmp-table thead th', 'position'),
    };
  });
  const cH3 = contrast(l.colors.h3, l.colors.boxBg);
  console.log('    字号：', JSON.stringify(l.fs));
  check('对比表 ≥12.5px', parseFloat(l.fs.table) >= 12.5, l.fs.table);
  check('卡片 KPI 标签 ≥11px', parseFloat(l.fs.kpiLabel) >= 11, l.fs.kpiLabel);
  check('卡片 KPI 数值 ≥15px', parseFloat(l.fs.kpiValue) >= 15, l.fs.kpiValue);
  check('曲线标题 ≥13px', parseFloat(l.fs.h3) >= 13, l.fs.h3);
  check('曲线标题对比度 ≥7:1', cH3 >= 7, cH3.toFixed(2));
  check('最佳值带方向标记', /▲/.test(l.bestAfter || ''), l.bestAfter);
  check('曲线图高度 ≥225px', (l.chartH || 0) >= 225, l.chartH);
  check('对比表表头吸顶', l.stickyHead === 'sticky', l.stickyHead);
  check('library 无横向溢出', l.overflowX <= 1, l.overflowX);
  check('library 无 JS 报错', errs2.length === 0, errs2);
  await q.close();

  await browser.close();
  server.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
