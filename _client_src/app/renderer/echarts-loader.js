'use strict';

/**
 * echarts 延迟加载器。
 *
 * 为什么单独成文件：4 个渲染页都带 CSP `script-src 'self'`，内联 <script> 会被
 * 浏览器直接拒绝执行，所以加载逻辑只能放在外部脚本里。
 *
 * 为什么不在 <head> 里同步 <script src>：echarts.min.js 有 1.07MB，同步加载会让
 * 窗口先等它下载+解析完才开始渲染；改成运行时注入后，窗口/按钮/日志面板先出来，
 * 图表后补。charts.js 的 ChartManager.init() 会 await window.echartsReady()。
 */
(function () {
  let p = null;

  function inject() {
    return new Promise(function (resolve) {
      const s = document.createElement('script');
      s.src = '../node_modules/echarts/dist/echarts.min.js';
      s.async = true;
      s.onload = function () { resolve(typeof echarts !== 'undefined'); };
      s.onerror = function () {
        console.warn('[charts] echarts 加载失败：图表区域留空，其余功能照常');
        resolve(false);
      };
      document.head.appendChild(s);
    });
  }

  window.echartsReady = function () {
    if (p) return p;
    p = (typeof echarts !== 'undefined') ? Promise.resolve(true) : inject();
    return p;
  };
})();
