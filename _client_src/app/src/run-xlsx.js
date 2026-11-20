'use strict';

/**
 * 采集结束后在「报告储存文件夹」生成 Excel 工作簿。
 *
 * 工作表（标签页）安排：
 *   汇总             —— 本轮基本信息 + 各指标均值/最小/最大
 *   FPS与卡顿 / CPU / 内存 / 网络 / 温度 / 电池 / GPU
 *                    —— 每个性能组独占一个标签页，按本轮 metricOrder 排序，
 *                       只列出该轮真正采到的列（没测到的指标不占位）
 *   其他指标         —— iOS / iOS GPU 等未按上述分组的字段（有才生成）
 *   标记区间         —— 采集窗口「开始标记 / 结束标记」划出的每段区间统计
 *   原始采样         —— 全部字段平铺，额外带「标记区间」列
 *
 * 「按不同标签展示」既指 Excel 底部的性能标签页，也指采集标记：两张表都带
 * 「标记区间」列，标记区间表再按段汇总。与 CSV 一致：未测到的值留空，不补 0。
 */

const fs = require('fs');
const path = require('path');
const Writer = require('./xlsx-writer');
const Schema = require('./metric-schema');

const DEFAULT_ORDER = ['fps', 'cpu', 'mem', 'net', 'gpu', 'temp', 'battery'];

/** 字段路径 → 中文表头。未列出的字段回退用原始路径。 */
const FIELD_LABELS = {
  timestamp: '时间戳 (ms)', time: '采样时间', pid: '进程 PID',
  // Jank 家族是固定电影帧绝对门槛的旧口径，跨刷新率不可直接比；
  // 表头保留原名前缀（对比脚本按它匹配），只在后面加「旧口径」提示。
  fps: 'FPS (帧/秒)', jank: 'Jank (帧)（旧口径）', bigJank: 'BigJank (帧)（旧口径）',
  smallJank: 'SmallJank (帧)（旧口径）', tinyJank: 'TinyJank (帧)（旧口径）',
  jankRate: 'JankRate (%)（旧口径）',
  // 现代帧指标（跨刷新率可比，见 docs/更新日志.md「帧指标」）
  ftP50: '帧耗时 P50 (ms)', ftP90: '帧耗时 P90 (ms)',
  ftP95: '帧耗时 P95 (ms)', ftP99: '帧耗时 P99 (ms)',
  jankyRatio: '卡顿帧占比 (%)', hitchMsPerSec: 'Hitch (ms/s)',
  overrunP95: '超帧时限 P95 (ms)', overrunP99: '超帧时限 P99 (ms)',
  overrunMax: '最长单帧超时 (ms)',
  fpsMethod: '取帧通道', tickMs: '采集耗时 (ms)',
  'net.netScope': '流量口径', 'net.netSource': '流量来源',
  dtMs: '与上一拍间隔 (ms)', tickStartTs: '采样窗口起点 (ms)',
  freqSource: 'CPU 频率来源', coolingName: '冷却设备', 'netSource': '流量来源',
  'cpu.sysCpu': '系统 CPU (%)', 'cpu.procCpu': '进程 CPU (%)',
  cpuUsage: 'CPU 使用率 (%)', cpuTotalSystem: '系统态 CPU (%)', cpuTotalUser: '用户态 CPU (%)',
  'mem.totalPss': '总 PSS (MB)', 'mem.rss': '进程 RSS (MB)', 'mem.nativeHeap': 'Native Heap (MB)',
  'mem.javaHeap': 'Java Heap (MB)', 'mem.dalvikHeap': 'Dalvik Heap (MB)',
  'mem.code': 'Code (MB)', 'mem.stack': 'Stack (MB)', 'mem.graphics': 'Graphics (MB)',
  'mem.privateOther': 'PrivateOther (MB)', 'mem.system': 'System (MB)',
  // 采集侧为降低对被测应用的干扰，把 dumpsys meminfo（遍历全部内存映射、持有 mm 锁）
  // 降到每 5 拍一次，其余拍只读 /proc/<pid>/status 的 VmRSS/VmHWM（内核计数，零遍历）。
  // mem.src 记录本拍 PSS 是实测还是沿用：full=实测，lite=沿用上次实测值。
  'mem.src': 'PSS 采样方式', 'mem.hwm': '进程内存峰值 HWM (MB)',
  'mem.memTotalMB': '整机内存总量 (MB)', 'mem.memAvailableMB': '整机可用内存 (MB)',
  'mem.threads': '线程数 (个)', 'mem.swapMB': 'Swap 换出 (MB)',
  'mem.ctxVoluntary': '自愿上下文切换 (次)', 'mem.ctxNonvoluntary': '非自愿上下文切换 (次)',
  physFootprint: '物理内存占用 (MB)', memResidentSize: '常驻内存 (MB)',
  memVirtualSize: '虚拟内存 (MB)', memRPrvt: '私有内存 (MB)', memRShrd: '共享内存 (MB)',
  memAnon: '匿名内存 (MB)', memCompressed: '压缩内存 (MB)', memPurgeable: '可清理内存 (MB)',
  'net.rxKBps': '下行 (KB/s)', 'net.txKBps': '上行 (KB/s)',
  rxKBps: '下行 (KB/s)', txKBps: '上行 (KB/s)',
  temperature: '机身温度 (°C)', tempSource: '温度来源',
  gpuTemp: 'GPU 结温 (°C)', cpuTemp: 'CPU 结温 (°C)',
  batteryTemp: '电池温度 (°C)', skinTemp: '外壳估算温度 (°C)',
  thermalStatus: '热节流等级 (ADPF)', coolingName: '冷却设备', coolingValue: '冷却动作量',
  'pcExtra.frameDisplayChangeMs': '上屏间隔 (ms)',
  'pcExtra.frameUntilDisplayedMs': 'Present→上屏延迟 (ms)',
  'pcExtra.framePresentApiMs': 'Present 调用耗时 (ms)',
  'pcExtra.frameRenderLatencyMs': '渲染完成延迟 (ms)',
  'pcExtra.frameAppStartGapMs': '帧起点间距 (ms)',
  gpu: 'GPU 利用率 (%)',
  'battery.level': '电量 (%)', 'battery.voltage': '电压 (mV)',
  'battery.temperature': '电池温度 (°C)', 'battery.currentNow': '电流 (mA)',
  'battery.power': '功耗 (mW)',
  diskBytesRead: '磁盘读 (B)', diskBytesWritten: '磁盘写 (B)',
  threadCount: '线程数', machPortCount: 'Mach 端口数',
};

/** 性能组：cols 是已知列，prefixes 用于自动补进同组的动态/平台专属列 */
const GROUP_DEFS = [
  { key: 'fps', name: 'FPS与卡顿',
    prefixes: ['fps', 'jank', 'bigJank', 'smallJank', 'tinyJank', 'jankRate',
      'ftP50', 'ftP90', 'ftP95', 'ftP99', 'jankyRatio', 'hitchMsPerSec',
      'overrunP95', 'overrunP99', 'overrunMax', 'fpsMethod', 'tickMs',
      'pcExtra.frame'],
    cols: ['fps', 'jank', 'bigJank', 'smallJank', 'tinyJank', 'jankRate',
      'ftP50', 'ftP90', 'ftP95', 'ftP99', 'jankyRatio', 'hitchMsPerSec',
      'overrunP95', 'overrunP99', 'overrunMax', 'fpsMethod', 'tickMs',
      'pcExtra.frameDisplayChangeMs', 'pcExtra.frameUntilDisplayedMs',
      'pcExtra.framePresentApiMs', 'pcExtra.frameRenderLatencyMs',
      'pcExtra.frameAppStartGapMs'] },
  { key: 'cpu', name: 'CPU',
    prefixes: ['cpu', 'cpuCores', 'cpuUsage', 'cpuTotalSystem', 'cpuTotalUser'],
    cols: ['cpu.sysCpu', 'cpu.procCpu', 'cpuUsage', 'cpuTotalSystem', 'cpuTotalUser'] },
  { key: 'mem', name: '内存',
    prefixes: ['mem', 'physFootprint', 'memResidentSize', 'memVirtualSize', 'memRPrvt',
      'memRShrd', 'memAnon', 'memCompressed', 'memPurgeable'],
    cols: ['mem.totalPss', 'mem.rss', 'mem.hwm', 'mem.nativeHeap', 'mem.javaHeap', 'mem.dalvikHeap',
      'mem.code', 'mem.stack', 'mem.graphics', 'mem.privateOther', 'mem.system', 'mem.src',
      'mem.threads', 'mem.swapMB', 'mem.ctxVoluntary', 'mem.ctxNonvoluntary',
      'physFootprint', 'memResidentSize', 'memVirtualSize', 'memRPrvt', 'memRShrd',
      'memAnon', 'memCompressed', 'memPurgeable'] },
  { key: 'net', name: '网络',
    prefixes: ['net', 'rxKBps', 'txKBps'],
    cols: ['net.rxKBps', 'net.txKBps', 'rxKBps', 'txKBps'] },
  { key: 'gpu', name: 'GPU', prefixes: ['gpu'], cols: ['gpu'] },
  { key: 'temp', name: '温度',
    prefixes: ['temperature', 'tempSource', 'gpuTemp', 'cpuTemp', 'batteryTemp', 'skinTemp',
      'thermalStatus', 'cooling'],
    cols: ['temperature', 'tempSource', 'gpuTemp', 'cpuTemp', 'batteryTemp', 'skinTemp',
      'thermalStatus', 'coolingName', 'coolingValue'] },
  { key: 'battery', name: '电池',
    prefixes: ['battery'],
    cols: ['battery.level', 'battery.voltage', 'battery.temperature',
      'battery.currentNow', 'battery.power'] },
];

/**
 * 0.2 平台能力边界：iOS 的 sysmon 只给 6 组（fps / cpu / mem / disk / events / proc），
 * 没有网络、电量、温度与 GPU 利用率；GPU 渲染管线另有独立页（category=ios_gpu）。
 * 旧行为是「没采到就不生成该标签页」，用户会把缺失当成采集故障。
 * 现在显式禁用这 4 组，并在汇总页写明「本平台不采集」。
 */
const PLATFORM_UNSUPPORTED_GROUPS = {
  ios: ['net', 'temp', 'battery', 'gpu'],
};
const PLATFORM_SCOPE_NOTE = {
  ios: '本平台不采集：网络 / 电量 / 温度 / GPU 利用率（GPU 专项见独立页）；共 6 组指标',
  ios_gpu: '本平台不采集：FPS / CPU / 内存 / 网络 / 电量 / 温度；仅渲染管线专项',
};
function platformOf(payload) {
  const d = (payload && payload.device) || {};
  return String(d.category || (payload && payload.category) || '').toLowerCase();
}
function unsupportedGroupsOf(payload) {
  return PLATFORM_UNSUPPORTED_GROUPS[platformOf(payload)] || [];
}
/** 明细页列名是否要标「整机流量」（与汇总页同一判据） */
function netIsDeviceLabel(prov) {
  const m = prov && prov.metrics && prov.metrics['net.rxKBps'];
  return !!m && !!m.measured && m.scope === 'device';
}

// time / timestamp 在各表都已单独成列，避免重复；pid 保留为普通字段进「原始采样」
// meta / shellMs 是逐拍诊断元数据（1.3/1.4），不当性能指标出列
const SKIP_KEYS = new Set(['timestamp', 'time', 'meta', 'shellMs']);

// 标识类字段不是性能指标：只在「原始采样」保留，不进「其他指标」，
// 否则真机上会多出一张只有一列「进程 PID」的空壳表。
const ID_KEYS = new Set(['pid']);

// ── 数据整形 ────────────────────────────────────────────────────────────────

/** 把一拍采样摊平成 { 'cpu.sysCpu': 12, 'cpuCores.usage[0]': 5, ... } */
function flattenRow(row, prefix, out) {
  out = out || {};
  if (!row || typeof row !== 'object') return out;
  for (const k of Object.keys(row)) {
    // 诊断元数据不进任何明细表（见 SKIP_KEYS）；只在汇总页聚合后展示。
    // jankAttr 同理：它是逐拍的归因对象（9 个字段），摊开会有 9 列几乎全空，
    // 而汇总页已给出整轮分布，明细表只保留原始计数没有意义。
    if (!prefix && (k === 'meta' || k === 'shellMs' || k === 'jankAttr')) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    const v = row[k];
    if (v == null) { out[key] = null; continue; }
    if (Array.isArray(v)) {
      if (v.length === 0) out[key] = '';
      else v.forEach((x, i) => { out[`${key}[${i}]`] = (x == null) ? null : x; });
    } else if (typeof v === 'object') {
      flattenRow(v, key, out);
    } else {
      out[key] = v;
    }
  }
  return out;
}

function normalizeTags(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(t => Array.isArray(t) && t.length >= 2)
    .map(t => [Math.max(0, Number(t[0]) | 0), Math.max(0, Number(t[1]) | 0)])
    .filter(([s, e]) => e >= s);
}

function tagLabelFor(i, tags) {
  const n = tags.findIndex(([s, e]) => i >= s && i <= e);
  return n < 0 ? '' : `标记${n + 1}`;
}

function fmtTs(ts) {
  if (!Number.isFinite(ts)) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function labelFor(key) {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  const m = /^cpuCores\.(usage|freq)\[(\d+)\]$/.exec(key);
  if (m) return `核心${m[2]} ${m[1] === 'usage' ? '使用率 (%)' : '频率 (MHz)'}`;
  // 组前缀回退：iOS 的内存字段在数据里是 mem.physFootprint / mem.memResidentSize 这种
  // 「组前缀 + 裸名」形式，而 FIELD_LABELS 里登记的是裸名。不回落就会把内部 key
  // 原样写进表头（用户看到 mem.physFootprint 这种名字）。这里剥一次前缀再查。
  const dot = key.indexOf('.');
  if (dot > 0) {
    const bare = key.slice(dot + 1);
    if (FIELD_LABELS[bare]) return FIELD_LABELS[bare];
  }
  return key;
}

function numbersAt(flatRows, key, from, to) {
  const out = [];
  for (let i = from; i <= to && i < flatRows.length; i++) {
    const v = flatRows[i] ? flatRows[i][key] : null;
    if (typeof v === 'number' && isFinite(v)) out.push(v);
    else if (typeof v === 'string' && v !== '' && isFinite(Number(v))) out.push(Number(v));
  }
  return out;
}

function stat(vals) {
  if (!vals.length) return { n: 0, mean: null, min: null, max: null };
  let sum = 0, min = Infinity, max = -Infinity;
  for (const v of vals) { sum += v; if (v < min) min = v; if (v > max) max = v; }
  return { n: vals.length, mean: Math.round(sum / vals.length * 100) / 100, min, max };
}

function r2(v) { return typeof v === 'number' ? Math.round(v * 100) / 100 : v; }

// ── 各工作表 ────────────────────────────────────────────────────────────────

function summarySheet(payload, flatRows, tags, prov) {
  const perf = Array.isArray(payload.perf) ? payload.perf : [];
  const dev = payload.device || {};
  const first = perf[0] || {}, last = perf[perf.length - 1] || {};
  const duration = Number.isFinite(first.timestamp) && Number.isFinite(last.timestamp)
    ? Math.round((last.timestamp - first.timestamp) / 100) / 10 : null;

  const rows = [
    ['项目', '值'],
    ['应用', dev.appName || dev.bundleId || ''],
    ['设备', dev.name || ''],
    ['平台', dev.category || ''],
    ['采集开始', fmtTs(first.timestamp) || first.time || ''],
    ['采集结束', fmtTs(last.timestamp) || last.time || ''],
    ['采样点数', perf.length],
    ['采集时长 (s)', duration],
    ['标记区间数', tags.length],
    ['导出时间', fmtTs(Date.now())],
    [],
    ['指标', '均值', '最小', '最大', '单位', '有效样本'],
  ];

  // 1.2 网络降级到整机时，指标名本身就要带口径，不能只靠脚注：
  // 「下行」会被直接读成被测应用的流量，改名是最省事也最不容易被忽略的防线。
  const netDef = prov && prov.metrics && prov.metrics['net.rxKBps'];
  const netIsDevice = !!netDef && netDef.measured && netDef.scope === 'device';
  const downName = netIsDevice ? '整机下行（非应用流量）' : '下行';
  const upName = netIsDevice ? '整机上行（非应用流量）' : '上行';
  const metrics = [
    ['FPS', 'fps', '帧/秒'], ['Jank', 'jank', '帧'], ['BigJank', 'bigJank', '帧'],
    ['帧耗时 P50', 'ftP50', 'ms'], ['帧耗时 P95', 'ftP95', 'ms'], ['帧耗时 P99', 'ftP99', 'ms'],
    ['卡顿帧占比', 'jankyRatio', '%'], ['Hitch', 'hitchMsPerSec', 'ms/s'],
    ['超帧时限 P99', 'overrunP99', 'ms'], ['最长单帧超时', 'overrunMax', 'ms'],
    ['系统 CPU', 'cpu.sysCpu', '%'], ['进程 CPU', 'cpu.procCpu', '%'],
    ['总 PSS', 'mem.totalPss', 'MB'], [downName, 'net.rxKBps', 'KB/s'],
    [upName, 'net.txKBps', 'KB/s'], ['机身温度', 'temperature', '°C'],
    ['电量', 'battery.level', '%'], ['GPU 利用率', 'gpu', '%'],
  ];
  for (const [name, key, unit] of metrics) {
    if (!flatRows.some(f => f[key] != null && f[key] !== '')) continue;
    const s = stat(numbersAt(flatRows, key, 0, flatRows.length - 1));
    rows.push([name, s.mean, r2(s.min), r2(s.max), unit, s.n]);
  }
  // 网络口径：整机流量必须写在最显眼的位置，否则会被当成应用流量解读
  if (netDef && netDef.measured) {
    rows.push([]);
    rows.push(['网络口径', netIsDevice
      ? '整机流量（含设备上其它应用的收发，不等于被测应用流量）'
      : '应用流量（按 UID 汇总）']);
  }
  // 0.2 平台能力边界：明确写「本平台不采集」，避免空列被当成采集故障
  const scopeNote = PLATFORM_SCOPE_NOTE[platformOf(payload)];
  if (scopeNote) {
    rows.push([]);
    rows.push(['平台采集范围', scopeNote]);
  }
  // 采集开销与历史截断：都是「这份数据完整不完整」的直接证据
  if (prov && prov.overhead) {
    rows.push(['采集耗时 P50 / P95 (ms)', `${prov.overhead.p50Ms} / ${prov.overhead.p95Ms}`]);
  }
  // 1.4 分项 shell 耗时：整拍慢的时候，能一眼看出是哪个 adb 通道拖的
  const shellAcc = Object.create(null);
  for (const r of (payload && Array.isArray(payload.perf) ? payload.perf : [])) {
    const s = r && r.shellMs;
    if (!s || typeof s !== 'object') continue;
    for (const k of Object.keys(s)) {
      if (typeof s[k] !== 'number' || !isFinite(s[k])) continue;
      if (!shellAcc[k]) shellAcc[k] = { sum: 0, n: 0 };
      shellAcc[k].sum += s[k]; shellAcc[k].n += 1;
    }
  }
  const shellKeys = Object.keys(shellAcc);
  if (shellKeys.length) {
    rows.push(['各采集通道平均耗时 (ms)',
      shellKeys.map(k => `${k}=${Math.round(shellAcc[k].sum / shellAcc[k].n)}`).join('  ')]);
  }
  if (prov && prov.spilledSamples) {
    rows.push(['分段落盘点数', `${prov.spilledSamples}（已合并回报告，未丢失）`]);
  }
  if (prov && prov.truncatedSamples) {
    rows.push(['历史截断点数', `${prov.truncatedSamples}（写盘失败导致，报告不完整）`]);
  }
  // 会话级：冷启动耗时 + 本轮 ANR/崩溃。
  // 这两项不进明细表（一轮只有一个值），但「应用能不能起来、跑着跑着有没有崩」
  // 是判断整轮数据能不能用的前置条件，必须出现在汇总页最上面。
  const sess = (payload && payload.session) || null;
  if (sess && sess.launch && sess.launch.totalTimeMs != null) {
    const st = sess.launch.state === 'COLD' ? '冷启动'
      : sess.launch.state === 'WARM' ? '温启动'
        : sess.launch.state === 'HOT' ? '热启动' : '启动';
    rows.push([`${st}耗时 (ms)`, sess.launch.totalTimeMs,
      sess.launch.waitTimeMs != null ? `调度等待 ${sess.launch.waitTimeMs} ms` : '']);
  }
  if (sess && sess.exit && sess.exit.supported) {
    const crashes = (sess.exit.crash || 0) + (sess.exit.nativeCrash || 0);
    rows.push(['本轮 ANR / 崩溃 / 其它退出',
      `${sess.exit.anr || 0} / ${crashes} / ${sess.exit.other || 0}`,
      sess.exit.total ? `共 ${sess.exit.total} 次进程退出` : '未发生进程退出']);
  }
  // FrameTimeline 卡顿归因分布：卡顿发生在应用侧还是合成侧，决定该找谁改。
  // 只有 timestats 通道的采样点带 jankAttr，所以在括号里写清覆盖了多少拍。
  {
    const JA_LABELS = {
      AppDeadlineMissed: '应用未按时提交',
      BufferStuffing: '应用缓冲堆积（独立计数）',
      SurfaceFlingerCpuDeadlineMissed: 'SF CPU 合成超时',
      SurfaceFlingerGpuDeadlineMissed: 'SF GPU 合成超时',
      SurfaceFlingerScheduling: 'SF 调度延迟',
      PredictionError: '帧时长预测偏差',
      Unknown: '归属不明',
    };
    const sum = Object.create(null);
    let covered = 0, janky = 0, frames = 0;
    for (const r of perf) {
      const a = r && r.jankAttr;
      if (!a || typeof a !== 'object') continue;
      covered += 1;
      if (typeof a._frames === 'number') frames += a._frames;
      if (typeof a._total === 'number') janky += a._total;
      for (const k of Object.keys(a)) {
        if (k.charAt(0) === '_' || typeof a[k] !== 'number' || a[k] <= 0) continue;
        sum[k] = (sum[k] || 0) + a[k];
      }
    }
    if (covered > 0) {
      // BufferStuffing 单独列：真机实测它不是 jankyFrames 的子集
      //（421 帧 / jankyFrames=19 / appBufferStuffingJankyFrames=213），
      // 混在一起会得出自相矛盾的合计。其余 6 项是「这一帧为什么算卡」的成因。
      // ⚠️ 成因可重叠（同一帧既可能应用侧超时、又可能 SF 合成超时），真机实测出现过
      // 4+2 > 卡顿 4 帧，所以下面是「成因计数」，不是互斥构成，不能相加当卡顿总数。
      const core = Object.keys(sum)
        .filter((k) => k !== 'BufferStuffing')
        .sort((a, b) => sum[b] - sum[a])
        .map((k) => `${JA_LABELS[k] || k} ${sum[k]}`);
      const stuffing = sum.BufferStuffing || 0;
      const coreTotal = Object.keys(sum)
        .filter((k) => k !== 'BufferStuffing')
        .reduce((t, k) => t + sum[k], 0);
      const overlap = (janky > 0 && coreTotal > janky)
        ? `；成因可重叠，合计 ${coreTotal} 次 > 卡顿 ${janky} 帧，勿按占比相加`
        : '';
      rows.push(['卡顿归因（FrameTimeline）',
        core.length ? core.join(' · ') : '未记录到卡顿帧',
        `覆盖 ${covered} 拍${frames ? ` / 窗口 ${frames} 帧` : ''}`
          + (stuffing ? `；另缓冲堆积 ${stuffing} 帧（独立计数，不与卡顿相加）` : '')
          + overlap]);
    }
  }
  rows.push([]);
  rows.push(['说明', '未测量到的指标留空，不写 0；各性能明细见底部对应标签页']);
  rows.push(['标记区间', tags.length ? '见「标记区间」标签页；明细表最后一列标出每个采样点所属区间' : '本轮未打标记（采集窗口用「开始标记 / 结束标记」划分）']);
  return { name: '汇总', rows };
}

/**
 * 「数据质量」页：本轮每个指标的来源、覆盖率、口径与质量评级。
 * 目的不是好看，而是回答两个问题：哪个数能信、哪个数其实是整机口径。
 */
function qualitySheet(prov, payload) {
  if (!prov || !prov.metrics) return null;
  const LABELS = {
    ok: '正常', partial: '部分可用', sparse: '样本稀疏',
    degraded: '口径降级', missing: '未采集到',
  };
  const rows = [
    ['指标', '单位', '所属组', '覆盖率', '有效/总样本', '实际口径', '期望口径', '质量', '数据来源', '说明'],
  ];
  for (const key of Object.keys(prov.metrics)) {
    const m = prov.metrics[key];
    rows.push([
      m.label, m.unit, m.group,
      `${Math.round(m.coverage * 1000) / 10}%`,
      `${m.measured}/${m.samples}`,
      m.scope, m.expectedScope,
      LABELS[m.quality] || m.quality,
      sourceText(m.sources),
      m.note || '',
    ]);
  }
  rows.push([]);
  rows.push(['口径版本', prov.schemaVersion]);
  rows.push(['平台', prov.platform || '']);
  // 0.2 平台不支持的组逐组列出，质量页也回答「这不是故障、是本平台不采集」
  for (const g of unsupportedGroupsOf(payload)) {
    const def = GROUP_DEFS.find(x => x.key === g);
    rows.push([def ? def.name : g, '—', g, '—', '—', '本平台不采集', '—', LABELS.missing, '—',
      PLATFORM_SCOPE_NOTE[platformOf(payload)] || '该平台不提供此组实时数据']);
  }
  if (prov.overhead) {
    rows.push(['采集自身耗时 P50 / P95 / max (ms)',
      `${prov.overhead.p50Ms} / ${prov.overhead.p95Ms} / ${prov.overhead.maxMs}`]);
  }
  if (prov.truncatedSamples) rows.push(['历史截断点数', prov.truncatedSamples]);
  rows.push(['说明', '覆盖率 = 有效样本 ÷ 总采样点；「未采集到」表示该平台/机型不提供此指标，不等于 0']);
  return { name: '数据质量', rows };
}

function sourceText(sources) {
  const ks = Object.keys(sources || {});
  if (!ks.length) return '';
  return ks.map(k => `${k}×${sources[k]}`).join(' / ');
}

function groupSheet(def, flatRows, perf, tags, knownKeys, labelOf) {
  // 组内列 = 已知列（按定义顺序）+ 本轮出现但未登记的同前缀动态列（如逐核频率）
  const keys = [];
  const seen = new Set();
  for (const k of def.cols) if (!seen.has(k)) { seen.add(k); keys.push(k); }
  for (const k of knownKeys) {
    if (seen.has(k)) continue;
    if (def.prefixes.some(p => k === p || k.startsWith(`${p}.`) || k.startsWith(`${p}[`))) {
      seen.add(k); keys.push(k);
    }
  }
  // 只保留本轮真的采到过值的列
  const usable = keys.filter(k => flatRows.some(f => {
    const v = f[k];
    return v != null && v !== '' && !(typeof v === 'number' && !isFinite(v));
  }));
  if (!usable.length) return null;

  const lf = typeof labelOf === 'function' ? labelOf : labelFor;
  const rows = [['序号', '采样时间', '标记区间', ...usable.map(lf)]];
  for (let i = 0; i < perf.length; i++) {
    rows.push([
      i + 1,
      perf[i] && perf[i].time ? perf[i].time : fmtTs(perf[i] && perf[i].timestamp),
      tagLabelFor(i, tags),
      ...usable.map(k => flatRows[i][k]),
    ]);
  }
  return { name: def.name, rows, key: def.key, columns: usable };
}

function otherSheet(flatRows, perf, tags, assignedKeys) {
  const keys = [];
  const seen = new Set();
  for (const f of flatRows) {
    for (const k of Object.keys(f)) {
      if (SKIP_KEYS.has(k) || ID_KEYS.has(k) || assignedKeys.has(k) || seen.has(k)) continue;
      seen.add(k); keys.push(k);
    }
  }
  const usable = keys.filter(k => flatRows.some(f => f[k] != null && f[k] !== ''));
  if (!usable.length) return null;
  const rows = [['序号', '采样时间', '标记区间', ...usable.map(labelFor)]];
  for (let i = 0; i < perf.length; i++) {
    rows.push([
      i + 1,
      perf[i] && perf[i].time ? perf[i].time : fmtTs(perf[i] && perf[i].timestamp),
      tagLabelFor(i, tags),
      ...usable.map(k => flatRows[i][k]),
    ]);
  }
  return { name: '其他指标', rows, columns: usable };
}

function tagSheet(flatRows, perf, tags) {
  const head = ['标记', '起始下标', '结束下标', '开始时间', '结束时间', '采样数',
    'FPS 均值', 'FPS 最低', '系统 CPU 均值', '进程 CPU 均值', '总 PSS 均值',
    '机身温度均值', '下行均值 (KB/s)', '上行均值 (KB/s)'];
  const rows = [head];
  if (!tags.length) {
    rows.push(['提示', '本轮未打标记；采集窗口点「开始标记」「结束标记」可划分区间，此处按段汇总各性能']);
    return { name: '标记区间', rows };
  }
  const probe = [
    ['fps', 6], ['cpu.sysCpu', 8], ['cpu.procCpu', 9], ['mem.totalPss', 10],
    ['temperature', 11], ['net.rxKBps', 12], ['net.txKBps', 13],
  ];
  tags.forEach(([s, e], idx) => {
    const from = Math.max(0, s), to = Math.min(perf.length - 1, e);
    const row = [
      `标记${idx + 1}`, from, e,
      (perf[from] && perf[from].time) || '', (perf[to] && perf[to].time) || '',
      to >= from ? to - from + 1 : 0,
      '', '', '', '', '', '', '', '',
    ];
    for (const [key, col] of probe) {
      const st = stat(numbersAt(flatRows, key, from, to));
      if (st.n) row[col] = st.mean;
    }
    const fps = stat(numbersAt(flatRows, 'fps', from, to));
    if (fps.n) row[7] = r2(fps.min);
    rows.push(row);
  });
  return { name: '标记区间', rows };
}

function rawSheet(flatRows, perf, tags) {
  const keys = [];
  const seen = new Set();
  for (const f of flatRows) {
    for (const k of Object.keys(f)) {
      if (seen.has(k) || SKIP_KEYS.has(k)) continue;
      seen.add(k); keys.push(k);
    }
  }
  const rows = [['序号', '采样时间', '时间戳 (ms)', '标记区间', ...keys.map(labelFor)]];
  for (let i = 0; i < perf.length; i++) {
    const d = perf[i] || {};
    rows.push([
      i + 1, d.time || fmtTs(d.timestamp), d.timestamp, tagLabelFor(i, tags),
      ...keys.map(k => flatRows[i][k]),
    ]);
  }
  return { name: '原始采样', rows, columns: keys };
}

// ── 对外 ────────────────────────────────────────────────────────────────────

/** @returns {Array<{name:string, rows:Array<Array<*>>}>} 按标签页顺序的工作表 */
/** 建表公共上下文：拍平采样点、判定口径、算出分组顺序（同步/异步两条路径共用） */
function prepareSheets(payload) {
  const p = payload || {};
  const perf = Array.isArray(p.perf) ? p.perf : [];
  const tags = normalizeTags(p.tag);
  const flatRows = perf.map(r => flattenRow(r));
  const knownKeys = [];
  const seen = new Set();
  for (const f of flatRows) {
    for (const k of Object.keys(f)) {
      if (SKIP_KEYS.has(k) || seen.has(k)) continue;
      seen.add(k); knownKeys.push(k);
    }
  }

  const order = Array.isArray(p.metricOrder) && p.metricOrder.length
    ? p.metricOrder.filter(k => GROUP_DEFS.some(g => g.key === k)) : [];
  for (const k of DEFAULT_ORDER) if (!order.includes(k)) order.push(k);
  for (const g of GROUP_DEFS) if (!order.includes(g.key)) order.push(g.key);

  // 口径元数据：writeDataJs 可能已经算过，直接复用；独立调用（如测试）时现场推导
  let prov = p.provenance || null;
  if (!prov) {
    try {
      const diag = p.diagnostics || null;
      prov = Schema.buildProvenance(perf, (p.device && p.device.category) || p.category || '', {
        tickMs: diag && diag.tickMs,
        truncated: diag && diag.droppedSamples,
        spilled: diag && diag.segments && diag.segments.spilledPoints,
      });
    } catch (_) { prov = null; }
  }

  // 0.2 / 1.2：平台不支持的组不生成空标签页；整机流量时列名直接带口径
  const unsupported = new Set(unsupportedGroupsOf(p));
  const labelOf = (netIsDeviceLabel(prov))
    ? (k) => (k === 'net.rxKBps' || k === 'rxKBps' ? '整机流量·下行 (KB/s)'
      : k === 'net.txKBps' || k === 'txKBps' ? '整机流量·上行 (KB/s)' : labelFor(k))
    : labelFor;

  return { p, perf, tags, flatRows, knownKeys, order, prov, unsupported, labelOf };
}

function makeGroupSheet(ctx, key) {
  if (ctx.unsupported.has(key)) return null;
  const def = GROUP_DEFS.find(g => g.key === key);
  if (!def) return null;
  const sh = groupSheet(def, ctx.flatRows, ctx.perf, ctx.tags, ctx.knownKeys, ctx.labelOf);
  if (!sh) return null;
  sh.columns.forEach(k => ctx.assigned.add(k));
  return { name: sh.name, rows: sh.rows };
}

function makeTailSheets(ctx) {
  const out = [];
  const others = otherSheet(ctx.flatRows, ctx.perf, ctx.tags, ctx.assigned);
  if (others) out.push({ name: others.name, rows: others.rows });
  out.push(tagSheet(ctx.flatRows, ctx.perf, ctx.tags));
  out.push(rawSheet(ctx.flatRows, ctx.perf, ctx.tags));
  return out;
}

function buildSheets(payload) {
  const ctx = prepareSheets(payload);
  ctx.assigned = new Set();
  const sheets = [summarySheet(ctx.p, ctx.flatRows, ctx.tags, ctx.prov)];
  const q = qualitySheet(ctx.prov, ctx.p);
  if (q) sheets.push(q);
  for (const key of ctx.order) {
    const sh = makeGroupSheet(ctx, key);
    if (sh) sheets.push(sh);
  }
  for (const sh of makeTailSheets(ctx)) sheets.push(sh);
  return sheets;
}

/**
 * 异步建表：每建完一个分组表让出一次事件循环。
 * 12 小时报告建表要 1.6s，一次做完就是窗口无响应；拆开后每段约 150ms。
 */
async function buildSheetsAsync(payload) {
  const ctx = prepareSheets(payload);
  ctx.assigned = new Set();
  const sheets = [summarySheet(ctx.p, ctx.flatRows, ctx.tags, ctx.prov)];
  const q = qualitySheet(ctx.prov, ctx.p);
  if (q) sheets.push(q);
  await new Promise(r => setImmediate(r));
  for (const key of ctx.order) {
    const sh = makeGroupSheet(ctx, key);
    if (sh) sheets.push(sh);
    await new Promise(r => setImmediate(r));
  }
  for (const sh of makeTailSheets(ctx)) sheets.push(sh);
  return sheets;
}

function suggestXlsxName(payload, when) {
  const p = payload || {};
  const app = String((p.device && (p.device.appName || p.device.bundleId)) || 'Perfara')
    .replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 40) || 'Perfara';
  const d = when || new Date();
  const p2 = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`
    + `-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  return `Perfara_${app}_${stamp}.xlsx`;
}

/**
 * 文件名只到秒，同一应用在同一秒内停两次会互相覆盖 —— 直接覆盖等于静默丢数据。
 * 撞名时依次尝试 `_2`、`_3`…（上限 99，之后才退回覆盖）。
 */
function uniquePath(dir, name) {
  const base = name.replace(/\.xlsx$/i, '');
  let p = path.join(dir, name);
  for (let i = 2; i <= 99 && fs.existsSync(p); i++) p = path.join(dir, `${base}_${i}.xlsx`);
  return p;
}

/**
 * 决定 Excel 的落盘目录与文件名。
 *
 * 有本次归档信息（archive = reportsDataJs.getLastArchive()）时，写进 history/，
 * 与本次报告的 <id>.js 同名同目录（<id>.xlsx），提取时报告与数据一一对应；
 * 没有归档信息（归档失败 / 独立导出）时，维持原行为：写 data.js 所在根目录。
 *
 * @param {object} payload
 * @param {string} dataJsPath
 * @param {{id:string, dir:string}|null} archive
 */
function resolveXlsxTarget(payload, dataJsPath, archive) {
  if (archive && archive.id && archive.dir) {
    const safe = String(archive.id).replace(/[\\/:*?"<>|]/g, '_');
    return { dir: archive.dir, name: safe + '.xlsx' };
  }
  return { dir: path.dirname(dataJsPath), name: suggestXlsxName(payload) };
}

/**
 * 写到 data.js 所在的报告目录（自动跟随 userData fallback，避免只读安装目录写失败）。
 * 传入 archive 时改为与历史报告同名归档到 history/（见 resolveXlsxTarget）。
 * @returns {{file:string, bytes:number, sheets:string[]}}
 */
function writeRunXlsx(payload, dataJsPath, archive) {
  if (!dataJsPath) throw new Error('缺少报告目录（data.js 路径）');
  const t = resolveXlsxTarget(payload, dataJsPath, archive);
  fs.mkdirSync(t.dir, { recursive: true });
  const sheets = buildSheets(payload);
  const buf = Writer.buildXlsx(sheets, {
    title: `Perfara 采集数据 · ${(payload.device && payload.device.appName) || ''}`,
    creator: 'Perfara',
  });
  const file = uniquePath(t.dir, t.name);
  fs.writeFileSync(file, buf);
  return { file, bytes: buf.length, sheets: sheets.map(s => s.name) };
}

/**
 * 异步导出（主进程用这条）：建表、拼 XML、压缩都分帧，不再冻结窗口。
 * 返回结构与会话同步版一致，调用方只改 await。
 */
async function writeRunXlsxAsync(payload, dataJsPath, archive) {
  if (!dataJsPath) throw new Error('缺少报告目录（data.js 路径）');
  const t = resolveXlsxTarget(payload, dataJsPath, archive);
  await fs.promises.mkdir(t.dir, { recursive: true });
  const sheets = await buildSheetsAsync(payload);
  const buf = await Writer.buildXlsxAsync(sheets, {
    title: `Perfara 采集数据 · ${(payload.device && payload.device.appName) || ''}`,
    creator: 'Perfara',
  });
  const file = uniquePath(t.dir, t.name);
  await fs.promises.writeFile(file, buf);
  return { file, bytes: buf.length, sheets: sheets.map(s => s.name) };
}

module.exports = {
  buildSheets, buildSheetsAsync, writeRunXlsx, writeRunXlsxAsync, suggestXlsxName, uniquePath, resolveXlsxTarget,
  flattenRow, normalizeTags,
  tagLabelFor, labelFor, fmtTs, GROUP_DEFS, DEFAULT_ORDER, qualitySheet, summarySheet,
  platformOf, unsupportedGroupsOf, PLATFORM_UNSUPPORTED_GROUPS, PLATFORM_SCOPE_NOTE,
};
