/**
 * 手机（USB）弱网接管：命令编排与失败分档。
 *
 * 只用 adb：reverse 建映射 → 写系统代理 → 回读校验，解除时反序清理。
 * 全程用假执行器，不起真 adb、不碰真机；覆盖失败路径（ROM 拒写、映射失败、
 * 回读不一致、设备序列号非法）和退出前还原。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const phoneProxy = require(path.resolve(__dirname, '../../../_client_src/app/src/phone-proxy'));

let passed = 0, failed = 0;
const FAILED = [];
function check(name, cond, detail) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '  -> ' + JSON.stringify(detail)));
  cond ? passed++ : (failed++, FAILED.push(name));
}

/**
 * 假执行器：settings 读写落在一个内存变量里，reverse 落在一个数组里。
 * fail 里放错误文本即可让对应动作抛错，用来造 ROM 拒写等场景。
 * opts.watch 打开时补上 pushFile 与守护脚本用到的几条 shell，用来测拔线守护编排。
 */
function makeFake(fail, opts) {
  const st = { proxy: '', reverses: [], calls: [], fail: fail || {}, script: '' };
  const withWatch = !!(opts && opts.watch);
  const runner = {
    async shell(deviceId, cmd) {
      st.calls.push('shell ' + cmd);
      const put = /^settings put global http_proxy (\S+)$/.exec(cmd);
      if (put) {
        if (st.fail.put) throw new Error(st.fail.put);
        st.proxy = put[1];
        return '';
      }
      if (/^settings delete global /.test(cmd)) {
        if (st.fail.del) throw new Error(st.fail.del);
        st.proxy = '';
        return '';
      }
      if (cmd === 'settings get global http_proxy') {
        if (st.fail.get) throw new Error(st.fail.get);
        return st.proxy ? st.proxy + '\n' : 'null\n';
      }
      if (withWatch) {
        if (/^chmod 755 \/data\/local\/tmp\/perfara_proxy_watch\.sh$/.test(cmd)) return '';
        if (/^if command -v setsid/.test(cmd)) return '';
        if (cmd === 'cat /data/local/tmp/perfara_proxy_watch.pid') return '4242\n';
        if (cmd === 'kill -0 4242') return '';
        if (/^p=\$\(cat \/data\/local\/tmp\/perfara_proxy_watch\.pid/.test(cmd)) return '';
      }
      throw new Error('未预期的 shell 命令: ' + cmd);
    },
    async reverseTcp(deviceId, phonePort, pcPort) {
      st.calls.push('reverse tcp:' + phonePort + '->' + pcPort);
      if (st.fail.reverse) throw new Error(st.fail.reverse);
      st.reverses.push('tcp:' + phonePort + ' tcp:' + pcPort);
    },
    async removeReverse(deviceId, port) {
      st.calls.push('reverse --remove tcp:' + port);
      st.reverses = st.reverses.filter((l) => l.indexOf('tcp:' + port) !== 0);
    },
    async listReverses() {
      st.calls.push('reverse --list');
      return st.reverses.slice();
    },
  };
  if (withWatch) {
    runner.pushFile = async (deviceId, local, remote) => {
      st.calls.push('push ' + remote);
      if (st.fail.push) throw new Error(st.fail.push);
      st.script = fs.readFileSync(local, 'utf8');
    };
  }
  return { state: st, runner };
}

const SERIAL = 'TESTSERIAL0001';
// 每段用不同序列号：模块里的持有关系是进程级的，串号才不会互相干扰
const SERIAL2 = 'TESTSERIAL0002';
const SERIAL3 = 'TESTSERIAL0003';
const SERIAL4 = 'TESTSERIAL0004';
const SERIAL5 = 'TESTSERIAL0005';
const SERIAL6 = 'TESTSERIAL0006';
const SERIAL7 = 'TESTSERIAL0007';
const SERIAL8 = 'TESTSERIAL0008';
const SERIAL9 = 'TESTSERIAL0009';
const SERIAL10 = 'TESTSERIAL0010';
const SERIAL11 = 'TESTSERIAL0011';
const SERIAL12 = 'TESTSERIAL0012';
const SERIAL13 = 'TESTSERIAL0013';
const SERIAL14 = 'TESTSERIAL0014';
const SERIAL15 = 'TESTSERIAL0015';
const SERIAL16 = 'TESTSERIAL0016';
const SERIAL17 = 'TESTSERIAL0017';
const SERIAL18 = 'TESTSERIAL0018';
const SERIAL19 = 'TESTSERIAL0019';
const SERIAL20 = 'TESTSERIAL0020';
const SERIAL21 = 'TESTSERIAL0021';
const SERIAL22 = 'TESTSERIAL0022';
const SERIAL23 = 'TESTSERIAL0023';
const PERM_ERR = 'Exception occurred while executing \'put\':\n'
  + 'java.lang.SecurityException: Permission denial: writing to settings requires:'
  + 'android.permission.WRITE_SECURE_SETTINGS';

async function main() {
  // 1) 正常接管：先删后建映射，再写代理，最后回读
  {
    const { state, runner } = makeFake();
    phoneProxy.__setRunner(runner);
    const r = await phoneProxy.connect({ deviceId: SERIAL, proxyPort: 8888 });
    check('接管成功', r.ok === true && r.proxy === '127.0.0.1:18888', r);
    check('映射先删后建（清掉上次残留）',
      state.calls.indexOf('reverse --remove tcp:18888') < state.calls.indexOf('reverse tcp:18888->8888')
      && state.calls.indexOf('reverse --remove tcp:18888') >= 0, state.calls);
    check('手机侧 18888 落到引擎端口 8888', state.reverses[0] === 'tcp:18888 tcp:8888', state.reverses);
    check('写下 http_proxy', state.proxy === '127.0.0.1:18888', state.proxy);
    check('清掉兼容字段', state.calls.filter((c) => /settings delete global global_http_proxy/.test(c)).length === 2,
      state.calls);
    check('记下持有关系', phoneProxy.heldPort(SERIAL) === 18888, phoneProxy.heldPort(SERIAL));
  }

  // 2) ROM 拒写：必须单独分档，并给出可操作的提示
  {
    const { runner } = makeFake({ put: PERM_ERR });
    phoneProxy.__setRunner(runner);
    const r = await phoneProxy.connect({ deviceId: SERIAL2, proxyPort: 8888 });
    check('拒绝写入 → stage=permission', r.ok === false && r.stage === 'permission', r);
    check('提示里带「禁止权限监控」', /禁止权限监控/.test(r.hint || ''), r.hint);
    check('拒写时不记持有关系', phoneProxy.heldPort(SERIAL2) === 0, phoneProxy.heldPort(SERIAL2));
  }

  // 3) 映射建不起来
  {
    const { runner } = makeFake({ reverse: 'adb: error: cannot bind listener' });
    phoneProxy.__setRunner(runner);
    const r = await phoneProxy.connect({ deviceId: SERIAL3, proxyPort: 8888 });
    check('映射失败 → stage=reverse', r.ok === false && r.stage === 'reverse', r);
  }

  // 4) 写进去了但读回来不是它（等于没生效）
  {
    const { runner } = makeFake();
    const wrapped = Object.assign({}, runner, {
      async shell(deviceId, cmd) {
        if (cmd === 'settings get global http_proxy') return 'null\n';
        return runner.shell(deviceId, cmd);
      },
    });
    phoneProxy.__setRunner(wrapped);
    const r = await phoneProxy.connect({ deviceId: SERIAL4, proxyPort: 8888 });
    check('回读不一致 → stage=verify', r.ok === false && r.stage === 'verify', r);
  }

  // 5) 设备序列号不合法：不执行任何 adb 命令
  {
    const { state, runner } = makeFake();
    phoneProxy.__setRunner(runner);
    const r = await phoneProxy.connect({ deviceId: 'bad serial; rm -rf /', proxyPort: 8888 });
    check('非法序列号被拦下', r.ok === false && r.stage === 'device' && state.calls.length === 0, r);
  }

  // 6) 解除：清代理 → 撤映射 → 回读为空
  {
    const { state, runner } = makeFake();
    phoneProxy.__setRunner(runner);
    await phoneProxy.connect({ deviceId: SERIAL, proxyPort: 8888 });
    state.calls.length = 0;
    const r = await phoneProxy.disconnect({ deviceId: SERIAL });
    check('解除成功', r.ok === true && state.proxy === '', r);
    check('先清代理再撤映射',
      state.calls.findIndex((c) => /settings delete global http_proxy/.test(c))
      < state.calls.findIndex((c) => /reverse --remove/.test(c)), state.calls);
    check('解除后不再持有', phoneProxy.heldPort(SERIAL) === 0, phoneProxy.heldPort(SERIAL));
  }

  // 7) 解除被拒：不能报成功
  {
    const { state, runner } = makeFake({ del: PERM_ERR });
    phoneProxy.__setRunner(runner);
    state.proxy = '127.0.0.1:18888';     // 手机上确实还挂着代理
    const r = await phoneProxy.disconnect({ deviceId: SERIAL5, proxyPort: 8888 });
    check('代理没清掉 → 不算成功', r.ok === false && r.stage === 'permission', r);
    check('解除失败也给提示', /禁止权限监控/.test(r.hint || ''), r.hint);
  }

  // 8) 退出前还原：把所有接管过的设备还原干净
  {
    const { state, runner } = makeFake();
    phoneProxy.__setRunner(runner);
    await phoneProxy.connect({ deviceId: SERIAL, proxyPort: 8888 });
    const out = await phoneProxy.restoreAll();
    check('restoreAll 逐个还原', Array.isArray(out) && out.length === 1 && out[0].ok === true, out);
    check('restoreAll 后代理已清空', state.proxy === '', state.proxy);
    check('restoreAll 后不再持有', phoneProxy.heldPort(SERIAL) === 0, phoneProxy.heldPort(SERIAL));
  }

  // 8b) 接管进行中程序被关：连接还挂在 adb 往返里，退出清理不能因为账本还空着就漏掉
  {
    const SLOW = 'TESTSERIAL0002';
    const { state, runner } = makeFake();
    const slow = Object.create(runner);
    slow.shell = async (d, cmd) => {
      if (/^settings put global http_proxy/.test(cmd)) await new Promise((r) => setTimeout(r, 200));
      return runner.shell(d, cmd);
    };
    phoneProxy.__setRunner(slow);
    const conn = phoneProxy.connect({ deviceId: SLOW, proxyPort: 8888 });
    await new Promise((r) => setTimeout(r, 60));      // 让 connect 先跑到 adb 中途
    const out = await phoneProxy.restoreAll();        // 相当于 window-all-closed
    const cr = await conn;
    check('接管中退出：接管本身已完成', !!(cr && cr.ok), cr);
    check('接管中退出：代理已还原', state.proxy === '', state.proxy);
    check('接管中退出：反向映射已撤掉', state.reverses.length === 0, state.reverses);
    check('接管中退出：账本已清空', phoneProxy.heldPort(SLOW) === 0, phoneProxy.heldPort(SLOW));
    check('接管中退出：清理结果如实返回', Array.isArray(out) && out.length === 1 && out[0].ok === true, out);
  }

  // 9) 状态读取：把手机上的真实代理反映出来（包括不是本工具设的）
  {
    const { state, runner } = makeFake();
    phoneProxy.__setRunner(runner);
    state.proxy = '127.0.0.1:18888';
    state.reverses = ['tcp:18888 tcp:8888'];
    const r = await phoneProxy.status(SERIAL);
    check('状态读到代理', r.ok === true && r.proxy === '127.0.0.1:18888', r);
    check('状态带反向映射', Array.isArray(r.reverse) && r.reverse.length === 1, r.reverse);
    state.proxy = '';
    const r2 = await phoneProxy.status(SERIAL);
    check('未接管时 proxy 为空', r2.ok === true && r2.proxy === '', r2);
  }

  // 10) 接管前手机上已有代理：解除时要按原值写回，不能一把删掉
  {
    const { state, runner } = makeFake();
    phoneProxy.__setRunner(runner);
    state.proxy = '10.0.0.9:3128';        // 公司 Wi-Fi 的代理
    const r = await phoneProxy.connect({ deviceId: SERIAL6, proxyPort: 8888 });
    check('接管前代理被记下', r.ok === true && r.restoredOnRelease === '10.0.0.9:3128', r);
    check('接管后代理指向本机', state.proxy === '127.0.0.1:18888', state.proxy);
    const off = await phoneProxy.disconnect({ deviceId: SERIAL6 });
    check('解除写回接管前的代理', off.ok === true && state.proxy === '10.0.0.9:3128', {
      r: off, proxy: state.proxy,
    });
    check('解除结果带上还原值', off.restored === '10.0.0.9:3128', off.restored);
  }

  // 11) 不是本工具写的代理：不接管、不删除，只报清楚
  {
    const { state, runner } = makeFake();
    phoneProxy.__setRunner(runner);
    state.proxy = '10.0.0.9:3128';
    const st = await phoneProxy.status(SERIAL7);
    check('自带代理不算 ours', st.ok === true && st.ours === false, st);
    state.calls.length = 0;
    const r = await phoneProxy.disconnect({ deviceId: SERIAL7 });
    check('非本工具的代理 → stage=foreign', r.ok === false && r.stage === 'foreign', r);
    check('非本工具的代理原样保留', state.proxy === '10.0.0.9:3128', state.proxy);
    check('非本工具的代理不写 settings',
      !state.calls.some((c) => /settings (put|delete)/.test(c)), state.calls);
  }

  // 12) 接管后用户自己改了代理：解除也不能覆盖，只撤自己的映射
  {
    const { state, runner } = makeFake();
    phoneProxy.__setRunner(runner);
    await phoneProxy.connect({ deviceId: SERIAL8, proxyPort: 8888 });
    state.proxy = '10.0.0.9:3128';
    const r = await phoneProxy.disconnect({ deviceId: SERIAL8 });
    check('被改成别的代理 → stage=foreign', r.ok === false && r.stage === 'foreign', r);
    check('改成别的代理时不动 settings', state.proxy === '10.0.0.9:3128', state.proxy);
    check('foreign 也撤掉自己的映射', state.reverses.length === 0, state.reverses);
    check('foreign 后不再持有', phoneProxy.heldPort(SERIAL8) === 0, phoneProxy.heldPort(SERIAL8));
  }

  // 13) 接管成功后在手机里装守护：拔线后自行撤代理（修「拔了线还在断网」）
  {
    const { state, runner } = makeFake(null, { watch: true });
    phoneProxy.__setRunner(runner);
    const r = await phoneProxy.connect({ deviceId: SERIAL9, proxyPort: 8888 });
    check('接管成功并装上拔线守护', r.ok === true && r.watch === true, r);
    check('守护脚本推到 /data/local/tmp',
      state.calls.includes('push /data/local/tmp/perfara_proxy_watch.sh'), state.calls);
    check('用 setsid 起守护（拔线带走 adb 会话也不退出）',
      state.calls.some((c) => /setsid sh \/data\/local\/tmp\/perfara_proxy_watch\.sh 18888 49C8/.test(c)),
      state.calls);
    check('守护脚本检测反向监听（/proc/net/tcp 的 0A=LISTEN）',
      /\/proc\/net\/tcp/.test(state.script) && /0A/.test(state.script), (state.script || '').slice(0, 120));
    check('守护脚本先写 :0 再删代理（MIUI 网络配置镜像也要清）',
      /settings put global http_proxy :0/.test(state.script)
      && /settings delete global http_proxy/.test(state.script), '');
    check('守护脚本是纯 LF（手机 sh 不认 CRLF）', !/\r/.test(state.script || ''), '');
    const stt = await phoneProxy.status(SERIAL9);
    check('状态里带 watch=true', stt.ok === true && stt.watch === true, stt);
  }

  // 14) 解除：先收守护 → 写 :0 → 删字段 → 撤映射，顺序不能反
  {
    const { state, runner } = makeFake(null, { watch: true });
    phoneProxy.__setRunner(runner);
    await phoneProxy.connect({ deviceId: SERIAL10, proxyPort: 8888 });
    state.calls.length = 0;
    const r = await phoneProxy.disconnect({ deviceId: SERIAL10 });
    const stopIdx = state.calls.findIndex((c) => /^shell p=\$\(cat/.test(c));
    const zeroIdx = state.calls.findIndex((c) => c === 'shell settings put global http_proxy :0');
    const delIdx = state.calls.findIndex((c) => c === 'shell settings delete global http_proxy');
    check('解除先收守护，再写 :0，最后删字段',
      stopIdx >= 0 && stopIdx < zeroIdx && zeroIdx < delIdx, state.calls);
    check('解除成功且代理清空', r.ok === true && state.proxy === '', { r, proxy: state.proxy });
  }

  // 15) 守护装不上不影响接管本身，但要如实告诉调用方
  {
    const { runner } = makeFake({ push: 'adb: error: failed to copy' }, { watch: true });
    phoneProxy.__setRunner(runner);
    const r = await phoneProxy.connect({ deviceId: SERIAL11, proxyPort: 8888 });
    check('守护安装失败仍算接管成功', r.ok === true && r.watch === false, r);
    check('守护失败给出原因', /failed to copy/.test(r.watch_msg || ''), r.watch_msg);
    check('守护失败仍记持有关系', phoneProxy.heldPort(SERIAL11) === 18888, phoneProxy.heldPort(SERIAL11));
  }

  // 16) 换机 / 换端口重连：先把账本里上一台还原，旧映射和旧代理都不留到拔线
  //     （WeakNet v1.1.12 同一处收口：断开按账本，不按界面当前选中的那台）
  {
    const st = { proxies: { [SERIAL12]: '10.0.0.9:3128', [SERIAL13]: '' }, reverses: {}, calls: [] };
    const runner = {
      async shell(dev, cmd) {
        st.calls.push(dev + ' shell ' + cmd);
        const put = /^settings put global http_proxy (\S+)$/.exec(cmd);
        if (put) { st.proxies[dev] = put[1]; return ''; }
        if (/^settings delete global /.test(cmd)) { st.proxies[dev] = ''; return ''; }
        if (cmd === 'settings get global http_proxy') return (st.proxies[dev] || 'null') + '\n';
        throw new Error('未预期的 shell 命令: ' + cmd);
      },
      async reverseTcp(dev, p, pc) {
        (st.reverses[dev] = st.reverses[dev] || []).push('tcp:' + p + ' tcp:' + pc);
      },
      async removeReverse(dev, p) {
        st.reverses[dev] = (st.reverses[dev] || []).filter((l) => l.indexOf('tcp:' + p) !== 0);
      },
      async listReverses(dev) { return (st.reverses[dev] || []).slice(); },
    };
    phoneProxy.__setRunner(runner);
    const a = await phoneProxy.connect({ deviceId: SERIAL12, proxyPort: 8888 });
    check('换机用例：先接管 A', a.ok === true && st.proxies[SERIAL12] === '127.0.0.1:18888', { a, p: st.proxies });
    const b = await phoneProxy.connect({ deviceId: SERIAL13, proxyPort: 8888 });
    check('换机接管 B 成功', b.ok === true && st.proxies[SERIAL13] === '127.0.0.1:18888', { b, p: st.proxies });
    check('换机前把 A 的原代理写回', st.proxies[SERIAL12] === '10.0.0.9:3128', st.proxies);
    check('换机前撤掉 A 的映射', (st.reverses[SERIAL12] || []).length === 0, st.reverses);
    check('结果里如实报告还原了 A',
      Array.isArray(b.restored) && b.restored.some((x) => x.deviceId === SERIAL12 && x.ok), b.restored);
    check('账本只剩 B',
      phoneProxy.heldPort(SERIAL12) === 0 && phoneProxy.heldPort(SERIAL13) === 18888,
      { a: phoneProxy.heldPort(SERIAL12), b: phoneProxy.heldPort(SERIAL13) });

    // 同机换端口重连：旧端口映射要撤，用户的原始代理不能被自己写的 127.0.0.1 顶掉
    st.proxies[SERIAL14] = '10.0.0.9:3128';
    const r1 = await phoneProxy.connect({ deviceId: SERIAL14, proxyPort: 8888 });
    check('同机首连成功', r1.ok === true && phoneProxy.heldPort(SERIAL14) === 18888, r1);
    const r2 = await phoneProxy.connect({ deviceId: SERIAL14, proxyPort: 8888, phonePort: 28888 });
    check('同机换端口重连成功', r2.ok === true && st.proxies[SERIAL14] === '127.0.0.1:28888', { r2, p: st.proxies });
    check('旧端口的映射已撤掉',
      (st.reverses[SERIAL14] || []).every((l) => l.indexOf('tcp:18888') !== 0), st.reverses);
    check('重连不把自己写的代理当成原代理', r2.restoredOnRelease === '10.0.0.9:3128', r2.restoredOnRelease);
    check('账本端口跟着换', phoneProxy.heldPort(SERIAL14) === 28888, phoneProxy.heldPort(SERIAL14));
    await phoneProxy.disconnect({ deviceId: SERIAL13 });
    await phoneProxy.disconnect({ deviceId: SERIAL14 });
  }

  // 17) 手机侧端口被占用：要点名是被别的 App 占着，不是权限问题
  {
    const { runner } = makeFake({ reverse: 'adb: error: cannot bind listener: Address already in use' });
    phoneProxy.__setRunner(runner);
    const r = await phoneProxy.connect({ deviceId: SERIAL15, proxyPort: 8888 });
    check('端口占用 → stage=reverse', r.ok === false && r.stage === 'reverse', r);
    check('端口占用点名 18888 被占', /18888 端口已被占用/.test(r.hint || ''), r.hint);
  }

  // 18) 自动还原失败：手动命令必须写 :0（delete 在 MIUI 上清不掉网络配置副本）
  {
    const { state, runner } = makeFake({ del: 'adb: device offline' });
    phoneProxy.__setRunner(runner);
    state.proxy = '127.0.0.1:18888';
    const r = await phoneProxy.disconnect({ deviceId: SERIAL16 });
    check('解除失败不算成功', r.ok === false, r);
    check('手动命令给的是 put :0', /settings put global http_proxy :0/.test(r.hint || ''), r.hint);
  }

  // 19) 账本里还挂着别的手机：状态要告诉界面，接管/解除会一起还原
  {
    const { runner } = makeFake();
    phoneProxy.__setRunner(runner);
    await phoneProxy.connect({ deviceId: SERIAL17, proxyPort: 8888 });
    const st = await phoneProxy.status(SERIAL18);
    check('状态带 heldOthers（另一台还挂着）',
      st.ok === true && (st.heldOthers || []).includes(SERIAL17), st.heldOthers);
    check('当前这台不算 heldOthers', !(st.heldOthers || []).includes(SERIAL18), st.heldOthers);
    await phoneProxy.restoreAll();
  }

  // 20) 解除失败不丢账本：退出时还会再试，且「接管前的原值」不会因为一次失败就忘掉
  {
    const { state, runner } = makeFake();
    phoneProxy.__setRunner(runner);
    state.proxy = '10.0.0.9:3128';
    await phoneProxy.connect({ deviceId: SERIAL19, proxyPort: 8888 });
    check('失败用例：先接管并记住原代理',
      phoneProxy.heldPort(SERIAL19) === 18888 && state.proxy === '127.0.0.1:18888', state.proxy);
    state.fail.put = 'adb: device offline';     // 写回原值时手机已经断了
    const bad = await phoneProxy.disconnect({ deviceId: SERIAL19 });
    check('清理失败如实报错', bad.ok === false, bad);
    check('清理失败后账本还记着', phoneProxy.heldPort(SERIAL19) === 18888, phoneProxy.heldPort(SERIAL19));
    delete state.fail.put;
    const again = await phoneProxy.disconnect({ deviceId: SERIAL19 });
    check('重试能把原代理写回去', again.ok === true && state.proxy === '10.0.0.9:3128',
      { again, proxy: state.proxy });
    check('重试成功后账本清空', phoneProxy.heldPort(SERIAL19) === 0, phoneProxy.heldPort(SERIAL19));
  }

  // 21) 启动自检：程序被强杀后账本是空的，映射已断但代理还指着本工具端口的手机要清掉；
  //     映射还在（限速可能还在用）或代理不是本工具的，一律不碰
  {
    const st = {
      devices: [SERIAL20, SERIAL21, SERIAL22, SERIAL23],
      proxies: {
        [SERIAL20]: '127.0.0.1:18888',                    // 拔线/强杀遗留：映射没了
        [SERIAL21]: '127.0.0.1:18888',                    // 映射还在：可能正在限速
        [SERIAL22]: '10.0.0.9:3128',                      // 公司代理：不是我们的
        [SERIAL23]: '',
      },
      reverses: { [SERIAL21]: ['tcp:18888 tcp:8888'] },
      calls: [],
    };
    const runner = {
      async getDevices() { return st.devices.map((id) => ({ id })); },
      async shell(dev, cmd) {
        st.calls.push(dev + ' shell ' + cmd);
        const put = /^settings put global http_proxy (\S+)$/.exec(cmd);
        if (put) { st.proxies[dev] = put[1]; return ''; }
        if (/^settings delete global /.test(cmd)) { st.proxies[dev] = ''; return ''; }
        if (cmd === 'settings get global http_proxy') return (st.proxies[dev] || 'null') + '\n';
        throw new Error('未预期的 shell 命令: ' + cmd);
      },
      async reverseTcp(dev, p, pc) { (st.reverses[dev] = st.reverses[dev] || []).push('tcp:' + p + ' tcp:' + pc); },
      async removeReverse(dev, p) {
        st.reverses[dev] = (st.reverses[dev] || []).filter((l) => l.indexOf('tcp:' + p) !== 0);
      },
      async listReverses(dev) { return (st.reverses[dev] || []).slice(); },
    };
    phoneProxy.__setRunner(runner);
    const swept = await phoneProxy.sweepStale();
    check('启动自检清掉映射已断的残留代理', st.proxies[SERIAL20] === '', st.proxies[SERIAL20]);
    check('启动自检只报这一台', swept.length === 1 && swept[0].deviceId === SERIAL20, swept);
    check('映射还在的手机不动', st.proxies[SERIAL21] === '127.0.0.1:18888', st.proxies[SERIAL21]);
    check('别人的代理不动', st.proxies[SERIAL22] === '10.0.0.9:3128', st.proxies[SERIAL22]);
    check('没有代理的手机不产生任何 adb 写操作',
      !st.calls.some((c) => c.startsWith(SERIAL23 + ' shell settings put')), st.calls);
    const noDevices = { getDevices: async () => { throw new Error('adb: no devices'); } };
    phoneProxy.__setRunner(noDevices);
    const none = await phoneProxy.sweepStale();
    check('adb 不可用时不抛错', Array.isArray(none) && none.length === 0, none);
  }

  // 22) 接线：主进程启动时真跑一次自检
  {
    const mainSrc = fs.readFileSync(path.resolve(__dirname, '../../../_client_src/app/main.js'), 'utf8');
    check('主进程启动时跑手机侧自检', /phoneProxy\.sweepStale\(\)/.test(mainSrc), 'main.js');
  }

  phoneProxy.__setRunner(null);
  console.log(`\n===== 手机 USB 接管测试结果: ${passed} PASS / ${failed} FAIL =====`);
  if (failed) {
    console.log('FAILED: ' + FAILED.join(', '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
