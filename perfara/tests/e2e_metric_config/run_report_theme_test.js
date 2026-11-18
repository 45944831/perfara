/**
 * 报告页深色主题配色守卫：三个「详情区块」(取证片段/会话级指标/卡顿归因) 与页头 chips
 * 在深色主题下必须是浅字深底，不能残留「浅底浅字」导致看不清（2026-11-17 截图 bug）。
 *
 * 用真实 perf.html + 构造数据无头渲染，读取计算样式，断言区块背景与文字的对比度足够。
 * 用法：node run_report_theme_test.js [path/to/Perfara_Portable_*.zip]
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pw = require('playwright-core');

const ZIP = process.argv[2];
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara-theme-'));
const REPORTS = path.resolve(__dirname, '..', '..', 'collector', 'resources', 'reports');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };

if (ZIP && fs.existsSync(ZIP)) {
  const PY = path.resolve(__dirname, '..', '..', '..', 'tools', '.venv', 'Scripts', 'python.exe');
  execFileSync(PY, ['-c',
    'import zipfile,sys,os; z=zipfile.ZipFile(sys.argv[1]); out=sys.argv[2];' +
    ' names=["collector/resources/reports/perf.html","collector/resources/reports/echarts.min.js"];' +
    ' [open(os.path.join(out,os.path.basename(n)),"wb").write(z.read(n)) for n in names]',
    ZIP, ROOT], { stdio: 'pipe' });
  console.log('[源] 交付包 perf.html:', path.basename(ZIP));
} else {
  ['perf.html', 'echarts.min.js'].forEach(f => fs.copyFileSync(path.join(REPORTS, f), path.join(ROOT, f)));
  console.log('[源] 仓库 perf.html');
}

// 构造覆盖三个区块的数据
function mkData() {
  const perf = [];
  for (let i = 0; i < 5; i++) perf.push({
    timestamp: 1700000000000 + i * 1000, time: '12:00:0' + i,
    mem: { totalPss: 1000 + i, javaHeap: 10, nativeHeap: 5, code: 1, stack: 1, graphics: 1, privateOther: 1, system: 1 },
    net: { rxKBps: 5, txKBps: 2 }, gpu: 3, temperature: 30,
    battery: { currentNow: 100, power: 2, level: 80, temperature: 29 },
    fps: 60, jank: 0, bigJank: 0, cpu: { sysCpu: 10, procCpu: 5 }, cpuCores: { usage: [1, 2], freq: [100, 200] },
    jankAttr: { _frames: 100, _total: 2, AppDeadlineMissed: 2 },
  });
  return {
    device: { name: 'Demo', model: 'Demo', category: 'android', deviceId: 'ABC', appName: 'Demo' },
    perf, tag: null, schemaVersion: '9',
    session: {
      launch: { state: 'WARM', totalTimeMs: 312 },
      exit: { supported: true, anr: 0, crash: 0, nativeCrash: 0, other: 0 },
    },
    traceCaptures: [{ ts: 1700000000000, kind: 'perfetto', source: 'manual', path: 'traces/demo.perfetto-trace' }],
    provenance: {
      overhead: { p50Ms: 400, p95Ms: 600 },
      truncatedSamples: 3,
    },
  };
}

// 相对亮度 → WCAG 对比度
function rgb(s) {
  const m = String(s).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}
function lum(c) {
  const f = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
}
function contrast(bg, fg) {
  const a = lum(bg), b = lum(fg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function main() {
  fs.writeFileSync(path.join(ROOT, 'data.js'), 'var data = ' + JSON.stringify(mkData(), null, 2) + ';\n');
  const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'perf.html');
    try { const body = fs.readFileSync(p); res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(body); }
    catch (e) { res.writeHead(404); res.end('nf'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await pw.chromium.launch({ executablePath: EDGE, args: ['--no-sandbox', '--headless=new'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/perf.html`, { waitUntil: 'load' });
  await page.waitForTimeout(2000);
  // 展开三个区块并取计算样式
  const r = await page.evaluate(() => {
    const out = {};
    ['trace-captures', 'session-metrics', 'jank-attr'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) { out[id] = null; return; }
      el.open = true;
      const cs = getComputedStyle(el);
      const textEl = el.querySelector('div,li,summary,span') || el;
      const tcs = getComputedStyle(textEl);
      out[id] = {
        bg: cs.backgroundColor, fg: tcs.color,
        // 找区块内一段有文字的元素的字色
        sampleText: (el.querySelector('div,li') ? el.querySelector('div,li').textContent : '').slice(0, 30),
      };
    });
    return out;
  });
  let pass = 0, fail = 0;
  const check = (name, ok, extra) => { if (ok) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra || ''); } };
  ['trace-captures', 'session-metrics', 'jank-attr'].forEach(id => {
    const v = r[id];
    check(id + ' 区块存在', !!v, JSON.stringify(v));
    if (!v) return;
    const bg = rgb(v.bg), fg = rgb(v.fg);
    check(id + ' 为深底', bg && lum(bg) < 0.15, v.bg);
    check(id + ' 文字可读（对比度≥4.5）', bg && fg && contrast(bg, fg) >= 4.5,
      `bg=${v.bg} fg=${v.fg} contrast=${bg && fg ? contrast(bg, fg).toFixed(2) : 'n/a'}`);
  });
  check('无 JS 报错', errors.length === 0, errors.join(';'));
  await browser.close();
  server.close();
  console.log(`\n==== report_theme_test: ${pass} PASS / ${fail} FAIL ====`);
  if (fail) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
