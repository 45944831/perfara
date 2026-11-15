'use strict';

/**
 * 顶栏「旁路取证」后面的 ! 说明浮层。
 *
 * 为什么不复用 title：一句话讲不清「抓什么 / 什么时候抓 / 有没有开销 / 产物在哪」，
 * tooltip 又不能选中复制。这里做成点击展开的面板。
 *
 * 独立性：不依赖 perfAPI / renderer.js。主脚本因为设备或后端异常没跑起来时，
 * 说明仍然要能看，所以单独一个文件、加载在 renderer.js 之前。
 *
 * 交互：点 ! 展开 / 收起；点面板内部不关；点面板外部、按 Esc、窗口失焦都收起。
 * ! 在 <label> 里面（视觉上贴着「旁路取证」），所以必须 preventDefault，
 * 否则 label 的默认激活行为会把复选框一起勾上。
 */
(function () {
  const wrap = document.querySelector('.trace-capture-wrap');
  const dot = document.getElementById('btn-trace-help');
  const panel = document.getElementById('trace-help-panel');
  if (!wrap || !dot || !panel) return;

  function isOpen() {
    return !panel.hidden;
  }

  function setOpen(open) {
    panel.hidden = !open;
    dot.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function toggle(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    setOpen(!isOpen());
  }

  dot.addEventListener('click', toggle);

  // 键盘可达：Enter / Space 切换，Esc 收起
  dot.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      toggle(e);
    } else if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      setOpen(false);
    }
  });

  // 面板内的点击不算「点外部」，否则选中文字就关掉了
  panel.addEventListener('click', (e) => e.stopPropagation());

  document.addEventListener('click', (e) => {
    if (isOpen() && !wrap.contains(e.target)) setOpen(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) setOpen(false);
  });

  // 窗口失焦（切到别的应用）时收起，避免回来时浮层还挂着
  window.addEventListener('blur', () => {
    if (isOpen()) setOpen(false);
  });
})();
