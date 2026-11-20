/**
 * 「导出分享报告」打包验证：
 *  1) 从 main.js 抽出打包相关纯函数（readReportPayload / buildSharedReportHtml / suggestSharedName / safeReportId），
 *     对真机报告执行打包，产出单文件 HTML；
 *  2) 用无头浏览器以 file:// 打开该文件（不启服务器、断网），验证：
 *     - 报告正常渲染（设备名 / 指标卡 / 图表 canvas / 统计表行）
 *     - 没有任何外部资源请求（echarts 与数据均已内联）
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const pw = require('playwright-core');

const PROJ = path.resolve(__dirname, '..', '..', '..');
const REPORTS = path.join(PROJ, 'perfara', 'collector', 'resources', 'reports');
const HISTORY = path.join(REPORTS, 'history');
const MAIN = path.join(PROJ, '_client_src', 'app', 'main.js');
const OUT = process.argv[2] || path.join(os.tmpdir(), 'perfara-shared');
fs.mkdirSync(OUT, { recursive: true });
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '  -> ' + JSON.stringify(detail)));
  cond ? passed++ : failed++;
}

/** 按大括号配对从 main.js 里抠出指定函数源码 */
function extractFn(src, name) {
  const needle = 'function ' + name + '(';
  const i = src.indexOf(needle);
  if (i < 0) throw new Error('未找到函数：' + name);
  let depth = 0, started = false, j = i;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) { j++; break; } }
  }
  return src.slice(i, j);
}

async function main() {
  // ── 选一份真实报告（真机 fixture 优先，否则用 e2e 夹具） ──
  const candidates = [
    { id: null, file: path.join(PROJ, 'perfara', 'tests', 'realdevice', '_real_android.json') },
    { id: null, file: path.join(PROJ, 'perfara', 'tests', 'e2e_metric_config', 'fixtures_history', 'repA.js') },
  ];
  // 目标 history 目录：优先用真实报告库，否则用测试夹具自建
  let historyDir = fs.existsSync(HISTORY) ? HISTORY : path.join(OUT, 'history');
  let reportId = null;
  if (fs.existsSync(HISTORY)) {
    const files = fs.readdirSync(HISTORY).filter(f => /\.js$/.test(f) && f !== 'index.js');
    if (files.length) reportId = files[0].replace(/\.js$/, '');
  }
  if (!reportId) {
    fs.mkdirSync(historyDir, { recursive: true });
    const raw = fs.readFileSync(candidates[1].file, 'utf8');
    fs.writeFileSync(path.join(historyDir, 'repA.js'), raw);
    reportId = 'repA';
  }
  console.log('报告 id =', reportId, ' history =', historyDir);

  // ── 组装打包函数 ──
  const src = fs.readFileSync(MAIN, 'utf8');
  // inlineEcharts 必须在 buildSharedReportHtml 之前抽取：
  // 它是 echarts 内联的实现，被 buildSharedReportHtml / buildSharedCompareHtml 共用。
  // redactSharedPayload 是分享前脱敏设备唯一标识的纯函数，同属这一串调用链。
  const code = ['safeReportId', 'readReportPayload', 'inlineEcharts', 'redactSharedPayload', 'buildSharedReportHtml', 'suggestSharedName']
    .map(n => extractFn(src, n)).join('\n\n');
  const factory = new Function('fs', 'path', 'getHistoryDir', 'getBundledReportsDir',
    code + '\nreturn { safeReportId, readReportPayload, buildSharedReportHtml, suggestSharedName };');
  const api = factory(fs, path, () => historyDir, () => REPORTS);

  const built = api.buildSharedReportHtml(reportId);
  check('打包成功返回 HTML', built.ok === true && typeof built.html === 'string', built.reason || Object.keys(built));
  if (!built.ok) { console.log(`\n结果：${passed} 通过 / ${failed} 失败`); process.exit(1); }

  // P2 脱敏：分享包会被转发给别人，设备唯一标识不能原样带走（机型/应用仍保留）
  const rawId = (built.payload && built.payload.device && built.payload.device.deviceId) || '';
  if (rawId) {
    const mId = /"deviceId":"([^"]*)"/.exec(built.html);
    check('分享包内 deviceId 已脱敏', !!mId && mId[1] === '已脱敏', mId ? mId[1] : '未找到 deviceId');
  } else {
    console.log('  skip 该报告没有 deviceId，跳过脱敏断言');
  }

  const name = api.suggestSharedName(built.payload, reportId);
  const outFile = path.join(OUT, name);
  fs.writeFileSync(outFile, built.html, 'utf8');
  const size = fs.statSync(outFile).size;
  console.log('产出文件：', outFile, Math.round(size / 1024) + ' KB');

  check('文件名含报告标识', /\.html$/.test(name) && name.length > 8, name);
  check('单文件体积 > 800KB（含内联 echarts）', size > 800 * 1024, Math.round(size / 1024) + 'KB');
  check('已内联 echarts（不再外链本地文件）', !/<script\s+src="echarts\.min\.js"/.test(built.html));
  check('echarts 代码确实内联进文件', built.html.length > 1000000 && /echarts/.test(built.html), built.html.length);
  check('已内联数据（含 var data =）', /var data\s*=\s*\{/.test(built.html));
  check('不依赖外部报告文件（无 src=history/）', !/src\s*=\s*['"]history\//.test(built.html));
  check('数据未被截断（可 JSON 解析出 device）', (() => {
    const m = /var data\s*=\s*(\{[\s\S]*?\});\s*\n/.exec(built.html);
    try { const d = JSON.parse(m[1]); return !!(d && d.device && Array.isArray(d.perf)); } catch (_) { return false; }
  })());

  // ── Excel 内联（隔离临时目录，避免污染真实报告库） ──
  const xlsxHis = path.join(OUT, 'history_xlsx');
  fs.rmSync(xlsxHis, { recursive: true, force: true });
  fs.mkdirSync(xlsxHis, { recursive: true });
  const rawReport = fs.readFileSync(path.join(historyDir, reportId + '.js'), 'utf8');
  const fakeXlsx = Buffer.from('PK\u0003\u0004perfara-test-xlsx-payload');
  fs.writeFileSync(path.join(xlsxHis, 'repX.js'), rawReport);
  fs.writeFileSync(path.join(xlsxHis, 'repX.xlsx'), fakeXlsx);
  fs.writeFileSync(path.join(xlsxHis, 'repY.js'), rawReport);   // 模拟改造前的旧报告（无 xlsx）
  const apiX = factory(fs, path, () => xlsxHis, () => REPORTS);

  const bx = apiX.buildSharedReportHtml('repX');
  check('分享包内联 Excel（window.__PERFARA_XLSX__）', bx.ok === true && /window\.__PERFARA_XLSX__\s*=/.test(bx.html));
  check('内联 Excel 文件名与归档 id 对应', /Perfara数据_repX\.xlsx/.test(bx.html));
  check('内联 Excel 字节数与源文件一致', bx.xlsxBytes === fakeXlsx.length, { got: bx.xlsxBytes, want: fakeXlsx.length });
  check('内联 base64 可还原为原字节', (() => {
    const m = /"b64":"([A-Za-z0-9+/=]+)"/.exec(bx.html);
    if (!m) return false;
    return Buffer.from(m[1], 'base64').equals(fakeXlsx);
  })());

  const by = apiX.buildSharedReportHtml('repY');
  // 注意：perf.html 模板本身含 window.__PERFARA_XLSX__ 的读取代码，
  // 因此「未注入」要检测实际数据字段（"b64":"），不能只搜变量名。
  check('旧报告（无 xlsx）不注入下载数据', by.ok === true && !/"b64":"/.test(by.html));
  check('旧报告 xlsxBytes=0', by.xlsxBytes === 0, by.xlsxBytes);

  // ── 接线守卫：导出结果要告诉用户分享包里有没有 Excel；报告库滚动条与另两处一致 ──
  {
    const libHtml = fs.readFileSync(path.join(REPORTS, 'library.html'), 'utf8');
    check('导出 IPC 回传 xlsxBytes', /xlsxBytes:\s*built\.xlsxBytes\s*\|\|\s*0/.test(src));
    check('导出提示区分「已内置」与「未内置」',
      /已内置本次采集的 Excel 数据表/.test(libHtml) && /未内置 Excel 数据表/.test(libHtml));
    check('超大 Excel 不内联（防巨型分享包）', /XLSX_INLINE_MAX/.test(src) && /12 \* 1024 \* 1024/.test(src));
    check('报告库滚动条与报告页/主界面一致',
      /::-webkit-scrollbar \{ width: 8px/.test(libHtml) && /#4a5368/.test(libHtml) && /#67728f/.test(libHtml));
  }

  // ── 离线渲染验证 ──
  const browser = await pw.chromium.launch({ executablePath: EDGE, args: ['--no-sandbox', '--headless=new'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  const external = [];
  const missRes = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('requestfailed', r => missRes.push(r.url()));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    // 单文件报告里也可能带低谷截图引用；截图是可选产物，用户清掉后报告仍要能看，
    // 所以资源 404 单独归类，不算 JS 报错（下面另有一条「除截图外无缺失」的断言）。
    if (/Failed to load resource/.test(m.text())) return;
    errs.push('console: ' + m.text());
  });
  page.on('request', r => { if (!/^file:/.test(r.url())) external.push(r.url()); });
  await page.goto('file:///' + outFile.replace(/\\/g, '/'), { waitUntil: 'load' });
  await page.waitForTimeout(3000);

  const r = await page.evaluate(() => ({
    device: (document.getElementById('device-info-text') || {}).textContent || '',
    title: document.title || '',
    canvases: document.querySelectorAll('canvas').length,
    cards: Array.from(document.querySelectorAll('.card-value')).map(e => e.textContent.trim()).filter(Boolean).length,
    statRows: document.querySelectorAll('#tbl-global tbody tr').length,
    fps: (document.getElementById('val-fps') || {}).textContent || '',
    bodyHasErr: /未找到全局变量 data/.test(document.body.innerText || ''),
  }));
  console.log('  渲染：device=', JSON.stringify(r.device.slice(0, 40)), ' canvas=', r.canvases,
    ' 卡片值=', r.cards, ' 统计行=', r.statRows, ' FPS=', r.fps.trim());
  check('页面正常渲染（未报「未找到全局变量 data」）', r.bodyHasErr === false);
  check('设备名已渲染', r.device.trim().length > 0, r.device);
  check('图表已渲染（canvas ≥ 5）', r.canvases >= 5, r.canvases);
  check('指标卡有数值', r.cards >= 5, r.cards);
  check('统计表有数据行', r.statRows >= 5, r.statRows);
  check('离线无外部资源请求（无依赖）', external.length === 0, external.slice(0, 5));
  check('无 JS 报错', errs.length === 0, errs.slice(0, 3));
  const badRes = missRes.filter(u => !/\/shots\//i.test(u));
  check('无缺失资源（低谷截图除外）', badRes.length === 0, badRes.slice(0, 3));

  await page.screenshot({ path: path.join(OUT, 'shared-report-top.png') });
  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'shared-report-charts.png') });

  // ── 带 Excel 的分享包：顶栏按钮 + 真实点击下载 ──
  const xlsxHtmlFile = path.join(OUT, 'shared-with-xlsx.html');
  fs.writeFileSync(xlsxHtmlFile, bx.html, 'utf8');
  const page2 = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const errs2 = [];
  page2.on('pageerror', e => errs2.push(e.message));
  await page2.goto('file:///' + xlsxHtmlFile.replace(/\\/g, '/'), { waitUntil: 'load' });
  await page2.waitForTimeout(2000);

  const btnText = await page2.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.topbar-right .btn-xlsx'));
    const vis = btns.find(b => b.offsetParent !== null) || btns[0];
    return vis ? vis.textContent.trim() : '';
  });
  check('分享包顶栏出现「↓ Excel」按钮', /Excel/.test(btnText), btnText);

  let dlName = '';
  try {
    const btn = page2.locator('.topbar-right .btn-xlsx:visible').first();
    const [dl] = await Promise.all([
      page2.waitForEvent('download', { timeout: 10000 }),
      btn.click(),
    ]);
    dlName = dl.suggestedFilename();
    await dl.cancel().catch(() => {});
  } catch (e) {
    dlName = 'ERR:' + (e && e.message ? e.message : e);
  }
  check('点击后触发 Excel 下载', dlName === 'Perfara数据_repX.xlsx', dlName);
  check('Excel 分享页无 JS 报错', errs2.length === 0, errs2.slice(0, 3));
  await page2.close();

  await browser.close();

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
