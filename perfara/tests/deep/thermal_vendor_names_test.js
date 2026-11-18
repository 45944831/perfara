'use strict';
/**
 * 温度传感器跨品牌统一解析守卫（2026-11-17）。
 *
 * 背景：采集端旧版 parseThermalService 只认 AOSP 标准 mName（BATTERY/SKIN/CPU），
 * 而 Samsung 真机用 AP/BAT/LRB/LRF/LRP，国产 ROM 甚至用小写 battery 或带空格的
 * "test temperature sensor"，导致副标题「外壳 -- · 结温 --」。
 *
 * 全网取证结论：AOSP ThermalHAL types.hal 明确 mName "not standardised"，
 * mType 才是强制枚举（CPU=0 GPU=1 BATTERY=2 SKIN=3 USB=4 PA=5 BCL=6/7/8 NPU=9）。
 * 因此本项目改为「mType 权威 + mName 别名兜底」，并把所有取证样本固化在此。
 *
 * 用法: node thermal_vendor_names_test.js
 */
const ADB = require('../../../_client_src/app/src/adb');
const parse = ADB.parseThermalService;
const algo = ADB.__algo;
const classify = algo.classifyThermalRow;

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; fails.push(name); console.log(`  FAIL  ${name}  ${detail !== undefined ? JSON.stringify(detail) : ''}`); }
}

function row(name, value, type, status) {
  const bits = [`mValue=${value}`];
  if (type != null) bits.push(`mType=${type}`);
  if (name != null) bits.push(`mName=${name}`);
  if (status != null) bits.push(`mStatus=${status}`);
  return `\tTemperature{${bits.join(', ')}}`;
}
function dump(lines, status) {
  return [
    status == null ? '' : `Thermal Status: ${status}`,
    'Current temperatures from HAL:',
    ...lines,
  ].filter(Boolean).join('\n');
}

console.log('\n===== 温度传感器跨品牌统一解析守卫 =====\n');

// ── 1. mType 强制枚举：跨品牌稳定的分类依据 ─────────────────────────────────
console.log('-- AOSP mType 枚举（1.0 + 2.0）--');
const TYPE_EXPECT = [
  [0, 'cpu'], [1, 'gpu'], [2, 'battery'], [3, 'skin'],
  [4, 'peripheral'], [5, 'peripheral'],
  [6, 'nonTemp'], [7, 'nonTemp'], [8, 'nonTemp'], [9, 'die'],
];
for (const [type, want] of TYPE_EXPECT) {
  check(`mType=${type} 归为 ${want}（无名字干扰）`, classify('X_' + type, type) === want,
    classify('X_' + type, type));
}
check('mType 缺失时走 mName 兜底（BAT → battery）', classify('BAT', null) === 'battery');
check('mType=-1(UNKNOWN) 时走 mName 兜底', classify('SKIN', -1) === 'skin');

// ── 2. 六个真机/社区取证样本 ─────────────────────────────────────────────────
console.log('-- 取证样本：Samsung A52 5G / Android 12（StackExchange 246774）--');
const samsungA52 = dump([
  row('AP', 25.6, 0, 0), row('BAT', 23.8, 2, 0),
  row('LRB', 24.7, 3, 0), row('LRF', 24.7, 3, 0), row('LRP', 24.7, 3, 0),
  row('PA', 25.7, 5, 0), row('SUBBAT', 0.0, 2, 0), row('USB', 0.0, 4, 0),
], 0);
const a52 = parse(samsungA52);
check('A52 主值取 BAT 23.8（不是 AP 25.6）', a52 && a52.main === 23.8 && a52.source === 'battery', a52);
check('A52 结温 AP → cpuTemp 25.6', a52 && a52.cpu === 25.6, a52 && a52.cpu);
check('A52 外壳 LRB/LRF/LRP 平均 → skinTemp 24.7', a52 && a52.skin === 24.7, a52 && a52.skin);
check('A52 PA/USB 外围不进主值', a52 && a52.main < 26, a52 && a52.main);

console.log('-- 取证样本：Samsung Tab A7 Lite / Android 11（标准名对照）--');
const tabA7 = parse(dump([
  row('CPU', 29.1, 0, 0), row('GPU', 29.1, 1, 0), row('BATTERY', 24.0, 2, 0),
  row('SKIN', 26.0, 3, 0), row('POWER_AMPLIFIER', 25.0, 5, 0), row('NPU', 29.1, 9, 0),
]));
check('Tab A7 主值取电池 24.0', tabA7 && tabA7.main === 24 && tabA7.source === 'battery', tabA7);
check('Tab A7 GPU 结温单独保留 29.1', tabA7 && tabA7.gpu === 29.1, tabA7 && tabA7.gpu);
check('Tab A7 NPU(mType=9) 不冒充 CPU 结温', tabA7 && tabA7.cpu === 29.1 && tabA7.skin === 26, tabA7);

console.log('-- 取证样本：MediaTek 平台（GitHub gist AndroidHQ254）--');
const mtk = parse(dump([
  row('CPU', 67.233, 0, 0), row('GPU', 67.233, 1, 0), row('BATTERY', 34.8, 2, 0),
  row('SKIN', 38.36, 3, 0), row('POWER_AMPLIFIER', 37.714, 5, 0), row('NPU', 67.233, 9, 0),
]));
check('MTK 主值取电池 34.8，不取 CPU 结温 67.2', mtk && mtk.main === 34.8, mtk);
check('MTK 外壳 38.36 → skinTemp 38.4', mtk && mtk.skin === 38.4, mtk && mtk.skin);
check('MTK CPU 结温 67.2 单独保留', mtk && mtk.cpu === 67.2, mtk && mtk.cpu);

console.log('-- 取证样本：廉价国产平板（mName 带空格，旧正则整行丢弃）--');
const cheap = parse(dump([row('test temperature sensor', 30.8, 3, 0)]));
check('带空格 mName 能被解析', cheap && cheap.main === 30.8, cheap);
check('带空格 mName 按 mType=3 归为外壳', cheap && cheap.source === 'skin', cheap && cheap.source);

console.log('-- 取证样本：bytescope.dev 小写 mName --');
const lower = parse(dump([row('battery', 32.5, 2, 0)]));
check('小写 mName 能被解析（旧正则只认大写）', lower && lower.main === 32.5, lower);
check('小写 battery 归为电池主值', lower && lower.source === 'battery', lower && lower.source);

console.log('-- 取证样本：本机真机一手 dump（<DEVICE_SERIAL>）--');
const local = parse([
  'IsStatusOverride: false',
  'Thermal Status: 3',
  'Current temperatures from HAL:',
  row('AP', 61.7, 0, 0), row('BAT', 44.6, 2, 0),
  row('LRB', 42.8, 3, 0), row('LRF', 43.3, 3, 0), row('LRP', 43.3, 3, 3),
  row('PA', 49.2, 5, 0), row('SUBBAT', 0.0, 2, 0), row('USB', 40.1, 4, 0),
].join('\n'));
check('本机主值取 BAT 44.6（不再是 board 平均）', local && local.main === 44.6 && local.source === 'battery', local);
check('本机 AP → cpuTemp 61.7', local && local.cpu === 61.7, local && local.cpu);
check('本机外壳取 LRB+LRF 平均 43.1（LRP mStatus=3 已滤）',
  local && local.skin === 43.1, local && local.skin);
check('本机 Thermal Status=3 仍被解析', local && local.thermalStatus === 3, local && local.thermalStatus);

// ── 3. 安全边界：不能因为「统一集成」把非温度/结温混进主值 ────────────────────
console.log('-- 安全边界 --');
const bcl = parse(dump([
  row('BCL_PERCENTAGE', 80, 8, 0), row('BCL_VOLTAGE', 95, 6, 0),
  row('BCL_CURRENT', 70, 7, 0), row('SKIN', 36.5, 3, 0),
]));
check('BCL 虚拟传感器（mV/mA/%）不当作摄氏度', bcl && bcl.main === 36.5, bcl);
const board8 = parse(dump([row('BOARD', 38.5, 8, 0), row('CPU', 65.43, 0, 0)]));
check('非标准 ROM 的 mType=8 + BOARD 仍按名字救回',
  board8 && board8.main === 38.5 && board8.source === 'skin', board8);
const nanDump = 'Current temperatures from HAL:\n' + row('BATTERY', 'NaN', 2, 0) + '\n' + row('SKIN', 36.6, 3, 0);
check('mValue=NaN（无读数哨兵）被跳过', parse(nanDump).main === 36.6, parse(nanDump));
const dieOnly = parse(dump([row('AP', 61.7, 0, 0), row('PA', 49.2, 5, 0)]));
check('只有结温时主值仍为 null（不编造机身温度）',
  dieOnly && dieOnly.main === null && dieOnly.source === 'die', dieOnly);

// ── 4. 别名表关键项存在性 ────────────────────────────────────────────────────
console.log('-- 别名表完整性 --');
for (const name of ['BAT', 'BATTERY', 'SUBBAT', 'LRB', 'LRF', 'LRP', 'SKIN', 'AP', 'CPU', 'PA']) {
  check(`别名表含 ${name}`, Object.prototype.hasOwnProperty.call(algo.THERMAL_NAME_ALIAS, name));
}
check('别名表已导出（供后续品牌扩展单点维护）',
  algo.THERMAL_NAME_ALIAS && algo.THERMAL_TYPE_CATEGORY && typeof classify === 'function');

console.log(`\n===== 结果: ${pass} PASS / ${fail} FAIL =====`);
if (fail) { console.log('失败项:', fails.join('; ')); process.exit(1); }
