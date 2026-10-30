'use strict';

const { nativeImage } = require('electron');
const fs   = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { TroughDetector } = require('./trough-detector');

const MAX_WIDTH = 900;
const JPEG_QUALITY = 82;
// 曲线标记只需几十像素宽，单独存一张小图，避免 900 宽原图在报告/曲线里按原尺寸解码
const THUMB_WIDTH = 140;
const THUMB_QUALITY = 76;

/** category → 本轮状态（detector + 落盘目录 + 已存条目） */
const _runs = new Map();

function _pad(n) { return String(n).padStart(2, '0'); }

function _sanitize(s) {
  return String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
}

function _stamp(d) {
  return `${d.getFullYear()}${_pad(d.getMonth() + 1)}${_pad(d.getDate())}`
    + `-${_pad(d.getHours())}${_pad(d.getMinutes())}${_pad(d.getSeconds())}`;
}

/**
 * 开始一轮采集：重置判定器，确定截图目录 `reports/shots/<app>/<起始时间>/`。
 * 同一 category 反复开始会覆盖上一轮状态（旧文件由 clear-report-shots / 下次启动清理）。
 */
function beginRun(reportsDir, category, appId, startTs) {
  const start = Number.isFinite(startTs) ? startTs : Date.now();
  const rel = ['shots', _sanitize(appId) || 'app', _stamp(new Date(start))].join('/');
  _runs.set(category, {
    detector: new TroughDetector(),
    rel,
    abs: path.join(reportsDir, ...rel.split('/')),
    startTs: start,
    seq: 0,
    busy: false,
    shots: [],
  });
}

function resetRun(category) {
  _runs.delete(category);
}

function resetAll() {
  _runs.clear();
}

/**
 * 喂一拍 FPS；命中低谷时调用 capture() 取图，压缩后落盘。
 * @param {string} category 'android' | 'ios'
 * @param {number} ts 采样时间戳（ms）
 * @param {number|null} fps
 * @param {() => Promise<Buffer>} capture 返回 PNG 字节
 * @returns {Promise<{meta?:object, hit:boolean, error?:Error}>}
 */
async function feed(category, ts, fps, capture) {
  const run = _runs.get(category);
  if (!run || run.busy) return { hit: false };
  const hit = run.detector.push(fps, ts);
  if (!hit) return { hit: false };

  run.busy = true;
  try {
    const png = await capture();
    const meta = savePng(run, png, hit);
    return { hit: true, meta };
  } catch (error) {
    return { hit: true, error };
  } finally {
    run.busy = false;
  }
}

function savePng(run, png, hit) {
  const img = nativeImage.createFromBuffer(png);
  if (img.isEmpty()) throw new Error('截图解码失败');
  const { width } = img.getSize();
  const out = width > MAX_WIDTH ? img.resize({ width: MAX_WIDTH, quality: 'good' }) : img;
  const jpeg = out.toJPEG(JPEG_QUALITY);
  if (!jpeg || jpeg.length < 500) throw new Error('截图编码失败');

  fs.mkdirSync(run.abs, { recursive: true });
  const d = new Date(hit.ts);
  const stem = `trough_${_pad(d.getHours())}${_pad(d.getMinutes())}${_pad(d.getSeconds())}`
    + `_${_pad(++run.seq)}`;
  const name = `${stem}.jpg`;
  const abs = path.join(run.abs, name);
  fs.writeFileSync(abs, jpeg);

  let thumb = '';
  let thumbUrl = '';
  try {
    const thumbJpeg = out.resize({ width: THUMB_WIDTH, quality: 'good' }).toJPEG(THUMB_QUALITY);
    if (thumbJpeg && thumbJpeg.length > 200) {
      const thumbName = `thumb_${stem}.jpg`;
      const thumbAbs = path.join(run.abs, thumbName);
      fs.writeFileSync(thumbAbs, thumbJpeg);
      thumb = `${run.rel}/${thumbName}`;
      thumbUrl = pathToFileURL(thumbAbs).href;
    }
  } catch (_) {
    // 小图失败不影响主图；展示端会回退到原图
  }

  const rel = `${run.rel}/${name}`;
  const meta = {
    id: rel,
    t: Math.max(0, Math.round((hit.ts - run.startTs) / 1000)),
    time: d.toLocaleTimeString(),
    fps: Math.round(hit.fps * 10) / 10,
    target: Math.round(hit.target * 10) / 10,
    file: rel,
    url: pathToFileURL(abs).href,
    bytes: jpeg.length,
    thumb,
    thumbUrl,
  };
  run.shots.push(meta);
  return meta;
}

/** 报告用：本轮已落盘的截图（不含 url 之外的私有字段时会一并写入 data.js，保留 url 便于直接打开） */
function getShots(category) {
  const run = _runs.get(category);
  return run ? run.shots.slice() : [];
}

module.exports = { beginRun, resetRun, resetAll, feed, getShots, MAX_WIDTH, JPEG_QUALITY };
