/**
 * 系统代理残留兜底：快照 / 还原 / 判断是否仍是本引擎的接管。
 *
 * 引擎被强杀（taskkill /F、崩溃）时 Python 的 atexit 不跑，HKCU 会停在
 * ProxyEnable=1 + ProxyServer=127.0.0.1:<引擎端口>，表现为「工具没了上不了网」。
 * 这里用内存注册表替身验证快照与还原的判断，不碰本机真实设置。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const sysproxy = require(path.resolve(__dirname, '../../../_client_src/app/src/sysproxy'));

let passed = 0, failed = 0;
const FAILED = [];
function check(name, cond, detail) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '  -> ' + JSON.stringify(detail)));
  cond ? passed++ : (failed++, FAILED.push(name));
}

const NAMES = ['ProxyEnable', 'ProxyServer', 'ProxyOverride'];
const D = (v) => ({ type: 'REG_DWORD', value: v });
const S = (v) => ({ type: 'REG_SZ', value: v });

function makeReg(initial) {
  const st = { reg: Object.assign({}, initial), writes: 0, notified: 0 };
  const io = {
    read() {
      const out = {};
      for (const n of NAMES) out[n] = st.reg[n] ? { type: st.reg[n].type, value: st.reg[n].value } : null;
      return out;
    },
    write(values) {
      st.writes += 1;
      for (const n of NAMES) st.reg[n] = values[n] ? { type: values[n].type, value: values[n].value } : null;
    },
    notify() { st.notified += 1; },
  };
  return { st, io };
}

const TMP = path.join(os.tmpdir(), 'perfara-sysproxy-test-' + process.pid + '.json');
function fresh() { try { fs.unlinkSync(TMP); } catch (_) {} }

(async () => {
  // 1) 开启前快照：原值（公司代理）完整落盘
  {
    fresh();
    const { st, io } = makeReg({ ProxyEnable: D(1), ProxyServer: S('10.0.0.9:3128'), ProxyOverride: null });
    sysproxy.__setIO(io);
    const r = sysproxy.snapshot(TMP, 8888);
    const saved = JSON.parse(fs.readFileSync(TMP, 'utf8'));
    check('快照成功并记录端口', r.ok === true && r.port === 8888, r);
    check('快照存下原代理', saved.values.ProxyServer.value === '10.0.0.9:3128', saved.values);
    check('快照保留 ProxyOverride 为空的事实', saved.values.ProxyOverride === null, saved.values);
    check('快照本身不改注册表', st.writes === 0, st.writes);
  }

  // 2) 已经是本引擎的接管：不能再快照（否则把 127.0.0.1 当成用户原值）
  {
    fresh();
    const { io } = makeReg({ ProxyEnable: D(1), ProxyServer: S('127.0.0.1:8888'), ProxyOverride: S('localhost;127.*;<local>') });
    sysproxy.__setIO(io);
    const r = sysproxy.snapshot(TMP, 8888);
    check('已接管时跳过快照', r.ok === false && r.reason === 'already-ours', r);
    check('跳过时不留备份文件', !fs.existsSync(TMP), true);
  }

  // 3) 引擎崩溃后：按快照还回用户原代理，并通知系统刷新
  {
    fresh();
    const boot = makeReg({ ProxyEnable: D(1), ProxyServer: S('10.0.0.9:3128'), ProxyOverride: null });
    sysproxy.__setIO(boot.io);
    sysproxy.snapshot(TMP, 8888);
    // 引擎接管后（崩溃前）
    boot.st.reg = { ProxyEnable: D(1), ProxyServer: S('127.0.0.1:8888'), ProxyOverride: S('localhost;127.*;<local>') };
    const r = sysproxy.restoreStale(TMP);
    check('崩溃后还原成功', r.ok === true && r.port === 8888, r);
    check('还原成接管前的值', boot.st.reg.ProxyEnable.value === 1
      && boot.st.reg.ProxyServer.value === '10.0.0.9:3128', boot.st.reg);
    check('还原后通知系统刷新', boot.st.notified === 1, boot.st.notified);
    check('还原后删掉快照', !fs.existsSync(TMP), true);
  }

  // 4) 原机器上本来就没开代理：还原成「关闭 + 无代理值」
  {
    fresh();
    const boot = makeReg({ ProxyEnable: D(0), ProxyServer: null, ProxyOverride: null });
    sysproxy.__setIO(boot.io);
    sysproxy.snapshot(TMP, 8888);
    boot.st.reg = { ProxyEnable: D(1), ProxyServer: S('127.0.0.1:8888'), ProxyOverride: S('localhost;127.*;<local>') };
    const r = sysproxy.restoreStale(TMP);
    check('原来没开代理时还原为关闭', r.ok === true && Number(boot.st.reg.ProxyEnable.value) === 0, boot.st.reg);
    check('代理地址一并清空', boot.st.reg.ProxyServer === null, boot.st.reg);
  }

  // 5) 用户中途自己换过代理：不覆盖，只丢过期快照
  {
    fresh();
    const boot = makeReg({ ProxyEnable: D(1), ProxyServer: S('10.0.0.9:3128'), ProxyOverride: null });
    sysproxy.__setIO(boot.io);
    sysproxy.snapshot(TMP, 8888);
    boot.st.reg = { ProxyEnable: D(1), ProxyServer: S('127.0.0.1:9999'), ProxyOverride: null };
    boot.st.writes = 0;
    const r = sysproxy.restoreStale(TMP);
    check('代理已被换掉 → 不动注册表', r.ok === false && r.reason === 'changed' && boot.st.writes === 0, r);
    check('换掉时代理原样保留', boot.st.reg.ProxyServer.value === '127.0.0.1:9999', boot.st.reg);
    check('换掉后也删掉快照', !fs.existsSync(TMP), true);
  }

  // 6) 端口不同（引擎顺延过端口）也不算自己的接管
  {
    fresh();
    const boot = makeReg({ ProxyEnable: D(1), ProxyServer: S('10.0.0.9:3128'), ProxyOverride: null });
    sysproxy.__setIO(boot.io);
    sysproxy.snapshot(TMP, 8888);
    boot.st.reg = { ProxyEnable: D(1), ProxyServer: S('127.0.0.1:8889'), ProxyOverride: null };
    const r = sysproxy.restoreStale(TMP);
    check('端口不一致不还原', r.ok === false && r.reason === 'changed', r);
  }

  // 7) 没有快照：什么也不做
  {
    fresh();
    const { st, io } = makeReg({ ProxyEnable: D(1), ProxyServer: S('127.0.0.1:8888'), ProxyOverride: null });
    sysproxy.__setIO(io);
    const r = sysproxy.restoreStale(TMP);
    check('没有快照就跳过', r.ok === false && r.skipped === true && st.writes === 0, r);
  }

  // 8) 接线静态检查：开启前快照、引擎退出与启动时还原、正常关闭清快照
  {
    const main = fs.readFileSync(path.resolve(__dirname, '../../../_client_src/app/main.js'), 'utf8');
    check('开启系统代理前打快照', /sysproxy\.snapshot\(sysproxyBackupFile\(\)/.test(main)
      && /\/api\/sysproxy/.test(main), 'main.js 未接快照');
    check('引擎退出时还原系统代理',
      /setExitHandler[\s\S]{0,400}sysproxy\.restoreStale\(sysproxyBackupFile\(\)\)/.test(main), '引擎退出未还原');
    check('启动时清掉上次崩溃留下的接管',
      /whenReady[\s\S]{0,1200}sysproxy\.restoreStale\(sysproxyBackupFile\(\)\)/.test(main), '启动未自检');
    check('正常关闭后清掉快照', /weaknetHost\.shutdown\(\)\)[\s\S]{0,200}sysproxy\.clearBackup/.test(main),
      '关闭未清快照');
  }

  sysproxy.__setIO(null);
  fresh();
  console.log(`\n===== 系统代理残留测试结果: ${passed} PASS / ${failed} FAIL =====`);
  if (failed) {
    console.log('FAILED: ' + FAILED.join(', '));
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
