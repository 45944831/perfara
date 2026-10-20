'use strict';
/**
 * PC 采集真机测试（本机 Windows）。
 *   1) 直接驱动内置 Python + collect_pc_perf.pyc 对真实进程采样
 *   2) 验证采样字段完整性/合理性
 *   3) 验证 filterPcData 的采集参数过滤
 *   4) 验证「读不到的指标折成 null」而不是误导性的 0
 *   5) 验证 PresentMon 无数据时 fpsSource 标记存在（用于提示管理员权限）
 *
 * 用法: node pc_realdevice_test.js [exePath] [seconds]
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Module = require('module');

const _origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return { app: { isPackaged: false, getPath: () => __dirname, getName: () => 'perfara' } };
  }
  return _origLoad.apply(this, arguments);
};

const PC = require('../../../_client_src/app/src/pc-collector');

// 项目重构后采集器资源位于 perfara/collector/resources（旧版为 Perfara-Portable/collector/resources）
const PORTABLE_ROOT = path.resolve(__dirname, '../../collector/resources');
const PY = path.join(PORTABLE_ROOT, 'ios-tools', 'python', 'python', 'python.exe');
const SCRIPT = path.join(PORTABLE_ROOT, 'ios-tools', 'python', 'python', 'Scripts', 'collect_pc_perf.pyc');
const EXE = process.argv[2] || 'C:\\Windows\\explorer.exe';
const SECONDS = parseInt(process.argv[3] || '12', 10);

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; fails.push(name); console.log(`  FAIL  ${name}  ${detail !== undefined ? JSON.stringify(detail) : ''}`); }
}
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

console.log('\n===== PC 采集真机测试 =====\n');
console.log(`目标进程: ${EXE}`);
console.log(`Python  : ${PY}`);
console.log(`脚本    : ${SCRIPT}\n`);

if (!fs.existsSync(PY)) { console.log('内置 Python 不存在，无法测试'); process.exit(2); }
if (!fs.existsSync(SCRIPT)) { console.log('collect_pc_perf.pyc 不存在，无法测试'); process.exit(2); }

const rows = [];
const stderrLines = [];
const child = spawn(PY, ['-u', SCRIPT, EXE], { cwd: path.dirname(SCRIPT), stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (c) => {
  for (const line of c.toString('utf8').split('\n')) {
    const t = line.trim();
    if (!t || !t.startsWith('{')) continue;
    try { rows.push(JSON.parse(t)); } catch (_) {}
  }
});
child.stderr.on('data', (c) => stderrLines.push(c.toString('utf8').trim()));

setTimeout(() => { try { child.kill(); } catch (_) {} }, SECONDS * 1000);

child.on('close', () => run());

function run() {
  console.log(`采集到 ${rows.length} 条数据`);
  if (stderrLines.length) {
    console.log('  脚本 stderr:');
    stderrLines.slice(0, 6).forEach(l => console.log('    ', l.slice(0, 160)));
  }
  const first = rows[0];
  if (first) console.log('  首条:', JSON.stringify(first).slice(0, 400));

  const notRunning = rows.find(r => r.error === 'not_running');
  if (notRunning) {
    console.log(`\n目标进程未运行: ${notRunning.message || ''}`);
    check('目标进程应处于运行状态', false, notRunning.message);
    done();
    return;
  }

  // 快照原始数据：后续 filterPcData 不应回写污染源对象
  const rawSnapshot = JSON.parse(JSON.stringify(rows));

  check('采集到数据', rows.length >= 3, rows.length);

  const need = ['timestamp', 'time', 'pid', 'cpu', 'mem', 'fps', 'jank', 'bigJank', 'jankRate',
    'net', 'battery', 'temperature', 'gpu', 'cpuCores', 'pcExtra'];
  const missing = need.filter(k => rows.every(r => r[k] === undefined));
  check('字段齐全', missing.length === 0, missing);

  check('pid 为正整数', rows.every(r => Number.isInteger(r.pid) && r.pid > 0), rows.map(r => r.pid).slice(0, 3));
  check('cpu.sysCpu 为数值且 0..100', rows.every(r => !r.cpu || (isNum(r.cpu.sysCpu) && r.cpu.sysCpu >= 0 && r.cpu.sysCpu <= 100)), rows.map(r => r.cpu && r.cpu.sysCpu).slice(0, 5));
  check('mem.totalPss > 0', rows.some(r => r.mem && r.mem.totalPss > 0), rows.map(r => r.mem && r.mem.totalPss).slice(0, 3));
  check('cpuCores.usage 非空且在 0..100', rows.every(r => Array.isArray(r.cpuCores && r.cpuCores.usage) && r.cpuCores.usage.length > 0 && r.cpuCores.usage.every(v => v >= 0 && v <= 100)), rows[0] && rows[0].cpuCores && rows[0].cpuCores.usage);
  check('cpuCores.freq 非空', rows.every(r => Array.isArray(r.cpuCores && r.cpuCores.freq) && r.cpuCores.freq.length > 0), rows[0] && rows[0].cpuCores && rows[0].cpuCores.freq);
  check('net 速率非负', rows.every(r => !r.net || (r.net.rxKBps >= 0 && r.net.txKBps >= 0)), rows.map(r => r.net).slice(0, 3));
  check('gpu 为 null 或 0..100', rows.every(r => r.gpu === null || r.gpu === undefined || (r.gpu >= 0 && r.gpu <= 100)), rows.map(r => r.gpu).slice(0, 6));
  check('jank 家族非负', rows.every(r => [r.jank, r.bigJank, r.jankRate].every(v => v === undefined || (isNum(v) && v >= 0))), rows.map(r => [r.jank, r.bigJank, r.jankRate]).slice(0, 3));
  check('pcExtra 含 exe/name', rows.every(r => r.pcExtra && r.pcExtra.name), rows[0] && rows[0].pcExtra);
  check('pcExtra 含 fpsSource 标记', rows.every(r => r.pcExtra && typeof r.pcExtra.fpsSource === 'string'), rows.map(r => r.pcExtra && r.pcExtra.fpsSource).slice(0, 5));

  // ── 采集参数过滤 ──
  const cfg = { fps: true, cpu: true, mem: true, net: false, gpu: false, temp: false, battery: false, disk: false };
  const norm = PC.normalizePcMetricConfig(cfg);
  check('normalizePcMetricConfig 保留显式开关', norm.net === false && norm.gpu === false && norm.fps === true, norm);
  check('normalizePcMetricConfig 缺省全开', Object.values(PC.normalizePcMetricConfig(null)).every(v => v === true), PC.normalizePcMetricConfig(null));

  const filtered = rows.map(r => PC.filterPcData(r, norm));
  check('过滤后无 net', filtered.every(r => r.net === undefined), filtered[0] && Object.keys(filtered[0]));
  check('过滤后无 gpu', filtered.every(r => r.gpu === undefined), filtered[0] && Object.keys(filtered[0]));
  check('过滤后无 temperature', filtered.every(r => r.temperature === undefined), filtered[0] && Object.keys(filtered[0]));
  check('过滤后无 battery', filtered.every(r => r.battery === undefined), filtered[0] && Object.keys(filtered[0]));
  check('过滤后保留 cpu', filtered.every(r => r.cpu !== undefined), filtered[0] && Object.keys(filtered[0]));
  check('disk 关闭后 pcExtra 不含磁盘读写', filtered.every(r => !r.pcExtra || (r.pcExtra.diskReadKBps === undefined && r.pcExtra.diskWriteKBps === undefined)), filtered[0] && filtered[0].pcExtra);
  check('disk 关闭后 pcExtra 仍保留进程名', filtered.every(r => r.pcExtra && r.pcExtra.name), filtered[0] && filtered[0].pcExtra);

  // ── 读不到的指标折成 null ──
  const observed = {
    tempZero: rawSnapshot.some(r => r.temperature === 0),
    batteryZero: rawSnapshot.some(r => r.battery && !r.battery.level && !r.battery.voltage),
  };
  console.log(`  观测: temperature=0 的采样 ${observed.tempZero ? '有' : '无'}, 电池全 0 ${observed.batteryZero ? '有' : '无'}`);

  const nul = PC.nullIfUnavailable({ temperature: 0, battery: { level: 0, voltage: 0, temperature: 0, currentNow: 0, power: 0 } });
  check('不可用的温度折成 null', nul.temperature === null, nul);
  check('无电池时电池折成 null', nul.battery === null, nul);
  const kept = PC.nullIfUnavailable({ temperature: 55, battery: { level: 80, voltage: 7500000, temperature: 30, currentNow: -200, power: 1500000 } });
  check('真实温度不被置空', kept.temperature === 55, kept);
  check('真实电池不被置空', kept.battery && kept.battery.level === 80, kept);

  const full = rows.map(r => PC.filterPcData(r, PC.normalizePcMetricConfig(null)));
  if (observed.tempZero) {
    check('全参数模式下不可用温度显示为 null', full.every(r => r.temperature === null), full.map(r => r.temperature).slice(0, 5));
  }
  if (observed.batteryZero) {
    check('无电池时不显示 0% 电量', full.every(r => r.battery === null), full.map(r => r.battery).slice(0, 3));
  }

  // 关键回归：过滤函数不得回写调用方持有的原始数据
  check('filterPcData 不污染入参原始数据',
    JSON.stringify(rows) === JSON.stringify(rawSnapshot),
    { now: rows[0] && rows[0].temperature, raw: rawSnapshot[0] && rawSnapshot[0].temperature });

  done();
}

function done() {
  console.log(`\n===== 结果: ${pass} PASS / ${fail} FAIL =====`);
  if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
  process.exit(fail ? 1 : 0);
}
