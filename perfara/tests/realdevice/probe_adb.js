'use strict';
// 真机采集全链路测试：逐个调用 adb.js 的采集函数，检查返回值合理性。
// 用法: node dev_realcollect_test.js <deviceId> [packageName]
const ADB = require('../../../_client_src/app/src/adb');

const DEVICE = process.argv[2] || '';
let PKG = process.argv[3] || '';

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; fails.push(name); console.log(`  FAIL  ${name}  ${detail !== undefined ? JSON.stringify(detail) : ''}`); }
}

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function pos(v) { return isNum(v) && v > 0; }

(async () => {
  console.log(`\n===== 真机采集测试  device=${DEVICE} =====\n`);

  // 1. 设备列表
  console.log('-- 设备枚举 --');
  const devices = await ADB.getDevices();
  console.log('  devices =', JSON.stringify(devices));
  check('getDevices 包含目标设备', Array.isArray(devices) && devices.some(d => (d.id || d) === DEVICE), devices);

  // 2. 设备信息
  console.log('-- 设备信息 --');
  const info = await ADB.getDeviceInfo(DEVICE).catch(e => ({ error: e.message }));
  console.log('  info =', JSON.stringify(info));
  check('getDeviceInfo 有 name/model', !!(info && (info.model || info.name)), info);
  check('getDeviceInfo 有 system/android 版本', !!(info && (info.android || info.system)), info);

  // 3. 包名选择
  console.log('-- 应用列表 --');
  const pkgs = await ADB.getThirdPartyPackages(DEVICE).catch(() => []);
  console.log('  第三方包数量 =', Array.isArray(pkgs) ? pkgs.length : 'ERR', Array.isArray(pkgs) ? pkgs.slice(0, 5) : pkgs);
  check('getThirdPartyPackages 返回非空数组', Array.isArray(pkgs) && pkgs.length > 0, pkgs && pkgs.length);

  if (!PKG) {
    for (const p of pkgs) {
      const name = (p && p.pkg) || p;
      const pid = await ADB.getPid(DEVICE, name).catch(() => null);
      if (pid) { PKG = name; break; }
    }
    if (!PKG) PKG = (pkgs[0] && pkgs[0].pkg) || pkgs[0] || 'com.android.settings';
  }
  console.log(`  选定被测应用 = ${PKG}`);

  // 4. 进程信息
  console.log('-- 进程/权限 --');
  const ensure = await ADB.ensureAppRunning(DEVICE, PKG, m => console.log('    ensure:', m));
  console.log('  ensure =', JSON.stringify(ensure));
  check('ensureAppRunning 返回 pid', !!(ensure && ensure.pid), ensure);
  const pid = ensure.pid;
  if (!pid) { console.log('\n无法获取 pid，后续采集项无法测试'); process.exit(1); }

  const uid = await ADB.getUid(DEVICE, PKG).catch(e => 'ERR:' + e.message);
  console.log('  uid =', uid);
  check('getUid 返回有效 uid', pos(uid), uid);

  // hasRoot 未导出（内部函数），用 adb 直接探测作参考信息
  const { execFileSync } = require('child_process');
  let suOut = '';
  try { suOut = execFileSync('adb', ['-s', DEVICE, 'shell', 'su -c id'], { encoding: 'utf8', timeout: 8000 }).trim(); } catch (_) { suOut = '(no root)'; }
  const rooted = /uid=0/.test(suOut);
  console.log('  设备 root 状态 =', rooted ? 'rooted' : 'non-root', '|', suOut.slice(0, 60));

  // 5. CPU
  console.log('-- CPU --');
  await ADB.getCpuStats(DEVICE, pid).catch(() => {}); // 预热（差分算法首帧常为 0）
  await new Promise(r => setTimeout(r, 1200));
  const cpu = await ADB.getCpuStats(DEVICE, pid).catch(e => ({ error: e.message }));
  console.log('  cpu =', JSON.stringify(cpu));
  check('getCpuStats 返回对象', cpu && typeof cpu === 'object' && !cpu.error, cpu);
  check('getCpuStats.procCpu 有数值', isNum(cpu && cpu.procCpu), cpu);

  const cores = await ADB.getCpuCoreStats(DEVICE).catch(e => ({ error: e.message }));
  console.log('  cores =', JSON.stringify(cores).slice(0, 300));
  check('getCpuCoreStats.usage 非空数组', Array.isArray(cores && cores.usage) && cores.usage.length > 0, cores && cores.usage && cores.usage.length);
  check('getCpuCoreStats.usage 值在 0..100', Array.isArray(cores && cores.usage) && cores.usage.every(v => !isNum(v) || (v >= 0 && v <= 100)), cores && cores.usage);
  check('getCpuCoreStats.freq 非空数组', Array.isArray(cores && cores.freq) && cores.freq.length > 0, cores && cores.freq && cores.freq.length);
  check('getCpuCoreStats.freq 值合理(>0)', Array.isArray(cores && cores.freq) && cores.freq.some(v => pos(v)), cores && cores.freq);

  // 6. 内存
  console.log('-- 内存 --');
  const mem = await ADB.getMemInfo(DEVICE, PKG).catch(e => ({ error: e.message }));
  console.log('  mem =', JSON.stringify(mem));
  check('getMemInfo 返回对象', mem && typeof mem === 'object' && !mem.error, mem);
  check('getMemInfo.totalPss > 0', pos(mem && mem.totalPss), mem);

  // 7. 网络
  console.log('-- 网络 --');
  await ADB.getNetStats(DEVICE).catch(() => {});
  await new Promise(r => setTimeout(r, 1200));
  const net = await ADB.getNetStats(DEVICE).catch(e => ({ error: e.message }));
  console.log('  net =', JSON.stringify(net));
  check('getNetStats 有 rxKBps/txKBps 数值', isNum(net && net.rxKBps) && isNum(net && net.txKBps), net);
  check('getNetStats 速率非负', net && net.rxKBps >= 0 && net.txKBps >= 0, net);

  // 8. 电量
  console.log('-- 电量 --');
  const bat = await ADB.getBatteryInfo(DEVICE).catch(e => ({ error: e.message }));
  console.log('  battery =', JSON.stringify(bat));
  check('getBatteryInfo.level 在 0..100', bat && isNum(bat.level) && bat.level >= 0 && bat.level <= 100, bat);
  check('getBatteryInfo.temperature 合理(0..120)', bat && isNum(bat.temperature) && bat.temperature > 0 && bat.temperature < 120, bat);
  check('getBatteryInfo.currentNow 有值', bat && isNum(bat.currentNow), bat);
  check('getBatteryInfo.power 有值', bat && isNum(bat.power), bat);

  // 9. 温度
  console.log('-- 温度 --');
  const th = await ADB.getThermalInfo(DEVICE).catch(e => ({ error: e.message }));
  console.log('  thermal =', JSON.stringify(th));
  check('getThermalInfo.temperature 合理(-20..120)', th && isNum(th.temperature) && th.temperature > -20 && th.temperature < 120, th);
  console.log('    gpuTemp =', th && th.gpuTemp);

  // 10. GPU
  console.log('-- GPU --');
  const gpu = await ADB.getGpuUsage(DEVICE).catch(e => ({ error: e.message }));
  console.log('  gpu =', gpu, ' (', typeof gpu, ')');
  check('getGpuUsage 返回 null 或 0..100 数字', gpu === null || gpu === undefined || (isNum(gpu) && gpu >= 0 && gpu <= 100), gpu);

  // 11. FPS（多帧，检查是否有非零帧率与 jank 字段）
  console.log('-- FPS / Jank --');
  const fpsSamples = [];
  for (let i = 0; i < 4; i++) {
    const f = await ADB.getFps(DEVICE, PKG, m => console.log('    fps-log:', m)).catch(e => ({ error: e.message }));
    fpsSamples.push(f);
    console.log(`  fps[${i}] =`, JSON.stringify(f));
    await new Promise(r => setTimeout(r, 900));
  }
  const okFps = fpsSamples.filter(f => f && !f.error);
  check('getFps 返回对象', okFps.length > 0 && okFps.every(f => typeof f === 'object'), fpsSamples);
  check('getFps.fps 为数值', okFps.every(f => isNum(f.fps)), fpsSamples);
  check('getFps 含 jank 字段', okFps.every(f => isNum(f.jank)), fpsSamples);
  check('getFps 含 bigJank 字段', okFps.every(f => isNum(f.bigJank)), fpsSamples);
  check('getFps 含 jankRate 字段', okFps.every(f => isNum(f.jankRate)), fpsSamples);
  check('getFps 至少一帧 fps>0', fpsSamples.some(f => f && f.fps > 0), fpsSamples.map(f => f && f.fps));
  check('getFps 有 method 标识', okFps.every(f => typeof f.method === 'string'), fpsSamples.map(f => f && f.method));

  console.log(`\n===== 结果: ${pass} PASS / ${fail} FAIL =====`);
  if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('致命错误:', e); process.exit(2); });
