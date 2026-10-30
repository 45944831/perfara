'use strict';

/**
 * 采集窗口的「低谷截图」缩略图条。
 * 主进程在 FPS 跌到目标 80% 以下时自动截图并推送 trough-shot，
 * 这里只负责展示：底部横向列表 + 点击全屏预览。
 */
(function () {
  const MAX_THUMBS = 60;

  let stripEl = null;
  let listEl = null;
  let countEl = null;
  let emptyEl = null;
  let overlayEl = null;
  let overlayImg = null;
  let overlayCap = null;
  let count = 0;
  let collapsed = false;

  function ensureDom() {
    if (stripEl) return;

    stripEl = document.createElement('div');
    stripEl.id = 'trough-strip';
    stripEl.className = 'trough-strip';
    stripEl.hidden = true;
    stripEl.innerHTML = [
      '<div class="trough-head">',
      '  <span class="trough-title">低谷截图 <span id="trough-count">0</span></span>',
      '  <span class="trough-hint">FPS 低于目标 80% 时自动截取，点击图片放大</span>',
      '  <button type="button" class="btn btn-sm" data-act="toggle">收起</button>',
      '</div>',
      '<div class="trough-list"></div>',
      '<div class="trough-empty">暂无低谷截图</div>',
    ].join('');
    document.body.insertBefore(stripEl, document.querySelector('.log-panel') || null);

    listEl = stripEl.querySelector('.trough-list');
    emptyEl = stripEl.querySelector('.trough-empty');
    countEl = stripEl.querySelector('#trough-count');
    stripEl.querySelector('[data-act="toggle"]').addEventListener('click', () => {
      collapsed = !collapsed;
      stripEl.classList.toggle('collapsed', collapsed);
      stripEl.querySelector('[data-act="toggle"]').textContent = collapsed ? '展开' : '收起';
    });

    overlayEl = document.createElement('div');
    overlayEl.className = 'trough-overlay';
    overlayEl.hidden = true;
    overlayEl.innerHTML = '<img alt="低谷截图" /><div class="trough-overlay-cap"></div>';
    document.body.appendChild(overlayEl);
    overlayImg = overlayEl.querySelector('img');
    overlayCap = overlayEl.querySelector('.trough-overlay-cap');
    overlayEl.addEventListener('click', closeOverlay);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeOverlay();
    });

    syncEmpty();
  }

  function syncEmpty() {
    if (!emptyEl) return;
    emptyEl.hidden = count > 0;
    if (countEl) countEl.textContent = String(count);
    if (stripEl) stripEl.hidden = count === 0;
  }

  function openOverlay(meta) {
    if (!overlayEl) return;
    overlayImg.src = meta.url || meta.file || '';
    overlayCap.textContent = `${meta.time || ''}  FPS ${meta.fps} / 目标 ${meta.target}`;
    overlayEl.hidden = false;
  }

  function closeOverlay() {
    if (!overlayEl) return;
    overlayEl.hidden = true;
    overlayImg.removeAttribute('src');
  }

  function add(meta) {
    if (!meta || !(meta.url || meta.file)) return;
    ensureDom();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'trough-thumb';
    btn.title = `${meta.time} · FPS ${meta.fps} / 目标 ${meta.target}`;
    btn.innerHTML = '<img alt="" loading="lazy" /><span></span>';
    btn.querySelector('img').src = meta.thumbUrl || meta.thumb || meta.url || meta.file;
    btn.querySelector('span').textContent = `${meta.time} · ${meta.fps} fps`;
    btn.addEventListener('click', () => openOverlay(meta));
    listEl.appendChild(btn);
    count += 1;
    while (listEl.children.length > MAX_THUMBS) {
      listEl.removeChild(listEl.firstChild);
    }
    syncEmpty();
    if (!collapsed) listEl.scrollLeft = listEl.scrollWidth;

    if (window.chartMgr) {
      window.chartMgr.pushTroughShot({
        id: meta.id,
        time: meta.time,
        fps: meta.fps,
        target: meta.target,
        thumb: meta.thumbUrl || meta.thumb || meta.url || meta.file,
        url: meta.url,
        file: meta.file,
      });
    }
  }

  function clear() {
    ensureDom();
    listEl.innerHTML = '';
    count = 0;
    syncEmpty();
    closeOverlay();
    if (window.chartMgr) window.chartMgr.clearTroughShots();
  }

  window.troughShots = { add, clear };

  window.addEventListener('DOMContentLoaded', () => {
    ensureDom();
    try {
      if (window.chartMgr) window.chartMgr.onTroughShotClick(openOverlay);
      if (window.perfAPI && typeof window.perfAPI.onTroughShot === 'function') {
        window.perfAPI.onTroughShot(add);
      }
    } catch (_) {}
  });
})();
