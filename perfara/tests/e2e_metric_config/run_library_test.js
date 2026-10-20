/**
 * library.html 无头验证（playwright-core + Edge）：
 *  A（完整）+ B（移除 fps）两份归档报告对比 →
 *   - B 的 fps 单元格显示「—」并带移除原因 title
 *   - fps 曲线只有 A 一条；cpu 曲线两条
 *   - B 卡片显示「已移除参数」
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pw = require('playwright-core');

const REPORTS = path.resolve(__dirname, '..', '..', 'collector', 'resources', 'reports');
// 临时工作目录：library.html + echarts + 归档夹具（history/）
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara-lib-'));
for (const f of ['library.html', 'echarts.min.js']) {
  fs.copyFileSync(path.join(REPORTS, f), path.join(ROOT, f));
}
fs.mkdirSync(path.join(ROOT, 'history'), { recursive: true });
for (const f of fs.readdirSync(path.join(__dirname, 'fixtures_history'))) {
  fs.copyFileSync(path.join(__dirname, 'fixtures_history', f), path.join(ROOT, 'history', f));
}
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

async function main() {
  const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'library.html');
    try {
      const body = fs.readFileSync(p);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      res.end(body);
    } catch (e) { res.writeHead(404); res.end('nf'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const browser = await pw.chromium.launch({ executablePath: EDGE, args: ['--no-sandbox', '--headless=new'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(`http://127.0.0.1:${port}/library.html`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  // 勾选两份报告（一次性 evaluate 内完成，规避网格重渲染导致的句柄失效）
  const n = await page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('.card-check'));
    if (boxes.length < 2) return boxes.length;
    for (const b of boxes.slice(0, 2)) {
      b.checked = true;
      b.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return boxes.length;
  });
  if (n < 2) { console.log('FAIL 卡片数不足:', n); process.exit(1); }
  await page.click('#btn-compare');
  await page.waitForTimeout(2500);

  const r = await page.evaluate(() => {
    const out = {};
    // 表头（列按时间倒序：B=12:05 在前，A=12:00 在后）
    out.heads = Array.from(document.querySelectorAll('#cmp-head th')).map(t => t.textContent.trim().replace(/\s+/g, ' '));
    // 对比表 FPS 行
    const rows = Array.from(document.querySelectorAll('#cmp-body tr'));
    const fpsRow = rows.find(tr => (tr.querySelector('.metric-name') || {}).textContent.includes('FPS'));
    if (fpsRow) {
      const tds = Array.from(fpsRow.querySelectorAll('td')).slice(1);
      out.fpsCells = tds.map(td => ({ text: td.textContent.trim(), title: td.getAttribute('title') || '' }));
    }
    // 已移除参数提示
    out.cardOff = Array.from(document.querySelectorAll('.card-off')).map(e => e.textContent.trim());
    // 图表：标题 + series 数
    out.charts = Array.from(document.querySelectorAll('#cmp-charts .chart-box')).map(box => {
      const t = (box.querySelector('h3') || {}).textContent || '';
      const el = box.querySelector('.chart');
      let series = null;
      try {
        const inst = window.echarts && echarts.getInstanceByDom(el);
        if (inst) series = (inst.getOption().series || []).map(s => ({
          name: s.name, len: (s.data || []).length,
          hasVal: (s.data || []).some(pt => pt && pt[1] != null),
        }));
      } catch (_) {}
      return { title: t.trim(), series };
    });
    return out;
  });

  // 按表头定位列（fpsCells 已去掉表头「指标」列，故索引-1）：B(12:05) 与 A(12:00)
  const colB = r.heads.findIndex(h => h.includes('12:05')) - 1;
  const colA = r.heads.findIndex(h => h.includes('12:00')) - 1;

  let pass = 0, fail = 0;
  const check = (name, ok, extra) => {
    if (ok) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name, extra || ''); }
  };

  check('对比表有 FPS 行', !!r.fpsCells, JSON.stringify(r).slice(0, 300));
  if (r.fpsCells && r.fpsCells.length === 2) {
    check('B(12:05) 的 fps 显示 —', r.fpsCells[colB] && r.fpsCells[colB].text === '—', JSON.stringify(r.fpsCells));
    check('B 的 fps 有移除原因 title', r.fpsCells[colB] && r.fpsCells[colB].title.includes('已移除'), r.fpsCells[colB] && r.fpsCells[colB].title);
    check('A(12:00) 的 fps 有数值', r.fpsCells[colA] && r.fpsCells[colA].text !== '—', JSON.stringify(r.fpsCells));
  }
  check('B 卡片显示已移除参数（友好名）', r.cardOff.some(t => t.includes('已移除参数') && t.includes('FPS 与卡顿')), JSON.stringify(r.cardOff));
  const fpsChart = r.charts.find(c => c.title.includes('FPS'));
  const cpuChart = r.charts.find(c => c.title.includes('CPU'));
  // fps 曲线：B(12:05) 序列无数据、A(12:00) 序列有点（B 不参与绘制）
  check('fps 曲线 B 序列为空', fpsChart && fpsChart.series && fpsChart.series[0] && !fpsChart.series[0].hasVal, JSON.stringify(fpsChart));
  check('fps 曲线 A 序列有数据', fpsChart && fpsChart.series && fpsChart.series[1] && fpsChart.series[1].hasVal, JSON.stringify(fpsChart));
  check('cpu 曲线两条都有数据', cpuChart && cpuChart.series && cpuChart.series.length === 2 && cpuChart.series.every(s => s.hasVal), JSON.stringify(cpuChart));
  check('无 JS 报错', errors.length === 0, errors.join(';'));

  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
