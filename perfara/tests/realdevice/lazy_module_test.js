'use strict';
/**
 * 惰性模块加载（src/lazy-module.js）行为一致性测试。
 *
 * main.js 把 5 个采集/导出模块从「启动期同步 require」改成惰性加载，为避免
 * 代理语义与直接 require 出现偏差（构造函数、静态方法、模块级导出），这里逐项比对。
 */
const path = require('path');
const assert = require('assert');

const APP = path.resolve(__dirname, '..', '..', '..', '_client_src', 'app');
const { lazy } = require(path.join(APP, 'src', 'lazy-module'));

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  (' + extra + ')' : '')); }
}

// ── 1. 惰性：未触碰前不加载模块 ───────────────────────────────────────────
// 借助 require.cache 判断是否真的被 require 进来
const collectorPath = require.resolve(path.join(APP, 'src', 'collector'));
delete require.cache[collectorPath];
const Collector = lazy(path.join(APP, 'src', 'collector'));
check('创建代理时未加载模块', require.cache[collectorPath] === undefined);
check('__lazyLoaded 为 false', Collector.__lazyLoaded === false);

// ── 2. 构造函数：new 出来的实例与直接 require 一致 ─────────────────────────
const inst = new Collector('dev-1', 'com.demo.app', 1000, null);
check('new 之后模块已加载', require.cache[collectorPath] !== undefined);
check('__lazyLoaded 变为 true', Collector.__lazyLoaded === true);
const RealCollector = require(path.join(APP, 'src', 'collector'));
check('实例是真实 Collector 的实例', inst instanceof RealCollector, inst.constructor.name);
check('构造参数被正确传入', inst.deviceId === 'dev-1' && inst.packageName === 'com.demo.app',
  `${inst.deviceId} / ${inst.packageName}`);

// ── 3. 静态方法（类本身作为 module.exports） ──────────────────────────────
check('静态方法 normalizeMetricConfig 可用',
  typeof Collector.normalizeMetricConfig === 'function');
const normA = Collector.normalizeMetricConfig({ fps: true, cpu: false });
const normB = RealCollector.normalizeMetricConfig({ fps: true, cpu: false });
check('静态方法结果与直接调用一致', JSON.stringify(normA) === JSON.stringify(normB),
  JSON.stringify(normA));
check('静态常量 ANDROID_METRIC_KEYS 可读（对象形式，与真实模块一致）',
  Collector.ANDROID_METRIC_KEYS &&
  JSON.stringify(Collector.ANDROID_METRIC_KEYS) === JSON.stringify(RealCollector.ANDROID_METRIC_KEYS),
  Object.keys(Collector.ANDROID_METRIC_KEYS || {}).length + ' 组');

// ── 4. 模块导出对象的场景（pc-collector、exporter） ──────────────────────
const PcCollector = lazy(path.join(APP, 'src', 'pc-collector'), 'PcCollector');
const PcCollectorMod = lazy(path.join(APP, 'src', 'pc-collector'));
check('pick 出来的是类', typeof PcCollector === 'function' && PcCollector.name === 'PcCollector',
  PcCollector.name);
const pcInst = new PcCollector('C:\\demo\\app.exe', null);
const RealPcMod = require(path.join(APP, 'src', 'pc-collector'));
check('pick 实例类型正确', pcInst instanceof RealPcMod.PcCollector, pcInst.constructor.name);
check('模块级静态方法可用', typeof PcCollectorMod.normalizePcMetricConfig === 'function');
check('模块级静态方法结果一致',
  JSON.stringify(PcCollectorMod.normalizePcMetricConfig({ cpu: true })) ===
  JSON.stringify(RealPcMod.normalizePcMetricConfig({ cpu: true })));

const Exporter = lazy(path.join(APP, 'src', 'exporter'));
const csv = Exporter.toCSV([{ time: '10:00:00', fps: 60 }]);
const realCsv = require(path.join(APP, 'src', 'exporter')).toCSV([{ time: '10:00:00', fps: 60 }]);
check('Exporter.toCSV 结果一致', csv === realCsv, JSON.stringify(String(csv).slice(0, 40)));

// ── 5. iOS 两个采集器（类 + 静态方法） ────────────────────────────────────
const IosCollector = lazy(path.join(APP, 'src', 'ios-collector'));
check('IosCollector 静态方法 resolveIosBin 可用', typeof IosCollector.resolveIosBin === 'function');
check('IosCollector 静态方法 getLockdownDeviceInfo 可用',
  typeof IosCollector.getLockdownDeviceInfo === 'function');
const IosGpuCollector = lazy(path.join(APP, 'src', 'ios-gpu-collector'));
check('IosGpuCollector 可 new', typeof new IosGpuCollector('com.demo', 'app', 'udid', null, null) === 'object');

// ── 6. 重复加载应命中缓存，不重复 require ─────────────────────────────────
const before = require.cache[collectorPath];
const Collector2 = lazy(path.join(APP, 'src', 'collector'));
Collector2.normalizeMetricConfig({});
check('同一模块复用缓存，未重复加载', require.cache[collectorPath] === before);

// ── 7. 访问不存在的属性应与真实模块一致（都返回 undefined） ───────────────
check('不存在的属性返回 undefined（与真实模块一致）',
  Collector.__notExist === undefined && RealCollector.__notExist === undefined);

// ── 8. 相对路径基准（回归：main.js 里的写法必须可用） ─────────────────────
// main.js 位于 app 根目录，写的是 lazy('./src/collector')；早期实现直接
// require('./src/collector')，基准落在 src/ 上，打包后解析成 src/src/collector，
// 点「开始」立即报 Cannot find module。这里锁定「相对路径以 app 根目录为基准」。
const relChecks = [
  ['./src/collector', (M) => typeof M.normalizeMetricConfig === 'function'],
  ['./src/pc-collector', (M) => typeof M.PcCollector === 'function'],
  ['./src/ios-collector', (M) => typeof M.resolveIosBin === 'function'],
  ['./src/ios-gpu-collector', (M) => typeof M === 'function'],
  ['./src/exporter', (M) => typeof M.toCSV === 'function'],
];
for (const [rel, pred] of relChecks) {
  const target = require.resolve(path.join(APP, rel.replace(/^\.\//, '').replace(/\//g, path.sep)));
  delete require.cache[target];
  const M = lazy(rel);
  let ok = false;
  let err = '';
  try {
    ok = pred(M) === true;
  } catch (e) {
    err = e.message;
  }
  check(`相对路径 ${rel} 可解析（app 根目录为基准）`, ok, err);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
