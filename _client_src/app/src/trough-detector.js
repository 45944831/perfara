'use strict';

/**
 * 性能低谷判定：给每一拍 FPS，决定此刻是否值得截一张图。
 *
 * 口径与报告里的「低帧占比」一致：FPS 低于目标（本轮 P95）的 80%。
 * 但只靠这条会把「静置 / 加载 / 应用层主动限帧」全判成卡顿：这类场景下游戏
 * 稳定跑在 30fps 一类的半帧平台上，jank 为 0、画面并没有掉帧，冷却一过就又截一张，
 * 一次加载能刷出十几张几乎一样的图。因此还要求：
 *
 *   1) 低谷必须是从正常帧率「跌落」出来的：此前连续若干拍处于正常帧率才允许截图；
 *   2) 一次跌落只截一张，回到正常帧率后重新武装，杜绝冷却一到就重复截；
 *   3) 连续低帧过久视为进入稳态（加载 / 静置 / 限帧平台），此后不再截图；
 *   4) 有 jank 数据时，半帧平台且明确零卡顿 → 判为静置/加载，不截图；
 *      深谷（低于目标 45%）即使 jank=0 也保留，避免漏报真的掉帧。
 *
 * jank 为 null（无权限 / iOS / gfxinfo-delta 未测分级）时视为「未知」，
 * 不因缺证据而拒绝截图，仅靠 1~3 条规则兜底。
 */

const DEFAULTS = {
  lowRatio: 0.8,
  consecutive: 2,
  minSamples: 8,
  cooldownMs: 10000,
  maxShots: 30,
  maxSamples: 14400,
  recoveryRatio: 0.85,     // ≥ target*0.85 视为回到正常帧率（重新武装）
  recoveryStreak: 2,       // 连续 2 拍正常才重新武装，防单点抖动
  steadyAfter: 6,          // 连续低帧 ≥ 6 拍 → 稳态，停止截图
  steadyFloorRatio: 0.45,  // fps ≥ target*0.45 视为「半帧平台」而非深谷
};

/** 最近秩百分位（与 reports-data-js 的 p95 口径同源） */
function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/**
 * 把一拍的卡顿分级折算成「卡顿证据」。
 * @returns {true|false|null} true=测得卡顿；false=测得零卡顿；null=未测量（缺证据）
 */
function jankSignal(ctx) {
  if (ctx == null) return null;
  const vals = typeof ctx === 'number' ? [ctx]
    : [ctx.jank, ctx.bigJank, ctx.smallJank, ctx.tinyJank, ctx.jankRate];
  let hasNumber = false;
  for (const v of vals) {
    if (v == null) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    hasNumber = true;
    if (n > 0) return true;
  }
  return hasNumber ? false : null;
}

/** 合并低帧窗口内的卡顿证据：只要有一拍测得卡顿就算有 */
function mergeJank(prev, cur) {
  if (prev === true || cur === true) return true;
  if (prev === false || cur === false) return false;
  return null;
}

class TroughDetector {
  constructor(options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    this.lowRatio = o.lowRatio;
    this.consecutive = Math.max(1, o.consecutive | 0);
    this.minSamples = Math.max(2, o.minSamples | 0);
    this.cooldownMs = o.cooldownMs;
    this.maxShots = o.maxShots;
    this.maxSamples = o.maxSamples;
    this.recoveryRatio = o.recoveryRatio;
    this.recoveryStreak = Math.max(1, o.recoveryStreak | 0);
    this.steadyAfter = Math.max(this.consecutive + 1, o.steadyAfter | 0);
    this.steadyFloorRatio = o.steadyFloorRatio;

    this._fps = [];
    this._lowStreak = 0;    // 连续低帧拍数
    this._highStreak = 0;   // 连续正常帧拍数
    this._armed = false;    // 是否处于「已从正常帧率跌落」的可截图状态
    this._jankSeen = null;  // 当前低帧窗口的卡顿证据
    this._lastShotTs = 0;
    this.shots = 0;
  }

  get target() {
    return percentile(this._fps, 0.95);
  }

  reset() {
    this._fps = [];
    this._lowStreak = 0;
    this._highStreak = 0;
    this._armed = false;
    this._jankSeen = null;
    this._lastShotTs = 0;
    this.shots = 0;
  }

  /**
   * @param {number|null} fps 本拍帧率；null/0/非数值表示「没取到帧数据」，不参与判定
   * @param {number} ts 采样时间戳（ms）
   * @param {object|number|null} [ctx] 本拍卡顿证据，如 { jank, bigJank, jankRate }
   * @returns {{fps:number,target:number,ts:number}|null} 命中时返回截图依据
   */
  push(fps, ts, ctx) {
    const t = Number.isFinite(ts) ? ts : Date.now();
    if (typeof fps !== 'number' || !isFinite(fps) || fps <= 0) {
      // 无帧数据（加载中 / 不在前台）打断连续计数，但不改变武装状态
      this._lowStreak = 0;
      this._highStreak = 0;
      this._jankSeen = null;
      return null;
    }

    this._fps.push(fps);
    if (this._fps.length > this.maxSamples) this._fps.shift();
    if (this._fps.length < this.minSamples) return null;

    const target = this.target;
    if (!(target > 0)) return null;

    // 回到正常帧率：解除稳态、重新武装，下一次真实跌落才允许截图
    if (fps >= target * this.recoveryRatio) {
      this._lowStreak = 0;
      this._highStreak += 1;
      this._jankSeen = null;
      if (this._highStreak >= this.recoveryStreak) this._armed = true;
      return null;
    }

    // 中间地带（介于低帧线和恢复线之间）：既不算低谷也不算恢复
    if (fps >= target * this.lowRatio) {
      this._lowStreak = 0;
      this._highStreak = 0;
      this._jankSeen = null;
      return null;
    }

    this._lowStreak += 1;
    this._highStreak = 0;
    this._jankSeen = mergeJank(this._jankSeen, jankSignal(ctx));

    // 1) 从未到过正常帧率，或上次截图后尚未恢复 → 不截
    if (!this._armed) return null;
    if (this._lowStreak < this.consecutive) return null;
    // 3) 连续低帧太久 = 加载/静置/限帧平台，锁到恢复正常帧率为止
    if (this._lowStreak >= this.steadyAfter) {
      this._armed = false;
      return null;
    }
    if (this.shots >= this.maxShots) return null;
    if (t - this._lastShotTs < this.cooldownMs) return null;

    // 4) 半帧平台 + 明确零卡顿 = 静置/加载/限帧，不是掉帧；深谷仍放行
    if (this._jankSeen === false && fps >= target * this.steadyFloorRatio) return null;

    // 2) 一次跌落只截一张，回到正常帧率后才重新武装
    this._armed = false;
    this._lowStreak = 0;
    this._lastShotTs = t;
    this.shots += 1;
    return { fps, target, ts: t };
  }
}

module.exports = { TroughDetector, percentile, jankSignal, DEFAULTS };
