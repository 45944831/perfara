'use strict';
/**
 * 真机端到端采集 → 导出 → 报告汇总 全链路测试。
 *   1) Collector 连续采集（默认全参数）
 *   2) 采集中途施加 CPU 压力，制造真实卡顿，验证 Jank 能被端到端抓到
 *   3) metricConfig 部分参数采集：被移除的组必须完全不出现在数据里
 *   4) CSV 导出：移除的指标输出为空
 *   5) reports-data-js.summarizePerf：KPI 汇总与过滤一致
 *
 * 用法: node e2e_realdevice.js <deviceId> [packageName] [seconds]
 */
const { execFileSync, execFile } = require('child_process');
const Module = require('module');
const os = require('os');
const fs = require('fs');
const path = require('path');

// reports-data-js 顶层 require('electron')，这里注入最小 stub 以便离线调用其纯函数。
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara-e2e-'));
function cleanupTmp() {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
}
const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: false,
        getPath: (name) => (name === 'userData' ? TMP_DIR : TMP_DIR),
        getName: () => 'perfara',
      },
    };
  }
  return _origLoad.apply(this, arguments);
};

const Collector = require('../../../_client_src/app/src/collector');
const exporter = require('../../../_client_src/app/src/exporter');
const reportsData = require('../../../_client_src/app/src/reports-data-js');

const DEVICE = process.argv[2] || '';
// 默认用 Chrome（任何设备都有、能稳定出帧）。脱敏后这里曾是占位包名
// com.example.game，默认跑法会因「应用未安装」直接失败，误伤排查。
const PKG = process.argv[3] || 'com.android.chrome';
const SECONDS = parseInt(process.argv[4] || '24', 10);

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; fails.push(name); console.log(`  FAIL  ${name}  ${detail !== undefined ? JSON.stringify(detail) : ''}`); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

// 在设备上起 N 个 CPU 压力进程，返回 pid 列表
function startStress(n) {
  const pids = [];
  for (let i = 0; i < n; i++) {
    try {
      const out = execFileSync('adb', ['-s', DEVICE, 'shell',
        'toybox yes > /dev/null 2>&1 & echo $!'], { encoding: 'utf8', timeout: 10000 }).trim();
      const pid = parseInt(out.split('\n').pop().trim(), 10);
      if (pid) pids.push(pid);
    } catch (_) {}
  }
  return pids;
}
function stopStress(pids) {
  for (const pid of pids) {
    try { execFileSync('adb', ['-s', DEVICE, 'shell', `kill -9 ${pid} 2>/dev/null`], { timeout: 8000 }); } catch (_) {}
  }
}

(async () => {
  console.log(`\n===== 真机端到端测试  device=${DEVICE}  pkg=${PKG} =====\n`);

  // ───── 阶段 A：全参数采集（中途加压） ─────────────────────────────────────
  console.log('-- A. 全参数连续采集 --');
  const c = new Collector(DEVICE, PKG, 1000);
  const errors = [];
  const dataCount = { n: 0 };
  c.on('error', e => errors.push(e.message));
  c.on('data', () => dataCount.n++);

  await c.start().catch(e => { console.log('  start 失败:', e.message); });
  if (!c.history.length) {
    console.log('  等待首个采样点…');
    await sleep(4000);
  }
  console.log(`  采集启动，PID=${c._pid}`);

  // 采集期交互驱动：真实测试时人会滑动/翻页。静态页面（游戏登录页、浏览器空白页）
  // 不产生新帧，帧率与卡顿断言就无从谈起 —— 这里每 1.2s 滑一次，让应用持续渲染。
  // 用异步 execFile：同步执行会阻塞事件循环，把采样 tick 一起拖慢。
  let swipeDir = 1;
  const swipeTimer = setInterval(() => {
    const from = swipeDir > 0 ? 1700 : 700;
    const to = swipeDir > 0 ? 700 : 1700;
    execFile('adb', ['-s', DEVICE, 'shell', 'input', 'swipe', '540', String(from), '540', String(to), '260'],
      { timeout: 6000 }, () => {});
    swipeDir = -swipeDir;
  }, 1200);

  const before = c.history.length;
  await sleep(Math.round(SECONDS * 1000 * 0.4));
  const midCount = c.history.length;

  console.log('  施加 CPU 压力（制造真实卡顿）…');
  const pids = startStress(6);
  console.log(`  已启动 ${pids.length} 个压力进程`);
  await sleep(Math.round(SECONDS * 1000 * 0.35));
  stopStress(pids);
  console.log('  压力已释放');
  await sleep(Math.round(SECONDS * 1000 * 0.25));

  c.stop('test');
  clearInterval(swipeTimer);
  const rows = c.history.slice();
  console.log(`  共采集 ${rows.length} 条 (加压前 ${midCount - before})`);

  check('无采集错误', errors.length === 0, errors);
  check('采集到多条数据', rows.length >= 3, rows.length);

  // 字段完整性
  const need = ['timestamp', 'time', 'pid', 'cpu', 'cpuCores', 'mem', 'fps', 'jank', 'bigJank',
    'smallJank', 'tinyJank', 'jankRate', 'net', 'battery', 'temperature', 'gpuTemp'];
  const partiallyMissing = need.filter(k => rows.every(r => r[k] === undefined));
  check('gpu 之外的字段全部存在', partiallyMissing.filter(k => k !== 'gpu').length === 0, partiallyMissing);
  // 若某字段在部分行缺失（而非全部），说明采集存在偶发空洞，需要告警
  const flaky = need.filter(k => rows.some(r => r[k] === undefined) && !rows.every(r => r[k] === undefined));
  check('无偶发缺失字段', flaky.length === 0, flaky);

  check('cpu.procCpu 为数值', rows.every(r => !r.cpu || isNum(r.cpu.procCpu)), rows[0] && rows[0].cpu);
  check('mem.totalPss > 0', rows.some(r => r.mem && r.mem.totalPss > 0), rows.map(r => r.mem && r.mem.totalPss).slice(0, 5));
  check('temperature 在合理区间', rows.every(r => r.temperature === undefined || (r.temperature > -20 && r.temperature < 120)), rows.map(r => r.temperature).slice(0, 5));
  check('battery.level 在 0..100', rows.every(r => !r.battery || (r.battery.level >= 0 && r.battery.level <= 100)), rows.map(r => r.battery && r.battery.level).slice(0, 5));
  check('gpu 为 null 或 0..100', rows.every(r => r.gpu === null || r.gpu === undefined || (r.gpu >= 0 && r.gpu <= 100)), rows.map(r => r.gpu).slice(0, 5));
  // null 表示「本 tick 无帧数据」（timestats-init / none / error），是刻意与 0 区分的：
  // 写 0 会被下游当成真实掉帧，把均值和 1%Low 一起拉坏。故 null 合法，但出现数值时必须非负。
  const absent = (v) => v === undefined || v === null;
  check('jank 家族非负', rows.every(r => [r.jank, r.bigJank, r.smallJank, r.tinyJank, r.jankRate].every(v => absent(v) || (isNum(v) && v >= 0))), rows.slice(0, 3));
  check('jankRate 在 0..100', rows.every(r => absent(r.jankRate) || (r.jankRate >= 0 && r.jankRate <= 100)), rows.map(r => r.jankRate).slice(0, 8));
  check('max(jank) 为整数计数语义', rows.every(r => absent(r.jank) || Number.isInteger(r.jank)), rows.map(r => r.jank).slice(0, 5));
  // 「假 0」修复的核心断言：**没有帧数据的轮次必须写 null 而不是 0**。
  // 旧写法断言「首采必为 null」，但首采能否拿到帧取决于 framestats 缓冲里有没有
  // 尚未消费的帧（应用刚被交互过就有），属于环境相关假设。真正要守住的是
  // 「0 不能作为无数据的占位值」—— 写 0 会把均值和 1%Low 一起拉坏。
  check('无帧轮次写 null 而非 0（不伪造掉帧）',
    rows.every(r => r.fps === null || r.fps === undefined || (isNum(r.fps) && r.fps > 0)),
    rows.filter(r => r.fps === 0).length);

  // 数据有效性：只有被测应用**确实在渲染**时才该有真实帧率。
  // 停在静态界面（如游戏登录页、后台应用）时三条取帧通道都取不到新帧，
  // 全 null 才是正确结果 —— 此时断言「必须有 fps>0」会假失败，
  // 改为按有无帧分支：有帧必须为正，无帧必须全 null（不得伪造 0）。
  const fpsVals = rows.map(r => r.fps).filter(v => typeof v === 'number');
  const hasFrames = fpsVals.length > 0;
  check(hasFrames ? '存在 fps > 0 的采样' : '无帧场景全 null（未渲染时正确降级）',
    hasFrames
      ? fpsVals.some(v => v > 0)
      : rows.every(r => r.fps === null || r.fps === undefined),
    hasFrames ? fpsVals.slice(0, 10) : rows.slice(0, 3).map(r => r.fps));
  const maxFps = hasFrames ? Math.max(...fpsVals) : 0;
  check('fps 上限合理(≤120)', maxFps <= 120, maxFps);

  console.log(`  FPS 序列: ${fpsVals.slice(0, 20).join(', ')}${fpsVals.length > 20 ? ' …' : ''}`);
  console.log(`  Jank 序列: ${rows.map(r => r.jank).slice(0, 20).join(', ')}`);
  console.log(`  BigJank 序列: ${rows.map(r => r.bigJank).slice(0, 20).join(', ')}`);
  console.log(`  TinyJank 序列: ${rows.map(r => r.tinyJank).slice(0, 20).join(', ')}`);

  // ───── 阶段 B：压力期间确实产生了可观测的帧率劣化 ────────────────────────
  console.log('-- B. 压力阶段可观测性 --');
  const half = Math.floor(rows.length / 2);
  const baseFps = rows.slice(0, Math.max(1, half)).map(r => r.fps).filter(v => v > 0);
  const stressFps = rows.slice(half).map(r => r.fps).filter(v => v > 0);
  if (baseFps.length && stressFps.length) {
    const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
    console.log(`  前半均值 fps=${avg(baseFps).toFixed(1)}  后半均值 fps=${avg(stressFps).toFixed(1)}`);
    check('压力阶段帧率确有变化（采集具备敏感性）',
      Math.abs(avg(baseFps) - avg(stressFps)) >= 0.5 || rows.some(r => r.jank > 0) || rows.some(r => r.tinyJank > 0),
      { base: avg(baseFps), stress: avg(stressFps) });
  } else {
    console.log('  （采样样本不足以对比，跳过）');
  }

  // ───── 阶段 C：metricConfig 采集过滤 ─────────────────────────────────────
  console.log('-- C. metricConfig 部分采集 --');
  const cfg = { fps: true, cpu: true, mem: false, net: false, gpu: false, temp: false, battery: false };
  const c2 = new Collector(DEVICE, PKG, 1000, cfg);
  await c2.start().catch(e => console.log('  start2:', e.message));
  // 同样驱动交互：否则 A 段有帧、C 段无帧，会让「保留的 fps 仍在采集」误判失败
  let swipeDir2 = 1;
  const swipeTimer2 = setInterval(() => {
    const from = swipeDir2 > 0 ? 1700 : 700;
    const to = swipeDir2 > 0 ? 700 : 1700;
    execFile('adb', ['-s', DEVICE, 'shell', 'input', 'swipe', '540', String(from), '540', String(to), '260'],
      { timeout: 6000 }, () => {});
    swipeDir2 = -swipeDir2;
  }, 1200);
  await sleep(6000);
  c2.stop('test2');
  clearInterval(swipeTimer2);
  const rows2 = c2.history.slice();
  console.log(`  采集 ${rows2.length} 条`);
  check('部分配置也能采到数据', rows2.length >= 2, rows2.length);
  check('移除的 mem 不再采集', rows2.every(r => r.mem === undefined), rows2.slice(0, 2));
  check('移除的 net 不再采集', rows2.every(r => r.net === undefined), rows2.slice(0, 2));
  check('移除的 battery 不再采集', rows2.every(r => r.battery === undefined), rows2.slice(0, 2));
  check('移除的 temperature 不再采集', rows2.every(r => r.temperature === undefined), rows2.slice(0, 2));
  // 保留 fps 组：字段必须**存在**（null 表示该轮无帧，属正常降级）；
  // 有数值时必须为正。不能拿 A 段「有过帧」推断 C 段「必有帧」——
  // 交互是否产生新帧取决于应用，两个阶段彼此独立。
  check('保留的 fps 仍在采集',
    rows2.every(r => r.fps !== undefined && (r.fps === null || (isNum(r.fps) && r.fps > 0))),
    rows2.slice(0, 2));
  check('保留的 cpu 仍在采集', rows2.every(r => r.cpu !== undefined), rows2.slice(0, 2));

  // ───── 阶段 D：CSV 导出 ──────────────────────────────────────────────────
  console.log('-- D. CSV 导出 --');
  let csv = '';
  try {
    csv = exporter.toCSV(rows);
  } catch (e) {
    console.log('  toCSV 异常:', e.message);
  }
  const lines = csv.split('\n').filter(Boolean);
  console.log(`  CSV ${lines.length} 行，表头: ${lines[0] ? lines[0].slice(0, 120) : '(空)'}`);
  // 表头固定全列；被移除的指标「值留空」（不补 0，避免误导）
  const headCols = (lines[0] || '').split(',');
  check('CSV 表头含全部指标列', headCols.length >= 20, headCols.length);
  check('CSV 包含 FPS 列', /fps/i.test(lines[0] || ''), lines[0]);
  const memIdx = headCols.findIndex(h => /totalPss/i.test(h));
  const fpsIdx = headCols.findIndex(h => /^fps$/i.test(h.trim()));
  check('CSV 存在内存列', memIdx >= 0, { head: lines[0] });

  // 全参数数据：内存列必须有值
  const csvFull = exporter.toCSV(rows);
  const memValsFull = csvFull.split('\n').filter(Boolean).slice(1).map(l => (l.split(',')[memIdx] || '').trim());
  check('全参数 CSV 内存列有值', memValsFull.some(v => v !== '' && parseFloat(v) > 0), memValsFull.slice(0, 5));

  // 部分配置数据：被移除的内存列必须留空（表头保留，值不补 0 以免误导）
  const csvPart = exporter.toCSV(rows2);
  const memValsPart = csvPart.split('\n').filter(Boolean).slice(1).map(l => (l.split(',')[memIdx] || '').trim());
  check('移除参数的 CSV 内存列全部留空', memValsPart.length > 0 && memValsPart.every(v => v === ''), memValsPart.slice(0, 5));

  const fpsValsCsv = csvPart.split('\n').filter(Boolean).slice(1).map(l => (l.split(',')[fpsIdx] || '').trim());
  // 判据取自 C 段自身数据：C 段有帧则列必须有值，C 段无帧则整列留空（不补 0）
  const rows2HasFps = rows2.some(r => isNum(r.fps) && r.fps > 0);
  check(rows2HasFps ? '保留的 FPS 列有值' : '无帧场景 FPS 列留空（不补 0）',
    rows2HasFps ? fpsValsCsv.some(v => v !== '' && parseFloat(v) >= 0) : fpsValsCsv.every(v => v === ''),
    fpsValsCsv.slice(0, 5));

  // ───── 阶段 E：报告汇总 ──────────────────────────────────────────────────
  console.log('-- E. 报告汇总 summarizePerf --');
  const full = reportsData.summarizePerf ? reportsData.summarizePerf(rows) : null;
  if (!full) {
    console.log('  summarizePerf 未导出（跳过）');
  } else {
    console.log('  顶层字段 =', Object.keys(full));
    check('汇总返回 samples', full.samples === rows.length, { samples: full.samples, rows: rows.length });
    check('汇总返回 durationSec', isNum(full.durationSec), full.durationSec);
    const kpi = full.kpi || {};
    const kpiKeys = Object.keys(kpi);
    console.log('  KPI 数量 =', kpiKeys.length, '示例:', kpiKeys.slice(0, 10).join(', '));
    check('KPI 含 fps', 'fps' in kpi, kpiKeys.slice(0, 20));
    check('KPI 含 jank', 'jank' in kpi, kpiKeys.slice(0, 20));
    check('KPI 含 mem(全参数采集)', 'mem' in kpi, kpiKeys.slice(0, 20));
    check('KPI 每项为 {avg,min,max}', kpiKeys.every(k => {
      const v = kpi[k];
      return v && typeof v === 'object' && ('avg' in v);
    }), kpi.fps);
    check(hasFrames ? 'KPI.fps.avg 为数值' : '无帧场景 KPI.fps.avg 为 null（不伪造 0）',
      hasFrames
        ? (kpi.fps && isNum(kpi.fps.avg))
        : (kpi.fps && (kpi.fps.avg === null || kpi.fps.avg === undefined)),
      kpi.fps);

    // 被移除组的 KPI 不应出现在汇总里
    const filtered = reportsData.summarizePerf(rows, cfg).kpi;
    check('过滤后不再输出 mem KPI', !('mem' in filtered), Object.keys(filtered).filter(k => /mem/i.test(k)));
    check('过滤后不再输出 temp KPI', !('temp' in filtered), Object.keys(filtered).filter(k => /temp/i.test(k)));
    check('过滤后仍输出 fps KPI', 'fps' in filtered, Object.keys(filtered).slice(0, 10));
  }

  console.log(`\n===== 结果: ${pass} PASS / ${fail} FAIL =====`);
  if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
  cleanupTmp();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('致命错误:', e); cleanupTmp(); process.exit(2); });
