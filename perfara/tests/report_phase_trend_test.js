'use strict';

/**
 * 报告「时段趋势」解读守卫（离线，不需要浏览器）。
 *
 * 背景（2026-11-19 报告解读优化）：
 *   buildInsight 只有整段均值视角，真机报告里 16:41 后 FPS 从 ~38 掉到 ~20、
 *   全程均值仍显示 29.5 —— 后段劣化被均值掩盖，用户看不出「后半段明显变差」。
 *
 * 优化：新增纯函数 iPhaseTrend(fps, dropRatio, minDropFps) 比较前后半均值，
 * 显著劣化（≥20% 且绝对差≥5fps）时，在分项解读和风险提示两处同步点出。
 *
 * 本测试从产品 perf.html 提取真实函数验证（不测副本），并静态守卫两处接线同步。
 * 用法: node perfara/tests/report_phase_trend_test.js
 */
const fs = require('fs');
const path = require('path');

const PERF = path.resolve(__dirname, '..', '..', 'perfara', 'collector', 'resources', 'reports', 'perf.html');
const src = fs.readFileSync(PERF, 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log(' FAIL  ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : '')); }
}

console.log('\n===== 报告时段趋势解读（P-解读优化） =====\n');

// 用大括号配平从源码提取函数（与 fps_curve_continuity_test.js 同法）
function extractFn(source, name) {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) return null;
  let i = source.indexOf('{', start), depth = 0, end = -1;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  return end < 0 ? null : source.slice(start, end);
}

const fnSrc = extractFn(src, 'iPhaseTrend');
const numsSrc = extractFn(src, 'iNums');
check('perf.html 中存在 iPhaseTrend 函数', !!fnSrc);
check('perf.html 中存在 iNums 函数', !!numsSrc);

let iPhaseTrend = null;
if (fnSrc && numsSrc) {
  // eslint-disable-next-line no-new-func
  iPhaseTrend = new Function(numsSrc + '\n' + fnSrc + '\nreturn iPhaseTrend;')();
}

if (iPhaseTrend) {
  // 样本不足 → 不给结论（避免制造趋势）
  check('少于 10 点返回 null', iPhaseTrend([30, 28, 26]) === null);
  check('空数组返回 null', iPhaseTrend([]) === null);
  check('恰好 10 点（每半5点）可判定', iPhaseTrend([40, 40, 40, 40, 40, 20, 20, 20, 20, 20]) !== null);

  // 平稳序列：不判显著
  const flat = iPhaseTrend(Array.from({ length: 40 }, () => 30));
  check('全程平稳不判显著', flat && flat.significant === false, flat);
  check('全程平稳 dropPct≈0', flat && Math.abs(flat.dropPct) < 0.001, flat);

  // 后段劣化：判显著（复刻真机报告形态：前段 ~38，后段 ~20）
  const degraded = iPhaseTrend([...Array(20).fill(38), ...Array(20).fill(20)]);
  check('前38→后20 判显著劣化', degraded && degraded.significant === true, degraded);
  check('前38→后20 dropPct≈47%', degraded && Math.abs(degraded.dropPct - 47.37) < 1, degraded);
  check('前38→后20 dropAbs=18', degraded && Math.abs(degraded.dropAbs - 18) < 0.001, degraded);

  // 后段变好：不报劣化（dropPct 为负）
  const better = iPhaseTrend([...Array(20).fill(20), ...Array(20).fill(38)]);
  check('后段变好不判劣化', better && better.significant === false, better);

  // 小幅下降（<20% 或 <5fps）：不报
  const tiny = iPhaseTrend([...Array(20).fill(30), ...Array(20).fill(28)]);
  check('小幅下降不判显著（绝对差<5）', tiny && tiny.significant === false, tiny);
  const smallPct = iPhaseTrend([...Array(20).fill(30), ...Array(20).fill(26)]);
  check('下降13%但绝对差=4<5 不判显著', smallPct && smallPct.significant === false, smallPct);

  // 自定义阈值
  const custom = iPhaseTrend([...Array(20).fill(30), ...Array(20).fill(27)], 0.05, 2);
  check('自定义阈值(5%,2fps)可判显著', custom && custom.significant === true, custom);

  // null/NaN 被 iNums 过滤，不污染前后半均值
  const withNull = iPhaseTrend([40, null, 40, NaN, 40, 40, 40, 20, null, 20, 20, 20, 20, 20]);
  check('null/NaN 被过滤后仍能判定', withNull && withNull.early > withNull.late, withNull);
}

// ── 接线守卫：分项 + 风险两处都必须用 phase.significant（同步，防自相矛盾）──
const phaseCalc = /const phase = iPhaseTrend\(iNums\(fpsCol\)\);/;
check('buildInsight 计算 phase', phaseCalc.test(src));
check('phase 暴露到 out（out.phaseTrend = phase）', /out\.phaseTrend\s*=\s*phase/.test(src));
const significantUses = (src.match(/phase\s*&&\s*phase\.significant/g) || []).length;
check('分项与风险两处都用 phase.significant 守卫（>=2）', significantUses >= 2, significantUses);
check('分项 push 了「时段趋势」条目', /push\('时段趋势'/.test(src));
check('风险文案点出「全程均值掩盖」', /全程均值掩盖了这次劣化/.test(src));

// ══════════════════════════════════════════════════════════════════════
// 2026-11-20 报告解读再优化：一眼速览 + 四项解读改进
// ══════════════════════════════════════════════════════════════════════
console.log('\n----- 一眼速览 / 解读优化（2026-11-20） -----\n');

// iPhaseTrend 现在带 n（有效样本数），供措辞降级判据使用
if (iPhaseTrend) {
  const dg = iPhaseTrend([...Array(20).fill(38), ...Array(20).fill(20)]);
  check('iPhaseTrend 返回带 n（有效样本数）',
    dg && typeof dg.n === 'number' && dg.n === 40, dg);
}

// ── iBottleneckHint：CPU 低 + 卡顿高 + 无热节流 + 无 GPU 利用率 ──
const bhSrc = extractFn(src, 'iBottleneckHint');
check('perf.html 中存在 iBottleneckHint', !!bhSrc);
let iBottleneckHint = null;
if (bhSrc) iBottleneckHint = new Function(bhSrc + '\nreturn iBottleneckHint;')();
if (iBottleneckHint) {
  // 真机形态：进程 CPU 4.4%、卡顿 71.9%、无热节流、无 GPU 利用率、SF 主因
  const hit = iBottleneckHint(4.4, 71.9, false, false, true);
  check('低CPU+高卡顿→给瓶颈洞察', typeof hit === 'string' && /合成侧/.test(hit), hit);
  check('洞察点出进程CPU具体值', hit && /4\.4%/.test(hit), hit);
  check('洞察点出卡顿占比具体值', hit && /71\.9%/.test(hit), hit);
  check('SF主因时指向 SurfaceFlinger', hit && /SurfaceFlinger/.test(hit), hit);
  // 非 SF 主因 → 指向渲染/合成通用侧
  const hit2 = iBottleneckHint(8, 40, false, false, false);
  check('非SF主因→指向渲染/合成通用侧', hit2 && /渲染 \/ 合成/.test(hit2) && !/SurfaceFlinger/.test(hit2), hit2);
  // 不满足条件 → 不制造结论
  check('CPU 高不给洞察', iBottleneckHint(40, 71.9, false, false, true) === null);
  check('卡顿低不给洞察', iBottleneckHint(4.4, 5, false, false, true) === null);
  check('有热节流不给洞察', iBottleneckHint(4.4, 71.9, true, false, true) === null);
  check('有GPU利用率不给洞察', iBottleneckHint(4.4, 71.9, false, true, true) === null);
  check('缺值不给洞察', iBottleneckHint(null, 71.9, false, false, true) === null);
}

// ── iShortRunExtrap：短采集外推标注 ──
const seSrc = extractFn(src, 'iShortRunExtrap');
check('perf.html 中存在 iShortRunExtrap', !!seSrc);
let iShortRunExtrap = null;
if (seSrc) iShortRunExtrap = new Function(seSrc + '\nreturn iShortRunExtrap;')();
if (iShortRunExtrap) {
  check('33秒短采集→给外推标注', /短采集外推/.test(iShortRunExtrap(33)));
  check('59秒→仍给外推标注', /短采集外推/.test(iShortRunExtrap(59)));
  check('60秒→不给标注', iShortRunExtrap(60) === '');
  check('300秒→不给标注', iShortRunExtrap(300) === '');
  check('null→不给标注', iShortRunExtrap(null) === '');
}

// ── buildGlance：一眼速览生成器（从 buildInsight 输出派生）──
const bgSrc = extractFn(src, 'buildGlance');
const fmtSrc = extractFn(src, 'iFmt');
check('perf.html 中存在 buildGlance', !!bgSrc);
let buildGlance = null;
if (bgSrc && numsSrc && fmtSrc) {
  buildGlance = new Function(numsSrc + '\n' + fmtSrc + '\n' + bgSrc + '\nreturn buildGlance;')();
}
if (buildGlance) {
  const r = {
    n: 41, level: 'warn', levelText: '一般', score: 57,
    fpsMean: 84.6, fpsTarget: 120, reach: 70.5, oneLow: 9,
    jankMean: 0.31, bjPerMin: 3.6, memMean: 167, tempMean: 35.6,
    bottleneckHint: '瓶颈在合成侧', phaseTrend: null, risks: [],
  };
  const g = buildGlance(r);
  check('速览：有数据时返回对象', g && typeof g === 'object');
  check('速览：无数据返回 null', buildGlance(null) === null && buildGlance({ n: 0 }) === null);
  check('速览：定性=levelText', g && g.verdict === '一般');
  check('速览：定性句含指数', g && /57 分/.test(g.sentence));
  check('速览：定性句含有效FPS', g && /84\.6/.test(g.sentence));
  check('速览：stats 含关键指标', g && g.stats.length >= 5, g && g.stats.length);
  check('速览：帧率低达标→warn 上色', g && g.stats.some(s => s.k === '帧率' && s.tone === 'warn'), g && g.stats);
  check('速览：先看这里优先用瓶颈洞察', g && /瓶颈在合成侧/.test(g.next));
  // 优先顺序：无瓶颈洞察时用时段趋势
  const g2 = buildGlance(Object.assign({}, r, { bottleneckHint: null,
    phaseTrend: { significant: true, dropPct: 39, early: 106, late: 65 } }));
  check('速览：次选用时段趋势', g2 && /后段帧率较前段下降 39%/.test(g2.next));
  // 都没有时用第一条风险
  const g3 = buildGlance(Object.assign({}, r, { bottleneckHint: null, phaseTrend: null,
    risks: [{ tone: 'mid', text: '内存增长' }] }));
  check('速览：兜底用首条风险', g3 && g3.next === '内存增长', g3 && g3.next);
  // 全无风险给默认句
  const g4 = buildGlance(Object.assign({}, r, { bottleneckHint: null, phaseTrend: null, risks: [] }));
  check('速览：无风险给默认提示', g4 && /未触发预警/.test(g4.next), g4 && g4.next);
}

// ── 静态接线守卫：一眼速览置顶 + 四项优化接线 ──
{
  const ri = extractFn(src, 'renderInsight') || '';
  const bgAt = ri.indexOf('buildGlance(r)');
  check('renderInsight 调用 buildGlance', bgAt >= 0, { bgAt });
  // 方案 A（2026-11-20）：一眼速览与解读总结合并为唯一头部。
  check('合并：glance label 改为「解读总结」', /glance-label">解读总结/.test(ri));
  check('合并：定性句用 .insight-lead 承载（兼容弱网 UI 测试）',
    /<div class="insight-lead">' \+ leadText/.test(ri));
  check('合并：删掉独立 insight-head 主路径，仅 fallback 保留',
    /\} else \{[\s\S]{0,400}<div class="insight-head"/.test(ri));
  check('合并：双 FPS 口径说明并入 glance leadText', /let leadText = g\.sentence/.test(ri)
    && /leadText \+= ' 此处 FPS 为排除/.test(ri));
  check('合并：采样 sub 信息移入卡内 .glance-sub',
    /<div class="glance-sub">采样信息/.test(ri));
}
check('buildInsight 暴露 bottleneckHint', /out\.bottleneckHint\s*=/.test(src));
check('buildInsight 暴露 fpsMean/fpsTarget/reach 供速览',
  /out\.fpsMean\s*=\s*fpsMean/.test(src) && /out\.reach\s*=/.test(src));
check('降帧条目用了短采集外推标注', /降帧 .*iShortRunExtrap\(durSec\)/.test(src));
check('时段趋势样本偏少措辞降级接线', /phase\.n\s*<\s*60/.test(src));
check('时段趋势风险与分项共用 phWeak 判据', (src.match(/phWeak\s*=/g) || []).length >= 2);
check('双 FPS 均值口径说明接线', /全程均值见统计表「FPS\(全程\)」行/.test(src));
check('新增 CSS .glance 样式', /\.glance\s*\{/.test(src) && /\.glance-focus/.test(src));
check('合并 CSS：.glance-sub 与卡内 .insight-lead 字号覆盖',
  /\.glance-sub\s*\{/.test(src) && /\.glance \.insight-lead\s*\{/.test(src));

// ── 2026-11-20 解读瘦身（A 去重 / B 折叠）接线守卫 ──
console.log('\n----- 解读瘦身 A+B（2026-11-20） -----\n');
// A：lead 不再逐字复述最高风险（tail 有风险时为空串）
check('A: lead 不再复述「最需关注：」+风险原文', /const tail = topRisk \? ''/.test(src));
check('A: 温度分项不再复述「未观察到降频」', /绝对温度仅供参考，未降频见「热节流」条/.test(src));
check('A: GPU 风险去重（仅完全不可读时保留一条）',
  /GPU「利用率需 root \/ 已改用温度」在分项解读里已写明/.test(src)
  && !/out\.risks\.push\(\{ tone: 'info', text: 'GPU 利用率需 root/.test(src));
check('A: 低帧风险不再复述采样点数字', /存在一段低帧时段，可在曲线图上框选/.test(src));
check('A: 弱样本时段风险精简', /有效样本仅 ' \+ phase\.n \+ ' 个，建议复核/.test(src));
// B：方法论折叠，但文案字符串保留（静态守卫可读）
check('B: 方法论写进 r.methodNote 而非拼接进 lead', /out\.methodNote = formula/.test(src));
check('B: renderInsight 用 details 包裹 methodNote',
  /<details class="insight-method"><summary>指数口径与可信度说明<\/summary>/.test(src));
check('B: 折叠区仍含 MOS 声明文案（口径未删）', /指数未经主观体验打分（MOS）标定/.test(src));
check('B: 折叠区仍含权重公式文案', /指数口径：帧率 50% \+ 卡顿 28% \+ 稳定 22%/.test(src));
check('B: 折叠 CSS 存在', /\.insight-method summary/.test(src) && /\.insight-method-body/.test(src));

// ── 2026-11-20 阅读性优化（中高影响 5 项）接线守卫 ──
console.log('\n----- 阅读性优化 1~5（2026-11-20） -----\n');
// 1) FPS 三数字口径就地标注
check('阅读1: 卡片 FPS 单位标「有效」', /setUnit\('card-fps', '帧\/s · 有效'\)/.test(src));
check('阅读1: 图表 FPS 标题标「全程」', /name === 'fps'[\s\S]{0,160}全程/.test(src));
// 2+3) 风险区去重并对齐速览
check('阅读2: 风险1删清单式猜测、指向先看这里',
  /定位方向见顶部「先看这里」，请结合逐帧指标与卡顿归因定位/.test(src));
check('阅读2: BigJank 风险不再复述次数',
  /出现 >125ms 严重卡顿帧/.test(src) && !/次\/分钟）。125ms/.test(src));
// 4) 统计表分层：统计学派生量折叠
check('阅读4: 次级指标并入明细', /SECONDARY = new Set\(\['帧耗时方差', '帧耗时标准差', '帧率标准差'\]\)/.test(src));
check('阅读4: 明细按钮含帧时分布', /内存分项 \/ 各核心 \/ 帧时分布/.test(src));
// 5) 术语就近释义
check('阅读5: 瓶颈术语带括注',
  /SurfaceFlinger \/ 合成侧（系统负责/.test(src) && /渲染 \/ 合成或应用主线程绘制（画面产出/.test(src));
// 可读性回归：解读正文字号达标
check('可读性: glance 内 lead 字号 ≥13px', /\.glance \.insight-lead \{ font-size: 13px/.test(src));

// ── 2026-11-20 滚动条对比度调整：报告页与采集主界面须一致 ──
console.log('\n----- 滚动条样式（报告页 / 采集主界面一致） -----\n');
const CSS_MAIN = fs.readFileSync(path.resolve(__dirname, '..', '..', '_client_src', 'app', 'renderer', 'style.css'), 'utf8');
const sbRules = [
  ['::-webkit-scrollbar { width: 8px; height: 8px; }', '宽度 8px'],
  ['::-webkit-scrollbar-thumb { background: #4a5368; border-radius: 4px; }', '滑块中灰蓝 #4a5368'],
  ['::-webkit-scrollbar-thumb:hover { background: #67728f; }', 'hover 提亮 #67728f'],
];
for (const [rule, label] of sbRules) {
  check('报告页 ' + label, src.includes(rule));
  check('主界面 ' + label, CSS_MAIN.includes(rule));
}
check('两处 track 仍用 --bg2', /::-webkit-scrollbar-track \{ background: var\(--bg2\); \}/.test(src)
  && /::-webkit-scrollbar-track \{ background: var\(--bg2\); \}/.test(CSS_MAIN));

// ── 2026-11-20 Excel 分享入口：报告库直接打开 + 分享包内联下载 ──
console.log('\n----- Excel 分享入口（报告库 / 分享包） -----\n');
const ROOT2 = path.resolve(__dirname, '..', '..');
const MAIN_SRC = fs.readFileSync(path.join(ROOT2, '_client_src', 'app', 'main.js'), 'utf8');
const PRELOAD_LIB = fs.readFileSync(path.join(ROOT2, '_client_src', 'app', 'preload-library.js'), 'utf8');
const LIB_SRC = fs.readFileSync(path.join(ROOT2, 'perfara', 'collector', 'resources', 'reports', 'library.html'), 'utf8');

check('main: 分享包按同 id 内联 Excel', /path\.join\(getHistoryDir\(\), id \+ '\.xlsx'\)/.test(MAIN_SRC)
  && /window\.__PERFARA_XLSX__/.test(MAIN_SRC));
check('main: Excel 读失败不阻断分享包', /内联 Excel 失败/.test(MAIN_SRC));
check('main: 直接打开 Excel 的 IPC', /ipcMain\.handle\('library-open-report-xlsx'/.test(MAIN_SRC)
  && /shell\.openPath\(file\)/.test(MAIN_SRC));
check('main: Excel 存在性查询 IPC', /ipcMain\.handle\('library-xlsx-ids'/.test(MAIN_SRC));
check('preload: 暴露 openReportXlsx / xlsxIds', /openReportXlsx:/.test(PRELOAD_LIB) && /xlsxIds:/.test(PRELOAD_LIB));
check('library: 卡片 Excel 入口按存在性显示', /state\.xlsxIds\.has\(rep\.id\)/.test(LIB_SRC)
  && /class="open-xlsx"/.test(LIB_SRC));
check('library: 浏览器直开时隐藏 Excel 入口', /\.no-location \.card-foot \.open-xlsx/.test(LIB_SRC));
check('perf: 分享包顶栏可下载 Excel', /__PERFARA_XLSX__/.test(src)
  && /btn-xlsx/.test(src) && /URL\.createObjectURL/.test(src));

// ── 2026-11-20 P0/P2：口径一致性、卡片布局、标题可读性 ──
console.log('\n----- 指标卡与图表标题（P0/P2） -----\n');

check('P0 1%Low 判定与显示同精度（两处都按 0.1 取整）',
  (src.match(/oneLow = Math\.round\(oneLow \* 10\) \/ 10;/g) || []).length === 2);
check('P0 BigJank 卡片按次/分判定（与解读同口径）',
  /const perMin = \(durSec && durSec > 0\) \? sum \/ \(durSec \/ 60\) : null;/.test(src)
  && /perMin >= 6 \? 'bad' : \(perMin >= 1 \? 'warn' : 'good'\)/.test(src));
check('P0 BigJank 卡片值显示绝对帧数、单位带速率',
  /setValue\('val-bigjank', String\(sum\)\)/.test(src)
  && /'帧 · ' \+ \(perMin >= 10/.test(src));
check('P0 卡片不再按指标类别上装饰色',
  !/#card-(?:cpu|proccpu|mem|fps|jank|bigjank|net|gpu|battery|temp)\s*\{\s*--card-color/.test(src));
check('P0 颜色说明只承诺「达标程度」', /绿 \/ 橙 \/ 红仅表示达标程度/.test(src));

check('P2 卡片网格列数可配（默认 7 列）',
  /grid-template-columns: repeat\(var\(--card-cols, 7\), minmax\(0, 1fr\)\)/.test(src));
check('P2 列数按宽度与卡片数评分（最后一行不落单）',
  /function layoutMetricCards\(\)/.test(src) && /const waste = c - \(n - \(rows - 1\) \* c\);/.test(src));
check('P2 FPS 派生卡归入 fps 组并插在 Jank 之前',
  /card\.setAttribute\('data-metric', 'fps'\)/.test(src) && /cards\.insertBefore\(card, anchor\)/.test(src));
check('P2 分项按主题排序且温度 / 热节流相邻',
  /'CPU', '内存', '温度', '热节流', 'GPU'/.test(src));
check('P2 图表标题去掉与数值重复的单位',
  src.indexOf('(?:%|MB|KB\\/s|GB\\/s|°C|mA|mW|MHz|次\\/s)') >= 0);
check('P2 图表标题不重复系列名',
  /const listed = sName && baseTxt\.indexOf\(sName\) >= 0;/.test(src));
check('P2 图表标题保留「!」口径入口',
  !/classList\.contains\('chart-title'\)\) continue;/.test(src)
  && /MetricInfo\.decorate\(_w\)/.test(src));
check('P2 0 次降帧不标「短采集外推」',
  /\(q\.drop > 0 \? iShortRunExtrap\(durSec\) : ''\)/.test(src));
check('P2 卡顿分项不再复述成因指向（留给风险区）',
  /单帧超过 125ms，用户可感知为明显卡顿/.test(src));
check('P2 分享包与对比包都脱敏设备 ID',
  /function redactSharedPayload/.test(MAIN_SRC)
  && /JSON\.stringify\(redactSharedPayload\(payload\)\)/.test(MAIN_SRC)
  && /data\[r\.id\] = redactSharedPayload\(p\)/.test(MAIN_SRC)
  && /deviceId: '已脱敏'/.test(MAIN_SRC));

// ── 2026-11-20 数据可读性：命名、口径、精度、分组、折叠 ──
console.log('\n----- 数据可读性（2026-11-20） -----\n');

check('改名：达帧率 → 帧率达成度（显示名）',
  /帧率达成度/.test(src) && !/['"]达帧率['"]/.test(src));
check('改名：FPS≥目标 → 满帧占比（显示名）',
  /满帧占比/.test(src) && !/['"]FPS≥目标['"]/.test(src));
check('MetricInfo 说明同步新名且保留「样本口径」区分',
  /与帧率达成度的区别：这是「样本口径」/.test(src));
check('表格侧有效时长与解读同精度（Math.round 到整数秒）',
  /Math\.max\(1, Math\.round\(durSec \* \(1 - info\.excludedRatio\)\)\)/.test(src));
check('Jank 系列单位改为「帧/拍」', (src.match(/unit:'帧\/拍'/g) || []).length >= 9);
check('折合速率标注「折合」前缀', /const sub = '折合 ' \+ fmtStat\(r\.mean\)/.test(src));
check('卡顿分项标注 timestats、卡顿归因标注 FrameTimeline',
  /帧\/拍（timestats）/.test(src) && /（FrameTimeline 逐帧）/.test(src));
check('单值指标后两列显示「—」', /class="stat-na">—</.test(src));
check('精度按指标语义（statDigits）',
  /function statDigits\(r\)/.test(src)
  && /if \(u === 'MB' \|\| u === 'ms²' \|\| u === 'GB'\) return 0;/.test(src));
check('统计表按窗口宽度分栏（宽屏填满、窄屏单栏）', /function statsColumnCount/.test(src)
  && /\.stats-tables \{ display: flex/.test(src)
  && /flex: 1 1 0/.test(src));
check('分栏允许组内断开并用「（续）」标重复组标题',
  /sec\.cont \? '（续）' : ''/.test(src) && /const cont = t > 0 && units\[t - 1\]\.grp === u\.grp/.test(src));
check('明细展开后同样分栏（不再缩成 720px 窄长条）',
  /class="stats-tables detail-blocks"/.test(src) && /class="stats-detail-bar"/.test(src));
check('主表按分组插标题行', /STAT_GROUP/.test(src) && /class="stats-group"/.test(src));
check('采样 <100 隐藏 P98 列', /o\.sampleN < 100/.test(src)
  && /' no-p98'/.test(src));
check('表下口径脚注', /function renderStatsFootnote/.test(src)
  && /className = 'stats-foot'/.test(src));
check('统计表默认折叠可展开', /function setupStatsCollapse/.test(src) && /btn-stats-toggle/.test(src));
check('顶栏目录跳转', /function setupToc/.test(src) && /btn-toc/.test(src));
check('全 0 / 单点图折叠并提示', /function collapseEmptyCharts/.test(src)
  && /charts-hidden-note/.test(src) && /仅 1 个有效采样点/.test(src));
check('TinyJank 默认不画（避免压塌其他卡顿柱）', /legendOff:\['TinyJank'\]/.test(src));
check('低谷标记改为小圆点（不再用缩略图盖曲线）',
  /symbol: 'circle'/.test(src) && !/symbol: 'image:\/\/'/.test(src));
check('低谷标注带目标与偏离幅度', /'（目标 ' \+ s\.target/.test(src));
check('采集开销 ≥8% 在结论旁提示', /采集开销 ' \+ _pct \+ '%/.test(src));
check('选中统计面板吸顶', /#wrap-stats-selected \{[^}]*position: sticky/.test(src));

console.log('\n===== 结果: ' + pass + ' PASS / ' + fail + ' FAIL =====\n');
process.exitCode = fail ? 1 : 0;
