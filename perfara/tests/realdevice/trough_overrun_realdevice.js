'use strict';
/**
 * 真机专项：优化方案 2.2「低谷截图接 frameOverrun」的真机端到端验证（**源码态**）。
 *
 * 为什么是源码态：打包态 Perfara.exe 仍是 10-19 那版，不含本轮 trough-detector 改动；
 * 重建 asar 属于「打包」动作，需用户明确授权。因此这里直接加载源码模块，
 * 用**真机真实帧数据**驱动判定器，覆盖本轮新增逻辑：
 *   - overrunSeverity 分级：≥100ms → 2 级（确认长帧）、≥50ms → 1 级、其余 0
 *   - 中间地带例外：FPS 落在 lowRatio~recoveryRatio 之间但 overrunMax ≥ 100ms
 *     → 仍应截图，reason='overrun'（只看 FPS 会漏掉这类「平均帧率被抹平」的长帧）
 *   - 旧数据兼容：没有 overrunMax 时退回 overrunP99
 *   - 低于 100ms 阈值不触发（避免把锁 30fps 这类主动限帧误判成卡顿）
 *   - 截图落盘链路：命中 → 调 capture → 落盘 jpg → meta 带 reason
 *
 * 用法: node trough_overrun_realdevice.js <deviceId> [packageName] [fpsRounds]
 * 设备序列号必须运行时传入（不入库）；默认 com.android.chrome。
 */
const Module = require('module');
const os = require('os');
const fs = require('fs');
const path = require('path');

// ── electron 桩 ────────────────────────────────────────────────────────────
// trough-shots.savePng 用 nativeImage 做 PNG 解码/缩放/JPEG 编码；测试环境没有
// Electron，用极简桩替代：只解析 PNG 宽高并返回一段合法 JPEG 字节。
// 图像编解码本身的正确性由打包态用例 trough_shot_realdevice.js 覆盖。
const JPEG_STUB = Buffer.concat([
  Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64'),
  // savePng 要求 JPEG ≥ 500 B 才算编码成功；桩字节补齐到门槛以上。
  // 注意：这是**桩字节**，不是可解码的真实 JPEG。本用例只验证「判定 → 调 capture
  // → 落盘 → meta 带 reason」这条链路；图像编解码正确性由打包态用例
  // trough_shot_realdevice.js 覆盖（那里用的是真实 Electron nativeImage）。
  Buffer.alloc(420),
]);
const PNG_STUB = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  Buffer.alloc(8),
  Buffer.from('IHDR'), Buffer.from([0, 0, 0x02, 0x58, 0, 0, 0x02, 0x58, 8, 6, 0, 0, 0]),
  Buffer.alloc(4),
]);
const NATIVE_IMAGE = {
  createFromBuffer(buf) {
    const empty = !buf || buf.length < 24;
    const self = {
      isEmpty: () => empty,
      getSize: () => ({ width: 600, height: 1200 }),
      resize: () => self,
      toJPEG: () => (empty ? Buffer.alloc(0) : JPEG_STUB),
    };
    return self;
  },
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-trough-overrun-'));
const _origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return {
      app: { isPackaged: false, getPath: () => TMP, getName: () => 'perfara' },
      nativeImage: NATIVE_IMAGE,
    };
  }
  return _origLoad.apply(this, arguments);
};

const PROJ = 'E:/WorkBuddy1/2026-10-19-13-59-27';
const APP = PROJ + '/_client_src/app';
process.resourcesPath = PROJ + '/perfara/collector/resources';

const ADB = require(path.join(APP, 'src/adb.js'));
const Trough = require(path.join(APP, 'src/trough-detector.js'));
const Shots = require(path.join(APP, 'src/trough-shots.js'));

const DEVICE = process.argv[2] || '';
const PKG = process.argv[3] || 'com.android.chrome';
const ROUNDS = parseInt(process.argv[4] || '10', 10);
if (!DEVICE) {
  console.error('用法: node trough_overrun_realdevice.js <deviceId> [packageName] [fpsRounds]');
  process.exit(2);
}

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); }
  else { fail++; fails.push(name); console.log(`  FAIL  ${name}  ${detail !== undefined ? JSON.stringify(detail) : ''}`); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

/** 造一个「已武装」的判定器：先喂够正常帧率，再回到可截图状态 */
function armedDetector(normalFps, target, rounds = 12) {
  const d = new Trough.TroughDetector();
  let t = Date.now();
  for (let i = 0; i < rounds; i += 1) {
    t += 1000;
    d.push(normalFps, t, { jank: 0, bigJank: 0 });
  }
  return d;
}

(async () => {
  console.log(`\n===== 真机低谷 overrun 专项  device=${DEVICE}  pkg=${PKG} =====\n`);

  // ── 1. 真机取真实帧数据 ────────────────────────────────────────────────
  console.log('[1] 真机取真实帧数据');
  const fpsSeq = [];
  for (let i = 0; i < ROUNDS; i += 1) {
    const f = await ADB.getFps(DEVICE, PKG, () => {}, 1000).catch(e => ({ error: e.message }));
    if (f && !f.error) {
      fpsSeq.push({
        fps: f.fps, method: f.method,
        ftP50: f.ftP50, ftP99: f.ftP99,
        jankyRatio: f.jankyRatio, hitchMsPerSec: f.hitchMsPerSec,
        overrunP99: f.overrunP99, overrunMax: f.overrunMax,
        jank: f.jank, bigJank: f.bigJank,
      });
    }
    await sleep(900);
  }
  const realFps = fpsSeq.filter(s => isNum(s.fps) && s.fps > 0).map(s => s.fps);
  console.log(`  取到 ${fpsSeq.length} 拍，其中有帧 ${realFps.length} 拍`);
  console.log('  样本:', JSON.stringify(fpsSeq.slice(0, 3)));
  check('真机成功取到帧采样', fpsSeq.length >= 3, { n: fpsSeq.length });

  const realWithOverrun = fpsSeq.filter(s => isNum(s.overrunMax));
  console.log(`  带 overrunMax 的拍数 = ${realWithOverrun.length}`);
  if (realWithOverrun.length) {
    const m = realWithOverrun.map(s => s.overrunMax);
    console.log(`  真机 overrunMax 区间 = ${Math.min(...m)} ~ ${Math.max(...m)} ms`);
    check('真机 overrunMax 非负', m.every(v => v >= 0), { min: Math.min(...m), max: Math.max(...m) });
  }

  // 目标帧率：优先用真机 P95，没有真实帧则退到 60Hz 基准（后续会标注）
  const target = realFps.length >= 4
    ? Trough.percentile(realFps, 0.95)
    : 60;
  const syntheticTarget = realFps.length < 4;
  console.log(`  目标帧率 target = ${target.toFixed(1)} Hz${syntheticTarget ? '（本轮无真实帧，用 60Hz 基准）' : '（真机 P95）'}`);

  // ── 2. overrunSeverity 分级 ────────────────────────────────────────────
  console.log('\n[2] overrunSeverity 分级');
  check('overrunMax = 220ms → 2 级（确认长帧）',
    Trough.overrunSeverity({ overrunMax: 220 }) === 2,
    Trough.overrunSeverity({ overrunMax: 220 }));
  check('overrunMax = 100ms 恰好达 2 级',
    Trough.overrunSeverity({ overrunMax: 100 }) === 2,
    Trough.overrunSeverity({ overrunMax: 100 }));
  check('overrunMax = 60ms → 1 级（可疑但未确认）',
    Trough.overrunSeverity({ overrunMax: 60 }) === 1,
    Trough.overrunSeverity({ overrunMax: 60 }));
  check('overrunMax = 20ms → 0 级',
    Trough.overrunSeverity({ overrunMax: 20 }) === 0,
    Trough.overrunSeverity({ overrunMax: 20 }));
  check('无 overrunMax 时退回 overrunP99',
    Trough.overrunSeverity({ overrunP99: 150 }) === 2,
    Trough.overrunSeverity({ overrunP99: 150 }));
  check('两者都缺失 → 0 级（不臆造证据）',
    Trough.overrunSeverity({}) === 0 && Trough.overrunSeverity(null) === 0);
  check('overrunMax 优先于 overrunP99',
    Trough.overrunSeverity({ overrunMax: 10, overrunP99: 300 }) === 0,
    Trough.overrunSeverity({ overrunMax: 10, overrunP99: 300 }));

  // ── 3. 中间地带 overrun 触发（2.2 核心） ───────────────────────────────
  console.log('\n[3] 中间地带：FPS 未跌落但存在长帧 → 仍应截图（reason=overrun）');
  const midFps = target * 0.82;   // 落在 lowRatio(0.8) ~ recoveryRatio(0.85) 之间
  console.log(`  构造 fps = target*0.82 = ${midFps.toFixed(1)}`);

  {
    const d = armedDetector(target, target);
    const hit = d.push(midFps, Date.now() + 100000, { overrunMax: 220, jank: 0 });
    check('overrunMax=220 → 命中且 reason=overrun',
      !!hit && hit.reason === 'overrun', hit);
    check('命中时带回 overrunMax 证据',
      !!hit && hit.overrunMax === 220, hit && hit.overrunMax);
  }
  {
    const d = armedDetector(target, target);
    const hit = d.push(midFps, Date.now() + 100000, { overrunMax: 0, jank: 0 });
    check('同样 FPS 但 overrunMax=0 → 不截图（避免误伤限帧平台）', !hit, hit);
  }
  {
    const d = armedDetector(target, target);
    const hit = d.push(midFps, Date.now() + 100000, { overrunP99: 220, jank: 0 });
    check('只有 overrunP99=220 → 同样命中（旧数据兼容）',
      !!hit && hit.reason === 'overrun', hit);
    check('旧数据回退时证据值不丢失（overrunMax 回落自 overrunP99）',
      !!hit && hit.overrunMax === 220, hit && hit.overrunMax);
  }
  {
    const d = armedDetector(target, target);
    const hit = d.push(midFps, Date.now() + 100000, { overrunMax: 60, jank: 0 });
    check('overrunMax=60（1 级）→ 不截图（阈值 100ms 门槛有效）', !hit, hit);
  }

  // ── 4. 深谷仍走 fps-drop，且带 overrun 时证据并列 ───────────────────────
  console.log('\n[4] 深谷：FPS 明显跌落 → reason=fps-drop');
  {
    const d = armedDetector(target, target);
    const deepFps = target * 0.3;
    // 深谷要求连续 2 拍（consecutive=2）才算「跌落」，单拍不算
    const h1 = d.push(deepFps, Date.now() + 100000, { overrunMax: 250, jank: 3 });
    check('深谷第 1 拍不触发（需连续 2 拍才算跌落）', !h1, h1);
    const hit = d.push(deepFps, Date.now() + 101000, { overrunMax: 250, jank: 3 });
    check('深谷连续 2 拍 + 长帧 → 命中 reason=fps-drop', !!hit && hit.reason === 'fps-drop', hit);
  }

  // ── 5. 截图落盘链路 ────────────────────────────────────────────────────
  console.log('\n[5] 命中 → 截图 → 落盘 → meta 带 reason');
  const reportsDir = fs.mkdtempSync(path.join(TMP, 'reports-'));
  Shots.beginRun(reportsDir, 'android', 'com.example.app', Date.now());
  let captureCalled = 0;
  const capture = async () => { captureCalled += 1; return PNG_STUB; };
  const res = await Shots.feed('android', Date.now(), target, capture, { jank: 0 });
  console.log('  feed 返回:', JSON.stringify(res));
  check('正常帧率不触发截图（feed 返回 hit=false）', res && res.hit === false, res);
  check('未触发时不会调用 capture', captureCalled === 0, { captureCalled });

  // 用同一 run 灌一段「正常 → 长帧」序列，逼出 overrun 截图
  const seq = [];
  for (let i = 0; i < 12; i += 1) seq.push({ fps: target, ctx: { jank: 0 } });
  seq.push({ fps: midFps, ctx: { overrunMax: 220, jank: 0 } });
  let shotMeta = null;
  for (const s of seq) {
    const r = await Shots.feed('android', Date.now(), s.fps, capture, s.ctx);
    if (r && r.hit) { shotMeta = r.meta; break; }
  }
  console.log('  截图 meta:', JSON.stringify(shotMeta));
  check('序列末尾的长帧触发了一次截图', !!shotMeta, shotMeta);
  if (shotMeta) {
    check('截图 meta.reason = overrun', shotMeta.reason === 'overrun', shotMeta.reason);
    check('截图 capture 被调用 1 次', captureCalled === 1, { captureCalled });
    check('截图文件已落盘', fs.existsSync(path.join(reportsDir, shotMeta.file)), shotMeta.file);
    const abs = path.join(reportsDir, shotMeta.file);
    if (fs.existsSync(abs)) {
      const sz = fs.statSync(abs).size;
      console.log(`  落盘文件大小 = ${sz} B`);
      check('落盘文件非空', sz > 0, { bytes: sz });
    }
    const shots = Shots.getShots('android');
    check('getShots 能取回本轮截图', Array.isArray(shots) && shots.length === 1, shots && shots.length);
  }

  // ── 6. 真机真截图能力（adb 层） ────────────────────────────────────────
  console.log('\n[6] 真机截图能力（adb exec-out screencap）');
  const png = await ADB.captureScreen(DEVICE).catch(e => null);
  check('真机截图返回合法 PNG', !!png && png.length > 5000,
    png ? { bytes: png.length, head: png.slice(0, 4).toString('hex') } : null);
  check('PNG 头正确（89504E47）',
    !!png && png.slice(0, 4).toString('hex') === '89504e47',
    png && png.slice(0, 4).toString('hex'));

  console.log(`\n===== 结果: ${pass} PASS / ${fail} FAIL =====`);
  if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); process.exit(2); });
