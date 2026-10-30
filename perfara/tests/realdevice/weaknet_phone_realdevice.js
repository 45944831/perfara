'use strict';

/**
 * 真机专项：弱网页「开启限速」一键完成 引擎 → USB 接管手机 → 限速，以及停止/解除/退出清理。
 *
 * 验证的是打包态 collector（resources/app.asar）在真机上跑出的实际效果：
 *   - 手机系统代理与 adb reverse 隧道是否真的建立、解除后是否还原；
 *   - 限速对「经过手机隧道的流量」是否真的生效（手机侧 Chrome 下载落盘实测，不只看接口返回值）；
 *   - 停止限速是否保留接管、解除是否清干净、退出程序是否回收（含拔线守护）。
 *
 * 串号只从环境变量进，不写进文件：
 *   PERFARA_TEST_SERIAL=xxx PERFARA_RD_ROOT=<...>/collector node weaknet_phone_realdevice.js
 *
 * 前提：本机 8899 上已有用户自己开着的 WeakNet 时会被接管（按设计），测试结束会还原它的
 * 场景与限速开关；不会杀它，也不会改它的全局设置。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { chromium } = require('playwright-core');

const SERIAL = process.env.PERFARA_TEST_SERIAL || '';
const COLLECTOR = process.env.PERFARA_RD_ROOT ||
  'E:/WorkBuddy1/2026-10-19-13-59-27/release/交付_20261030/Perfara_Portable_20261030_r17/collector';
const CDP_PORT = Number(process.env.WN_CDP_PORT || 9343);
const ADB = process.env.ADB_BIN || 'adb';
const PHONE_PORT = 18888;
const OUT = process.env.RD_OUT || path.join(__dirname, '..', '_run_out', 'rd_phone');
const SHOTS = path.join(OUT, 'shots');
const BLOB_BYTES = 2 * 1024 * 1024;

const results = [];
const check = (name, ok, extra) => {
  results.push({ name, ok: !!ok, extra });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra !== undefined ? '  | ' + JSON.stringify(extra) : ''));
};
const note = (name, extra) => {
  results.push({ name, ok: true, note: true, extra });
  console.log('INFO  ' + name + (extra !== undefined ? '  | ' + JSON.stringify(extra) : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function adb(...args) {
  const r = spawnSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8', timeout: 60000 });
  return ((r.stdout || '') + (r.stderr || '')).trim();
}
// :0 是 Android 的「无代理」哨兵，和空值等价（app 的 _cleared 同样这么认）
const phoneProxy = () => {
  const v = adb('shell', 'settings', 'get', 'global', 'http_proxy').trim();
  return /^(|null|none|:0|0)$/i.test(v) ? '' : v;
};
const reverses = () => adb('reverse', '--list');

function clearPhoneProxy() {
  adb('shell', 'settings', 'put', 'global', 'http_proxy', ':0');
  adb('shell', 'settings', 'delete', 'global', 'http_proxy');
  adb('shell', 'settings', 'delete', 'global', 'global_http_proxy_host');
  adb('shell', 'settings', 'delete', 'global', 'global_http_proxy_port');
}
function removeReverse() {
  adb('reverse', '--remove', 'tcp:' + PHONE_PORT);
}

function httpJson(port, p, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port, path: p,
      method: payload ? 'POST' : 'GET',
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
      timeout: 5000,
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (payload) req.write(payload);
    req.end();
  });
}

/** PC 侧经引擎代理下载，返回字节数与耗时 */
function fetchViaProxy(proxyPort, url, timeout = 90000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port: proxyPort, path: url, method: 'GET' }, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; });
      res.on('end', () => resolve({ n, ms: Date.now() - t0, code: res.statusCode }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

/**
 * 手机侧经 USB 隧道下载。
 * 本机 ROM 的 toybox nc 不转发数据（连本机回环都发不出去），改用 Chrome 走系统代理：
 * 手机 → 127.0.0.1:18888（adb reverse）→ 本机引擎 8888 → 本机源站。
 * 计时看下载目录里文件的落盘大小，比等到“接口返回”更接近用户体感。
 *
 * Chrome 被系统回收后（或停在首启/崩溃恢复页）只发 VIEW intent 是不下载的，
 * 所以每次先把它拉到前台，第一次没动静再补发一次（换文件名，避开同名去重）。
 */
async function phoneDownload(baseUrl, name, timeoutMs = 40000) {
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  adb('shell', 'monkey', '-p', 'com.android.chrome', '-c', 'android.intent.category.LAUNCHER', '1');
  await sleep(2500);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const nm = attempt === 1 ? name : name + '-r' + attempt;
    const file = '/sdcard/Download/' + nm + '.bin';
    adb('shell', 'rm', '-f', file);
    const t0 = Date.now();
    adb('shell', 'am start -a android.intent.action.VIEW',
      '-d', '"' + baseUrl + '?n=' + nm + '"', 'com.android.chrome');
    let got = 0;
    while (Date.now() - t0 < timeoutMs) {
      const s = adb('shell', 'stat -c %s ' + file + ' 2>/dev/null');
      const m = /^(\d+)$/m.exec(s);
      if (m) {
        got = Number(m[1]);
        if (got >= BLOB_BYTES) break;
      }
      await sleep(300);
    }
    const ms = Date.now() - t0;
    adb('shell', 'rm', '-f', file);
    if (got >= BLOB_BYTES) return { ms, bytes: got, name: nm };
  }
  return { ms: 0, bytes: 0, name };
}

function waitFor(fn, ms, step = 400) {
  return new Promise(async (resolve) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await fn().catch(() => null);
      if (v) return resolve(v);
      await sleep(step);
    }
    resolve(null);
  });
}

function registryProxy() {
  const q = (v) => {
    const r = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', v],
      { encoding: 'utf8' });
    const m = /REG_\w+\s+(.+)/.exec(r.stdout || '');
    return m ? m[1].trim() : '';
  };
  return { enable: q('ProxyEnable'), server: q('ProxyServer') };
}

function collectorProcesses() {
  // 按本次用的采集端目录过滤，别把仓库里/别处的 Perfara.exe 也算成残留
  const tag = COLLECTOR.replace(/\\/g, '\\\\').replace(/'/g, "''");
  const ps = spawnSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='Perfara.exe'\" | "
    + `Where-Object { $_.ExecutablePath -like '${tag}*' } | Select-Object -ExpandProperty ProcessId`],
  { encoding: 'utf8' });
  return (ps.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** 截图前打码：串号、手机型号（下拉框显示的是桌面应用名/机型，可能含个人信息） */
async function maskSerial(page) {
  await page.evaluate((s) => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walk.nextNode()) nodes.push(walk.currentNode);
    nodes.forEach((n) => { n.nodeValue = n.nodeValue.split(s).join('••••••••'); });
    document.querySelectorAll('#wn-phone-dev option').forEach((o) => {
      if (o.value === s) o.textContent = '真机（型号已隐去）';
    });
  }, SERIAL).catch(() => {});
}

(async () => {
  if (!SERIAL) throw new Error('缺少 PERFARA_TEST_SERIAL');
  fs.mkdirSync(SHOTS, { recursive: true });
  const t0 = Date.now();

  // 本机 8899 上的引擎快照（多半是用户自己开着的 GUI 实例）
  const snap = await httpJson(8899, '/api/status');
  const baseline = {
    phoneProxy: phoneProxy(),
    reverse: reverses(),
    reg: registryProxy(),
    engine: snap ? { limit_on: !!snap.limit_on, preset_key: String(snap.preset_key || '') } : null,
  };
  check('真机已连接（读取系统代理成功）', baseline.phoneProxy !== undefined);
  check('测试开始前手机代理为空', baseline.phoneProxy === '', baseline.phoneProxy || '(空)');
  check('测试开始前没有 18888 映射', !/:18888/.test(baseline.reverse), baseline.reverse || '(空)');
  note('本机 8899 引擎快照（结束后还原）', baseline.engine);

  // 本机 HTTP 源站：引擎（在本机）去取它，手机经隧道让引擎代取。
  // 手机那侧要用本机局域网 IP 当 URL：手机自己的 Wi-Fi 在另一个网段，根本到不了这个 IP，
  // 所以它还能下载成功就只能是走了 USB 反向隧道 → 本机引擎。
  const blob = crypto.randomBytes(BLOB_BYTES);
  const hits = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://local');
    const name = String(u.searchParams.get('n') || 'blob').replace(/[^A-Za-z0-9_-]/g, '');
    hits.push({ name, from: (req.socket.remoteAddress || '').replace(/^::ffff:/, ''), t: Date.now() });
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': blob.length,
      'Cache-Control': 'no-store',
      'Content-Disposition': 'attachment; filename="' + name + '.bin"',
    });
    res.end(blob);
  });
  await new Promise((r) => srv.listen(0, '0.0.0.0', r));
  const lanIp = (snap && snap.lan_ip) || (Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)[0] || {}).address;
  const blobUrl = 'http://127.0.0.1:' + srv.address().port + '/blob.bin';
  const blobUrlLan = 'http://' + lanIp + ':' + srv.address().port + '/blob.bin';
  note('本机源站地址（手机侧用它）', blobUrlLan);

  // 打包态采集端（临时配置目录，避免碰用户的采集历史）
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara-rd-'));
  const appEnv = { ...process.env };
  delete appEnv.ELECTRON_RUN_AS_NODE;
  appEnv.APPDATA = path.join(profile, 'appdata');
  appEnv.LOCALAPPDATA = path.join(profile, 'local');
  fs.mkdirSync(appEnv.APPDATA, { recursive: true });
  fs.mkdirSync(appEnv.LOCALAPPDATA, { recursive: true });
  const app = spawn(path.join(COLLECTOR, 'Perfara.exe'),
    ['--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + path.join(profile, 'userdata')],
    { cwd: COLLECTOR, env: appEnv, stdio: ['ignore', 'ignore', 'ignore'] });
  let appExit = null;
  app.on('exit', (code, sig) => { appExit = { code, sig }; });

  let browser = null;
  let page = null;
  const pageErrors = [];
  let phoneHeld = false;

  const api = (p, body) => page.evaluate(([q, b]) => window.perfAPI.weaknetApi(q, b), [p, body])
    .then((r) => { if (!r || !r.ok) throw new Error((r && r.reason) || '引擎未响应'); return r.data; });
  const phoneStatus = () => page.evaluate((s) => window.perfAPI.weaknetPhone({ action: 'status', deviceId: s }), SERIAL);

  try {
    const connected = await waitFor(async () => {
      if (appExit) throw new Error('采集端启动后立即退出：' + JSON.stringify(appExit));
      try {
        const b = await chromium.connectOverCDP('http://127.0.0.1:' + CDP_PORT);
        const ctx = b.contexts()[0];
        const p = ctx && ctx.pages().find((x) => /index\.html/.test(x.url()));
        if (p) { browser = b; page = p; return true; }
      } catch (_) {}
      return false;
    }, 40000, 700);
    check('打包态采集窗口已启动（app.asar）', !!connected,
      page && decodeURI(page.url().split('/app.asar/')[1] || ''));
    if (!page) throw new Error('未能连上采集窗口');
    page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));
    await page.bringToFront().catch(() => {});

    // ── 1. 打开弱网二级页，确认引擎可用、设备已识别 ─────────────────────────
    await page.click('#btn-weaknet');
    await page.waitForSelector('#wn-run', { state: 'visible', timeout: 20000 });
    const st0 = await waitFor(async () => { const s = await api('/api/status'); return s && s.version ? s : null; }, 45000, 800);
    check('弱网引擎就绪', !!st0 && /^1\.1\./.test(st0.version), st0 && st0.version);
    const devReady = await waitFor(() => page.waitForFunction((s) => Array.from(
      document.querySelectorAll('#wn-phone-dev option')).some((o) => o.value === s), SERIAL, { timeout: 3000 })
      .then(() => true).catch(() => false), 40000, 800);
    check('弱网页设备下拉里识别到真机', !!devReady);
    await page.evaluate((s) => {
      const sel = document.getElementById('wn-phone-dev');
      sel.value = s;
      sel.dispatchEvent(new Event('change'));
    }, SERIAL);
    await sleep(800);
    check('接管前手机代理仍为空', phoneProxy() === '', phoneProxy() || '(空)');

    // ── 2. 一键：拉起/接管引擎 → USB 接管手机 → 开限速 ───────────────────────
    await page.click('#wn-run');
    const lim = await waitFor(async () => { const s = await api('/api/status'); return s && s.limit_on ? s : null; }, 40000, 500);
    check('一次点击完成「接管 + 开限速」', !!lim,
      lim ? { scene: lim.profile && lim.profile.name, preset: lim.preset_key } : null);
    const proxyNow = phoneProxy();
    check('手机系统代理已指向本机引擎', proxyNow === '127.0.0.1:' + PHONE_PORT, proxyNow || '(空)');
    const rev = reverses();
    check('adb reverse 隧道已建立', new RegExp('tcp:' + PHONE_PORT + '\\s+tcp:\\d+').test(rev), rev || '(空)');
    phoneHeld = proxyNow === '127.0.0.1:' + PHONE_PORT;
    const dom = await page.evaluate(() => ({
      state: (document.getElementById('wn-phone-state') || {}).textContent || '',
      run: (document.getElementById('wn-run') || {}).textContent || '',
      pill: (document.getElementById('wn-pill') || {}).textContent || '',
    }));
    check('页面显示已接管并处于限速中',
      /127\.0\.0\.1:\d+/.test(dom.state) && /停止限速/.test(dom.run) && /限速中/.test(dom.pill), dom);
    const st1 = await phoneStatus().catch(() => null);
    check('拔线守护已安装（watch）', !!(st1 && st1.watch), st1 && { watch: st1.watch, held: st1.held, ours: st1.ours });
    const watchOnPhone = adb('shell', 'test -f /data/local/tmp/perfara_proxy_watch.sh && echo yes');
    check('手机侧守护脚本已落盘', /yes/.test(watchOnPhone), watchOnPhone);
    await maskSerial(page);
    await page.screenshot({ path: path.join(SHOTS, 'rd-phone-01-on.png') });

    // ── 3. 限速实测：本机代理 + 手机隧道 ────────────────────────────────────
    // 引擎只换场景时不一定开限速，两步都显式下发：direct+limit_on 是不限速基线
    const proxyPort = Number((await api('/api/status')).listen.port) || 8888;
    await api('/api/preset', { key: 'direct' });
    await api('/api/run', { enable: true });
    await sleep(600);
    const pcDirect = await fetchViaProxy(proxyPort, blobUrl);
    await api('/api/preset', { key: '4g_weak' });
    await api('/api/run', { enable: true });
    await sleep(600);
    const pcWeak = await fetchViaProxy(proxyPort, blobUrl);
    check('本机经代理：限速后耗时 ≥3 倍', pcDirect.n > BLOB_BYTES * 0.9 && pcWeak.n === pcDirect.n
      && pcWeak.ms > pcDirect.ms * 3, { direct: pcDirect.ms + 'ms', weak: pcWeak.ms + 'ms' });

    // 手机那一半：Chrome 走系统代理下载本机源站，按落盘计时
    await api('/api/preset', { key: 'direct' });
    await api('/api/run', { enable: true });
    await sleep(800);
    const phDirect = await phoneDownload(blobUrlLan, 'rd-phone-direct');
    await api('/api/preset', { key: '4g_weak' });
    await api('/api/run', { enable: true });
    await sleep(800);
    const phWeak = await phoneDownload(blobUrlLan, 'rd-phone-weak');
    check('手机经 USB 隧道取到完整数据', phDirect.bytes >= BLOB_BYTES && phWeak.bytes >= BLOB_BYTES,
      { direct: phDirect.bytes + 'B', weak: phWeak.bytes + 'B' });
    check('手机侧流量确实被限速（≥3 倍）', phDirect.ms > 0 && phWeak.ms > phDirect.ms * 3,
      { direct: phDirect.ms + 'ms', weak: phWeak.ms + 'ms' });
    // 手机 Wi-Fi 在别的网段（172.16.x），到不了本机 192.168.x：能下到就只能是走的隧道
    const viaEngine = hits.filter((h) => h.from === lanIp && /^rd-phone-(direct|weak)/.test(h.name)).map((h) => h.name);
    check('手机请求确实经本机引擎代理（源站只见到本机出口）',
      viaEngine.some((n) => n.startsWith('rd-phone-direct')) && viaEngine.some((n) => n.startsWith('rd-phone-weak')),
      { lanIp, hits: hits.map((h) => h.name + '@' + h.from) });
    const limNow = await api('/api/status');
    check('限速中场景为 4G 弱网', limNow.limit_on === true && /4G 弱网/.test((limNow.profile || {}).name || ''),
      (limNow.profile || {}).name);
    await maskSerial(page);
    await page.screenshot({ path: path.join(SHOTS, 'rd-phone-02-throttled.png') }).catch(() => {});

    // ── 4. 停止限速：接管保留 ──────────────────────────────────────────────
    await page.click('#wn-run');
    const off = await waitFor(async () => { const s = await api('/api/status'); return s && s.limit_on === false ? s : null; }, 20000, 500);
    check('停止限速生效', !!off);
    check('停止限速后手机接管仍保留（按设计）', phoneProxy() === '127.0.0.1:' + PHONE_PORT, phoneProxy());

    // ── 5. 解除接管：代理与隧道都还原 ───────────────────────────────────────
    await page.click('#wn-phone');
    const released = await waitFor(() => page.waitForFunction(
      () => /未接管/.test((document.getElementById('wn-phone-state') || {}).textContent || ''),
      null, { timeout: 3000 }).then(() => true).catch(() => false), 25000, 700);
    check('解除接管成功', !!released);
    const proxyAfter = phoneProxy();
    check('解除后手机系统代理还原', proxyAfter === '', proxyAfter || '(空)');
    const revAfter = reverses();
    check('解除后 18888 映射已撤掉', !/:18888/.test(revAfter), revAfter || '(空)');
    phoneHeld = false;

    // ── 6. 引擎已在跑时直接接管（不需要先开限速） ───────────────────────────
    await page.click('#wn-phone');
    const held2 = await waitFor(async () => {
      const s = await phoneStatus().catch(() => null);
      return s && s.ok && s.ours && s.held && s.watch ? s : null;
    }, 30000, 600);
    check('引擎已在跑时可直接接管（无需先开限速）', !!held2, held2 && { ours: held2.ours, held: held2.held, watch: held2.watch });
    // 页面对「刚接管」的设计是顺手把限速打开（否则手机流量等于直通），场景沿用当前选择
    const limitWhileHeld = await api('/api/status');
    check('接管后限速保持开启、场景不变（按设计顺手打开）',
      limitWhileHeld.limit_on === true && limitWhileHeld.preset_key === '4g_weak',
      { limit_on: limitWhileHeld.limit_on, preset: limitWhileHeld.preset_key });
    phoneHeld = phoneProxy() === '127.0.0.1:' + PHONE_PORT;
    await maskSerial(page);
    await page.screenshot({ path: path.join(SHOTS, 'rd-phone-03-held.png') }).catch(() => {});
    await sleep(1200);   // 账本与守护都落定后再关窗，避免把「接管还在进行」误判成「退出不回收」

    // ── 7. 接管状态下退出程序：手机代理与隧道都要回收 ───────────────────────
    await page.evaluate(() => window.close()).catch(() => {});
    const exited = await waitFor(async () => appExit, 25000, 500);
    check('关闭窗口后程序退出', !!exited, exited || null);
    await sleep(2500);
    const proxyOnExit = phoneProxy();
    check('退出后手机系统代理已还原', proxyOnExit === '', proxyOnExit || '(空)');
    const revOnExit = reverses();
    check('退出后 18888 映射已撤掉', !/:18888/.test(revOnExit), revOnExit || '(空)');
    phoneHeld = proxyOnExit === '127.0.0.1:' + PHONE_PORT;
    check('退出后没有残留采集进程', collectorProcesses().length === 0, collectorProcesses());
    const engineAlive = await httpJson(8899, '/api/status');
    check('接管来的引擎没有被误杀', !!engineAlive && !!engineAlive.version, engineAlive && engineAlive.version);

    // ── 7b. 接管刚点下就关窗：半途退出同样不能把手机留在代理里 ──────────────
    {
      const profile2 = fs.mkdtempSync(path.join(os.tmpdir(), 'perfara-rd2-'));
      const env2 = { ...process.env };
      delete env2.ELECTRON_RUN_AS_NODE;
      env2.APPDATA = path.join(profile2, 'appdata');
      env2.LOCALAPPDATA = path.join(profile2, 'local');
      fs.mkdirSync(env2.APPDATA, { recursive: true });
      fs.mkdirSync(env2.LOCALAPPDATA, { recursive: true });
      const app2 = spawn(path.join(COLLECTOR, 'Perfara.exe'),
        ['--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + path.join(profile2, 'userdata')],
        { cwd: COLLECTOR, env: env2, stdio: ['ignore', 'ignore', 'ignore'] });
      let exit2 = null;
      app2.on('exit', (code, sig) => { exit2 = { code, sig }; });
      try {
        const p2 = await waitFor(async () => {
          try {
            const b2 = await chromium.connectOverCDP('http://127.0.0.1:' + CDP_PORT);
            const p = b2.contexts()[0].pages().find((x) => /index\.html/.test(x.url()));
            if (!p) return null;
            await p.waitForSelector('#btn-weaknet', { state: 'visible', timeout: 15000 }).catch(() => {});
            await p.click('#btn-weaknet');
            await p.waitForSelector('#wn-phone', { state: 'visible', timeout: 20000 });
            return p;
          } catch (_) { return null; }
        }, 60000, 900);
        check('第二个实例重新拉起（半途退出场景）', !!p2);
        if (p2) {
          // 引擎就绪后点「接管」，立刻关窗——此时 connect 还在 adb 往返里
          await p2.evaluate(async (s) => {
            const sel = document.getElementById('wn-phone-dev');
            if (sel && !Array.from(sel.options).some((o) => o.value === s)) {
              await new Promise((r) => setTimeout(r, 1500));
            }
            if (sel && Array.from(sel.options).some((o) => o.value === s)) {
              sel.value = s;
              sel.dispatchEvent(new Event('change'));
            }
          }, SERIAL).catch(() => {});
          await sleep(500);
          await p2.evaluate(() => {
            const b = document.getElementById('wn-phone');
            if (b) b.click();
            setTimeout(() => window.close(), 300);
          }).catch(() => {});
          const exitOk = await waitFor(async () => exit2, 30000, 500);
          check('半途关窗后程序退出', !!exitOk, exitOk || null);
          await sleep(2500);
          const proxyMid = phoneProxy();
          check('半途退出后手机系统代理已还原', proxyMid === '', proxyMid || '(空)');
          const revMid = reverses();
          check('半途退出后 18888 映射已撤掉', !/:18888/.test(revMid), revMid || '(空)');
          phoneHeld = proxyMid === '127.0.0.1:' + PHONE_PORT;
        }
      } finally {
        try { if (!exit2) app2.kill(); } catch (_) {}
        if (!exit2) await sleep(1500);
        try { fs.rmSync(profile2, { recursive: true, force: true }); } catch (_) {}
      }
    }

    // ── 8. 还原用户引擎状态与全局设置 ───────────────────────────────────────
    if (baseline.engine) {
      if (baseline.engine.preset_key) await httpJson(8899, '/api/preset', { key: baseline.engine.preset_key });
      await httpJson(8899, '/api/run', { enable: !!baseline.engine.limit_on });
    }
    const engineBack = await httpJson(8899, '/api/status');
    check('用户引擎场景/限速已还原',
      !!engineBack && engineBack.preset_key === (baseline.engine || {}).preset_key
      && !!engineBack.limit_on === !!(baseline.engine || {}).limit_on,
      engineBack && { preset: engineBack.preset_key, limit_on: engineBack.limit_on });
    const regAfter = registryProxy();
    check('系统代理设置未被改动', regAfter.enable === baseline.reg.enable && regAfter.server === baseline.reg.server,
      { before: baseline.reg, after: regAfter });
    check('页面无 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3));
  } finally {
    // 不论成败都把手机与引擎恢复原样，别把用户手机留在代理里
    try {
      if (phoneHeld || /^127\.0\.0\.1:18888$/.test(phoneProxy())) {
        clearPhoneProxy();
        removeReverse();
      }
    } catch (_) {}
    try { if (baseline.engine && !appExit) {
      await httpJson(8899, '/api/preset', { key: baseline.engine.preset_key });
      await httpJson(8899, '/api/run', { enable: !!baseline.engine.limit_on });
    } } catch (_) {}
    try { if (browser) await browser.close().catch(() => {}); } catch (_) {}
    try { if (!appExit) app.kill(); } catch (_) {}
    try { srv.close(); } catch (_) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  const summary = {
    timer: Math.round((Date.now() - t0) / 1000) + 's',
    pass, fail,
    results,
    baseline,
  };
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\n===== 真机接管专项: ${pass} PASS / ${fail} FAIL (${summary.timer}) =====`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('FATAL ' + ((e && e.stack) || e));
  const pass = results.filter((r) => r.ok).length;
  try { fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ pass, fail: results.length - pass, results, fatal: String(e && e.message || e) }, null, 2)); } catch (_) {}
  console.log(`===== 中断：${pass} PASS / ${results.length - pass} FAIL =====`);
  process.exit(2);
});
