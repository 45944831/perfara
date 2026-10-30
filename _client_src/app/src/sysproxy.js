'use strict';

/**
 * Windows 系统代理的残留兜底。
 *
 * 引擎自己会在退出时解除接管（`set_sysproxy(false)`），但那是 Python 的 atexit ——
 * 被 taskkill /F、崩溃、整机断电时都不会执行，HKCU 里就留下
 * `ProxyEnable=1` + `ProxyServer=127.0.0.1:<引擎端口>`，表现是「工具没了，整机上不了网」。
 *
 * 这里在开启前把注册表原值快照到磁盘（进程死了快照还在），引擎意外退出或下次启动
 * 发现快照还在，就按快照还原并通知系统刷新。只有当前代理仍然指向快照记录的那个引擎
 * 端口才动 —— 用户中途自己改过代理就不碰，只把快照丢掉。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const NAMES = ['ProxyEnable', 'ProxyServer', 'ProxyOverride'];

function _short(e) {
  const text = String((e && e.message) || e || '');
  return text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || '';
}

function _reg(args) {
  return execFileSync('reg', args, { windowsHide: true, encoding: 'utf8', timeout: 5000 });
}

/** 读一项；不存在（REG 报错）返回 null，区分「没有这个值」和「读挂了」 */
function _readValue(name) {
  let out = '';
  try {
    out = _reg(['query', KEY, '/v', name]);
  } catch (_) {
    return null;
  }
  const m = /^\s*(\S+)\s+(REG_[A-Z_]+)\s+(.*)$/m.exec(out);
  if (!m) return null;
  const type = m[2];
  const raw = String(m[3]).trim();
  if (type === 'REG_DWORD') {
    return { type, value: /^0x/i.test(raw) ? parseInt(raw, 16) : Number(raw) };
  }
  return { type, value: raw };
}

function _readReg() {
  const out = {};
  for (const n of NAMES) out[n] = _readValue(n);
  return out;
}

function _writeReg(values) {
  for (const n of NAMES) {
    const item = values[n];
    if (!item) {
      try { _reg(['delete', KEY, '/v', n, '/f']); } catch (_) {}
      continue;
    }
    const type = item.type === 'REG_DWORD' ? 'REG_DWORD' : 'REG_SZ';
    _reg(['add', KEY, '/v', n, '/t', type, '/d', String(item.value), '/f']);
  }
}

/** 通知 WinINet 立刻重读设置；失败只影响见效速度，不影响结论 */
function _notify() {
  const ps = 'Add-Type -Namespace Perfara -Name Wininet -MemberDefinition '
    + '\'[System.Runtime.InteropServices.DllImport("wininet.dll")] public static extern bool '
    + 'InternetSetOption(System.IntPtr h,int o,System.IntPtr b,int l);\';'
    + '[Perfara.Wininet]::InternetSetOption([System.IntPtr]::Zero,39,[System.IntPtr]::Zero,0)|Out-Null;'
    + '[Perfara.Wininet]::InternetSetOption([System.IntPtr]::Zero,37,[System.IntPtr]::Zero,0)|Out-Null';
  try {
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
  } catch (_) {}
}

/** 测试注入：默认走真注册表；单测换成内存对象，不碰本机设置 */
let _io = null;
function _hooks() {
  return _io || { read: _readReg, write: _writeReg, notify: _notify };
}

function _ours(proxyServer, port) {
  return !!port && String(proxyServer || '').trim() === '127.0.0.1:' + port;
}

function _readBackup(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || !obj.values) return null;
    return obj;
  } catch (_) {
    return null;
  }
}

/**
 * 开启系统代理前把原值存下来。存失败不影响开启（最多是崩溃时还原不了），
 * 所以这里不抛，只把原因交给调用方记日志。
 */
function snapshot(file, port) {
  try {
    const p = Number(port) || 0;
    const values = _hooks().read();
    // 已经是本引擎接管着的（重复点「接管」/重新拉起后补一句）：原值早被覆盖掉了，
    // 再快照一次只会把 127.0.0.1:<port> 当成「用户原值」存下来
    const cur = values && values.ProxyServer && values.ProxyServer.value;
    if (values && values.ProxyEnable && Number(values.ProxyEnable.value) && _ours(cur, p)) {
      return { ok: false, skipped: true, reason: 'already-ours' };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ port: p, at: Date.now(), values }), 'utf8');
    return { ok: true, port: p };
  } catch (e) {
    return { ok: false, msg: _short(e) };
  }
}

function clearBackup(file) {
  try { fs.unlinkSync(file); return { ok: true }; }
  catch (_) { return { ok: false }; }
}

/**
 * 发现快照就还原（引擎崩溃后 / 下次启动时）。只在当前代理仍指向快照里记录的
 * 引擎端口时改注册表：用户中途换了代理（另一个端口、另一个地址）就不能覆盖。
 */
function restoreStale(file) {
  const backup = _readBackup(file);
  if (!backup) return { ok: false, skipped: true, reason: 'no-backup' };
  const h = _hooks();
  let current;
  try { current = h.read(); } catch (e) { return { ok: false, msg: _short(e) }; }
  const cur = current && current.ProxyServer && current.ProxyServer.value;
  const enable = current && current.ProxyEnable && Number(current.ProxyEnable.value);
  if (!enable || !_ours(cur, backup.port)) {
    // 已经不是我们写的接管了（用户自己改过、或已被正常解除）：只丢掉过期快照
    clearBackup(file);
    return { ok: false, skipped: true, reason: 'changed', current: cur || '' };
  }
  try {
    h.write(backup.values);
  } catch (e) {
    return { ok: false, msg: _short(e) };
  }
  clearBackup(file);
  try { h.notify(); } catch (_) {}
  return { ok: true, port: backup.port };
}

module.exports = {
  snapshot, restoreStale, clearBackup, KEY, NAMES,
  __setIO: (io) => { _io = io || null; },
};
