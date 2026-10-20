'use strict';

const crypto = require('crypto');
const os = require('os');

/**
 * 与 Python platform.machine() 对齐（Windows: AMD64 而非 x64；Unix: x86_64 等）。
 */
function pythonStyleMachine() {
  const p = process.platform;
  const a = os.arch();
  if (p === 'win32') {
    if (a === 'x64') return 'AMD64';
    if (a === 'ia32') return 'x86';
    return a;
  }
  if (a === 'x64') return 'x86_64';
  if (a === 'ia32') return 'i686';
  return a;
}

/**
 * 本机唯一 UID（64 位十六进制 SHA256），与项目根 uid.py 算法一致。
 */
function getMachineUid() {
  const parts = [
    os.hostname(),
    os.platform(),
    pythonStyleMachine(),
    String(os.userInfo().username || ''),
  ];
  return crypto.createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

module.exports = { getMachineUid };
