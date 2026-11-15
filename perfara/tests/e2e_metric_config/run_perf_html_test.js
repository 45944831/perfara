/**
 * perf.html 无头验证（playwright-core + Edge）：
 *  A) android + metricConfig(fps/cpu 移除) → 图表与卡片按配置隐藏，其余正常
 *  B) android 无 metricConfig（旧报告） → 全部显示，行为不回退
 *  C) 全 0 帧 → 帧率质量给提示行，不输出无意义的达帧率
 *  D) FIX-16：low-activity / no-frames 两种空值语义在解读里分开说清
 *  E) ADPF 热节流信号真的渲染（字段未归一化会静默消失）
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pw = require('playwright-core');

const REPORTS = path.resolve(__dirname, '..', '..', 'collector', 'resources', 'reports');
// 用临时目录跑：data.js 会被脚本改写，避免污染真实报告目录
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara-perf-'));
for (const f of ['perf.html', 'echarts.min.js']) {
  fs.copyFileSync(path.join(REPORTS, f), path.join(ROOT, f));
}
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

function mkAndroid(mc) {
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
  const p = { device: { name: 'Pixel 7', model: 'Pixel', category: 'android', deviceId: 'ABC', appName: 'Demo' }, perf, tag: null };
  if (mc) p.metricConfig = mc;
  return p;
}

async function runCase(browser, port, dataJs, label) {
  fs.writeFileSync(path.join(ROOT, 'data.js'), 'var data = ' + JSON.stringify(dataJs, null, 2) + ';\n');
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/perf.html`, { waitUntil: 'load' });
  await page.waitForTimeout(2200);
  const r = await page.evaluate(() => {
    const q = s => document.querySelector(s);
    const vis = el => !!(el && !el.hidden && el.style.display !== 'none');
    return {
      wrapFps: vis(q('#chart-fps') && q('#chart-fps').closest('.chart-wrap')),
      wrapCpu: vis(q('#chart-cpu') && q('#chart-cpu').closest('.chart-wrap')),
      wrapMem: vis(q('#chart-mem') && q('#chart-mem').closest('.chart-wrap')),
      wrapNet: vis(q('#chart-net') && q('#chart-net').closest('.chart-wrap')),
      cardFps: vis(q('#card-fps')), cardCpu: vis(q('#card-cpu')),
      cardMem: vis(q('#card-mem')), cardNet: vis(q('#card-net')),
      valMem: (q('#val-mem') || {}).textContent,
      // FIX-16：两种「帧分布为空」的语义写在解读框里，这里取全文供断言
      insight: (q('#insight-box') || {}).textContent || '',
    };
  });
  await page.close();
  return { r, errors };
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
  const check = (name, ok, extra) => {
    if (ok) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name, extra || ''); }
  };

  console.log('[A] android + metricConfig(fps/cpu 移除)');
  const a = await runCase(browser, port, mkAndroid({ fps: false, cpu: false, mem: true, net: true, gpu: true, temp: true, battery: true }), 'A');
  check('fps 图隐藏', a.r.wrapFps === false, JSON.stringify(a.r));
  check('cpu 图隐藏', a.r.wrapCpu === false);
  check('mem 图可见', a.r.wrapMem === true);
  check('net 图可见', a.r.wrapNet === true);
  check('fps 卡隐藏', a.r.cardFps === false);
  check('cpu 卡隐藏', a.r.cardCpu === false);
  check('mem 卡可见', a.r.cardMem === true);
  check('mem 卡有数值', a.r.valMem && a.r.valMem !== '--');
  check('无 JS 报错', a.errors.length === 0, a.errors.join(';'));

  console.log('[B] android 无 metricConfig（旧报告回归）');
  const b = await runCase(browser, port, mkAndroid(null), 'B');
  check('fps 图可见', b.r.wrapFps === true, JSON.stringify(b.r));
  check('cpu 图可见', b.r.wrapCpu === true);
  check('mem 图可见', b.r.wrapMem === true);
  check('fps 卡可见', b.r.cardFps === true);
  check('cpu 卡可见', b.r.cardCpu === true);
  check('mem 卡有数值', b.r.valMem && b.r.valMem !== '--');
  check('无 JS 报错', b.errors.length === 0, b.errors.join(';'));

  console.log('[C] 全 0 帧（应用在后台/无渲染层）→ 帧率质量给出提示行而非静默消失');
  // 回归背景：目标帧率由帧率分布 P95 推出，全 0 时无解，达帧率/均帧/低帧/1%Low/Drop
  // /FPS≥目标/稳帧范围/标准差 会整族消失，用户只看到「参数丢了很多」。
  const zeroPerf = mkAndroid(null);
  zeroPerf.perf = zeroPerf.perf.map(s => ({ ...s, fps: 0 }));
  fs.writeFileSync(path.join(ROOT, 'data.js'), 'var data = ' + JSON.stringify(zeroPerf, null, 2) + ';\n');
  const zc = await browser.newPage();
  const zErr = [];
  zc.on('pageerror', e => zErr.push(e.message));
  await zc.goto(`http://127.0.0.1:${port}/perf.html`, { waitUntil: 'load' });
  await zc.waitForTimeout(2200);
  const zRows = await zc.evaluate(() => {
    const out = [];
    document.querySelectorAll('table tr').forEach(tr => {
      const t = [...tr.querySelectorAll('td,th')].map(td => td.textContent.trim()).join(' ');
      if (t) out.push(t);
    });
    return out;
  });
  await zc.close();
  const hasNote = zRows.some(r => r.includes('帧率质量') && r.includes('未取到有效帧'));
  const hasReach = zRows.some(r => r.startsWith('达帧率'));
  check('全 0 帧时出现「帧率质量」提示行', hasNote, '行数=' + zRows.length);
  check('全 0 帧时不再输出无意义的达帧率数值', hasReach === false);
  check('全 0 帧时无 JS 报错', zErr.length === 0, zErr.join(';'));

  console.log('[D] FIX-16：low-activity 与 no-frames 两种空值语义要在解读里说清');
  // 回归背景：两种「帧分布为空」此前都只显示裸 `--`，用户分不清「帧太少没统计」
  // 与「本周期没有渲染帧」。round2_fixes_test 自注「由人工验收覆盖」，这里补自动化。
  const mix = mkAndroid(null);
  mix.perf = mix.perf.map((s, i) => {
    if (i < 3) {
      return { ...s, fps: 2, fpsMethod: 'low-activity', ftP50: null,
        jankyRatio: null, hitchMsPerSec: null, overrunP99: null, overrunMax: null };
    }
    if (i < 5) return { ...s, fps: null, fpsMethod: 'no-frames' };
    return { ...s, fps: 60, fpsMethod: 'timestats' };
  });
  const d = await runCase(browser, port, mix, 'D');
  check('解读出现「帧数不足」（不是裸 --）', d.r.insight.includes('帧数不足'),
    d.r.insight.slice(0, 160));
  check('解读出现「无渲染帧」', d.r.insight.includes('无渲染帧'),
    d.r.insight.slice(0, 160));
  check('两种语义分开计数（3 拍 / 2 拍）',
    /3\s*拍帧数不足/.test(d.r.insight) && /2\s*拍无渲染帧/.test(d.r.insight),
    d.r.insight.slice(0, 200));
  check('D 无 JS 报错', d.errors.length === 0, d.errors.join(';'));

  console.log('[E] ADPF 热节流信号要真的渲染出来（字段没进归一化就会静默消失）');
  // 回归背景：buildInsight 的「热节流」条目读 pts 里的 thermalStatus / coolingValue，
  // 但 Android 归一化对象没保留这两个字段 → 采集端写了、报告页永远读不到，
  // 整条解读静默消失。perf_source_audit 只验证了「采集端写入」，覆盖不到这里。
  const th = mkAndroid(null);
  th.perf = th.perf.map((s, i) => (i < 4
    ? { ...s, thermalStatus: 3, coolingValue: 12 }
    : { ...s, thermalStatus: 0, coolingValue: 0 }));
  const e = await runCase(browser, port, th, 'E');
  check('解读出现「热节流」条目', e.r.insight.includes('热节流'), e.r.insight.slice(0, 200));
  check('节流等级与命中拍数正确（峰值 3 级，4/8 拍）',
    /峰值等级\s*3\s*级/.test(e.r.insight) && /4\/8\s*拍节流中/.test(e.r.insight),
    e.r.insight.slice(0, 240));
  check('E 无 JS 报错', e.errors.length === 0, e.errors.join(';'));

  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
