'use strict';

const fs   = require('fs');
const path = require('path');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 3;

let _stream = null;
let _file   = null;

function _logDir() {
  // 显式覆盖（排障/测试）
  if (process.env.PERFARA_LOG_DIR) return process.env.PERFARA_LOG_DIR;
  // 打包态 app.asar 只读，__dirname 下的 log/ 建不出来（旧版静默丢弃全部 iOS 日志）。
  // 便携包布局：collector/resources/app.asar → ../../logs 即包根 logs\（与 launcher.log 同处）。
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) return path.join(process.resourcesPath, '..', '..', 'logs');
  } catch (_) {}
  return path.join(__dirname, '..', 'log');
}

function _rotate(file) {
  try {
    if (fs.statSync(file).size < MAX_BYTES) return;
  } catch (_) {
    return;
  }
  for (let i = MAX_FILES - 1; i >= 1; i--) {
    const from = i === 1 ? file : `${file}.${i - 1}`;
    try { fs.renameSync(from, `${file}.${i}`); } catch (_) {}
  }
}

function _open() {
  if (_stream) return _stream;
  if (!_file) _file = path.join(_logDir(), 'ios.log');
  try {
    fs.mkdirSync(path.dirname(_file), { recursive: true });
    _rotate(_file);
    const stream = fs.createWriteStream(_file, { flags: 'a', encoding: 'utf8' });
    stream.on('error', () => { _stream = null; });
    _stream = stream;
  } catch (_) {}
  return _stream;
}

// 设备 UDID 不能落进日志（日志可能被用户回传）
const UDID_RE = /\b[0-9a-fA-F]{40}\b|\b[0-9a-fA-F]{24}\b/g;

function _mask(line) {
  return line.replace(UDID_RE, (m) => `${m.slice(0, 6)}…${m.slice(-4)}`);
}

function write(line) {
  const stream = _open();
  if (!stream) return;
  try {
    stream.write(`[${new Date().toISOString()}] ${_mask(String(line))}\n`);
  } catch (_) {}
}

function separator(label) {
  write(`${'='.repeat(20)} ${label} ${'='.repeat(20)}`);
}

module.exports = { write, separator };
