'use strict';
/**
 * 真机网络口径降级链端到端（优化方案 1.2）：qtaguid → dumpsys netstats → /proc/net/dev。
 *
 * 用法: node net_scope_realdevice.js <deviceId> [packageName]
 * 设备序列号必须运行时传入（不入库）；默认 com.android.chrome。
 *
 * 覆盖点：
 *   1) 设备实际能力盘点：qtaguid 文件在不在、dumpsys netstats 能不能按 UID 解析出
 *   2) 真实 UID 走 getNetStats：scope 必须是 'app'（①或②命中），绝不静默落整机
 *   3) 首拍速率必须为 null（只建基线），第二拍起才有数值且非负
 *   4) 不存在的 UID 走 getNetStats：必须降级到 ③ 整机（scope='device' +
 *      source='proc-net-dev'），且不能冒充应用口径
 *   5) 纯函数离线复放：parseQtaguidStats / parseNetstatsUid 对真实设备输出做解析对账
 *   6) 降级后再隔 15s 重试应用口径的节流行为（_netScopeCache）——只验结构不验时长
 *
 * 前置：设备屏幕点亮（弱网场景不涉及）；无需应用前台 —— 计数器是累计值，不要求有流量。
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-netscope-'));
const _origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return { app: { isPackaged: false, getPath: () => TMP, getName: () => 'perfara' } };
  }
  return _origLoad.apply(this, arguments);
};

const APP = path.resolve(__dirname, '..', '..', '..', '_client_src', 'app');
process.resourcesPath = path.resolve(__dirname, '..', '..', 'collector', 'resources');
const ADB = require(path.join(APP, 'src', 'adb.js'));
const algo = ADB.__algo;

const DEVICE = process.argv[2] || '';
const PKG = process.argv[3] || 'com.android.chrome';
if (!DEVICE) {
  console.error('用法: node net_scope_realdevice.js <deviceId> [packageName]');
  process.exit(2);
}

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + '  -> ' + JSON.stringify(detail)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, timeoutMs) => ADB.shell(DEVICE, cmd, timeoutMs);

(async () => {
  console.log(`\n===== 真机网络口径降级链 e2e  device=${DEVICE}  pkg=${PKG} =====\n`);

  // 0) 设备在位 + 能力盘点
  try { await sh('echo ok', 8000); } catch (_) {
    console.error('设备不可达: ' + DEVICE);
    process.exit(2);
  }
  let qtaguidOut = '';
  try { qtaguidOut = String(await sh('cat /proc/net/xt_qtaguid/stats 2>/dev/null', 8000)); } catch (_) {}
  const hasQtaguid = qtaguidOut.split('\n').some((l) => /^\s*\d+\s/.test(l));
  console.log(`    [info] qtaguid 可用=${hasQtaguid}（Android 9+ 通常已移除）`);

  // 1) 纯函数对账：parseNetstatsUid 对真实 dumpsys 输出必须能解析出目标 UID
  const uid = await ADB.getUid(DEVICE, PKG);
  check('取得应用 UID', Number.isFinite(uid) && uid > 0, uid);
  let netstatsOut = '';
  // 必须带 --uid：默认视图只有汇总段（目录 / 接口 / openSession callers），
  // **不含** per-UID 的计数行，解析器在默认视图上必然命中不了。
  try { netstatsOut = String(await sh(`dumpsys netstats --uid ${uid} 2>/dev/null`, 20000)); } catch (_) {}
  check('dumpsys netstats --uid 有输出', netstatsOut.length > 500, netstatsOut.length);
  let netstatsDefault = '';
  try { netstatsDefault = String(await sh('dumpsys netstats 2>/dev/null', 20000)); } catch (_) {}
  check('默认视图（不带 --uid）确实解析不出 per-UID 计数（记录 ROM 事实）',
    algo.parseNetstatsUid(netstatsDefault, uid) === null,
    { defaultLen: netstatsDefault.length });
  const parsedUid = algo.parseNetstatsUid(netstatsOut, uid);
  check('parseNetstatsUid 在真实输出中命中该 UID（②级可用）', !!parsedUid
    && parsedUid.rx >= 0 && parsedUid.tx >= 0, parsedUid);
  // 换个不存在的 UID：解析必须返回 null（绝不拿整机数字凑数）
  const bogusUid = 999998;
  check('parseNetstatsUid 对不存在 UID 返回 null', algo.parseNetstatsUid(netstatsOut, bogusUid) === null, true);
  if (hasQtaguid) {
    const pq = algo.parseQtaguidStats(qtaguidOut, uid);
    check('parseQtaguidStats 在真实输出中命中该 UID（①级可用）', !!pq, pq);
  }

  // 2) 真实 UID 走 getNetStats：scope 必须 app、首拍 null、次拍有数值
  ADB.resetDeviceState(DEVICE);
  const first = await ADB.getNetStats(DEVICE, uid);
  check('首拍 netScope=app（qtaguid 或 netstats 之一）', first.netScope === 'app', first);
  check('首拍 netSource 是已知通道', first.netSource === 'qtaguid' || first.netSource === 'netstats',
    first.netSource);
  check('首拍速率为 null（只建基线，不编 0）', first.rxKBps === null && first.txKBps === null, first);
  await sleep(2200);
  const second = await ADB.getNetStats(DEVICE, uid);
  check('第二拍 netScope 仍为 app', second.netScope === 'app', second);
  check('第二拍与首拍同通道（口径未漂移）', second.netSource === first.netSource, second);
  check('第二拍速率非负数值（或仍为 null——无流量时差值也是合法的 0）',
    (second.rxKBps === null || (Number.isFinite(second.rxKBps) && second.rxKBps >= 0))
    && (second.txKBps === null || (Number.isFinite(second.txKBps) && second.txKBps >= 0)),
    second);

  // 3) 不存在 UID：必须降级到整机并如实标注，绝不冒充应用口径
  const dev1 = await ADB.getNetStats(DEVICE, bogusUid);
  check('不存在 UID 降级 netScope=device', dev1.netScope === 'device', dev1);
  check('降级 netSource=proc-net-dev', dev1.netSource === 'proc-net-dev', dev1);
  // 注意：`/proc/net/dev` 是**整机全局**计数器，与 UID 无关。
  // 因此「不存在的 UID」走 ③ 时，如果本轮之前已经用 ③ 建过基线，
  // 这一拍就能直接给出差值速率 —— 这是正确行为，不是「首拍没建基线」。
  // 这里断言的是「速率要么是 null（尚未建基线）要么是合法非负数」，
  // 绝不接受负值 / NaN 这类伪造出来的数。
  check('降级采样速率合法（null 表示尚未建基线，否则必须是非负数）',
    (dev1.rxKBps === null && dev1.txKBps === null)
    || (Number.isFinite(dev1.rxKBps) && dev1.rxKBps >= 0
      && Number.isFinite(dev1.txKBps) && dev1.txKBps >= 0), dev1);
  await sleep(1200);
  const dev2 = await ADB.getNetStats(DEVICE, bogusUid);
  check('降级第二拍 netScope 仍 device（15s 内不回切应用口径）', dev2.netScope === 'device', dev2);
  check('降级第二拍速率非负数值', Number.isFinite(dev2.rxKBps) && dev2.rxKBps >= 0
    && Number.isFinite(dev2.txKBps) && dev2.txKBps >= 0, dev2);

  // 4) 纯函数守门：无 UID / 非法输入绝不返回假数据
  check('parseNetstatsUid 无 UID 返回 null', algo.parseNetstatsUid(netstatsOut, 0) === null, true);
  check('parseNetstatsUid NaN 返回 null', algo.parseNetstatsUid(netstatsOut, NaN) === null, true);
  check('parseQtaguidStats 空文本返回 null', algo.parseQtaguidStats('', uid) === null, true);

  ADB.resetDeviceState(DEVICE);

  console.log(`\n===== 网络口径真机结果: ${pass} PASS / ${fail} FAIL =====`);
  if (FAILS.length) console.log('失败项: ' + FAILS.join(' | '));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常: ' + (e && e.stack || e));
  process.exit(1);
});
