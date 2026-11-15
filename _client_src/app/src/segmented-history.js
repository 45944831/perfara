'use strict';

/**
 * 1.5 长时采集「分段落盘 + 报告合并」。
 *
 * 旧实现：内存里只留 MAX_HISTORY 个点，超了就 shift() 静默丢开头。
 * 新实现：到达上限时把最早的一段写成 JSON 分片到临时目录，内存只留最近的点；
 * 停止采集时把分片按顺序读回来，与内存尾部拼成完整 perf 数组再出报告。
 * 所以「12 小时内存上限」不再等于「报告只有 12 小时」。
 *
 * 设计约束：
 *   - 分片目录在**第一次溢出时**才创建，短时采集零 IO；
 *   - 写盘失败不丢数据（退回内存保留 + 计入 dropped，并打日志）；
 *   - 合并后由 drainSegments() 删除分片，不留垃圾；
 *   - 文件操作可注入 fs 替身，便于离线注入 15000 点。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/** 纯函数：算一次溢出要挪走多少点，便于单测 */
function planSpill(currentLen, max, chunkSize) {
  const n = Math.min(Math.max(1, Math.floor(chunkSize) || 1), Math.max(1, Math.floor(max) || 1));
  return currentLen >= max ? n : 0;
}

class SegmentedHistory {
  /**
   * @param {Object} opts
   * @param {number} opts.max 内存保留上限
   * @param {number} [opts.chunkSize=3600] 每次溢出的点数（默认 1 小时 @1Hz）
   * @param {string} [opts.dir] 分片目录，缺省用系统临时目录
   * @param {Object} [opts.fs] 文件系统替身
   * @param {Function} [opts.log] 日志回调
   */
  constructor(opts) {
    const o = opts || {};
    this.max = Math.max(1, Math.floor(o.max) || 1);
    this.chunkSize = Math.max(1, Math.floor(o.chunkSize) || 3600);
    this._f = o.fs || fs;
    this._log = typeof o.log === 'function' ? o.log : () => {};
    this.dir = o.dir || path.join(os.tmpdir(), 'perfara_segments',
      `run-${process.pid}-${Date.now()}`);
    this.segments = [];
    this.spilledPoints = 0;
    this.droppedPoints = 0;
    this._dirReady = false;
  }

  _ensureDir() {
    if (this._dirReady) return true;
    try {
      this._f.mkdirSync(this.dir, { recursive: true });
      this._dirReady = true;
      return true;
    } catch (e) {
      this._log(`分段目录创建失败：${e.message}`);
      return false;
    }
  }

  /**
   * 往缓冲区追加一拍；触发上限时先把最早一段挪到磁盘。
   * @param {Array<Object>} buffer 当前内存缓冲（原地修改）
   * @param {Object} row 新采样点
   */
  push(buffer, row) {
    const n = planSpill(buffer.length, this.max, this.chunkSize);
    if (n > 0) {
      const chunk = buffer.splice(0, n);
      if (this._ensureDir()) {
        const idx = this.segments.length;
        const file = path.join(this.dir, `part-${String(idx).padStart(4, '0')}.json`);
        try {
          this._f.writeFileSync(file, JSON.stringify(chunk), 'utf8');
          this.segments.push({
            file,
            count: chunk.length,
            firstTs: chunk[0] && chunk[0].timestamp,
            lastTs: chunk[chunk.length - 1] && chunk[chunk.length - 1].timestamp,
          });
          this.spilledPoints += chunk.length;
          if (this.segments.length === 1) {
            this._log(`采样点已达内存上限 ${this.max}，最早的 ${chunk.length} 点已落盘分片；`
              + '停止采集时会自动合并进报告，不会丢数据');
          }
        } catch (e) {
          // 写盘失败：不能无限把旧点退回内存（长时采集会 OOM），
          // 只能显式丢弃并计数 + 每次都打日志，绝不静默。
          this.droppedPoints += chunk.length;
          this._log(`分段写盘失败（${e.message}）：最早的 ${chunk.length} 个点已丢弃，`
            + `累计 ${this.droppedPoints} 点；报告会标注数据不完整`);
        }
      } else {
        this.droppedPoints += chunk.length;
        this._log(`分段目录不可用：最早的 ${chunk.length} 个点已丢弃，累计 ${this.droppedPoints} 点`);
      }
    }
    buffer.push(row);
  }

  /** 读回全部分片，按写入顺序拼好（不含内存尾部） */
  readSpilled() {
    const out = [];
    for (const seg of this.segments) {
      try {
        const arr = JSON.parse(this._f.readFileSync(seg.file, 'utf8'));
        if (Array.isArray(arr)) for (const r of arr) out.push(r);
      } catch (e) {
        this._log(`分段读取失败：${seg.file} ${e.message}`);
      }
    }
    return out;
  }

  /** 合并分片 + 内存尾部，然后清理临时文件 */
  drain(buffer) {
    const spilled = this.readSpilled();
    const merged = spilled.concat(Array.isArray(buffer) ? buffer : []);
    for (const seg of this.segments) {
      try { this._f.unlinkSync(seg.file); } catch (_) {}
    }
    if (this._dirReady) {
      try { this._f.rmdirSync(this.dir); } catch (_) {}
    }
    this.segments = [];
    return merged;
  }

  diagnostics() {
    return {
      spilledPoints: this.spilledPoints,
      droppedPoints: this.droppedPoints,
      segmentCount: this.segments.length,
      dir: this._dirReady ? this.dir : null,
    };
  }
}

module.exports = { SegmentedHistory, planSpill };
