/**
 * 对比报告「曲线连在一起」回归测试。
 *
 * 背景（用户实机反馈）：对比图里几次运行的曲线糊成一条线，分不出谁是谁。
 * 根因有两个，本测试各覆盖一半：
 *   ① canvas 尺寸 bug：echarts 这份构建没有 ResizeObserver，而对比图是一张张 append 进
 *      grid 的 —— 第一张 init 时还是 grid 里唯一子项，canvas 按整行宽度定死，第二张按两列
 *      宽度定死；等 grid 重排成 3 列后容器缩到 453px，前几张的 canvas 却还是 1434/698px，
 *      多出的部分被右侧图表底色盖住，只剩左边一小条。所有运行都从 x=0 起，于是全挤在
 *      可见的那一小段里，看上去就像连成了一条线（轴上也只能看到 0/10/20 几个刻度）。
 *   ② 叠画语义：即便尺寸正确，时长差得远的几次运行都归一到 x=0 起画，短运行的曲线仍会
 *      挤在左上角和长运行的起点糊在一起。现改为「分段并列泳道」，每次运行独占一段。
 *
 * 断言要点：
 *   - 每张图的 canvas 宽度必须等于容器宽度（修 ①）
 *   - 各系列的 x 区间两两不重叠、段间有间隙（修 ②）
 *   - 单点运行也有可见标记（showSymbol 兜底）
 *   - 轴刻度按段内秒数显示；悬停提示能回答「哪次运行、第几秒」
 *   - 全程无 JS 报错
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
const OUT = process.argv[2] || path.join(os.tmpdir(), 'perfara-cmp-lanes');
fs.mkdirSync(OUT, { recursive: true });
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

// 4 份真实报告，时长差得远：37.4s / 单点 / 14.8s / 8.0s —— 正是会糊在一起的形态
const IDS = [
  '20261020-093156-厂商_generic',
  '20261020-143158-厂商_generic',
  '20261020-145215-厂商_generic',
  '20261020-145531-厂商_generic',
];

let passed = 0, failed = 0;
const FAILED = [];
function check(name, cond, detail) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '  -> ' + JSON.stringify(detail)));
  cond ? passed++ : (failed++, FAILED.push(name));
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

/** 抽取 `const NAME = ...;` 整条语句（感知字符串/模板串，不被字符串里的括号误导） */
function extractConst(src, name) {
  const m = new RegExp('^const ' + name + ' = ', 'm').exec(src);
  if (!m) throw new Error('未找到常量：' + name);
  const start = m.index;
  let i = src.indexOf('=', start) + 1;
  let depth = 0, q = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '\\') { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) break;
  }
  return src.slice(start, i + 1);
}

/** 用产品自身的打包逻辑生成 4 份报告的对比页（与用户导出的报告同构） */
function buildCompare() {
  const src = fs.readFileSync(MAIN, 'utf8');
  const names = ['getBundledReportsDir', 'safeReportId', 'readHistoryIndex', 'readReportPayload',
    'inlineEcharts', 'loadPayloadAny', '_inlineJson', 'buildCompareMeta',
    'buildSharedCompareHtml', 'suggestCompareName'];
  const code = names.map(n => extractFn(src, n)).join('\n\n') +
    '\n\n' + extractConst(src, 'CMP_MAX') + '\n\n' + extractConst(src, 'CMP_BOOT_JS');
  const patched = 'function getHistoryDir() { return ' + JSON.stringify(HISTORY) + '; }\n\n' + code
    .replace(/function getBundledReportsDir\(\)\s*\{[\s\S]*?\n\}/,
      'function getBundledReportsDir() { return ' + JSON.stringify(REPORTS) + '; }')
    .replace(/function readHistoryIndex\(\)\s*\{[\s\S]*?\n\}/,
      'function readHistoryIndex() { return JSON.parse(fs.readFileSync(' +
      JSON.stringify(path.join(HISTORY, 'index.json')) + ', "utf8")); }');
  const factory = new Function('fs', 'path', patched +
    '\nreturn { buildSharedCompareHtml, suggestCompareName };');
  return factory(fs, path).buildSharedCompareHtml(IDS);
}

async function main() {
  const built = buildCompare();
  check('打包成功返回 HTML', built.ok === true && typeof built.html === 'string', built.reason);
  if (!built.ok) { console.log(`\n结果：${passed} 通过 / ${failed} 失败`); process.exit(1); }
  const outFile = path.join(OUT, built.name);
  fs.writeFileSync(outFile, built.html, 'utf8');
  console.log('对比报告：', path.basename(outFile), Math.round(fs.statSync(outFile).size / 1024) + 'KB');

  const browser = await pw.chromium.launch({ executablePath: EDGE, args: ['--no-sandbox', '--headless=new'] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto('file:///' + outFile.replace(/\\/g, '/'), { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  // ─────────── ① canvas 尺寸必须与容器对齐 ───────────
  console.log('[canvas 尺寸]');
  const sizes = await page.evaluate(() =>
    [...document.querySelectorAll('#cmp-charts .chart')].map((el, i) => {
      const cv = el.querySelector('canvas');
      const title = ((el.parentElement.querySelector('h3') || {}).textContent || '').trim();
      return { i, title, container: Math.round(el.getBoundingClientRect().width),
        canvas: cv ? Math.round(cv.getBoundingClientRect().width) : -1 };
    }));
  check('渲染出多张对比图', sizes.length >= 3, sizes.length);
  const bad = sizes.filter(s => s.container !== s.canvas);
  check('每张图 canvas 宽度都等于容器宽度（无超宽被裁切）', bad.length === 0, bad);
  check('没有图退化成 0 宽度', sizes.every(s => s.container > 100 && s.canvas > 100), sizes);

  // ─────────── ② 泳道：x 区间两两不重叠 ───────────
  console.log('[分段泳道]');
  const charts = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('#cmp-charts .chart').forEach((el) => {
      const inst = echarts.getInstanceByDom(el);
      if (!inst) return;
      const title = ((el.parentElement.querySelector('h3') || {}).textContent || '').trim();
      const sers = inst.getOption().series.map(s => {
        const xs = s.data.map(p => p[0]).filter(v => typeof v === 'number' && isFinite(v));
        return { name: s.name, n: s.data.length,
          x0: xs.length ? Math.min.apply(null, xs) : null,
          x1: xs.length ? Math.max.apply(null, xs) : null,
          showSymbol: s.showSymbol };
      });
      out.push({ title, sers, xmax: inst.getOption().xAxis[0].max });
    });
    return out;
  });

  for (const c of charts) {
    const withData = c.sers.filter(s => s.x0 != null);
    // 两两不重叠
    let overlap = null;
    for (let a = 0; a < withData.length; a++) {
      for (let b = a + 1; b < withData.length; b++) {
        const A = withData[a], B = withData[b];
        if (A.x0 <= B.x1 && B.x0 <= A.x1) overlap = [A.name, A.x0, A.x1, B.name, B.x0, B.x1];
      }
    }
    check('[' + c.title + '] 各运行 x 区间两两不重叠', overlap === null, overlap);
    // 段与段之间有间隙（后一段起点严格大于前一段终点）
    const sorted = withData.slice().sort((p, q) => p.x0 - q.x0);
    let gapOk = true, gapDetail = null;
    for (let k = 1; k < sorted.length; k++) {
      if (!(sorted[k].x0 > sorted[k - 1].x1)) { gapOk = false; gapDetail = [sorted[k - 1], sorted[k]]; }
    }
    check('[' + c.title + '] 段与段之间留有间隙（曲线不可能搭上）', gapOk, gapDetail);
    // 每段都从自己的 0 起（第一段起点为 0）
    check('[' + c.title + '] 第一段从 0 起', sorted.length && sorted[0].x0 === 0, sorted[0]);
  }

  // 单点运行（14:31:58 只有 1 个采样点）必须有可见标记，否则图上什么都没有
  console.log('[单点运行兜底]');
  const fps = charts.find(c => /FPS/.test(c.title));
  const single = fps && fps.sers.find(s => /14:31:58/.test(s.name));
  check('单点运行被标了可见符号（showSymbol=true）', !!single && single.showSymbol === true, single);
  check('单点运行仍只保留 1 个数据点', !!single && single.n === 1, single);

  // ─────────── ③ 轴刻度按段内秒数 ───────────
  console.log('[坐标轴]');
  const ticks = await page.evaluate(() => {
    const el = document.querySelector('#cmp-charts .chart');
    const inst = echarts.getInstanceByDom(el);
    const axis = inst.getModel().getComponent('xAxis').axis;
    const raw = axis.scale.getTicks().map(t => t.value);
    const fmt = inst.getOption().xAxis[0].axisLabel.formatter;
    const bands = inst.getOption().series
      .filter(s => s.markArea)
      .flatMap(s => s.markArea.data.map(d => [d[0].xAxis, d[1].xAxis]));
    return { raw, shown: raw.map(v => fmt(v)), bands };
  });
  check('轴 max 覆盖到最长一段的末尾', ticks.raw.length && ticks.raw[ticks.raw.length - 1] > 60,
    ticks.raw[ticks.raw.length - 1]);
  check('刻度文字均为数字或空串（段间空隙留空）',
    ticks.shown.every(s => s === '' || /^\d+$/.test(s)), ticks.shown);
  check('存在多个段的标注区间', Array.isArray(ticks.bands) && ticks.bands.length >= 4, ticks.bands);

  // ─────────── ④ 悬停提示 ───────────
  console.log('[悬停提示]');
  const tip = await page.evaluate(async () => {
    const el = document.querySelector('#cmp-charts .chart');
    const inst = echarts.getInstanceByDom(el);
    // 在第二段（单点运行那段）里取一个点触发提示
    const s2 = inst.getOption().series[2];
    if (!s2 || !s2.data.length) return { ok: false, why: 'series[2] 无数据' };
    inst.dispatchAction({ type: 'showTip', seriesIndex: 2, dataIndex: 0 });
    await new Promise(r => setTimeout(r, 400));
    const nodes = [...document.querySelectorAll('div')].filter(d =>
      /第\s*[\d.]+\s*秒/.test(d.textContent || '') && d.children.length <= 3);
    const txt = nodes.length ? nodes[nodes.length - 1].textContent : '';
    return { ok: true, txt: (txt || '').slice(0, 120) };
  });
  check('悬停提示能标出「哪次运行 · 第几秒」', tip.ok && /第\s*[\d.]+\s*秒/.test(tip.txt || ''), tip);

  // ─────────── ⑤ 整体健康 ───────────
  console.log('[整体健康]');
  check('全程无 JS 报错', errs.length === 0, errs.slice(0, 3));
  const table = await page.evaluate(() => ({
    rows: document.querySelectorAll('#cmp-table tbody tr, #cmp-tbl tbody tr').length,
    legend: (document.getElementById('cmp-legend') || {}).textContent || '',
    canvases: document.querySelectorAll('#cmp-charts canvas').length,
  }));
  check('对比表仍然渲染', table.rows > 0, table.rows);
  check('图例带圈号与时长说明', /\u2460/.test(table.legend) && /每段为一次运行/.test(table.legend),
    table.legend.slice(0, 120));
  check('每张图都有 canvas', table.canvases >= 3, table.canvases);

  await page.screenshot({ path: path.join(OUT, 'cmp-lanes.png'), fullPage: false });
  await browser.close();

  console.log(`\n==== 对比报告泳道测试结果: ${passed} PASS / ${failed} FAIL ====`);
  if (failed) console.log('FAILED: ' + FAILED.join(', '));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
