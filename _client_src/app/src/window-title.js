'use strict';

/**
 * 窗口标题格式：标题后跟版本号，有新版本时再跟一个标记。
 * 纯逻辑、不依赖 Electron，方便离线单测；版本号来源由主进程统一提供
 * （包外 version.txt > src/app-version.js 的 APP_VERSION）。
 */
const DEFAULT_APP_NAME = 'Perfara离线版';

/** 去掉开头的 v/V 与首尾空白，避免 version.txt 写 `v...` 时出现 `vv...` */
function normalizeVersion(v) {
  return String(v == null ? '' : v).trim().replace(/^[vV](?=\d)/, '');
}

/**
 * @param {{appName?:string, version?:string, hasUpdate?:boolean}} options
 * @returns {string} 例如 `Perfara - 移动端性能工具  v1.10  · 新版本可用`
 */
function formatWindowTitle(options) {
  const o = options || {};
  const appName = String(o.appName || '').trim() || DEFAULT_APP_NAME;
  const version = normalizeVersion(o.version);
  let title = appName + ' - 移动端性能工具';
  if (version) title += '  v' + version;
  if (o.hasUpdate) title += '  · 新版本可用';
  return title;
}

module.exports = { DEFAULT_APP_NAME, normalizeVersion, formatWindowTitle };
