'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const loading = require('./fps-loading');
const Schema = require('./metric-schema');

/**
 * 写入 reports/data.js、data.json 时：若有应用显示名且与包名/bundle 不同，则使用「名称(包名或 bundle_id)」；
 * 无显示名或显示名与 id 相同则仅写 id。
 * @param {string} rawId 包名或 bundle_id
 * @param {string} [displayName] 应用名称
 * @returns {string}
 */
function formatReportAppId(rawId, displayName) {
  const id = String(rawId || '').trim();
  const name = String(displayName || '').trim();
  if (!id) return '';
  if (!name || name === id) return id;
  return `${name}(${id})`;
}

/**
 * Path to reports/data.js — development: <project>/reports/data.js;
 * packaged: resources/reports/data.js (same folder as bundled reports extraResource).
 */
function getReportsDataJsPath() {
  const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
  return path.join(base, 'reports', 'data.js');
}

function getReportsDirCandidates() {
  return [
    getReportsDataJsPath(),
    path.join(app.getPath('userData'), 'reports', 'data.js'),
  ];
}

/**
 * 定位第一个可用的 data.js，返回去掉 var 后的纯 JSON 文本与源文件路径。
 * @returns {{ jsonText: string, dataJsPath: string } | null}
 */
function findDataJsPureJson() {
  for (const dataJsPath of getReportsDirCandidates()) {
    try {
      if (!fs.existsSync(dataJsPath)) continue;
      const raw = fs.readFileSync(dataJsPath, 'utf8');
      const i = raw.indexOf('{');
      const j = raw.lastIndexOf('}');
      if (i === -1 || j === -1 || j <= i) continue;
      const jsonText = raw.slice(i, j + 1);
      JSON.parse(jsonText);
      return { jsonText, dataJsPath };
    } catch (_) {}          // 这段文本不是完整 JSON（data.js 里还有别的 {}），继续往后找
  }
  return null;
}

/**
 * Write `var data = <json>;\n` — same structure as android.json / ios.json / iosgpu.json.
 * Prefer resources/reports; if not writable (e.g. Program Files), fall back to userData/reports.
 * 每次写入都会顺带归档一份到 history/，作为本地报告库的一条记录。
 */
function writeDataJs(payload) {
  const prepared = preparePayload(payload);
  // 不缩进：data.js 供报告页 <script> 加载，缩进会让体积膨胀 2~3 倍，
  // 拖慢「写入 + 报告页解析」两头（长时采集可达数十 MB）。人读请用同目录 data.json。
  const content = `var data = ${JSON.stringify(prepared)};\n`;
  const primary = getReportsDataJsPath();
  let written = primary;
  try {
    fs.mkdirSync(path.dirname(primary), { recursive: true });
    fs.writeFileSync(primary, content, 'utf8');
  } catch (err) {
    if (app.isPackaged) {
      const fallback = path.join(app.getPath('userData'), 'reports', 'data.js');
      fs.mkdirSync(path.dirname(fallback), { recursive: true });
      fs.writeFileSync(fallback, content, 'utf8');
      written = fallback;
    } else {
      throw err;
    }
  }
  // 归档失败不能影响主流程（data.js 已经写好）
  try { archiveReport(prepared, written); } catch (_) {}
  return written;
}

/**
 * 给 payload 补口径元数据（schemaVersion / metricDefinitions / provenance）。
 *
 * 这三样是「数据能不能用」的说明书：
 *   - schemaVersion：跨版本对比前先看它，不一致就不该直接比；
 *   - metricDefinitions：每个指标的单位与期望口径，报告页/Excel 共用；
 *   - provenance：本次实际来源、覆盖率、降级项（例如网络回退成整机流量）。
 * 全部由采样点推导，幂等 —— 重复调用不会叠加字段。
 */
function preparePayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const perf = Array.isArray(payload.perf) ? payload.perf : [];
  const dev = payload.device || {};
  const platform = dev.category || payload.category || '';
  const diag = payload.diagnostics || null;
  let provenance;
  try {
    provenance = Schema.buildProvenance(perf, platform, {
      tickMs: diag && diag.tickMs,
      truncated: diag && diag.droppedSamples,
      spilled: diag && diag.segments && diag.segments.spilledPoints,
    });
  } catch (_) {
    provenance = undefined;
  }
  // D-20（2026-11-15 真机）：报告页 `deviceTargetHz()` 读的是 data.loading.targetHz，
  // 但这一段此前只存在于 summarizePerf 的返回值里，data.js 从来没写过 —— 报告侧
  // 「设备自报刷新率优先」整条链静默失效，目标帧率退回 P95 推断（历史 4 份报告全部如此）。
  // 这里只写报告页真正会用的字段，体积可忽略。
  let loadingMeta;
  try {
    const fpsSeries = perf.map(r => (r && typeof r.fps === 'number') ? r.fps : null);
    const hz = payload.displayProfile && Number(payload.displayProfile.refreshRateHz);
    const L = loading.analyseLoading(fpsSeries, undefined, hz);
    loadingMeta = {
      target: L.target,
      targetSource: L.targetSource,
      targetHz: L.targetHz,
      inferredTarget: L.inferredTarget,
      segments: L.segments,
      excludedSamples: L.excludedSamples,
      excludedRatio: _round(L.excludedRatio, 4),
    };
  } catch (err) {
    // 分析失败不能拖垮落盘（data.js 写不出去比少一个字段严重得多）。但也不静默：
    // 把原因写进 loading 段，报告页 deviceTargetHz() 会因 targetHz 缺失退回 P95 吸附
    // —— 与完全没有这段时行为一致，区别只是降级有迹可循，不再重演 D-20 那种无声失效。
    loadingMeta = { targetSource: 'unavailable', error: String((err && err.message) || err) };
  }

  return Object.assign({}, payload, {
    schemaVersion: Schema.SCHEMA_VERSION,
    metricDefinitions: Schema.metricDefinitions(),
    provenance: provenance || undefined,
    loading: loadingMeta || payload.loading,
  });
}

/**
 * 读取已写入的 reports/data.js（与 writeDataJs 路径一致，含 userData 回退）。
 */
function readReportDataJs() {
  const f = findDataJsPureJson();
  if (!f) return null;
  try {
    return JSON.parse(f.jsonText);
  } catch (_) {
    return null;
  }
}

/**
 * 从 reports/data.js 去掉 `var data =` 与末尾分号，得到与 data.json 等价的纯 JSON 文本（用于上传等）。
 */
function readReportPureJsonTextFromDataJs() {
  const f = findDataJsPureJson();
  return f ? f.jsonText : null;
}

/**
 * 上传前：将 data.js 中的纯 JSON 写入同目录 reports/data.json（只含 JSON，无 var）。
 * 若只读目录写入失败（如打包到 Program Files），则写入 userData/reports/data.json。
 * @returns {{ ok: true, jsonText: string, jsonPath: string } | { ok: false, reason: string }}
 */
function writeReportDataJsonFromDataJs() {
  const f = findDataJsPureJson();
  if (!f) {
    return { ok: false, reason: '未找到 reports/data.js 或内容无效' };
  }

  const target = path.join(path.dirname(f.dataJsPath), 'data.json');
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.jsonText, 'utf8');
    return { ok: true, jsonText: f.jsonText, jsonPath: target };
  } catch (err) {
    if (app.isPackaged) {
      const fallback = path.join(app.getPath('userData'), 'reports', 'data.json');
      try {
        fs.mkdirSync(path.dirname(fallback), { recursive: true });
        fs.writeFileSync(fallback, f.jsonText, 'utf8');
        return { ok: true, jsonText: f.jsonText, jsonPath: fallback };
      } catch (e2) {
        return { ok: false, reason: e2.message || String(e2) };
      }
    }
    return { ok: false, reason: err.message || String(err) };
  }
}

// ─── 本地报告库：归档 + 索引 ────────────────────────────────────────────────

const HISTORY_DIRNAME = 'history';
/** 最多保留的报告份数，超出后从最旧的开始删 */
const MAX_HISTORY_REPORTS = 200;

function getReportsRootDir() {
  return path.dirname(getReportsDataJsPath());
}

/**
 * 报告产物实际落盘的根目录 —— data.js / data.json / history/ / shots/ / traces/ 都在这一层。
 *
 * 首选 `resources/reports`：与安装目录同盘，便携包解到 D:/E: 时报告与取证片段都不占 C 盘。
 * 仅当它确实不可写（典型是装进 `C:\Program Files`）才退回 `userData/reports`，
 * 与 writeDataJs 的降级方向保持一致。
 *
 * 结果在进程内缓存：同一次运行里「写 data.js」与「写 trace」必须落在同一处，
 * 否则用户会在两个目录里各看到一半文件，比放错地方更难排查。
 * @returns {string}
 */
let _reportsRootResolved = '';
function resolveReportsRootDir() {
  if (_reportsRootResolved) return _reportsRootResolved;
  const primary = getReportsRootDir();
  let writable = false;
  try {
    fs.mkdirSync(primary, { recursive: true });
    fs.accessSync(primary, fs.constants.W_OK);
    writable = true;
  } catch (_) {
    writable = false;      // 目录建不出来或不可写，走 userData 降级
  }
  _reportsRootResolved = writable
    ? primary
    : path.join(app.getPath('userData'), 'reports');
  return _reportsRootResolved;
}

function getHistoryDir() {
  return path.join(getReportsRootDir(), HISTORY_DIRNAME);
}

function _pad(n) { return String(n).padStart(2, '0'); }

function _nums(arr) { return (arr || []).filter(v => typeof v === 'number' && isFinite(v)); }

function _round(v, d) {
  if (v == null || !isFinite(v)) return null;
  const p = Math.pow(10, d == null ? 1 : d);
  return Math.round(v * p) / p;
}

function _avg(arr) {
  const n = _nums(arr);
  return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null;
}

/**
 * 热路径取值（summarizePerf 每点要取 10 个字段）。
 * _pick 用 rest 参数 + split 解析路径，每个字段都要分配数组与子串；这里改成
 * 直接传候选值，不做任何字符串处理。语义与 _pick 一致：取第一个有限数值。
 */
function _firstNum(a, b, c, d) {
  if (typeof a === 'number' && isFinite(a)) return a;
  if (typeof b === 'number' && isFinite(b)) return b;
  if (typeof c === 'number' && isFinite(c)) return c;
  if (typeof d === 'number' && isFinite(d)) return d;
  return null;
}

/** 多段路径的中间层：只有对象才继续往下取（数字 / null 一律视为不通） */
function _asObj(v) {
  return (v && typeof v === 'object') ? v : null;
}

/** 按 a.b.c 取数，返回第一个存在的有限数值 */
function _pick(obj, ...paths) {
  for (const p of paths) {
    let cur = obj;
    let ok = true;
    for (const k of p.split('.')) {
      if (cur == null || typeof cur !== 'object') { ok = false; break; }
      cur = cur[k];
    }
    if (ok && typeof cur === 'number' && isFinite(cur)) return cur;
  }
  return null;
}

/**
 * KPI key → 采集参数组（与 renderer/metric-settings.js 的组定义一致）。
 * 用户在采集界面移除某组参数后，对应 KPI 不进入索引，对比报告自动隐藏该行。
 */
const KPI_GROUP = {
  fps: 'fps', jank: 'fps', bigJank: 'fps', smallJank: 'fps', tinyJank: 'fps',
  fpsTarget: 'fps', fpsReach: 'fps', fpsFrameTime: 'fps', fpsLowPct: 'fps', fps1Low: 'fps',
  fpsGeTarget: 'fps', fpsMedRange: 'fps', fpsStd: 'fps', fpsStutter: 'fps', fpsDrop: 'fps',
  jank10: 'fps', bigJank10: 'fps', smallJank10: 'fps', tinyJank10: 'fps',
  ftP50: 'fps', ftP90: 'fps', ftP95: 'fps', ftP99: 'fps',
  jankyRatio: 'fps', hitchMsPerSec: 'fps', overrunP99: 'fps',
  cpu: 'cpu', mem: 'mem', temp: 'temp', gpu: 'gpu', gpuTemp: 'gpu',
};

/** 归一化 metricConfig：只认已知组，缺省 true（旧数据无配置时全启用） */
function normalizeMetricConfig(cfg) {
  const out = {};
  for (const k of Object.keys(KPI_GROUP)) {
    const g = KPI_GROUP[k];
    if (!(g in out)) out[g] = true;
  }
  if (cfg && typeof cfg === 'object') {
    for (const g of Object.keys(out)) {
      if (Object.prototype.hasOwnProperty.call(cfg, g)) out[g] = !!cfg[g];
    }
  }
  return out;
}

/**
 * 把一次采集的 perf 数组压成列表/对比用的指标。
 * Android / iOS / PC 三端字段不完全一致，统一走 _pick 的多候选路径
 * （camelCase 为安卓/PC 口径，snake_case 为 iOS py 输出口径）。
 * @param {Array} perf 采样数组
 * @param {Object} [metricConfig] 采集参数配置；被移除组的 KPI 不输出
 */
// 新口径帧指标是「有才写」的序列集合：放模块级，避免每次 summarizePerf 重建
const OPTIONAL_SERIES_SET = new Set(['ftP50', 'ftP90', 'ftP95', 'ftP99',
  'jankyRatio', 'hitchMsPerSec', 'overrunP99']);

function summarizePerf(perf, metricConfig, displayProfile) {
  // 模块级常量（见文件尾部）：构造 Set / 闭包放进每行循环是实测过的纯浪费
  const OPTIONAL_SERIES = OPTIONAL_SERIES_SET;
  const rows = Array.isArray(perf) ? perf : [];
  // 一次循环把 10 条序列 + 时间戳都取出来：原来是对同一份 rows 跑 11 遍 map，
  // 每遍都要 _pick 做 split 解析，长时采集时这部分是纯浪费。
  const series = {
    fps: [], cpu: [], mem: [], temp: [], gpu: [], gpuTemp: [],
    jank: [], bigJank: [], smallJank: [], tinyJank: [],
    // 现代帧指标（批次 1.1）：进索引后，报告库与对比页才能按同一口径横向比较
    ftP50: [], ftP90: [], ftP95: [], ftP99: [],
    jankyRatio: [], hitchMsPerSec: [], overrunP99: [],
  };
  const ts = [];
  // 先探测这批数据到底有没有新口径帧字段（老数据 / PC / iOS 都没有）。
  // 没有就整段跳过，避免每行都付 7 次取值 + 8 次调用的代价 ——
  // 这是实测出来的：逐行判空仍会让 6000 点报告多花 ~4ms。
  let hasFrameStats = false;
  for (const r of rows) {
    if (r && (r.ftP50 != null || r.ftP99 != null || r.hitchMsPerSec != null)) { hasFrameStats = true; break; }
  }
  for (const r of rows) {
    const o = (r && typeof r === 'object') ? r : {};
    // 多段路径（cpu.x / mem.x / fps.fps）要求中间层是对象，与 _pick 语义一致：
    // 中间层若是数字（如 cpu: 12），_pick 会判失败并回退到下一个候选。
    const co = _asObj(o.cpu), mo = _asObj(o.mem), fo = _asObj(o.fps), go = _asObj(o.gpu);
    series.fps.push(_firstNum(o.fps, fo ? fo.fps : undefined));
    series.cpu.push(_firstNum(co ? co.procCpu : undefined, co ? co.cpu : undefined, o.procCpu, o.cpuUsage));
    series.mem.push(_firstNum(mo ? mo.totalPss : undefined, mo ? mo.pss : undefined, mo ? mo.physic : undefined, o.physFootprint));
    series.temp.push(_firstNum(o.temperature, o.temp));
    series.gpu.push(_firstNum(o.gpu, go ? go.utilization : undefined));
    series.gpuTemp.push(_firstNum(o.gpuTemp, o.gpu_temp));
    series.jank.push(_firstNum(o.jank, o.jankRate));
    series.bigJank.push(_firstNum(o.bigJank, o.big_jank, o.bigJankRate));
    series.smallJank.push(_firstNum(o.smallJank, o.small_jank));
    series.tinyJank.push(_firstNum(o.tinyJank, o.tiny_jank));
    // 新口径帧指标只在采样点确实带该字段时才入列：
    // 全量 push null 会让每个报告多出 7 条与样本等长的空数组，白付统计与内存成本。
    if (hasFrameStats) {
      if (o.ftP50 != null) series.ftP50.push(o.ftP50);
      if (o.ftP90 != null) series.ftP90.push(o.ftP90);
      if (o.ftP95 != null) series.ftP95.push(o.ftP95);
      if (o.ftP99 != null) series.ftP99.push(o.ftP99);
      if (o.jankyRatio != null) series.jankyRatio.push(o.jankyRatio);
      if (o.hitchMsPerSec != null) series.hitchMsPerSec.push(o.hitchMsPerSec);
      if (o.overrunP99 != null) series.overrunP99.push(o.overrunP99);
    }
    if (o.timestamp != null) ts.push(o.timestamp);
  }
  // ── 加载阶段剔除 ───────────────────────────────────────────────────────────
  // 冷启动 / 换场景 / 读关卡时 FPS 会连续掉到个位数，这段不代表游戏内表现。
  // 目标帧率必须用「原始序列」推（剔除后 P95 会偏高），识别完再把 FPS 家族
  // 的采样点置 null，后面的 KPI 计算自然跳过。识别规则见 src/fps-loading.js。
  const fpsRawSeries = series.fps.slice();
  const fpsRawAvg = _avg(fpsRawSeries);
  // 1.1 设备自报刷新率优先：displayProfile 由采集端在 start 时读一次
  // （dumpsys display / settings peak_refresh_rate），不随采样点重复下发 adb。
  const deviceHz = displayProfile && Number(displayProfile.refreshRateHz);
  const fpsLoading = loading.analyseLoading(fpsRawSeries, undefined, deviceHz);
  const loadingMask = fpsLoading.mask;
  if (fpsLoading.excludedSamples > 0) {
    for (const k of ['fps', 'jank', 'bigJank', 'smallJank', 'tinyJank']) {
      series[k] = loading.maskToNull(series[k], loadingMask);
    }
  }

  const kpi = {};
  // 新口径帧指标是「有才写」：老数据 / PC / iOS 没有这些字段，
  // 生成一条 avg=null 的 KPI 只会让报告库对比表多出一整行「—」。
  for (const k of Object.keys(series)) {
    if (OPTIONAL_SERIES.has(k) && series[k].length === 0) continue;
    // 单趟求 sum / min / max：原来 _avg 与 _nums 各遍历一遍（共 3 遍），
    // 且 Math.min.apply(null, 大数组) 在点数 >6.5 万时会 RangeError（长时采集风险）
    let sum = 0, cnt = 0, mn = Infinity, mx = -Infinity;
    for (const v of series[k]) {
      if (typeof v !== 'number' || !isFinite(v)) continue;
      sum += v; cnt += 1;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    kpi[k] = {
      avg: cnt ? _round(sum / cnt, 1) : null,
      min: cnt ? _round(mn, 1) : null,
      max: cnt ? _round(mx, 1) : null,
    };
  }

  // FPS 派生指标（与报告页 perf.html perfFpsQualityRows 完全同口径）：
  //   帧率达成度 = 平均 FPS ÷ 目标帧率 × 100（均值口径）
  //   均帧     = 各采样点帧间隔（1000/FPS）的平均，ms
  //   低帧占比 = FPS 低于目标 80% 的采样占比
  //   1%Low    = 帧耗时最长 1% 的均值折算帧率
  //   满帧占比 = 达到目标帧率的采样占比（样本口径，与上面「帧率达成度」不同算法）
  //   稳帧范围 = 偏离中位数 ±20% 内的占比（MedRange）
  //   帧率标准差 / 卡顿时长占比（Stutter）/ Drop（帧/时）
  // 目标帧率由 P95 吸附到常见刷新率（30/45/60/90/120/144/165）。
  const fpsNums = _nums(series.fps);
  // 同样避免 Math.max.apply 展开超长数组（点数多时会 RangeError）
  let tsMin = Infinity, tsMax = -Infinity;
  for (const t of ts) { if (t < tsMin) tsMin = t; if (t > tsMax) tsMax = t; }
  let durSec = ts.length >= 2 ? _round((tsMax - tsMin) / 1000, 1) : null;
  // 剔除加载段后实际参与统计的时长：按剔除比例折算（采样等间隔，比例近似即可），
  // 用于把 Jank / Drop 这类「按时间折算」的指标换算到正确的时间基数上。
  const keptRatio = fpsLoading.totalSamples
    ? (fpsLoading.totalSamples - fpsLoading.excludedSamples) / fpsLoading.totalSamples
    : 1;
  const effDurSec = (durSec != null) ? durSec * keptRatio : null;
  // 目标帧率用原始序列推出来的值（见上方 fpsLoading），不再对剔除后的序列重算
  const target = fpsLoading.target;
  if (fpsNums.length && target > 0) {
    const sorted = fpsNums.slice().sort((a, b) => a - b);
    const avg = _avg(series.fps);
    const moving = fpsNums.filter(v => v > 0);
    const frameTime = moving.length ? _avg(moving.map(v => 1000 / v)) : null;
    const low = fpsNums.filter(v => v < target * 0.8).length;
    kpi.fpsTarget = { avg: target, min: target, max: target };
    kpi.fpsReach = { avg: _round((avg / target) * 100, 1), min: null, max: null };
    kpi.fpsFrameTime = { avg: _round(frameTime, 1), min: null, max: null };
    kpi.fpsLowPct = { avg: _round((low / fpsNums.length) * 100, 1), min: null, max: null };
    // 1%Low
    if (moving.length) {
      const ftList = moving.map(v => 1000 / v).sort((a, b) => b - a);
      const k = Math.max(1, Math.round(ftList.length * 0.01));
      const worstFt = ftList.slice(0, k).reduce((a, b) => a + b, 0) / k;
      kpi.fps1Low = { avg: _round(1000 / worstFt, 1), min: null, max: null };
    }
    // 满帧占比（样本口径）
    const ge = fpsNums.filter(v => v >= target).length;
    kpi.fpsGeTarget = { avg: _round((ge / fpsNums.length) * 100, 1), min: null, max: null };
    // 稳帧范围 MedRange
    const mi = (sorted.length - 1) / 2;
    const median = sorted.length % 2 ? sorted[mi]
      : (sorted[Math.floor(mi)] + sorted[Math.ceil(mi)]) / 2;
    const inMed = fpsNums.filter(v => Math.abs(v - median) <= median * 0.2).length;
    kpi.fpsMedRange = { avg: _round((inMed / fpsNums.length) * 100, 1), min: null, max: null };
    // 帧率标准差
    const variance = fpsNums.reduce((a, v) => a + (v - avg) * (v - avg), 0) / fpsNums.length;
    kpi.fpsStd = { avg: _round(Math.sqrt(variance), 2), min: null, max: null };
    // 卡顿时长占比（Stutter）：帧间隔 > 2×目标帧间隔的时间 ÷ 总时间
    const targetFt = 1000 / target;
    let slow = 0, total = 0;
    for (const v of moving) { const t = 1000 / v; total += t; if (t > targetFt * 2) slow += t; }
    if (total > 0) kpi.fpsStutter = { avg: _round((slow / total) * 100, 1), min: null, max: null };
    // Drop(FPS)：相邻两点下降 > 8 帧的次数，按小时折算（时间基数用剔除后的有效时长）
    const durHour = effDurSec ? effDurSec / 3600 : null;
    let drop = 0;
    for (let i2 = 1; i2 < fpsNums.length; i2++) if (fpsNums[i2 - 1] - fpsNums[i2] > 8) drop++;
    kpi.fpsDrop = { avg: _round(durHour ? drop / durHour : drop, 1), min: null, max: null };
  }

  // Jank / BigJank / SmallJank / TinyJank 每 10 分钟次数（与报告页同口径）
  const durMin = effDurSec ? effDurSec / 60 : null;
  const per10 = (key) => {
    const n = _nums(series[key]);
    if (!n.length) return;
    const sum = n.reduce((a, b) => a + b, 0);
    kpi[key + '10'] = { avg: _round(durMin > 0 ? sum / durMin * 10 : sum, 1), min: null, max: null };
  };
  per10('jank'); per10('bigJank'); per10('smallJank'); per10('tinyJank');

  // 按采集参数过滤：被移除的组不产出 KPI（对比报告据此隐藏整行）
  const mc = normalizeMetricConfig(metricConfig);
  for (const k of Object.keys(kpi)) {
    const g = KPI_GROUP[k];
    if (g && !mc[g]) delete kpi[k];
  }

  return {
    samples: rows.length,
    durationSec: durSec,
    kpi,
    // 加载阶段剔除情况：供对比报告 / 排查用，也是「均值为什么和曲线看起来不一致」的依据
    loading: {
      target: fpsLoading.target,
      targetSource: fpsLoading.targetSource,
      targetHz: fpsLoading.targetHz,
      inferredTarget: fpsLoading.inferredTarget,
      segments: fpsLoading.segments,
      excludedSamples: fpsLoading.excludedSamples,
      excludedRatio: _round(fpsLoading.excludedRatio, 4),
      effectiveDurationSec: (effDurSec != null) ? _round(effDurSec, 1) : null,
      fpsAvgRaw: _round(fpsRawAvg, 1),
      fpsAvg: kpi.fps ? kpi.fps.avg : null,
    },
  };
}

function _sanitize(s) {
  // 只保留 ASCII 字母数字下划线连字符（\w = [A-Za-z0-9_]）。
  // 设备名可能是中文（iOS「某某的 iPhone」/ 中文主机名），若原样进 id，
  // main.js 的 safeReportId 白名单会把它剥成残缺 id，导致报告库的
  // 打开 / 删除 / 导出分享 / Excel 入口全部对不上文件名。
  return String(s || '')
    .replace(/[^\w\-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/** 读取 history/index.json（不存在返回空数组） */
function readReportIndex() {
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(getHistoryDir(), 'index.json'), 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

/** 同时写 index.json 与 index.js（后者供 file:// 页面用 <script> 直接读取，避开 CORS） */
function writeReportIndex(list) {
  const dir = getHistoryDir();
  fs.mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(list, null, 2);
  fs.writeFileSync(path.join(dir, 'index.json'), json, 'utf8');
  fs.writeFileSync(path.join(dir, 'index.js'), `var reportIndex = ${json};\n`, 'utf8');
}

/**
 * 最近一次归档的元信息（报告 id + 所在目录）。
 * 供 Excel 导出用：让 .xlsx 与本次归档的 <id>.js 同名、同目录，提取时一一对应。
 * 模块级单槽即可：writeDataJs 归档后立即同步取走，不会跨采集串味。
 */
let _lastArchive = null;
function getLastArchive() {
  return _lastArchive ? Object.assign({}, _lastArchive) : null;
}

/**
 * 归档一次采集：写 history/<id>.js|json 并刷新索引。
 * 返回元数据；失败返回 null（归档是附加能力，绝不抛出影响采集主流程）。
 */
function archiveReport(payload, dataJsPath) {
  // 先清空：本次归档失败时，Excel 导出应回退到默认命名，而不是误用上一次的 id。
  _lastArchive = null;
  try {
    const perf = payload && payload.perf;
    if (!Array.isArray(perf) || perf.length === 0) return null;

    const dir = path.join(path.dirname(dataJsPath || getReportsDataJsPath()), HISTORY_DIRNAME);
    fs.mkdirSync(dir, { recursive: true });

    const now = new Date();
    const stamp = `${now.getFullYear()}${_pad(now.getMonth() + 1)}${_pad(now.getDate())}-` +
                  `${_pad(now.getHours())}${_pad(now.getMinutes())}${_pad(now.getSeconds())}`;
    const dev = (payload && payload.device) || {};
    const suffix = _sanitize(dev.name || dev.model || dev.bundleId || dev.appName);
    let id = suffix ? `${stamp}-${suffix}` : stamp;
    // 同一秒内多次归档：加序号，避免互相覆盖
    let n = 2;
    const base = id;
    while (fs.existsSync(path.join(dir, `${id}.js`))) id = `${base}_${n++}`;

    // 不缩进（见 writeDataJs 注释）。只落一份 .js：报告页与报告库都直接
    // `<script src="history/<id>.js">` 加载，`.json` 副本内容完全一致，
    // 存两份等于把归档目录体积翻倍（每次采集 ~90 KB）。
    // 老版本已生成的 .json 仍保留可读（main.js 的读取逻辑有 .json 兜底）。
    const json = JSON.stringify(payload);
    fs.writeFileSync(path.join(dir, `${id}.js`), `var data = ${json};\n`, 'utf8');

    const sum = summarizePerf(perf, payload.metricConfig, payload.displayProfile);
    const meta = {
      id,
      file: `${HISTORY_DIRNAME}/${id}.js`,
      createdAt: now.toISOString(),
      createdAtLocal: `${now.getFullYear()}-${_pad(now.getMonth() + 1)}-${_pad(now.getDate())} ` +
                      `${_pad(now.getHours())}:${_pad(now.getMinutes())}:${_pad(now.getSeconds())}`,
      platform: dev.category || payload.category || '',
      deviceName: dev.name || dev.model || '',
      deviceId: dev.deviceId || dev.udid || '',
      app: dev.appName || dev.bundleId || '',
      samples: sum.samples,
      durationSec: sum.durationSec,
      kpi: sum.kpi,
      // 本次采集的参数配置（勾选项）；对比报告据此逐列隐藏被移除的指标
      metricConfig: payload.metricConfig || null,
      // 本次采集保存的参数展示顺序；对比报告据此重排指标行与曲线
      metricOrder: payload.metricOrder || null,
      // 口径版本与降级项：报告库列表与对比页据此判断「能不能直接比」
      schemaVersion: payload.schemaVersion || Schema.SCHEMA_VERSION,
      degraded: payload.provenance && Array.isArray(payload.provenance.degraded)
        ? payload.provenance.degraded.map(d => d.key) : [],
      missing: payload.provenance && Array.isArray(payload.provenance.missing)
        ? payload.provenance.missing.slice(0, 12) : [],
      truncatedSamples: (payload.diagnostics && payload.diagnostics.droppedSamples) || 0,
    };

    const list = readReportIndex();
    list.unshift(meta);
    while (list.length > MAX_HISTORY_REPORTS) {
      const old = list.pop();
      // Excel 现在与报告同 id 归档到 history/（<id>.xlsx），淘汰旧报告时一并清掉，
      // 避免报告被删、Excel 却残留成一堆孤立文件。
      for (const ext of ['.js', '.json', '.xlsx']) {
        // 删旧报告失败（被占用 / 已经不在了）不阻断索引更新：索引里已经把它 pop 掉，
        // 残留文件下次归档时还会被再删一遍。
        try { fs.unlinkSync(path.join(dir, `${old.id}${ext}`)); } catch (_) {}
      }
    }
    writeReportIndex(list);
    // 记录本次归档，供紧随其后的 Excel 导出同名落盘（见 getLastArchive）。
    _lastArchive = { id: meta.id, dir, file: meta.file };
    return meta;
  } catch (_) {
    return null;
  }
}

module.exports = {
  getReportsDataJsPath,
  getReportsRootDir,
  resolveReportsRootDir,
  getHistoryDir,
  getLastArchive,
  formatReportAppId,
  writeDataJs,
  preparePayload,
  readReportDataJs,
  readReportPureJsonTextFromDataJs,
  writeReportDataJsonFromDataJs,
  summarizePerf,
  normalizeMetricConfig,
  KPI_GROUP,
  archiveReport,
  readReportIndex,
  writeReportIndex,
};
