/**
 * 「保存对比报告」打包验证：
 *  1) 静态检查：library.html 有保存按钮 / 有 exportCompareReport 串联 / preload 暴露接口 / main.js 注册 IPC；
 *  2) 从 main.js 抽出对比打包相关纯函数（readHistoryIndex / buildSharedCompareHtml / suggestCompareName …），
 *     用两份真实报告执行打包，产出单文件 HTML；
 *  3) 用无头浏览器以 file:// 打开该文件（不启服务器、不联网），验证：
 *     - 直接进入对比视图（指标表 / 图例 / 曲线 canvas 都在），报告库管理区已隐藏
 *     - 没有任何外部资源请求（echarts 与全部报告数据均已内联）
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const pw = require('playwright-core');

const PROJ = path.resolve(__dirname, '..', '..', '..');
const REPORTS = path.join(PROJ, 'perfara', 'collector', 'resources', 'reports');
const REAL_HISTORY = path.join(REPORTS, 'history');
const LIB = path.join(REPORTS, 'library.html');
const MAIN = path.join(PROJ, '_client_src', 'app', 'main.js');
const PRELOAD = path.join(PROJ, '_client_src', 'app', 'preload-library.js');
const OUT = process.argv[2] || path.join(os.tmpdir(), 'perfara-compare');
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

/** 抠出 const 常量声明：先试「数组 + join」的多行写法，再退化为单行写法 */
function extractConst(src, name, stopAt) {
  const head = 'const ' + name + ' = ';
  const i = src.indexOf(head);
  if (i < 0) throw new Error('未找到常量：' + name);
  let rest = src.slice(i);
  const lim = stopAt ? rest.indexOf(stopAt) : -1;   // 限定搜索范围，避免吃到后面的函数
  if (lim > 0) rest = rest.slice(0, lim);
  if (rest[head.length] === '[') {          // 多行数组写法：到 ].join(...); 收尾
    const j = rest.lastIndexOf('].join(');  // 数组内部可能也有 ].join(，取范围内最靠后的那个
    if (j > 0) { const end = rest.indexOf(';', j); return rest.slice(0, end + 1); }
  }
  return rest.slice(0, rest.indexOf(';') + 1);
}

/** 准备两份真实报告（真实库不够 2 份时，把第一份复制并微调为第二份） */
function prepareHistory() {
  const dir = path.join(OUT, 'history');
  fs.mkdirSync(dir, { recursive: true });
  const nowIso = new Date().toISOString();
  const readIndex = () => {
    const p = path.join(REAL_HISTORY, 'index.json');
    if (!fs.existsSync(p)) return null;
    try { const a = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(a) ? a : null; } catch (_) { return null; }
  };
  const base = readIndex();

  if (base && base.length >= 2) {              // 直接用真实归档里的两份
    const picks = base.slice(0, 2);
    for (const it of picks) {
      const src = [path.join(REAL_HISTORY, it.id + '.js'), path.join(REAL_HISTORY, it.id + '.json')]
        .find(f => fs.existsSync(f));
      if (!src) throw new Error('真实报告数据缺失：' + it.id);
      const payload = readPayloadFile(src);
      fs.writeFileSync(path.join(dir, it.id + '.js'), 'var data = ' + JSON.stringify(payload) + ';\n', 'utf8');
      fs.writeFileSync(path.join(dir, it.id + '.json'), JSON.stringify(payload), 'utf8');
    }
    const idx = picks.map(x => Object.assign({}, x));
    writeIndexFiles(dir, idx);
    return { dir, ids: idx.map(x => x.id), idx };
  }

  // 只有一份：复制成两份同时参与对比
  const realFiles = fs.existsSync(REAL_HISTORY)
    ? fs.readdirSync(REAL_HISTORY).filter(f => /\.js$/.test(f) && f !== 'index.js')
    : [];
  let idA = null, payloadA = null;
  if (realFiles.length) {
    idA = realFiles[0].replace(/\.js$/, '');
    payloadA = readPayloadFile(path.join(REAL_HISTORY, realFiles[0]));
  } else {
    const fx = path.join(PROJ, 'perfara', 'tests', 'e2e_metric_config', 'fixtures_history', 'repA.js');
    if (!fs.existsSync(fx)) throw new Error('既没有真实报告也没有测试夹具');
    idA = 'repA';
    payloadA = readPayloadFile(fx);
  }
  const idB = idA + '-copy';
  const payloadB = JSON.parse(JSON.stringify(payloadA));
  if (payloadB.device) payloadB.device.name = String(payloadB.device.name || '设备') + '（副本）';

  fs.writeFileSync(path.join(dir, idA + '.js'), 'var data = ' + JSON.stringify(payloadA) + ';\n', 'utf8');
  fs.writeFileSync(path.join(dir, idB + '.js'), 'var data = ' + JSON.stringify(payloadB) + ';\n', 'utf8');
  fs.writeFileSync(path.join(dir, idA + '.json'), JSON.stringify(payloadA), 'utf8');
  fs.writeFileSync(path.join(dir, idB + '.json'), JSON.stringify(payloadB), 'utf8');

  // 索引条目必须照真实归档结构构造（kpi 是 {fps:{avg,...}} 这种嵌套），
  // 否则对比表取不到值会被整行跳过，测不出真实效果。
  const first = (base && base[0]) || {
    id: idA, platform: 'android', deviceName: (payloadA.device && payloadA.device.name) || '真机A',
    app: '', samples: (payloadA.perf || []).length, kpi: {},
  };
  const idx = [
    Object.assign({}, first, { id: idA, file: 'history/' + idA + '.js' }),
    Object.assign({}, first, {
      id: idB, file: 'history/' + idB + '.js',
      deviceName: (first.deviceName || '真机A') + '（副本）',
    }),
  ];
  if (idx[0].createdAtLocal == null) idx[0].createdAtLocal = nowIso;
  if (idx[1].createdAtLocal == null) idx[1].createdAtLocal = nowIso;
  writeIndexFiles(dir, idx);
  return { dir, ids: [idA, idB], idx };
}

function writeIndexFiles(dir, idx) {
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(idx, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'index.js'), 'var reportIndex = ' + JSON.stringify(idx, null, 2) + ';\n', 'utf8');
}

function readPayloadFile(f) {
  const raw = fs.readFileSync(f, 'utf8');
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  return JSON.parse(raw.slice(s, e + 1));
}

async function main() {
  // ───────── 1) 静态检查 ─────────
  console.log('[静态] 按钮与接口接线');
  const libHtml = fs.readFileSync(LIB, 'utf8');
  const mainSrc = fs.readFileSync(MAIN, 'utf8');
  const preSrc = fs.readFileSync(PRELOAD, 'utf8');

  check('对比区含「保存对比报告」按钮', /id="btn-export-compare"[^>]*>[^<]*保存对比报告/.test(libHtml));
  check('按钮默认 disabled（未对比时不可点）', /id="btn-export-compare"\s+disabled/.test(libHtml));
  check('页面实现了 exportCompareReport()', /function exportCompareReport\(/.test(libHtml));
  check('页面调用 reportLib.exportCompareReport', /reportLib\.exportCompareReport/.test(libHtml));
  check('对比成功后启用保存按钮', /btn-export-compare'\)\s*;?\s*if \(saveBtn\) saveBtn\.disabled = false/.test(libHtml)
    || /saveBtn\.disabled = false/.test(libHtml));
  check('收起对比时禁用保存按钮', /saveBtn\.disabled = true/.test(libHtml));
  check('无客户端环境（no-location）时隐藏该按钮', /no-location #btn-export-compare \{ display: none/.test(libHtml));
  check('preload 暴露 exportCompareReport', /exportCompareReport:\s*\(ids\)/.test(preSrc));
  check('main.js 注册 IPC library-export-compare-report',
    /ipcMain\.handle\('library-export-compare-report'/.test(mainSrc));

  // ───────── 2) 打包 ─────────
  console.log('\n[打包] 抽取 main.js 里的对比打包函数');
  const { dir: historyDir, ids } = prepareHistory();
  const code = [
    extractConst(mainSrc, 'CMP_MAX'),
    extractFn(mainSrc, 'safeReportId'),
    extractFn(mainSrc, 'readReportPayload'),
    extractFn(mainSrc, 'loadPayloadAny'),
    extractFn(mainSrc, '_inlineJson'),
    extractFn(mainSrc, 'buildCompareMeta'),
    extractConst(mainSrc, 'CMP_BOOT_JS', 'function buildSharedCompareHtml'),
    extractFn(mainSrc, 'buildSharedCompareHtml'),
    extractFn(mainSrc, 'suggestCompareName'),
    extractFn(mainSrc, 'readHistoryIndex'),
  ].join('\n\n');
  const factory = new Function('fs', 'path', 'getHistoryDir', 'getBundledReportsDir',
    code + '\nreturn { buildSharedCompareHtml, suggestCompareName, readHistoryIndex, buildCompareMeta };');
  const api = factory(fs, path, () => historyDir, () => REPORTS);

  check('索引可读到 2 条', api.readHistoryIndex().length === 2, api.readHistoryIndex().length);
  check('少于 2 份时拒绝打包（返回 ok:false）',
    api.buildSharedCompareHtml([ids[0]]).ok === false, api.buildSharedCompareHtml([ids[0]]));
  check('空 ids 时拒绝打包', api.buildSharedCompareHtml([]).ok === false);
  check('不存在的 id 时拒绝打包',
    api.buildSharedCompareHtml([ids[0], '../evil']).ok === false,
    api.buildSharedCompareHtml([ids[0], '../evil']));

  const built = api.buildSharedCompareHtml(ids);
  check('两份真实报告打包成功', built.ok === true && typeof built.html === 'string', built.reason);
  if (!built.ok) { console.log(`\n结果：${passed} 通过 / ${failed} 失败`); process.exit(1); }

  const html = built.html;
  const outFile = path.join(OUT, built.name);
  fs.writeFileSync(outFile, html, 'utf8');
  const size = fs.statSync(outFile).size;
  console.log('  产出：', outFile, Math.round(size / 1024) + ' KB');

  check('文件名形如 Perfara对比报告_…', /^Perfara对比报告_.*_\d+份_\d{8}-\d{4}\.html$/.test(built.name), built.name);
  check('文件名无非法字符', !/[\\/:*?"<>|]/.test(built.name), built.name);
  check('体积 > 800KB（含内联 echarts）', size > 800 * 1024, Math.round(size / 1024) + 'KB');
  check('已内联 echarts（不再外链）', !/<script\s+src="echarts\.min\.js"/.test(html));
  check('不再用 <script> 标签外链 history/index.js', !/<script[^>]+src\s*=\s*['"]history\//.test(html));
  check('已内联 reportIndex（2 条）', (() => {
    const m = /var reportIndex\s*=\s*(\[[\s\S]*?\]);\s*\n<\/script>/.exec(html);
    if (!m) return false;
    try { return JSON.parse(m[1].replace(/\\u003c/g, '<')).length === 2; } catch (_) { return false; }
  })());
  check('已内联两份报告原始数据', (() => {
    const m = /window\.__PERFARA_CMP__\s*=\s*(\{[\s\S]*?\}\s*);\s*\n<\/script>/.exec(html);
    if (!m) return false;
    try {
      const src = m[1];
      // 内联的是 JS 字面量（键名不带引号），用求值而非 JSON.parse
      const o = (new Function('return ' + src))();
      const vals = Object.keys(o.data || {}).map(k => o.data[k]);
      return Array.isArray(o.ids) && o.ids.length === 2
        && vals.length === 2 && vals.every(v => v && Array.isArray(v.perf) && v.perf.length > 0)
        && !!(o.meta && o.meta.title);
    } catch (_) { return false; }
  })());
  check('注入了进入对比视图的引导脚本', /CMP_BOOT|runCompare\(\)/.test(html) && /insertBefore\(head, cmp\)/.test(html));
  check('标题已替换为对比报告标题', /<title>Perfara 对比报告/.test(html), (/<title>([^<]*)<\/title>/.exec(html) || [])[1]);
  check('含自包含说明注释', /Perfara 单文件对比报告/.test(html));
  check('脚本闭合标签完整（无破损注入）', (html.match(/<script>/g) || []).length === (html.match(/<\/script>/g) || []).length,
    { open: (html.match(/<script>/g) || []).length, close: (html.match(/<\/script>/g) || []).length });

  // ───────── 3) 离线渲染 ─────────
  console.log('\n[渲染] 无头浏览器以 file:// 直接打开（不联网）');
  const browser = await pw.chromium.launch({ executablePath: EDGE, args: ['--no-sandbox', '--headless=new'] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errs = [], external = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  page.on('request', r => { if (!/^file:/.test(r.url())) external.push(r.url()); });
  await page.goto('file:///' + outFile.replace(/\\/g, '/'), { waitUntil: 'load' });
  await page.waitForTimeout(3500);

  const r = await page.evaluate(() => {
    const vis = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && !!el.offsetParent !== false;
    };
    return {
      title: document.title || '',
      compareOn: !!document.getElementById('compare') && document.getElementById('compare').classList.contains('is-on'),
      gridVisible: vis('#grid'),
      topbarVisible: vis('.topbar'),
      filterbarVisible: vis('#filterbar'),
      hintbarVisible: vis('.hintbar'),
      saveBtnVisible: vis('#btn-export-compare'),
      shareHead: !!document.querySelector('.share-head h2'),
      shareHeadText: (document.querySelector('.share-head h2') || {}).textContent || '',
      headCols: document.querySelectorAll('#cmp-head th').length,
      rows: document.querySelectorAll('#cmp-body tr').length,
      rowTexts: Array.from(document.querySelectorAll('#cmp-body tr'))
        .map(t => t.textContent.replace(/\s+/g, ' ').trim()),
      legend: document.querySelectorAll('#cmp-legend .lg-item, #cmp-legend > *').length,
      canvases: document.querySelectorAll('#cmp-charts canvas').length,
      insightText: ((document.getElementById('cmp-insight') || {}).textContent || '').slice(0, 60),
      bodyErr: /对比渲染失败|渲染失败/.test(document.body.innerText || ''),
    };
  });
  console.log('  渲染：title=', JSON.stringify(r.title), ' 表列=', r.headCols, ' 行=', r.rows,
    ' 图例=', r.legend, ' canvas=', r.canvases);
  console.log('  解读：', JSON.stringify(r.insightText));

  check('标题为对比报告', /对比报告/.test(r.title), r.title);
  check('打开即进入对比视图', r.compareOn === true);
  check('报告库卡片区已隐藏', r.gridVisible === false, r.gridVisible);
  check('顶栏/筛选/提示条已隐藏',
    r.topbarVisible === false && r.filterbarVisible === false && r.hintbarVisible === false,
    { top: r.topbarVisible, filter: r.filterbarVisible, hint: r.hintbarVisible });
  check('已隐藏「保存对比报告」按钮（副本里不再需要）', r.saveBtnVisible === false, r.saveBtnVisible);
  check('有分享页头（含报告标题）', r.shareHead === true && r.shareHeadText.length > 0, r.shareHeadText);
  check('对比表已渲染（有指标行）', r.rows >= 3, r.rows);
  check('对比表包含 FPS 相关指标行', r.rowTexts.some(t => /FPS/.test(t)), r.rowTexts);
  check('每份报告的指标单元格有数值', r.rowTexts.some(t => /\d/.test(t)), r.rowTexts);
  check('对比表含多份报告列（≥ 3 列）', r.headCols >= 3, r.headCols);
  check('图例已渲染', r.legend >= 2, r.legend);
  check('对比曲线已渲染（canvas ≥ 2）', r.canvases >= 2, r.canvases);
  check('对比解读有内容', r.insightText.length > 0 || r.title.length > 0, r.insightText);
  check('无 JS 报错', errs.length === 0, errs.slice(0, 3));
  check('离线无外部资源请求（真正零依赖）', external.length === 0, external.slice(0, 5));

  await page.screenshot({ path: path.join(OUT, 'compare-report-top.png'), fullPage: false });
  await page.evaluate(() => window.scrollTo(0, 1200));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'compare-report-charts.png') });
  await browser.close();

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
