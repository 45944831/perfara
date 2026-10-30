'use strict';

/**
 * WeakNet 引擎宿主：拉起进程 → 拿到实际端口 → 转发控制请求 → 退出回收。
 *
 * 为什么要有这一层：
 *   - 引擎（weaknet.py）的控制接口没有 CORS 头，渲染进程不能直接 fetch，
 *     所以请求统一走主进程（renderer → IPC → 这里 → http://127.0.0.1:port）。
 *   - 引擎端口可能被占用后顺延，硬编码 8899 会连错实例（甚至别的程序），
 *     所以用 --ready-file 握手拿到它自己报告的实际端口。
 *   - 纯 Node 实现，不 require('electron')，测试可以脱离 Electron 直接驱动。
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const DEFAULT_CTRL_PORT = Number(process.env.PERFARA_WEAKNET_CTRL || 8899) || 8899;
const DEFAULT_PROXY_PORT = 8888;
/** 冷启动（onefile 解包 + 引擎起来）实测 2~6 s，留足余量 */
const READY_TIMEOUT_MS = 25000;
/** 单次控制请求超时：接口都是本地同步操作，5 s 不回来就是出事了 */
const CALL_TIMEOUT_MS = 5000;

/**
 * 允许渲染进程调用的路由。
 * 桌面端 /api/vpn、/api/float 固定 501（安卓专属），不开放；/ 与 /index.html 是
 * 网页控制台入口，也不需要。白名单同时挡住「顺手套一个别的 URL」这种用法。
 */
const ALLOWED_PATHS = new Set([
  '/api/status', '/api/presets', '/api/params', '/api/upresets', '/api/combos',
  '/api/targets', '/api/peers', '/api/inbox', '/api/inbox/resolve', '/api/me',
  '/api/share/status', '/api/share/pin', '/api/push',
  '/api/preset', '/api/profile', '/api/run', '/api/stop', '/api/scope',
  '/api/sysproxy', '/api/listen', '/api/combo', '/api/combo/delete',
  '/api/upreset', '/api/upreset/del',
]);

/** @type {{proc:import('child_process').ChildProcess|null, info:object|null, starting:Promise|null}} */
const state = { proc: null, info: null, starting: null };
let exitHandler = null;

function setExitHandler(fn) {
  exitHandler = typeof fn === 'function' ? fn : null;
}

function _tmpReadyFile() {
  return path.join(os.tmpdir(), 'perfara-weaknet-' + process.pid + '-' +
    Math.random().toString(36).slice(2, 8) + '.json');
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 直接打引擎的 /api/status，用来判断某个端口上是不是已经有 WeakNet */
function probe(port, timeout = 900) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/status', method: 'GET' },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try { resolve(JSON.parse(body)); } catch (_) { resolve(null); }
        });
      });
    req.on('error', () => resolve(null));
    req.setTimeout(timeout, () => { try { req.destroy(); } catch (_) {} resolve(null); });
    req.end();
  });
}

function isAlive() {
  return !!state.info;
}

function currentInfo() {
  return state.info ? { ...state.info } : null;
}

/**
 * 复用已在跑的引擎（用户可能自己开了 WeakNet.exe，也可能上一次没退干净）。
 * 命中就接管，不再起第二个进程 —— 两个引擎抢同一套端口只会互相踩。
 */
async function _adoptIfRunning(defaultCtrlPort) {
  if (state.info && state.proc) return null;
  const st = await probe(defaultCtrlPort);
  if (!st) return null;
  state.info = {
    ctrlPort: defaultCtrlPort,
    proxyPort: st.listen && st.listen.port ? st.listen.port : null,
    version: st.version || '',
    pid: null,
    adopted: true,
  };
  _watchAdopted();
  return state.info;
}

/**
 * 接管来的实例不是自己的子进程，没有 exit 事件：用户把那个 WeakNet 窗口一关，
 * 手机代理还指着它的端口，就成了「没人管却还在绕路」的残留。
 * 每 5 秒探一次，连续两次探不到就当作退出，走和自有引擎一样的收尾。
 */
let adoptTimer = null;
function _stopAdoptWatch() {
  if (adoptTimer) { clearInterval(adoptTimer); adoptTimer = null; }
}
/** 接管实例没了：清状态并走和自有引擎退出一样的收尾（还原手机代理、系统代理） */
function _adoptedGone(was) {
  state.info = null;
  state.proc = null;
  _stopAdoptWatch();
  if (exitHandler) { try { exitHandler(was || {}, { code: 'adopted-gone' }); } catch (_) {} }
}
function _watchAdopted() {
  if (adoptTimer) return;
  const tick = async () => {
    const info = state.info;
    if (!info || !info.adopted) { _stopAdoptWatch(); return; }
    if (await probe(info.ctrlPort, 1200)) return;
    if (await probe(info.ctrlPort, 1200)) return;
    _adoptedGone({ ...info });
  };
  adoptTimer = setInterval(() => { tick().catch(() => {}); }, 5000);
  if (adoptTimer.unref) adoptTimer.unref();
}

/**
 * 确保引擎在跑。
 * @param {{command:string, args?:string[], cwd?:string, env?:object,
 *          ctrlPort?:number, proxyPort?:number}} spec
 * @returns {Promise<{ok:boolean, ctrlPort?:number, proxyPort?:number, version?:string,
 *                    adopted?:boolean, reason?:string}>}
 */
async function ensure(spec) {
  if (state.info && state.info.adopted) {
    // 接管来的实例随时可能被用户关掉，别拿旧端口当还活着
    if (await probe(state.info.ctrlPort)) { _watchAdopted(); return { ok: true, ...state.info }; }
    _adoptedGone({ ...state.info });
  }
  if (isAlive()) {
    // 句柄还在不代表端口还答话：引擎卡死、被系统挂起、上一个实例刚被关时，
    // 拿这个「活着」的状态去接手机，只会把手机指到一个没人监听的端口
    if (await probe(state.info.ctrlPort, 1500)) return { ok: true, ...state.info };
    const was = { ...state.info };
    state.proc = null;
    state.info = null;
    if (exitHandler) { try { exitHandler(was, { code: 'unresponsive' }); } catch (_) {} }
  }
  if (state.starting) return state.starting;
  const ctrlPort = Number(spec && spec.ctrlPort) || DEFAULT_CTRL_PORT;
  const proxyPort = Number(spec && spec.proxyPort) || DEFAULT_PROXY_PORT;

  const adopted = await _adoptIfRunning(ctrlPort);
  if (adopted) return { ok: true, ...adopted };

  if (!spec || !spec.command) return { ok: false, reason: '未配置弱网引擎启动命令' };

  state.starting = _spawnAndHandshake(spec, ctrlPort, proxyPort);
  try {
    return await state.starting;
  } finally {
    state.starting = null;
  }
}

async function _spawnAndHandshake(spec, ctrlPort, proxyPort) {
  const readyFile = spec.readyFile || _tmpReadyFile();
  try { fs.unlinkSync(readyFile); } catch (_) {}
  const args = (spec.args || []).concat(['--ready-file', readyFile]);

  let child;
  try {
    child = spawn(spec.command, args, {
      cwd: spec.cwd || undefined,
      env: spec.env || process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return { ok: false, reason: '启动弱网引擎失败：' + (e.message || String(e)) };
  }

  let tail = '';
  const collect = (buf) => {
    tail = (tail + buf.toString('utf8')).slice(-4096);
  };
  if (child.stdout) child.stdout.on('data', collect);
  if (child.stderr) child.stderr.on('data', collect);

  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  child.on('error', (e) => { exited = { code: -1, signal: String(e && e.message) }; });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(readyFile)) {
      let info = null;
      try { info = JSON.parse(fs.readFileSync(readyFile, 'utf8')); } catch (_) {}
      if (info && info.status === 'ready') {
        state.proc = child;
        state.info = {
          ctrlPort: Number(info.ctrl_port) || ctrlPort,
          proxyPort: Number(info.proxy_port) || proxyPort,
          version: info.version || '',
          pid: info.pid || child.pid,
          adopted: false,
        };
        child.on('exit', (code, signal) => {
          if (state.proc !== child) return;
          const was = { ...state.info };
          state.proc = null;
          state.info = null;
          if (exitHandler) { try { exitHandler(was, { code, signal }); } catch (_) {} }
        });
        try { fs.unlinkSync(readyFile); } catch (_) {}
        return { ok: true, ...state.info };
      }
      if (info && info.status === 'already') {
        // 端口上是别的实例：直接接管它（它自己已经跑得好好的）。
        // 它只报 ctrl_port，代理端口得自己探：拿不到会让手机 reverse 到默认 8888，
        // 而对方可能因为 8888 被占顺延过端口，手机就被指到一个空端口上断网。
        const live = await probe(Number(info.ctrl_port) || ctrlPort, 1500);
        state.proc = null;
        state.info = {
          ctrlPort: Number(info.ctrl_port) || ctrlPort,
          proxyPort: (live && live.listen && live.listen.port) || null,
          version: info.version || (live && live.version) || '',
          pid: info.pid || null,
          adopted: true,
        };
        try { child.kill(); } catch (_) {}
        try { fs.unlinkSync(readyFile); } catch (_) {}
        _watchAdopted();
        return { ok: true, ...state.info };
      }
      if (info && info.status === 'failed') {
        try { child.kill(); } catch (_) {}
        try { fs.unlinkSync(readyFile); } catch (_) {}
        return { ok: false, reason: info.reason || '弱网引擎启动失败' };
      }
    }
    if (exited) {
      try { fs.unlinkSync(readyFile); } catch (_) {}
      return { ok: false, reason: _exitReason(tail, exited) };
    }
    await _sleep(120);
  }

  try { child.kill(); } catch (_) {}
  try { fs.unlinkSync(readyFile); } catch (_) {}
  return { ok: false, reason: '弱网引擎启动超时（' + Math.round(READY_TIMEOUT_MS / 1000) + ' 秒）' };
}

/** 把「进程秒退」翻译成用户看得懂的话：最常见的原因是 exe 还是旧版本，不认 --headless */
function _exitReason(tail, exited) {
  // code=-1 是 spawn 自己的 error 事件（exe 不在、被拦、无权限），此时没有输出，
  // 真正的原因在 signal 里（我们存的是 e.message），不带上就只能看到「立即退出」
  if (exited && exited.code === -1) {
    return '无法启动弱网引擎：' + (exited.signal || '未知错误') +
      '（常见原因：exe 被杀毒软件隔离、文件被删、没有执行权限）';
  }
  const t = tail || '';
  if (/unrecognized arguments|no such option|invalid choice/i.test(t)) {
    return '弱网引擎版本过旧，不支持无界面模式（需重新打包 WeakNet.exe）';
  }
  const code = exited && exited.code != null ? exited.code : '?';
  const line = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() || '';
  return '弱网引擎启动后立即退出（code=' + code + '）' + (line ? '：' + line : '');
}

/**
 * 转发一次控制请求。
 * @param {string} apiPath 必须是 ALLOWED_PATHS 里的
 * @param {object} [body] 有 body 就走 POST
 * @param {{port?:number, timeout?:number}} [opts] port 用于指定手机 APK 的转发端口
 */
function call(apiPath, body, opts) {
  const p = String(apiPath || '');
  if (!ALLOWED_PATHS.has(p)) {
    return Promise.reject(new Error('不支持的弱网接口：' + p));
  }
  const port = Number(opts && opts.port) || (state.info && state.info.ctrlPort) || DEFAULT_CTRL_PORT;
  const timeout = Number(opts && opts.timeout) || CALL_TIMEOUT_MS;
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: p,
      method: payload ? 'POST' : 'GET',
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
        : {},
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = raw; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const reason = (data && data.error) || (data && data.reason) || '';
          reject(new Error((reason || '接口返回 HTTP ' + res.statusCode) + ' [' + p + ']'));
          return;
        }
        resolve(data);
      });
    });
    req.on('error', (e) => reject(new Error('弱网引擎未响应：' + (e.message || e))));
    req.setTimeout(timeout, () => {
      try { req.destroy(); } catch (_) {}
      reject(new Error('弱网引擎响应超时：' + p));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** 停掉自己拉起的引擎。接管来的实例不动（可能是用户自己开的窗口） */
function stop() {
  _stopAdoptWatch();
  const info = state.info;
  const child = state.proc;
  state.proc = null;
  state.info = null;
  if (!child) return { stopped: false, adopted: !!(info && info.adopted) };
  const pid = child.pid;
  try {
    // onefile 的 exe 是「引导进程 + 真身」两层，只 kill 引导会留下真身占着端口。
    // 必须同步等 taskkill 跑完：退出路径上紧接着就是 app.quit()，异步 spawn 的
    // taskkill 会跟着 Electron 的 job 一起被杀，引擎就成了没人管的孤儿进程。
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    } else {
      child.kill();
    }
  } catch (_) {
    try { child.kill(); } catch (__) {}
  }
  return { stopped: true, adopted: false };
}

/**
 * 退出前收尾：先让引擎解除系统代理接管、停掉限速，再杀进程。
 *
 * 引擎进程里的 atexit 才会还原系统代理，而 taskkill /F 绕过 atexit —— 直接强杀会
 * 把整机代理留在一个已经没人监听的端口上（表现为「关掉工具后上不了网」）。
 * 所以这两步不能省；万一接口已经不响应，也别把退出拖住，4 秒后照样杀。
 */
async function shutdown() {
  if (!state.info) return { ok: true, skipped: true };
  const bounded = new Promise((r) => setTimeout(r, 4000));
  const cleanup = (async () => {
    if (state.info && state.info.adopted) return;   // 别人的实例：不动它的全局设置
    try { await call('/api/sysproxy', { enable: false }); } catch (_) {}
    try { await call('/api/stop'); } catch (_) {}
  })();
  await Promise.race([cleanup, bounded]);
  return { ok: true, ...stop() };
}

module.exports = {
  ensure, call, stop, shutdown, probe, isAlive, currentInfo,
  setExitHandler, ALLOWED_PATHS, DEFAULT_CTRL_PORT, DEFAULT_PROXY_PORT, READY_TIMEOUT_MS,
};
