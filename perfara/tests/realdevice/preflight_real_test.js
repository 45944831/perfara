'use strict';
/**
 * 真机深度用例：采集前健康检查（preflight）与超时熔断（breaker）的实机行为
 *
 * 覆盖 4 个场景：
 *   A. 正常态：preflight 返回结构化结果，耗时在界内（不能又变成「点了没反应」）
 *   B. 熄屏态：preflight 自动点亮屏幕（KEYCODE_WAKEUP），且不把「刚被点亮」判成失败
 *   C. 熄屏下直接 start()：采集器靠 preflight 把屏幕点亮后仍能出数据
 *   D. adb 通道中断（kill-server，模拟 USB 掉线/设备卡死）：
 *      采集器必须在有限时间内**自动停止并给出可操作原因**，不能留下假「采集中」
 *
 * 用法: node preflight_real_test.js <deviceId> [packageName]
 */
const { execFile } = require('child_process');
const path = require('path');
const Module = require('module');
const os = require('os');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-preflight-'));
const _origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return { app: { isPackaged: false, getPath: () => TMP, getName: () => 'perfara' } };
  }
  return _origLoad.apply(this, arguments);
};

const APP = path.resolve(__dirname, '..', '..', '..', '_client_src', 'app');
process.resourcesPath = path.resolve(__dirname, '..', '..', 'collector', 'resources');

const ADB = require(path.join(APP, 'src/adb.js'));
const CollectorMod = require(path.join(APP, 'src/collector.js'));
const Collector = CollectorMod.Collector || CollectorMod;

const DEVICE = process.argv[2] || '';
const PKG = process.argv[3] || 'com.android.chrome';

const ADB_BIN = (() => {
  const p = path.resolve(__dirname, '..', '..', 'collector', 'resources', 'adb', 'win', 'adb.exe');
  return fs.existsSync(p) ? p : 'adb';
})();

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); }
  else { fail++; fails.push(name); console.log(`  FAIL  ${name}  ${detail !== undefined ? JSON.stringify(detail) : ''}`); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function adb(args) {
  return new Promise((resolve) => {
    execFile(ADB_BIN, ['-s', DEVICE, 'shell', ...args], { timeout: 15000 },
      (e, so) => resolve({ ok: !e, out: String(so || '').trim(), err: e && e.message }));
  });
}
function adbNoDevice(args) {
  return new Promise((resolve) => {
    execFile(ADB_BIN, args, { timeout: 20000 }, (e, so) => resolve({ ok: !e, out: String(so || '').trim() }));
  });
}
/** 等设备回到在线态：无线 adb 在熄屏/休眠后可能短暂 offline */
async function waitOnline(timeoutMs = 20000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    const r = await adb(['echo', '1']);
    if (r.ok && r.out === '1') return true;
    await sleep(1000);
  }
  return false;
}
async function wakefulness() {
  const r = await adb(['dumpsys power | grep -m1 mWakefulness']);
  const m = r.out.match(/mWakefulness=(\w+)/);
  return m ? m[1] : '';
}
/** 点亮并尝试解除 keyguard（无 PIN 场景下滑动即可） */
async function wakeAndUnlock() {
  await adb(['input keyevent 224']);   // WAKEUP
  await sleep(500);
  await adb(['input keyevent 82']);    // MENU：多数 ROM 上可解除无密码 keyguard
  await sleep(400);
  await adb(['input swipe 540 1800 540 600 200']);
  await sleep(500);
}

(async () => {
  console.log(`\n===== 深度用例：健康检查与熔断（device=${DEVICE} pkg=${PKG}）=====\n`);

  // ───── A. 正常态健康检查 ────────────────────────────────────────────────
  console.log('[A] 正常态 preflight');
  await wakeAndUnlock();
  const tA = Date.now();
  const pf = await ADB.preflightCheck(DEVICE);
  const msA = Date.now() - tA;
  console.log('  result =', JSON.stringify({
    level: pf.level, ok: pf.ok, summary: pf.summary,
    checks: {
      responsive: pf.checks.responsive,
      memory: pf.checks.memory,
      gpu: pf.checks.gpu,
      screen: pf.checks.screen,
    },
    warnings: pf.warnings,
  }));
  check('返回结构化结果', !!(pf && pf.checks && typeof pf.level === 'string'), pf && pf.level);
  check('level 合法', ['ok', 'warn', 'fail'].includes(pf.level), pf.level);
  check('设备响应检查通过', pf.checks.responsive === true, pf.checks.responsive);
  check('内存检查有总量/可用量', !!(pf.checks.memory && pf.checks.memory.totalMB > 0 && pf.checks.memory.availMB >= 0), pf.checks.memory);
  check('GPU 检查为数值或 null（不误判失败）', pf.checks.gpu === null || (typeof pf.checks.gpu === 'object'), pf.checks.gpu);
  check('屏幕检查有结论', !!(pf.checks.screen && (pf.checks.screen.known === false || typeof pf.checks.screen.awake === 'boolean')), pf.checks.screen);
  check('总耗时有界（<8s，实测应 ~1-3s）', msA < 8000, { ms: msA });
  check('有可读 summary', typeof pf.summary === 'string' && pf.summary.length > 0, pf.summary);

  // ───── B. 熄屏 → 自动点亮 ───────────────────────────────────────────────
  console.log('[B] 熄屏后 preflight 自动点亮');
  await adb(['input keyevent 223']);   // SLEEP
  await sleep(1500);
  const before = await wakefulness();
  console.log(`  熄屏前 mWakefulness=${before}`);
  const pf2 = await ADB.preflightCheck(DEVICE);
  const after = await wakefulness();
  console.log(`  检查后 mWakefulness=${after}  screen=${JSON.stringify(pf2.checks.screen)}`);
  check('确实进入非 Awake 状态（前置条件）', before !== 'Awake' || before === '', before || '(读不到)');
  check('preflight 未因熄屏判失败', pf2.level !== 'fail', { level: pf2.level, reason: pf2.reason });
  if (before && before !== 'Awake') {
    check('preflight 把屏幕点亮（woke 或最终 Awake）',
      !!(pf2.checks.screen && (pf2.checks.screen.woke || pf2.checks.screen.awake)) || after === 'Awake',
      { woke: pf2.checks.screen && pf2.checks.screen.woke, after });
  } else {
    console.log('  （读不到熄屏状态，跳过点亮断言）');
  }

  // ───── C. 熄屏下直接 start()：靠 preflight 点亮后仍能出数 ────────────────
  console.log('[C] 熄屏状态下 start() 采集');
  await adb(['input keyevent 223']);
  await sleep(1500);
  const c1 = new Collector(DEVICE, PKG, 1000, null);
  const s1 = [];
  c1.on('data', (d) => s1.push(d));
  let startErr = null;
  const tC = Date.now();
  try { await c1.start(); } catch (e) { startErr = e.message; }
  const msStart = Date.now() - tC;
  await sleep(6000);
  try { c1.stop('preflight-real-c'); } catch (_) {}
  const wf = await wakefulness();
  console.log(`  start 耗时 ${msStart}ms，样本 ${s1.length} 条，屏幕=${wf}`);
  check('熄屏下 start() 未报错', startErr === null, startErr);
  check('采集到样本（屏幕已被点亮）', s1.length >= 2, s1.length);
  check('采集后屏幕为 Awake', wf === 'Awake', wf);
  await wakeAndUnlock();

  // ───── D. 采集通道整体失效 → 自动熔断 ──────────────────────────────────
  // 为什么用故障注入而不是 kill-server：
  //   `adb kill-server` 之后，**下一条 adb 命令会自动把 server 拉起来**，设备几秒内
  //   就恢复，根本模拟不出「通道断了」；真实拔线又做不到。所以在 ADB 模块上把
  //   采集用到的方法整体替换成「立即 reject」，等价于设备端每条命令都失败
  //   （USB 松动 / adb 无响应 / 设备离线时的真实表现）。
  console.log('[D] 采集通道失效 → 熔断（故障注入）');
  // C 段熄屏后无线 adb 可能短暂 offline，先等设备回到在线态再起采集
  await wakeAndUnlock();
  if (!(await waitOnline())) console.log('  警告：设备 20s 内未恢复在线');
  const CHANNEL_FNS = ['getPid', 'probeChannel', 'getCpuStats', 'getCpuCoreStats', 'getMemInfo', 'getFps',
    'getNetStats', 'getBatteryInfo', 'getThermalInfo', 'getGpuUsage'];
  const orig = {};
  const c2 = new Collector(DEVICE, PKG, 1000, null);
  const s2 = [];
  let stopped = null;
  let errMsg = null;
  c2.on('data', (d) => s2.push(d));
  c2.on('stopped', (info) => { if (!stopped) stopped = info; });
  c2.on('error', (e) => { if (!errMsg) errMsg = e.message; });
  try { await c2.start(); } catch (e) {
    console.log('  start 失败（等在线后重试一次）:', e.message);
    await waitOnline();
    try { await c2.start(); } catch (e2) { console.log('  start 再次失败:', e2.message); }
  }
  await sleep(4000);
  const beforeKill = s2.length;
  console.log(`  正常采集 ${beforeKill} 条后注入通道故障…`);

  for (const k of CHANNEL_FNS) {
    orig[k] = ADB[k];
    ADB[k] = () => Promise.reject(new Error('模拟 adb 通道断开（ECONNRESET）'));
  }
  const tD = Date.now();
  // 3 轮全失败即熔断（≈3s）；给 30s 余量覆盖在途调用
  while (Date.now() - tD < 30000) {
    if (stopped || !c2._running) break;
    await sleep(300);
  }
  const msD = Date.now() - tD;
  const afterKill = s2.length;
  for (const k of CHANNEL_FNS) ADB[k] = orig[k];
  try { c2.stop('preflight-real-d'); } catch (_) {}
  console.log(`  ${(msD / 1000).toFixed(1)}s 后：running=${c2._running} stopped=${JSON.stringify(stopped && { reason: stopped.reason })}`);
  console.log(`  样本 ${beforeKill} → ${afterKill}（故障后不应再产出零值样本）`);
  console.log(`  error=${errMsg || '(无)'}`);

  check('通道失效后自动停止（≤30s）', stopped !== null || c2._running === false, { ms: msD, running: c2._running });
  // reason 是给界面分支用的固定码（renderer 里 device_stall 有专门文案），
  // 具体原因在 error 文案里，两者都要对
  check('熔断 reason 为 device_stall', !!(stopped && stopped.reason === 'device_stall'), stopped && stopped.reason);
  check('error 文案指向连接问题', !!errMsg && /设备|USB|卡顿|连接|断开/.test(errMsg), errMsg);
  check('故障后不再产出零值样本（不假装在采）', afterKill - beforeKill <= 1, { before: beforeKill, after: afterKill });
  check('熔断后不再残留采样定时器', c2._timer === null, c2._timer);
  check('熔断标记已置位', c2._breakerTripped === true, c2._breakerTripped);

  console.log(`\n===== 结果: ${pass} PASS / ${fail} FAIL =====`);
  if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
  process.exit(fail ? 1 : 0);
})();
