'use strict';

/**
 * 惰性模块加载：把「启动期一次性 require 全部采集器」改成「真正用到时才 require」。
 *
 * 主进程启动时会同步 require 五个采集/导出模块（adb.js 就有 49KB），而它们在用户
 * 真正开始采集之前完全用不上。改成惰性加载可以省掉启动路径上的这部分解析与
 * asar 读取开销。
 *
 * 路径基准：相对路径一律以 **app 根目录**（main.js 所在目录）为基准解析，
 * 因此调用方写 `lazy('./src/collector')`，与 main.js 里直接 `require('./src/collector')`
 * 的语义完全一致。（早期实现直接 `require(requirePath)`，基准变成了本文件所在
 * 的 src/，导致打包后 require './src/collector' 被解析成 src/src/collector，
 * 启动采集时报 Cannot find module —— 这里统一修正。）
 *
 * 用法与直接 require 完全一致（同时支持构造函数与静态方法）：
 *     const Collector = lazy('./src/collector');
 *     new Collector(id, pkg, 1000, cfg);        // 触发 require
 *     IosCollector.resolveIosBin();             // 触发 require
 */
const path = require('path');

/** app 根目录（本文件位于 <app>/src/） */
const APP_ROOT = path.resolve(__dirname, '..');

function lazy(requirePath, pick) {
  let mod = null;
  const load = () => {
    if (mod === null) {
      const target =
        typeof requirePath === 'string' && requirePath.startsWith('.')
          ? path.resolve(APP_ROOT, requirePath)
          : requirePath;
      mod = require(target);
    }
    return mod;
  };
  // 模块导出的是对象（如 { PcCollector }）时，pick 指定要代理的成员
  const resolve = () => (pick ? load()[pick] : load());

  // target 是函数，`new Proxy(...)` 时 construct 默认转发给它，
  // 而它内部返回真实模块构造出的实例（构造函数返回对象会覆盖 this）。
  const target = function (...args) {
    const M = resolve();
    return new M(...args);
  };

  return new Proxy(target, {
    get(_t, prop) {
      if (prop === '__lazyLoaded') return mod !== null;
      if (prop === '__lazyRequire') return load;
      const M = resolve();
      const v = M[prop];
      return typeof v === 'function' ? v.bind(M) : v;
    },
    has(_t, prop) {
      return prop in load();
    },
  });
}

module.exports = { lazy };
