'use strict';
/**
 * 真包参数准确性 e2e —— 用**解包后的便携包**采集真机，再拿独立基准逐项核对参数。
 *
 * 与其它真机用例的区别：
 *   · 其它用例 require 仓库源码（`_client_src/app/src/*.js`），验证的是「源码改了」；
 *     这里启动的是包里的 `collector/Perfara.exe`（同一份 app.asar + 同一套运行时），
 *     验证的是「用户手里那份包算得对不对」。
 *   · 基准不用包里的代码：FPS 从 `gfxinfo framestats` 自己数帧，CPU 自己读
 *     `/proc/stat` + `/proc/<pid>/stat` 算，PSS 自己解析 `dumpsys meminfo`，
 *     刷新率读 `settings get system peak_refresh_rate` 与支持模式列表。
 *   · 最后再把包里的 `perf.html` 用真数据渲染一遍，读**页面上显示的数字**——
 *     采集 → data.js → 报告页这条链上任何一环算错都会在这里露出来。
 *
 * 用法：
 *   PERFARA_PKG_ROOT=<解包目录> node param_accuracy_pkg.js <deviceId> [packageName] [seconds]
 *   不设 PERFARA_PKG_ROOT 时退回仓库内的 perfara/collector（便于开发期快速回归）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const pw = require('playwright-core');

const PROJ = path.resolve(__dirname, '..', '..', '..');
const ROOT = process.env.PERFARA_PKG_ROOT || path.join(PROJ, 'perfara');
const COLLECTOR = fs.existsSync(path.join(ROOT, 'collector', 'Perfara.exe'))
  ? path.join(ROOT, 'collector') : ROOT;
const APP_EXE = path.join(COLLECTOR, 'Perfara.exe');
const REPORTS = path.join(COLLECTOR, 'resources', 'reports');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const DEVICE = process.argv[2] || '';
const PKG = process.argv[3] || 'com.android.chrome';
const SECONDS = parseInt(process.argv[4] || '60', 10);
if (!DEVICE) {
  console.error('用法: PERFARA_PKG_ROOT=<解包目录> node param_accuracy_pkg.js <deviceId> [packageName] [seconds]');
  process.exit(2);
}

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + '  -> ' + JSON.stringify(detail)); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const adb = (args, opt) => execFileSync('adb', ['-s', DEVICE, ...args],
  Object.assign({ encoding: 'utf8', timeout: 20000, maxBuffer: 32 * 1024 * 1024 }, opt));

// ── 独立基准：解析器自己写，不复用包里那份 ───────────────────────────────────

/** /proc/stat 的 cpu 汇总行 → {total, idle} */
function parseSysStat(raw) {
  const line = String(raw || '').split('\n').find(l => l.startsWith('cpu '));
  if (!line) return null;
  const n = line.trim().split(/\s+/).slice(1).map(Number);
  if (n.length < 5 || n.some(v => !Number.isFinite(v))) return null;
  return { total: n.reduce((a, b) => a + b, 0), idle: n[3] + (n[4] || 0) };
}

/** /proc/<pid>/stat → utime+stime（jiffies） */
function parsePidJiffies(raw) {
  const s = String(raw || '');
  const close = s.lastIndexOf(')');
  if (close < 0) return null;
  const rest = s.slice(close + 1).trim().split(/\s+/);
  if (rest.length < 13) return null;
  const u = parseInt(rest[11], 10), st = parseInt(rest[12], 10);
  return (Number.isFinite(u) && Number.isFinite(st)) ? u + st : null;
}

/** dumpsys meminfo → App Summary 的 TOTAL PSS（KB） */
function parseTotalPssKb(out) {
  const s = String(out || '');
  const m = /TOTAL PSS:\s+(\d+)/.exec(s);
  if (m) return parseInt(m[1], 10);
  // 老 ROM 没有 App Summary：退回表格里的 TOTAL 行（第二列是 PSS）
  const m2 = /^\s*TOTAL\s+(\d+)/m.exec(s);
  return m2 ? parseInt(m2[1], 10) : null;
}

/**
 * SurfaceFlinger timestats 里的图层统计。
 *
 * 为什么用它当 FPS 基准：gfxinfo 只统计被测进程自己的 UI 线程帧，Chrome 这类
 * 「浏览器 UI + 渲染进程」的包，网页内容的帧根本不进 gfxinfo（实测包内 111fps
 * 时 gfxinfo 只有 19fps，差 5 倍）。SurfaceFlinger 的 per-layer totalFrames 是
 * Android 自己数的呈现帧，与产品无关，且 `displayRefreshRate` 顺手给出了真实刷新率。
 */
function parseTimestats(out) {
  const s = String(out || '');
  const num = (re) => { const m = re.exec(s); return m ? Number(m[1]) : null; };
  const res = {
    statsStart: num(/^statsStart\s*=\s*(\d+)/m),
    statsEnd: num(/^statsEnd\s*=\s*(\d+)/m),
    displayRefreshRate: num(/^displayRefreshRate\s*=\s*([0-9.]+)/m),
    layers: [],
  };
  const blocks = s.split(/^layerName\s*=\s*/m).slice(1);
  for (const b of blocks) {
    const name = (b.split('\n')[0] || '').trim();
    const tf = /^totalFrames\s*=\s*(\d+)/m.exec(b);
    if (!name || !tf) continue;
    res.layers.push({ name, totalFrames: parseInt(tf[1], 10) });
  }
  return res;
}

/** 设备真实峰值刷新率：用户设置优先，其次支持模式里的最大 fps */
function devicePeakHz() {
  let fromSetting = null, fromModes = null;
  try {
    const v = parseFloat(String(adb(['shell', 'settings get system peak_refresh_rate']) || '').trim());
    if (Number.isFinite(v) && v >= 24 && v <= 480) fromSetting = v;
  } catch (_) {}
  try {
    const d = adb(['shell', 'dumpsys display']);
    const fps = Array.from(String(d).matchAll(/fps=([0-9.]+)/g)).map(m => parseFloat(m[1]));
    const ok = fps.filter(v => Number.isFinite(v) && v >= 24 && v <= 480);
    if (ok.length) fromModes = Math.max(...ok);
  } catch (_) {}
  return { setting: fromSetting, modes: fromModes };
}

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const median = a => {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

(async () => {
  console.log(`\n===== 真包参数准确性  device=${DEVICE}  pkg=${PKG}  ${SECONDS}s =====`);
  console.log(`  包根: ${ROOT}`);
  console.log(`  采集端: ${APP_EXE}`);
  console.log(`  报告目录: ${REPORTS}\n`);

  check('包内采集端存在', fs.existsSync(APP_EXE), APP_EXE);
  check('包内报告目录存在', fs.existsSync(REPORTS), REPORTS);
  if (!fs.existsSync(APP_EXE)) { console.log('\n包不完整，无法继续'); process.exit(2); }

  const dataPath = path.join(REPORTS, 'data.js');
  const preMtime = fs.existsSync(dataPath) ? fs.statSync(dataPath).mtimeMs : 0;

  // 设备侧准备：亮屏解锁、确保目标应用已安装
  try { adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']); } catch (_) {}
  try { adb(['shell', 'wm', 'dismiss-keyguard']); } catch (_) {}
  const installed = String(adb(['shell', `pm list packages ${PKG}`]) || '').includes(PKG);
  check('目标应用已安装', installed, PKG);
  if (!installed) { console.log('\n应用未安装，无法继续'); process.exit(2); }

  // 冷启动：先杀掉被测应用，让采集启动时走 ensureAppRunning 的冷启动路径，
  // 这样前几秒必然出现「加载段」掉帧，才能验证加载段剔除是否真的生效。
  try { adb(['shell', `am force-stop ${PKG}`]); } catch (_) {}

  // 动画页：稳定出帧，用来让「帧率」有可比的基准
  const PAGE = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#111}</style>
<canvas id="c"></canvas><script>
const c=document.getElementById('c'),x=c.getContext('2d');
function fit(){c.width=innerWidth;c.height=innerHeight}addEventListener('resize',fit);fit();
let n=0;
function frame(t){
  n++;
  x.fillStyle='#111';x.fillRect(0,0,c.width,c.height);
  for(let i=0;i<40;i++){const a=i/40*6.283+t/900;
    x.beginPath();x.arc(c.width/2+Math.cos(a)*160,c.height/2+Math.sin(a)*160,26,0,6.283);
    x.fillStyle='hsla('+(i*9%360)+',85%,62%,.85)';x.fill();}
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
</script>`;
  // 重载页：每帧固定烧 30ms CPU，把帧率压到 ~25fps，用来稳定制造「加载段」。
  const HEAVY = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#111}</style>
<canvas id="c"></canvas><script>
const c=document.getElementById('c'),x=c.getContext('2d');
function fit(){c.width=innerWidth;c.height=innerHeight}addEventListener('resize',fit);fit();
function frame(t){
  const end=performance.now()+30; while(performance.now()<end){Math.sqrt(Math.random());}
  x.fillStyle='#111';x.fillRect(0,0,c.width,c.height);
  x.fillStyle='#f60';x.fillRect((t/8)%c.width,0,80,80);
  requestAnimationFrame(frame);}
requestAnimationFrame(frame);
</script>`;
  const pageSrv = http.createServer((req, res) => {
    const heavy = String(req.url || '').includes('heavy');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(heavy ? HEAVY : PAGE);
  });
  await new Promise(r => pageSrv.listen(0, '127.0.0.1', r));
  const pagePort = pageSrv.address().port;
  const pageUrl = `http://127.0.0.1:${pagePort}/`;
  try { adb(['reverse', `tcp:${pagePort}`, `tcp:${pagePort}`]); } catch (_) {}

  // 清掉 ELECTRON_RUN_AS_NODE：否则 Electron 退化成纯 Node，窗口一闪就退
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;

  const electronApp = await pw._electron.launch({ executablePath: APP_EXE, env, timeout: 90000 });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2500);
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e.message || e)));

  const deviceReady = await page.waitForFunction((id) => {
    const sel = document.getElementById('sel-device');
    if (!sel) return false;
    if (!Array.from(sel.options).some(o => o.value === id)) return false;
    sel.value = id;
    sel.dispatchEvent(new Event('change'));
    return true;
  }, DEVICE, { timeout: 20000 }).then(() => true).catch(() => false);
  check('采集窗口识别到目标设备', deviceReady, deviceReady);

  let started = { ok: false };
  let tStart = 0;
  if (deviceReady) {
    const appReady = await page.waitForFunction((pkg) => {
      const sel = document.getElementById('sel-app');
      return !!(sel && !sel.disabled && Array.from(sel.options).some(o => o.value === pkg));
    }, PKG, { timeout: 60000 }).then(() => true).catch(() => false);
    check('应用列表包含目标包名', appReady, appReady);
    if (appReady) {
      await page.evaluate((pkg) => {
        const sel = document.getElementById('sel-app');
        sel.value = pkg;
        sel.dispatchEvent(new Event('change'));
      }, PKG);
      // 清空 SurfaceFlinger 计时：让跑完后的 totalFrames 只覆盖本轮采集
      try { adb(['shell', 'dumpsys SurfaceFlinger --timestats -enable']); } catch (_) {}
      try { adb(['shell', 'dumpsys SurfaceFlinger --timestats -clear']); } catch (_) {}
      const tStart0 = Date.now();
      await page.click('#btn-start');
      tStart = tStart0;
      await page.waitForTimeout(3000);
      started = await page.evaluate(() => {
        const stop = document.getElementById('btn-stop');
        const badge = document.querySelector('.badge');
        return { ok: !!(stop && !stop.disabled), badge: badge ? badge.textContent.trim() : '' };
      });
    }
  }
  check('真包采集启动成功', !!(started && started.ok), started);
  if (!started || !started.ok) {
    try { adb(['reverse', '--remove', `tcp:${pagePort}`]); } catch (_) {}
    pageSrv.close();
    await electronApp.close().catch(() => {});
    console.log(`\n===== 结果: ${pass} PASS / ${fail} FAIL =====`);
    process.exit(1);
  }

  // 冷启动被测应用 → 天然产生「加载段」掉帧，用于验证加载段剔除
  const openPage = () => {
    try { adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', pageUrl, '-p', PKG]); } catch (_) {}
  };
  const frontPkg = () => {
    try {
      const m = /topResumedActivity=ActivityRecord\{\S+ u\d+ ([\w.]+)\//.exec(adb(['shell', 'dumpsys activity activities']));
      return m ? m[1] : '';
    } catch (_) { return ''; }
  };
  const openHeavy = () => {
    try { adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', pageUrl + 'heavy.html', '-p', PKG]); } catch (_) {}
  };
  // 先跑 8s 重载页：冷启动 + 高负载，必然出现一段明显低帧
  openHeavy();
  await sleep(8000);
  openPage();
  await sleep(1200);

  // ── 并行采基准 ────────────────────────────────────────────────────────────
  const gt = [];          // {t, fps, cpuPct, pssKb}
  let prevSys = null, prevPid = null, prevT = 0;
  let pid = null;
  try {
    const p = /(\d+)/.exec(String(adb(['shell', `pidof ${PKG}`]) || ''));
    pid = p ? parseInt(p[1], 10) : null;
  } catch (_) {}
  check('取到被测进程 pid', !!pid, pid);

  const deadline = Date.now() + SECONDS * 1000;
  let round = 0;
  while (Date.now() < deadline) {
    if (round % 4 === 0 && frontPkg() !== PKG) openPage();
    round++;
    const t = Date.now();
    try {
      const sOut = adb(['shell', `cat /proc/stat; echo ---P---; cat /proc/${pid}/stat`]);
      const [sysPart, pidPart] = String(sOut).split('---P---');
      const sys = parseSysStat(sysPart);
      const pj = parsePidJiffies(pidPart);
      // 在线核数从同一份 /proc/stat 的 cpuN 行数出来，不写死
      const cores = Math.max(1, (String(sysPart).match(/^cpu\d+/gm) || []).length);
      let cpuPct = null;
      if (sys && pj != null && prevSys && prevPid != null) {
        const dTotal = sys.total - prevSys.total;
        const dPid = pj - prevPid;
        if (dTotal > 0 && dPid >= 0) cpuPct = (dPid / (dTotal / cores)) * 100;
      }
      prevSys = sys; prevPid = pj; prevT = t;

      const mOut = adb(['shell', `dumpsys meminfo ${pid}`]);
      const pssKb = parseTotalPssKb(mOut);

      gt.push({ t, cpuPct, pssKb });
      process.stdout.write(`\r  基准采样 ${gt.length} 次（${Math.max(0, Math.round((deadline - Date.now()) / 1000))}s 剩余）   `);
    } catch (e) {
      gt.push({ t, cpuPct: null, pssKb: null, err: e.message });
    }
    await sleep(700);
  }
  process.stdout.write('\n');

  // 停采
  await page.click('#btn-stop').catch(() => {});
  await page.waitForTimeout(2500);

  // 等 data.js 落盘（本轮新写）
  let wrote = false;
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(dataPath) && fs.statSync(dataPath).mtimeMs > preMtime + 500) { wrote = true; break; }
    await sleep(500);
  }
  check('本轮采集写出 data.js', wrote, { path: dataPath, preMtime });
  if (!wrote) {
    try { adb(['reverse', '--remove', `tcp:${pagePort}`]); } catch (_) {}
    pageSrv.close();
    await electronApp.close().catch(() => {});
    console.log(`\n===== 结果: ${pass} PASS / ${fail} FAIL =====`);
    process.exit(1);
  }

  // ── 包产出的数据 ──────────────────────────────────────────────────────────
  let data = null;
  try {
    const raw = fs.readFileSync(dataPath, 'utf8');
    data = JSON.parse(raw.replace(/^var data\s*=\s*/, '').replace(/;\s*$/, ''));
  } catch (e) {
    check('data.js 可解析', false, e.message);
  }
  check('data.js 可解析', !!data, data && Object.keys(data));
  if (!data) {
    try { adb(['reverse', '--remove', `tcp:${pagePort}`]); } catch (_) {}
    pageSrv.close();
    await electronApp.close().catch(() => {});
    console.log(`\n===== 结果: ${pass} PASS / ${fail} FAIL =====`);
    process.exit(1);
  }

  const perf = Array.isArray(data.perf) ? data.perf : [];
  const fpsPts = perf.filter(p => typeof p.fps === 'number' && p.fps > 0);
  const dp = data.displayProfile || {};
  console.log(`\n  包内样本 ${perf.length} 条，fps 有效 ${fpsPts.length} 条；基准 ${gt.length} 次`);
  console.log(`  displayProfile = ${JSON.stringify(dp)}`);

  // A. 采集完整性
  check('采样点数 ≥ 30', perf.length >= 30, perf.length);
  check('fps 有效率 ≥ 80%', perf.length > 0 && fpsPts.length / perf.length >= 0.8,
    (fpsPts.length / Math.max(1, perf.length)).toFixed(3));
  check('无 fps=0 的假值（未测量应为 null）', perf.every(p => p.fps !== 0), perf.filter(p => p.fps === 0).length);
  check('schemaVersion = 9（跨品牌温度归类口径已版本化）',
    Number(data.schemaVersion) === 9, data.schemaVersion);

  // B. 刷新率 / 目标帧率
  // 三路独立来源：用户设置、支持模式列表、SurfaceFlinger 自己报的 displayRefreshRate
  const peak = devicePeakHz();
  const sfStats = parseTimestats(adb(['shell', 'dumpsys SurfaceFlinger --timestats -dump']));
  const trueHz = Math.max(peak.setting || 0, peak.modes || 0, sfStats.displayRefreshRate || 0) || null;
  console.log(`  设备真实刷新率 = ${trueHz}（setting=${peak.setting} modes=${peak.modes} SF=${sfStats.displayRefreshRate}）`);
  check('设备真实刷新率可判定（≥2 路来源一致）', trueHz > 0 && peak.modes && Math.abs(peak.modes - (sfStats.displayRefreshRate || 0)) < 0.6,
    { setting: peak.setting, modes: peak.modes, sf: sfStats.displayRefreshRate });
  // SurfaceFlinger 的 displayRefreshRate 带浮点噪声（实测 120.00001），
  // 严格相等会把「报对了」判成红 —— 按 0.5Hz 容差比，即肉眼可见的档位一致。
  check('包内 displayProfile.refreshRateHz 等于设备真实刷新率',
    trueHz > 0 && Number(dp.refreshRateHz) > 0
      && Math.abs(Number(dp.refreshRateHz) - Number(trueHz)) <= 0.5,
    { reported: dp.refreshRateHz, true: trueHz, source: dp.source });
  // 报告页的 deviceTargetHz() 读的是 data.loading.targetHz；这一段缺失时，
  // 「设备自报刷新率优先」整条链在报告侧静默失效，目标帧率退回 P95 推断。
  // 必须真的带 targetHz：只校验 targetSource 存在的话，分析失败时写的
  // { targetSource: 'unavailable' } 也会通过 —— 那就把降级当成了成功。
  check('data.js 带加载段元数据（报告据此用设备刷新率定目标）',
    !!(data.loading && Number(data.loading.targetHz) > 0
      && data.loading.targetSource && data.loading.targetSource !== 'unavailable'),
    data.loading || null);

  // C. FPS 准确性（SurfaceFlinger 呈现帧数 vs 包内逐拍 fps）
  // 采集开始前已 clear，跑完后的 totalFrames 只覆盖本轮；取被测包名下帧数最多的图层
  // （Chrome 的内容帧在 ChromeChildSurface，不在 Activity 层）。
  const winSec = (sfStats.statsEnd && sfStats.statsStart)
    ? (sfStats.statsEnd - sfStats.statsStart) : null;
  const pkgLayers = sfStats.layers
    .filter(l => l.name && l.name.includes(PKG))
    .sort((a, b) => b.totalFrames - a.totalFrames);
  const topLayer = pkgLayers[0] || null;
  const sfFps = (topLayer && winSec > 0) ? topLayer.totalFrames / winSec : null;
  console.log(`  SurfaceFlinger: 图层=${topLayer ? topLayer.name : '--'} 帧数=${topLayer ? topLayer.totalFrames : '--'} 窗口=${winSec ? winSec + 's' : '--'} → ${sfFps ? sfFps.toFixed(1) : '--'} fps`);
  check('SurfaceFlinger 统计到被测包图层', !!topLayer && topLayer.totalFrames > 0, topLayer);
  check('SurfaceFlinger 统计窗口 ≥ 30s', winSec != null && winSec >= 30, winSec);

  const appMeanFps = mean(fpsPts.map(p => p.fps));
  if (sfFps != null && appMeanFps != null) {
    const rel = Math.abs(appMeanFps - sfFps) / sfFps;
    console.log(`  包内均值 ${appMeanFps.toFixed(1)} fps vs SurfaceFlinger ${sfFps.toFixed(1)} fps → 相对误差 ${(rel * 100).toFixed(1)}%`);
    check('FPS 聚合均值相对误差 ≤ 12%', rel <= 0.12,
      { app: +appMeanFps.toFixed(1), sf: +sfFps.toFixed(1), rel: +(rel * 100).toFixed(1) });
    // 逐拍积分出的总帧数应与 SF 计数同量级（允许首尾各半拍误差）
    const appFrames = fpsPts.reduce((a, p) => a + p.fps * ((p.dtMs || 1000) / 1000), 0);
    const frameRel = Math.abs(appFrames - topLayer.totalFrames) / topLayer.totalFrames;
    console.log(`  包内积分帧数 ${Math.round(appFrames)} vs SF ${topLayer.totalFrames} → 相对误差 ${(frameRel * 100).toFixed(1)}%`);
    check('累计帧数与 SurfaceFlinger 计数相对误差 ≤ 15%', frameRel <= 0.15,
      { app: Math.round(appFrames), sf: topLayer.totalFrames });
  }
  check('FPS 不超过屏幕刷新率 × 1.05（无越界值）',
    trueHz > 0 && fpsPts.every(p => p.fps <= trueHz * 1.05),
    { max: Math.max(...fpsPts.map(p => p.fps)), limit: trueHz * 1.05 });

  // D. CPU 准确性
  const cpuPairs = [];
  for (const g of gt) {
    if (g.cpuPct == null) continue;
    let best = null, bestD = Infinity;
    for (const p of perf) {
      const v = p.cpu && p.cpu.procCpu;
      if (typeof v !== 'number') continue;
      const d = Math.abs(p.timestamp - g.t);
      if (d < bestD) { bestD = d; best = v; }
    }
    if (best != null && bestD <= 2500) cpuPairs.push({ app: best, gt: g.cpuPct });
  }
  console.log(`  可对齐的 CPU 对比点 ${cpuPairs.length} 个`);
  check('CPU 可对齐点 ≥ 8', cpuPairs.length >= 8, cpuPairs.length);
  if (cpuPairs.length) {
    const absErr = cpuPairs.map(p => Math.abs(p.app - p.gt));
    const medAbs = median(absErr);
    const appMean = mean(cpuPairs.map(p => p.app));
    const gtMean = mean(cpuPairs.map(p => p.gt));
    console.log(`  CPU 逐点中位绝对误差 = ${medAbs.toFixed(2)}pp；包均值 ${appMean.toFixed(1)} vs 基准均值 ${gtMean.toFixed(1)}`);
    check('CPU 逐点中位绝对误差 ≤ 6pp', medAbs <= 6, medAbs.toFixed(2));
    check('CPU 聚合均值绝对误差 ≤ 6pp', Math.abs(appMean - gtMean) <= 6,
      { app: +appMean.toFixed(1), gt: +gtMean.toFixed(1) });
  }

  // E. 内存准确性（PSS）
  const memPairs = [];
  for (const g of gt) {
    if (g.pssKb == null) continue;
    let best = null, bestD = Infinity;
    for (const p of perf) {
      const v = p.mem && p.mem.totalPss;
      if (typeof v !== 'number') continue;
      const d = Math.abs(p.timestamp - g.t);
      if (d < bestD) { bestD = d; best = v; }
    }
    if (best != null && bestD <= 4000) memPairs.push({ app: best, gt: g.pssKb / 1024 });
  }
  console.log(`  可对齐的内存对比点 ${memPairs.length} 个`);
  check('内存可对齐点 ≥ 6', memPairs.length >= 6, memPairs.length);
  if (memPairs.length) {
    const absErr = memPairs.map(p => Math.abs(p.app - p.gt));
    const medAbs = median(absErr);
    const gtMean = mean(memPairs.map(p => p.gt));
    console.log(`  PSS 逐点中位绝对误差 = ${medAbs.toFixed(1)}MB；基准均值 ${gtMean.toFixed(1)}MB`);
    check('PSS 逐点中位绝对误差 ≤ max(15MB, 10%)', medAbs <= Math.max(15, gtMean * 0.10), medAbs.toFixed(1));
  }

  // F. 口径自洽（不依赖基准，纯内部一致性）
  const pctOk = perf.filter(p => p.ftP50 != null && p.ftP99 != null)
    .every(p => p.ftP50 <= p.ftP90 + 1e-6 && p.ftP90 <= p.ftP95 + 1e-6 && p.ftP95 <= p.ftP99 + 1e-6);
  check('帧耗时分位单调 P50≤P90≤P95≤P99', pctOk,
    perf.filter(p => p.ftP50 != null && !(p.ftP50 <= p.ftP90 && p.ftP90 <= p.ftP95 && p.ftP95 <= p.ftP99)).slice(0, 2));
  const jankOk = perf.filter(p => p.jank != null && p.bigJank != null && p.smallJank != null)
    .every(p => p.bigJank <= p.jank && p.bigJank <= p.smallJank);
  check('卡顿分级自洽 BigJank ≤ Jank 且 ≤ SmallJank', jankOk,
    perf.filter(p => p.bigJank != null && !(p.bigJank <= p.jank && p.bigJank <= p.smallJank)).slice(0, 2));
  check('页面无 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3));

  // ── 用包里的 perf.html 渲染真数据，读页面上显示的数字 ─────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-acc-'));
  for (const f of ['perf.html', 'echarts.min.js', 'data.js']) {
    const src = path.join(REPORTS, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f));
  }
  const srv = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'perf.html';
    const fp = path.join(tmp, name);
    if (!fp.startsWith(tmp) || !fs.existsSync(fp)) { res.writeHead(404); res.end('nf'); return; }
    const ext = path.extname(fp).toLowerCase();
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(fp));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const rport = srv.address().port;

  const browser = await pw.chromium.launch({ executablePath: EDGE, headless: true });
  const rp = await browser.newPage();
  const rErrors = [];
  rp.on('pageerror', e => rErrors.push(String(e.message || e)));
  await rp.goto(`http://127.0.0.1:${rport}/perf.html`, { waitUntil: 'domcontentloaded' });
  const rendered = await rp.waitForFunction(() => {
    const v = document.querySelector('[id="val-fps"]');
    return !!(v && v.textContent.trim() && v.textContent.trim() !== '--');
  }, { timeout: 30000 }).then(() => true).catch(() => false);
  check('报告页用真包数据渲染成功', rendered, rendered);
  const kpi = rendered ? await rp.evaluate(() => {
    const pick = (id) => {
      const els = Array.from(document.querySelectorAll('[id="' + id + '"]'));
      const vis = els.find(e => e.offsetParent !== null) || els[0];
      return vis ? vis.textContent.trim() : null;
    };
    const reachUnit = (() => {
      const c = document.getElementById('card-reach');
      const u = c && c.querySelector('.card-unit');
      return u ? u.textContent.trim() : '';
    })();
    return {
      fps: pick('val-fps'), proccpu: pick('val-proccpu'), mem: pick('val-mem'),
      jank: pick('val-jank'), bigjank: pick('val-bigjank'),
      reach: pick('val-reach'), ft: pick('val-ft'), low: pick('val-low'), oneLow: pick('val-1low'),
      reachUnit,
    };
  }) : null;
  if (kpi) {
    console.log(`  报告页显示: ${JSON.stringify(kpi)}`);
    const targetM = /目标\s*([0-9.]+)/.exec(kpi.reachUnit || '');
    const shownTarget = targetM ? parseFloat(targetM[1]) : null;
    check('报告页显示目标帧率 = 设备真实峰值',
      shownTarget != null && trueHz > 0 && Math.abs(shownTarget - trueHz) < 0.6,
      { shown: shownTarget, true: trueHz });

    const shownFps = parseFloat(kpi.fps);
    const shownReach = parseFloat(kpi.reach);
    const shownFt = parseFloat(kpi.ft);
    const shownLow = parseFloat(kpi.low);
    const shown1Low = parseFloat(kpi.oneLow);

    if (shownTarget && Number.isFinite(shownFps)) {
      // 报告页的均值已剔除加载段，用页面自己显示的均值反推才可比。
      // 容差 = ±0.6（页面自身取整） + 显示 FPS ±0.5 的取整传导
      //   （截图显示 FPS 取整到整数，57.5→57 时 57.5/60 与 57/60 差 0.83%，
      //     ×.5 边界会超过原 ±0.6 容差；目标 60Hz 时传导上限 = 100/60*0.5≈0.83）。
      const expectReach = (shownFps / shownTarget) * 100;
      const reachTol = 0.6 + (100 / shownTarget) * 0.5;
      check('达帧率 = 平均FPS ÷ 目标 × 100（±容差，显示值取整）',
        Number.isFinite(shownReach) && Math.abs(shownReach - expectReach) <= reachTol,
        { shownReach, expect: +expectReach.toFixed(1), tol: +reachTol.toFixed(2) });
      check('均帧 = 1000 ÷ 平均FPS（±8%）',
        Number.isFinite(shownFt) && Math.abs(shownFt - 1000 / shownFps) / (1000 / shownFps) <= 0.08,
        { shownFt, expect: +(1000 / shownFps).toFixed(1) });
      check('1%Low ≤ 平均 FPS', Number.isFinite(shown1Low) ? shown1Low <= shownFps * 1.02 : true,
        { shown1Low, shownFps });
      // 低帧占比：剔除开头的加载段后再复算（报告页同样剔除，否则分子分母都含加载段）
      let li = 0;
      while (li < fpsPts.length && fpsPts[li].fps < shownTarget * 0.5) li++;
      const kept = fpsPts.slice(li);
      const lowPct = kept.length ? kept.filter(p => p.fps < shownTarget * 0.8).length / kept.length * 100 : null;
      console.log(`  剔除前 ${li} 个加载段采样，剩余 ${kept.length} 个用于复算`);
      check('低帧占比与非加载段复算一致（±3pp）',
        lowPct == null || !Number.isFinite(shownLow) || Math.abs(shownLow - lowPct) <= 3,
        { shownLow, recomputed: lowPct == null ? null : +lowPct.toFixed(1) });
    }
    check('报告页无 JS 异常', rErrors.length === 0, rErrors.slice(0, 3));
  }
  await browser.close().catch(() => {});
  srv.close();

  // G. 加载段剔除：冷启动必有一段低帧，剔除后均值应高于全段均值
  const allFps = perf.map(p => p.fps).filter(v => typeof v === 'number' && v > 0);
  const rawMean = mean(allFps);
  const shownFpsNum = kpi ? parseFloat(kpi.fps) : NaN;
  const early = perf.slice(0, Math.min(12, perf.length)).map(p => p.fps).filter(v => typeof v === 'number' && v > 0);
  const hadDip = early.length > 0 && Math.min(...early) < (trueHz || 60) * 0.5;
  console.log(`  全段均值 ${rawMean == null ? '--' : rawMean.toFixed(1)}；报告均值 ${Number.isFinite(shownFpsNum) ? shownFpsNum : '--'}；冷启动掉帧=${hadDip}`);
  if (hadDip && Number.isFinite(shownFpsNum)) {
    check('加载段被剔除（报告均值 > 全段均值）', shownFpsNum > rawMean + 0.5,
      { report: shownFpsNum, raw: +rawMean.toFixed(1) });
  } else {
    console.log('  [skip] 本轮未形成明显加载段，跳过剔除断言');
  }

  // 收尾
  try { adb(['reverse', '--remove', `tcp:${pagePort}`]); } catch (_) {}
  pageSrv.close();
  await electronApp.close().catch(() => {});
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

  console.log(`\n===== 结果: ${pass} PASS / ${fail} FAIL =====`);
  if (fail) console.log('失败项: ' + FAILS.join(' / '));
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\n[FATAL] ' + (e && e.stack || e));
  process.exit(1);
});
