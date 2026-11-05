'use strict';
/**
 * 温度口径离线回归测试。
 *
 * 背景：真机（MTK 平台）实测 dumpsys thermalservice 的 CPU / GPU / NPU 结温为
 * 65.4°C，而 BATTERY 只有 36.0°C、SKIN 外壳估算 49.5°C。旧版
 * parseThermalService 优先取 CPU，把芯片结温当「机身温度」展示，
 * 造成「手摸不热却报 60 多度」的假高温。
 *
 * 本测试锁定修复后的分层口径：
 *   主温度 = 电池热敏电阻 > SKIN 外壳估算 > 其它机身传感器；
 *   只有芯片结温可读时主温度为 null（不编造机身温度），仅标记 source='die'。
 *   CPU / GPU 结温、SKIN 估算值单独返回，绝不混进主温度。
 *
 * 用法: node thermal_source_test.js
 */
const ADB = require('../../../_client_src/app/src/adb');
const Collector = require('../../../_client_src/app/src/collector');
const PC = require('../../../_client_src/app/src/pc-collector');
const Exporter = require('../../../_client_src/app/src/exporter');
const parse = ADB.parseThermalService;
const algo = ADB.__algo;

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; fails.push(name); console.log(`  FAIL  ${name}  ${detail !== undefined ? JSON.stringify(detail) : ''}`); }
}

function rows(list) {
  return list.map(([name, value, type]) =>
    `\tTemperature{mValue=${value}, mType=${type}, mName=${name}, mStatus=0}`).join('\n');
}
function dump(hal, cached, halFirst) {
  const halBlock = hal ? 'Current temperatures from HAL:\n' + rows(hal) : '';
  const cachedBlock = cached ? 'Cached temperatures:\n' + rows(cached) : '';
  const body = halFirst
    ? [halBlock, cachedBlock].filter(Boolean).join('\n')
    : [cachedBlock, halBlock].filter(Boolean).join('\n');
  return ['ThermalManagerService:', body, '\tCoolingDevice{mValue=0, mType=2, mName=cpu00}']
    .filter(Boolean).join('\n');
}

// 真机实测快照（脱敏：不含设备标识）
const HAL = [
  ['CPU', 65.43, 0], ['GPU', 65.43, 1], ['BATTERY', 36.0, 2],
  ['SKIN', 49.547, 3], ['POWER_AMPLIFIER', 45.666, 5], ['NPU', 65.43, 9],
];
const CACHED = [
  ['CPU', 58.372, 0], ['GPU', 58.372, 1], ['NPU', 58.372, 9],
  ['SKIN', 35.635, 3], ['BATTERY', 28.0, 2], ['POWER_AMPLIFIER', 33.5, 5],
];

console.log('\n===== 温度分层口径回归 =====\n');

// ── 1. 核心回归：不再把 CPU 结温当机身温度 ──────────────────────────────────
console.log('-- 真机快照：Cached 在前、HAL 在后 --');
const r = parse(dump(HAL, CACHED));
check('主温度取电池 36.0°C，不取 CPU 65.43°C', r && r.main === 36, r);
check('主温度落在手感区间（< 50°C）', r && r.main > 0 && r.main < 50, r && r.main);
check('主温度来源标记为 battery', r && r.source === 'battery', r && r.source);
check('CPU 结温单独保留 65.4°C', r && r.cpu === 65.4, r && r.cpu);
check('GPU 结温单独保留 65.4°C', r && r.gpu === 65.4, r && r.gpu);
check('SKIN 外壳估算单独保留 49.5°C', r && r.skin === 49.5, r && r.skin);
check('电池温度单独保留 36.0°C', r && r.battery === 36, r && r.battery);
check('用 HAL 实时值而非 Cached 旧值', r && r.battery === 36 && r.cpu === 65.4, r);

// ── 2. HAL 段在前时不能被后面的 Cached 段污染 ───────────────────────────────
console.log('-- HAL 段在前 / 只有 Cached 段 --');
const rHalFirst = parse(dump(HAL, CACHED, true));
check('HAL 在前时仍取 HAL 的 36.0°C', rHalFirst && rHalFirst.main === 36, rHalFirst);
const rCachedOnly = parse(dump(null, CACHED));
check('无 HAL 时退回 Cached 的电池 28.0°C', rCachedOnly && rCachedOnly.main === 28, rCachedOnly);
check('无 HAL 时也不取 Cached 的 CPU 58.4°C', rCachedOnly && rCachedOnly.cpu === 58.4, rCachedOnly);

// ── 3. 各类降级路径 ─────────────────────────────────────────────────────────
console.log('-- 传感器缺失时的降级 --');
const rSkinOnly = parse(dump([['CPU', 65.43, 0], ['SKIN', 41.2, 3]], null));
check('无 BATTERY 时取 SKIN 41.2°C', rSkinOnly && rSkinOnly.main === 41.2 && rSkinOnly.source === 'skin', rSkinOnly);
const rDieOnly = parse(dump([['CPU', 65.43, 0], ['GPU', 65.43, 1], ['NPU', 65.43, 9]], null));
check('只有结温时主温度为 null，结温仍保留并标记 die',
  rDieOnly && rDieOnly.main === null && rDieOnly.source === 'die' && rDieOnly.cpu === 65.4, rDieOnly);
const rBoard = parse(dump([['CPU', 65.43, 0], ['POWER_AMPLIFIER', 45.666, 5], ['BOARD', 38.5, 8]], null));
check('有机身传感器时取机身、排除结温', rBoard && rBoard.main === 38.5, rBoard);

// ── 4. 异常输入 ─────────────────────────────────────────────────────────────
console.log('-- 异常与边界 --');
check('无 Temperature 行返回 null', parse('ThermalManagerService:\n\tCoolingDevice{mValue=0}') === null);
check('空输入返回 null', parse('') === null && parse(null) === null);
const rBad = parse(dump([['CPU', 0, 0], ['BATTERY', 200, 2], ['SKIN', 36.6, 3]], null));
check('0 / 200 等异常值被过滤，取有效 SKIN', rBad && rBad.main === 36.6, rBad);

// ── 5. 采集数据白名单：新字段不能被配置过滤丢掉 ─────────────────────────────
console.log('-- collector 字段白名单 --');
const sample = {
  timestamp: 1, time: 'x', pid: 2,
  temperature: 36, tempSource: 'battery', gpuTemp: 65.4,
  cpuTemp: 65.4, batteryTemp: 36, skinTemp: 49.5, gpu: null,
};
const full = Collector.filterDataByConfig(sample, Collector.normalizeMetricConfig(null));
for (const k of ['temperature', 'tempSource', 'gpuTemp', 'cpuTemp', 'batteryTemp', 'skinTemp']) {
  check(`默认配置保留 ${k}`, Object.prototype.hasOwnProperty.call(full, k), full);
}
const noTemp = Collector.filterDataByConfig(sample, Collector.normalizeMetricConfig({ temp: false }));
for (const k of ['temperature', 'tempSource', 'gpuTemp', 'cpuTemp', 'batteryTemp', 'skinTemp']) {
  check(`关闭温度组后移除 ${k}`, !Object.prototype.hasOwnProperty.call(noTemp, k), noTemp);
}

// ── 6. 电池电压 / 电流单位（纯函数，离线锁定口径） ──────────────────────────
// 真机实测（Android 13 中端机型）：voltage=4(V)、current_now=-227 / current_max=2000 → mA 量级；
// AOSP 标准机型同名字段是 µV / µA。旧链路只看数值猜单位，报告页又无条件 /1000。
console.log('-- 电池单位换算 --');
const vMv = algo.normalizeBatteryVoltageMv;
const iMa = algo.normalizeCurrentMa;
check('标准 mV 电压原样保留', vMv(4200) === 4200, vMv(4200));
check('OPLUS V 电压转 mV', vMv(4) === 4000, vMv(4));
check('µV 电压转 mV', vMv(4200000) === 4200, vMv(4200000));
check('电压读不到写 null 而不是 0V', vMv(null) === null && vMv(0) === null && vMv(NaN) === null);
check('AOSP µA 机型转 mA 且保留充电负号', iMa(-227000, true) === -227, iMa(-227000, true));
check('OPLUS mA 机型原样保留负号', iMa(-227, false) === -227, iMa(-227, false));
check('低电流 µA 不再被误判成 mA（旧阈值盲区）', iMa(5000, true) === 5, iMa(5000, true));
check('未标单位时按量级兜底 400000µA → 400mA', iMa(400000) === 400, iMa(400000));
check('未标单位时 500mA 不再被除 1000', iMa(500) === 500, iMa(500));
check('电流读不到写 null', iMa('N/A') === null && iMa(null) === null);
check('真实 0 电流保留 0（与「未测量」区分）', iMa(0, false) === 0);

// ── 7. PC 侧「无数据 ≠ 0」与结温不顶替机身温度 ──────────────────────────────
console.log('-- PC 侧 null 语义 --');
const pcZero = PC.nullIfUnavailable({
  temperature: 0, cpuTemp: 61,
  battery: { level: 0, voltage: 0, temperature: 61, currentNow: 0, power: 0 },
});
check('PC 温度 0 折成 null', pcZero.temperature === null, pcZero.temperature);
check('台式机无电池时 battery 整组为 null（CPU 结温不能当电池证据）', pcZero.battery === null, pcZero.battery);
check('PC CPU 结温单独保留', pcZero.cpuTemp === 61, pcZero.cpuTemp);
const pcBat = PC.nullIfUnavailable({ temperature: null, cpuTemp: 61,
  battery: { level: 80, voltage: 7500, temperature: null, currentNow: -200, power: 1500 } });
check('有电池时保留整组', pcBat.battery && pcBat.battery.level === 80, pcBat.battery);
const pcFull = PC.filterPcData({ timestamp: 1, time: 'x', pid: 2,
  temperature: null, cpuTemp: 61, fps: 60 }, PC.normalizePcMetricConfig(null));
check('PC 默认配置保留 cpuTemp', pcFull.cpuTemp === 61, pcFull);
const pcNoTemp = PC.filterPcData({ timestamp: 1,
  temperature: null, cpuTemp: 61, fps: 60 }, PC.normalizePcMetricConfig({ temp: false }));
check('PC 关闭温度组后 temperature / cpuTemp 一起移除',
  !Object.prototype.hasOwnProperty.call(pcNoTemp, 'temperature')
  && !Object.prototype.hasOwnProperty.call(pcNoTemp, 'cpuTemp'), pcNoTemp);
check('PC 关闭温度组不影响 fps', pcNoTemp.fps === 60, pcNoTemp);

// ── 8. CSV：未测量留空、CPU 结温不顶替机身温度 ──────────────────────────────
console.log('-- CSV 空值语义 --');
const csv = Exporter.toCSV([{
  timestamp: 1, time: 'x', pid: 2,
  cpu: { sysCpu: null, procCpu: null }, mem: { totalPss: null },
  net: { rxKBps: null, txKBps: null },
  battery: { level: null, voltage: null, temperature: null, currentNow: null, power: null },
  temperature: null, cpuTemp: 61.5,
}]);
const [csvHead, csvRow] = csv.split('\r\n');
const head = csvHead.split(',');
const cells = csvRow.split(',');
const col = (name) => head.indexOf(name);
check('CSV 列名标注 currentNow_mA / power_mW',
  head.includes('currentNow_mA') && head.includes('power_mW'), csvHead);
check('CSV 未测量的电流 / 功耗留空而不是 0',
  cells[col('currentNow_mA')] === '' && cells[col('power_mW')] === '', csvRow);
check('CSV 未测量的 sysCpu / 流量留空',
  cells[col('sysCpu')] === '' && cells[col('rxKBps')] === '', csvRow);
check('CSV 把 CPU 结温写入独立列 cpuTemp_die',
  cells[col('cpuTemp_die')] === '61.5', csvRow);
check('CSV 机身温度无数据留空（不拿结温顶替）',
  cells[col('deviceTemp')] === '', csvRow);

console.log(`\n===== 结果: ${pass} PASS / ${fail} FAIL =====`);
if (fail) { console.log('失败项:', fails.join('; ')); process.exit(1); }
