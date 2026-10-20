'use strict';

const fs   = require('fs');
const path = require('path');

const LOG_DIR  = path.join(__dirname, '..', 'log');
const LOG_FILE = path.join(LOG_DIR, 'ios.log');

let _stream = null;

function _open() {
  if (_stream) return _stream;
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    _stream = fs.createWriteStream(LOG_FILE, { flags: 'a', encoding: 'utf8' });
    _stream.on('error', () => { _stream = null; });
  } catch (_) {}
  return _stream;
}

function write(line) {
  const stream = _open();
  if (!stream) return;
  try {
    stream.write(`[${new Date().toISOString()}] ${line}\n`);
  } catch (_) {}
}

function separator(label) {
  write(`${'='.repeat(20)} ${label} ${'='.repeat(20)}`);
}

module.exports = { write, separator };
