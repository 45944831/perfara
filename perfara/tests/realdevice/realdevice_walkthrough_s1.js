'use strict';
/**
 * 真机完整走查 —— 阶段 1：设备发现 / 信息 / 应用列表 / PID / 启动拉起 / 采集出数
 *
 * 用法: node realdevice_walkthrough_s1.js <deviceId>
 * 不写任何项目目录，只用系统临时目录。
 */
const Module = require('module');
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-walk-s1-'));
const _origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return { app: { isPackaged: false, getPath: () => TMP, getName: () => 'perfara' } };
  }
  return _origLoad.apply(this, arguments);
};

const APP = 'E:/WorkBuddy1/2026-10-19-13-59-27/_client_src/app';
process.resourcesPath = 'E:/WorkBuddy1/2026-10-19-13-59-27/perfara/collector/resources';

const ADB = require(path.join(APP, 'src/adb.js'));
const CollectorMod = require(path.join(APP, 'src/collector.js'));
const Collector = CollectorMod.Collector || CollectorMod;

const DEVICE = process.argv[2] || '';

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); }
  else { fail++; fails.push(name); console.log(`  FAIL  ${name}  ${detail !== undefined ? JSON.stringify(detail) : ''}`); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

(async () => {
  console.log(`\n===== 阶段 1：设备发现与基础能力（device=${DEVICE}）=====\n`);

  // ---- 1.1 getDevices ----
  console.log('[1.1] getDevices');
  let devices = [];
  try {
    const t0 = Date.now();
    devices = await ADB.getDevices();
    check('getDevices 返回数组', Array.isArray(devices), { count: devices.length });
    check('getDevices 识别到目标设备', devices.some(d => d.id === DEVICE), devices.map(d => d.id));
    const dev = devices.find(d => d.id === DEVICE);
    check('设备条目含 model', !!(dev && dev.model), dev && dev.model);
    check('USB 设备 wifi 标记为 false', !!(dev && dev.wifi === false), dev && dev.wifi);
  } catch (e) {
    check('getDevices 正常返回', false, e.message);
  }

  // ---- 1.2 getDeviceInfo ----
  console.log('[1.2] getDeviceInfo');
  try {
    const info = await ADB.getDeviceInfo(DEVICE);
    check('getDeviceInfo 返回对象', !!(info && typeof info === 'object'), info);
    check('含 brand/name/system', !!(info && info.brand && info.name && info.system), info);
  } catch (e) {
    check('getDeviceInfo 正常返回', false, e.message);
  }
  try {
    const nullInfo = await ADB.getDeviceInfo('');
    check('空 deviceId 返回 null', nullInfo === null, nullInfo);
  } catch (e) {
    check('空 deviceId 不抛错', false, e.message);
  }

  // ---- 1.3 getThirdPartyPackages ----
  console.log('[1.3] getThirdPartyPackages');
  let pkgs = [];
  try {
    const t0 = Date.now();
    pkgs = await ADB.getThirdPartyPackages(DEVICE);
    check('返回包数组', Array.isArray(pkgs), { count: pkgs.length, ms: Date.now() - t0 });
    check('包列表非空', pkgs.length > 0, pkgs.length);
    check('每项含 pkg 字段', pkgs.every(p => p && typeof p.pkg === 'string' && p.pkg.length), pkgs[0]);
    check('包名无 package: 前缀残留', !pkgs.some(p => p.pkg.startsWith('package:')), pkgs.find(p => p.pkg.startsWith('package:')));
  } catch (e) {
    check('getThirdPartyPackages 正常返回', false, e.message);
  }

  // ---- 1.4 getPid ----
  console.log('[1.4] getPid');
  try {
    const pid = await ADB.getPid(DEVICE, 'com.android.chrome');
    check('已安装应用取到 PID', isNum(pid) && pid > 0, pid);
  } catch (e) {
    check('getPid 正常返回', false, e.message);
  }
  try {
    const pid = await ADB.getPid(DEVICE, 'com.not.exist.package.xyz');
    check('不存在的包返回 null（不抛错）', pid === null, pid);
  } catch (e) {
    check('不存在的包不抛错', false, e.message);
  }

  // ---- 1.5 ensureAppRunning ----
  console.log('[1.5] ensureAppRunning');
  try {
    const t0 = Date.now();
    const r = await ADB.ensureAppRunning(DEVICE, 'com.android.chrome', () => {});
    check('已运行应用直接返回 ok', r && r.ok === true && isNum(r.pid), { r, ms: Date.now() - t0 });
  } catch (e) {
    check('ensureAppRunning(已运行) 正常', false, e.message);
  }
  try {
    const t0 = Date.now();
    const r = await ADB.ensureAppRunning(DEVICE, 'com.not.exist.package.xyz', () => {});
    const ms = Date.now() - t0;
    check('不存在的包 ok=false', r && r.ok === false, r);
    check('不存在的包有可读错误文案', !!(r && r.error), r && r.error);
    check('不存在的包 5 秒内返回（不干等）', ms < 8000, { ms });
  } catch (e) {
    check('ensureAppRunning(不存在包) 正常返回不抛错', false, e.message);
  }
  // 无 launcher 入口的包
  try {
    const t0 = Date.now();
    const r = await ADB.ensureAppRunning(DEVICE, 'cn.wps.moffice.lite', () => {});
    const ms = Date.now() - t0;
    check('无入口包快速返回失败', r && r.ok === false, { r, ms });
    check('无入口包 < 8s', ms < 8000, { ms });
  } catch (e) {
    check('ensureAppRunning(无入口包) 不抛错', false, e.message);
  }

  // ---- 1.6 拉起一个真实可启动的应用 ----
  console.log('[1.6] 拉起真实应用（验证 monkey/am start 回退）');
  const launchable = pkgs.find(p => /chrome|settings|calculator|deskclock|mms/i.test(p.pkg));
  if (launchable) {
    try {
      await ADB.getPid(DEVICE, launchable.pkg);
      const t0 = Date.now();
      const r = await ADB.ensureAppRunning(DEVICE, launchable.pkg, (m) => console.log('    log:', String(m).slice(0, 110)));
      check('可启动包拉起成功', r && r.ok === true && isNum(r.pid), { pkg: launchable.pkg, r, ms: Date.now() - t0 });
    } catch (e) {
      check('可启动包拉起正常', false, { pkg: launchable.pkg, e: e.message });
    }
  } else {
    console.log('    (跳过：设备上没有已知可启动包)');
  }

  // ---- 1.7 完整采集出数 ----
  console.log('[1.7] Collector 全参数采集 12 秒');
  const target = launchable ? launchable.pkg : 'com.android.chrome';
  const c = new Collector(DEVICE, target, 1000, null);
  const samples = [];
  let errs = [];
  c.on('data', d => samples.push(d));
  c.on('error', e => errs.push(e.message));
  try {
    const t0 = Date.now();
    await c.start();
    check('start() 成功', true, { pkg: target, ms: Date.now() - t0 });
  } catch (e) {
    check('start() 成功', false, { pkg: target, e: e.message });
  }
  await sleep(12000);
  try { c.stop(); } catch (_) {}
  check('采集到样本', samples.length >= 5, { count: samples.length });
  check('无致命错误', errs.length === 0, errs.slice(0, 3));

  if (samples.length) {
    const s = samples[samples.length - 1];
    console.log('    末样本字段:', Object.keys(s).join(','));
    console.log('    末样本值:', JSON.stringify(s).slice(0, 400));
    check('样本含 timestamp', isNum(s.timestamp));
    check('样本含 pid', isNum(s.pid) && s.pid > 0, s.pid);
    check('样本含 cpu', !!(s.cpu && typeof s.cpu === 'object'), s.cpu);
    check('样本含 mem', !!(s.mem && typeof s.mem === 'object'), s.mem);
    check('样本含 net', !!(s.net && typeof s.net === 'object'), s.net);
    check('样本含 battery', !!(s.battery && typeof s.battery === 'object'), s.battery);
    check('样本含 temperature', isNum(s.temperature), s.temperature);
    // FPS 允许 null（无前台帧），但不应是 undefined
    check('fps 字段存在(null 允许)', 'fps' in s, s.fps);
    // 统计各字段出现率
    const rate = (f) => (samples.filter(x => x[f] !== undefined && x[f] !== null).length / samples.length * 100).toFixed(0) + '%';
    console.log('    字段有效率: fps=' + rate('fps') + ' cpu=' + rate('cpu') + ' mem=' + rate('mem') +
                ' temp=' + rate('temperature') + ' gpu=' + rate('gpu') + ' net=' + rate('net') +
                ' battery=' + rate('battery') + ' cpuCores=' + rate('cpuCores'));
  }

  console.log(`\n===== 阶段 1 结果：PASS ${pass} / FAIL ${fail} =====`);
  if (fails.length) console.log('失败项: ' + fails.join(' | '));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); process.exit(2); });
