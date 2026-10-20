'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

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
    } catch (_) {}
  }
  return null;
}

/**
 * Write `var data = <json>;\n` — same structure as android.json / ios.json / iosgpu.json.
 * Prefer resources/reports; if not writable (e.g. Program Files), fall back to userData/reports.
 * 每次写入都会顺带归档一份到 history/，作为本地报告库的一条记录。
 */
function writeDataJs(payload) {
  // 不缩进：data.js 供报告页 <script> 加载，缩进会让体积膨胀 2~3 倍，
  // 拖慢「写入 + 报告页解析」两头（长时采集可达数十 MB）。人读请用同目录 data.json。
  const content = `var data = ${JSON.stringify(payload)};\n`;
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
  try { archiveReport(payload, written); } catch (_) {}
  return written;
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
function summarizePerf(perf, metricConfig) {
  const rows = Array.isArray(perf) ? perf : [];
  // 一次循环把 10 条序列 + 时间戳都取出来：原来是对同一份 rows 跑 11 遍 map，
  // 每遍都要 _pick 做 split 解析，长时采集时这部分是纯浪费。
  const series = {
    fps: [], cpu: [], mem: [], temp: [], gpu: [], gpuTemp: [],
    jank: [], bigJank: [], smallJank: [], tinyJank: [],
  };
  const ts = [];
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
    if (o.timestamp != null) ts.push(o.timestamp);
  }
  const kpi = {};
  for (const k of Object.keys(series)) {
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
  //   达帧率   = 平均 FPS ÷ 目标帧率 × 100
  //   均帧     = 各采样点帧间隔（1000/FPS）的平均，ms
  //   低帧占比 = FPS 低于目标 80% 的采样占比
  //   1%Low    = 帧耗时最长 1% 的均值折算帧率
  //   FPS≥目标 = 达到目标帧率的采样占比
  //   稳帧范围 = 偏离中位数 ±20% 内的占比（MedRange）
  //   帧率标准差 / 卡顿时长占比（Stutter）/ Drop（帧/时）
  // 目标帧率由 P95 吸附到常见刷新率（30/45/60/90/120/144/165）。
  const fpsNums = _nums(series.fps);
  // 同样避免 Math.max.apply 展开超长数组（点数多时会 RangeError）
  let tsMin = Infinity, tsMax = -Infinity;
  for (const t of ts) { if (t < tsMin) tsMin = t; if (t > tsMax) tsMax = t; }
  let durSec = ts.length >= 2 ? _round((tsMax - tsMin) / 1000, 1) : null;
  if (fpsNums.length) {
    const sorted = fpsNums.slice().sort((a, b) => a - b);
    const i = (sorted.length - 1) * 0.95;
    const lo = Math.floor(i), hi = Math.ceil(i);
    const p95 = lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
    let target = null;
    for (const c of [30, 45, 60, 90, 120, 144, 165]) { if (c >= p95 * 0.97) { target = c; break; } }
    if (target == null) target = Math.ceil(p95 / 30) * 30;
    if (target > 0) {
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
      // FPS≥目标
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
      // Drop(FPS)：相邻两点下降 > 8 帧的次数，按小时折算
      const durHour = durSec ? durSec / 3600 : null;
      let drop = 0;
      for (let i2 = 1; i2 < fpsNums.length; i2++) if (fpsNums[i2 - 1] - fpsNums[i2] > 8) drop++;
      kpi.fpsDrop = { avg: _round(durHour ? drop / durHour : drop, 1), min: null, max: null };
    }
  }

  // Jank / BigJank / SmallJank / TinyJank 每 10 分钟次数（与报告页同口径）
  const durMin = durSec ? durSec / 60 : null;
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
  };
}

function _sanitize(s) {
  return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
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
 * 归档一次采集：写 history/<id>.js|json 并刷新索引。
 * 返回元数据；失败返回 null（归档是附加能力，绝不抛出影响采集主流程）。
 */
function archiveReport(payload, dataJsPath) {
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

    // 同样不缩进（见 writeDataJs 注释）；history 里 .js 与 .json 内容一致，
    // 序列化一次复用，避免对同一份数据跑两遍 stringify
    const json = JSON.stringify(payload);
    fs.writeFileSync(path.join(dir, `${id}.js`), `var data = ${json};\n`, 'utf8');
    fs.writeFileSync(path.join(dir, `${id}.json`), json, 'utf8');

    const sum = summarizePerf(perf, payload.metricConfig);
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
    };

    const list = readReportIndex();
    list.unshift(meta);
    while (list.length > MAX_HISTORY_REPORTS) {
      const old = list.pop();
      for (const ext of ['.js', '.json']) {
        try { fs.unlinkSync(path.join(dir, `${old.id}${ext}`)); } catch (_) {}
      }
    }
    writeReportIndex(list);
    return meta;
  } catch (_) {
    return null;
  }
}

module.exports = {
  getReportsDataJsPath,
  getReportsRootDir,
  getHistoryDir,
  formatReportAppId,
  writeDataJs,
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
