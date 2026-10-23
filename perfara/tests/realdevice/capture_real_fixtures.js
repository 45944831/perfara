'use strict';
/**
 * 采集真机数据并落盘为报告渲染用的 fixture：
 *   _real_android.json（真机 Android 采集）
 *   _real_pc.json    （本机 Windows 采集）
 * 供 render_real_report.js 灌进 perf.html 验证。
 *
 * 用法: node capture_real_fixtures.js <androidDeviceId> <androidPackage> [seconds]
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Module = require('module');

const _origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return { app: { isPackaged: false, getPath: () => __dirname, getName: () => 'perfara' } };
  }
  return _origLoad.apply(this, arguments);
};

const Collector = require('../../../_client_src/app/src/collector');
const PC = require('../../../_client_src/app/src/pc-collector');

const DEVICE = process.argv[2] || '';
const PKG = process.argv[3] || 'com.android.chrome';
const SECONDS = parseInt(process.argv[4] || '16', 10);

const OUT_DIR = __dirname;
const PORTABLE_ROOT = path.resolve(__dirname, '../../../Perfara-Portable/collector/resources');
const PY = path.join(PORTABLE_ROOT, 'ios-tools', 'python', 'python', 'python.exe');
const SCRIPT = path.join(PORTABLE_ROOT, 'ios-tools', 'python', 'python', 'Scripts', 'collect_pc_perf.pyc');
const PC_EXE = 'C:\\Windows\\explorer.exe';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function captureAndroid() {
  console.log(`\n[Android] ${DEVICE} / ${PKG} …`);
  const c = new Collector(DEVICE, PKG, 1000);
  const errs = [];
  c.on('error', e => errs.push(e.message));
  try {
    await c.start();
  } catch (e) {
    console.log('  启动失败:', e.message);
    return null;
  }
  console.log(`  采集中（${SECONDS}s）… PID=${c._pid}`);
  await sleep(SECONDS * 1000);
  c.stop('fixture');
  const perf = c.history.slice();
  console.log(`  采集 ${perf.length} 条，错误 ${errs.length}`);
  if (!perf.length) return null;
  const payload = {
    device: {
      name: 'Android 真机', model: 'generic', brand: 'generic', system: 'Android 13',
      category: 'android', deviceId: DEVICE, appName: PKG, appLabel: PKG,
    },
    perf,
    tag: null,
    metricConfig: { fps: true, cpu: true, mem: true, net: true, gpu: true, temp: true, battery: true },
  };
  fs.writeFileSync(path.join(OUT_DIR, '_real_android.json'), JSON.stringify(payload, null, 2), 'utf8');
  console.log('  已写入 _real_android.json');
  return payload;
}

async function capturePc(seconds) {
  console.log(`\n[PC] ${PC_EXE} …`);
  if (!fs.existsSync(PY) || !fs.existsSync(SCRIPT)) {
    console.log('  内置 Python / 脚本缺失，跳过 PC 采集');
    return null;
  }
  const rows = [];
  const child = spawn(PY, ['-u', SCRIPT, PC_EXE], { cwd: path.dirname(SCRIPT), stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout.on('data', (c) => {
    for (const line of c.toString('utf8').split('\n')) {
      const t = line.trim();
      if (!t || !t.startsWith('{')) continue;
      try {
        const o = JSON.parse(t);
        if (o.error) { if (o.error === 'not_running') console.log('  目标未运行:', o.message); continue; }
        rows.push(PC.filterPcData(o, PC.normalizePcMetricConfig(null)));
      } catch (_) {}
    }
  });
  await sleep(seconds * 1000);
  try { child.kill(); } catch (_) {}
  try { require('child_process').exec(`taskkill /PID ${child.pid} /T /F`, () => {}); } catch (_) {}
  console.log(`  采集 ${rows.length} 条`);
  if (!rows.length) return null;
  const payload = {
    device: {
      name: process.env.COMPUTERNAME || 'Windows PC', model: 'PC', brand: 'PC', system: 'Windows',
      category: 'pc', deviceId: 'local-pc', appName: 'explorer.exe', appLabel: 'explorer.exe',
    },
    perf: rows,
    tag: null,
    metricConfig: { fps: true, cpu: true, mem: true, net: true, gpu: true, temp: true, battery: true, disk: true },
  };
  fs.writeFileSync(path.join(OUT_DIR, '_real_pc.json'), JSON.stringify(payload, null, 2), 'utf8');
  console.log('  已写入 _real_pc.json');
  return payload;
}

(async () => {
  await captureAndroid();
  await capturePc(Math.max(10, Math.round(SECONDS * 0.8)));
  console.log('\n完成');
  process.exit(0);
})();
