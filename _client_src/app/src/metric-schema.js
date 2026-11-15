'use strict';

/**
 * 指标口径登记表（单一真值源）。
 *
 * 这个模块解决两个长期问题：
 *   1. 报告/Excel 里只有数值，没有「这个数从哪来、是应用口径还是整机口径、
 *      是直读还是降级、覆盖了多少采样」——用户无法判断一个数能不能用。
 *   2. 历史报告的统计口径变过（温度结温/机身温度、Jank 单位次/s→帧），
 *      但没有版本号，跨版本对比时会静默得到错误结论。
 *
 * 因此这里同时提供：
 *   - SCHEMA_VERSION：口径版本，写进每份 data.js；
 *   - METRIC_DEFS：每个指标的标签、单位、所属组、期望口径（scope）；
 *   - buildProvenance()：扫一遍采样点，得出每指标的实际来源、覆盖率与质量评级。
 *
 * 设计约束：
 *   - 纯函数、零依赖（报告写入、Excel 导出、离线测试都能直接 require）；
 *   - 只读采样点，不修改数据；
 *   - 采不到就如实报 missing，绝不用 0 或默认值补齐。
 */

/**
 * 口径版本。以下任一情况必须递增：
 *   - 某指标的统计口径/单位变化（如温度从结温改机身温度）
 *   - 某指标换了数据源且数值分布不同（如网络从整机改按 UID）
 *   - 派生指标的算法变化（如 jank 阈值基准）
 * 报告页读到这个字段与当前版本不同时，会提示「跨版本不可直接对比」。
 */
const SampleMeta = require('./sample-meta');
const SCHEMA_VERSION = SampleMeta.SCHEMA_VERSION;

/** 平台无关的指标定义。get() 取数值；sourceOf()/scopeOf() 取来源与口径。 */
const METRIC_DEFS = [
  // ── 帧 ────────────────────────────────────────────────────────────────────
  { key: 'fps', label: 'FPS', unit: '帧/秒', group: 'fps', scope: 'app',
    get: r => num(r.fps), sourceOf: r => str(r.fpsMethod) },
  { key: 'ftP50', label: '帧耗时 P50', unit: 'ms', group: 'fps', scope: 'app',
    get: r => num(r.ftP50) },
  { key: 'ftP90', label: '帧耗时 P90', unit: 'ms', group: 'fps', scope: 'app',
    get: r => num(r.ftP90) },
  { key: 'ftP95', label: '帧耗时 P95', unit: 'ms', group: 'fps', scope: 'app',
    get: r => num(r.ftP95) },
  { key: 'ftP99', label: '帧耗时 P99', unit: 'ms', group: 'fps', scope: 'app',
    get: r => num(r.ftP99) },
  // FIX-02（schema v4）：三项指标的「超时」基准是 deadline = max(屏幕刷新周期,
  // 本段实际帧节奏 P50)，不再单独锚面板 vsync —— 否则锁 30fps 在高刷面板上
  // 帧帧误判卡顿、跨面板结论翻 100 个百分点。
  { key: 'jankyRatio', label: '卡顿帧占比', unit: '%', group: 'fps', scope: 'app',
    get: r => num(r.jankyRatio),
    note: '帧耗时 > 2×deadline 的帧占比；deadline = max(屏幕刷新周期, 实际帧节奏 P50)' },
  { key: 'hitchMsPerSec', label: 'Hitch（超时/秒）', unit: 'ms/s', group: 'fps', scope: 'app',
    get: r => num(r.hitchMsPerSec),
    note: '相对实际帧节奏的超时累计（每秒），Apple Hitch Time Ratio 口径' },
  { key: 'overrunP99', label: '超帧时限 P99', unit: 'ms', group: 'fps', scope: 'app',
    get: r => num(r.overrunP99),
    note: '单帧相对实际帧节奏的超时 P99' },
  { key: 'overrunMax', label: '最长单帧超时', unit: 'ms', group: 'fps', scope: 'app',
    get: r => num(r.overrunMax) },
  { key: 'jank', label: 'Jank', unit: '帧', group: 'fps', scope: 'app',
    get: r => num(r.jank) },
  // PerfDog 卡顿分级家族。此前只登记了 jank 主项，导致 provenance 覆盖率表
  // 看不到这四项 —— 它们在采样点与 ANDROID_METRIC_KEYS 里都有，属于「采了但没登记」。
  // 口径与 jank 一致：本采样周期的卡顿帧数（默认 1Hz 时数值上等于次/秒）。
  { key: 'bigJank', label: 'BigJank', unit: '帧', group: 'fps', scope: 'app',
    get: r => num(r.bigJank) },
  { key: 'smallJank', label: 'SmallJank', unit: '帧', group: 'fps', scope: 'app',
    get: r => num(r.smallJank),
    note: 'v5 档梯：阈值 max(2×基准, 41.67ms)（电影帧 1 倍，PerfDog 未公布数值，按其算术推导），数值天然 ≥ Jank' },
  { key: 'tinyJank', label: 'TinyJank', unit: '帧', group: 'fps', scope: 'app',
    get: r => num(r.tinyJank) },
  // jankRate 是 jank ÷ 参与判定的帧数，单位是百分比，与上面四项的「帧」不同。
  { key: 'jankRate', label: '卡顿帧率', unit: '%', group: 'fps', scope: 'app',
    get: r => num(r.jankRate) },
  // overrunP95 与 overrunP99/Max 同族；FRAME_STAT_KEYS 里一直有它，定义表漏登记。
  { key: 'overrunP95', label: '超帧时限 P95', unit: 'ms', group: 'fps', scope: 'app',
    get: r => num(r.overrunP95) },
  // ── CPU / 内存 ────────────────────────────────────────────────────────────
  { key: 'cpu.procCpu', label: '进程 CPU', unit: '%', group: 'cpu', scope: 'app',
    get: r => num(r.cpu && r.cpu.procCpu), legacy: r => num(r.cpuUsage) },
  { key: 'cpu.sysCpu', label: '系统 CPU', unit: '%', group: 'cpu', scope: 'device',
    get: r => num(r.cpu && r.cpu.sysCpu), legacy: r => num(r.cpuTotalSystem),
    // r3 遗留项闭环（FIX-14 freqSource 下游）：频率精度进 provenance sources——
    // cpuinfo=核心实际运行频率，scaling=governor 目标（DVFS 切换时与实际差一档）。
    // 逐核 freq 是数组指标不做分位数，这里只登记「来源」维度，无口径争议。
    sourceOf: r => str(r.freqSource),
    sourceLabels: { cpuinfo: '实际运行频率（cpuinfo_cur_freq）',
                    scaling: 'governor 目标频率（scaling_cur_freq）' } },
  { key: 'mem.totalPss', label: '总 PSS', unit: 'MB', group: 'mem', scope: 'app',
    get: r => num(r.mem && r.mem.totalPss), legacy: r => num(r.physFootprint),
    cadenced: true },
  // RSS 走 /proc/<pid>/status，是逐拍实测值（PSS 家族降频到 5s，见 collector）。
  // 两个口径并列展示：RSS 看趋势、PSS 看真实占用，用户能自己判断是否被降频影响。
  { key: 'mem.rss', label: '进程 RSS', unit: 'MB', group: 'mem', scope: 'app',
    get: r => num(r.mem && r.mem.rss) },
  // ── 网络 ──────────────────────────────────────────────────────────────────
  { key: 'net.rxKBps', label: '下行', unit: 'KB/s', group: 'net', scope: 'app',
    get: r => num(r.net && r.net.rxKBps), legacy: r => num(r.rxKBps),
    scopeOf: r => str(r.net && r.net.netScope) || str(r.netScope),
    sourceOf: r => str(r.net && r.net.netSource) || str(r.netSource) },
  { key: 'net.txKBps', label: '上行', unit: 'KB/s', group: 'net', scope: 'app',
    get: r => num(r.net && r.net.txKBps), legacy: r => num(r.txKBps),
    scopeOf: r => str(r.net && r.net.netScope) || str(r.netScope),
    sourceOf: r => str(r.net && r.net.netSource) || str(r.netSource) },
  // ── GPU / 温度 / 电池 ─────────────────────────────────────────────────────
  { key: 'gpu', label: 'GPU 利用率', unit: '%', group: 'gpu', scope: 'device',
    get: r => num(r.gpu), legacy: r => num(r.gpu && r.gpu.utilization),
    // D-03（r4）：采集实现全部是设备级 sysfs 节点（kgsl/mali/ged 等），没有
    // 按进程/UID 的路径 —— 旧标 'app' 会把别人的 GPU 负载说成本应用的，
    // 归因跑偏。与网络回退整机口径标注同一处理原则。
    note: '设备级 GPU 利用率（整机口径），非按进程统计；后台负载会计入' },
  { key: 'temperature', label: '机身温度', unit: '°C', group: 'temp', scope: 'device',
    get: r => num(r.temperature), legacy: r => num(r.temp),
    sourceOf: r => str(r.tempSource), sourceLabels: TEMP_SOURCE_LABELS() },
  // FIX-07（v4）：/proc/<pid>/status 现成字段，零额外 adb 开销；读不到写 null
  { key: 'mem.threads', label: '线程数', unit: '个', group: 'mem', scope: 'app',
    get: r => num(r.mem && r.mem.threads),
    note: 'native 线程数（/proc/<pid>/status Threads），暴涨多为泄漏或并发问题' },
  { key: 'mem.swapMB', label: 'Swap 换出', unit: 'MB', group: 'mem', scope: 'app',
    get: r => num(r.mem && r.mem.swapMB),
    note: 'VmSwap：被系统换出到 swap 的内存大小，反映内存压力' },
  { key: 'mem.ctxVoluntary', label: '自愿上下文切换', unit: '次', group: 'mem', scope: 'app',
    get: r => num(r.mem && r.mem.ctxVoluntary),
    note: '累计值（等 IO / 锁时主动让出）；速率由报告层取差' },
  { key: 'mem.ctxNonvoluntary', label: '非自愿上下文切换', unit: '次', group: 'mem', scope: 'app',
    get: r => num(r.mem && r.mem.ctxNonvoluntary),
    note: '累计值；非自愿切换速率高 = CPU 争抢，与 CPU 曲线对照看' },
  // ── v3 新增：ADPF 节流信号（Android，thermalservice 通道）───────────────────
  // thermalStatus 是系统判定的节流等级（0 NONE~6 SHUTDOWN），掉帧归因时
  // 「Status>0」= 系统正在限频的铁证；coolingValue 是动作量最大的冷却设备幅度。
  { key: 'thermalStatus', label: '热节流等级', unit: '级', group: 'temp', scope: 'device',
    get: r => num(r.thermalStatus),
    note: '0=正常，1~6 逐级加重（ADPF Thermal Status），null=ROM 未暴露' },
  { key: 'coolingValue', label: '冷却动作量', unit: '量', group: 'temp', scope: 'device',
    get: r => num(r.coolingValue), sourceOf: r => str(r.coolingName),
    note: '动作量最大的冷却设备（如 cpu_adaptive），数值越大限得越狠' },
  // ── v3 新增：PC 帧延迟分解（PresentMon v1 列，1s 窗口均值）─────────────────
  // 与 Android 端帧耗时 P50/P99 对齐：PC 也能回答「延迟花在哪个阶段」。
  { key: 'pc.frameDisplayChangeMs', label: '上屏间隔', unit: 'ms', group: 'fps', scope: 'app',
    get: r => num(r.pcExtra && r.pcExtra.frameDisplayChangeMs),
    note: 'MsBetweenDisplayChange：上一帧上屏到本帧上屏' },
  { key: 'pc.frameUntilDisplayedMs', label: 'Present→上屏延迟', unit: 'ms', group: 'fps', scope: 'app',
    get: r => num(r.pcExtra && r.pcExtra.frameUntilDisplayedMs),
    note: 'MsUntilDisplayed（P2D）：Present() 调用到画面上屏' },
  { key: 'pc.framePresentApiMs', label: 'Present 调用耗时', unit: 'ms', group: 'fps', scope: 'app',
    get: r => num(r.pcExtra && r.pcExtra.framePresentApiMs),
    note: 'MsInPresentAPI：Present() 内部阻塞时长（过长=提交队列堵）' },
  { key: 'pc.frameRenderLatencyMs', label: '渲染完成延迟', unit: 'ms', group: 'fps', scope: 'app',
    get: r => num(r.pcExtra && r.pcExtra.frameRenderLatencyMs),
    note: 'MsRenderPresentLatency：Present() 到 GPU 完成该帧' },
  { key: 'pc.frameAppStartGapMs', label: '帧起点间距', unit: 'ms', group: 'fps', scope: 'app',
    get: r => num(r.pcExtra && r.pcExtra.frameAppStartGapMs),
    note: 'MsBetweenAppStart：模拟/等待节奏（过大=CPU 侧瓶颈）' },
];

/** 温度来源 → 人话 */
function TEMP_SOURCE_LABELS() {
  return {
    battery: '电池温度（兜底）',
    skin: '外壳估算温度',
    body: '机身温度节点',
    board: '主板温度节点',
    die: '芯片结温',
  };
}

function num(v) {
  return (typeof v === 'number' && isFinite(v)) ? v : null;
}
function str(v) {
  return (typeof v === 'string' && v) ? v : null;
}

/** 覆盖率 → 质量评级。阈值是工程约定，不是行业标准。 */
function qualityOf(coverage, r) {
  if (r === 0) return 'missing';
  if (coverage >= 0.9) return 'ok';
  if (coverage >= 0.5) return 'partial';
  return 'sparse';
}

/**
 * 扫一遍采样点，生成指标溯源表。
 *
 * @param {Array<Object>} perf 采样点数组
 * @param {string} platform 'android' | 'ios' | 'ios-gpu' | 'pc'
 * @param {{tickMs?:number[], truncated?:number}} [extra] 可选：采集开销与截断信息
 * @returns {Object} provenance
 */
function buildProvenance(perf, platform, extra) {
  const rows = Array.isArray(perf) ? perf : [];
  const total = rows.length;
  const metrics = {};
  const degraded = [];
  const missing = [];

  for (const def of METRIC_DEFS) {
    let measured = 0;
    const sources = Object.create(null);
    const scopes = Object.create(null);

    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      let v = def.get(r);
      // 平台专属字段名（如 PC 的 cpuUsage）只在主字段缺失时兜底，
      // 不改变数值语义，只避免把「同一指标换了个字段名」误判成漏采。
      if (v == null && typeof def.legacy === 'function') v = def.legacy(r);
      if (v == null) continue;
      measured++;
      const src = (def.sourceOf && def.sourceOf(r)) || 'default';
      sources[src] = (sources[src] || 0) + 1;
      const sc = (def.scopeOf && def.scopeOf(r)) || def.scope;
      scopes[sc] = (scopes[sc] || 0) + 1;
    }

    const coverage = total ? round(measured / total, 4) : 0;
    // 实际口径取「出现最多的那一个」：一次采集中途切换口径时，多数样本才是主口径
    const scope = dominantKey(scopes) || def.scope;
    const expected = def.scope;
    let quality = qualityOf(coverage, measured);
    let note = '';
    if (measured > 0 && scope !== expected) {
      // 口径与预期不一致 → 降级。最典型的是网络回退整机流量。
      quality = 'degraded';
      note = scope === 'device' && def.group === 'net'
        ? '整机流量：包含设备上其它应用的收发，不等于被测应用流量'
        : `实际口径为 ${scope}（预期 ${expected}）`;
    }
    if (measured > 0 && quality !== 'degraded' && Object.keys(sources).length > 1) {
      // 一次采集中换了通道：数值分布可能不同，需要提示
      note = note || `采集期间使用了 ${Object.keys(sources).length} 条通道，数值可能不连续`;
      if (quality === 'ok') quality = 'partial';
    }
    if (measured > 0 && def.group === 'net' && scope === 'app' && sources.netstats) {
      // netstats 通道的固有限制：ROM 按分桶（实测 bucketDuration 常为 1~2 小时）
      // 存储计数，短周期的突发流量可能被桶粒度抹平。它仍优于整机流量，
      // 但和 qtaguid 的逐包计数不是一回事，必须写明，否则会被当成同等精度。
      note = note || '应用流量来自 dumpsys netstats：ROM 按分桶存储，'
        + '短周期突发流量可能被分桶粒度抹平';
    }
    if (measured > 0 && def.cadenced) {
      // 内存重通道降频（见 collector.MEM_FULL_REFRESH_MS）：只有打了 src:'full'
      // 的点才是 dumpsys meminfo 的实测值，其余点是沿用上一次实测值的阶梯。
      // 不说明的话，用户会把阶梯当成人真的「每秒内存」曲线。
      const full = rows.reduce((n, r) => (
        n + ((r && r.mem && r.mem.src === 'full') ? 1 : 0)
      ), 0);
      if (full > 0 && full < measured) {
        note = note || `${def.label} 每 ${Math.max(1, Math.round(measured / full))} 拍实测一次，`
          + '中间采样点沿用上次实测值（降低采集对被测应用的干扰）';
      }
    }

    const item = {
      key: def.key,
      label: def.label,
      unit: def.unit,
      group: def.group,
      samples: total,
      measured,
      coverage,
      quality,
      scope,
      expectedScope: expected,
      sources: sources,
      note,
    };
    metrics[def.key] = item;
    if (quality === 'degraded') degraded.push(item);
    if (quality === 'missing') missing.push(item);
  }

  const summary = {
    metrics: Object.keys(metrics).length,
    ok: countQuality(metrics, 'ok'),
    partial: countQuality(metrics, 'partial'),
    sparse: countQuality(metrics, 'sparse'),
    degraded: degraded.length,
    missing: missing.length,
  };

  const out = {
    schemaVersion: SCHEMA_VERSION,
    platform: platform || '',
    generatedAt: new Date().toISOString(),
    samples: total,
    summary,
    metrics,
    degraded: degraded.map(d => ({ key: d.key, label: d.label, scope: d.scope, note: d.note })),
    missing: missing.map(d => d.key),
  };

  // 采集开销（批次 1.4）：只有拿到逐拍耗时才写，避免伪造
  const ticks = Array.isArray(extra && extra.tickMs)
    ? extra.tickMs.filter(v => typeof v === 'number' && isFinite(v) && v >= 0) : [];
  if (ticks.length) {
    const sorted = ticks.slice().sort((a, b) => a - b);
    out.overhead = {
      samples: ticks.length,
      p50Ms: nearestRank(sorted, 0.5),
      p95Ms: nearestRank(sorted, 0.95),
      maxMs: sorted[sorted.length - 1],
    };
  }
  // 长时采集截断（批次 1.5）：绝不静默。
  // spilled 是「已落盘分片、合并回报告」的点，不是丢失，单独列出便于区分。
  if (extra && extra.truncated > 0) out.truncatedSamples = extra.truncated;
  if (extra && extra.spilled > 0) out.spilledSamples = extra.spilled;
  // 1.3 逐拍 meta：四端共用同一形状，这里给出覆盖率与降级拍数。
  // 老报告没有 meta 时 withMeta=0，报告页据此隐藏该行，不影响历史数据。
  const per = SampleMeta.summarizeSampleMeta(rows);
  if (per.withMeta > 0) out.perSample = per;
  return out;
}

function countQuality(metrics, q) {
  return Object.keys(metrics).filter(k => metrics[k].quality === q).length;
}

function dominantKey(obj) {
  let best = null, bestN = -1;
  for (const k of Object.keys(obj)) {
    if (obj[k] > bestN) { best = k; bestN = obj[k]; }
  }
  return best;
}

function round(v, d) {
  const p = Math.pow(10, d == null ? 2 : d);
  return Math.round(v * p) / p;
}

/** 最近秩分位数（与 adb.js 里帧耗时分位数同一口径，便于跨模块对齐） */
function nearestRank(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const i = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[i];
}

/**
 * 报告页加载时判断口径是否可比。
 * @param {string|undefined} loaded 报告里记录的 schemaVersion
 * @returns {{comparable:boolean, level:'ok'|'legacy'|'mismatch', message:string}}
 */
function checkSchema(loaded) {
  if (!loaded) {
    return {
      comparable: false,
      level: 'legacy',
      message: '这份报告没有口径版本（旧版生成），跨版本对比可能得出错误结论。',
    };
  }
  if (String(loaded) !== SCHEMA_VERSION) {
    return {
      comparable: false,
      level: 'mismatch',
      message: `报告口径版本为 ${loaded}，当前为 ${SCHEMA_VERSION}；指标定义或单位已变化，不建议直接对比。`,
    };
  }
  return { comparable: true, level: 'ok', message: '' };
}

/** 报告/Excel 用的精简定义清单 */
function metricDefinitions() {
  return METRIC_DEFS.map(d => ({
    key: d.key,
    label: d.label,
    unit: d.unit,
    group: d.group,
    scope: d.scope,
    // FIX-02：口径说明（deadline 语义）随定义进 data.js，报告对比页能展示
    ...(d.note ? { note: d.note } : {}),
  }));
}

module.exports = {
  SCHEMA_VERSION,
  METRIC_DEFS,
  metricDefinitions,
  buildProvenance,
  checkSchema,
  nearestRank,
  TEMP_SOURCE_LABELS,
};
