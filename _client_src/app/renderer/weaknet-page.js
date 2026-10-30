'use strict';

/**
 * 弱网测试二级页面。
 *
 * 引擎（WeakNet）以无窗口方式随 Perfara 启动，这里只做界面：
 *   renderer → perfAPI.weaknetApi() → 主进程(src/weaknet-host.js) → 引擎控制接口。
 * 不直接 fetch，因为控制接口没有 CORS 头，页面里发请求会被浏览器拦掉。
 *
 * 页面是覆盖式的：返回采集不会停引擎、也不会停限速，采集可以照常进行；
 * 顶栏按钮在限速期间变成绿色「≈ 限速中」，回到主界面也知道现在还被限着。
 */
(function initWeaknetPage() {
  const btn = document.getElementById('btn-weaknet');
  const btnPause = document.getElementById('btn-wn-pause');
  const btnStop = document.getElementById('btn-wn-stop');
  const btnHint = document.getElementById('wn-quick-hint');
  let hintTimer = null;
  if (!btn || !window.perfAPI || typeof window.perfAPI.weaknetApi !== 'function') return;

  const OPEN_POLL_MS = 1000;
  const IDLE_POLL_MS = 4000;
  /** 与引擎 spec 的 combo 上限一致：段数、单段分/秒 */
  const MAX_COMBO_STEPS = 5;
  const MAX_STEP_MIN = 600;
  const MAX_STEP_SEC = 59;
  const FOLLOW_KEY = 'perfara.weaknet.follow';

  const st = {
    dom: null,
    open: false,
    ready: false,          // 引擎握手成功、可以发控制请求
    busy: false,           // 有一次请求在飞，避免连点
    status: null,
    paramDefs: null,
    paramSig: '',
    timer: null,
    engineMsg: '',
    bannerUntil: 0,        // 「停止弱网」这类一次性说明的到期时刻，轮询清屏时别把它冲掉
    paused: false,         // 从主界面暂停过：引擎 limit_on 已是 false，但接管都还留着
    follow: false,         // 跟随性能采集：点「开始」时同步开限速，停止时一起收掉
    devices: [],
    phoneOn: false,
    sceneOpts: [],         // 组合编辑器里的场景下拉（内置 + 自定义）
    combos: [],            // 弱网组合列表
    comboSig: '',
    editing: '',           // 编辑器正在编辑的组合 id，空 = 新建
    editorOpen: false,
    delArmed: '',          // 删除按钮的两步确认：记住已经确认过的组合 id
    play: null,            // 组合播放的本地进度（段索引 + 该段开始时刻）
  };
  try { st.follow = localStorage.getItem(FOLLOW_KEY) === '1'; } catch (_) { st.follow = false; }

  const $ = (id) => document.getElementById(id);

  // ── DOM ────────────────────────────────────────────────────────────────────
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function buildDom() {
    if (st.dom) return st.dom;
    const page = el('section', 'wn-page');
    page.id = 'weaknet-page';
    page.hidden = true;

    // 页头
    const head = el('div', 'wn-head');
    const back = el('button', 'wn-back', '← 返回采集');
    back.id = 'wn-back';
    back.type = 'button';
    back.title = '返回采集界面（不会停止限速）';
    const title = el('div', 'wn-title', '弱网测试');
    const ver = el('span', 'wn-ver', '');
    ver.id = 'wn-ver';
    title.appendChild(ver);
    const spacer = el('div', 'wn-spacer');
    const pill = el('span', 'wn-pill', '引擎未启动');
    pill.id = 'wn-pill';
    // 唯一的启停按钮：拉起引擎 → 接管所选手机 → 开启限速，一次点完
    const run = el('button', 'wn-btn wn-btn-primary', '▶ 开启限速');
    run.id = 'wn-run';
    run.type = 'button';
    head.append(back, title, spacer, pill, run);

    // 提示条
    const banner = el('div', 'wn-banner', '');
    banner.id = 'wn-banner';
    banner.hidden = true;

    // 状态条
    const sub = el('div', 'wn-sub');
    [['wn-k-scene', '当前场景'], ['wn-k-listen', '代理'], ['wn-k-conns', '连接 / 活跃'],
      ['wn-k-rate', '下行 / 上行'], ['wn-k-sys', '系统代理'], ['wn-k-scope', '接管范围']]
      .forEach(([id, label]) => {
        const kv = el('div', 'wn-kv');
        kv.appendChild(el('label', null, label));
        const v = el('span', null, '--');
        v.id = id;
        kv.appendChild(v);
        sub.appendChild(kv);
      });

    // 主体
    const body = el('div', 'wn-body');
    const left = el('div', 'wn-col');
    const cardScene = el('div', 'wn-card');
    const sceneH = el('div', 'wn-card-h');
    sceneH.appendChild(el('span', null, '场景预设'));
    sceneH.appendChild(el('span', 'wn-hint', '选中即生效（限速开启时立即按新参数跑）'));
    const scenes = el('div', null, '');
    scenes.id = 'wn-presets';
    cardScene.append(sceneH, scenes);

    // 弱网组合：把几段场景排成一条链，按时间轴自动切换
    const cardCombo = el('div', 'wn-card');
    const comboH = el('div', 'wn-card-h');
    comboH.appendChild(el('span', null, '弱网组合'));
    comboH.appendChild(el('span', 'wn-hint', '多段场景按顺序播放'));
    comboH.appendChild(el('div', 'wn-spacer'));
    const comboNew = el('button', 'wn-mini', '＋ 新建');
    comboNew.id = 'wn-combo-new';
    comboNew.type = 'button';
    comboNew.addEventListener('click', () => openComboEditor(null));
    comboH.appendChild(comboNew);
    const combos = el('div', 'wn-scenes');
    combos.id = 'wn-combos';
    const comboState = el('div', 'wn-note wn-combo-state', '');
    comboState.id = 'wn-combo-state';
    const comboActions = el('div', 'wn-combo-actions');
    comboActions.id = 'wn-combo-actions';
    comboActions.hidden = true;
    const comboEdit = el('button', 'wn-mini', '编辑');
    comboEdit.id = 'wn-combo-edit';
    comboEdit.type = 'button';
    comboEdit.addEventListener('click', () => {
      const c = comboOf(st.status && st.status.preset_key);
      if (c) openComboEditor(c.id);
    });
    const comboDel = el('button', 'wn-mini', '删除');
    comboDel.id = 'wn-combo-del';
    comboDel.type = 'button';
    comboDel.addEventListener('click', () => {
      const c = comboOf(st.status && st.status.preset_key);
      if (c) armDeleteCombo(c.id);
    });
    comboActions.append(comboEdit, comboDel);
    const comboEd = buildComboEditor();
    cardCombo.append(comboH, combos, comboState, comboActions, comboEd);

    const cardParam = el('div', 'wn-card');
    const paramH = el('div', 'wn-card-h');
    paramH.appendChild(el('span', null, '自定义参数'));
    paramH.appendChild(el('span', 'wn-hint', '0 = 不限制'));
    paramH.appendChild(el('div', 'wn-spacer'));
    const apply = el('button', 'wn-mini', '应用到当前');
    apply.id = 'wn-apply';
    apply.type = 'button';
    paramH.appendChild(apply);
    const params = el('div', 'wn-params');
    params.id = 'wn-params';
    cardParam.append(paramH, params);

    const cardTip = el('div', 'wn-card');
    const tipH = el('div', 'wn-card-h');
    tipH.appendChild(el('span', null, '使用提示'));
    const tipList = el('div', 'wn-note wn-tips');
    tipList.innerHTML = '<div>· 限速只改变网络路径，adb / USB 采集链路不受影响，可以边限速边采集。</div>'
      + '<div>· 手机走 USB 接管（推荐）：插上数据线，在右侧「手机（USB 直连）」里选设备点「接管」，手机不用装任何 App。</div>'
      + '<div>· 采集期间开启的弱网时段会写进报告，报告页对应生成「弱网总结分析」。</div>'
      + '<div>· 「返回采集」不会停引擎；退出 Perfara 时会停掉它拉起的引擎、解除系统代理并还原手机代理。</div>';
    cardTip.append(tipH, tipList);
    left.append(cardScene, cardCombo, cardParam, cardTip);

    const right = el('div', 'wn-col');
    const cardSwitch = el('div', 'wn-card');
    // 跟随性能采集：弱网不再单独开关，跟着「开始 / 停止采集」一起生效
    const swFollow = el('div', 'wn-switch');
    swFollow.appendChild(el('span', null, '跟随性能采集（开始采集时同步开弱网）'));
    const follow = el('button', 'wn-mini', '关闭');
    follow.id = 'wn-follow';
    follow.type = 'button';
    follow.title = '开启后：点「开始」采集时自动接管当前设备并开启限速，停止采集时一起收掉';
    swFollow.appendChild(follow);
    const swLan = el('div', 'wn-switch');
    swLan.appendChild(el('span', null, '局域网访问（给手机用）'));
    const lan = el('button', 'wn-mini', '开启');
    lan.id = 'wn-lan';
    lan.type = 'button';
    swLan.appendChild(lan);
    const swSys = el('div', 'wn-switch');
    swSys.appendChild(el('span', null, '接管本机流量（系统代理）'));
    const sys = el('button', 'wn-mini', '接管');
    sys.id = 'wn-sys';
    sys.type = 'button';
    swSys.appendChild(sys);
    cardSwitch.append(swFollow, swLan, swSys);

    // 手机（USB）接管：只用 adb，手机不装任何 App
    const cardPhone = el('div', 'wn-card');
    const phoneH = el('div', 'wn-card-h');
    phoneH.appendChild(el('span', null, '手机（USB 直连）'));
    phoneH.appendChild(el('span', 'wn-hint', '不用装 App'));
    phoneH.appendChild(el('div', 'wn-spacer'));
    const phoneBtn = el('button', 'wn-mini', '接管');
    phoneBtn.id = 'wn-phone';
    phoneBtn.type = 'button';
    phoneH.appendChild(phoneBtn);
    const phoneRow = el('div', 'wn-switch');
    const phoneDev = el('select', 'wn-select');
    phoneDev.id = 'wn-phone-dev';
    phoneRow.appendChild(phoneDev);
    const phoneState = el('div', 'wn-note wn-phone-state', '未选择设备');
    phoneState.id = 'wn-phone-state';
    const phoneNote = el('div', 'wn-note', '');
    phoneNote.innerHTML = '走 <code>adb reverse</code> + 手机系统代理接管，插上 USB 就能用；'
      + '引擎没起时点「接管」会自动把它拉起来。'
      + '只对读系统代理的程序生效；自己开 TCP/UDP 的程序（多数手游）不走代理，限不到。'
      + '被代理的流量在手机上走回环，采集里的上下行统计不到，以 WeakNet 的代理流量为准。';
    cardPhone.append(phoneH, phoneRow, phoneState, phoneNote);

    const cardLog = el('div', 'wn-card wn-grow');
    const logH = el('div', 'wn-card-h');
    logH.appendChild(el('span', null, '事件日志'));
    const log = el('div', 'wn-log');
    log.id = 'wn-log';
    cardLog.append(logH, log);
    right.append(cardSwitch, cardPhone, cardLog);

    body.append(left, right);
    page.append(head, banner, sub, body);
    document.body.appendChild(page);

    back.addEventListener('click', close);
    run.addEventListener('click', () => toggleRun());
    follow.addEventListener('click', () => setFollow(!st.follow));
    apply.addEventListener('click', () => applyProfile());
    lan.addEventListener('click', () => toggleListen());
    sys.addEventListener('click', () => toggleSysproxy());
    phoneBtn.addEventListener('click', () => togglePhone());
    phoneDev.addEventListener('change', () => refreshPhone());
    page.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });

    st.dom = { page, back, run, follow, pill, ver, banner, scenes, params, apply, lan, sys,
      phoneDev, phoneBtn, phoneState, log, combos, comboState, comboActions,
      comboNew, comboEdit, comboDel, comboEd };
    paintFollow();
    return st.dom;
  }

  // ── 与引擎通信 ─────────────────────────────────────────────────────────────
  async function api(path, body) {
    const r = await window.perfAPI.weaknetApi(path, body);
    if (!r || !r.ok) throw new Error((r && r.reason) || '弱网引擎未响应');
    return r.data;
  }

  function setBanner(msg, kind, ttlMs) {
    st.engineMsg = msg || '';
    st.bannerUntil = st.engineMsg && ttlMs ? Date.now() + ttlMs : 0;
    const d = buildDom();
    d.banner.textContent = st.engineMsg;
    d.banner.hidden = !st.engineMsg;
    d.banner.classList.toggle('is-ok', kind === 'ok');
  }

  /** 主界面的操作结果：一行短句，明细放悬停提示，8 秒后自己消失 */
  function showQuickHint(text, bad, detail) {
    if (!btnHint) return;
    btnHint.textContent = text;
    btnHint.title = detail || text;
    btnHint.className = 'wn-quick-hint ' + (bad ? 'is-bad' : 'is-ok');
    btnHint.hidden = false;
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { btnHint.hidden = true; }, 8000);
  }

  async function ensureEngine() {
    const d = buildDom();
    if (!st.ready) {
      d.pill.textContent = '启动中…';
      const r = await window.perfAPI.launchWeaknet();
      if (!r || !r.ok) {
        st.ready = false;
        setBanner('弱网引擎启动失败：' + ((r && r.reason) || '未知错误'));
        d.pill.textContent = '引擎未启动';
        return false;
      }
      st.ready = true;
      setBanner('');
    }
    // 场景/参数是静态定义，只取一次；静默探测命中既有引擎时也要补这一步
    if (!st.paramDefs) {
      try {
        await loadStatic();
        await loadCombos();
      } catch (e) {
        setBanner('读取场景/参数失败：' + (e.message || e));
      }
    }
    return true;
  }

  /** 场景与参数定义是静态的，取一次即可 */
  async function loadStatic() {
    const d = buildDom();
    const [presets, params] = await Promise.all([api('/api/presets'), api('/api/params')]);
    st.paramDefs = (params && params.items) || [];

    // 组合编辑器要能选到「自定义场景」（WeakNet 图形界面里存的），老引擎没有这个接口
    let ups = [];
    try {
      const r = await api('/api/upresets');
      ups = (r && r.items) || [];
    } catch (_) {}
    st.sceneOpts = (presets || []).map((p) => ({ key: p.key, name: p.name, cat: p.cat }));
    ups.forEach((u) => {
      st.sceneOpts.push({ key: 'u:' + u.id, name: u.name, cat: '自定义场景' });
    });

    const cats = [];
    const byCat = new Map();
    (presets || []).forEach((p) => {
      if (!byCat.has(p.cat)) { byCat.set(p.cat, []); cats.push(p.cat); }
      byCat.get(p.cat).push(p);
    });
    const frag = document.createDocumentFragment();
    cats.forEach((cat) => {
      const box = el('div', 'wn-cat');
      box.appendChild(el('div', 'wn-cat-t', cat));
      const row = el('div', 'wn-scenes');
      byCat.get(cat).forEach((p) => {
        const b = el('button', 'wn-scene', p.name);
        b.type = 'button';
        b.dataset.key = p.key;
        b.addEventListener('click', () => selectScene(p.key));
        row.appendChild(b);
      });
      box.appendChild(row);
      frag.appendChild(box);
    });
    d.scenes.replaceChildren(frag);

    const pFrag = document.createDocumentFragment();
    st.paramDefs.forEach((p) => {
      const wrap = el('div', 'wn-param');
      const lab = el('label', null, p.label);
      lab.htmlFor = 'wn-p-' + p.key;
      const inp = el('input');
      inp.type = 'number';
      inp.id = 'wn-p-' + p.key;
      inp.min = String(p.min);
      inp.max = String(p.max);
      inp.step = String(p.step);
      inp.value = String(p.default);
      const unit = el('span', 'wn-unit', p.unit || '');
      wrap.append(lab, inp, unit);
      pFrag.appendChild(wrap);
    });
    d.params.replaceChildren(pFrag);
  }

  async function selectScene(key) {
    if (st.busy) return;
    await guard(async () => {
      await api('/api/preset', { key });
    });
  }

  // ── 弱网组合 ───────────────────────────────────────────────────────────────
  // 引擎按 steps 的时间轴自己切场景，页面只负责：选、编辑、看进度。
  // 进度没有独立接口，用「当前 profile.name 落在第几段」对齐，再按该段时长倒数。

  function sceneName(key) {
    const o = st.sceneOpts.find((x) => x.key === key);
    return o ? o.name : String(key || '');
  }

  function stepSeconds(step) {
    return Math.max(0, (Number(step && step.minutes) || 0) * 60
      + (Number(step && step.seconds) || 0));
  }

  function fmtClock(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function comboOf(key) {
    const k = String(key || '');
    if (k.indexOf('c:') !== 0) return null;
    return (st.combos || []).find((c) => c.id === k.slice(2)) || null;
  }

  function buildComboEditor() {
    const box = el('div', 'wn-combo-ed');
    box.id = 'wn-combo-ed';
    box.hidden = true;
    const title = el('div', 'wn-combo-ed-t', '新建弱网组合');
    title.id = 'wn-ce-title';

    const rowName = el('div', 'wn-ce-row');
    const lab = el('label', null, '名称');
    lab.htmlFor = 'wn-ce-name';
    const name = el('input', 'wn-ce-name');
    name.id = 'wn-ce-name';
    name.type = 'text';
    name.maxLength = 24;
    name.placeholder = '例如：通勤路上';
    rowName.append(lab, name);

    const loopRow = el('label', 'wn-ce-loop');
    const loop = el('input');
    loop.type = 'checkbox';
    loop.id = 'wn-ce-loop';
    loopRow.append(loop, el('span', null, '播完回到第一段（不勾则停在最后一段）'));

    const stepsH = el('div', 'wn-cat-t', '按顺序播放（最多 ' + MAX_COMBO_STEPS + ' 段，每段都要有时长）');
    const steps = el('div', 'wn-ce-steps');
    steps.id = 'wn-ce-steps';
    const add = el('button', 'wn-mini', '＋ 添加一段');
    add.id = 'wn-ce-add';
    add.type = 'button';
    add.addEventListener('click', () => { addComboStep(null); syncComboEditor(); });

    const err = el('div', 'wn-ce-err');
    err.id = 'wn-ce-err';
    err.hidden = true;

    const bar = el('div', 'wn-ce-bar');
    const save = el('button', 'wn-btn wn-btn-primary', '保存');
    save.id = 'wn-ce-save';
    save.type = 'button';
    save.addEventListener('click', () => saveCombo());
    const cancel = el('button', 'wn-mini', '取消');
    cancel.id = 'wn-ce-cancel';
    cancel.type = 'button';
    cancel.addEventListener('click', () => closeComboEditor());
    bar.append(save, cancel);

    box.append(title, rowName, loopRow, stepsH, steps, add, err, bar);
    return box;
  }

  function addComboStep(step) {
    const box = $('wn-ce-steps');
    if (!box) return;
    const row = el('div', 'wn-ce-step');
    const num = el('span', 'wn-ce-n', String(box.children.length + 1));

    const sel = el('select', 'wn-select wn-ce-scene');
    const cats = [];
    const byCat = new Map();
    st.sceneOpts.forEach((o) => {
      if (!byCat.has(o.cat)) { byCat.set(o.cat, []); cats.push(o.cat); }
      byCat.get(o.cat).push(o);
    });
    cats.forEach((cat) => {
      const g = document.createElement('optgroup');
      g.label = cat;
      byCat.get(cat).forEach((o) => {
        const op = document.createElement('option');
        op.value = o.key;
        op.textContent = o.name;
        g.appendChild(op);
      });
      sel.appendChild(g);
    });
    if (step && step.key) sel.value = step.key;
    else if (st.sceneOpts.length) {
      const first = st.sceneOpts.find((o) => o.key !== 'direct') || st.sceneOpts[0];
      sel.value = first.key;
    }

    const min = el('input', 'wn-ce-num wn-ce-min');
    min.type = 'number';
    min.min = '0';
    min.max = String(MAX_STEP_MIN);
    min.value = String(step ? (Number(step.minutes) || 0) : 0);
    const sec = el('input', 'wn-ce-num wn-ce-sec');
    sec.type = 'number';
    sec.min = '0';
    sec.max = String(MAX_STEP_SEC);
    sec.value = String(step ? (Number(step.seconds) || 0) : 30);

    const del = el('button', 'wn-mini wn-ce-del', '✕');
    del.type = 'button';
    del.title = '删掉这一段';
    del.addEventListener('click', () => {
      row.remove();
      renumberSteps();
      syncComboEditor();
    });

    row.append(num, sel, min, el('span', 'wn-ce-unit', '分'),
      sec, el('span', 'wn-ce-unit', '秒'), del);
    box.appendChild(row);
  }

  function renumberSteps() {
    const box = $('wn-ce-steps');
    if (!box) return;
    Array.prototype.forEach.call(box.children, (row, i) => {
      const n = row.querySelector('.wn-ce-n');
      if (n) n.textContent = String(i + 1);
    });
  }

  function setComboErr(msg) {
    const box = $('wn-ce-err');
    if (!box) return;
    box.textContent = msg || '';
    box.hidden = !msg;
  }

  /** 段数到上限就把「添加一段」置灰，别让人排到第 6 段再被引擎退回 */
  function syncComboEditor() {
    const box = $('wn-ce-steps');
    const add = $('wn-ce-add');
    if (!box || !add) return;
    add.disabled = !st.ready || st.busy || box.children.length >= MAX_COMBO_STEPS;
  }

  function openComboEditor(id) {
    buildDom();
    const combo = id ? (st.combos || []).find((c) => c.id === id) : null;
    st.editing = combo ? combo.id : '';
    $('wn-ce-title').textContent = combo ? '编辑弱网组合' : '新建弱网组合';
    $('wn-ce-name').value = combo ? combo.name : '';
    $('wn-ce-loop').checked = !!(combo && combo.loop);
    const steps = (combo && Array.isArray(combo.steps) && combo.steps.length)
      ? combo.steps : [{ key: '', minutes: 0, seconds: 30 }];
    $('wn-ce-steps').replaceChildren();
    steps.slice(0, MAX_COMBO_STEPS).forEach((x) => addComboStep(x));
    setComboErr('');
    st.dom.comboEd.hidden = false;
    st.editorOpen = true;
    syncComboEditor();
    $('wn-ce-name').focus();
  }

  function closeComboEditor() {
    st.editorOpen = false;
    st.editing = '';
    if (st.dom && st.dom.comboEd) st.dom.comboEd.hidden = true;
    setComboErr('');
  }

  async function saveCombo() {
    if (st.busy) return;
    const name = ($('wn-ce-name').value || '').trim();
    if (!name) { setComboErr('先给组合起个名字'); return; }
    const rows = Array.prototype.slice.call($('wn-ce-steps').children);
    const steps = rows.map((r) => ({
      key: r.querySelector('.wn-ce-scene').value,
      minutes: Math.max(0, Math.min(MAX_STEP_MIN, Number(r.querySelector('.wn-ce-min').value) || 0)),
      seconds: Math.max(0, Math.min(MAX_STEP_SEC, Number(r.querySelector('.wn-ce-sec').value) || 0)),
    })).filter((s) => s.key && stepSeconds(s) > 0);
    if (!steps.length) { setComboErr('至少要有一段时长大于 0'); return; }
    setComboErr('');
    await guard(async () => {
      const body = { name, loop: $('wn-ce-loop').checked, steps };
      if (st.editing) body.id = st.editing;
      await api('/api/combo', body);
      closeComboEditor();
      await loadCombos();
    });
  }

  /** 删除要按两下：第一下把按钮变成「确认删除」，4 秒内再点才真删 */
  function armDeleteCombo(id) {
    const btn = st.dom && st.dom.comboDel;
    if (!btn) return;
    if (st.delArmed === id) {
      st.delArmed = '';
      btn.textContent = '删除';
      btn.classList.remove('is-danger');
      guard(async () => {
        await api('/api/combo/delete', { id });
        st.play = null;
        await loadCombos();
      });
      return;
    }
    st.delArmed = id;
    btn.textContent = '确认删除';
    btn.classList.add('is-danger');
    setTimeout(() => {
      if (st.delArmed !== id) return;
      st.delArmed = '';
      btn.textContent = '删除';
      btn.classList.remove('is-danger');
    }, 4000);
  }

  async function loadCombos() {
    try {
      const r = await api('/api/combos');
      st.combos = (r && r.items) || [];
    } catch (_) {
      st.combos = [];
    }
    renderComboList();
    paintCombos();
  }

  /** 列表结构只在组合本身变了时才重建，否则每秒轮询会不停替换按钮、丢焦点 */
  function renderComboList() {
    const d = st.dom;
    if (!d) return;
    const sig = (st.combos || []).map((c) => c.id + '|' + c.name + '|' + (c.loop ? 1 : 0)
      + '|' + (c.steps || []).length + '|' + (c.summary || '')).join(',');
    if (sig === st.comboSig) return;
    st.comboSig = sig;
    const frag = document.createDocumentFragment();
    (st.combos || []).forEach((c) => {
      const b = el('button', 'wn-scene', '🔀 ' + c.name);
      b.type = 'button';
      b.dataset.combo = c.id;
      b.title = c.summary || c.name;
      b.addEventListener('click', () => selectCombo(c.id));
      frag.appendChild(b);
    });
    d.combos.replaceChildren(frag);
  }

  function paintCombos() {
    const d = st.dom;
    if (!d) return;
    const s = st.status || {};
    const cur = comboOf(s.preset_key);
    Array.prototype.forEach.call(d.combos.querySelectorAll('button'), (b) => {
      b.classList.toggle('is-on', !!cur && b.dataset.combo === cur.id);
    });
    d.comboActions.hidden = !cur;
    if (!st.combos.length) {
      d.comboState.textContent = '还没有组合：点「＋ 新建」把最多 '
        + MAX_COMBO_STEPS + ' 段场景排成一条链。';
      return;
    }
    if (!cur) {
      d.comboState.textContent = '点一支组合选中它；「开启限速」后按顺序播放。';
      return;
    }
    const total = (cur.steps || []).length;
    if (!s.limit_on) {
      d.comboState.textContent = '已选中，点「开启限速」后按序播放：' + (cur.summary || '');
      return;
    }
    const pr = comboProgress(s, cur);
    if (pr && pr.idx != null) {
      d.comboState.textContent = '▶ 正在播放第 ' + pr.idx + '/' + pr.total + ' 段'
        + (pr.name ? '（' + pr.name + '）' : '')
        + (pr.left != null ? '，还剩 ' + fmtClock(pr.left) : '')
        + (cur.loop ? '（循环）' : '');
      return;
    }
    d.comboState.textContent = '▶ 播放中（共 ' + total + ' 段）'
      + (cur.loop ? '（循环）' : '') + '：' + (cur.summary || '');
  }

  /**
   * 当前播到第几段：引擎按时间轴换 profile，这里用 profile.name 与各段场景名对齐。
   * 同名场景排了多段时，按「从上一段往后找」推进，避免一直停在第一段。
   */
  function comboProgress(s, combo) {
    const steps = combo.steps || [];
    if (!steps.length || !s.limit_on) { st.play = null; return null; }
    const profName = (s.profile && s.profile.name) || '';
    const names = steps.map((x) => sceneName(x.key));
    const cands = [];
    names.forEach((n, i) => { if (n === profName) cands.push(i); });
    if (!st.play || st.play.id !== combo.id) {
      st.play = { id: combo.id, idx: -1, at: 0 };
    }
    const g = st.play;
    if (cands.length) {
      let idx = cands[0];
      if (g.idx >= 0) {
        if (cands.indexOf(g.idx) >= 0) idx = g.idx;
        else {
          const next = cands.filter((i) => i > g.idx);
          idx = next.length ? next[0] : cands[0];
        }
      }
      if (idx !== g.idx) { g.idx = idx; g.at = Date.now(); }
    }
    const total = steps.length;
    if (g.idx < 0) return { idx: null, total, name: profName };
    const dur = stepSeconds(steps[g.idx]);
    const elapsed = (Date.now() - g.at) / 1000;
    return {
      idx: g.idx + 1,
      total,
      name: names[g.idx],
      left: Math.max(0, Math.round(dur - elapsed)),
    };
  }

  async function selectCombo(id) {
    if (st.busy) return;
    await guard(async () => {
      await api('/api/preset', { key: 'c:' + id });
      // 换了组合，本地进度从头算
      st.play = null;
    });
  }

  /** 顶栏按钮：限速中 / 已暂停 / 仅开启跟随（跟随状态用文字点出来，回主界面也知道） */
  function paintTopBtn(on, paused) {
    btn.textContent = on ? '≈ 限速中'
      : (paused ? '≈ 已暂停' : (st.follow ? '≈ 弱网·跟随' : '≈ 弱网测试'));
    btn.classList.toggle('is-on', !!on);
    btn.classList.toggle('is-paused', !!paused);
    btn.classList.toggle('is-follow', st.follow && !on && !paused);
  }

  function paintFollow() {
    const d = st.dom;
    if (!d) return;
    d.follow.textContent = st.follow ? '已开启' : '关闭';
    d.follow.classList.toggle('is-on', st.follow);
    if (!(st.status && st.status.limit_on)) paintTopBtn(false, st.paused);
  }

  function setFollow(on) {
    st.follow = !!on;
    try { localStorage.setItem(FOLLOW_KEY, st.follow ? '1' : '0'); } catch (_) {}
    paintFollow();
    if (typeof window.log === 'function') {
      try {
        window.log(st.follow
          ? '弱网跟随采集已开启：点「开始」采集时会自动接管当前设备并开启限速，停止采集时一起收掉'
          : '弱网跟随采集已关闭：弱网仍可在本页手动开关', '');
      } catch (_) {}
    }
  }

  /** 当前是不是「直连（不限制）」：一键开始 / 跟随采集时要点出来，否则用户以为限了其实没限 */
  function sceneDirect() {
    const prof = (st.status && st.status.profile) || {};
    const key = (st.status && st.status.preset_key) || '';
    return key === 'direct' || /直连/.test(prof.name || '');
  }

  /**
   * 唯一的启停入口：关着时一次做完「拉起引擎 → 接管所选手机 → 开启限速」，
   * 开着时只停限速（场景 / 监听 / 系统代理 / 手机接管都保留，随时能再开）。
   * 中途失败不吞掉原因：手机接管失败只提示、限速照开，引擎起不来才整体放弃。
   */
  async function toggleRun() {
    if (st.busy) return;
    const on = !!(st.status && st.status.limit_on);
    if (on) {
      await guard(async () => { await api('/api/run', { enable: false }); });
      return;
    }
    await startWeaknet();
  }

  async function startWeaknet() {
    if (st.busy || (st.status && st.status.limit_on)) return;
    const d = buildDom();
    st.busy = true;
    syncBusy();
    const done = [];
    const picked = d.phoneDev && d.phoneDev.value;
    let tookPhone = false;
    try {
      if (!(await ensureEngine())) return;
      const id = picked;
      if (id && !st.phoneOn) {
        try {
          const r = await window.perfAPI.weaknetPhone({ action: 'connect', deviceId: id });
          if (r && r.ok) {
            tookPhone = true;
            done.push('手机已接管' + (r.watch === false ? '（拔线守护未就绪）' : ''));
            await refreshPhone();
          } else {
            setPhoneMsg(((r && (r.msg || r.reason)) || '手机接管失败')
              + (r && r.hint ? ' ' + r.hint : ''), true);
          }
        } catch (e) {
          setPhoneMsg('手机接管失败：' + (e.message || e), true);
        }
      }
      const s0 = st.status || await api('/api/status');
      if (!s0.limit_on) {
        await api('/api/run', { enable: true });
        done.push('限速已开启');
      }
      await refresh();
      const scene = (st.status && st.status.profile && st.status.profile.name) || '';
      const msg = '弱网已开始' + (done.length ? '：' + done.join('、') : '')
        + (scene ? '（场景：' + scene + '）' : '')
        + (sceneDirect() ? '；当前是直连（不限制），选一个场景后立即生效' : '')
        + '。可点「← 返回采集」开始采集。';
      setBanner(msg, 'ok', 12000);
      if (typeof window.log === 'function') { try { window.log(msg, ''); } catch (_) {} }
    } catch (e) {
      // 限速没开成时把刚接管的手机退回去，不留「接管着但没限速」的半截状态
      let back = '';
      if (tookPhone && picked) {
        try {
          const r = await window.perfAPI.weaknetPhone({ action: 'disconnect', deviceId: picked });
          back = r && r.ok ? '；已还原手机代理' : '；手机代理还原失败，请到右栏点「解除」';
          await refreshPhone();
        } catch (_) { back = '；手机代理还原失败，请到右栏点「解除」'; }
      }
      // 带 ttl：refresh 轮询时不会把这条失败提示顺手清掉
      setBanner('开启限速失败：' + (e.message || e) + back, '', 15000);
    } finally {
      st.busy = false;
      syncBusy();
    }
  }

  /**
   * 主界面「暂停 / 继续」：只动限速开关，场景、监听、系统代理、手机接管全部保留，
   * 继续时按原样跑，不用重新选场景。
   */
  async function togglePauseWeaknet() {
    if (st.busy) return;
    await guard(async () => {
      const on = !!(st.status && st.status.limit_on);
      await api('/api/run', { enable: !on });
      // 刚关掉才叫暂停；刚恢复就回到正常限速态
      st.paused = on;
    });
  }

  /**
   * 主界面「停止」：限速、系统代理、手机代理一起收干净。
   * 只关限速不够——本机和手机的流量还指着引擎端口，用户以为停了、网却还绕路。
   */
  async function stopWeaknet() {
    if (st.busy) return;
    const s = st.status || {};
    st.busy = true;
    syncBusy();
    const done = [];
    const fails = [];
    try {
      try {
        if (s.limit_on) await api('/api/run', { enable: false });
        done.push('限速已停');
      } catch (e) { fails.push('限速：' + (e.message || e)); }
      if (s.sysproxy) {
        try {
          await api('/api/sysproxy', { enable: false });
          done.push('系统代理已解除');
        } catch (e) { fails.push('系统代理：' + (e.message || e)); }
      }
      // 页面这边不知道接管过哪些手机，交由主进程按记录统一还原
      if (typeof window.perfAPI.weaknetPhone === 'function') {
        try {
          const r = await window.perfAPI.weaknetPhone({ action: 'restore' });
          if (!r || !r.ok) {
            fails.push('手机代理：' + ((r && (r.msg || r.reason)) || '还原失败'));
          } else {
            const n = (r.items || []).filter((x) => x && x.ok).length;
            if (n) done.push('手机代理已还原（' + n + ' 台）');
          }
        } catch (_) { fails.push('手机代理：还原失败'); }
      }
      st.paused = false;
      await refresh();
      const summary = fails.length
        ? '停止弱网未完全成功：' + fails.join('；')
        : '已停止弱网：' + done.join('、') + '。采集不受影响，随时可以再开。';
      if (fails.length) {
        setBanner(summary);
        showQuickHint('停止弱网未完全成功', true, summary);
      } else {
        setBanner(summary, 'ok', 8000);
        showQuickHint('弱网已停止', false, summary);
      }
      // 二级页收起来时提示条看不见，日志面板里再留一条
      if (typeof window.log === 'function') {
        try { window.log(summary, fails.length ? 'error' : ''); } catch (_) {}
      }
    } finally {
      st.busy = false;
      syncBusy();
    }
  }

  async function applyProfile() {
    if (st.busy || !st.paramDefs) return;
    await guard(async () => {
      const body = {};
      st.paramDefs.forEach((p) => {
        const inp = $('wn-p-' + p.key);
        body[p.key] = Number(inp && inp.value) || 0;
      });
      await api('/api/profile', body);
    });
  }

  async function toggleListen() {
    if (st.busy) return;
    await guard(async () => {
      const host = st.status && st.status.listen && st.status.listen.host;
      await api('/api/listen', { host: host === '0.0.0.0' ? '127.0.0.1' : '0.0.0.0' });
    });
  }

  async function toggleSysproxy() {
    if (st.busy) return;
    await guard(async () => {
      const on = !!(st.status && st.status.sysproxy);
      await api('/api/sysproxy', { enable: !on });
    });
  }

  /** 统一处理：置忙 → 执行 → 刷新；失败把原因摆到提示条上，不弹 alert */
  async function guard(fn) {
    st.busy = true;
    try {
      await fn();
      await refresh();
    } catch (e) {
      setBanner(e.message || String(e));
    } finally {
      st.busy = false;
      syncBusy();
    }
  }

  // ── 手机（USB）接管 ────────────────────────────────────────────────────────
  function setPhoneMsg(text, bad) {
    const d = st.dom;
    d.phoneState.textContent = text;
    d.phoneState.className = 'wn-note wn-phone-state' + (bad ? ' is-bad' : '');
  }

  /** 设备列表每次打开页面都重取：插拔手机后不用重启采集端 */
  async function loadPhoneDevices() {
    const d = buildDom();
    let list = [];
    try { list = await window.perfAPI.getDevices(); } catch (_) {}
    st.devices = (Array.isArray(list) ? list : []).filter((x) => x && x.id);
    const keep = d.phoneDev.value;
    const frag = document.createDocumentFragment();
    const head = el('option', null, st.devices.length ? '选择手机' : '没有已连接的手机');
    head.value = '';
    frag.appendChild(head);
    st.devices.forEach((x) => {
      // main 进程已经在 displayName 里标过「(无线)」，这里不再重复追加
      const o = el('option', null, x.displayName || x.id);
      o.value = x.id;
      frag.appendChild(o);
    });
    d.phoneDev.replaceChildren(frag);
    d.phoneDev.value = st.devices.some((x) => x.id === keep)
      ? keep : (st.devices[0] ? st.devices[0].id : '');
    await refreshPhone();
  }

  async function refreshPhone() {
    const d = st.dom;
    const id = d.phoneDev.value;
    if (!id) {
      st.phoneOn = false;
      d.phoneBtn.textContent = '接管';
      d.phoneBtn.classList.remove('is-on');
      d.phoneBtn.disabled = true;
      setPhoneMsg('没有可用的设备', false);
      return;
    }
    let r = null;
    if (typeof window.perfAPI.weaknetPhone !== 'function') {
      setPhoneMsg('当前版本不支持手机接管', true);
      d.phoneBtn.disabled = true;
      return;
    }
    try { r = await window.perfAPI.weaknetPhone({ action: 'status', deviceId: id }); } catch (_) {}
    d.phoneBtn.disabled = false;
    if (!r || !r.ok) {
      st.phoneOn = false;
      d.phoneBtn.textContent = '接管';
      d.phoneBtn.classList.remove('is-on');
      setPhoneMsg('读不到手机状态：' + ((r && (r.msg || r.reason)) || 'adb 未响应'), true);
      return;
    }
    // 只有指向本工具端口的代理才算接管；手机自己配着的代理（公司 Wi-Fi 之类）
    // 不能显示成「已接管」，否则一点「解除」就把人家配置删了
    const ours = !!r.ours;
    st.phoneOn = ours;
    d.phoneBtn.textContent = ours ? '解除' : '接管';
    d.phoneBtn.classList.toggle('is-on', ours);
    // 账本里还有别的手机挂着代理（接管后下拉框切走了）：接管/解除都会按账本一起还原
    const otherHeld = (r.heldOthers || []).length
      ? '；另一台手机还挂着代理，点「接管 / 解除」会把它一起还原' : '';
    if (!ours && r.proxy) {
      setPhoneMsg('手机自带系统代理 ' + r.proxy + '（不是本工具设置的）'
        + '，接管时会先记下，解除时原样写回' + otherHeld, false);
      return;
    }
    if (!ours) {
      setPhoneMsg('手机未接管（系统代理为空）' + otherHeld, false);
      return;
    }
    const m = /^(\S+):(\d+)$/.exec(r.proxy);
    const mapped = m ? (r.reverse || []).some((l) => l.includes('tcp:' + m[2])) : false;
    const tail = mapped
      ? (r.watch === false
        ? '，USB 映射已就绪（拔线守护未安装：拔线前请先点「解除」）'
        : '，USB 映射已就绪，拔线后手机会自动恢复直连')
      : '，但没有 USB 映射（流量会连不上，点「解除」可清掉）';
    setPhoneMsg('手机代理 ' + r.proxy + tail, !mapped);
  }

  /** 接管/解除都要先确保引擎活着：没有代理端口，映射到哪儿都没意义 */
  async function togglePhone() {
    if (st.busy) return;
    const d = st.dom;
    const id = d.phoneDev.value;
    if (!id) return;
    const wasOn = st.phoneOn;
    st.busy = true;
    syncBusy();
    try {
      if (!wasOn && !(await ensureEngine())) return;
      const r = await window.perfAPI.weaknetPhone({
        action: wasOn ? 'disconnect' : 'connect',
        deviceId: id,
      });
      if (!r || !r.ok) {
        const msg = (r && (r.msg || r.reason)) || '手机接管失败';
        // 失败路径也可能刚还原过上一台：先按手机真实状态刷新按钮，再把失败原因打上去
        await refreshPhone();
        setPhoneMsg(msg + (r && r.hint ? ' ' + r.hint : ''), true);
        return;
      }
      if (!wasOn) {
        // 引擎可能是主进程为了这次接管刚拉起来的：页面这边别停在过期的「未启动」
        st.ready = true;
        // 接管成功后手机流量立刻进引擎；限速开关没开就等于直通，顺手打开
        try {
          const s = await api('/api/status');
          if (!s.limit_on) await api('/api/run', { enable: true });
        } catch (_) {}
        // 换机重连前会先把上一台还原，如实写进日志，免得用户以为它还管着
        const back = (r.restored || []).filter((x) => x && x.ok && x.deviceId !== id);
        if (back.length && typeof window.log === 'function') {
          try { window.log('已还原上一台手机的代理：' + back.map((x) => x.deviceId).join('、'), 'info'); } catch (_) {}
        }
      }
      await refreshPhone();
      await refresh();
    } catch (e) {
      setPhoneMsg(e.message || String(e), true);
    } finally {
      st.busy = false;
      syncBusy();
    }
  }

  function syncBusy() {
    const d = st.dom;
    if (!d) return;
    const dis = !st.ready || st.busy;
    d.run.disabled = dis;
    d.follow.disabled = false;     // 跟随开关不依赖引擎，先设好再开始采集
    d.apply.disabled = dis;
    d.lan.disabled = dis;
    d.sys.disabled = dis;
    // 主界面快捷按钮不依赖二级页面是否打开，忙的时候一起置灰
    if (btnPause) btnPause.disabled = st.busy;
    if (btnStop) btnStop.disabled = st.busy;
    // 手机接管不依赖引擎是否已就绪：解除时更要能用（引擎挂了反而必须能还原手机）
    d.phoneBtn.disabled = st.busy || !d.phoneDev.value;
    d.phoneDev.disabled = st.busy;
    d.scenes.querySelectorAll('button').forEach((b) => { b.disabled = dis; });
    d.params.querySelectorAll('input').forEach((i) => { i.disabled = dis; });
    d.combos.querySelectorAll('button').forEach((b) => { b.disabled = dis; });
    d.comboNew.disabled = dis;
    d.comboEdit.disabled = dis;
    d.comboDel.disabled = dis;
    if (st.editorOpen) {
      d.comboEd.querySelectorAll('input, select, button').forEach((x) => { x.disabled = dis; });
      syncComboEditor();     // 段数到上限时，添加按钮要单独置灰
    }
  }

  // ── 渲染 ───────────────────────────────────────────────────────────────────
  function fmtBytes(n) {
    const v = Number(n) || 0;
    if (v >= 1073741824) return (v / 1073741824).toFixed(1) + ' GB';
    if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB';
    if (v >= 1024) return (v / 1024).toFixed(0) + ' KB';
    return v + ' B';
  }

  function render() {
    const d = buildDom();
    const s = st.status;
    const on = !!(s && s.limit_on);
    if (on) st.paused = false;
    const paused = !on && st.paused;

    // 顶栏按钮：任何页面都能看到是否正在限速
    paintTopBtn(on, paused);
    btn.title = on
      ? '弱网测试：当前正在限速，点击查看场景与参数'
      : (paused
        ? '弱网测试：限速已暂停（场景 / 代理 / 手机接管都保留），点击可继续或停止'
        : (st.follow
          ? '弱网测试：已开启「跟随性能采集」，点「开始」采集时会同步开启限速'
          : '弱网测试：打开弱网页面，可对手机/本机做限速 / 延迟 / 丢包 / 断网'));
    paintFollow();

    // 主界面快捷按钮：限速中给「暂停 / 停止」，暂停后暂停键变「继续」
    if (btnPause) {
      btnPause.hidden = !(on || paused);
      btnPause.textContent = paused ? '▶ 继续弱网' : '⏸ 暂停弱网';
      btnPause.title = paused
        ? '继续弱网：按原场景恢复限速（系统代理 / 手机接管都还在）'
        : '暂停弱网：流量恢复直连，场景 / 系统代理 / 手机接管都保留，随时可继续';
    }
    if (btnStop) {
      btnStop.hidden = !(on || paused);
      btnStop.title = '停止弱网：结束限速，并解除系统代理、还原手机代理';
    }

    if (!s) { syncBusy(); return; }

    d.ver.textContent = s.version ? 'v' + s.version : '';
    d.pill.textContent = on ? '限速中' : '未开启';
    d.pill.classList.toggle('is-on', on);
    d.run.textContent = on ? '■ 停止限速' : '▶ 开启限速';
    d.run.className = 'wn-btn ' + (on ? 'wn-btn-danger' : 'wn-btn-primary');
    d.run.title = on
      ? '停止限速：场景、代理、手机接管都保留，随时可以再开'
      : '开启限速：引擎没起就拉起，接管下拉框选中的手机，再按当前场景开限速';

    const prof = s.profile || {};
    $('wn-k-scene').textContent = prof.name || '--';
    $('wn-k-listen').textContent = s.listen ? (s.listen.host + ':' + s.listen.port) : '--';
    const stats = s.stats || {};
    $('wn-k-conns').textContent = (stats.total || 0) + ' / ' + (stats.active || 0);
    $('wn-k-rate').textContent = fmtBytes(stats.down) + ' / ' + fmtBytes(stats.up);
    const sys = $('wn-k-sys');
    sys.textContent = s.sysproxy ? '已接管' : '未接管';
    sys.className = s.sysproxy ? 'is-good' : '';
    const scope = s.scope || { mode: 'all', list: [] };
    const n = Array.isArray(scope.list) ? scope.list.length : 0;
    $('wn-k-scope').textContent = scope.mode === 'all' ? '全部程序'
      : (scope.mode === 'only' ? '仅 ' + n + ' 个' : '排除 ' + n + ' 个');

    d.scenes.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('is-on', b.dataset.key === s.preset_key);
    });
    paintCombos();
    const custom = s.preset_key === 'custom';
    d.apply.textContent = custom ? '自定义生效中' : '应用到当前';
    d.apply.classList.toggle('is-on', custom);

    if (s.listen) {
      const lanOn = s.listen.host === '0.0.0.0';
      d.lan.textContent = lanOn ? '关闭' : '开启';
      d.lan.classList.toggle('is-on', lanOn);
    }
    d.sys.textContent = s.sysproxy ? '解除' : '接管';
    d.sys.classList.toggle('is-on', !!s.sysproxy);

    fillParams(prof);
    renderLog(s.events || []);
    syncBusy();
  }

  /** 参数框只在「引擎侧的值变了」且用户没在输入时刷新，否则改一半就被冲掉 */
  function fillParams(prof) {
    if (!st.paramDefs || !prof) return;
    const sig = st.paramDefs.map((p) => (prof[p.key] == null ? p.default : prof[p.key])).join(',');
    if (sig === st.paramSig) return;
    const ae = document.activeElement;
    if (st.paramSig && ae && ae.id && ae.id.indexOf('wn-p-') === 0) return;
    st.paramDefs.forEach((p) => {
      const inp = $('wn-p-' + p.key);
      if (inp) inp.value = String(prof[p.key] == null ? p.default : prof[p.key]);
    });
    st.paramSig = sig;
  }

  function renderLog(events) {
    const d = st.dom;
    const frag = document.createDocumentFragment();
    events.forEach((ev) => {
      const row = el('div');
      row.appendChild(el('span', 'wn-t', ev.t || ''));
      const cls = ev.type === 'config' ? 'wn-ev-config' : (ev.type === 'error' ? 'wn-ev-error' : '');
      row.appendChild(el('span', cls, ev.msg || ''));
      frag.appendChild(row);
    });
    d.log.replaceChildren(frag);
  }

  // ── 轮询 ───────────────────────────────────────────────────────────────────
  async function refresh() {
    if (!st.ready) return;
    try {
      st.status = await api('/api/status');
      if (!st.bannerUntil || Date.now() > st.bannerUntil) setBanner('');
      render();
    } catch (e) {
      // 引擎没了（被关掉/崩溃）：明确告诉用户，别让界面停在过期的「限速中」
      st.ready = false;
      st.status = null;
      st.paused = false;
      setBanner('弱网引擎已断开：' + (e.message || e));
      paintTopBtn(false, false);
      if (btnPause) btnPause.hidden = true;
      if (btnStop) btnStop.hidden = true;
      const d = st.dom;
      if (d) { d.pill.textContent = '引擎未启动'; d.pill.classList.remove('is-on'); }
      syncBusy();
    }
  }

  function schedule() {
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(async () => {
      await refresh();
      schedule();
    }, st.open ? OPEN_POLL_MS : IDLE_POLL_MS);
  }

  // ── 打开 / 关闭 ────────────────────────────────────────────────────────────
  async function open() {
    const d = buildDom();
    st.open = true;
    d.page.hidden = false;
    d.page.tabIndex = -1;
    d.page.focus();
    if (st.paramDefs && st.status) render();
    const ok = await ensureEngine();
    if (ok) await refresh();
    else syncBusy();   // 引擎没起来：把操作全部置灰，别让人点了没反应
    if (ok) loadCombos().catch(() => {});   // 组合可能在图形界面里改过，每次打开重取
    loadPhoneDevices().catch(() => {});
    schedule();
  }

  function close() {
    const d = buildDom();
    st.open = false;
    d.page.hidden = true;
    btn.focus();
    schedule();
  }

  btn.addEventListener('click', () => {
    if (st.open) close();
    else open();
  });
  if (btnPause) btnPause.addEventListener('click', () => { togglePauseWeaknet(); });
  if (btnStop) btnStop.addEventListener('click', () => { stopWeaknet(); });

  /**
   * 供采集主界面调用：跟随模式下，开始采集前开弱网、停止采集时收掉。
   * 只在「跟随性能采集」开启时生效；其他情况原样返回，不干扰正常采集。
   */
  window.weaknetFollow = {
    isOn: () => !!st.follow,

    async onCollectStart(deviceId) {
      if (!st.follow) return { ok: true, skipped: true };
      const done = [];
      const id = String(deviceId || '');
      let tookPhone = false;
      try {
        if (!(await ensureEngine())) {
          return { ok: false, msg: '弱网跟随采集：引擎启动失败，本次按直连采集' };
        }
        if (id) {
          // 采集设备就是要限速的那台手机：还没接管过就一并接管
          let cur = null;
          try { cur = await window.perfAPI.weaknetPhone({ action: 'status', deviceId: id }); } catch (_) {}
          if (!(cur && cur.ok && cur.ours)) {
            try {
              const r = await window.perfAPI.weaknetPhone({ action: 'connect', deviceId: id });
              if (r && r.ok) {
                tookPhone = true;
                done.push('手机已接管' + (r.watch === false ? '（拔线守护未就绪，拔线前请先停止弱网）' : ''));
              } else {
                done.push('手机接管失败：' + ((r && (r.msg || r.reason)) || '未知原因'));
              }
            } catch (e) {
              done.push('手机接管失败：' + (e.message || e));
            }
          } else {
            done.push('手机接管保持');
          }
          // 让页面上的设备下拉跟着选中，回到弱网页时状态一致
          const d = buildDom();
          if (Array.from(d.phoneDev.options).some((o) => o.value === id)) d.phoneDev.value = id;
        }
        const s0 = st.status || await api('/api/status');
        if (!s0.limit_on) {
          await api('/api/run', { enable: true });
          done.push('限速已开启');
        }
        await refresh();
        try { await refreshPhone(); } catch (_) {}
        const msg = '弱网跟随采集：' + (done.join('、') || '已开启')
          + (sceneDirect() ? '（注意：当前场景是直连，不限制）' : '');
        if (typeof window.log === 'function') { try { window.log(msg, ''); } catch (_) {} }
        return { ok: true, msg };
      } catch (e) {
        // 限速没开成时把刚接管的手机退回去：留着代理只会让手机流量白绕一圈
        if (tookPhone) {
          try { await window.perfAPI.weaknetPhone({ action: 'disconnect', deviceId: id }); } catch (_) {}
        }
        return { ok: false, msg: '弱网跟随采集失败：' + (e.message || e) + (tookPhone ? '（已还原手机代理）' : '') };
      }
    },

    async onCollectStop() {
      if (!st.follow || !st.ready) return { ok: true, skipped: true };
      // 采集结束就把弱网一起收掉：限速、系统代理、手机代理都不留残留
      await stopWeaknet();
      return { ok: true };
    },
  };

  // 启动时静默探一次：引擎可能本来就在跑（上次没退干净、或用户自己开着 WeakNet）。
  // 命中的话顶栏直接显示真实状态；探不到就算了，不能因为探测去拉起进程。
  window.perfAPI.weaknetApi('/api/status').then((r) => {
    if (st.ready || !r || !r.ok) return;
    st.ready = true;
    st.status = r.data;
    render();
    schedule();
  }).catch(() => {});

  if (typeof window.perfAPI.onWeaknetEngineExit === 'function') {
    window.perfAPI.onWeaknetEngineExit(() => {
      st.ready = false;
      st.status = null;
      st.paused = false;
      if (st.dom) {
        setBanner('弱网引擎已退出（进程结束）。重新点「开始」即可再拉起。');
        st.dom.pill.textContent = '引擎未启动';
        st.dom.pill.classList.remove('is-on');
      }
      paintTopBtn(false, false);
      if (btnPause) btnPause.hidden = true;
      if (btnStop) btnStop.hidden = true;
      syncBusy();
    });
  }
})();
