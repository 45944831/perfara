'use strict';

/**
 * 性能低谷判定：给每一拍 FPS，决定此刻是否值得截一张图。
 *
 * 口径与报告里的「低帧占比」一致：FPS 低于目标（本轮 P95）的 80%。
 * 单点抖动不算低谷，要求连续 N 拍都低；两次截图之间有冷却，避免卡顿时连拍。
 */

const DEFAULTS = {
  lowRatio: 0.8,
  consecutive: 2,
  minSamples: 8,
  cooldownMs: 10000,
  maxShots: 30,
  maxSamples: 14400,
};

/** 最近秩百分位（与 reports-data-js 的 p95 口径同源） */
function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
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

    this._fps = [];
    this._lowStreak = 0;
    this._lastShotTs = 0;
    this.shots = 0;
  }

  get target() {
    return percentile(this._fps, 0.95);
  }

  reset() {
    this._fps = [];
    this._lowStreak = 0;
    this._lastShotTs = 0;
    this.shots = 0;
  }

  /**
   * @param {number|null} fps 本拍帧率；null/0/非数值表示「没取到帧数据」，不参与判定
   * @param {number} ts 采样时间戳（ms）
   * @returns {{fps:number,target:number,ts:number}|null} 命中时返回截图依据
   */
  push(fps, ts) {
    const t = Number.isFinite(ts) ? ts : Date.now();
    if (typeof fps !== 'number' || !isFinite(fps) || fps <= 0) {
      this._lowStreak = 0;
      return null;
    }

    this._fps.push(fps);
    if (this._fps.length > this.maxSamples) this._fps.shift();
    if (this._fps.length < this.minSamples) return null;

    const target = this.target;
    if (!(target > 0)) return null;

    if (fps >= target * this.lowRatio) {
      this._lowStreak = 0;
      return null;
    }

    this._lowStreak += 1;
    if (this._lowStreak < this.consecutive) return null;
    if (this.shots >= this.maxShots) return null;
    if (t - this._lastShotTs < this.cooldownMs) return null;

    this._lowStreak = 0;
    this._lastShotTs = t;
    this.shots += 1;
    return { fps, target, ts: t };
  }
}

module.exports = { TroughDetector, percentile, DEFAULTS };
