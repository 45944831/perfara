'use strict';

/**
 * 弱网引擎宿主（src/weaknet-host.js）+ 采集端接线的深度测试。
 *
 * 两类检查：
 *   1) 真引擎：用 WeakNet 源码起一个 headless 实例，验证握手端口、接口白名单、
 *      限速确实生效、退出回收，以及「接管已在跑的实例」「旧版本 exe 的报错翻译」。
 *   2) 静态接线：主进程/preload/四个页面/追踪模块的关键调用点，防止后续改动把
 *      这一段悄悄断掉（这类断裂跑起来才知道，静态检查能提前拦住）。
 *
 * WeakNet 源码目录用环境变量 PERFARA_WEAKNET_SRC 指定（本机调试也要设它）；
 * 没设或目录不存在时跳过真引擎部分，静态检查照跑。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HOST = require(path.join(ROOT, '_client_src', 'app', 'src', 'weaknet-host.js'));

const CTRL = 18901;
const PROXY = 18889;
const SRC = process.env.PERFARA_WEAKNET_SRC || '';

const checks = [];
function check(name, cond, extra) {
  checks.push({ name, ok: !!cond, extra });
  console.log((cond ? '  ok  ' : ' FAIL ') + name + (extra ? ' | ' + extra : ''));
}

function read(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (_) { return ''; }
}

function hasAll(text, needles) {
  return needles.every((n) => text.indexOf(n) >= 0);
}

// ── 通过引擎代理下载一个 256 KB 文件，用来实测限速 ────────────────────────────
function startBlobServer() {
  return new Promise((resolve) => {
    const buf = Buffer.alloc(256 * 1024, 7);
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length });
      res.end(buf);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function downloadViaProxy(url, proxyPort) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port: proxyPort, path: url, method: 'GET' }, (r) => {
      let n = 0;
      r.on('data', (c) => { n += c.length; });
      r.on('end', () => resolve({ n, ms: Date.now() - t0, code: r.statusCode }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function probePort(port) {
  return new Promise((resolve) => {
    const s = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout: 700 }, (r) => {
      r.resume();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

async function realEnginePart() {
  if (!SRC || !fs.existsSync(path.join(SRC, 'weaknet_gui.py'))) {
    console.log('SKIP 真引擎部分：未设置 PERFARA_WEAKNET_SRC 或目录里没有 weaknet_gui.py');
    return null;
  }
  const spec = () => ({
    command: 'python',
    args: [path.join(SRC, 'weaknet_gui.py'), '--headless',
      '--proxy-port', String(PROXY), '--ctrl-port', String(CTRL)],
    cwd: SRC,
    ctrlPort: CTRL,
    proxyPort: PROXY,
  });

  const { srv, port: blobPort } = await startBlobServer();
  let exits = 0;
  HOST.setExitHandler(() => { exits += 1; });
  let bare = null;

  try {
    const t0 = Date.now();
    const r = await HOST.ensure(spec());
    const bootMs = Date.now() - t0;
    check('ensure 拉起引擎并完成握手', r.ok === true, JSON.stringify(r) + ' / ' + bootMs + 'ms');
    check('握手回传实际端口', r.ctrlPort === CTRL && r.proxyPort === PROXY,
      r.ctrlPort + '/' + r.proxyPort);
    check('回传版本号与 pid', !!r.version && !!r.pid, r.version + ' pid=' + r.pid);

    const st = await HOST.call('/api/status');
    check('status 可读', st && st.limit_on === false, 'version=' + (st && st.version));
    const presets = await HOST.call('/api/presets');
    check('17 个内置场景', Array.isArray(presets) && presets.length === 17, 'n=' + presets.length);
    const cats = [...new Set((presets || []).map((p) => p.cat))];
    check('场景分三档', cats.length === 3, cats.join('/'));
    const params = await HOST.call('/api/params');
    check('13 个可调参数', params && params.items.length === 13, 'n=' + (params.items || []).length);

    // 白名单：任意 URL / 非 /api 路径 / 桌面端 501 的路由都要挡
    const denied = [];
    for (const p of ['http://example.com/', '/etc/passwd', '/api/vpn', '/api/float', '/', '/api/preset/../x']) {
      try { await HOST.call(p); denied.push(p + '=ALLOWED'); } catch (_) { denied.push(p + '=denied'); }
    }
    check('白名单挡住 6 个非法路径', denied.every((s) => /denied$/.test(s)), denied.join(' '));

    // 限速实测
    const direct = await downloadViaProxy('http://127.0.0.1:' + blobPort + '/blob.bin', PROXY);
    await HOST.call('/api/preset', { key: '4g_weak' });
    await HOST.call('/api/run', { enable: true });
    const st2 = await HOST.call('/api/status');
    check('开限速后 limit_on/preset 正确', st2.limit_on === true && st2.preset_key === '4g_weak',
      st2.limit_on + '/' + st2.preset_key);
    const slow = await downloadViaProxy('http://127.0.0.1:' + blobPort + '/blob.bin', PROXY);
    check('限速真实生效（≥3 倍耗时）', slow.ms > direct.ms * 3 && slow.n === direct.n,
      'direct=' + direct.ms + 'ms slow=' + slow.ms + 'ms bytes=' + slow.n);

    // 自定义参数
    await HOST.call('/api/profile', { down_kbps: 900 });
    const st3 = await HOST.call('/api/status');
    check('应用自定义参数', st3.preset_key === 'custom' && st3.profile.down_kbps === 900,
      st3.preset_key + ' down=' + st3.profile.down_kbps);

    // 弱网组合：新建 → 回读 → 选中播放（引擎按时间轴切段）→ 删除回直连
    const c1 = await HOST.call('/api/combo', { name: '自动化组合', loop: false, steps: [
      { key: '4g_weak', minutes: 0, seconds: 1 },
      { key: 'wifi', minutes: 0, seconds: 1 },
    ] });
    check('组合可以新建', !!(c1 && c1.ok === true && c1.id), JSON.stringify(c1));
    const combos = await HOST.call('/api/combos');
    const got = (combos && combos.items || []).find((x) => x.id === c1.id);
    check('组合列表回读段序', !!got && got.steps.length === 2 && /→/.test(got.summary || ''),
      got && got.summary);

    await HOST.call('/api/run', { enable: true });
    await HOST.call('/api/preset', { key: 'c:' + c1.id });
    const seen = new Set();
    for (let i = 0; i < 12; i++) {
      const s = await HOST.call('/api/status');
      seen.add(s.profile.name);
      await sleep(250);
    }
    check('组合按时间轴换段', seen.size >= 2, [...seen].join(' / '));

    const del = await HOST.call('/api/combo/delete', { id: c1.id });
    check('组合可以删除', !!(del && del.ok === true), JSON.stringify(del));
    const stAfter = await HOST.call('/api/status');
    check('删掉正在播的组合后回直连',
      stAfter.preset_key === 'direct' && stAfter.limit_on === false,
      stAfter.preset_key + ' limit=' + stAfter.limit_on);

    // 回收：shutdown 先解除系统代理再杀进程
    const sd = await HOST.shutdown();
    check('shutdown 回收自有引擎', sd.ok === true && sd.stopped === true, JSON.stringify(sd));
    await sleep(1200);
    check('回收后端口关闭', (await probePort(CTRL)) === false);
    check('回收后状态清空', HOST.isAlive() === false);

    // 接管已在跑的实例（用户自己开着 WeakNet 时不能起第二个）
    bare = spawn('python', ['weaknet_gui.py', '--headless', '--ready-file',
      path.join(require('os').tmpdir(), 'wn_bare_' + process.pid + '.json'),
      '--proxy-port', String(PROXY), '--ctrl-port', String(CTRL)], { cwd: SRC, stdio: 'ignore' });
    let up = false;
    for (let i = 0; i < 60; i++) { if (await probePort(CTRL)) { up = true; break; } await sleep(250); }
    check('外部实例已就绪（准备接管）', up === true);
    const r2 = await HOST.ensure(spec());
    check('ensure 接管已存在实例', r2.ok === true && r2.adopted === true, JSON.stringify(r2));
    const st4 = await HOST.call('/api/status');
    check('接管后接口可用', !!st4 && !!st4.version, 'version=' + (st4 && st4.version));
    const sd2 = HOST.stop();
    check('接管来的实例不被杀', sd2.stopped === false && sd2.adopted === true, JSON.stringify(sd2));
    check('接管实例仍在运行', (await probePort(CTRL)) === true);

    // 用户把自己开的 WeakNet 关掉：接管实例没有子进程 exit 事件，靠探活发现，
    // 发现后要像自有引擎退出一样走收尾（还原手机代理/系统代理）
    const exitsBefore = exits;
    const r4 = await HOST.ensure(spec());
    check('停止后可重新接管实例', r4.ok === true && r4.adopted === true, JSON.stringify(r4));
    bare.kill();
    let goneFired = false;
    for (let i = 0; i < 40; i++) {
      if (exits > exitsBefore) { goneFired = true; break; }
      await sleep(500);
    }
    check('接管实例消失后触发退出收尾',
      goneFired === true && HOST.isAlive() === false,
      'exits+' + (exits - exitsBefore) + ' alive=' + HOST.isAlive());

    // 旧版本 exe：不认 --headless 时要翻译成人话
    await sleep(300);
    const r3 = await HOST.ensure({ command: 'python',
      args: [path.join(SRC, 'weaknet_gui.py'), '--no-such-flag'], cwd: SRC, ctrlPort: CTRL });
    check('旧版本引擎报错可读', r3.ok === false && /版本过旧/.test(r3.reason || ''), r3.reason || '');
  } finally {
    try { if (bare && bare.exitCode === null) bare.kill(); } catch (_) {}
    HOST.stop();
    srv.close();
  }
  return exits;
}

function wiringPart() {
  const main = read('_client_src/app/main.js');
  const preload = read('_client_src/app/preload.js');
  const page = read('_client_src/app/renderer/weaknet-page.js');
  const tracker = read('_client_src/app/src/weaknet-tracker.js');
  const hostMod = read('_client_src/app/src/weaknet-host.js');

  check('main.js 用 host 拉起引擎', hasAll(main, ['weaknetHost.ensure(', 'weaknetLaunchSpec(']));
  check('main.js 提供 weaknet-api 转发', hasAll(main, ["ipcMain.handle('weaknet-api'", 'weaknetHost.call(']));
  check('main.js 退出前回收引擎', hasAll(main, ['weaknetHost.shutdown()']));
  check('接管手机前先确保引擎可用',
    /action === 'connect'[\s\S]{0,700}weaknetHost\.ensure\(weaknetLaunchSpec\(\)\)/.test(main),
    'main.js 接管分支需自行拉起引擎，不能要求用户先点别的按钮');
  check('main.js 把实际端口传给追踪', /weaknetTracker\.start\(\{[\s\S]{0,160}ctrlPort/.test(main),
    '需包含 ctrlPort');
  check('tracker 支持 ctrlPort 选项', /function start\(opts\)[\s\S]{0,400}opts\.ctrlPort/.test(tracker));

  check('preload 暴露 weaknetApi/退出事件', hasAll(preload,
    ['weaknetApi:', 'onWeaknetEngineExit', 'launchWeaknet:']));

  check('页面只走 perfAPI，不直接出网', !/\bfetch\s*\(/.test(page) && !/XMLHttpRequest/.test(page));
  const pages = ['index.html', 'iphone.html', 'iphone_gpu.html', 'pc.html'];
  const missing = pages.filter((f) => {
    const html = read(path.join('_client_src/app/renderer', f));
    return !hasAll(html, ['weaknet-page.js', 'weaknet-page.css', 'id="btn-weaknet"']);
  });
  check('四个平台页都挂了弱网页面', missing.length === 0, missing.join(',') || 'ok');

  const allowed = [...HOST.ALLOWED_PATHS];
  check('白名单含关键路由', hasAll(allowed.join(' '),
    ['/api/status', '/api/preset', '/api/profile', '/api/run', '/api/stop', '/api/scope',
      '/api/sysproxy', '/api/listen']));
  check('白名单含弱网组合路由', hasAll(allowed.join(' '),
    ['/api/combos', '/api/combo', '/api/combo/delete']));
  check('页面接了弱网组合（列表/保存/删除/上限）', hasAll(page,
    ['/api/combos', "'/api/combo'", "'/api/combo/delete'", 'MAX_COMBO_STEPS', 'c:']));
  check('白名单不含桌面端 501 路由', !allowed.includes('/api/vpn') && !allowed.includes('/api/float'));
  check('host 模块保留了 4 秒退出上限', /setTimeout\(r, 4000\)/.test(hostMod));
  check('already 接管时回探真实代理端口',
    /status === 'already'[\s\S]{0,400}await probe\(/.test(hostMod),
    '引擎只报 ctrl_port，代理端口不探就只能落到默认 8888');
  check('spawn 失败带上系统错误原文',
    /code === -1[\s\S]{0,120}exited\.signal/.test(hostMod),
    'exe 被杀软隔离/被删时不能只报「立即退出」');
}

/**
 * IPC 接线真跑：用一个假的 electron 模块加载真实的 main.js，直接调它注册的
 * weaknet-* handler。这样验证的是「页面 → preload → IPC → host → 引擎」整条链，
 * 而不只是 host 本身；不需要 Electron 运行时（本机也装不上，见发布说明）。
 */
async function ipcPart() {
  if (!SRC) {
    console.log('SKIP IPC 部分：未设置 PERFARA_WEAKNET_SRC');
    return;
  }
  process.env.PERFARA_WEAKNET_SRC = SRC;
  const Module = require('module');
  const handlers = {};
  const noop = () => {};
  const fake = {
    app: {
      isPackaged: false,
      whenReady: () => new Promise(() => {}),
      on: noop, quit: noop, exit: noop,
      getPath: () => require('os').tmpdir(),
      getAppPath: () => path.join(ROOT, '_client_src', 'app'),
      setAppUserModelId: noop,
      requestSingleInstanceLock: () => true,
      commandLine: { appendSwitch: noop },
    },
    BrowserWindow: class {
      static getAllWindows() { return []; }
      static fromWebContents() { return null; }
      constructor() {
        this.webContents = { on: noop, send: noop, session: { webRequest: { onBeforeRequest: noop } } };
      }
      loadFile() {} on() {} once() {} isDestroyed() { return true; }
      show() {} focus() {}
    },
    ipcMain: { handle: (n, fn) => { handlers[n] = fn; }, on: noop },
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    shell: { openExternal: noop, showItemInFolder: noop },
    Menu: { setApplicationMenu: noop, buildFromTemplate: () => ({}) },
    session: { defaultSession: { webRequest: { onBeforeRequest: noop } } },
    nativeTheme: { on: noop },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1280, height: 800 } }) },
  };
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return fake;
    return origLoad.apply(this, arguments);
  };

  let adopted = false;
  let prevLimit = null;
  try {
    require(path.join(ROOT, '_client_src', 'app', 'main.js'));
    const wn = ['weaknet-launch', 'weaknet-api', 'weaknet-engine-stop', 'weaknet-phone'];
    check('main.js 注册了 4 个弱网 IPC', wn.every((n) => typeof handlers[n] === 'function'),
      Object.keys(handlers).filter((k) => k.startsWith('weaknet')).join(','));

    const r = await handlers['weaknet-launch']({});
    check('IPC weaknet-launch 拉起引擎', r && r.ok === true, JSON.stringify(r));
    adopted = !!(r && r.adopted);
    // 接管的是用户自己开着的引擎：测试动过限速开关就要还回去，别给人留下一个「被限速」的状态
    if (adopted) {
      const s0 = await handlers['weaknet-api']({}, { path: '/api/status' });
      prevLimit = !!(s0 && s0.ok && s0.data && s0.data.limit_on);
    }

    const presets = await handlers['weaknet-api']({}, { path: '/api/presets' });
    check('IPC weaknet-api 返回场景', presets && presets.ok && presets.data.length === 17,
      'n=' + ((presets && presets.data) || []).length);

    const evil = await handlers['weaknet-api']({}, { path: 'http://example.com/' });
    check('IPC 白名单拒非法路径', evil && evil.ok === false && /不支持/.test(evil.reason || ''),
      evil && evil.reason);

    await handlers['weaknet-api']({}, { path: '/api/run', body: { enable: true } });
    const st = await handlers['weaknet-api']({}, { path: '/api/status' });
    check('经 IPC 开限速生效', st && st.ok && st.data.limit_on === true,
      'limit_on=' + (st && st.data && st.data.limit_on));

    const stop = await handlers['weaknet-engine-stop']({});
    check('IPC weaknet-engine-stop 正常返回', stop && stop.ok === true, JSON.stringify(stop));
    await sleep(1200);
    const after = await handlers['weaknet-api']({}, { path: '/api/status' });
    if (adopted) {
      check('接管来的引擎停后仍在跑（不动别人的进程）', after && after.ok === true);
    } else {
      check('IPC 停引擎后接口不可用', after && after.ok === false, after && after.reason);
    }

    // 引擎不在时点「接管」：主进程要自己把引擎拉起来，
    // 不能回一句「先点开启限速」把顺序问题甩给用户。
    // HOST.stop() 只清主进程手里的状态（接管来的外部实例不会被杀），正好造出「没引擎」的现场
    HOST.stop();
    const ph = await handlers['weaknet-phone']({}, { action: 'connect', deviceId: 'PERFARA_NO_SUCH' });
    check('接管手机时引擎不在会自动拉起', ph && ph.stage !== 'engine', JSON.stringify(ph));
    check('自动拉起后引擎可用', HOST.isAlive() === true, 'alive=' + HOST.isAlive());

    if (adopted && prevLimit === false) {
      await handlers['weaknet-api']({}, { path: '/api/run', body: { enable: false } });
      const off = await handlers['weaknet-api']({}, { path: '/api/status' });
      check('接管外部引擎后还原限速开关', !(off && off.data && off.data.limit_on),
        'limit_on=' + (off && off.data && off.data.limit_on));
    }
  } catch (e) {
    check('IPC 接线真跑', false, e.message);
  } finally {
    Module._load = origLoad;
    try { HOST.stop(); } catch (_) {}
    if (adopted && prevLimit === false && typeof handlers['weaknet-api'] === 'function') {
      try { await handlers['weaknet-api']({}, { path: '/api/run', body: { enable: false } }); } catch (_) {}
    }
    delete process.env.PERFARA_WEAKNET_SRC;
  }
}

(async () => {
  wiringPart();
  await realEnginePart();
  await ipcPart();
  const bad = checks.filter((c) => !c.ok);
  console.log('\n通过 ' + (checks.length - bad.length) + ' / ' + checks.length);
  if (bad.length) {
    console.log('失败：' + bad.map((b) => b.name).join(' ; '));
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
