'use strict';

const { execFile } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

/** 与 ios-collector.js 保持同一套查找顺序 */
function resolveIosBin() {
  const candidates = [
    path.join(process.resourcesPath || '', 'ios-tools', 'bin', 'ios.exe'),
    path.join(__dirname, '..', 'ios-tools', 'bin', 'ios.exe'),
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

/**
 * 截取 iOS 设备当前画面（PNG 字节）。
 * go-ios：`ios screenshot [--output=<file>] [--udid=<udid>]`。UDID 是 `--udid=`（没有 `-u` 短选项），
 * 用错会被 docopt 当成未知参数直接失败。iOS 17+ 依赖已建立的 tunnel，
 * 失败时把 stderr 原样抛给调用方记日志（不做重试：低谷每 10s 才会再触发）。
 */
function captureIosScreen(udid, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const bin = resolveIosBin();
    if (!bin) return reject(new Error('ios.exe not found'));
    const out = path.join(os.tmpdir(), `perfara_shot_${process.pid}_${Date.now()}.png`);
    const args = ['screenshot', `--output=${out}`];
    if (udid) args.push(`--udid=${String(udid)}`);

    execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      let buf = null;
      try { if (fs.existsSync(out)) buf = fs.readFileSync(out); } catch (_) {}
      try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch (_) {}
      if (!buf || buf.length < 100) {
        const detail = [stderr && String(stderr).trim(), err && err.message]
          .filter(Boolean).join(' ') || 'ios screenshot 无输出';
        return reject(new Error(detail));
      }
      resolve(buf);
    });
  });
}

module.exports = { captureIosScreen, resolveIosBin };
