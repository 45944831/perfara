/**
 * 从交付包内解包 perf.html 实测「报告口径版本」顶部提示条：
 *  1) schemaVersion=9（=当前 SCHEMA_VERSION）→ 不应出现「当前为 2」误报；
 *  2) schemaVersion=7（旧报告）→ 应出现跨版本提示（证明提示功能没被误删）；
 *  3) 无 schemaVersion（旧报告）→ 应出现「旧版本生成」提示。
 *
 * 关键：测的是 zip 内的 perf.html（用户实际拿到的文件），不是仓库源码副本。
 * 用法：node run_schema_notice_test.js [path/to/Perfara_Portable_*.zip]
 * 不带参数时回退到仓库源目录报告页（便于开发期快速跑）。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pw = require('playwright-core');

const ZIP = process.argv[2];
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara-schema-notice-'));
const REPORTS = path.resolve(__dirname, '..', '..', 'collector', 'resources', 'reports');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };

// 取 perf.html + echarts.min.js：优先从 zip 解包，回退源目录
if (ZIP && fs.existsSync(ZIP)) {
  const PY = path.resolve(__dirname, '..', '..', '..', 'tools', '.venv', 'Scripts', 'python.exe');
  execFileSync(PY, ['-c',
    'import zipfile,sys,os; z=zipfile.ZipFile(sys.argv[1]); out=sys.argv[2];' +
    ' names=["collector/resources/reports/perf.html","collector/resources/reports/echarts.min.js"];' +
    ' [open(os.path.join(out,os.path.basename(n)),"wb").write(z.read(n)) for n in names]',
    ZIP, ROOT], { stdio: 'pipe' });
  console.log('[源] 交付包内 perf.html:', path.basename(ZIP));
} else {
  ['perf.html', 'echarts.min.js'].forEach(f =>
    fs.copyFileSync(path.join(REPORTS, f), path.join(ROOT, f)));
  console.log('[源] 仓库源目录 perf.html');
}

function mkData(schemaVersion) {
  const perf = [];
  for (let i = 0; i < 5; i++) perf.push({
    timestamp: 1700000000000 + i * 1000, time: '12:00:0' + i,
    mem: { totalPss: 1000 + i, javaHeap: 10, nativeHeap: 5, code: 1, stack: 1, graphics: 1, privateOther: 1, system: 1 },
    net: { rxKBps: 5, txKBps: 2 }, gpu: 3, temperature: 30,
    battery: { currentNow: 100, power: 2, level: 80, temperature: 29 },
    fps: 60, jank: 0, bigJank: 0, cpu: { sysCpu: 10, procCpu: 5 }, cpuCores: { usage: [1, 2], freq: [100, 200] },
  });
  const p = { device: { name: 'Demo', model: 'Demo', category: 'android', deviceId: 'ABC', appName: 'Demo' }, perf, tag: null };
  if (schemaVersion != null) p.schemaVersion = String(schemaVersion);
  return p;
}

async function noticeFor(browser, port, schemaVersion) {
  fs.writeFileSync(path.join(ROOT, 'data.js'), 'var data = ' + JSON.stringify(mkData(schemaVersion), null, 2) + ';\n');
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/perf.html`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => {
    const el = document.getElementById('data-notice');
    return { hasNotice: !!el, text: el ? (el.textContent || '') : '', errors: [] };
  });
  await page.close();
  return { ...r, jsErrors: errors };
}

async function main() {
  const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'perf.html');
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
  const check = (name, ok, extra) => { if (ok) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra || ''); } };

  const cur = await noticeFor(browser, port, 9);
  check('schemaVersion=9 无「当前为 2」误报', !cur.text.includes('当前为 2'), cur.text);
  check('schemaVersion=9 无跨版本警示条', !cur.hasNotice, cur.text);
  check('schemaVersion=9 无 JS 报错', cur.jsErrors.length === 0, cur.jsErrors.join(';'));

  const old = await noticeFor(browser, port, 7);
  check('schemaVersion=7 出现跨版本提示', old.hasNotice && old.text.includes('本报告口径版本为 7'), old.text);

  const legacy = await noticeFor(browser, port, null);
  check('无 schemaVersion 出现旧版本提示', legacy.hasNotice && legacy.text.includes('旧版本生成'), legacy.text);

  await browser.close();
  server.close();
  console.log(`\n==== schema_notice_test: ${pass} PASS / ${fail} FAIL ====`);
  if (fail) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
