/**
 * 报告「参数重复」治理回归：
 *   A. 单份报告（perf.html）统计表
 *      - 同名指标行不得出现两次（达帧率 / 均帧 / 低帧占比 曾被渲染两遍）
 *      - Jank/10min 四行合并进 Jank 行作副标注（不再独立成行）
 *      - GPU 温度与「温度」同源同值时只留「温度」一行
 *      - 合并后信息不丢：Jank 行仍能看到「次/10min」数值
 *      - 框选区间时派生行仍可用（不丢失随选区变化的达帧率/均帧/低帧占比）
 *   B. 对比报告（library.html）指标表
 *      - 不再出现 Jank/10min 独立行
 *      - Jank 行带「每 10min：…」副标注
 *   C. 两个页面都不得有 JS 报错
 */
'use strict';
const fs = require('fs');
const path = require('path');
const pw = require('playwright-core');

const PROJ = path.resolve(__dirname, '..', '..', '..');
const REPORTS = path.join(PROJ, 'perfara', 'collector', 'resources', 'reports');
const HIST = path.join(REPORTS, 'history');
const OUT = process.argv[2] || path.join(__dirname, '_shots');
fs.mkdirSync(OUT, { recursive: true });
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '  -> ' + JSON.stringify(detail)));
  cond ? passed++ : failed++;
}

function firstReportId() {
  if (fs.existsSync(HIST)) {
    const f = fs.readdirSync(HIST).filter(x => /\.js$/.test(x) && x !== 'index.js');
    if (f.length) return f[0].replace(/\.js$/, '');
  }
  return null;
}

/**
 * 报告库被清空时（清理过期产物 / 全新机器）用夹具顶上。
 * perf.html 只认 history/<id>.js，所以必须真写进 history 目录，
 * 名字带 _fixture_ 前缀，退出时删掉，不污染用户报告库。
 */
function ensureFixtureReport() {
  const src = path.join(__dirname, 'fixtures', 'compare_rep.js');
  if (!fs.existsSync(src)) throw new Error('既没有真实报告也没有测试夹具：' + src);
  const id = '_fixture_compare_rep';
  const dst = path.join(HIST, id + '.js');
  fs.mkdirSync(HIST, { recursive: true });
  fs.copyFileSync(src, dst);
  // 空库时 history/index.js 也不存在，library.html 加载它必然 404、控制台留一条
  // ERR_FILE_NOT_FOUND（真实客户端即使 0 份报告也会写这个文件）。补一份空索引，退出时删掉。
  const idx = path.join(HIST, 'index.js');
  const madeIdx = !fs.existsSync(idx);
  if (madeIdx) fs.writeFileSync(idx, 'var reportIndex = [];\n', 'utf8');
  const cleanup = () => {
    try { fs.unlinkSync(dst); } catch (_) {}
    if (madeIdx) { try { fs.unlinkSync(idx); } catch (_) {} }
  };
  process.on('exit', cleanup);
  return id;
}

async function main() {
  const id = firstReportId() || ensureFixtureReport();
  console.log('报告 id =', id);
  const browser = await pw.chromium.launch({ executablePath: EDGE, args: ['--no-sandbox', '--headless=new'] });

  // ───────── A. 单份报告统计表 ─────────
  console.log('\n[单报告] perf.html 统计表去重');
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errs = [];
  const missRes = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('requestfailed', r => missRes.push(r.url()));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    // 资源 404 单独归类：报告比截图活得久（低谷截图是可选产物，用户清掉 shots/ 之后
    // 报告页仍要能正常看）。这类失败不该判成 JS 报错，但要单独断言「除截图外无缺失」。
    if (/Failed to load resource/.test(m.text())) return;
    errs.push('console: ' + m.text());
  });
  await page.goto('file:///' + path.join(REPORTS, 'perf.html').replace(/\\/g, '/') + '?r=' + encodeURIComponent(id),
    { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  const t = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#tbl-global tbody tr'))
      .filter(tr => !tr.classList.contains('stats-detail-row'));
    return {
      labels: rows.map(tr => (tr.children[0] || {}).textContent || '').map(s => s.replace(/!|\d+(?:\.\d+)?\s*次\/10min/g, '').trim()),
      rawTexts: rows.map(tr => (tr.children[0] || {}).textContent || ''),
      subs: rows.map(tr => {
        const el = tr.querySelector('.metric-sub');
        return el ? el.textContent.trim() : '';
      }).filter(Boolean),
    };
  });
  console.log('  主表行数 =', t.labels.length);
  const dup = {};
  for (const l of t.labels) dup[l] = (dup[l] || 0) + 1;
  const dups = Object.keys(dup).filter(k => dup[k] > 1);
  check('主表无同名重复行', dups.length === 0, dups);
  // 指标名带单位后缀（如「达帧率%」），按前缀计数
  const countOf = (name) => t.labels.filter(l => l.indexOf(name) === 0).length;
  check('达帧率只出现一次', countOf('达帧率') === 1, countOf('达帧率'));
  check('均帧只出现一次', countOf('均帧') === 1, countOf('均帧'));
  check('低帧占比只出现一次', countOf('低帧占比') === 1, countOf('低帧占比'));
  check('Jank/10min 已并入 Jank 行（不再独立成行）',
    !t.labels.some(l => /\/10min/.test(l)), t.labels.filter(l => /10min/.test(l)));
  check('GPU 温度与温度不同时出现（同源时只看温度）',
    !(t.labels.includes('GPU 温度') && t.labels.some(l => l.startsWith('温度'))));
  check('并入的信息没丢（Jank 行带次/10min 副标注）',
    t.subs.length >= 4 && t.subs.some(s => /10min/.test(s)), t.subs);
  check('主表行数已精简（≤ 26 行）', t.labels.length <= 26, t.labels.length);
  await page.screenshot({ path: path.join(OUT, 'perf-table-dedupe.png') });

  // 框选区间的派生行走不同代码分支（chartMgr 在闭包里，playwright 无法直接调用），
  // 这里用源码断言锁住「整段不追加、只有框选才追加」这个去重前提。
  const perfSrc = fs.readFileSync(path.join(REPORTS, 'perf.html'), 'utf8');
  check('派生行只在框选（scope）时追加，整段不再重复',
    /if \(scope && fpsState2/.test(perfSrc) && /整段统计时由 perfFpsQualityRows 提供|整段模式下这里不再追加/.test(perfSrc));
  check('整段 PerfDog 口径行仍在（不随选区）', /if \(!scope\) \{[\s\S]{0,400}perfFpsQualityRows\(/.test(perfSrc));
  check('去重组函数已接线到 buildTableRows', /return dedupeStatRows\(buildTableRowsRaw\(scope\)\);/.test(perfSrc));

  check('单报告页无 JS 报错', errs.length === 0, errs.slice(0, 3));
  const badRes = missRes.filter(u => !/\/shots\//i.test(u));
  check('单报告页无缺失资源（低谷截图除外）', badRes.length === 0, badRes.slice(0, 3));

  // ───────── B. 对比报告指标表 ─────────
  console.log('\n[对比报告] library.html 指标表去重');
  const page2 = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errs2 = [];
  const missRes2 = [];
  page2.on('pageerror', e => errs2.push(e.message));
  page2.on('requestfailed', r => missRes2.push(r.url()));
  page2.on('console', m => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/.test(m.text())) return;   // 同上：资源 404 单独断言
    errs2.push('console: ' + m.text());
  });
  await page2.goto('file:///' + path.join(REPORTS, 'library.html').replace(/\\/g, '/'), { waitUntil: 'load' });
  await page2.waitForTimeout(2000);
  const c = await page2.evaluate(async (fid) => {
    // 报告库被清空时 index.js 里没有条目：用夹具载荷现造一条。
    // kpi 必须带上——对比表的指标行完全由 index 条目的 kpi 决定，缺了只剩「采样数/时长/设备」三行。
    if (!state.reports || !state.reports.length) {
      const p = await loadReportData(fid);
      if (!p) throw new Error('夹具载荷读取失败：' + fid);
      state.reports = [{
        id: fid, platform: 'android', app: '', createdAtLocal: '00:00:00',
        deviceName: (p.device && p.device.name) || '夹具设备',
        samples: (p.perf || []).length, durationSec: p.durationSec, kpi: p.kpi || {},
      }];
    }
    // 内存构造第二份报告（副本），不动磁盘上的真实报告库
    const a = state.reports[0];
    const b = Object.assign({}, a, {
      id: a.id + '-copy', createdAtLocal: '10:00:00',
      deviceName: (a.deviceName || 'd') + '（副本）',
    });
    state.reports = [a, b];
    const pa = await loadReportData(a.id);
    state.cache.set(b.id, JSON.parse(JSON.stringify(pa)));
    state.selected = new Set([a.id, b.id]);
    await runCompare();
    const rows = Array.from(document.querySelectorAll('#cmp-body tr'));
    return {
      count: rows.length,
      names: rows.map(tr => ((tr.querySelector('.metric-name') || {}).textContent || '').replace(/\s+/g, ' ').trim()),
      subs: rows.map(tr => ((tr.querySelector('.cmp-sub') || {}).textContent || '').trim()).filter(Boolean),
    };
  }, id);
  console.log('  对比表行数 =', c.count);
  check('对比表不再出现 Jank/10min 独立行',
    !c.names.some(n => /\/10min/.test(n) && !/^Jank|BigJank|SmallJank|TinyJank/.test(n)) && !c.names.some(n => /Jank\/10min/.test(n)),
    c.names.filter(n => /10min/.test(n)));
  check('对比表 Jank 行带「每 10min」副标注',
    c.subs.length >= 1 && c.subs.every(s => /每 10min/.test(s)), c.subs);
  check('对比表仍有核心指标（FPS / CPU / 内存 / Jank）',
    /FPS/.test(c.names.join('|')) && /CPU/.test(c.names.join('|')) && /Jank/.test(c.names.join('|')), c.names.slice(0, 6));
  check('对比表行数已精简（< 27 行）', c.count < 27, c.count);
  await page2.screenshot({ path: path.join(OUT, 'compare-table-dedupe.png') });
  check('对比页无 JS 报错', errs2.length === 0, errs2.slice(0, 3));
  const badRes2 = missRes2.filter(u => !/\/shots\//i.test(u));
  check('对比页无缺失资源', badRes2.length === 0, badRes2.slice(0, 3));

  await browser.close();
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
