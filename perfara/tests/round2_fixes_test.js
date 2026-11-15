'use strict';
/**
 * 外部修复说明 r2（2026-11-14）FIX-13 ~ FIX-17 的离线回归用例。
 *
 * FIX-13（P1）长间隔（>3s）的 CPU/GPU/网络差值是「长窗口平均」→ 写 null 重建基线，
 *             采样点带 dtMs 让报告层解释断截
 * FIX-14（P2）CPU 频率优先 cpuinfo_cur_freq（实际频率），回退 scaling（governor 目标），
 *             freqSource 进采样点
 * FIX-15（P1）Scripts/ 下 .py 兜底：compile 复制 + 运行期 Bad magic 自动回退
 * FIX-17（P2）framestats 窗口过期判定用上一拍实际周期（另见 frame_metrics_test 四档）
 *
 * FIX-16（报告文案）在 perf.html（asar 外即时生效），由展示面用例与人工验收覆盖。
 */
const path = require('path');
const fs = require('fs');
const ADB = require(path.resolve(__dirname, '..', '..', '_client_src', 'app', 'src', 'adb.js'));
const CollectorMod = require(path.resolve(__dirname, '..', '..', '_client_src', 'app', 'src', 'collector.js'));
const Collector = CollectorMod.Collector || CollectorMod;
const algo = ADB.__algo;

let pass = 0, fail = 0;
const FAILED = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; FAILED.push(name); console.log('  FAIL  ' + name + '  -> ' + JSON.stringify(detail)); }
}
const adbSrc = fs.readFileSync(
  path.resolve(__dirname, '..', '..', '_client_src', 'app', 'src', 'adb.js'), 'utf8');
const colSrc = fs.readFileSync(
  path.resolve(__dirname, '..', '..', '_client_src', 'app', 'src', 'collector.js'), 'utf8');
const pcSrc = fs.readFileSync(
  path.resolve(__dirname, '..', '..', '_client_src', 'app', 'src', 'pc-collector.js'), 'utf8');

console.log('\n-- FIX-13（P1）：长间隔 → null + 基线重建 --');
{
  check('13.1 STALE_GAP_MS=3000 常量存在（1Hz 的 3 倍冗余）',
    adbSrc.includes('const STALE_GAP_MS = 3000;'), true);
  check('13.2 CPU 快照存 mono 并判 stale（sysCpu/procCpu 写 null）',
    adbSrc.includes('const cpuStale = !!(prev && prev.mono != null && mono - prev.mono > staleGapMs);')
    && adbSrc.includes('if (!cpuStale && prev && prev.sys && curr.sys)'), true);
  check('13.3 逐核 usage 在 stale 时全部 null（不把 10 秒压进一个点）',
    adbSrc.includes(': coreCount ? coreIds.map(() => null) : [];'), true);
  check('13.4 GPU gpubusy 基线带 mono 并判 stale', adbSrc.includes('const gpuStale = !!(prevRec && prevRec.mono != null')
    && adbSrc.includes('_gpuBusyState.set(deviceId, { busy: busy.busy, total: busy.total, mono: monoNow });'), true);
  check('13.5 网络 dtMs > staleGapMs → null 重建基线',
    /if \(dtMs > staleGapMs\) \{/.test(adbSrc), true);
  check('13.6 采样点带 dtMs（上一拍 tickStart 差）',
    colSrc.includes('data.dtMs = this._lastTickStart != null ? tickStart - this._lastTickStart : null;'), true);
  check('13.7 dtMs 进 filterDataByConfig 白名单',
    colSrc.includes("'tickStartTs', 'dtMs'"), true);
  // r3 遗留项闭环：阈值按实际采样周期推导（可配间隔 >3s 不误杀）
  check('13.8 三通道 staleGapMs 可选参数（默认 STALE_GAP_MS 兜底）',
    /getCpuSnapshot\(deviceId, pid, staleGapMs = STALE_GAP_MS\)/.test(adbSrc)
    && /getNetStats\(deviceId, uid, staleGapMs = STALE_GAP_MS\)/.test(adbSrc)
    && /getGpuUsage\(deviceId, staleGapMs = STALE_GAP_MS\)/.test(adbSrc), true);
  check('13.9 collector 传 Math.max(3×intervalMs, 3000)',
    colSrc.includes('const staleGap = Math.max(3 * this.intervalMs, 3000);')
    && colSrc.includes('getCpuSnapshot(this.deviceId, this._pid, staleGap)'), true);
  check('13.10 perf.html 归一化带 dtMs（报告层可消费，不再死字段）',
    fs.readFileSync(path.resolve(__dirname, '..', '..', 'perfara', 'collector', 'resources',
      'reports', 'perf.html'), 'utf8').includes('dtMs: it.dtMs ?? null'), true);
}

console.log('\n-- FIX-14（P2）：CPU 频率 cpuinfo 优先 --');
{
  check('14.1 shell 先读 cpuinfo_cur_freq（实际频率）',
    adbSrc.indexOf('cpuinfo_cur_freq') > 0
    && adbSrc.indexOf('cpuinfo_cur_freq') < adbSrc.indexOf('scaling_cur_freq'), true);
  check('14.2 FSRC 行标记来源', adbSrc.includes('FSRC=scaling; fi;') && adbSrc.includes('FSRC=cpuinfo; '), true);
  check('14.3 解析 FSRC → freqSource（cpuinfo|scaling|null）',
    /let freqSource = null;/.test(adbSrc) && /freqSource = ms\[1\]/.test(adbSrc), true);
  check('14.4 返回对象带 freqSource（含错误路径）',
    /cores: \{ usage, freq \}, coreCount, freqSource \}/.test(adbSrc)
    && /coreCount: 0,\n      freqSource: null/.test(adbSrc), true);
  check('14.5 collector 透传 freqSource',
    colSrc.includes('data.freqSource = cpuSnap.freqSource ?? null;'), true);
  // r3 遗留项闭环：freqSource 进 provenance sources（数据质量页显示频率精度）
  const Schema = require(path.resolve(__dirname, '..', '..', '_client_src', 'app', 'src', 'metric-schema.js'));
  const pv = Schema.buildProvenance([
    { cpu: { sysCpu: 20, procCpu: 15 }, freqSource: 'cpuinfo' },
    { cpu: { sysCpu: 21, procCpu: 16 }, freqSource: 'scaling' },
  ], 'android');
  check('14.6 provenance cpu sources 按 freqSource 分组',
    pv.metrics['cpu.sysCpu'].sources.cpuinfo === 1
    && pv.metrics['cpu.sysCpu'].sources.scaling === 1, pv.metrics['cpu.sysCpu'].sources);
  check('14.7 perf.html 归一化带 freqSource',
    fs.readFileSync(path.resolve(__dirname, '..', '..', 'perfara', 'collector', 'resources',
      'reports', 'perf.html'), 'utf8').includes('freqSource: it.freqSource ?? null'), true);
}

console.log('\n-- FIX-15（P1）：pyc 无路可退的根因防护 --');
{
  const compileSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'tools', 'compile_pc_collector.py'), 'utf8');
  check('15.1 compile 脚本把 .py 复制到 DST 同目录', compileSrc.includes('shutil.copyfile(SRC, py_dst)'), true);
  const pyPath = path.resolve(__dirname, '..', '..', 'perfara', 'collector', 'resources',
    'ios-tools', 'python', 'python', 'Scripts', 'collect_pc_perf.py');
  check('15.2 Scripts/ 下现在有 .py 兜底（可回退）', fs.existsSync(pyPath), pyPath);
  check('15.3 运行期检测 Bad magic / ImportError 后自动回退 .py',
    /Bad magic number\|ImportError/.test(pcSrc) && pcSrc.includes('this._pyFallback = true;'), true);
  check('15.4 回退时显式改用 .py（resolvePcScript 仍选 pyc，需强制覆盖）',
    pcSrc.includes("scriptPath = scriptPath.replace(/\\.pyc$/i, '.py');"), true);
  check('15.5 只回退一次（防循环）', pcSrc.includes('!this._pyFallback'), true);
}

console.log('\n-- FIX-17（P2）：framestats 窗口用实际周期 --');
{
  check('17.1 getFps 接收 actualIntervalMs 并取有效值',
    /async function getFps\(deviceId, packageName, logFn, intervalMs = 1000, actualIntervalMs = null\)/.test(adbSrc)
    && adbSrc.includes('const effInterval = (Number(actualIntervalMs) > 0) ? Number(actualIntervalMs) : intervalMs;'), true);
  check('17.2 selectFramestatsWindow 调用传 effInterval',
    adbSrc.includes('selectFramestatsWindow(frames, _fsState.get(key), mono, effInterval);'), true);
  check('17.3 collector 传上一拍实际周期（首拍 null 走配置）',
    colSrc.includes('this._lastTickStart != null ? Math.max(1, tickStart - this._lastTickStart) : null'), true);
}

console.log('\n-- 口径版本 --');
{
  const Schema = require(path.resolve(__dirname, '..', '..', '_client_src', 'app', 'src', 'metric-schema.js'));
  check('R2 SCHEMA_VERSION 已升到 7（P-01/P-04 + S-01/S-02 + D-19/D-20 改变已发布指标数值）',
    Schema.SCHEMA_VERSION === '7', Schema.SCHEMA_VERSION);
}

console.log('\n-- 参数准确性报告（P-02 / P-03）--');
{
  const pyPath = path.resolve(__dirname, '..', '..', 'perfara', 'collector', 'resources',
    'ios-tools', 'python', 'python', 'Scripts', 'collect_pc_perf.py');
  const pySrc = fs.readFileSync(pyPath, 'utf8');
  // P-02：procCpu 不再截断（Android 同口径，perf_source_audit 有「不被 100 截断」锁定）
  const m = /"procCpu":\s*(.+?),?\s*\n/.exec(pySrc);
  check('P-02.1 procCpu 不再 min(100) 截断（多线程满载可 >100%）',
    !!m && !m[1].includes('min(100'), m && m[1]);
  check('P-02.2 sysCpu 仍保留 0~100 截断（整机口径）',
    pySrc.includes('"sysCpu": round(min(100.0, float(sys_cpu)), 1)'), true);
  // P-03：Android 归一化按相邻采样点取 ctx 差值速率
  const html = fs.readFileSync(path.resolve(__dirname, '..', '..', 'perfara', 'collector',
    'resources', 'reports', 'perf.html'), 'utf8');
  check('P-03.1 cswitch 速率取差逻辑存在（_prevCtx + dtSec）',
    html.includes('let _prevCtx = null, _prevCtxTs = null;')
    && html.includes('Math.max(0, (ctxNow - _prevCtx) / dtSec)'), true);
  check('P-03.2 仅 Android 分支改写（iOS/ios_gpu 保留自己的 cswitch 数据源）',
    (html.match(/cswitch: it\.cswitch \?\? null/g) || []).length === 2, true);
}

console.log('-- P-01 / P-04（参数准确性调研落地）--');
{
  // P-01：档梯单调性全范围枚举（0.5~200ms）+ PerfDog 公式固有合并性质说明
  let bad = 0;
  for (let b = 0.5; b <= 200; b += 0.5) {
    const tiny = b * 1.5;
    const small = Math.max(2 * b, algo.MOVIE_FRAME_X1_MS);
    const jank = Math.max(2 * b, algo.MOVIE_FRAME_X2_MS);
    const big = Math.max(2 * b, algo.MOVIE_FRAME_X3_MS);
    if (!(tiny <= small && small <= jank && jank <= big)) bad++;
  }
  check('P-01.1 Tiny≤Small≤Jank≤Big 全档单调（0.5~200ms 枚举 0 违例）', bad === 0, bad);
  check('P-01.2 SmallJank ⊃ Jank 方向修正（60Hz：small 41.67 < jank 83.34）',
    Math.max(2 * 16.67, algo.MOVIE_FRAME_X1_MS) < Math.max(2 * 16.67, algo.MOVIE_FRAME_X2_MS), true);
  check('P-01.3 MOVIE_FRAME_X1_MS = 1000/24（推导值，非官方口径）',
    Math.abs(algo.MOVIE_FRAME_X1_MS - 1000 / 24) < 1e-9, algo.MOVIE_FRAME_X1_MS);
  const Schema2 = require(path.resolve(__dirname, '..', '..', '_client_src', 'app', 'src', 'metric-schema.js'));
  // v7（D-19/D-20）：目标帧率来源修正 + data.js 补 loading 段
  check('P-01.4 SCHEMA_VERSION = 7（口径变更已版本化）', Schema2.SCHEMA_VERSION === '7', Schema2.SCHEMA_VERSION);
}
{
  // P-04：perf.html 的 snapFpsTarget / 设备值优先 / 档位同源
  const html = fs.readFileSync(path.resolve(__dirname, '..', '..', 'perfara', 'collector',
    'resources', 'reports', 'perf.html'), 'utf8');
  check('P-04.1 档位表与采集端 REFRESH_RATES 同源（含 185，无 45）',
    html.includes('REFRESH_RATES_SHARED = [24, 30, 48, 60, 90, 100, 120, 144, 165, 185, 240]')
    && adbSrc.includes('REFRESH_RATES = [24, 30, 48, 60, 90, 100, 120, 144, 165, 185, 240]'), true);
  check('P-04.2 设备自报优先：fpsTargetOf / fpsTargetOfSeries 都先取 loading.target',
    (html.match(/const dev = deviceTargetHz\(\);/g) || []).length === 2, true);
  check('P-04.3 兜底公式改为 p95 向上取整（不再 ceil(p95/30)*30 误判 185→210）',
    html.includes('return Math.ceil(p95);') && !html.includes('Math.ceil(p95 / 30) * 30'), true);
  check('P-04.4 parsePeakRefreshRate 上界放宽到 480（360Hz 屏不被丢弃）',
    /hz >= 24 && hz <= 480/.test(adbSrc), true);
}

console.log(`\n===== 结果: ${pass} PASS / ${fail} FAIL =====`);
if (FAILED.length) console.log('失败项:\n   - ' + FAILED.join('\n   - '));
process.exit(fail ? 1 : 0);
