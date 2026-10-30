'use strict';

/**
 * 弱网二级页面（renderer/weaknet-page.js）渲染与交互测试。
 *
 * 用 Playwright 打开真实的采集页 index.html，只在页面里注入一个假的 perfAPI：
 * 这样测的是页面自己的 DOM/CSS/事件逻辑，不依赖 Electron、也不依赖真引擎。
 * 引擎侧的行为（启停/限速/回收）由 weaknet_host_test.js 用真引擎验证。
 */

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PAGE = path.join(ROOT, '_client_src', 'app', 'renderer', 'index.html');
const OUT = path.join(ROOT, 'release', '_audit', 'weaknet-ui');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const checks = [];
function check(name, cond, extra) {
  checks.push({ name, ok: !!cond, extra });
  console.log((cond ? '  ok  ' : ' FAIL ') + name + (extra ? ' | ' + extra : ''));
}

/** 页面里注入的假引擎：形状与 /api/status 一致，行为够页面跑起来 */
const FAKE = `
// ?wnfail=1 用来模拟「引擎起不来」：启动返回原因、控制接口全部拒绝
const FAILMODE = location.search.indexOf('wnfail') >= 0;
window.__wn = { calls: [], status: {
  version: '1.1.10', limit_on: false, preset_key: 'direct', sysproxy: false,
  listen: { host: '127.0.0.1', port: 8888 },
  profile: { name: '直连（不限制）', latency_down_ms: 0, down_kbps: 0, loss_pct: 0 },
  stats: { total: 0, active: 0, down: 0, up: 0 },
  scope: { mode: 'all', list: [] },
  events: [{ seq: 1, t: '12:00:00', type: 'config', msg: '引擎已就绪' }],
} };
const PRESETS = [
  { key: 'direct', name: '直连（不限制）', cat: '常规网络' },
  { key: 'wifi', name: 'Wi-Fi 良好', cat: '常规网络' },
  { key: '4g_weak', name: '4G 弱网（边缘/室内）', cat: '弱网环境' },
  { key: 'airplane', name: '完全断网（立即拒连）', cat: '极端环境' },
];
const PARAMS = { items: [
  { key: 'latency_down_ms', label: '下行延迟', unit: 'ms', min: 0, max: 60000, step: 10, default: 0 },
  { key: 'down_kbps', label: '下行带宽', unit: 'kbps', min: 0, max: 1000000, step: 100, default: 0 },
  { key: 'loss_pct', label: '丢包率', unit: '%', min: 0, max: 100, step: 1, default: 0 },
] };
// 弱网组合：段里存的是场景 key + 时长，与引擎 /api/combos 同构
const COMBOS = [
  { id: 'cmb1', name: '通勤组合', loop: true, steps: [
    { key: '4g_weak', minutes: 0, seconds: 20 },
    { key: 'wifi', minutes: 0, seconds: 10 },
    { key: 'airplane', minutes: 0, seconds: 20 },
  ] },
  { id: 'cmb2', name: '单段组合', loop: false, steps: [
    { key: 'wifi', minutes: 1, seconds: 0 },
  ] },
];
const sceneName = (k) => (PRESETS.find((p) => p.key === k) || { name: k }).name;
const comboSummary = (c) => c.steps.map((x) => sceneName(x.key) + ' '
  + Math.floor((x.minutes * 60 + x.seconds) / 60) + ':'
  + String((x.minutes * 60 + x.seconds) % 60).padStart(2, '0')).join(' → ')
  + (c.loop ? '（循环）' : '');
function push(ev) { window.__wn.status.events.unshift(ev); }
window.__fakeEngine = async (p, body) => {
  if (FAILMODE) return { ok: false, reason: '弱网引擎未响应：connect ECONNREFUSED' };
  window.__wn.calls.push({ path: p, body: body === undefined ? null : body });
  const s = window.__wn.status;
  if (p === '/api/status') return { ok: true, data: JSON.parse(JSON.stringify(s)) };
  if (p === '/api/presets') return { ok: true, data: PRESETS };
  if (p === '/api/params') return { ok: true, data: PARAMS };
  if (p === '/api/upresets') return { ok: true, data: { items: [
    { id: 'up1', name: '我的自定义场景', profile: {} },
  ] } };
  if (p === '/api/combos') {
    return { ok: true, data: { items: COMBOS.map((c) => ({
      id: c.id, name: c.name, loop: c.loop, summary: comboSummary(c), steps: c.steps,
    })) } };
  }
  if (p === '/api/combo') {
    const id = body.id || ('cmb' + (COMBOS.length + 1));
    const row = { id, name: body.name, loop: !!body.loop, steps: body.steps || [] };
    const i = COMBOS.findIndex((c) => c.id === id);
    if (i >= 0) COMBOS[i] = row; else COMBOS.push(row);
    return { ok: true, data: { ok: true, id, name: row.name, steps: row.steps.length } };
  }
  if (p === '/api/combo/delete') {
    const i = COMBOS.findIndex((c) => c.id === body.id);
    if (i >= 0) COMBOS.splice(i, 1);
    // 与引擎一致：删的正是当前选中的组合，就停播放回直连
    if (s.preset_key === 'c:' + body.id) {
      s.preset_key = 'direct';
      s.profile.name = '直连（不限制）';
      s.limit_on = false;
    }
    return { ok: true, data: { ok: i >= 0 } };
  }
  if (p === '/api/preset') {
    s.preset_key = body.key;
    if (String(body.key).indexOf('c:') === 0) {
      // 组合：限速开着就从第一段开始播（与引擎一致）
      const c = COMBOS.find((x) => x.id === String(body.key).slice(2));
      if (c && s.limit_on && c.steps.length) s.profile.name = sceneName(c.steps[0].key);
    } else {
      const pr = PRESETS.find((x) => x.key === body.key);
      s.profile.name = pr ? pr.name : body.key;
    }
    push({ seq: 9, t: '12:00:01', type: 'config', msg: '切换场景：' + s.profile.name });
    return { ok: true, data: s };
  }
  if (p === '/api/profile') {
    s.preset_key = 'custom';
    s.profile.name = '自定义';
    Object.assign(s.profile, body);
    push({ seq: 9, t: '12:00:02', type: 'config', msg: '应用自定义参数' });
    return { ok: true, data: s };
  }
  if (p === '/api/run') {
    if (RUNFAIL && body.enable) return { ok: false, reason: 'fake: 限速开关失败' };
    s.limit_on = !!body.enable;
    const key = String(s.preset_key || '');
    if (s.limit_on && key.indexOf('c:') === 0) {
      const c = COMBOS.find((x) => x.id === key.slice(2));
      if (c && c.steps.length) s.profile.name = sceneName(c.steps[0].key);
    }
    push({ seq: 9, t: '12:00:03', type: 'config', msg: body.enable ? '开启限速' : '停止限速' });
    return { ok: true, data: s };
  }
  if (p === '/api/sysproxy') { s.sysproxy = !!body.enable; return { ok: true, data: s }; }
  if (p === '/api/listen') { s.listen.host = body.host; return { ok: true, data: s }; }
  return { ok: false, reason: 'fake: 未实现 ' + p };
};

const noop = () => {};
// 手机（USB）接管的假实现：状态落在 window.__ph，接管后手机代理就是本机 8888
const PERMODE = location.search.indexOf('wnperm') >= 0;
// ?wnforeign=1：手机自己配着别的代理（公司 Wi-Fi 之类），不是本工具写的
const FOREIGN = location.search.indexOf('wnforeign') >= 0;
// ?wnotherheld=1：账本里还挂着另一台手机（接管后下拉框切走了）
const OTHERHELD = location.search.indexOf('wnotherheld') >= 0;
// ?wnrunfail=1：限速开关接口失败，用来验证「接管了但没限速」要回滚手机
const RUNFAIL = location.search.indexOf('wnrunfail') >= 0;
window.__ph = {
  proxy: FOREIGN ? '10.0.0.9:3128' : '', calls: [],
  heldOthers: OTHERHELD ? ['FAKEDEV2'] : [],
};
const OURS = '127.0.0.1:18888';
window.__fakePhone = async (req) => {
  window.__ph.calls.push(req);
  if (req.action === 'connect') {
    if (PERMODE) {
      return { ok: false, stage: 'permission', msg: '手机拒绝了写入系统代理（ROM 权限限制）',
        hint: '请到「开发者选项」打开「禁止权限监控」后重试。' };
    }
    window.__ph.proxy = OURS;
    return { ok: true, deviceId: req.deviceId, port: 18888, proxy: OURS, restoredOnRelease: '' };
  }
  if (req.action === 'disconnect') { window.__ph.proxy = ''; return { ok: true }; }
  if (req.action === 'restore') {
    // 与主进程一致：按「本工具接管过」的记录还原，没接管过就还原 0 台
    const items = window.__ph.proxy === OURS ? [{ ok: true, deviceId: 'FAKEDEV1' }] : [];
    window.__ph.proxy = '';
    return { ok: true, items };
  }
  return { ok: true, deviceId: req.deviceId, proxy: window.__ph.proxy,
    ours: window.__ph.proxy === OURS,
    heldOthers: (window.__ph.heldOthers || []).filter((x) => x !== req.deviceId),
    reverse: window.__ph.proxy === OURS ? ['tcp:18888 tcp:8888'] : [] };
};
const stub = new Proxy({
  weaknetApi: (p, b) => window.__fakeEngine(p, b),
  launchWeaknet: async () => (FAILMODE
    ? { ok: false, reason: '弱网引擎版本过旧，不支持无界面模式（需重新打包 WeakNet.exe）' }
    : { ok: true, ctrlPort: 8899, proxyPort: 8888, version: '1.1.10' }),
  weaknetPhone: (req) => window.__fakePhone(req),
  getDevices: async () => [
    { id: 'FAKEDEV1', displayName: '测试机 A', wifi: false },
    { id: 'FAKEDEV2', displayName: '测试机 B (无线)', wifi: true },
  ],
  onWeaknetEngineExit: noop,
  removeWeaknetEngineExit: noop,
}, {
  get(t, k) {
    if (k in t) return t[k];
    if (typeof k === 'string' && (k.startsWith('on') || k.startsWith('remove'))) return noop;
    return async () => null;
  },
});
window.perfAPI = stub;
`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  await page.addInitScript(FAKE);
  await page.goto('file:///' + PAGE.replace(/\\/g, '/'), { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  // ── 初始态：页面在文档里但隐藏，顶栏按钮是普通态
  const init = await page.evaluate(() => {
    const p = document.getElementById('weaknet-page');
    const b = document.getElementById('btn-weaknet');
    const pa = document.getElementById('btn-wn-pause');
    const st = document.getElementById('btn-wn-stop');
    return { hasPage: !!p, hidden: !!(p && p.hidden), btn: b ? b.textContent.trim() : null,
      on: b ? b.className : '', pauseHidden: !!(pa && pa.hidden), stopHidden: !!(st && st.hidden),
      hasQuick: !!pa && !!st };
  });
  check('二级页面已注入但默认隐藏', init.hasPage && init.hidden, JSON.stringify(init));
  check('顶栏按钮初始文案', init.btn === '≈ 弱网测试', init.btn);
  check('未限速时主界面不显示暂停/停止', init.hasQuick && init.pauseHidden && init.stopHidden,
    JSON.stringify(init));

  // ── 打开
  await page.click('#btn-weaknet');
  await page.waitForTimeout(600);
  const opened = await page.evaluate(() => {
    const p = document.getElementById('weaknet-page');
    return { hidden: p.hidden, scenes: document.querySelectorAll('#wn-presets .wn-scene').length,
      params: document.querySelectorAll('.wn-param').length,
      cats: [...document.querySelectorAll('#wn-presets .wn-cat-t')].map((e) => e.textContent),
      pill: document.getElementById('wn-pill').textContent,
      ver: document.getElementById('wn-ver').textContent,
      scene: document.getElementById('wn-k-scene').textContent,
      scope: document.getElementById('wn-k-scope').textContent,
      logLines: document.querySelectorAll('#wn-log div').length };
  });
  check('点击后页面可见', opened.hidden === false);
  check('场景按钮 4 个', opened.scenes === 4, 'n=' + opened.scenes);
  check('参数输入 3 个', opened.params === 3, 'n=' + opened.params);
  check('场景按分类分组', opened.cats.join('/') === '常规网络/弱网环境/极端环境', opened.cats.join('/'));
  check('状态条读到版本与场景', opened.ver === 'v1.1.10' && opened.scene === '直连（不限制）',
    opened.ver + ' ' + opened.scene);
  check('接管范围默认全部程序', opened.scope === '全部程序', opened.scope);
  check('事件日志有内容', opened.logLines >= 1, 'n=' + opened.logLines);
  await page.screenshot({ path: path.join(OUT, 'page-open.png') });

  // ── 选场景
  await page.click('.wn-scene[data-key="4g_weak"]');
  await page.waitForTimeout(500);
  const sceneOn = await page.evaluate(() => ({
    on: [...document.querySelectorAll('.wn-scene.is-on')].map((e) => e.textContent),
    call: window.__wn.calls.filter((c) => c.path === '/api/preset').pop(),
  }));
  check('选场景调用 /api/preset', sceneOn.call && sceneOn.call.body.key === '4g_weak',
    JSON.stringify(sceneOn.call));
  check('场景高亮跟随 preset_key', sceneOn.on.length === 1 && /4G 弱网/.test(sceneOn.on[0]),
    sceneOn.on.join(','));

  // ── 开限速（没选手机时只开限速，不碰手机）
  await page.selectOption('#wn-phone-dev', '');
  await page.waitForTimeout(200);
  await page.click('#wn-run');
  await page.waitForTimeout(500);
  const running = await page.evaluate(() => ({
    call: window.__wn.calls.filter((c) => c.path === '/api/run').pop(),
    pill: document.getElementById('wn-pill').textContent,
    pillOn: document.getElementById('wn-pill').className,
    run: document.getElementById('wn-run').textContent,
    btn: document.getElementById('btn-weaknet').textContent.trim(),
    btnCls: document.getElementById('btn-weaknet').className,
    phoneTaken: window.__ph.calls.filter((c) => c.action === 'connect').length,
  }));
  check('开限速调用 /api/run {enable:true}', running.call && running.call.body.enable === true,
    JSON.stringify(running.call));
  check('没选手机时开限速不碰手机', running.phoneTaken === 0, 'connect=' + running.phoneTaken);
  check('状态胶囊变限速中', running.pill === '限速中' && /is-on/.test(running.pillOn), running.pill);
  check('按钮变停止限速', /停止限速/.test(running.run), running.run);
  check('顶栏按钮显示限速中', running.btn === '≈ 限速中' && /is-on/.test(running.btnCls),
    running.btn + ' / ' + running.btnCls);

  // ── 自定义参数
  await page.fill('#wn-p-down_kbps', '900');
  await page.click('#wn-apply');
  await page.waitForTimeout(500);
  const custom = await page.evaluate(() => ({
    call: window.__wn.calls.filter((c) => c.path === '/api/profile').pop(),
    apply: document.getElementById('wn-apply').textContent,
    applyCls: document.getElementById('wn-apply').className,
    scene: document.getElementById('wn-k-scene').textContent,
    down: document.getElementById('wn-p-down_kbps').value,
  }));
  check('应用自定义带宽 900', custom.call && custom.call.body.down_kbps === 900, JSON.stringify(custom.call));
  check('应用按钮变「自定义生效中」', custom.apply === '自定义生效中' && /is-on/.test(custom.applyCls),
    custom.apply);
  check('当前场景显示自定义', custom.scene === '自定义', custom.scene);
  check('参数框保留用户输入', custom.down === '900', custom.down);

  // ── 开关
  await page.click('#wn-sys');
  await page.click('#wn-lan');
  await page.waitForTimeout(500);
  const toggles = await page.evaluate(() => ({
    sys: window.__wn.calls.filter((c) => c.path === '/api/sysproxy').pop(),
    lan: window.__wn.calls.filter((c) => c.path === '/api/listen').pop(),
    sysKv: document.getElementById('wn-k-sys').textContent,
  }));
  check('系统代理开关调用 /api/sysproxy', toggles.sys && toggles.sys.body.enable === true,
    JSON.stringify(toggles.sys));
  check('局域网开关调用 /api/listen 0.0.0.0', toggles.lan && toggles.lan.body.host === '0.0.0.0',
    JSON.stringify(toggles.lan));
  check('状态条显示已接管', toggles.sysKv === '已接管', toggles.sysKv);

  // ── 手机（USB）接管：选设备 → 接管 → 自动开限速 → 解除
  await page.selectOption('#wn-phone-dev', 'FAKEDEV1');
  await page.waitForTimeout(300);
  const phoneInit = await page.evaluate(() => ({
    opts: [...document.querySelectorAll('#wn-phone-dev option')].map((o) => o.textContent),
    sel: document.getElementById('wn-phone-dev').value,
    state: document.getElementById('wn-phone-state').textContent,
    btn: document.getElementById('wn-phone').textContent,
  }));
  check('设备下拉已填入手机', phoneInit.opts.length === 3 && phoneInit.sel === 'FAKEDEV1',
    JSON.stringify(phoneInit));
  check('无线机型不重复标「无线」', !/无线.*无线/.test(phoneInit.opts.join('|')),
    JSON.stringify(phoneInit.opts));
  check('初始状态为未接管', /未接管/.test(phoneInit.state) && phoneInit.btn === '接管',
    phoneInit.state + ' / ' + phoneInit.btn);

  await page.click('#wn-phone');
  await page.waitForTimeout(600);
  const phoneOn = await page.evaluate(() => ({
    state: document.getElementById('wn-phone-state').textContent,
    btn: document.getElementById('wn-phone').textContent,
    on: /is-on/.test(document.getElementById('wn-phone').className),
    limit: window.__wn.status.limit_on,
    call: window.__ph.calls.filter((c) => c.action === 'connect').pop(),
  }));
  check('接管调用 connect 并带上设备号', phoneOn.call && phoneOn.call.deviceId === 'FAKEDEV1',
    JSON.stringify(phoneOn.call));
  check('接管后状态显示手机代理与映射', /127\.0\.0\.1:18888/.test(phoneOn.state)
    && /USB 映射已就绪/.test(phoneOn.state), phoneOn.state);
  check('接管后按钮变解除', phoneOn.btn === '解除' && phoneOn.on, phoneOn.btn);
  check('接管顺手打开限速', phoneOn.limit === true, phoneOn.limit);
  await page.screenshot({ path: path.join(OUT, 'page-phone.png') });

  await page.click('#wn-phone');
  await page.waitForTimeout(600);
  const phoneOff = await page.evaluate(() => ({
    state: document.getElementById('wn-phone-state').textContent,
    btn: document.getElementById('wn-phone').textContent,
    call: window.__ph.calls.filter((c) => c.action === 'disconnect').pop(),
  }));
  check('解除调用 disconnect', !!phoneOff.call, JSON.stringify(phoneOff.call));
  check('解除后回到未接管', /未接管/.test(phoneOff.state) && phoneOff.btn === '接管',
    phoneOff.state + ' / ' + phoneOff.btn);
  await page.screenshot({ path: path.join(OUT, 'page-running.png') });

  // ── 弱网组合：列表 / 选中 / 播放进度 / 新建 / 删除
  const comboInit = await page.evaluate(() => ({
    n: document.querySelectorAll('#wn-combos button').length,
    labels: [...document.querySelectorAll('#wn-combos button')].map((b) => b.textContent),
    state: document.getElementById('wn-combo-state').textContent,
  }));
  check('组合卡片列出组合', comboInit.n === 2 && /通勤组合/.test(comboInit.labels.join('|')),
    JSON.stringify(comboInit.labels));
  check('未选中时说明怎么用', /点一支组合/.test(comboInit.state), comboInit.state);

  await page.click('#wn-combos button[data-combo="cmb1"]');
  await page.waitForTimeout(700);
  const comboOn = await page.evaluate(() => ({
    call: window.__wn.calls.filter((c) => c.path === '/api/preset' && c.body
      && c.body.key === 'c:cmb1').pop(),
    on: [...document.querySelectorAll('#wn-combos button.is-on')].map((b) => b.textContent),
    state: document.getElementById('wn-combo-state').textContent,
    scene: document.getElementById('wn-k-scene').textContent,
  }));
  check('点组合调用 /api/preset c:<id>', !!comboOn.call, JSON.stringify(comboOn.call));
  check('选中的组合高亮', comboOn.on.length === 1 && /通勤组合/.test(comboOn.on[0]),
    comboOn.on.join(','));
  check('限速中直接显示播放进度', /第 1\/3 段/.test(comboOn.state) && /4G 弱网/.test(comboOn.state),
    comboOn.state);
  check('进度带剩余时间与循环标记', /还剩 \d+:\d\d/.test(comboOn.state) && /循环/.test(comboOn.state),
    comboOn.state);
  check('当前场景跟随组合段', /4G 弱网/.test(comboOn.scene), comboOn.scene);

  // 引擎到点换段：把 status.profile.name 改成第二段的场景名
  await page.evaluate(() => { window.__wn.status.profile.name = 'Wi-Fi 良好'; });
  await page.waitForTimeout(1500);
  const comboStep2 = await page.evaluate(
    () => document.getElementById('wn-combo-state').textContent);
  check('换段后进度跟着走到第 2 段', /第 2\/3 段/.test(comboStep2) && /Wi-Fi 良好/.test(comboStep2),
    comboStep2);
  await page.screenshot({ path: path.join(OUT, 'page-combo.png') });

  // ── 新建组合：名称 + 段数上限 + 保存
  await page.click('#wn-combo-new');
  await page.waitForTimeout(250);
  const edOpen = await page.evaluate(() => ({
    hidden: document.getElementById('wn-combo-ed').hidden,
    title: document.getElementById('wn-ce-title').textContent,
    rows: document.querySelectorAll('#wn-ce-steps .wn-ce-step').length,
    sceneOpts: [...document.querySelectorAll('#wn-ce-steps select option')].map((o) => o.textContent),
  }));
  check('新建组合打开编辑器', edOpen.hidden === false && /新建/.test(edOpen.title),
    JSON.stringify(edOpen.title));
  check('默认一段，场景含自定义场景', edOpen.rows === 1
    && edOpen.sceneOpts.length >= 5 && /我的自定义场景/.test(edOpen.sceneOpts.join('|')),
  edOpen.sceneOpts.join('|'));

  await page.click('#wn-ce-save');
  await page.waitForTimeout(200);
  const noName = await page.evaluate(() => ({
    err: document.getElementById('wn-ce-err').textContent,
    hidden: document.getElementById('wn-ce-err').hidden,
  }));
  check('没填名字不能保存', noName.hidden === false && /名字/.test(noName.err), noName.err);

  await page.fill('#wn-ce-name', '高峰组合');
  await page.fill('#wn-ce-steps .wn-ce-step:nth-child(1) .wn-ce-min', '1');
  // 已有 1 段，再点 4 次刚好到上限（第 5 段之后按钮会置灰，点不动）
  for (let i = 0; i < 4; i += 1) {
    await page.click('#wn-ce-add');
    await page.waitForTimeout(60);
  }
  const addState = await page.evaluate(() => ({
    rows: document.querySelectorAll('#wn-ce-steps .wn-ce-step').length,
    addDisabled: document.getElementById('wn-ce-add').disabled,
  }));
  check('最多 5 段，到上限禁用添加', addState.rows === 5 && addState.addDisabled === true,
    JSON.stringify(addState));

  await page.click('#wn-ce-save');
  await page.waitForTimeout(800);
  const saved = await page.evaluate(() => ({
    call: window.__wn.calls.filter((c) => c.path === '/api/combo').pop(),
    hidden: document.getElementById('wn-combo-ed').hidden,
    names: [...document.querySelectorAll('#wn-combos button')].map((b) => b.textContent),
  }));
  check('保存调用 /api/combo（新建不带 id）', saved.call && saved.call.body.name === '高峰组合'
    && saved.call.body.steps.length === 5 && !saved.call.body.id,
  JSON.stringify(saved.call && saved.call.body));
  check('保存后编辑器收起', saved.hidden === true);
  check('保存后列表出现新组合', /高峰组合/.test(saved.names.join('|')), saved.names.join('|'));

  // ── 删除：两下确认
  await page.click('#wn-combo-del');
  await page.waitForTimeout(200);
  const armed = await page.evaluate(() => ({
    text: document.getElementById('wn-combo-del').textContent,
    calls: window.__wn.calls.filter((c) => c.path === '/api/combo/delete').length,
  }));
  check('删除要点两下（第一下不删）', armed.text === '确认删除' && armed.calls === 0,
    JSON.stringify(armed));

  await page.click('#wn-combo-del');
  await page.waitForTimeout(800);
  const deleted = await page.evaluate(() => ({
    calls: window.__wn.calls.filter((c) => c.path === '/api/combo/delete').length,
    names: [...document.querySelectorAll('#wn-combos button')].map((b) => b.textContent),
    state: document.getElementById('wn-combo-state').textContent,
    limit: window.__wn.status.limit_on,
  }));
  check('确认后调用 /api/combo/delete', deleted.calls === 1, String(deleted.calls));
  check('删除后列表少一支', deleted.names.length === 2 && !/通勤组合/.test(deleted.names.join('|')),
    deleted.names.join('|'));
  check('删掉正在播的组合后回直连', deleted.limit === false && /点一支组合/.test(deleted.state),
    deleted.state + ' limit=' + deleted.limit);

  // 删除顺带停了限速：重新开回来，后面的「关闭后仍是限速中」才有意义
  // （先清空设备选择：启停按钮会顺手接管下拉框里的手机，这里只要限速）
  await page.selectOption('#wn-phone-dev', '');
  await page.waitForTimeout(200);
  await page.click('#wn-run');
  await page.waitForTimeout(400);

  // ── 关闭（Esc）：页面收起，顶栏还留着「限速中」
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const closed = await page.evaluate(() => ({
    hidden: document.getElementById('weaknet-page').hidden,
    btn: document.getElementById('btn-weaknet').textContent.trim(),
  }));
  check('Esc 关闭页面', closed.hidden === true);
  check('关闭后顶栏仍是限速中', closed.btn === '≈ 限速中', closed.btn);

  // ── 主界面快捷按钮：限速中直接暂停 / 继续 / 停止
  const quick = await page.evaluate(() => ({
    pauseHidden: document.getElementById('btn-wn-pause').hidden,
    stopHidden: document.getElementById('btn-wn-stop').hidden,
    pause: document.getElementById('btn-wn-pause').textContent,
    stop: document.getElementById('btn-wn-stop').textContent,
  }));
  check('限速中主界面出现暂停/停止', quick.pauseHidden === false && quick.stopHidden === false,
    JSON.stringify(quick));
  check('快捷按钮文案', quick.pause === '⏸ 暂停弱网' && quick.stop === '■ 停止弱网',
    quick.pause + ' / ' + quick.stop);
  await page.screenshot({ path: path.join(OUT, 'main-quick-running.png') });

  await page.click('#btn-wn-pause');
  await page.waitForTimeout(500);
  const paused = await page.evaluate(() => {
    const b = document.getElementById('btn-weaknet');
    return {
      call: window.__wn.calls.filter((c) => c.path === '/api/run').pop(),
      limit: window.__wn.status.limit_on,
      preset: window.__wn.status.preset_key,
      sys: window.__wn.status.sysproxy,
      pause: document.getElementById('btn-wn-pause').textContent,
      stopHidden: document.getElementById('btn-wn-stop').hidden,
      btn: b.textContent.trim(),
      btnCls: b.className,
    };
  });
  check('暂停只调 /api/run enable:false', paused.call && paused.call.body.enable === false,
    JSON.stringify(paused.call));
  check('暂停后限速关闭、场景与系统代理保留', paused.limit === false && paused.preset === 'direct'
    && paused.sys === true, 'limit=' + paused.limit + ' preset=' + paused.preset + ' sys=' + paused.sys);
  check('暂停后暂停键变继续、停止键仍在', paused.pause === '▶ 继续弱网'
    && paused.stopHidden === false, paused.pause);
  check('顶栏变成已暂停且带橙色标记', paused.btn === '≈ 已暂停'
    && /is-paused/.test(paused.btnCls) && !/is-on/.test(paused.btnCls), paused.btn + ' / ' + paused.btnCls);
  await page.screenshot({ path: path.join(OUT, 'main-quick-paused.png') });

  await page.click('#btn-wn-pause');
  await page.waitForTimeout(500);
  const resumed = await page.evaluate(() => ({
    call: window.__wn.calls.filter((c) => c.path === '/api/run').pop(),
    limit: window.__wn.status.limit_on,
    pause: document.getElementById('btn-wn-pause').textContent,
    btn: document.getElementById('btn-weaknet').textContent.trim(),
  }));
  check('继续调用 /api/run enable:true 并恢复限速', resumed.call && resumed.call.body.enable === true
    && resumed.limit === true, JSON.stringify(resumed.call));
  check('继续后暂停键与顶栏回到限速态', resumed.pause === '⏸ 暂停弱网'
    && resumed.btn === '≈ 限速中', resumed.pause + ' / ' + resumed.btn);

  // 先接管一台手机，验证「停止」会把手机代理一起还原
  await page.click('#btn-weaknet');
  await page.waitForTimeout(600);
  await page.selectOption('#wn-phone-dev', 'FAKEDEV1');
  await page.waitForTimeout(300);
  await page.click('#wn-phone');
  await page.waitForTimeout(600);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const beforeStop = await page.evaluate(() => ({
    phone: window.__ph.proxy,
    sys: window.__wn.status.sysproxy,
    limit: window.__wn.status.limit_on,
  }));
  check('停止前：手机已接管、系统代理已接管、限速中', beforeStop.phone === '127.0.0.1:18888'
    && beforeStop.sys === true && beforeStop.limit === true, JSON.stringify(beforeStop));

  await page.click('#btn-wn-stop');
  await page.waitForTimeout(900);
  const stopped = await page.evaluate(() => {
    const b = document.getElementById('btn-weaknet');
    const ban = document.getElementById('wn-banner');
    return {
      runCall: window.__wn.calls.filter((c) => c.path === '/api/run').pop(),
      sysCall: window.__wn.calls.filter((c) => c.path === '/api/sysproxy').pop(),
      rest: window.__ph.calls.filter((c) => c.action === 'restore').pop(),
      limit: window.__wn.status.limit_on,
      sys: window.__wn.status.sysproxy,
      phone: window.__ph.proxy,
      pauseHidden: document.getElementById('btn-wn-pause').hidden,
      stopHidden: document.getElementById('btn-wn-stop').hidden,
      btn: b.textContent.trim(),
      btnCls: b.className,
      banner: ban.textContent,
      bannerHidden: ban.hidden,
      bannerOk: ban.classList.contains('is-ok'),
      hint: (() => {
        const h = document.getElementById('wn-quick-hint');
        return { hidden: h.hidden, text: h.textContent, cls: h.className, title: h.title };
      })(),
      logLast: (() => {
        const o = document.getElementById('log-output');
        const l = o && o.lastElementChild;
        return l ? l.textContent : '';
      })(),
    };
  });
  check('停止先关限速', stopped.runCall && stopped.runCall.body.enable === false,
    JSON.stringify(stopped.runCall));
  check('停止解除系统代理', stopped.sysCall && stopped.sysCall.body.enable === false,
    JSON.stringify(stopped.sysCall));
  check('停止还原手机代理（restore，不带设备号）', stopped.rest && !stopped.rest.deviceId,
    JSON.stringify(stopped.rest));
  check('停止后限速关、系统代理关、手机代理清空', stopped.limit === false && stopped.sys === false
    && stopped.phone === '', JSON.stringify({ l: stopped.limit, s: stopped.sys, p: stopped.phone }));
  check('停止后快捷按钮收起、顶栏回到弱网测试', stopped.pauseHidden === true
    && stopped.stopHidden === true && stopped.btn === '≈ 弱网测试' && !/is-(on|paused)/.test(stopped.btnCls),
  stopped.btn + ' / ' + stopped.btnCls);
  check('停止后主界面给出绿色结果提示', stopped.hint.hidden === false
    && /is-ok/.test(stopped.hint.cls) && stopped.hint.text === '弱网已停止'
    && /手机代理已还原（1 台）/.test(stopped.hint.title), stopped.hint.text + ' / ' + stopped.hint.title);
  check('停止明细写进日志面板', /已停止弱网/.test(stopped.logLast)
    && /系统代理已解除/.test(stopped.logLast), stopped.logLast);
  check('停止后页面提示条留档说明收回了哪些', stopped.bannerHidden === false && stopped.bannerOk
    && /已停止弱网/.test(stopped.banner) && /系统代理已解除/.test(stopped.banner)
    && /手机代理已还原（1 台）/.test(stopped.banner), stopped.banner);
  await page.screenshot({ path: path.join(OUT, 'main-quick-stopped.png') });

  // ── 单一启停按钮与「跟随性能采集」：一键接管 + 开限速 / 随采集起停 ──────────
  await page.click('#btn-weaknet');
  await page.waitForTimeout(600);
  const runBtn = await page.evaluate(() => {
    const b = document.getElementById('wn-run');
    return { exists: !!b, text: b ? b.textContent.trim() : '', disabled: b ? b.disabled : null,
      oldNow: !!document.getElementById('wn-now') };
  });
  check('页头只剩一个启停按钮（「立即开始」已合并）', runBtn.exists
    && runBtn.text === '▶ 开启限速' && !runBtn.disabled && !runBtn.oldNow,
  JSON.stringify(runBtn));

  await page.click('#wn-run');
  await page.waitForTimeout(900);
  const started = await page.evaluate(() => ({
    run: window.__wn.calls.filter((c) => c.path === '/api/run').pop(),
    phone: window.__ph.calls.filter((c) => c.action === 'connect').pop(),
    limit: window.__wn.status.limit_on,
    pill: document.getElementById('wn-pill').textContent,
    banner: document.getElementById('wn-banner').textContent,
    bannerOk: document.getElementById('wn-banner').classList.contains('is-ok'),
    runText: document.getElementById('wn-run').textContent.trim(),
    btn: document.getElementById('btn-weaknet').textContent.trim(),
  }));
  check('一键开始：调 /api/run enable:true', started.run && started.run.body.enable === true,
    JSON.stringify(started.run));
  check('一键开始：顺手接管所选手机', started.phone && started.phone.deviceId === 'FAKEDEV1',
    JSON.stringify(started.phone));
  check('一键开始后限速中、提示成功', started.limit === true && started.pill === '限速中'
    && /弱网已开始/.test(started.banner) && started.bannerOk,
  started.pill + ' / ' + started.banner);
  check('限速中按钮变「■ 停止限速」', started.runText === '■ 停止限速', started.runText);
  await page.screenshot({ path: path.join(OUT, 'page-start.png') });

  // 停掉限速，再打开跟随：顶栏要能看出「只开了跟随」
  await page.click('#wn-run');
  await page.waitForTimeout(500);
  await page.click('#wn-follow');
  await page.waitForTimeout(500);
  const followOn = await page.evaluate(() => {
    const b = document.getElementById('btn-weaknet');
    return {
      followText: document.getElementById('wn-follow').textContent.trim(),
      followOn: /is-on/.test(document.getElementById('wn-follow').className),
      top: b.textContent.trim(),
      topCls: b.className,
      stored: localStorage.getItem('perfara.weaknet.follow'),
      limit: window.__wn.status.limit_on,
    };
  });
  check('跟随开关打开并记住状态', followOn.followText === '已开启' && followOn.followOn
    && followOn.stored === '1', JSON.stringify(followOn));
  check('只开跟随时顶栏显示「弱网·跟随」', followOn.top === '≈ 弱网·跟随'
    && /is-follow/.test(followOn.topCls) && followOn.limit === false,
  followOn.top + ' / ' + followOn.topCls);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'main-follow.png') });

  // 采集主界面「开始」时也会调这个入口；这里直接调用同一入口验证编排
  // 先解除手机接管，证明跟随开始时会自己接管回来
  await page.evaluate(async () => {
    await window.perfAPI.weaknetPhone({ action: 'disconnect', deviceId: 'FAKEDEV1' });
    window.__ph.calls.length = 0;
  });
  const followStart = await page.evaluate(async () => {
    const r = await window.weaknetFollow.onCollectStart('FAKEDEV1');
    return { r, limit: window.__wn.status.limit_on,
      phone: window.__ph.calls.filter((c) => c.action === 'connect').pop() };
  });
  check('跟随采集：开始采集同时接管手机 + 开限速',
    followStart.r && followStart.r.ok === true && followStart.limit === true
    && followStart.phone && followStart.phone.deviceId === 'FAKEDEV1',
    JSON.stringify(followStart));

  const followStop = await page.evaluate(async () => {
    const r = await window.weaknetFollow.onCollectStop();
    return { r, limit: window.__wn.status.limit_on, phone: window.__ph.proxy,
      rest: window.__ph.calls.filter((c) => c.action === 'restore').pop() };
  });
  check('跟随采集：停止采集一起收掉限速与手机代理',
    followStop.r && followStop.r.ok === true && followStop.limit === false
    && followStop.phone === '' && !!followStop.rest, JSON.stringify(followStop));

  // 关掉跟随，避免影响后面的页面
  await page.evaluate(() => { if (window.weaknetFollow.isOn()) document.getElementById('wn-follow').click(); });
  await page.waitForTimeout(300);
  const followOff = await page.evaluate(() => ({
    on: window.weaknetFollow.isOn(), top: document.getElementById('btn-weaknet').textContent.trim(),
    stored: localStorage.getItem('perfara.weaknet.follow'),
  }));
  check('跟随开关可关闭并复位顶栏', followOff.on === false && followOff.top === '≈ 弱网测试'
    && followOff.stored === '0', JSON.stringify(followOff));

  // ── 引擎起不来：提示条要说出原因（?wnfail=1 让注入的假 perfAPI 直接失败）
  await page.goto('file:///' + PAGE.replace(/\\/g, '/') + '?wnfail=1', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.click('#btn-weaknet');
  await page.waitForTimeout(600);
  const failed = await page.evaluate(() => ({
    banner: document.getElementById('wn-banner').textContent,
    shown: !document.getElementById('wn-banner').hidden,
    pill: document.getElementById('wn-pill').textContent,
    runDisabled: document.getElementById('wn-run').disabled,
  }));
  check('引擎启动失败显示提示条', failed.shown && /版本过旧/.test(failed.banner), failed.banner);
  check('失败时胶囊为引擎未启动', failed.pill === '引擎未启动', failed.pill);
  check('失败时禁用操作按钮', failed.runDisabled === true);

  // ── ROM 拒写：接管失败要把原因和操作指引摆出来（?wnperm=1）
  await page.goto('file:///' + PAGE.replace(/\\/g, '/') + '?wnperm=1', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.click('#btn-weaknet');
  await page.waitForTimeout(600);
  await page.click('#wn-phone');
  await page.waitForTimeout(600);
  const phoneDenied = await page.evaluate(() => ({
    state: document.getElementById('wn-phone-state').textContent,
    bad: /is-bad/.test(document.getElementById('wn-phone-state').className),
    btn: document.getElementById('wn-phone').textContent,
  }));
  check('接管被拒要显示原因', /ROM 权限限制/.test(phoneDenied.state) && phoneDenied.bad,
    phoneDenied.state);
  check('接管被拒给出「禁止权限监控」指引', /禁止权限监控/.test(phoneDenied.state),
    phoneDenied.state);
  check('接管失败按钮仍是接管', phoneDenied.btn === '接管', phoneDenied.btn);

  // ── 手机自带代理：不能显示成「已接管」，也不能给一键解除去删人家配置（?wnforeign=1）
  await page.goto('file:///' + PAGE.replace(/\\/g, '/') + '?wnforeign=1', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.click('#btn-weaknet');
  await page.waitForTimeout(600);
  const phoneForeign = await page.evaluate(() => ({
    state: document.getElementById('wn-phone-state').textContent,
    bad: /is-bad/.test(document.getElementById('wn-phone-state').className),
    btn: document.getElementById('wn-phone').textContent,
    on: /is-on/.test(document.getElementById('wn-phone').className),
  }));
  check('自带代理不算已接管', phoneForeign.btn === '接管' && phoneForeign.on === false,
    phoneForeign.btn + ' / is-on=' + phoneForeign.on);
  check('自带代理要把原值告诉用户', /10\.0\.0\.9:3128/.test(phoneForeign.state), phoneForeign.state);
  check('自带代理不是报错态', phoneForeign.bad === false, phoneForeign.state);

  // ── 账本里还挂着另一台手机：下拉框切走后要提示「一起还原」（?wnotherheld=1）
  await page.goto('file:///' + PAGE.replace(/\\/g, '/') + '?wnotherheld=1', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.click('#btn-weaknet');
  await page.waitForTimeout(600);
  const otherHeld = await page.evaluate(() => document.getElementById('wn-phone-state').textContent);
  check('账本里有别的手机要提示', /另一台手机还挂着代理/.test(otherHeld), otherHeld);
  await page.selectOption('#wn-phone-dev', 'FAKEDEV2');
  await page.waitForTimeout(300);
  await page.click('#wn-phone');
  await page.waitForTimeout(400);
  const otherHeldAfter = await page.evaluate(() => ({
    connected: window.__ph.calls.filter((c) => c.action === 'connect').map((c) => c.deviceId),
    btn: document.getElementById('wn-phone').textContent,
  }));
  check('切走下拉框后接管的是选中的那台',
    otherHeldAfter.connected[0] === 'FAKEDEV2' && otherHeldAfter.btn === '解除',
    JSON.stringify(otherHeldAfter));

  // ── 限速开不起来：刚接管的手机要退回去，不留「接管着但没限速」（?wnrunfail=1）
  await page.goto('file:///' + PAGE.replace(/\\/g, '/') + '?wnrunfail=1', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.click('#btn-weaknet');
  await page.waitForTimeout(600);
  await page.click('#wn-run');
  await page.waitForTimeout(600);
  const startFail = await page.evaluate(() => ({
    banner: document.getElementById('wn-banner').textContent,
    proxy: window.__ph.proxy,
    disc: window.__ph.calls.filter((c) => c.action === 'disconnect').length,
  }));
  check('开启限速失败要回滚手机代理', /开启限速失败/.test(startFail.banner)
    && /已还原手机代理/.test(startFail.banner) && startFail.proxy === '' && startFail.disc === 1,
  JSON.stringify(startFail));

  // 跟随采集同理：限速失败 → 手机退回去，本次按直连采
  await page.evaluate(() => {
    window.__ph.proxy = '';
    window.__ph.calls.length = 0;
    if (!window.weaknetFollow.isOn()) document.getElementById('wn-follow').click();
  });
  await page.waitForTimeout(300);
  const followFail = await page.evaluate(async () => {
    const r = await window.weaknetFollow.onCollectStart('FAKEDEV1');
    return { r, proxy: window.__ph.proxy,
      disc: window.__ph.calls.filter((c) => c.action === 'disconnect').length };
  });
  check('跟随采集失败要回滚手机代理', followFail.r && followFail.r.ok === false
    && /已还原手机代理/.test(followFail.r.msg) && followFail.proxy === '' && followFail.disc === 1,
  JSON.stringify(followFail));

  await browser.close();

  const bad = checks.filter((c) => !c.ok);
  console.log('\n通过 ' + (checks.length - bad.length) + ' / ' + checks.length);
  if (errors.length) console.log('页面 JS 错误: ' + JSON.stringify(errors.slice(0, 5)));
  if (bad.length) {
    console.log('失败：' + bad.map((b) => b.name).join(' ; '));
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
