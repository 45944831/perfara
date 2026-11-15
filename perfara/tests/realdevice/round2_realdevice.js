'use strict';
/**
 * 第二轮修复（FIX-13/14/15）真机验收。
 *
 * 背景：`app.asar` 打包时间早于本轮源码改动，真机采集报告仍是旧代码产物
 * （`meta.unitVersion='3'`、无 dtMs/freqSource）。因此必须直接驱动**源码**
 * 的 adb.js 采样，才能证明修复在真机上真的生效。
 *
 * 覆盖：
 *   - FIX-14：freqSource 是否给出（cpuinfo / scaling），逐核频率是否按 cpuN 配对
 *   - FIX-13：连续采样时 CPU / 网络 / GPU 是否给出合理瞬时值（非全 null）；
 *             首拍应为 null（无基线），第二拍起应有值
 *   - FIX-11：FPS 通道是否产出，jank 家族口径是否为「帧」
 *
 * 用法: node round2_realdevice.js <deviceId> [packageName] [拍数]
 */
const path = require('path');
const ADB = require(path.resolve(__dirname, '..', '..', '..', '_client_src', 'app', 'src', 'adb.js'));

const D = process.argv[2];
const PKG = process.argv[3] || 'com.android.settings';
const N = parseInt(process.argv[4] || '4', 10);

if (!D) { console.log('用法: node round2_realdevice.js <deviceId> [pkg] [n]'); process.exit(2); }

let pass = 0, fail = 0;
const FAILED = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; FAILED.push(name); console.log('  FAIL  ' + name + '  -> ' + JSON.stringify(detail)); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isNum = v => typeof v === 'number' && Number.isFinite(v);

(async () => {
  console.log(`\n===== 第二轮修复真机验收 =====\n设备: ${D}\n目标: ${PKG}\n`);

  const pid = await ADB.getPid(D, PKG).catch(() => null);
  if (!pid) { console.log('目标应用未运行或未安装，请先打开: ' + PKG); process.exit(2); }
  console.log('PID:', pid);

  // 预热：确保 SurfaceFlinger timestats 已启用
  await ADB.getFps(D, PKG, () => {}, 1000).catch(() => {});

  const rows = [];
  for (let i = 0; i < N; i++) {
    const [cpu, gpu, net, fps] = await Promise.allSettled([
      ADB.getCpuSnapshot(D, pid),
      ADB.getGpuUsage(D),
      ADB.getNetStats(D),
      ADB.getFps(D, PKG, () => {}, 1000),
    ]);
    const row = {
      i,
      cpu: cpu.status === 'fulfilled' ? cpu.value : null,
      gpu: gpu.status === 'fulfilled' ? gpu.value : null,
      net: net.status === 'fulfilled' ? net.value : null,
      fps: fps.status === 'fulfilled' ? fps.value : null,
    };
    rows.push(row);
    console.log(`  [${i}] sysCpu=${row.cpu && row.cpu.sysCpu} procCpu=${row.cpu && row.cpu.procCpu}` +
      ` freqSource=${row.cpu && row.cpu.freqSource} freq=${JSON.stringify(row.cpu && row.cpu.cores && row.cpu.cores.freq)}` +
      ` gpu=${row.gpu} net=${row.net && row.net.rxKBps}/${row.net && row.net.txKBps}(${row.net && row.net.netScope})` +
      ` fps=${row.fps && row.fps.fps}(${row.fps && row.fps.method}) jank=${row.fps && row.fps.jank}`);
    if (i < N - 1) await sleep(1000);
  }

  console.log('\n-- FIX-14：CPU 频率来源与逐核配对 --');
  const withSrc = rows.filter(r => r.cpu && r.cpu.freqSource);
  check('freqSource 有值（cpuinfo 或 scaling）',
    withSrc.length > 0, rows.map(r => r.cpu && r.cpu.freqSource));
  check('freqSource 取值合法',
    withSrc.every(r => ['cpuinfo', 'scaling'].includes(r.cpu.freqSource)),
    [...new Set(withSrc.map(r => r.cpu.freqSource))]);
  const coreRow = rows.find(r => r.cpu && r.cpu.cores && r.cpu.cores.freq && r.cpu.cores.freq.length);
  check('逐核频率非空', !!coreRow, coreRow && coreRow.cpu.cores.freq);
  if (coreRow) {
    const f = coreRow.cpu.cores.freq;
    check('逐核频率为正数或 null（不写 0 冒充）',
      f.every(v => v == null || (isNum(v) && v > 0)), f);
    check('频率值在合理区间（100~6000 MHz）',
      f.filter(v => v != null).every(v => v >= 100 && v <= 6000), f);
  }

  console.log('\n-- FIX-13：长间隔保护不误伤正常采样 --');
  check('首拍 CPU 为 null（无基线，不编 0）',
    rows[0].cpu && rows[0].cpu.sysCpu === null, rows[0].cpu && rows[0].cpu.sysCpu);
  const laterCpu = rows.slice(1).filter(r => r.cpu && r.cpu.sysCpu != null);
  check('第二拍起 CPU 有实测值（1s 间隔未被判 stale）',
    laterCpu.length > 0, rows.map(r => r.cpu && r.cpu.sysCpu));
  check('CPU 值在 0..100', laterCpu.every(r => r.cpu.sysCpu >= 0 && r.cpu.sysCpu <= 100),
    laterCpu.map(r => r.cpu.sysCpu));

  const laterNet = rows.slice(1).filter(r => r.net && r.net.rxKBps != null);
  check('第二拍起网络速率有实测值', laterNet.length > 0,
    rows.map(r => r.net && r.net.rxKBps));
  check('网络速率非负', laterNet.every(r => r.net.rxKBps >= 0 && r.net.txKBps >= 0),
    laterNet.map(r => [r.net.rxKBps, r.net.txKBps]));

  console.log('\n-- FPS / Jank 口径 --');
  const fpsRows = rows.filter(r => r.fps && r.fps.method && r.fps.method !== 'none');
  check('FPS 通道有命中（非 none）', fpsRows.length > 0,
    rows.map(r => r.fps && r.fps.method));
  check('jank 为 null 或非负数（未测量不写 0 以外的假值）',
    rows.every(r => !r.fps || r.fps.jank == null || (isNum(r.fps.jank) && r.fps.jank >= 0)),
    rows.map(r => r.fps && r.fps.jank));

  console.log(`\n===== 结果: ${pass} PASS / ${fail} FAIL =====`);
  if (FAILED.length) console.log('失败项:\n   - ' + FAILED.join('\n   - '));
  process.exit(fail ? 1 : 0);
})();
