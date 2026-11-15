'use strict';

/**
 * 加载阶段（loading）识别 —— 供 FPS 统计剔除使用。
 *
 * 背景：应用冷启动、换场景、读关卡时会连续几秒渲染不出帧，FPS 会突然掉到个位数。
 * 这段数据真实存在（曲线该照常画），但它不代表游戏内表现，混进均值 / 1%Low /
 * 卡顿率会把整份报告拉垮。本模块负责把这类「掉下去又能回来」的连续低帧段标出来，
 * 统计时跳过；识别结果同时供报告页画底纹。
 *
 * 判定规则（4 条同时满足才剔除）：
 *   1. 连续 ≥ minRun 个采样点 FPS < 目标帧率 × lowRatio（默认 3 点 / 50%）
 *   2. 段结束后 recoverWindow 个采样点内，出现 FPS ≥ 目标帧率 × recoverRatio
 *      （默认 5 点 / 80%）——「能恢复」才是加载；一直低是真实性能不足，不能剔
 *   3. 段内允许夹少量 null（取不到帧的采样点），最多 maxNullBridge 个
 *   4. 被剔除的采样点总数不超过全段的 maxExcludedRatio（默认 40%），
 *      超过说明这段本来就整体跑不动，识别结果作废，避免把坏数据洗成好数据
 *
 * 另有一条 warm-up 规则：起始 warmupSamples 个点内的低帧，只要 1 个点即视为
 * 启动预热（首个采样点往往没有帧数增量，会被记成 0，那 1 个 0 就能把 1%Low 打到 0）。
 *
 * ⚠️ 与 `perfara/backend/utils.py:detect_loading_segments`、
 *    `perfara/collector/resources/reports/perf.html` 内的同名实现保持完全一致。
 */

const DEFAULT_OPTIONS = {
  lowRatio: 0.5,
  recoverRatio: 0.8,
  minRun: 3,
  recoverWindow: 5,
  maxNullBridge: 2,
  warmupSamples: 3,
  maxExcludedRatio: 0.4,
};

function isNum(v) {
  return typeof v === 'number' && isFinite(v);
}

/** P95（线性插值），与报告页 fpsTargetOfSeries 同口径 */
function p95Of(values) {
  const a = (values || []).filter(isNum).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const i = (a.length - 1) * 0.95;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (i - lo);
}

/**
 * 常见屏幕刷新率档位（Hz）。
 *
 * ⚠️ S-01：这张表在项目里有 5 份副本（本文件、`adb.js:REFRESH_RATES`、
 * `perf.html:REFRESH_RATES_SHARED`、`library.html`、`backend/utils.py:
 * FPS_TARGET_CANDIDATES`），改动必须同步。历史教训：P-04 只改了其中 2 份，
 * 本文件仍是旧的 7 档表，而它的输出会经 `data.loading.target` 被报告页当成
 * 「设备值」直接采用，使报告页新表形同虚设（100Hz 被算成 120、24fps 算成 30）。
 *
 * 24 / 48 是视频帧率，100 是非 30 倍数的真实机型，185 见于 ROG 9 / K100 Pro Max。
 */
const REFRESH_RATES = [24, 30, 48, 60, 90, 100, 120, 144, 165, 185, 240];

/** P95 吸附到常见刷新率档位 */
function snapFpsTarget(p95) {
  if (!(p95 > 0)) return null;
  for (const c of REFRESH_RATES) {
    // 只贴「略高于实测」的档：下界 0.97 让 119→120；上界 1.10 防止 200Hz 面板
    // 被抬到 240（达帧率凭空少 17%，2026-11-15 真机复核时定的上界）。
    if (c >= p95 * 0.97 && c <= p95 * 1.10) return c;
  }
  // 旧兜底 ceil(p95/30)*30 会把 24fps 判成 30、185Hz 判成 210 —— 直接向上取整。
  return Math.ceil(p95);
}

/** 由 FPS 序列直接推目标帧率 */
function fpsTargetOf(values) {
  return snapFpsTarget(p95Of(values));
}

/**
 * 识别加载段。
 * @param {Array<number|null>} fps FPS 采样序列（null = 本次未取到帧数据）
 * @param {number} target 目标帧率（见 fpsTargetOf）
 * @param {Object} [options] 覆盖 DEFAULT_OPTIONS
 * @returns {Array<{start:number,end:number,samples:number}>} 闭区间下标，按时间升序
 */
function detectLoadingSegments(fps, target, options) {
  const o = Object.assign({}, DEFAULT_OPTIONS, options || {});
  const arr = Array.isArray(fps) ? fps : [];
  const n = arr.length;
  if (!n || !(target > 0)) return [];

  const lowThr = target * o.lowRatio;
  const recThr = target * o.recoverRatio;
  const segs = [];

  let i = 0;
  while (i < n) {
    const v = arr[i];
    if (!isNum(v) || v >= lowThr) { i += 1; continue; }

    // 向后延伸连续低帧，允许夹 null
    let j = i;
    let low = 0;
    let nullRun = 0;
    while (j < n) {
      const w = arr[j];
      if (!isNum(w)) {
        nullRun += 1;
        if (nullRun > o.maxNullBridge) break;
        j += 1;
        continue;
      }
      if (w >= lowThr) break;
      nullRun = 0;
      low += 1;
      j += 1;
    }

    // 结尾若停在 null 上，收缩到最后一个有效低帧
    let e = j - 1;
    while (e > i && !isNum(arr[e])) e -= 1;

    const isWarmup = i < o.warmupSamples;
    if (low >= o.minRun || (isWarmup && low >= 1)) {
      let recovered = false;
      for (let k = j; k < Math.min(n, j + o.recoverWindow); k += 1) {
        if (isNum(arr[k]) && arr[k] >= recThr) { recovered = true; break; }
      }
      if (recovered) {
        segs.push({ start: i, end: e, samples: e - i + 1 });
        i = j;
        continue;
      }
    }
    i = j > i ? j : i + 1;
  }

  const covered = segs.reduce((s, g) => s + g.samples, 0);
  if (covered / n > o.maxExcludedRatio) return [];
  return segs;
}

/** 把识别结果转成「按下标是否剔除」的掩码（1 = 剔除） */
function buildLoadingMask(length, segments) {
  const mask = new Uint8Array(Math.max(0, length | 0));
  for (const g of segments || []) {
    const s = Math.max(0, g.start | 0);
    const e = Math.min(mask.length - 1, g.end | 0);
    for (let k = s; k <= e; k += 1) mask[k] = 1;
  }
  return mask;
}

/**
 * 一次算齐：目标帧率 → 加载段 → 掩码 + 汇总信息。
 * @returns {{target:number|null, segments:Array, mask:Uint8Array,
 *            excludedSamples:number, totalSamples:number, excludedRatio:number}}
 */
function analyseLoading(fps, options, targetOverride) {
  const arr = Array.isArray(fps) ? fps : [];
  const inferred = fpsTargetOf(arr);
  // 1.1：设备自报的 peak_refresh_rate 比「FPS 序列 P95 吸附」可信 ——
  // 锁 30fps 的应用会把 P95 推成 30，而屏幕其实是 120Hz。
  // 有设备值时优先用它；没有时保持旧行为，历史报告数值不变。
  const hz = Number(targetOverride);
  const fromDevice = Number.isFinite(hz) && hz >= 24 && hz <= 240;
  const target = fromDevice ? Math.round(hz) : inferred;
  const segments = detectLoadingSegments(arr, target, options);
  const mask = buildLoadingMask(arr.length, segments);
  let excluded = 0;
  for (let k = 0; k < mask.length; k += 1) if (mask[k]) excluded += 1;
  return {
    target,
    targetSource: fromDevice ? 'device-peak-refresh-rate' : 'fps-p95-inferred',
    targetHz: fromDevice ? Math.round(hz) : null,
    inferredTarget: inferred,
    segments,
    mask,
    excludedSamples: excluded,
    totalSamples: arr.length,
    excludedRatio: arr.length ? excluded / arr.length : 0,
  };
}

/** 按掩码取均值（跳过 null 与被剔除点） */
function maskedMean(values, mask) {
  let sum = 0;
  let cnt = 0;
  for (let k = 0; k < (values || []).length; k += 1) {
    const v = values[k];
    if (!isNum(v)) continue;
    if (mask && mask[k]) continue;
    sum += v;
    cnt += 1;
  }
  return cnt ? sum / cnt : null;
}

/** 把掩码位置置为 null（生成一份可交给原统计函数的新数组） */
function maskToNull(values, mask) {
  const out = (values || []).slice();
  if (!mask) return out;
  for (let k = 0; k < out.length; k += 1) if (mask[k]) out[k] = null;
  return out;
}

module.exports = {
  DEFAULT_OPTIONS,
  REFRESH_RATES,
  p95Of,
  snapFpsTarget,
  fpsTargetOf,
  detectLoadingSegments,
  buildLoadingMask,
  analyseLoading,
  maskedMean,
  maskToNull,
};
