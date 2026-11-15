'use strict';

/**
 * 指标卡「!」口径说明。
 *
 * 为什么要有：卡片上只有名称、数值、单位，但同一个「CPU」可能是整机口径也可能是
 * 单核口径，「内存」是 PSS 还是 RSS，「Jank」阈值怎么来的，「网络」是本应用还是整机
 * ——这些差异足以让两个数直接比错。口径写进卡片说明，比写在文档里有效。
 *
 * 数据来源（改这里的文案前请先对代码，别凭印象写）：
 *   - CPU：src/adb.js calcCpuPct（/proc/stat 增量；进程按单核百分比，可 >100%）
 *   - 内存：src/collector.js _collectMem（PSS 每 5 拍实测，中间沿用；RSS 逐拍读 /proc）
 *   - FPS/Jank：src/adb.js analyseHistogram（基准 P50，绝对门槛 83.34 / 125ms）
 *   - 网络：src/adb.js getNetStats（dumpsys netstats --uid，DEFAULT + FOREGROUND）
 *   - GPU/温度/电池：src/adb.js getGpuUsage / getThermalInfo / getBatteryInfo
 *   - 口径枚举：src/metric-schema.js METRIC_DEFS 的 scope（app / device）
 *
 * 交互与顶栏「旁路取证」的 ! 一致：点击展开，点外部 / Esc / 窗口失焦收起，
 * 一次只开一个。按钮是真 <button>，键盘 Enter / Space 原生可用。
 */
(function () {
  const PANEL_ID = 'metric-help-panel';

  /** scope: 'app' 应用口径 / 'device' 整机口径 */
  const DESC = {
    'card-cpu': {
      title: '系统 CPU',
      scope: 'device',
      rows: [
        ['怎么算', '两次读 /proc/stat，(总增量 − 空闲增量) ÷ 总增量，整机 0~100%。'],
        ['看什么', '看设备整体有没有被别的应用或系统服务拖住；应用自己占多少看「进程 CPU」。'],
      ],
      foot: '整机口径：包含本应用 + 桌面 + 后台 + 系统进程，不能拿它判断应用自身开销。',
    },
    'card-proccpu': {
      title: '进程 CPU',
      scope: 'app',
      rows: [
        ['怎么算', '读 /proc/<pid>/stat 的 utime+stime 增量，除以「单核平均总时长」（整机总增量 ÷ 在线核数）。'],
        ['单核口径', '跑满 1 个核 = 100%，8 核机型最高可到 800%。多线程渲染的应用常年 100% 以上是正常的。'],
      ],
      foot: '不要把这里和「占整机百分比」的旧数据直接比，两者差一个核数量级。',
    },
    'card-mem': {
      title: '内存 PSS',
      scope: 'app',
      rows: [
        ['怎么算', 'dumpsys meminfo 的 TOTAL PSS，共享页按比例分摊，比 RSS 更接近「真实占用」。'],
        ['采样节奏', 'PSS 家族每 5 拍实测一次（dumpsys 会握进程锁、阻塞应用主线程），中间拍沿用上次实测值，Excel 里 mem.src 标的 full / lite 就是采样方式。'],
      ],
      foot: '要逐拍平滑趋势看「进程 RSS」：读 /proc/<pid>/status 的 VmRSS，零干扰。',
    },
    'card-fps': {
      title: 'FPS',
      scope: 'app',
      rows: [
        ['怎么算', '优先 SurfaceFlinger timestats 按 layer 取；不行退 gfxinfo framestats，再不行 gfxinfo delta。命中哪条通道会打在日志里。'],
        ['显示 --', '静态页 / 应用不在前台 / 没有可见渲染层时显示 -- 并断开曲线，这不等于 0 帧。'],
      ],
      foot: '锁 30fps 的应用稳定在 30 是正常的；判断卡顿看它有没有掉到 30 以下。',
    },
    'card-jank': {
      title: 'Jank',
      scope: 'app',
      rows: [
        ['定义', '单帧间隔 ≥ max(2 × 基准, 83.34ms) 记 1 次；基准 = max(屏幕 vsync, 帧间隔 P50)。'],
        ['为什么用 P50', '用平均值的话，卡顿会把阈值一起抬高，越卡越测不出来（自我遮蔽）。'],
      ],
      foot: '单位是「帧」不是「次/秒」；卡片右下角小字是这一段 Jank ÷ 总帧数。',
    },
    'card-bigjank': {
      title: 'BigJank',
      scope: 'app',
      rows: [
        ['定义', '单帧间隔 ≥ max(2 × 基准, 125ms)，125ms = 3 个电影帧（PerfDog 口径）。'],
        ['看什么', '基本对应肉眼能看到的明显卡顿，比 Jank 更严重，定位问题优先看它。'],
      ],
      foot: '和 Jank 共用一套基准，BigJank 一定是 Jank 的子集，两个数可以直接比大小。',
    },
    'card-net': {
      title: '网络 ↓ / ↑',
      scope: 'app',
      rows: [
        ['怎么算', 'dumpsys netstats 按 UID 取本应用流量，合并 DEFAULT（非前台）与 FOREGROUND 两套分桶，用累计字节增量 ÷ 采样间隔折算成 KB/s。'],
        ['降级', 'ROM 不支持按 UID 时退回整机口径，报告里 netScope / netSource 会标出来。'],
      ],
      foot: '整机口径和应用口径不能直接比；同一个包在不同机型上也可能走不同路径。',
    },
    'card-gpu': {
      title: 'GPU',
      scope: 'device',
      rows: [
        ['来源', '依次尝试高通 kgsl（gpu_busy_percentage / gpubusy 累计增量）、Mali utilization、MTK /proc/mtk_mali，部分节点需要 root。'],
        ['显示 --', '表示这台机器没有可读节点，不是 GPU 占用 0。'],
      ],
      foot: '整机口径：只反映 GPU 整体忙闲，不区分是哪个应用在用。',
    },
    'card-battery': {
      title: '电池',
      scope: 'device',
      rows: [
        ['来源', 'dumpsys battery 的 level，剩余电量百分比。'],
        ['看什么', '一次采集内基本不动，主要用来确认设备没在充电、也没异常掉电。'],
      ],
      foot: '温度看「机身温度」卡片；电流 / 功耗曲线在下面的图表区。',
    },
    'card-temp': {
      title: '机身温度',
      scope: 'device',
      rows: [
        ['主数值', '机身 / 电池温度，接近手感。优先取 thermalservice 的机身节点，取不到时用电池温度兜底。'],
        ['下方小字', '外壳是节点估算温度，结温是 CPU 芯片内部温度，两者只作参考。'],
      ],
      foot: '芯片结温常年比外壳高 20~30°C，属正常现象，不代表机身发烫。',
    },
  };

  let panel = null;
  let dots = [];
  let currentKey = null;

  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'metric-help-panel';
    panel.setAttribute('role', 'dialog');
    panel.hidden = true;
    document.body.appendChild(panel);
    return panel;
  }

  function render(item) {
    const tag = item.scope === 'device'
      ? '<span class="metric-help-panel__tag metric-help-panel__tag--device">整机口径</span>'
      : '<span class="metric-help-panel__tag">应用口径</span>';
    const rows = item.rows.map(([k, v]) => `<li><b>${esc(k)}</b>：${esc(v)}</li>`).join('');
    return `<div class="metric-help-panel__head">`
      + `<span class="metric-help-panel__title">${esc(item.title)}</span>${tag}</div>`
      + `<ul class="metric-help-panel__list">${rows}</ul>`
      + `<div class="metric-help-panel__foot">${esc(item.foot)}</div>`;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  function place(dot) {
    const r = dot.getBoundingClientRect();
    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;
    let left = r.left + r.width / 2 - pw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    let top = r.bottom + 8;
    if (top + ph > window.innerHeight - 8) {
      const above = r.top - ph - 8;
      top = above >= 8 ? above : Math.max(8, window.innerHeight - ph - 8);
    }
    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(top) + 'px';
  }

  function setExpanded(activeDot) {
    dots.forEach((d) => d.setAttribute('aria-expanded', d === activeDot ? 'true' : 'false'));
  }

  function close() {
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    currentKey = null;
    setExpanded(null);
  }

  function openFor(key, dot) {
    const item = DESC[key];
    if (!item) return;
    ensurePanel();
    if (currentKey === key) { close(); return; }
    panel.innerHTML = render(item);
    panel.hidden = false;
    // 先显示再测量，才能拿到真实高度做上/下翻转
    panel.style.visibility = 'hidden';
    place(dot);
    panel.style.visibility = '';
    currentKey = key;
    setExpanded(dot);
  }

  function enhance() {
    const cards = document.querySelectorAll('.cards .card');
    cards.forEach((card) => {
      const item = DESC[card.id];
      const label = card.querySelector('.card-label');
      if (!item || !label || label.querySelector('.metric-help-dot')) return;

      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'metric-help-dot';
      dot.textContent = '!';
      dot.setAttribute('aria-label', item.title + ' 口径说明');
      dot.setAttribute('aria-expanded', 'false');
      dot.setAttribute('aria-controls', PANEL_ID);
      dot.title = '点击查看口径说明';
      dot.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openFor(card.id, dot);
      });
      dot.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close();
      });

      label.appendChild(dot);
      dots.push(dot);
    });
  }

  // 点面板内部不算「点外部」，方便选中文字
  document.addEventListener('click', (e) => {
    if (!panel || panel.hidden) return;
    if (panel.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.metric-help-dot')) return;
    close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enhance);
  } else {
    enhance();
  }
})();
