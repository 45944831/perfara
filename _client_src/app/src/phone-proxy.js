'use strict';

/**
 * 手机（USB）弱网接管。
 *
 * 只用 adb，手机端不装任何东西：
 *   adb reverse tcp:18888 tcp:8888    手机 127.0.0.1:18888 → 本机 127.0.0.1:8888
 *   settings put global http_proxy 127.0.0.1:18888
 * 之后手机走系统代理的流量经 USB 进到本机 WeakNet 代理，由它按场景限速。
 *
 * 两条边界，界面上必须说清楚，不然会被当成「工具坏了」：
 *   - 只有读系统代理的程序会被接管（okhttp/HttpURLConnection/WebView 等）；
 *     自己开 TCP/UDP 的程序（多数手游）不读系统代理，USB 代理管不到它们。
 *   - 部分 ROM 禁止 adb 写 settings（ColorOS 报 WRITE_SECURE_SETTINGS），
 *     需要在开发者选项里放开「禁止权限监控 / USB 调试（安全设置）」。
 *
 * 手机原有的系统代理（公司 Wi-Fi 之类）是别人的配置：接管时记下、解除时写回；
 * 代理不是本工具写的就不碰，只撤自己的端口映射。
 *
 * 拔线残留（本模块最关键的一条约束）：系统代理写在手机设置里，拔线、重启都不消失；
 * 而 adb reverse 只活在 adb 传输会话上，拔线即消失。两者一错位，手机就把所有
 * HTTP(S) 发给一个没人监听的 127.0.0.1 端口——看起来就是「拔了线还在断网」。
 * 拔线后电脑侧已经没有 adb 通道，清不了，所以接管成功后在手机上起一个守护脚本，
 * 由它发现反向监听消失后自行撤掉全局代理（脚本做法与 WeakNet 自带 usb_phone.py 一致）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const ADB = require('./adb');

const DEFAULT_PROXY_PORT = 8888;
/**
 * 手机侧监听端口。不能用 8888：手机上跑的代理（含 WeakNet APK）默认就占 8888，
 * adb reverse 会和它抢同一个地址，映射直接建不起来。
 */
const PHONE_PORT = 18888;
/** 老版本/部分 ROM 会优先读兼容字段，留着会和 http_proxy 打架 */
const LEGACY_KEYS = ['global_http_proxy_host', 'global_http_proxy_port'];
const SAFE_DEVICE = /^[A-Za-z0-9._:-]{1,80}$/;

/** 手机侧守护：拔线后自己把代理撤掉，避免「拔了线还断网」 */
const WATCH_PATH = '/data/local/tmp/perfara_proxy_watch.sh';
const WATCH_PID = '/data/local/tmp/perfara_proxy_watch.pid';
const WATCH_LOG = '/data/local/tmp/perfara_proxy_watch.log';

const PERM_HINT = '这台手机限制了 adb 写系统设置。请到「开发者选项」打开'
  + '「禁止权限监控」或「USB 调试（安全设置）」（不同厂商叫法不同，两个都没有就说明不支持）后重试。';
/**
 * 自动还原失败时手把手告诉用户怎么清。必须是「写 :0」而不是「delete」：
 * delete 只清全局那一行，MIUI 会把代理镜像进当前 Wi-Fi 的网络配置，
 * 清完照样把所有流量发给死端口（WeakNet v1.1.11/1.1.12 真机复核过）。
 */
const MANUAL_HINT = '也可以手动清：手机「设置 → WLAN → 代理」改成「无」，'
  + '或在命令行执行 adb shell settings put global http_proxy :0。';

/** 测试注入用：默认就是真 adb，单测换成假执行器，不起真进程 */
let _exec = ADB;

let _held = new Map();   // deviceId -> { phonePort, pcPort }，只记我们下发的，退出时要还原

/**
 * 接管/解除串行化。一次接管是好几趟 adb（reverse → 代理 → 守护），中途用户直接关窗时，
 * 退出清理如果和还在飞的 connect 并发跑，账本还是空的 —— 清理什么都没做，
 * connect 随后又把代理/映射写上，手机就留在「指着没人监听的端口」的状态。
 * 退出清理排在队列末尾，等手上这一步落定（此时账本已写好）再动手。
 */
let _queue = Promise.resolve();
function _enqueue(fn) {
  const run = _queue.then(() => fn());
  _queue = run.then(() => {}, () => {});
  return run;
}

/** adb 的报错是「Java 异常 + 一长串 at ...」，只留最有信息量的那一行 */
function _short(e) {
  const text = String((e && e.message) || e || '');
  const lines = text.split(/\r?\n/).map((x) => x.trim())
    .filter((x) => x && !/^at\s/.test(x));
  const pick = lines.find((l) => /SecurityException|Permission denial|error:/i.test(l))
    || lines[0] || '';
  return pick.replace(/\s+/g, ' ').slice(0, 160);
}

function _badDevice(deviceId) {
  if (!deviceId) return '没有选择手机';
  if (!SAFE_DEVICE.test(deviceId)) return '设备序列号不合法';
  return '';
}

function _normPort(v) {
  const n = Number(v);
  return (n > 0 && n < 65536) ? Math.trunc(n) : 0;
}

/** 手机侧端口直接决定代理字符串，只接受本机回环地址的写法 */
function _proxyOf(phonePort) {
  return '127.0.0.1:' + phonePort;
}

function _isPermissionError(text) {
  return /WRITE_SECURE_SETTINGS|SecurityException|Permission denial/i.test(String(text || ''));
}

function _cleared(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  // :0 是 Android 的无代理哨兵（MIUI 清网络镜像代理时也写它），等同「没有代理」
  return v === '' || v === 'null' || v === 'none' || v === ':0' || v === '0';
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 手机侧守护脚本。每 2 秒看一次 18888 是否还在监听，连续两次都看不到（拔线 / adb 断开）
 * 就先写 :0（触发 MIUI 把 Wi-Fi 网络配置里镜像的那份代理一起清掉）再删残留字段；
 * 删之前先读设置，值已被别人改过就退出，不跟别的工具抢。
 * 只能由电脑端在接管后推送并启动，参数：<端口> <端口十六进制>。
 */
function _watchScript() {
  return [
    '#!/system/bin/sh',
    '# Perfara USB 弱网守护：反向监听消失后自动撤掉全局代理。勿手工修改。',
    'PORT="$1"',
    'HEX="$2"',
    'EXPECT="127.0.0.1:$PORT"',
    'PIDF="' + WATCH_PID + '"',
    'LOG="' + WATCH_LOG + '"',
    '',
    'echo "start $(date) pid=$$ expect=$EXPECT" >"$LOG"',
    'echo $$ >"$PIDF"',
    '',
    '# 没有 awk 就判断不了监听，宁可不清理也不能误清（那会把限速打断）',
    'if ! command -v awk >/dev/null 2>&1; then',
    '    echo "no awk, 跳过自动清理 $(date)" >>"$LOG"',
    '    rm -f "$PIDF"',
    '    exit 0',
    'fi',
    '',
    'listening() {',
    '    awk -v p=":$HEX" \'$2 ~ p"$" && $4 == "0A" {f=1} END {exit !f}\' /proc/net/tcp /proc/net/tcp6 2>/dev/null',
    '}',
    '',
    'i=0',
    'while [ "$i" -lt 43200 ]; do',
    '    i=$((i + 1))',
    '    sleep 2',
    '    listening && continue',
    '    sleep 2',
    '    listening && continue',
    '    v=$(settings get global http_proxy 2>/dev/null)',
    '    if [ "$v" != "$EXPECT" ]; then',
    '        echo "proxy 已是 [$v]，不接管 $(date)" >>"$LOG"',
    '        break',
    '    fi',
    '    settings put global http_proxy :0 >/dev/null 2>&1',
    '    settings delete global global_http_proxy_host >/dev/null 2>&1',
    '    settings delete global global_http_proxy_port >/dev/null 2>&1',
    '    settings delete global http_proxy >/dev/null 2>&1',
    '    echo "反向监听消失，已清除全局代理 $(date)" >>"$LOG"',
    '    break',
    'done',
    'rm -f "$PIDF"',
    '',
  ].join('\n');
}

/** 收掉手机上的守护；失败只返回原因，调用方在清理路径上，不抛 */
async function _stopWatch(deviceId) {
  const cmd = 'p=$(cat ' + WATCH_PID + ' 2>/dev/null); '
    + 'if [ -n "$p" ] && grep -q perfara_proxy_watch /proc/$p/cmdline 2>/dev/null; '
    + 'then kill $p 2>/dev/null; fi; rm -f ' + WATCH_PID + ' ' + WATCH_PATH;
  try { await _exec.shell(deviceId, cmd); return { ok: true }; }
  catch (e) { return { ok: false, msg: _short(e) }; }
}

/**
 * 在手机上启动守护。装不上不影响代理本身，只是拔线后不会自愈，
 * 所以失败按「警告」返回，由界面提示用户先点「解除」再拔线。
 */
async function _startWatch(deviceId, phonePort) {
  if (typeof _exec.pushFile !== 'function') {
    return { ok: false, msg: '当前执行器不支持文件推送' };
  }
  await _stopWatch(deviceId);
  let tmp = '';
  try {
    tmp = path.join(os.tmpdir(), `perfara-proxy-watch-${process.pid}.sh`);
    fs.writeFileSync(tmp, _watchScript(), 'utf8');     // Node 不做换行转换，脚本是纯 LF
    await _exec.pushFile(deviceId, tmp, WATCH_PATH);
    await _exec.shell(deviceId, 'chmod 755 ' + WATCH_PATH);
    const hex = ('0000' + phonePort.toString(16).toUpperCase()).slice(-4);
    // setsid 另起会话：拔线时 adb 传输断开会把命令会话里的进程带走，nohup 只挡
    // SIGHUP、实测照样会死；setsid 起的新会话没有控制终端，能活到发现监听消失
    const launch = 'if command -v setsid >/dev/null 2>&1; then '
      + `setsid sh ${WATCH_PATH} ${phonePort} ${hex} </dev/null >/dev/null 2>&1 & `
      + `else nohup sh ${WATCH_PATH} ${phonePort} ${hex} </dev/null >/dev/null 2>&1 & fi`;
    await _exec.shell(deviceId, launch);

    // 回读 pid 并确认进程还活着：adb 返回 0 不代表后台进程没被立刻回收
    for (let i = 0; i < 10; i += 1) {
      await _sleep(200);
      let pid = '';
      try { pid = String(await _exec.shell(deviceId, 'cat ' + WATCH_PID)).trim(); } catch (_) {}
      if (!/^\d+$/.test(pid)) continue;
      try {
        await _exec.shell(deviceId, 'kill -0 ' + pid);
        return { ok: true, pid: Number(pid) };
      } catch (_) {
        return { ok: false, msg: '守护进程启动后立即退出（日志：' + WATCH_LOG + '）' };
      }
    }
    return { ok: false, msg: '守护进程未启动' };
  } catch (e) {
    return { ok: false, msg: _short(e) };
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch (_) {} }
  }
}

async function _getProxy(deviceId) {
  const out = await _exec.shell(deviceId, 'settings get global http_proxy');
  return String(out == null ? '' : out).trim();
}

/** 读手机当前代理与反向映射，页面打开时用它显示真实状态 */
async function status(deviceId) {
  const bad = _badDevice(deviceId);
  if (bad) return { ok: false, stage: 'device', msg: bad };
  let proxy = '';
  let lines = [];
  try { proxy = await _getProxy(deviceId); } catch (e) {
    return { ok: false, stage: 'settings', msg: '读取手机代理失败：' + _short(e) };
  }
  try { lines = await _exec.listReverses(deviceId); } catch (_) {}
  const rec = _held.get(deviceId);
  const cur = _cleared(proxy) ? '' : proxy;
  return {
    ok: true,
    deviceId,
    proxy: cur,
    // 只有指向本工具端口（18888/本次下发的端口）才算接管成功；
    // 手机原本就配着别的代理时不能当成「已接管」，更不能一键解除把人家配置删了
    ours: _isOurs(cur, rec ? rec.phonePort : PHONE_PORT),
    port: rec ? rec.phonePort : 0,
    held: !!rec,
    watch: !!(rec && rec.watch),
    // 账本里另外几台：下拉框切走之后，接管/解除都要把它们一起收掉
    heldOthers: Array.from(_held.keys()).filter((id) => id !== deviceId),
    reverse: lines.filter((l) => /tcp:\d+/.test(l)),
  };
}

/** 判断手机当前代理是不是本工具下发的 */
function _isOurs(proxy, phonePort) {
  const m = /^127\.0\.0\.1:(\d+)$/.exec(String(proxy || ''));
  if (!m) return false;
  const p = Number(m[1]);
  return p === PHONE_PORT || (!!phonePort && p === phonePort);
}

/**
 * 接管：建反向映射 → 写系统代理 → 回读校验。
 * 失败按阶段返回 stage，页面照原文提示，不做「大概成功了」的猜测。
 */
async function connectInner(opts) {
  const deviceId = String((opts && opts.deviceId) || '');
  const pcPort = _normPort(opts && opts.proxyPort) || DEFAULT_PROXY_PORT;
  const phonePort = _normPort(opts && opts.phonePort) || PHONE_PORT;
  const bad = _badDevice(deviceId);
  if (bad) return { ok: false, stage: 'device', msg: bad };

  // 0) 换机 / 换端口 / 重连之前，先把账本里的接管全部还原。账本记的是「已接管的那台」，
  //    不是界面下拉框当前选中的那台；旧机、旧端口的 reverse 映射不还原就会留到拔线为止。
  //    还原后手机代理回到接管前原值，下面第 2 步读到的就是真正的原值（不会把自己的
  //    127.0.0.1 当成用户原代理、把公司的代理丢掉）。
  const restored = [];
  for (const [heldId, heldRec] of Array.from(_held.entries())) {
    let r;
    try { r = await disconnectInner({ deviceId: heldId, phonePort: heldRec.phonePort }); }
    catch (e) { r = { ok: false, msg: _short(e) }; }
    restored.push({ deviceId: heldId, ok: !!r.ok, msg: r.msg || '', hint: r.hint || '' });
  }

  // 1) 反向映射。先删后建：上次异常退出可能留着一条指向已关闭端口的旧映射
  try { await _exec.removeReverse(deviceId, phonePort); } catch (_) {}
  try {
    await _exec.reverseTcp(deviceId, phonePort, pcPort);
  } catch (e) {
    const text = _short(e);
    const busy = /address already in use/i.test(text);
    return {
      ok: false, stage: 'reverse', msg: '建立 USB 端口映射失败：' + text,
      // 手机侧这个端口被别人占着是另一回事：映射建不起来，跟权限无关
      hint: busy
        ? `手机上的 ${phonePort} 端口已被占用（多半是手机上前台开着的代理 App 正监听它），先停掉它再重试。`
        : '',
      restored,
    };
  }
  try {
    const lines = await _exec.listReverses(deviceId);
    if (lines.length && !lines.some((l) => l.includes('tcp:' + phonePort))) {
      return { ok: false, stage: 'reverse', msg: `端口映射未生效（reverse --list 里查不到 tcp:${phonePort}）`, restored };
    }
  } catch (_) {}

  // 2) 写系统代理。先记下手机原有的值：可能是公司 Wi-Fi 的代理，
  //    解除时按原样写回，不能直接删掉
  const proxy = _proxyOf(phonePort);
  let prev = '';
  try {
    const before = await _getProxy(deviceId);
    if (!_cleared(before) && !_isOurs(before, phonePort)) prev = before;
  } catch (_) {}
  const rollback = async () => { try { await _exec.removeReverse(deviceId, phonePort); } catch (_) {} };
  // 账本先落位：映射已经建好，后面还有写代理、装守护几趟 adb。中途程序被关掉时，
  // 退出清理要能按这条记录把映射和代理都撤掉，而不是因为账本还空着就什么都不做。
  _held.set(deviceId, { phonePort, pcPort, prev, watch: false });
  for (const k of LEGACY_KEYS) {
    try { await _exec.shell(deviceId, 'settings delete global ' + k); } catch (_) {}
  }
  try {
    await _exec.shell(deviceId, 'settings put global http_proxy ' + proxy);
  } catch (e) {
    const text = _short(e);
    const perm = _isPermissionError(text);
    await rollback();          // 没写成代理，映射留着也没人用，顺手撤掉
    _held.delete(deviceId);
    return {
      ok: false,
      stage: perm ? 'permission' : 'settings',
      msg: perm ? '手机拒绝了写入系统代理（ROM 权限限制）' : '写入系统代理失败：' + text,
      hint: perm ? PERM_HINT : '',
      restored,
    };
  }

  // 3) 回读：写进去但读回来不是它，等于没生效
  let got = '';
  try { got = await _getProxy(deviceId); } catch (_) {}
  if (got !== proxy) {
    await rollback();
    _held.delete(deviceId);
    return {
      ok: false,
      stage: 'verify',
      msg: '回读校验失败（期望 ' + proxy + '，实际 ' + (got || '空') + '）',
      hint: PERM_HINT,
      restored,
    };
  }

  // 4) 手机上起守护：拔线后反向映射消失，由它把全局代理撤掉
  const watch = await _startWatch(deviceId, phonePort);

  _held.set(deviceId, { phonePort, pcPort, prev, watch: !!watch.ok });
  return {
    ok: true, deviceId, port: phonePort, proxy, restoredOnRelease: prev,
    watch: !!watch.ok, watch_msg: watch.ok ? '' : (watch.msg || '守护未安装'),
    restored,
  };
}

/** 解除：还原接管前的代理（原来是空的就删掉）→ 撤映射 → 回读。代理必须先动，否则中间态是「有代理没端口」 */
async function disconnectInner(opts) {
  const deviceId = String((opts && opts.deviceId) || '');
  const bad = _badDevice(deviceId);
  if (bad) return { ok: false, stage: 'device', msg: bad };

  // 手机侧端口要从实际代理值里认：可能是上次下发的，也可能是手机上手写的
  let proxy0 = '';
  try { proxy0 = await _getProxy(deviceId); } catch (e) {
    return { ok: false, stage: 'settings', msg: '读取手机代理失败：' + _short(e) };
  }
  const rec = _held.get(deviceId);
  const m = /^127\.0\.0\.1:(\d+)$/.exec(proxy0);
  const portFromProxy = m ? Number(m[1]) : 0;
  const ours = _isOurs(proxy0, rec ? rec.phonePort : 0);
  const phonePort = _normPort(opts && opts.phonePort) || (rec && rec.phonePort)
    || portFromProxy || PHONE_PORT;
  const prev = (rec && rec.prev) || '';

  // 现在的代理既不是我们写的、也不是接管前的原值（比如接管后用户自己又改成了
  // 公司 Wi-Fi 的代理）：只撤自己的端口映射，手机设置一概不碰
  if (!ours && !_cleared(proxy0) && proxy0 !== prev) {
    try { await _exec.removeReverse(deviceId, phonePort); } catch (_) {}
    _held.delete(deviceId);
    return {
      ok: false,
      stage: 'foreign',
      msg: '手机现在的系统代理是 ' + proxy0 + '，不是本工具设置的，没有改动',
    };
  }

  const notes = [];
  // 先收守护，再动设置：守护盯着反向监听，正常解除时映射一撤它也会动作
  if (rec && rec.watch) await _stopWatch(deviceId);
  // 没有原值时先写 :0 再删。delete 只清全局行，MIUI 会把代理镜像进当前 Wi-Fi
  // 的网络配置且不跟着删，于是「设置里已经没有代理」的手机照样把所有流量发给死端口。
  // 写 :0 会触发一次同步，把网络里的代理一起清掉。
  const cmds = prev
    ? ['settings put global http_proxy ' + prev]
    : ['settings put global http_proxy :0', 'settings delete global http_proxy']
      .concat(LEGACY_KEYS.map((k) => 'settings delete global ' + k));
  for (const cmd of cmds) {
    try { await _exec.shell(deviceId, cmd); } catch (e) { notes.push(_short(e)); }
  }
  try { await _exec.removeReverse(deviceId, phonePort); } catch (_) {}

  let got = null;
  try { got = await _getProxy(deviceId); } catch (e) { notes.push(_short(e)); }

  const notRestored = prev ? (got != null && got !== prev) : (got != null && !_cleared(got));
  // 有命令失败时即便读回已是 :0/null 也不算干净：残留的兼容字段可能还指旧端口
  if (notRestored || notes.length) {
    // 没清干净就别丢账本：退出、重连时还要按它再试一次，
    // 丢了既不会再重试，也忘了接管前的原值（下次解除会当成本工具写的直接删掉）
    _held.set(deviceId, { phonePort, pcPort: (rec && rec.pcPort) || 0, prev, watch: false });
    const perm = _isPermissionError(notes.join(' '));
    return {
      ok: false,
      stage: perm ? 'permission' : 'verify',
      msg: notRestored
        ? (prev
          ? '手机代理没还原成接管前的值（期望 ' + prev + '，实际 ' + (got || '空') + '）'
          : '手机代理没清除干净（读回 ' + got + '）')
        : '代理已切到无代理（:0），但有字段没清干净：' + notes.join('；'),
      hint: perm ? PERM_HINT : MANUAL_HINT,
      notes,
    };
  }
  _held.delete(deviceId);
  return { ok: true, deviceId, port: phonePort, restored: prev, notes };
}

function heldPort(deviceId) {
  const rec = _held.get(String(deviceId || ''));
  return (rec && rec.phonePort) || 0;
}

/** 退出前还原：不留「手机代理指向一个没人监听的端口」这种状态 */
async function restoreAllInner() {
  const items = Array.from(_held.entries());
  const out = [];
  for (const [deviceId, rec] of items) {
    try { out.push(await disconnectInner({ deviceId, phonePort: rec.phonePort })); }
    catch (e) { out.push({ ok: false, deviceId, msg: _short(e) }); }
  }
  return out;
}

/**
 * 启动自检：账本只在内存里，程序上次被强杀（任务管理器结束进程、蓝屏）后重开就是空的，
 * 手机可能还指着 127.0.0.1:18888，而反向映射已经随 adb 会话一起没了 —— 表现就是手机断网。
 * 只处理「代理是我们的端口 + reverse 里已经没有这条映射」的设备：映射还在说明限速可能
 * 还在用，不碰；没连手机、读不到设置就跳过，不拖慢启动。
 */
async function sweepStale() {
  const out = [];
  let devices = [];
  try { devices = await _exec.getDevices(); } catch (_) { return out; }
  for (const d of devices || []) {
    const deviceId = String((d && d.id) || d || '');
    if (!SAFE_DEVICE.test(deviceId) || _held.has(deviceId)) continue;
    let proxy = '';
    try { proxy = await _getProxy(deviceId); } catch (_) { continue; }
    if (!_isOurs(proxy, 0)) continue;
    let lines = [];
    try { lines = await _exec.listReverses(deviceId); } catch (_) { continue; }
    if (lines.some((l) => l.includes('tcp:' + PHONE_PORT))) continue;
    try { out.push(await disconnectInner({ deviceId, phonePort: PHONE_PORT })); }
    catch (e) { out.push({ ok: false, deviceId, msg: _short(e) }); }
  }
  return out;
}

/** 对外一律走队列：接管、解除、退出清理不会交错执行（见 _enqueue） */
const connect = (opts) => _enqueue(() => connectInner(opts));
const disconnect = (opts) => _enqueue(() => disconnectInner(opts));
const restoreAll = () => _enqueue(() => restoreAllInner());

module.exports = {
  connect, disconnect, status, restoreAll, sweepStale, heldPort,
  DEFAULT_PROXY_PORT, PHONE_PORT, PERM_HINT,
  __setRunner: (r) => { _exec = r || ADB; },
};
