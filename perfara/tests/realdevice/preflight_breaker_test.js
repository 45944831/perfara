'use strict';
/**
 * 采集前健康检查（preflight）+ 采集超时熔断（breaker）行为测试。
 *
 * 背景：设备卡顿曾一路传导到 PC 界面 —— 点开始后 ensureAppRunning 逐条尝试 +
 * 轮询 PID，最坏 20 多秒才有反应；采集中 adb 通道卡死时门闩被永不 resolve 的
 * promise 焊死，界面停在「采集中」再也不动。这里用假 adb / 假 shell 离线锁定
 * 修好之后的两个行为：
 *   ① preflightCheck：阈值判定、fail-fast、读不到就降级（不误判失败）
 *   ② Collector：单轮看门狗 + 无数据巡检，卡死时主动停并给出可操作原因
 *
 * 运行：node preflight_breaker_test.js   （不需要真机）
 */
const path = require('path');

const SRC = path.resolve(__dirname, '..', '..', '..', '_client_src', 'app', 'src');
const ADB_PATH = require.resolve(path.join(SRC, 'adb.js'));
const COLLECTOR_PATH = require.resolve(path.join(SRC, 'collector.js'));

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  (' + extra + ')' : '')); }
}

const ADB = require(ADB_PATH);

// ─── 1. preflightCheck ───────────────────────────────────────────────────────
console.log('\n── 采集前健康检查（preflightCheck）──');

/** 假 shell：按命令内容回喂设备输出 */
function makeShell(handler) {
  const seen = [];
  const shell = async (deviceId, cmd, timeout) => {
    seen.push({ deviceId, cmd, timeout });
    return handler(cmd);
  };
  shell.seen = seen;
  return shell;
}

const OK_ECHO = '__perfara_ok__\n';
function meminfo(totalKB, availKB) {
  return `MemTotal:       ${totalKB} kB\nMemFree:        ${Math.round(availKB * 0.4)} kB\n`
    + `MemAvailable:   ${availKB} kB\nBuffers:         12345 kB\nCached:         987654 kB\n`;
}
/** gpu 探针脚本的假输出：只有 kgsl_pct（探针表里第一个）有值 */
function gpuOut(pct) {
  return '@@kgsl_pct\n' + pct + '\n@@kgsl_busy\n@@kgsl_load\n@@mali_util\n';
}
/** 带屏幕状态的假 shell：wake 序列按 mWakefulness 查询次序返回 */
function screenShell({ wake, thenWake, locked }) {
  let wakeIdx = 0;
  const seen = [];
  const shell = async (deviceId, cmd) => {
    seen.push({ deviceId, cmd });
    if (cmd.includes('__perfara_ok__')) return OK_ECHO;
    if (cmd.includes('/proc/meminfo')) return meminfo(8 * 1024 * 1024, 4 * 1024 * 1024);
    if (cmd.startsWith('echo "@@')) return gpuOut(30);
    if (cmd.includes('mWakefulness')) {
      const first = wakeIdx === 0 ? wake : (thenWake === undefined ? wake : thenWake);
      wakeIdx++;
      return first ? `  mWakefulness=${first}\n` : '';
    }
    if (cmd.includes('input keyevent')) return '';
    if (cmd.includes('Lockscreen')) return locked ? `  mShowingLockscreen=${locked}\n` : '';
    return '';
  };
  shell.seen = seen;
  return shell;
}

(async () => {
  // 1.1 健康设备
  {
    const shell = makeShell((cmd) => {
      if (cmd.includes('__perfara_ok__')) return Promise.resolve(OK_ECHO);
      if (cmd.includes('/proc/meminfo')) return Promise.resolve(meminfo(12 * 1024 * 1024, 4 * 1024 * 1024));
      if (cmd.startsWith('echo "@@')) return Promise.resolve(gpuOut(37));
      return Promise.resolve('');
    });
    const r = await ADB.preflightCheck('dev-1', shell);
    check('健康设备 → ok', r.level === 'ok' && r.ok === true, r.summary);
    check('汇总含内存与 GPU', /可用内存 4\.0G\/12G/.test(r.summary) && /GPU 37%/.test(r.summary), r.summary);
    check('三项都探到了', r.checks.responsive === true && r.checks.memory.availMB === 4096 && r.checks.gpu === 37,
      JSON.stringify(r.checks));
    check('响应检查用短超时', shell.seen[0].timeout === 2500, shell.seen[0].timeout + 'ms');
    check('内存与 GPU 都探了（并行）', shell.seen.length === 4, shell.seen.length + ' 次调用');
  }

  // 1.2 可用内存见底 → fail，且原因可操作
  {
    const shell = makeShell((cmd) => {
      if (cmd.includes('__perfara_ok__')) return Promise.resolve(OK_ECHO);
      if (cmd.includes('/proc/meminfo')) return Promise.resolve(meminfo(8 * 1024 * 1024, 100 * 1024));
      if (cmd.startsWith('echo "@@')) return Promise.resolve(gpuOut(20));
      return Promise.resolve('');
    });
    const r = await ADB.preflightCheck('dev-1', shell);
    check('内存 100MB → fail', r.level === 'fail' && r.ok === false);
    check('失败原因说明剩余量与后果',
      /可用内存仅剩 100MB/.test(r.reason || '') && /关闭后台应用|重启手机/.test(r.reason || ''),
      (r.reason || '').slice(0, 40) + '…');
  }

  // 1.3 内存偏低 → warn（不阻断）
  {
    const shell = makeShell((cmd) => {
      if (cmd.includes('__perfara_ok__')) return Promise.resolve(OK_ECHO);
      if (cmd.includes('/proc/meminfo')) return Promise.resolve(meminfo(8 * 1024 * 1024, 500 * 1024));
      if (cmd.startsWith('echo "@@')) return Promise.resolve(gpuOut(20));
      return Promise.resolve('');
    });
    const r = await ADB.preflightCheck('dev-1', shell);
    check('内存 500MB → warn 但仍放行', r.level === 'warn' && r.ok === true && r.warnings.length === 1,
      r.warnings[0]);
  }

  // 1.4 GPU 被别人占满 → warn（不阻断：要测的可能就是重载应用）
  {
    const shell = makeShell((cmd) => {
      if (cmd.includes('__perfara_ok__')) return Promise.resolve(OK_ECHO);
      if (cmd.includes('/proc/meminfo')) return Promise.resolve(meminfo(12 * 1024 * 1024, 4 * 1024 * 1024));
      if (cmd.startsWith('echo "@@')) return Promise.resolve(gpuOut(98));
      return Promise.resolve('');
    });
    const r = await ADB.preflightCheck('dev-1', shell);
    check('GPU 98% → warn 且放行', r.level === 'warn' && r.ok === true && /GPU 负载 98%/.test(r.warnings[0]),
      r.warnings[0]);
  }

  // 1.5 设备无响应 → fail，且不再往下探（fail-fast）
  {
    const shell = makeShell((cmd) => {
      if (cmd.includes('__perfara_ok__')) return Promise.reject(new Error('device offline'));
      return Promise.resolve(OK_ECHO);
    });
    const r = await ADB.preflightCheck('dev-1', shell);
    check('无响应 → fail', r.level === 'fail' && r.ok === false);
    check('原因指向连接/解锁/授权', /USB 线|解锁|USB 调试|网段/.test(r.reason || ''));
    check('fail-fast：不再探内存与 GPU', shell.seen.length === 1, shell.seen.length + ' 次调用');
  }

  // 1.6 内存读不到 → 降级为未知，不判失败
  {
    const shell = makeShell((cmd) => {
      if (cmd.includes('__perfara_ok__')) return Promise.resolve(OK_ECHO);
      if (cmd.includes('/proc/meminfo')) return Promise.resolve('');      // 读不到
      if (cmd.startsWith('echo "@@')) return Promise.resolve(gpuOut(30));
      return Promise.resolve('');
    });
    const r = await ADB.preflightCheck('dev-1', shell);
    check('meminfo 读不到 → 仍 ok', r.level === 'ok' && r.ok === true);
    check('记一条说明而不是失败', r.notes.some(n => /未读到整机内存信息/.test(n)), r.notes.join(' / '));
    check('汇总标注内存不可读', /内存不可读/.test(r.summary), r.summary);
  }

  // 1.7 GPU 节点不开放 → 降级为未知（真机部分 GPU 驱动/ROM 就是这个表现）
  {
    const shell = makeShell((cmd) => {
      if (cmd.includes('__perfara_ok__')) return Promise.resolve(OK_ECHO);
      if (cmd.includes('/proc/meminfo')) return Promise.resolve(meminfo(8 * 1024 * 1024, 3 * 1024 * 1024));
      if (cmd.startsWith('echo "@@')) return Promise.resolve('@@kgsl_pct\n@@mali_util\n');   // 全是空
      return Promise.resolve('');
    });
    const r = await ADB.preflightCheck('dev-1', shell);
    check('GPU 节点不开放 → 仍 ok', r.level === 'ok' && r.ok === true);
    check('提示报告页会显示无数据', r.notes.some(n => /未开放 GPU 负载节点/.test(n)), r.notes.join(' / '));
  }

  // 1.8 没选设备
  {
    const r = await ADB.preflightCheck('', makeShell(() => Promise.resolve(OK_ECHO)));
    check('未选设备 → fail', r.level === 'fail' && /未选择设备/.test(r.reason || ''));
  }

  // 1.9 屏幕点亮 → 正常
  {
    const shell = screenShell({ wake: 'Awake', locked: 'false' });
    const r = await ADB.preflightCheck('dev-1', shell);
    check('亮屏未锁 → ok', r.level === 'ok' && r.checks.screen.awake === true, r.summary);
    check('汇总标注屏幕已点亮', /屏幕已点亮/.test(r.summary), r.summary);
  }

  // 1.10 熄屏但能唤醒 → 放行并记一条说明（真机最常见：手机放着就灭了）
  {
    const shell = screenShell({ wake: 'Asleep', thenWake: 'Awake', locked: 'false' });
    const r = await ADB.preflightCheck('dev-1', shell);
    check('熄屏可唤醒 → ok', r.level === 'ok' && r.ok === true);
    check('唤醒动作被记录下来', r.notes.some(n => /已自动唤醒/.test(n)), r.notes.join(' / '));
    check('确实发了唤醒键', shell.seen.some(s => s.cmd.includes('input keyevent 224')));
  }

  // 1.11 熄屏且唤不醒 → fail（否则会采一整段全 null 的空曲线）
  {
    const shell = screenShell({ wake: 'Asleep', thenWake: 'Asleep', locked: 'false' });
    const r = await ADB.preflightCheck('dev-1', shell);
    check('熄屏唤不醒 → fail', r.level === 'fail' && r.ok === false);
    check('原因说明「没有可见渲染层」', /可见渲染层|点靓屏幕|点亮屏幕/.test(r.reason || ''), (r.reason || '').slice(0, 30) + '…');
  }

  // 1.12 亮屏但锁屏 → warn（应用被 keyguard 挡着，同样取不到帧）
  {
    const shell = screenShell({ wake: 'Awake', locked: 'true' });
    const r = await ADB.preflightCheck('dev-1', shell);
    check('锁屏 → warn 但放行', r.level === 'warn' && r.ok === true && /锁屏/.test(r.warnings[0]), r.warnings[0]);
  }

  // 1.13 屏幕状态读不到 → 不判失败
  {
    const shell = screenShell({ wake: '', locked: '' });
    const r = await ADB.preflightCheck('dev-1', shell);
    check('屏幕状态不可读 → 仍 ok', r.level === 'ok' && r.ok === true);
    check('汇总标注不可读', /屏幕状态不可读/.test(r.summary), r.summary);
  }

  // ─── 2. Collector 熔断 ────────────────────────────────────────────────────
  console.log('\n── 采集超时熔断（Collector）──');

  /** 造一个假 adb 模块并注入 require.cache，然后重新加载 collector */
  function loadCollector(overrides) {
    const fake = {
      preflightCalls: 0,
      cancelled: 0,
      cancelAllInflight() { fake.cancelled++; },
      resetDeviceState() {},
      ensureAppRunning: async () => ({ ok: true, launched: false, pid: 4242 }),
      getPid: async () => 4242,
      getUid: async () => 10123,
      getCpuStats: async () => ({ sysCpu: 10, procCpu: 5 }),
      getCpuCoreStats: async () => ({ usage: [1, 2], freq: [1, 2] }),
      getMemInfo: async () => ({ totalPss: 100, memTotalMB: 8000, memAvailableMB: 3000 }),
      getFps: async () => ({ fps: 60, jank: 0, bigJank: 0, smallJank: 0, tinyJank: 0, jankRate: 0, method: 'timestats' }),
      getNetStats: async () => ({ rxKBps: 1, txKBps: 1 }),
      getBatteryInfo: async () => ({ level: 50 }),
      getThermalInfo: async () => ({ temperature: 30, gpuTemp: null }),
      getGpuUsage: async () => null,
      probeChannel: async () => true,
      preflightCheck: async () => {
        fake.preflightCalls++;
        return { level: 'ok', ok: true, warnings: [], notes: [], summary: '设备响应正常', checks: {} };
      },
    };
    Object.assign(fake, overrides || {});
    require.cache[ADB_PATH] = {
      id: ADB_PATH, filename: ADB_PATH, loaded: true, exports: fake, children: [], paths: [],
    };
    delete require.cache[COLLECTOR_PATH];
    const Collector = require(COLLECTOR_PATH);
    return { Collector, adb: fake };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** 收一个事件，超时返回 null（避免测试本身卡死） */
  function once(emitter, ev, ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { emitter.off(ev, h); resolve(null); }, ms);
      const h = (p) => { clearTimeout(t); resolve(p); };
      emitter.on(ev, h);
    });
  }
  /** 按用例缩放时间常量，返回还原函数 */
  function withTimings(Collector, overrides) {
    const T = Collector.__timings;
    const saved = { ...T };
    Object.assign(T, overrides);
    return () => Object.assign(T, saved);
  }

  // 2.1 健康链路：数据正常流动，不误熔断；且启动前跑过健康检查
  {
    const { Collector, adb } = loadCollector({});
    const restore = withTimings(Collector, {});
    const c = new Collector('dev-1', 'com.demo.app', 40, null);
    const errs = [];
    c.on('error', (e) => errs.push(e.message));
    await c.start();
    await sleep(300);
    check('启动前跑过健康检查', adb.preflightCalls === 1, adb.preflightCalls + ' 次');
    check('健康链路持续产出数据', c.history.length >= 3, c.history.length + ' 点');
    check('健康链路不熔断', c._running === true && errs.length === 0, errs.join('|'));
    const stopped = once(c, 'stopped', 1000);
    c.stop('manual');
    const p = await stopped;
    check('手动停止正常', p && p.reason === 'manual');
    check('停止后清掉巡检定时器', c._stallTimer === null);
    restore();
  }

  // 2.2 无数据熔断：adb 通道卡死（promise 永不 resolve）
  {
    const { Collector } = loadCollector({ getFps: () => new Promise(() => {}) });
    const restore = withTimings(Collector, { STALL_MS: 250, STALL_CHECK_MS: 50 });
    const c = new Collector('dev-1', 'com.demo.app', 30, null);
    const errs = [];
    c.on('error', (e) => errs.push(e.message));
    await c.start();
    const stopped = await once(c, 'stopped', 3000);
    check('卡死 → 自动停止', stopped && stopped.reason === 'device_stall', stopped ? stopped.reason : '未停止');
    check('熔断说明是「多久没有新数据」', errs.some(m => /没有新的采样数据/.test(m)), errs.join('|'));
    check('熔断原因可操作', errs.some(m => /检查设备是否卡顿|USB 连接/.test(m)));
    check('熔断时清理了 adb 进程', c._running === false);
    restore();
  }

  // 2.3 连续慢 tick → 看门狗熔断（两轮即断，不等更长）
  {
    const { Collector } = loadCollector({
      getFps: () => sleep(400).then(() => ({ fps: 60, method: 'timestats' })),
    });
    const restore = withTimings(Collector, { TICK_TIMEOUT_MS: 120, STALL_MS: 60000, STALL_CHECK_MS: 100 });
    const c = new Collector('dev-1', 'com.demo.app', 30, null);
    const errs = [];
    c.on('error', (e) => errs.push(e.message));
    await c.start();
    const stopped = await once(c, 'stopped', 5000);
    check('连续慢 tick → 自动停止', stopped && stopped.reason === 'device_stall', stopped ? stopped.reason : '未停止');
    check('熔断说明点名连续轮数', errs.some(m => /连续 2 轮采样/.test(m)), errs.join('|'));
    check('慢 tick 不写入半成品数据', c.history.length === 0, c.history.length + ' 点');
    restore();
  }

  // 2.4 看门狗只丢卡住的那一轮：慢一轮 + 快一轮 → 恢复，不熔断
  {
    let n = 0;
    const { Collector } = loadCollector({
      getFps: () => (++n % 2 === 1 ? sleep(300) : sleep(1)).then(() => ({ fps: 60, method: 'timestats' })),
    });
    const restore = withTimings(Collector, { TICK_TIMEOUT_MS: 120, STALL_MS: 60000, STALL_CHECK_MS: 100 });
    const c = new Collector('dev-1', 'com.demo.app', 30, null);
    const errs = [];
    c.on('error', (e) => errs.push(e.message));
    await c.start();
    await sleep(900);
    check('快慢交替 → 仍在采集', c._running === true, 'running=' + c._running);
    check('快慢交替 → 有数据产出', c.history.length >= 2, c.history.length + ' 点');
    check('快慢交替 → 不熔断', errs.length === 0, errs.join('|'));
    check('死轮计数未累积到熔断线', c._deadTicks < 2, '_deadTicks=' + c._deadTicks);
    c.stop('manual');
    restore();
  }

  // 2.5 健康检查不过 → start() 直接失败（不等后面的启动流程）
  {
    const { Collector } = loadCollector({
      preflightCheck: async () => ({
        level: 'fail', ok: false, warnings: [], notes: [],
        reason: '设备可用内存仅剩 80MB（共 8192MB），系统随时会杀掉目标进程。', summary: '', checks: {},
      }),
    });
    const restore = withTimings(Collector, {});
    const c = new Collector('dev-1', 'com.demo.app', 1000, null);
    let msg = '';
    try { await c.start(); } catch (e) { msg = e.message; }
    check('健康检查失败 → start() 抛出', /可用内存仅剩 80MB/.test(msg), msg.slice(0, 40) + '…');
    check('失败后不残留采样定时器', c._timer === null && c._running === false);
    restore();
  }

  // 2.6 start() 全流程硬超时：拉起应用卡住 → 有限时间内给结论
  {
    const { Collector } = loadCollector({ ensureAppRunning: () => new Promise(() => {}) });
    const restore = withTimings(Collector, { START_TIMEOUT_MS: 200 });
    const c = new Collector('dev-1', 'com.demo.app', 1000, null);
    const t0 = Date.now();
    let msg = '';
    try { await c.start(); } catch (e) { msg = e.message; }
    const cost = Date.now() - t0;
    check('启动卡住 → 超时抛错', /启动超时/.test(msg), msg.slice(0, 30) + '…');
    check('超时有界（<1s，生产为 30s）', cost < 1000, cost + 'ms');
    check('超时后不残留定时器/运行态', c._timer === null && c._running === false && c._tickBusy === false);
    restore();
  }

  // 2.7 冷启动的稳定期等待不算「无数据」：巡检从「本该出数据」那一刻起算
  {
    const { Collector } = loadCollector({
      ensureAppRunning: async () => { await sleep(120); return { ok: true, launched: true, pid: 4242 }; },
      getFps: () => new Promise(() => {}),
    });
    const restore = withTimings(Collector, { STALL_MS: 200, STALL_CHECK_MS: 50 });
    const c = new Collector('dev-1', 'com.demo.app', 30, null);
    c.on('error', () => {});
    const t0 = Date.now();
    await c.start();
    const stopped = await once(c, 'stopped', 12000);
    const cost = Date.now() - t0;
    check('等过冷启动稳定期后才熔断（未被误判）', stopped && stopped.reason === 'device_stall',
      stopped ? stopped.reason : '未停止');
    check('确实等满了 5s 稳定期', cost >= 5000, cost + 'ms');
    restore();
  }

  // 2.8 通道整体失效：所有采集调用都失败（USB 掉线 / adb 无响应）
  //     旧逻辑用 0 兜底后照样 emit 样本，_lastDataTs 一直被刷新 →
  //     无数据巡检永不触发，界面「采集中」却是一条零线。这里锁住修好后的行为。
  {
    const dead = () => Promise.reject(new Error('模拟通道断开'));
    const { Collector } = loadCollector({
      getCpuStats: dead, getCpuCoreStats: dead, getMemInfo: dead, getFps: dead,
      getNetStats: dead, getBatteryInfo: dead, getThermalInfo: dead, getGpuUsage: dead,
    });
    const restore = withTimings(Collector, {});
    const c = new Collector('dev-1', 'com.demo.app', 30, null);
    const errs = [];
    c.on('error', (e) => errs.push(e.message));
    await c.start();
    const stopped = await once(c, 'stopped', 3000);
    check('全部调用失败 → 自动停止', stopped && stopped.reason === 'device_stall',
      stopped ? stopped.reason : '未停止');
    check('熔断文案指向连接断开', errs.some(m => /连接可能已断开/.test(m)), errs.join('|').slice(0, 60));
    check('全失败轮次不产出零值样本', c.history.length === 0, c.history.length + ' 点');
    check('全失败熔断不残留定时器', c._timer === null && c._stallTimer === null);
    restore();
  }

  // 2.9 「应用被杀」与「通道断开」必须区分：getPid 在两种情况下都返回 null
  {
    // 2.9a 通道正常、应用真被杀 → process_gone
    const { Collector: C1 } = loadCollector({
      getPid: async () => null,
      probeChannel: async () => true,
    });
    const r1 = withTimings(C1, {});
    const c1 = new C1('dev-1', 'com.demo.app', 30, null);
    c1.on('error', () => {});
    await c1.start();
    const s1 = await once(c1, 'stopped', 2000);
    check('应用被杀 → process_gone', s1 && s1.reason === 'process_gone', s1 ? s1.reason : '未停止');
    r1();

    // 2.9b 通道断了 → 不能误报「应用进程已退出」，应走熔断。
    //      真实断连时每条命令都失败，所以这里把 PID、探活、各采集项一起置为失败。
    const dead = () => Promise.reject(new Error('模拟通道断开'));
    const { Collector: C2 } = loadCollector({
      getPid: async () => null,
      probeChannel: async () => false,
      getCpuStats: dead, getCpuCoreStats: dead, getMemInfo: dead, getFps: dead,
      getNetStats: dead, getBatteryInfo: dead, getThermalInfo: dead, getGpuUsage: dead,
    });
    const r2 = withTimings(C2, {});
    const c2 = new C2('dev-1', 'com.demo.app', 30, null);
    const errs2 = [];
    c2.on('error', (e) => errs2.push(e.message));
    await c2.start();
    const s2 = await once(c2, 'stopped', 3000);
    check('通道断开 → 不误报 process_gone', s2 && s2.reason === 'device_stall', s2 ? s2.reason : '未停止');
    check('通道断开文案点名连接问题', errs2.some(m => /连接可能已断开|无法与设备通信/.test(m)),
      errs2.join('|').slice(0, 60));
    r2();
  }

  // ─── 汇总 ────────────────────────────────────────────────────────────────
  console.log(`\n合计: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试执行异常:', e);
  process.exit(1);
});
