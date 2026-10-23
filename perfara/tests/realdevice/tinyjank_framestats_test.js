'use strict';
/**
 * 真机专项：framestats 通道的卡顿分级口径（TinyJank 曾 ≈ 总帧数）
 *
 * 背景：
 *   calcJankFramestats 原先把 `FrameCompleted − Vsync` 当作帧间隔。该值实际是
 *   「本帧从 vsync 到渲染完成」的**呈现延迟**，跟帧节奏无关，且随缓冲深度/刷新率变化：
 *     · 60Hz + 三缓冲（锁 30fps 应用）= 2 个 vsync ≈ 33.6ms
 *     · 120Hz 设置页滑动 = 1 个 vsync ≈ 7.6ms
 *   一旦该值 ≥ 1.5×vsync（TinyJank 阈值），每一帧都会被判成微卡顿 → TinyJank ≈ 总帧数。
 *   修复：帧间隔改取相邻帧 Vsync 的差值，TinyJank 基准与 analyseHistogram 同口径
 *   （max(屏幕 vsync, 段内平均帧间隔) × 1.5）。
 *
 * 为什么单独一套：
 *   常规采集里 framestats 常被「窗口过期」（gfxinfo 缓冲区跨越几十秒）挡掉，
 *   自动降级到 gfxinfo 增量 —— 那条路根本不算 jank，验证不到本修复。
 *   本用例先 `dumpsys gfxinfo <pkg> reset` 清空缓冲区，再用滑动驱动真实渲染，
 *   强制走 framestats 通道。
 *
 * 用法: node tinyjank_framestats_test.js <deviceId> [packageName]
 *
 * 默认用系统设置页（com.android.settings）：
 *   - 它是纯 View 渲染，滚动时 framestats 稳定产出（实测 5 次滑动 120 帧）；
 *   - Chrome 走独立合成器，framestats 只有零星几帧，不适合做基准；
 *   - 系统设置必须**先 am start 起来**，否则 `dumpsys gfxinfo` 会报 No process found
 *     （进程名与包名不一致的假象）。
 */
const { execFile } = require('child_process');
const path = require('path');
const Module = require('module');
const os = require('os');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-tinyjank-'));
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
const A = ADB.__algo;

const DEVICE = process.argv[2] || '';
const PKG = process.argv[3] || 'com.android.settings';

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

function shell(cmd, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(ADB_BIN, ['-s', DEVICE, 'shell', cmd], { timeout, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

function swipe(dir) {
  const from = dir > 0 ? '1750' : '750';
  const to = dir > 0 ? '750' : '1750';
  return new Promise((resolve) => {
    execFile(ADB_BIN, ['-s', DEVICE, 'shell', 'input', 'swipe', '540', from, '540', to, '260'],
      { timeout: 6000 }, () => resolve());
  });
}

/** 解析 getFps 的 framestats 日志行 */
function parseFs(line) {
  const m = String(line).match(/framestats ✓ frames=(\d+) dur=([\d.]+)s fps=(\d+) jank=(\d+) bigJank=(\d+) smallJank=(\d+) tinyJank=(\d+)/);
  if (!m) return null;
  return { frames: +m[1], dur: +m[2], fps: +m[3], jank: +m[4], bigJank: +m[5], smallJank: +m[6], tinyJank: +m[7] };
}

(async () => {
  console.log(`\n===== 真机专项：framestats 卡顿口径（device=${DEVICE} pkg=${PKG}）=====\n`);

  // ---- 0. 离线口径反例：同一批真机形态数据，新旧算法对比 ----
  // completed − vsync 恒 33.6ms，vsync 每 16.67ms 前进一帧
  console.log('[0] 离线对照：新口径 vs 旧口径（旧口径 = completed−vsync 当帧间隔）');
  const frames = [];
  let t = 1e9;
  for (let i = 0; i < 60; i++) { frames.push({ vsync: t, completed: t + 33.6e6 }); t += 16.67e6; }
  const newRes = A.calcJankFramestats(frames);
  // 旧算法在测试内内联复现，作为反例
  const ftOld = frames.map(f => (f.completed - f.vsync) / 1e6);
  const oldTiny = ftOld.filter(v => v >= 16.67 * 1.5).length;
  console.log('   新口径 =', JSON.stringify(newRes), ' 旧口径 tinyJank =', oldTiny);
  check('新口径 TinyJank=0（稳定 60Hz 不该有微卡顿）', newRes.tinyJank === 0, newRes);
  check('旧口径 TinyJank≈总帧数（反例成立，证明修复必要）', oldTiny >= frames.length - 4,
    { oldTiny, frames: frames.length });

  // ---- 1. 准备前台应用 ----
  console.log('\n[1] 准备前台应用');
  if (/^com\.android\.settings$/.test(PKG)) {
    await shell('am start -a android.settings.SETTINGS');
    await sleep(2500);
  } else if (/^com\.android\.chrome$/.test(PKG)) {
    await shell('am start -a android.intent.action.VIEW -d "https://www.baidu.com" -n com.android.chrome/com.google.android.apps.chrome.Main');
    await sleep(5000);
  }
  const r = await ADB.ensureAppRunning(DEVICE, PKG, () => {});
  check('目标应用已就绪', !!(r && r.ok), r && { ok: r.ok, pid: r.pid });
  if (!r || !r.ok) { console.log('无法启动目标应用，终止'); process.exit(1); }
  check('目标应用在前台', await ADB.isAppForeground(DEVICE, PKG), PKG);

  // ---- 2. 清空 gfxinfo 缓冲区，确保 framestats 窗口新鲜 ----
  console.log('\n[2] 清空 gfxinfo 缓冲区（reset），避免「窗口过期」降级');
  const before = await shell(`dumpsys gfxinfo '${PKG}'`);
  const beforeTotal = (before.match(/Total frames rendered:\s*(\d+)/) || [])[1];
  await shell(`dumpsys gfxinfo '${PKG}' reset`);
  await sleep(300);
  const after = await shell(`dumpsys gfxinfo '${PKG}'`);
  const afterTotal = (after.match(/Total frames rendered:\s*(\d+)/) || [])[1];
  console.log(`   Total frames: ${beforeTotal} → ${afterTotal}`);
  check('reset 后帧计数归零（缓冲区已清）', afterTotal === '0' || afterTotal === undefined,
    { beforeTotal, afterTotal });

  // ---- 3. 驱动渲染后直接取 framestats 原始 dump 验算 ----
  // 不走 getFps 是为了绕开通道优先级（timestats 命中时根本到不了 Method 2）；
  // 这里用的 parseFramestats + calcJankFramestats 就是 Method 2 内部那两个函数。
  console.log('\n[3] 滑动驱动渲染 3s，然后抓 framestats 原始 dump');
  let dir = 1;
  const timer = setInterval(() => { swipe(dir); dir = -dir; }, 700);
  await sleep(3000);
  clearInterval(timer);
  await sleep(200);

  const dump = await shell(`dumpsys gfxinfo '${PKG}' framestats`);
  const parsed = A.parseFramestats(dump);
  const realFrames = parsed.frames;
  console.log(`   解析到 ${realFrames.length} 帧（按表头取列=${parsed.sawHeader}，列数=${parsed.iCompleted + 1}）`);
  check('framestats 解析到足够帧数（≥20）', realFrames.length >= 20, realFrames.length);
  check('按表头名取列（非写死索引）', parsed.sawHeader === true, parsed.sawHeader);

  if (realFrames.length >= 20) {
    const res = A.calcJankFramestats(realFrames);
    // 旧口径对照：completed − vsync 当帧间隔
    const latency = realFrames.map(f => (f.completed - f.vsync) / 1e6);
    const avgLatency = latency.reduce((a, b) => a + b, 0) / latency.length;
    const intervals = [];
    for (let i = 1; i < realFrames.length; i++) intervals.push((realFrames[i].vsync - realFrames[i - 1].vsync) / 1e6);
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / Math.max(intervals.length, 1);
    const vsyncMs = avgInterval <= 10 ? 8.33 : (avgInterval <= 13 ? 11.11 : 16.67);
    const oldTiny = latency.filter(v => v >= vsyncMs * 1.5).length;
    // 旧口径会误判的充要条件：呈现延迟 ≥ 1.5×vsync（60Hz 三缓冲、锁帧应用都会命中）
    const triggersOldBug = avgLatency >= vsyncMs * 1.5;

    console.log(`   呈现延迟均值 = ${avgLatency.toFixed(1)}ms   帧间隔均值 = ${avgInterval.toFixed(1)}ms   vsync≈${vsyncMs}ms`);
    console.log(`   新口径 = ${JSON.stringify(res)}   旧口径 tinyJank = ${oldTiny}`);
    console.log(`   真实帧间隔样本 = ${intervals.slice(0, 7).map(v => v.toFixed(1)).join(', ')} ms`);

    check('新口径 TinyJank < frames（不再是总帧数）', res.tinyJank < realFrames.length,
      `${res.tinyJank}/${realFrames.length}`);
    check('新口径 TinyJank 占比 < 60%', res.tinyJank / realFrames.length < 0.6,
      Number((res.tinyJank / realFrames.length).toFixed(2)));
    check('层级成立 bigJank ≤ jank ≤ tinyJank ≤ frames',
      res.bigJank <= res.jank && res.jank <= res.tinyJank && res.tinyJank <= realFrames.length, res);
    check('smallJank ≤ tinyJank（84ms 档更严）', res.smallJank <= res.tinyJank, res);

    // 口径判别：只有在「旧口径确实会误判」的机型/场景上，才能拿它当反例断言
    if (triggersOldBug) {
      check('旧口径把几乎全部帧判成微卡顿（本机触发，反例成立）',
        oldTiny >= realFrames.length * 0.8, { oldTiny, frames: realFrames.length });
      check('新口径把误判压到 20% 以内', res.tinyJank <= realFrames.length * 0.2,
        { newTiny: res.tinyJank, oldTiny, frames: realFrames.length });
    } else {
      console.log(`   NOTE 本机型/场景呈现延迟 ${avgLatency.toFixed(1)}ms < 1.5×vsync(${(vsyncMs * 1.5).toFixed(1)}ms)，`
        + '旧口径不会误判 —— 反例由段 [0] 的离线构造覆盖');
    }
  }

  // ---- 4. 再抓两次，确认口径稳定（不是偶然）----
  console.log('\n[4] 连续再抓 2 次，确认口径稳定');
  const seq = [];
  for (let i = 0; i < 2; i++) {
    await shell(`dumpsys gfxinfo '${PKG}' reset`);
    const t2 = setInterval(() => { swipe(dir); dir = -dir; }, 700);
    await sleep(2000);
    clearInterval(t2);
    const d2 = await shell(`dumpsys gfxinfo '${PKG}' framestats`);
    const f2 = A.parseFramestats(d2).frames;
    if (f2.length >= 20) seq.push({ frames: f2.length, ...A.calcJankFramestats(f2) });
    await sleep(300);
  }
  seq.forEach(o => console.log('   ', JSON.stringify(o)));
  check('连续采样均满足 TinyJank < frames', seq.length > 0 && seq.every(o => o.tinyJank < o.frames),
    seq.map(o => `${o.tinyJank}/${o.frames}`));
  check('TinyJank 占比始终 < 60%', seq.every(o => o.tinyJank / o.frames < 0.6),
    seq.map(o => Number((o.tinyJank / o.frames).toFixed(2))));

  console.log(`\n===== 结果: ${pass} PASS / ${fail} FAIL =====`);
  if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
  process.exit(fail ? 1 : 0);
})();
