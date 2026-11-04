/**
 * 退出时收掉 adb server：离线回归（不联网、不依赖真机 / Electron）
 *  A) 归属判定：只收「本进程拉起」的 server，外部已在跑的一律不动
 *  B) 探测顺序：必须在第一次 spawn 之前探 5037，且整个进程只探一次
 *  C) 失败/挂起：kill 失败或卡住都不能拖住退出
 *  D) 接线一致性：main.js 退出链里真的调了，且有强制退出兜底
 *
 * 背景：adb 客户端执行任意命令都会 fork 一个常驻 server（`fork-server server`），
 * 它不随客户端退出。旧版关掉程序后 adb.exe 会以孤儿进程常驻，占着 5037 并锁住
 * 便携包里的 adb.exe —— 表现就是「程序关了，进程还在」。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const APP = path.resolve(__dirname, '..', '..', '_client_src', 'app');

// adb.js 在 require 时就解构了 execFile，必须先打桩再 require，否则会真的起 adb。
const cp = require('child_process');
const execLog = [];
cp.execFile = function (bin, args, opts, cb) {
  execLog.push({ bin, args: Array.from(args || []) });
  const child = new EventEmitter();
  child.pid = 4242;
  child.kill = () => {};
  setImmediate(() => {
    try { child.emit('exit', 0); } catch (_) {}
    if (typeof cb === 'function') cb(null, 'ok', '');
  });
  return child;
};

const ADB = require(path.join(APP, 'src', 'adb.js'));
const mainSrc = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
const adbSrc = fs.readFileSync(path.join(APP, 'src', 'adb.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : ' → ' + JSON.stringify(extra))); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ── A. 归属判定 ────────────────────────────────────────────────────────────
  console.log('\n[A] 归属判定：只收自己拉起的 server');
  {
    let killCalls = 0;
    let probeCalls = 0;
    ADB.__setServerRunner({
      probe: () => { probeCalls++; return Promise.resolve(false); }, // 5037 没人听 → 我们起的
      kill: (cb) => { killCalls++; cb(null); return { kill() {} }; },
    });
    const r = await ADB.killServerIfOwned().catch(() => null);
    // 还没跑过任何 adb 命令，探测也没做过 —— killServerIfOwned 自己会先探测
    check('5037 空闲时判定为「自己拉起的」并执行 kill', killCalls === 1, { killCalls });
    check('kill 成功返回 killed:true', !!(r && r.killed === true), r);
    check('探测只做一次', probeCalls === 1, { probeCalls });

    const again = await ADB.killServerIfOwned();
    check('收过之后不再重复 kill（已不是我们的）', again && again.killed === false && again.reason === 'not-ours', again);
    check('第二次没有多杀一次', killCalls === 1, { killCalls });
  }
  {
    let killCalls = 0;
    ADB.__setServerRunner({
      probe: () => Promise.resolve(true),   // 外部（Escrcpy / Android Studio）已在跑
      kill: (cb) => { killCalls++; cb(null); return { kill() {} }; },
    });
    const r = await ADB.killServerIfOwned();
    check('外部 server 一律不动', killCalls === 0 && r.killed === false, { killCalls, r });
    check('跳过原因可读', r.reason === 'not-ours', r);
  }

  // ── B. 探测顺序 ────────────────────────────────────────────────────────────
  console.log('\n[B] 探测必须在第一次 spawn 之前，且只探一次');
  {
    const order = [];
    let probeCalls = 0;
    ADB.__setServerRunner({
      probe: () => { probeCalls++; order.push('probe'); return Promise.resolve(false); },
      kill: (cb) => { order.push('kill'); cb(null); return { kill() {} }; },
    });
    execLog.length = 0;
    await ADB.shell('DEV123', 'echo hi');
    check('探测先于 spawn', order[0] === 'probe' && execLog.length === 1, { order, execLog: execLog.length });
    check('adb 参数未被包装破坏', JSON.stringify(execLog[0].args) === JSON.stringify(['-s', 'DEV123', 'shell', 'echo hi']), execLog[0]);

    await ADB.shell('DEV123', 'echo 2');
    await ADB.shell('DEV123', 'echo 3');
    check('多次调用只探测一次', probeCalls === 1, { probeCalls });
    check('后续调用照常 spawn', execLog.length === 3, { n: execLog.length });
  }
  {
    // 探测自身抛错不能连累采集：adb() 必须照常执行
    ADB.__setServerRunner({
      probe: () => Promise.reject(new Error('probe boom')),
      kill: (cb) => { cb(null); return { kill() {} }; },
    });
    execLog.length = 0;
    let ok = true;
    try { await ADB.shell('DEV123', 'echo hi'); } catch (_) { ok = false; }
    check('探测报错时 adb 仍可用', ok && execLog.length === 1, { ok, n: execLog.length });
    const r = await ADB.killServerIfOwned();
    check('探测报错时保守判定为「不是我们的」', r.killed === false, r);
  }
  {
    // 首条命令是 captureScreen / readApkEntry 时也要探到（三处入口都接线）
    ADB.__setServerRunner({ probe: () => Promise.resolve(false), kill: (cb) => cb(null) });
    execLog.length = 0;
    ADB.captureScreen('DEV123').then(() => {}, () => {});
    await sleep(30);
    check('captureScreen 也走探测', execLog.length === 1, { n: execLog.length });
  }

  // ── C. kill 失败 / 挂起都不能拖住退出 ──────────────────────────────────────
  console.log('\n[C] kill 失败或挂起不拖住退出');
  {
    let killCalls = 0;
    ADB.__setServerRunner({
      probe: () => Promise.resolve(false),
      kill: (cb) => { killCalls++; cb(new Error('kill failed')); return { kill() {} }; },
    });
    const r = await ADB.killServerIfOwned();
    check('kill 失败返回 killed:false', r.killed === false, r);
    await ADB.killServerIfOwned();
    check('kill 失败后保留归属，下次还能重试', killCalls === 2, { killCalls });
  }
  {
    ADB.__setServerRunner({
      probe: () => Promise.resolve(false),
      kill: () => ({ kill() {} }),          // 永不回调：模拟 adb 卡死
    });
    const t0 = Date.now();
    const r = await ADB.killServerIfOwned(80);
    const cost = Date.now() - t0;
    check('kill 挂起时按超时放弃', r.killed === false, r);
    check('放弃耗时受控（< 1200ms）', cost < 1200, { cost });
  }

  // ── D. 接线一致性 ──────────────────────────────────────────────────────────
  console.log('\n[D] 退出链接线');
  const quitBlock = (mainSrc.match(/app\.on\('window-all-closed'[\s\S]*?\n\}\);/) || [''])[0];
  check('找到 window-all-closed 处理器', quitBlock.length > 100, { len: quitBlock.length });
  check('退出链里调用了 killServerIfOwned', /killServerIfOwned\(\)/.test(quitBlock));
  check('kill 在 app.quit() 之前', quitBlock.indexOf('killServerIfOwned') < quitBlock.lastIndexOf('app.quit()'));
  check('先取消在途 adb 子进程', /cancelAllInflight\(\)/.test(quitBlock));
  check('有强制退出兜底 app.exit(0)', /app\.exit\(0\)/.test(quitBlock));
  check('兜底定时器退出前被清掉', /clearTimeout\(hardExit\)/.test(quitBlock));
  check('兜底定时器 unref（不阻止正常退出）', /hardExit\.unref/.test(quitBlock));
  check('用内联 require 取 adb（main.js 没有顶层 ADB 常量）',
    /require\('\.\/src\/adb'\)\.killServerIfOwned/.test(quitBlock));

  check('adb.js 导出 killServerIfOwned', /killServerIfOwned,/.test(adbSrc));
  check('adb.js 端口跟随 ANDROID_ADB_SERVER_PORT，默认 5037',
    /ANDROID_ADB_SERVER_PORT/.test(adbSrc) && /raw : 5037/.test(adbSrc));
  check('adb.js 三个 spawn 入口都先探测',
    (adbSrc.match(/ensureServerOwnership\(\)\.then\(/g) || []).length >= 3,
    { n: (adbSrc.match(/ensureServerOwnership\(\)\.then\(/g) || []).length });

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.log('UNCAUGHT: ' + (e && e.stack || e));
  process.exit(1);
});
