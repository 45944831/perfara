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
 *   5) 帧耗时分位数（overrunP99）作为**补充证据**：偶发一次 200ms 长帧会被
 *      1 秒窗口的平均帧率抹平（60→50fps 仍在中间地带），只看 FPS 会漏掉。
 *      但 overrun 不能单独当卡顿证据 —— 锁 30fps 的应用在 60Hz 上每帧天然
 *      超时 16.7ms，那是主动限帧而非卡顿，故阈值取 100ms 量级。
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
  // P2b 分段配额（2026-11-19）：真实报告的 30 张低谷截图全集中在前 11 分钟，
  // 后段的场景切换拐点（16:41 FPS 从 ~38 掉到 ~20）没有一张截图可归因。
  // segmentSamples>0 时启用：每 segmentSamples 拍最多 perSegment 张，避免前段用光额度。
  // 默认 0 = 关闭，行为与旧版完全一致（单测/默认构造不受影响）。
  segmentSamples: 0,
  perSegment: 10,
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

/**
 * 帧耗时超时严重度（0=无证据，1=值得注意，2=确认长帧）。
 *
 * overrunP99 是「本拍最差 1% 的帧超出 vsync 多少毫秒」，overrunMax 是「最差单帧超时」。
 * 后者比 FPS 敏感得多：一次 200ms 长帧在 1 秒窗口里只把平均帧率从 60 拉到 50，
 * 仍高于低帧线，但 overrunMax 会直接报到 180ms 以上。
 *
 * 阈值刻意取 100ms：锁 30fps 的应用在 60Hz 上每帧天然超时 16.7ms、
 * 在 120Hz 上 25ms，都属于「主动限帧」，不能被当成卡顿刷图。
 */
function overrunSeverity(ctx) {
  if (!ctx || typeof ctx !== 'object') return 0;
  // 旧数据没有 overrunMax 时退回 overrunP99（同一物理含义，只是统计位置不同）
  const raw = (ctx.overrunMax != null) ? ctx.overrunMax : ctx.overrunP99;
  const over = Number(raw);
  if (!Number.isFinite(over)) return 0;
  if (over >= 100) return 2;
  if (over >= 50) return 1;
  return 0;
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
    this.segmentSamples = Math.max(0, o.segmentSamples | 0);
    this.perSegment = Math.max(1, o.perSegment | 0);
    // 每张截图落在第几个「样本段」：floor(sampleIndex / segmentSamples)。
    // 用记录数组而非计数 Map：段号按累计样本算，天然单调，无需清理旧段。
    this._shotSegmentCounts = new Map();
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
    this._shotSegmentCounts.clear();
  }

  /**
   * P2b：当前样本段是否还有配额。
   * 用「已积压的有效样本数」(_fps.length) 算段号——它是单调累计到 maxSamples 的滑窗长度，
   * 除以 segmentSamples 得到段号；段内截图数达 perSegment 则本段不再截。
   * @returns {boolean} true=允许截图
   */
  _segmentAllows() {
    if (!this.segmentSamples) return true;
    const seg = Math.floor(this._fps.length / this.segmentSamples);
    return (this._shotSegmentCounts.get(seg) || 0) < this.perSegment;
  }

  _recordSegmentShot() {
    if (!this.segmentSamples) return;
    const seg = Math.floor(this._fps.length / this.segmentSamples);
    this._shotSegmentCounts.set(seg, (this._shotSegmentCounts.get(seg) || 0) + 1);
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

    // 中间地带（介于低帧线和恢复线之间）：既不算低谷也不算恢复。
    // 例外：帧耗时出现成片长帧（overrunP99 ≥ 100ms）。此时平均帧率被拉回
    // 中间地带，但画面确实卡了 —— 这是只看 FPS 抓不到的一类。
    if (fps >= target * this.lowRatio) {
      this._lowStreak = 0;
      this._highStreak = 0;
      if (this._armed && overrunSeverity(ctx) >= 2
          && this.shots < this.maxShots
          && this._segmentAllows()
          && t - this._lastShotTs >= this.cooldownMs) {
        this._armed = false;
        this._lastShotTs = t;
        this.shots += 1;
        this._recordSegmentShot();
        this._jankSeen = null;
        // 证据值要跟判定用同一个回退口径：旧数据只有 overrunP99 时，
        // 不能把 overrunMax 写成 NaN（JSON 序列化后变 null，证据就丢了）。
        const evidence = (ctx.overrunMax != null) ? ctx.overrunMax : ctx.overrunP99;
        return { fps, target, ts: t, reason: 'overrun', overrunMax: Number(evidence) };
      }
      this._jankSeen = null;
      return null;
    }

    this._lowStreak += 1;
    this._highStreak = 0;
    // 帧耗时证据与 jank 分级证据并列：任一为真即视为「确实卡了」
    const jank = jankSignal(ctx);
    this._jankSeen = mergeJank(this._jankSeen, jank === true ? true
      : (overrunSeverity(ctx) >= 1 ? true : jank));

    // 1) 从未到过正常帧率，或上次截图后尚未恢复 → 不截
    if (!this._armed) return null;
    if (this._lowStreak < this.consecutive) return null;
    // 3) 连续低帧太久 = 加载/静置/限帧平台，锁到恢复正常帧率为止
    if (this._lowStreak >= this.steadyAfter) {
      this._armed = false;
      return null;
    }
    if (this.shots >= this.maxShots) return null;
    // P2b：本样本段的软配额用尽 → 不截，给后段场景留额度（不惩罚 armed 状态，恢复后可再截）
    if (!this._segmentAllows()) return null;
    if (t - this._lastShotTs < this.cooldownMs) return null;

    // 4) 半帧平台 + 明确零卡顿 = 静置/加载/限帧，不是掉帧；深谷仍放行
    if (this._jankSeen === false && fps >= target * this.steadyFloorRatio) return null;

    // 2) 一次跌落只截一张，回到正常帧率后才重新武装
    this._armed = false;
    this._lowStreak = 0;
    this._lastShotTs = t;
    this.shots += 1;
    this._recordSegmentShot();
    return { fps, target, ts: t, reason: 'fps-drop' };
  }
}

module.exports = { TroughDetector, percentile, jankSignal, overrunSeverity, DEFAULTS };
