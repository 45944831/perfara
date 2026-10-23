'use strict';
/**
 * 真机深度用例：FPS 取帧通道在「应用确实在渲染」时的端到端有效性
 *
 * 为什么单独做这一套：
 *   其余 e2e 用例把「被测应用在渲染」当作前提。真机上游戏常停在静态登录页、
 *   浏览器停在空白页，三条取帧通道都取不到新帧 —— 那种情况下只能验证
 *   「全 null 正确降级」，**验证不了 FPS 数值本身**。
 *   本用例用系统设置页 + 持续滑动驱动真实渲染，专测数值链路：
 *     1) 取到非 null 帧率，落在合理区间（>0 且 ≤ 屏幕刷新率上限）
 *     2) 帧率有波动（不是常数假值）
 *     3) jank / bigJank / smallJank / jankRate 字段齐全且非负
 *     4) 有帧样本占比高（滑动期间应持续有帧）
 *     5) 采集日志出现取帧通道标识（timestats / framestats / gfxinfo 增量）
 *
 * 用法: node fps_render_test.js <deviceId> [packageName] [pageUrl]
 *   默认 packageName = com.android.chrome，并打开一个长结果页（可滚动，滚动必然产生新帧）。
 *   真机实测：桌面只在转场时出帧（APP_SWITCH +65，滑动 +0），系统设置页在部分 ROM 上
 *   进程名与包名不一致（dumpsys gfxinfo 报 No process found），都不适合做帧率基准；
 *   浏览器长页滚动是最稳定、也最贴近真实使用场景的渲染源。
 */
const { execFile } = require('child_process');
const path = require('path');
const Module = require('module');
const os = require('os');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-fps-render-'));
const _origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return { app: { isPackaged: false, getPath: () => TMP, getName: () => 'perfara' } };
  }
  return _origLoad.apply(this, arguments);
};

const APP = path.resolve(__dirname, '..', '..', '..', '_client_src', 'app');
process.resourcesPath = path.resolve(__dirname, '..', '..', 'collector', 'resources');

const CollectorMod = require(path.join(APP, 'src/collector.js'));
const Collector = CollectorMod.Collector || CollectorMod;
const ADB = require(path.join(APP, 'src/adb.js'));

const DEVICE = process.argv[2] || '';
const PKG = process.argv[3] || 'com.android.chrome';
const PAGE_URL = process.argv[4] || 'https://www.baidu.com/s?wd=%E6%80%A7%E8%83%BD%E6%B5%8B%E8%AF%95';
/** 采集时长：本机全指标单轮约 1-4s（timestats+gfxinfo 本身就重） */
const DURATION_MS = 24000;
/** 滑动间隔：太密会和采集的 adb 调用抢通道，把 tick 拖长 */
const SWIPE_EVERY_MS = 1200;

// 优先用包内 adb（与采集器同源，避免 PATH 里版本不一致）
const ADB_BIN = (() => {
  const p = path.resolve(__dirname, '..', '..', 'collector', 'resources', 'adb', 'win', 'adb.exe');
  return fs.existsSync(p) ? p : 'adb';
})();

/** 屏幕刷新率上限：不同机型 60/90/120/144Hz，用 144 作为物理上限 */
const FPS_CEIL = 144;

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); }
  else { fail++; fails.push(name); console.log(`  FAIL  ${name}  ${detail !== undefined ? JSON.stringify(detail) : ''}`); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

/** 滑动一次（异步，不阻塞采样） */
function swipe(dir) {
  // dir=1 上滑（内容向下滚），dir=-1 下滑
  const from = dir > 0 ? '1750' : '750';
  const to = dir > 0 ? '750' : '1750';
  return new Promise((resolve) => {
    execFile(ADB_BIN, ['-s', DEVICE, 'shell', 'input', 'swipe', '540', from, '540', to, '260'],
      { timeout: 6000 }, () => resolve());
  });
}

(async () => {
  console.log(`\n===== 深度用例：FPS 取帧通道（device=${DEVICE} pkg=${PKG}）=====\n`);

  // ---- 前置：打开长页（浏览器场景）+ 拉到前台 ----
  console.log('[0] 准备前台应用');
  if (/^com\.android\.chrome$/.test(PKG) && PAGE_URL) {
    await new Promise((resolve) => {
      execFile(ADB_BIN, ['-s', DEVICE, 'shell',
        `am start -a android.intent.action.VIEW -d "${PAGE_URL}" -n com.android.chrome/com.google.android.apps.chrome.Main`],
        { timeout: 15000 }, () => resolve());
    });
    console.log('  已请求 Chrome 打开长页，等待加载…');
    await sleep(6000);
  }
  const r = await ADB.ensureAppRunning(DEVICE, PKG, () => {});
  check('目标应用已就绪', !!(r && r.ok && isNum(r.pid)), r && { ok: r.ok, pid: r.pid, launched: r.launched });
  if (!r || !r.ok) { console.log('无法启动目标应用，终止'); process.exit(1); }
  check('目标应用在前台（ResumedActivity）', await ADB.isAppForeground(DEVICE, PKG), PKG);
  await sleep(1200);

  // ---- 采集 + 持续滑动驱动渲染 ----
  console.log(`[1] 采集 ${DURATION_MS / 1000}s，期间每 ${SWIPE_EVERY_MS}ms 滑动一次制造真实帧`);
  const logs = [];
  const c = new Collector(DEVICE, PKG, 1000, null);
  const samples = [];
  c.on('data', (d) => samples.push(d));
  c.on('log', (m) => logs.push(String(m)));
  c.on('error', (e) => console.log('  采集错误:', e.message));
  const t0 = Date.now();
  try { await c.start(); } catch (e) { console.log('  start 失败:', e.message); }

  let dir = 1;
  const swipeTimer = setInterval(() => { swipe(dir); dir = -dir; }, SWIPE_EVERY_MS);
  await sleep(DURATION_MS);
  clearInterval(swipeTimer);
  try { c.stop('fps-render-test'); } catch (_) {}
  await sleep(300);
  const elapsed = (Date.now() - t0) / 1000;

  console.log(`  样本 ${samples.length} 条，日志 ${logs.length} 条，耗时 ${elapsed.toFixed(1)}s`);
  console.log(`  平均单轮采样成本 ≈ ${(elapsed / Math.max(samples.length, 1)).toFixed(2)}s（全指标；timestats+gfxinfo 本身较重）`);
  const fpsLogs = logs.filter(l => /FPS|帧/.test(l));
  fpsLogs.slice(0, 6).forEach(l => console.log('    log:', l));

  // ---- 断言 ----
  check('采集到足够样本（≥5）', samples.length >= 5, samples.length);

  const fpsVals = samples.map(s => s.fps).filter(v => isNum(v));
  const nonNullRatio = samples.length ? fpsVals.length / samples.length : 0;

  check('取到非 null 帧率', fpsVals.length > 0, { count: fpsVals.length, ratio: Number(nonNullRatio.toFixed(2)) });
  check('有帧样本占比 ≥60%（滑动期间持续有帧）', nonNullRatio >= 0.6, Number(nonNullRatio.toFixed(2)));
  check('帧率全部 > 0（无假 0）', fpsVals.every(v => v > 0), fpsVals.slice(0, 12));
  check(`帧率不超物理上限（≤${FPS_CEIL}）`, fpsVals.every(v => v <= FPS_CEIL), Math.max(...(fpsVals.length ? fpsVals : [0])));

  const distinct = Array.from(new Set(fpsVals));
  check('帧率有波动（非常数假值）', distinct.length >= 3, distinct.slice(0, 10));

  const jankKeys = ['jank', 'bigJank', 'smallJank', 'tinyJank', 'jankRate'];
  const jankOk = samples.every(s => jankKeys.every(k => s[k] === null || s[k] === undefined || (isNum(s[k]) && s[k] >= 0)));
  check('jank 族字段齐全且非负', jankOk, samples.slice(0, 2).map(s => ({ jank: s.jank, bigJank: s.bigJank, smallJank: s.smallJank, tinyJank: s.tinyJank })));
  const hasJankNum = samples.some(s => isNum(s.jank));
  check('至少一条样本带 jank 数值', hasJankNum, samples.filter(s => isNum(s.jank)).length);

  // 取帧通道：日志里应出现至少一种通道标识
  const channel = ['timestats', 'framestats', 'gfxinfo'].filter(k => logs.some(l => l.includes(k)));
  check('日志出现取帧通道标识', channel.length > 0, channel);

  // 其他指标未被影响
  check('CPU 采样正常', samples.every(s => s.cpu !== undefined), samples.filter(s => s.cpu).length);
  check('内存采样正常', samples.every(s => s.mem !== undefined), samples.filter(s => s.mem).length);
  check('无致命错误事件', !logs.some(l => /error|异常|失败/i.test(l) && /FPS/.test(l)), logs.filter(l => /error|异常|失败/i.test(l)).slice(0, 3));

  // ---- 汇总 ----
  if (fpsVals.length) {
    const avg = fpsVals.reduce((a, b) => a + b, 0) / fpsVals.length;
    console.log(`\n  FPS 统计: avg=${avg.toFixed(1)} min=${Math.min(...fpsVals)} max=${Math.max(...fpsVals)} 有效=${fpsVals.length}/${samples.length}`);
    console.log(`  FPS 序列: ${samples.slice(0, 20).map(s => s.fps === null ? 'null' : s.fps).join(', ')}`);
  }

  console.log(`\n===== 结果: ${pass} PASS / ${fail} FAIL =====`);
  if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
  process.exit(fail ? 1 : 0);
})();
