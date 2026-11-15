'use strict';
/**
 * 真机旁路取证端到端（优化方案 2.1）：perfetto / simpleperf 实抓 → 本地落盘 → 设备端零残留。
 *
 * 用法: node trace_capture_realdevice.js <deviceId> [durationSec]
 * 设备序列号必须运行时传入（不入库）。
 *
 * 覆盖点：
 *   1) 能力探测：Android 12+ 真机应探到 perfetto（simpleperf 各 ROM 都有）
 *   2) 默认关闭零开销：不 enable 时 capture 返回 disabled，且没有任何 adb 调用
 *   3) 真抓一段 trace：ok=true / kind=perfetto / 本地文件存在且非空 / 记录入 list
 *   4) 设备端零残留：/data/local/tmp 与 /data/misc/perfetto-traces/ 都不留 perfara_trace_*（成功、失败路径都要清）
 *   5) simpleperf 通道真抓验证（绕过 perfetto 优先级，直接验证设备端命令语义）
 *   6) 产物文件头合理（perfetto trace 是 protobuf，体积应在 KB~MB 级且非全零）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const APP = path.resolve(__dirname, '..', '..', '..', '_client_src', 'app');
const TRACE = require(path.join(APP, 'src', 'trace-capture.js'));
const ADB = require(path.join(APP, 'src', 'adb.js'));
process.resourcesPath = path.resolve(__dirname, '..', '..', 'collector', 'resources');

const DEVICE = process.argv[2] || '';
const SEC = Math.min(30, Math.max(3, parseInt(process.argv[3] || '5', 10)));
if (!DEVICE) {
  console.error('用法: node trace_capture_realdevice.js <deviceId> [durationSec]');
  process.exit(2);
}

const ADB_BIN = (() => {
  const p = path.resolve(__dirname, '..', '..', 'collector', 'resources', 'adb', 'win', 'adb.exe');
  return fs.existsSync(p) ? p : 'adb';
})();

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + '  -> ' + JSON.stringify(detail)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function adbOut(args, timeoutMs) {
  return execFileSync(ADB_BIN, ['-s', DEVICE, ...args],
    { encoding: 'utf8', timeout: timeoutMs || 15000 });
}
function deviceResidue() {
  // perfetto 产物在 /data/misc/perfetto-traces/（SELinux 只放行该目录），
  // simpleperf 产物在 /data/local/tmp/ —— 两个目录都要查残留
  let out = '';
  try {
    out = adbOut(['shell',
      'ls /data/local/tmp/ /data/misc/perfetto-traces/ 2>/dev/null'], 8000);
  } catch (_) {}
  return out.split(/\r?\n/).filter((l) => l.indexOf('perfara_trace_') >= 0);
}

(async () => {
  console.log(`\n===== 真机旁路取证 e2e  device=${DEVICE}  ${SEC}s =====\n`);

  // 0) 前置：确认设备在位；清掉历史残留，避免旧文件干扰断言
  try { adbOut(['shell', 'getprop', 'ro.build.version.sdk']); } catch (_) {
    console.error('设备不可达: ' + DEVICE);
    process.exit(2);
  }
  try { adbOut(['shell', 'rm -rf /data/local/tmp/perfara_trace_* /data/misc/perfetto-traces/perfara_trace_*'], 8000); } catch (_) {}
  const sdk = parseInt(String(adbOut(['shell', 'getprop', 'ro.build.version.sdk'])).trim(), 10);

  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara-trace-e2e-'));
  const logs = [];
  const cap = TRACE.createTraceCapture({
    deviceId: DEVICE,
    reportDir: reportDir,
    enabled: false,
    runAdb: (args, timeout) => ADB.runAdb(args, timeout),
    cancelInflight: () => { try { ADB.cancelAllInflight(); } catch (_) {} },
    log: (m) => { logs.push(String(m)); console.log('    [log] ' + m); },
  });

  // 1) 默认关闭零开销：未 enable 时 capture 短路
  const beforeDisabled = await cap.capture({ durationSec: SEC });
  check('默认关闭时 capture=disabled', beforeDisabled.ok === false
    && beforeDisabled.reason === 'disabled', beforeDisabled);
  check('disabled 时不产生任何本地文件', fs.readdirSync(reportDir).length === 0,
    fs.readdirSync(reportDir));

  // 2) 能力探测（缓存到实例）
  const sup = await cap.isSupported();
  check('能力探测 supported=true', sup.supported === true, sup);
  check('sdkInt 与设备一致', sup.sdkInt === sdk, { expect: sdk, got: sup.sdkInt });
  if (sdk >= 31) {
    check('Android 12+ 探到 perfetto', sup.perfetto === true && sup.backend === 'perfetto', sup);
  }

  // 3) enable + 真抓一段
  cap.enable();
  const t0 = Date.now();
  const res = await cap.capture({ durationSec: SEC, source: 'manual' });
  const wallMs = Date.now() - t0;
  check('真抓返回 ok=true', res.ok === true, res);
  check('kind 与能力探测一致', res.ok && res.kind === sup.backend,
    { expect: sup.backend, got: res.ok ? res.kind : null });
  check('耗时 ≥ 抓取时长且不超 3 倍+裕量', res.ok && wallMs >= SEC * 1000 && wallMs < (SEC * 3 + 30) * 1000,
    { wallMs, sec: SEC });
  check('返回本地路径存在', res.ok && typeof res.path === 'string'
    && fs.existsSync(res.path), res.path || null);

  // 4) 产物文件合理性
  if (res.ok && fs.existsSync(res.path)) {
    const buf = fs.readFileSync(res.path);
    const allZero = buf.length > 0 && buf.every((b) => b === 0);
    check('产物非空且非全零', buf.length > 1024 && !allZero,
      { size: buf.length, allZero });
    if (res.kind === 'perfetto') {
      // perfetto trace 以 protobuf TracePacket 开始（首字节 0x0a）或以 "TRACE" magic 开始
      const headOk = buf[0] === 0x0a || buf.slice(0, 5).toString('ascii') === 'TRACE';
      check('perfetto 产物文件头是 protobuf/magic', headOk,
        { head: buf.slice(0, 8).toString('hex') });
      check('perfetto 产物体积在 1KB~64MB', buf.length > 1024 && buf.length < 64 * 1024 * 1024,
        { size: buf.length });
    } else {
      // simpleperf record 的产物首字节是 magic "PERF"
      check('simpleperf 产物以 PERF magic 开始', buf.slice(0, 4).toString('ascii') === 'PERF',
        { head: buf.slice(0, 8).toString('ascii') });
    }
  }

  // 5) 设备端零残留（成功路径）——等 finally 里的 rm 完成
  await sleep(2500);
  check('成功抓取后设备端无 perfara_trace_* 残留', deviceResidue().length === 0,
    deviceResidue());

  // 6) 记录与诊断
  const list = cap.list();
  check('capture 记录入 list', list.length === 1 && list[0].ok === true, list);
  check('记录带 trigger.source=manual', list.length === 1 && list[0].trigger
    && list[0].trigger.source === 'manual', list[0] && list[0].trigger);
  const diag = cap.getDiagnostics();
  check('诊断 okCount=1 failCount=0', diag.okCount === 1 && diag.failCount === 0, diag);

  // 7) simpleperf 通道直接验证：绕过优先级，验证设备端命令语义。
  //    部分 ROM（如 ColorOS）内核禁了 shell 用户的 perf_event_open，
  //    连按 PID 采样都 Permission denied —— 该场景记 skip，不算产品缺陷。
  const simpleperfPath = (() => { try { return adbOut(['shell', 'command -v simpleperf']).trim(); } catch (_) { return ''; } })();
  if (simpleperfPath) {
    const remote = '/data/local/tmp/perfara_trace_manualcheck/perf.data';
    let spOk = false;
    let spErr = '';
    try {
      adbOut(['shell', 'mkdir -p /data/local/tmp/perfara_trace_manualcheck && '
        + 'simpleperf record -o ' + remote + ' --duration 3 -a'], 30000);
      const pulled = path.join(reportDir, 'manual_simpleperf.perf.data');
      adbOut(['pull', remote, pulled], 30000);
      const buf = fs.readFileSync(pulled);
      spOk = buf.length > 512 && buf.slice(0, 4).toString('ascii') === 'PERF';
    } catch (e) {
      spErr = String(e && e.message || e);
    }
    try { adbOut(['shell', 'rm -rf /data/local/tmp/perfara_trace_manualcheck*'], 8000); } catch (_) {}
    if (spOk) {
      check('simpleperf 通道真抓产物 PERF magic', true, true);
    } else if (/Permission denied|root privilege|Operation not permitted/i.test(spErr)) {
      console.log('    [skip] simpleperf 被内核/权限限制（' + spErr.split('\n')[0].slice(0, 80) + '）—— perfetto 通道不受影响');
    } else {
      check('simpleperf 通道真抓产物 PERF magic', false, spErr.slice(0, 200));
    }
  } else {
    console.log('    [skip] 设备无 simpleperf');
  }

  // 8) cancel 路径的真机行为：起一段长 trace，中途取消，验证不留设备端残留
  if (sup.supported) {
    const p = cap.capture({ durationSec: 30 });
    await sleep(3000); // 等进入抓取阶段
    const did = cap.cancel();
    const r2 = await p;
    check('cancel 命中在途返回 true', did === true, did);
    check('在途以 cancelled 收尾', r2.ok === false && r2.reason === 'cancelled', r2);
    await sleep(2500);
    check('取消后设备端无残留', deviceResidue().length === 0, deviceResidue());
  }

  cap.dispose();
  try { fs.rmSync(reportDir, { recursive: true, force: true }); } catch (_) {}

  console.log(`\n===== 旁路取证真机结果: ${pass} PASS / ${fail} FAIL =====`);
  if (FAILS.length) console.log('失败项: ' + FAILS.join(' | '));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常: ' + (e && e.stack || e));
  process.exit(1);
});
