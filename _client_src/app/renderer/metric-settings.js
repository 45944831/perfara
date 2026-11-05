/**
 * 采集参数设置（共享模块，四个采集页共用）。
 *
 * 用户可勾选/移除本次要采集的参数，并用 ↑↓ 或拖动调整参数展示顺序；默认全选、默认顺序。
 * 取消勾选的参数：
 *   1. 采集器不再采集（安卓直接跳过对应 adb 调用，iOS/PC 过滤输出字段）；
 *   2. 采集界面隐藏对应卡片与曲线；
 *   3. 生成的本地报告 / 对比报告 / 上传后的 Web 报告同步隐藏对应图表与指标行。
 * 调整后的顺序：
 *   · 保存后立即作用于采集界面的指标卡与图表区；
 *   · 随每次采集写入 reports/data.js 的 payload.metricOrder，报告端据此重排；
 *   · 上传后由后端写入 blob.meta.metricOrder，Web 报告端据此重排。
 *
 * 配置按平台分别保存在 localStorage（键：perfara.metricConfig.<platform>），
 * 形状为 { <group>: bool, __order: [<group>...] }。
 * __order 是展示配置，不参与采集过滤：主进程会把它单独抽到 payload.metricOrder，
 * 采集器的 normalizeMetricConfig 仍只产出纯 bool 字典。
 */
(function () {
  'use strict';

  /** 展示顺序在配置对象里的保留键（不与任何指标组 id 冲突） */
  var ORDER_KEY = '__order';

  /** 指标组定义：key=组 id，label=界面名，hint=说明 */
  var METRIC_GROUPS = {
    fps:     { label: 'FPS 与卡顿', hint: 'FPS、Jank / BigJank / SmallJank / TinyJank 分级、帧率稳定性' },
    cpu:     { label: 'CPU',        hint: '系统 / 进程 CPU、各核心使用率与频率' },
    mem:     { label: '内存',       hint: 'PSS / 物理内存、内存详情分项' },
    net:     { label: '网络',       hint: '网络流量 下行 / 上行' },
    gpu:     { label: 'GPU',        hint: 'GPU 利用率（部分机型需 root）与 GPU 温度' },
    temp:    { label: '温度',       hint: 'Android 取机身 / 电池温度；PC 无机身传感器，取 CPU 结温。结温常年 55~70°C，不代表机身发烫' },
    battery: { label: '电池',       hint: '电量、电流、功耗' },
    disk:    { label: '磁盘 I/O',   hint: '磁盘读 / 写速率' },
    events:  { label: '系统事件',   hint: '上下文切换、中断唤醒、缺页中断' },
    proc:    { label: '进程信息',   hint: '线程数、Mach 端口、消息收发、系统调用、进程状态' },
  };

  /** 各采集平台适用的指标组（顺序即「默认顺序」与首次打开弹窗的展示顺序） */
  var PLATFORM_METRICS = {
    android: ['fps', 'cpu', 'mem', 'net', 'gpu', 'temp', 'battery'],
    ios:     ['fps', 'cpu', 'mem', 'disk', 'events', 'proc'],
    ios_gpu: ['gpu'],
    pc:      ['fps', 'cpu', 'mem', 'net', 'gpu', 'temp', 'battery', 'disk'],
  };

  function storageKey(platform) {
    return 'perfara.metricConfig.' + platform;
  }

  /** 默认顺序（返回副本） */
  function defaultOrder(platform) {
    return (PLATFORM_METRICS[platform] || []).slice();
  }

  /**
   * 归一化顺序：丢掉不属于该平台的组、去重、把缺的组按默认顺序补在末尾。
   * 这样以后新增指标组时，老用户的存档也不会缺项。
   */
  function normalizeOrder(platform, arr) {
    var groups = PLATFORM_METRICS[platform] || [];
    var out = [];
    var seen = {};
    if (Array.isArray(arr)) {
      for (var i = 0; i < arr.length; i++) {
        var g = arr[i];
        if (typeof g === 'string' && groups.indexOf(g) !== -1 && !seen[g]) {
          out.push(g);
          seen[g] = true;
        }
      }
    }
    for (var j = 0; j < groups.length; j++) {
      if (!seen[groups[j]]) { out.push(groups[j]); seen[groups[j]] = true; }
    }
    return out;
  }

  /** 归一化：只保留该平台适用的组，缺省一律 true（默认全选）；附带合法的顺序 */
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
    out[ORDER_KEY] = normalizeOrder(platform, cfg && cfg[ORDER_KEY]);
    return out;
  }

  /** 读取某平台配置；无存档返回全选 + 默认顺序 */
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

  /** 从配置里取顺序（兼容旧存档 / 缺字段） */
  function getOrder(platform, cfg) {
    return normalizeOrder(platform, cfg && cfg[ORDER_KEY]);
  }

  /**
   * 按展示顺序给页面上的 [data-metric] 元素设置 CSS order。
   *
   * 用 CSS order 而不是移动 DOM：echarts 实例、事件监听、id 查询都绑在原节点上，
   * 移动节点会牵动渲染；order 只对 flex/grid 直接子元素生效，而 .cards/.charts-grid
   * 恰好都是 flex，改一个整数即可，零副作用。
   *
   * 容器里还可能有不带 data-metric 的块（报告页的分区标题、动态 KPI 卡等）。
   * 这些块按原始位置分成三类：首个指标之前 → 固定最前；末个指标之后 → 固定最后；
   * 夹在中间 → 跟在它前面那组之后。避免它们因默认 order=0 被顶到最前。
   */
  function applyOrderToPage(platform, cfg) {
    var order = getOrder(platform, cfg);
    var rank = {};
    for (var i = 0; i < order.length; i++) rank[order[i]] = i;
    var unknown = order.length;

    var els = document.querySelectorAll('[data-metric]');
    var parents = [];
    for (var m = 0; m < els.length; m++) {
      var p = els[m].parentNode;
      if (p && parents.indexOf(p) === -1) parents.push(p);
    }

    for (var c = 0; c < parents.length; c++) {
      var kids = parents[c].children;
      var first = -1, last = -1;
      for (var a = 0; a < kids.length; a++) {
        if (kids[a].getAttribute && kids[a].getAttribute('data-metric')) {
          if (first < 0) first = a;
          last = a;
        }
      }
      if (first < 0) continue;
      var seqByRank = {};
      var prevRank = -1;
      for (var b = 0; b < kids.length; b++) {
        var g = kids[b].getAttribute && kids[b].getAttribute('data-metric');
        if (!g) {
          if (b < first) kids[b].style.order = '-1000';
          else if (b > last) kids[b].style.order = String((unknown + 1) * 1000);
          else kids[b].style.order = String((prevRank < 0 ? 0 : prevRank) * 1000 + 500);
          continue;
        }
        var r = Object.prototype.hasOwnProperty.call(rank, g) ? rank[g] : unknown;
        prevRank = r;
        var seq = seqByRank[r] || 0;
        seqByRank[r] = seq + 1;
        kids[b].style.order = String(r * 1000 + seq);
      }
    }
    return order;
  }

  /**
   * 把配置应用到当前页面：隐藏/显示带 data-metric 属性的卡片与图表块，
   * 并按配置顺序重排。元素 hidden 与 order 由本模块统一管理，页面自身不要重复设置。
   */
  function applyToPage(platform, cfg) {
    var norm = normalize(platform, cfg);
    var els = document.querySelectorAll('[data-metric]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var g = el.getAttribute('data-metric');
      el.hidden = !isEnabled(norm, g);
    }
    applyOrderToPage(platform, norm);
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
   * @param {string} platform android | ios | ios_gpu | pc
   * @param {(cfg:object)=>void} [onSave] 保存回调（已写 localStorage、已应用到页面）
   */
  function openDialog(platform, onSave) {
    var groups = PLATFORM_METRICS[platform];
    if (!groups) return;
    closeDialog();

    var cfg = load(platform);
    var order = getOrder(platform, cfg);
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
    desc.textContent = '勾选需要采集的参数（默认全选），用 ↑ / ↓ 按钮或直接拖动行可调整展示顺序。保存后采集界面与生成的测试报告都会按新顺序展示；修改对下次采集生效。';
    box.appendChild(desc);

    var list = document.createElement('div');
    list.className = 'ms-list';

    /** 按当前 DOM 顺序读取顺序数组 */
    function readOrder() {
      var out = [];
      var rows = list.querySelectorAll('.ms-row');
      for (var i = 0; i < rows.length; i++) out.push(rows[i].getAttribute('data-group'));
      return out;
    }

    /** 更新每行 ↑↓ 的禁用态 */
    function syncMoveButtons() {
      var rows = list.querySelectorAll('.ms-row');
      for (var i = 0; i < rows.length; i++) {
        var up = rows[i].querySelector('.ms-up');
        var down = rows[i].querySelector('.ms-down');
        if (up) up.disabled = (i === 0);
        if (down) down.disabled = (i === rows.length - 1);
      }
    }

    /** 创建一行 */
    function makeRow(g) {
      var def = METRIC_GROUPS[g] || { label: g, hint: '' };
      var row = document.createElement('div');
      row.className = 'ms-row';
      row.setAttribute('data-group', g);
      row.setAttribute('draggable', 'true');

      var grip = document.createElement('span');
      grip.className = 'ms-grip';
      grip.title = '按住拖动可调整顺序';
      grip.textContent = '⋮⋮';
      row.appendChild(grip);

      var main = document.createElement('label');
      main.className = 'ms-row-main';
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
        var it = document.createElement('i');
        it.textContent = def.hint;
        txt.appendChild(it);
      }
      main.appendChild(cb);
      main.appendChild(txt);
      row.appendChild(main);

      var move = document.createElement('div');
      move.className = 'ms-move';
      var up = document.createElement('button');
      up.type = 'button';
      up.className = 'ms-up';
      up.title = '上移';
      up.setAttribute('aria-label', '上移 ' + def.label);
      up.textContent = '↑';
      var down = document.createElement('button');
      down.type = 'button';
      down.className = 'ms-down';
      down.title = '下移';
      down.setAttribute('aria-label', '下移 ' + def.label);
      down.textContent = '↓';
      move.appendChild(up);
      move.appendChild(down);
      row.appendChild(move);

      up.onclick = function () {
        var prev = row.previousElementSibling;
        if (prev) { list.insertBefore(row, prev); syncMoveButtons(); }
      };
      down.onclick = function () {
        var next = row.nextElementSibling;
        if (next) { list.insertBefore(next, row); syncMoveButtons(); }
      };
      return row;
    }

    order.forEach(function (g) { list.appendChild(makeRow(g)); });
    box.appendChild(list);

    // ── 拖动排序（鼠标拖拽；按钮作为键盘/精确操作的兜底） ──
    var dragging = null;
    list.addEventListener('dragstart', function (e) {
      var row = e.target && e.target.closest ? e.target.closest('.ms-row') : null;
      if (!row) return;
      dragging = row;
      row.classList.add('ms-dragging');
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', row.getAttribute('data-group'));
      } catch (_) {}
    });
    list.addEventListener('dragover', function (e) {
      if (!dragging) return;
      var target = e.target && e.target.closest ? e.target.closest('.ms-row') : null;
      if (!target || target === dragging) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
      var rect = target.getBoundingClientRect();
      var after = (e.clientY - rect.top) > rect.height / 2;
      list.insertBefore(dragging, after ? target.nextElementSibling : target);
      syncMoveButtons();
    });
    list.addEventListener('drop', function (e) {
      if (dragging) e.preventDefault();
      dragging = null;
      var rows = list.querySelectorAll('.ms-row');
      for (var i = 0; i < rows.length; i++) rows[i].classList.remove('ms-dragging');
      syncMoveButtons();
    });
    list.addEventListener('dragend', function () {
      dragging = null;
      var rows = list.querySelectorAll('.ms-row');
      for (var i = 0; i < rows.length; i++) rows[i].classList.remove('ms-dragging');
      syncMoveButtons();
    });

    var ops = document.createElement('div');
    ops.className = 'ms-ops';
    function mkBtn(text, cls) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-sm ' + (cls || '');
      b.textContent = text;
      return b;
    }
    var btnAll = mkBtn('全选');
    var btnNone = mkBtn('全不选');
    var btnReset = mkBtn('恢复默认顺序');
    var btnCancel = mkBtn('取消');
    var btnSave = mkBtn('保存', 'btn-primary');
    ops.appendChild(btnAll);
    ops.appendChild(btnNone);
    ops.appendChild(btnReset);
    ops.appendChild(btnCancel);
    ops.appendChild(btnSave);
    box.appendChild(ops);

    backdrop.appendChild(box);
    root.appendChild(backdrop);

    function readForm() {
      var out = {};
      var cbs = list.querySelectorAll('input[type=checkbox]');
      for (var i = 0; i < cbs.length; i++) out[cbs[i].value] = cbs[i].checked;
      out[ORDER_KEY] = readOrder();
      return out;
    }
    function setAll(v) {
      var cbs = list.querySelectorAll('input[type=checkbox]');
      for (var i = 0; i < cbs.length; i++) cbs[i].checked = v;
    }
    btnAll.onclick = function () { setAll(true); };
    btnNone.onclick = function () { setAll(false); };
    btnReset.onclick = function () {
      defaultOrder(platform).forEach(function (g) {
        var row = list.querySelector('.ms-row[data-group="' + g + '"]');
        if (row) list.appendChild(row);
      });
      syncMoveButtons();
    };
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

    syncMoveButtons();
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
    ORDER_KEY: ORDER_KEY,
    METRIC_GROUPS: METRIC_GROUPS,
    PLATFORM_METRICS: PLATFORM_METRICS,
    load: load,
    save: save,
    normalize: normalize,
    isEnabled: isEnabled,
    defaultOrder: defaultOrder,
    normalizeOrder: normalizeOrder,
    getOrder: getOrder,
    applyOrderToPage: applyOrderToPage,
    applyToPage: applyToPage,
    openDialog: openDialog,
    closeDialog: closeDialog,
    current: current,
  };
})();
