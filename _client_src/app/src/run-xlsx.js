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
const { buildXlsx } = require('./xlsx-writer');

const DEFAULT_ORDER = ['fps', 'cpu', 'mem', 'net', 'gpu', 'temp', 'battery'];

/** 字段路径 → 中文表头。未列出的字段回退用原始路径。 */
const FIELD_LABELS = {
  timestamp: '时间戳 (ms)', time: '采样时间', pid: '进程 PID',
  fps: 'FPS (帧/秒)', jank: 'Jank (帧)', bigJank: 'BigJank (帧)',
  smallJank: 'SmallJank (帧)', tinyJank: 'TinyJank (帧)', jankRate: 'JankRate (%)',
  'cpu.sysCpu': '系统 CPU (%)', 'cpu.procCpu': '进程 CPU (%)',
  cpuUsage: 'CPU 使用率 (%)', cpuTotalSystem: '系统态 CPU (%)', cpuTotalUser: '用户态 CPU (%)',
  'mem.totalPss': '总 PSS (MB)', 'mem.nativeHeap': 'Native Heap (MB)',
  'mem.javaHeap': 'Java Heap (MB)', 'mem.dalvikHeap': 'Dalvik Heap (MB)',
  'mem.code': 'Code (MB)', 'mem.stack': 'Stack (MB)', 'mem.graphics': 'Graphics (MB)',
  'mem.privateOther': 'PrivateOther (MB)', 'mem.system': 'System (MB)',
  physFootprint: '物理内存占用 (MB)', memResidentSize: '常驻内存 (MB)',
  memVirtualSize: '虚拟内存 (MB)', memRPrvt: '私有内存 (MB)', memRShrd: '共享内存 (MB)',
  memAnon: '匿名内存 (MB)', memCompressed: '压缩内存 (MB)', memPurgeable: '可清理内存 (MB)',
  'net.rxKBps': '下行 (KB/s)', 'net.txKBps': '上行 (KB/s)',
  rxKBps: '下行 (KB/s)', txKBps: '上行 (KB/s)',
  temperature: '机身温度 (°C)', tempSource: '温度来源',
  gpuTemp: 'GPU 结温 (°C)', cpuTemp: 'CPU 结温 (°C)',
  batteryTemp: '电池温度 (°C)', skinTemp: '外壳估算温度 (°C)',
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
    prefixes: ['fps', 'jank', 'bigJank', 'smallJank', 'tinyJank', 'jankRate'],
    cols: ['fps', 'jank', 'bigJank', 'smallJank', 'tinyJank', 'jankRate'] },
  { key: 'cpu', name: 'CPU',
    prefixes: ['cpu', 'cpuCores', 'cpuUsage', 'cpuTotalSystem', 'cpuTotalUser'],
    cols: ['cpu.sysCpu', 'cpu.procCpu', 'cpuUsage', 'cpuTotalSystem', 'cpuTotalUser'] },
  { key: 'mem', name: '内存',
    prefixes: ['mem', 'physFootprint', 'memResidentSize', 'memVirtualSize', 'memRPrvt',
      'memRShrd', 'memAnon', 'memCompressed', 'memPurgeable'],
    cols: ['mem.totalPss', 'mem.nativeHeap', 'mem.javaHeap', 'mem.dalvikHeap',
      'mem.code', 'mem.stack', 'mem.graphics', 'mem.privateOther', 'mem.system',
      'physFootprint', 'memResidentSize', 'memVirtualSize', 'memRPrvt', 'memRShrd',
      'memAnon', 'memCompressed', 'memPurgeable'] },
  { key: 'net', name: '网络',
    prefixes: ['net', 'rxKBps', 'txKBps'],
    cols: ['net.rxKBps', 'net.txKBps', 'rxKBps', 'txKBps'] },
  { key: 'gpu', name: 'GPU', prefixes: ['gpu'], cols: ['gpu'] },
  { key: 'temp', name: '温度',
    prefixes: ['temperature', 'tempSource', 'gpuTemp', 'cpuTemp', 'batteryTemp', 'skinTemp'],
    cols: ['temperature', 'tempSource', 'gpuTemp', 'cpuTemp', 'batteryTemp', 'skinTemp'] },
  { key: 'battery', name: '电池',
    prefixes: ['battery'],
    cols: ['battery.level', 'battery.voltage', 'battery.temperature',
      'battery.currentNow', 'battery.power'] },
];

// time / timestamp 在各表都已单独成列，避免重复；pid 保留为普通字段进「原始采样」
const SKIP_KEYS = new Set(['timestamp', 'time']);

// 标识类字段不是性能指标：只在「原始采样」保留，不进「其他指标」，
// 否则真机上会多出一张只有一列「进程 PID」的空壳表。
const ID_KEYS = new Set(['pid']);

// ── 数据整形 ────────────────────────────────────────────────────────────────

/** 把一拍采样摊平成 { 'cpu.sysCpu': 12, 'cpuCores.usage[0]': 5, ... } */
function flattenRow(row, prefix, out) {
  out = out || {};
  if (!row || typeof row !== 'object') return out;
  for (const k of Object.keys(row)) {
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

function summarySheet(payload, flatRows, tags) {
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

  const metrics = [
    ['FPS', 'fps', '帧/秒'], ['Jank', 'jank', '帧'], ['BigJank', 'bigJank', '帧'],
    ['系统 CPU', 'cpu.sysCpu', '%'], ['进程 CPU', 'cpu.procCpu', '%'],
    ['总 PSS', 'mem.totalPss', 'MB'], ['下行', 'net.rxKBps', 'KB/s'],
    ['上行', 'net.txKBps', 'KB/s'], ['机身温度', 'temperature', '°C'],
    ['电量', 'battery.level', '%'], ['GPU 利用率', 'gpu', '%'],
  ];
  for (const [name, key, unit] of metrics) {
    if (!flatRows.some(f => f[key] != null && f[key] !== '')) continue;
    const s = stat(numbersAt(flatRows, key, 0, flatRows.length - 1));
    rows.push([name, s.mean, r2(s.min), r2(s.max), unit, s.n]);
  }
  rows.push([]);
  rows.push(['说明', '未测量到的指标留空，不写 0；各性能明细见底部对应标签页']);
  rows.push(['标记区间', tags.length ? '见「标记区间」标签页；明细表最后一列标出每个采样点所属区间' : '本轮未打标记（采集窗口用「开始标记 / 结束标记」划分）']);
  return { name: '汇总', rows };
}

function groupSheet(def, flatRows, perf, tags, knownKeys) {
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

  const rows = [['序号', '采样时间', '标记区间', ...usable.map(labelFor)]];
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
function buildSheets(payload) {
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

  const sheets = [summarySheet(p, flatRows, tags)];
  const assigned = new Set();
  for (const key of order) {
    const def = GROUP_DEFS.find(g => g.key === key);
    const sh = groupSheet(def, flatRows, perf, tags, knownKeys);
    if (!sh) continue;
    sh.columns.forEach(k => assigned.add(k));
    sheets.push({ name: sh.name, rows: sh.rows });
  }
  const others = otherSheet(flatRows, perf, tags, assigned);
  if (others) sheets.push({ name: others.name, rows: others.rows });
  sheets.push(tagSheet(flatRows, perf, tags));
  sheets.push(rawSheet(flatRows, perf, tags));
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
 * 写到 data.js 所在的报告目录（自动跟随 userData fallback，避免只读安装目录写失败）。
 * @returns {{file:string, bytes:number, sheets:string[]}}
 */
function writeRunXlsx(payload, dataJsPath) {
  if (!dataJsPath) throw new Error('缺少报告目录（data.js 路径）');
  const dir = path.dirname(dataJsPath);
  fs.mkdirSync(dir, { recursive: true });
  const sheets = buildSheets(payload);
  const buf = buildXlsx(sheets, {
    title: `Perfara 采集数据 · ${(payload.device && payload.device.appName) || ''}`,
    creator: 'Perfara',
  });
  const file = uniquePath(dir, suggestXlsxName(payload));
  fs.writeFileSync(file, buf);
  return { file, bytes: buf.length, sheets: sheets.map(s => s.name) };
}

module.exports = {
  buildSheets, writeRunXlsx, suggestXlsxName, uniquePath, flattenRow, normalizeTags,
  tagLabelFor, labelFor, fmtTs, GROUP_DEFS, DEFAULT_ORDER,
};
