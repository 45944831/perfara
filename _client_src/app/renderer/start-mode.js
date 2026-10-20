'use strict';

/**
 * 「开始」时的采集模式选择。
 *
 *   fresh  —— 重新采集：清空上一轮数据，从零开始
 *   append —— 继续采集：保留上一轮数据，新数据接在后面（同设备/同应用）
 *
 * 用法：
 *   const mode = await window.askStartMode(已有采样点数);  // 'fresh' | 'append' | null(取消)
 */
(function () {
  let root = null;
  let resolveFn = null;

  function build() {
    const el = document.createElement('div');
    el.className = 'perfara-modal start-mode-modal';
    el.hidden = true;
    el.innerHTML = [
      '<div class="perfara-modal__backdrop"></div>',
      '<div class="perfara-modal__box">',
      '  <div class="perfara-modal__title">已有采集数据</div>',
      '  <div class="perfara-modal__body">',
      '    当前设备与应用下已有 <b id="start-mode-count">0</b> 个采样点。<br>',
      '    「重新采集」会清空上一轮数据；「继续采集」会把新数据接在上一轮后面。',
      '  </div>',
      '  <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">',
      '    <button type="button" class="btn btn-sm" data-mode="cancel">取消</button>',
      '    <button type="button" class="btn btn-sm" data-mode="append">继续采集</button>',
      '    <button type="button" class="btn btn-primary" data-mode="fresh">重新采集</button>',
      '  </div>',
      '</div>',
    ].join('\n');
    document.body.appendChild(el);

    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mode]');
      if (btn) {
        const m = btn.getAttribute('data-mode');
        finish(m === 'cancel' ? null : m);
        return;
      }
      // 点遮罩关闭 = 取消
      if (e.target.classList && e.target.classList.contains('perfara-modal__backdrop')) {
        finish(null);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && el && !el.hidden) finish(null);
    });

    return el;
  }

  function finish(v) {
    if (!root) return;
    root.hidden = true;
    const r = resolveFn;
    resolveFn = null;
    if (r) r(v);
  }

  /**
   * @param {number} count 已有采样点数
   * @returns {Promise<'fresh'|'append'|null>}
   */
  window.askStartMode = function (count) {
    if (!root) root = build();
    const el = root.querySelector('#start-mode-count');
    if (el) el.textContent = String(count || 0);
    root.hidden = false;
    return new Promise((res) => { resolveFn = res; });
  };
})();
