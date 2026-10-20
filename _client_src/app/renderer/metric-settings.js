/**
 * 采集参数设置（共享模块，三个采集页共用）。
 *
 * 用户可勾选/移除本次要采集的参数，默认全选；取消勾选的参数：
 *   1. 采集器不再采集（安卓直接跳过对应 adb 调用，iOS/PC 过滤输出字段）；
 *   2. 采集界面隐藏对应卡片与曲线；
 *   3. 生成的本地报告 / 对比报告 / 上传后的 Web 报告同步隐藏对应图表与指标行。
 *
 * 配置按平台分别保存在 localStorage（键：perfara.metricConfig.<platform>），
 * 并随每次采集写入 reports/data.js 的 payload.metricConfig，报告端据此适配。
 */
(function () {
  'use strict';

  /** 指标组定义：key=组 id，label=界面名，hint=说明 */
  var METRIC_GROUPS = {
    fps:     { label: 'FPS 与卡顿', hint: 'FPS、Jank / BigJank / SmallJank / TinyJank 分级、帧率稳定性' },
    cpu:     { label: 'CPU',        hint: '系统 / 进程 CPU、各核心使用率与频率' },
    mem:     { label: '内存',       hint: 'PSS / 物理内存、内存详情分项' },
    net:     { label: '网络',       hint: '网络流量 下行 / 上行' },
    gpu:     { label: 'GPU',        hint: 'GPU 利用率（部分机型需 root）与 GPU 温度' },
    temp:    { label: '温度',       hint: 'CPU / 电池温度' },
    battery: { label: '电池',       hint: '电量、电流、功耗' },
    disk:    { label: '磁盘 I/O',   hint: '磁盘读 / 写速率' },
    events:  { label: '系统事件',   hint: '上下文切换、中断唤醒、缺页中断' },
    proc:    { label: '进程信息',   hint: '线程数、Mach 端口、消息收发、系统调用、进程状态' },
  };

  /** 各采集平台适用的指标组（顺序即设置弹窗展示顺序） */
  var PLATFORM_METRICS = {
    android: ['fps', 'cpu', 'mem', 'net', 'gpu', 'temp', 'battery'],
    ios:     ['fps', 'cpu', 'mem', 'disk', 'events', 'proc'],
    ios_gpu: ['gpu'],
    pc:      ['fps', 'cpu', 'mem', 'net', 'gpu', 'temp', 'battery', 'disk'],
  };

  function storageKey(platform) {
    return 'perfara.metricConfig.' + platform;
  }

  /** 归一化：只保留该平台适用的组，缺省一律 true（默认全选） */
  function normalize(platform, cfg) {
    var groups = PLATFORM_METRICS[platform] || [];
    var out = {};
    for (var i = 0; i < groups.length; i++) out[groups[i]] = true;
    if (cfg && typeof cfg === 'object') {
      for (var j = 0; j < groups.length; j++) {
        var g = groups[j];
        if (Object.prototype.hasOwnProperty.call(cfg, g)) out[g] = !!cfg[g];
      }
    }
    return out;
  }

  /** 读取某平台配置；无存档返回全选 */
  function load(platform) {
    var all = normalize(platform, null);
    try {
      var raw = localStorage.getItem(storageKey(platform));
      if (raw) {
        var saved = JSON.parse(raw);
        if (saved && typeof saved === 'object') return normalize(platform, saved);
      }
    } catch (_) {}
    return all;
  }

  /** 保存某平台配置（自动归一化） */
  function save(platform, cfg) {
    var n = normalize(platform, cfg);
    try { localStorage.setItem(storageKey(platform), JSON.stringify(n)); } catch (_) {}
    return n;
  }

  /** 单个组是否启用（无配置时默认启用，兼容旧数据） */
  function isEnabled(cfg, group) {
    if (!cfg || typeof cfg !== 'object') return true;
    if (!Object.prototype.hasOwnProperty.call(cfg, group)) return true;
    return !!cfg[group];
  }

  /**
   * 把配置应用到当前页面：隐藏/显示带 data-metric 属性的卡片与图表块。
   * 元素 hidden 由本模块统一管理，页面自身不要重复设置这些元素。
   */
  function applyToPage(platform, cfg) {
    var norm = normalize(platform, cfg);
    var els = document.querySelectorAll('[data-metric]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var g = el.getAttribute('data-metric');
      el.hidden = !isEnabled(norm, g);
    }
    try {
      window.dispatchEvent(new CustomEvent('metric-config-changed', { detail: { platform: platform, config: norm } }));
    } catch (_) {}
    return norm;
  }

  // ─── 设置弹窗 ──────────────────────────────────────────────────────────────

  var _dialog = null; // { platform, root, onSave }

  function ensureRoot() {
    var root = document.getElementById('metric-settings-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'metric-settings-root';
      document.body.appendChild(root);
    }
    return root;
  }

  /**
   * 打开设置弹窗。
   * @param {string} platform android | ios | pc
   * @param {(cfg:object)=>void} [onSave] 保存回调（已写 localStorage）
   */
  function openDialog(platform, onSave) {
    var groups = PLATFORM_METRICS[platform];
    if (!groups) return;
    closeDialog();

    var cfg = load(platform);
    var root = ensureRoot();
    root.innerHTML = '';

    var backdrop = document.createElement('div');
    backdrop.className = 'ms-backdrop';

    var box = document.createElement('div');
    box.className = 'ms-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-labelledby', 'ms-title');

    var title = document.createElement('div');
    title.className = 'ms-title';
    title.id = 'ms-title';
    title.textContent = '采集参数设置';
    box.appendChild(title);

    var desc = document.createElement('p');
    desc.className = 'ms-desc';
    desc.textContent = '勾选需要采集的参数，默认全选。取消勾选的参数将不采集，报告中的对应图表与指标也会同步隐藏。修改对下次采集生效。';
    box.appendChild(desc);

    var list = document.createElement('div');
    list.className = 'ms-list';
    groups.forEach(function (g) {
      var def = METRIC_GROUPS[g] || { label: g, hint: '' };
      var row = document.createElement('label');
      row.className = 'ms-row';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!cfg[g];
      cb.value = g;
      var txt = document.createElement('span');
      txt.className = 'ms-row-txt';
      var b = document.createElement('b');
      b.textContent = def.label;
      txt.appendChild(b);
      if (def.hint) {
        var i = document.createElement('i');
        i.textContent = def.hint;
        txt.appendChild(i);
      }
      row.appendChild(cb);
      row.appendChild(txt);
      list.appendChild(row);
    });
    box.appendChild(list);

    var ops = document.createElement('div');
    ops.className = 'ms-ops';
    var btnAll = document.createElement('button');
    btnAll.type = 'button';
    btnAll.className = 'btn btn-sm';
    btnAll.textContent = '全选';
    var btnNone = document.createElement('button');
    btnNone.type = 'button';
    btnNone.className = 'btn btn-sm';
    btnNone.textContent = '全不选';
    var btnCancel = document.createElement('button');
    btnCancel.type = 'button';
    btnCancel.className = 'btn btn-sm';
    btnCancel.textContent = '取消';
    var btnSave = document.createElement('button');
    btnSave.type = 'button';
    btnSave.className = 'btn btn-primary btn-sm';
    btnSave.textContent = '保存';
    ops.appendChild(btnAll);
    ops.appendChild(btnNone);
    ops.appendChild(btnCancel);
    ops.appendChild(btnSave);
    box.appendChild(ops);

    backdrop.appendChild(box);
    root.appendChild(backdrop);

    function readForm() {
      var out = {};
      var cbs = list.querySelectorAll('input[type=checkbox]');
      for (var i = 0; i < cbs.length; i++) out[cbs[i].value] = cbs[i].checked;
      return out;
    }
    function setAll(v) {
      var cbs = list.querySelectorAll('input[type=checkbox]');
      for (var i = 0; i < cbs.length; i++) cbs[i].checked = v;
    }
    btnAll.onclick = function () { setAll(true); };
    btnNone.onclick = function () { setAll(false); };
    btnCancel.onclick = function () { closeDialog(); };
    backdrop.onclick = function (e) { if (e.target === backdrop) closeDialog(); };
    btnSave.onclick = function () {
      var picked = readForm();
      var norm = save(platform, picked);
      applyToPage(platform, norm);
      closeDialog();
      if (typeof onSave === 'function') {
        try { onSave(norm); } catch (_) {}
      }
    };

    _dialog = { platform: platform, root: root, onSave: onSave };
    backdrop.style.display = 'flex';
    // 焦点放到第一个复选框，键盘可直接操作
    try { list.querySelector('input[type=checkbox]').focus(); } catch (_) {}
  }

  function closeDialog() {
    if (_dialog && _dialog.root) _dialog.root.innerHTML = '';
    _dialog = null;
  }

  /** 供页面读取当前平台配置的便捷方法 */
  function current(platform) { return load(platform); }

  window.MetricSettings = {
    METRIC_GROUPS: METRIC_GROUPS,
    PLATFORM_METRICS: PLATFORM_METRICS,
    load: load,
    save: save,
    normalize: normalize,
    isEnabled: isEnabled,
    applyToPage: applyToPage,
    openDialog: openDialog,
    closeDialog: closeDialog,
    current: current,
  };
})();
