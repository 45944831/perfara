'use strict';

const fs = require('fs');
const path = require('path');

/** 与 configout/config.js 中 `var upload={...}` 字段一致（不含 logpannel，logpannel 仅来自 configout 文件） */
const DEFAULT_CONFIG = {
  usePreGpuIos17: 0,
  appname: 'Perfara',
  username: '',
  check: true,
  para1: '',
  para2: '',
  // 本工具完全离线：不向任何外部域名发起请求，loginurl 保持为空。
  // （原值指向第三方授权域名，已移除；若将来需要上报，须改为显式可配置且默认留空。）
  loginurl: '',
  report_config: {
    url: '',
  },
  unactivatedTrialSec: 150,
  loginPara1: 'test',
};

function configOutPaths() {
  const paths = [];
  if (process.resourcesPath) {
    paths.push(path.join(process.resourcesPath, 'configout', 'config.js'));
  }
  paths.push(path.join(__dirname, '..', 'configout', 'config.js'));
  return paths;
}

function parseUploadObject(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const i = raw.indexOf('{');
  const j = raw.lastIndexOf('}');
  if (i === -1 || j === -1 || j <= i) return null;
  try {
    return JSON.parse(raw.slice(i, j + 1));
  } catch (_) {
    return null;
  }
}

function coerceLogpannelBool(v) {
  return v === true || v === 1 || String(v).toLowerCase() === 'true';
}

function mapLogPanelAliases(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const o = { ...obj };
  if (o.logpannel === undefined && o.logPanel !== undefined) o.logpannel = o.logPanel;
  if (o.logpannel === undefined && o.log_panel !== undefined) o.logpannel = o.log_panel;
  return o;
}

/**
 * 与 readConfigOut 相同路径顺序；后者后写覆盖前者，故 logpannel 取「最后一个显式声明」。
 * 若所有文件中均未出现 logpannel，默认 true（显示日志区）。
 */
function readLogpannelValueFromConfigOutFiles() {
  let lastDefined = null;
  for (const p of configOutPaths()) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, 'utf8');
      const obj = parseUploadObject(raw);
      if (!obj || typeof obj !== 'object') continue;
      const m = mapLogPanelAliases(obj);
      if (m.logpannel !== undefined) {
        lastDefined = coerceLogpannelBool(m.logpannel);
      }
    } catch (_) {
      continue;
    }
  }
  if (lastDefined !== null) return lastDefined;
  return false;
}

let _logpannelSnapshotRead = false;
let _logpannelSnapshot = false;

/**
 * 应用启动时调用一次：只读 configout/config.js，不合并任何内置 logpannel。
 * 若未调用，首次 getLogpannelFromConfigOut / readConfigOut 时会自动加载。
 */
function loadLogpannelFromConfigOutOnce() {
  if (_logpannelSnapshotRead) return _logpannelSnapshot;
  _logpannelSnapshotRead = true;
  _logpannelSnapshot = readLogpannelValueFromConfigOutFiles();
  console.log('[configout] logpannel =', _logpannelSnapshot, '(configout 路径 last-wins；未声明则默认 true)');
  return _logpannelSnapshot;
}

function getLogpannelFromConfigOut() {
  if (!_logpannelSnapshotRead) loadLogpannelFromConfigOutOnce();
  return _logpannelSnapshot;
}

/**
 * 合并其它配置；logpannel 仅来自 getLogpannelFromConfigOut()（configout 文件，启动时快照）。
 */
function readConfigOut() {
  const merged = { ...DEFAULT_CONFIG };
  for (const p of configOutPaths()) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, 'utf8');
      let obj = parseUploadObject(raw);
      if (obj && typeof obj === 'object') {
        obj = mapLogPanelAliases(obj);
        delete obj.logpannel;
        delete obj.logPanel;
        delete obj.log_panel;
        Object.assign(merged, obj);
      }
    } catch (_) {}
  }
  merged.logpannel = getLogpannelFromConfigOut();
  return merged;
}

function readAppNameFromReports() {
  const c = readConfigOut();
  const n = c.appname != null ? String(c.appname).trim() : '';
  return n || 'Perfara离线版';
}

function readUsePreGpuIos17FromReports() {
  return Number(readConfigOut().usePreGpuIos17) === 1;
}

module.exports = {
  readConfigOut,
  loadLogpannelFromConfigOutOnce,
  getLogpannelFromConfigOut,
  readAppNameFromReports,
  readUsePreGpuIos17FromReports,
  configOutPaths,
};
