'use strict';

/**
 * 激活模块（激活校验已移除）。
 *
 * 原实现会读取 userData 下的 activitecode.json，用
 * 「8 位 base36 到期时间 + SHA512(uid+ts+SECRET) 前 24 位」校验激活码，
 * 未激活时只给有限试用时长，并在界面显示「未激活，请先激活」。
 *
 * 现在统一返回「已激活、永久有效」：界面不显示激活入口与提示，
 * 采集与上传不再受激活状态限制。对外接口与原模块保持一致，
 * 以免 main.js / preload.js 的调用点需要改动。
 */

const path = require('path');

/**
 * 激活码校验已彻底移除。
 * 原先的 SECRET_KEY / ACTIVATION_HASH_ALG 常量（用于「8位base36到期时间 + SHA512 签名」校验）
 * 已一并删除——它们不再参与任何逻辑，留在源码里只会造成安全卫生困扰与误读。
 */
const ACTIVATION_FILENAME = 'activitecode.json';

/** 永久有效的到期时间（2099-12-31 23:59:59 UTC） */
const PERPETUAL_EXPIRY_UNIX_SEC = 4102444799;

const RESPONSE_CODE = {
  STARTUP: 0,
  API_SKIP: 1,
  SERVER_CLEAR: 2,
  PAGE_OK: 4,
};

function getUserDataPath(app) {
  try {
    return app.getPath('userData');
  } catch (_) {
    return path.join(__dirname, '..');
  }
}

function activationFilePath(app) {
  return path.join(getUserDataPath(app), ACTIVATION_FILENAME);
}

/** 恒定通过 */
function verifyActivationCode() {
  return { ok: true, expiryUnixSec: PERPETUAL_EXPIRY_UNIX_SEC };
}

/** 恒定「已激活、永久有效」；hideActivationHints=true 让界面隐藏激活区 */
function getActivationState(app, currentUid) {
  return {
    activated: true,
    uid: currentUid,
    expiryUnixSec: PERPETUAL_EXPIRY_UNIX_SEC,
    expiryLabel: '永久',
    message: '',
    savedCode: '',
    savedAt: null,
    responseCode: RESPONSE_CODE.STARTUP,
    hideActivationHints: true,
    mustShowActivationBar: false,
  };
}

/** 上传鉴权参数：para1 用本机 uid，para2 用服务端约定占位值 */
function getUploadCredentials(app, currentUid) {
  return {
    ok: true,
    para1: String(currentUid || '').trim(),
    para2: 'perefara',
  };
}

const UNACTIVATED_UPLOAD_PARA2 = 'perefara';

function getUploadCredentialsOrUnactivatedPlaceholder(app, currentUid) {
  return {
    ok: true,
    para1: String(currentUid || '').trim(),
    para2: UNACTIVATED_UPLOAD_PARA2,
    unactivated: false,
  };
}

/** 上传 URL 的 para1：原为激活码，现固定 test（服务端不校验） */
function getUploadPara1OrTest() {
  return 'test';
}

/** 兼容调用：不再落盘任何激活数据 */
function saveActivation() {
  return {
    ok: true,
    expiryUnixSec: PERPETUAL_EXPIRY_UNIX_SEC,
    expiryLabel: '永久',
    saved: false,
  };
}

/** 兼容调用：远端 loginurl 结果不再影响本地状态 */
function applyLoginFetchResult() {
  return { applied: false, skipped: true, reason: '激活校验已移除' };
}

function isServerTrialDisabled() {
  return false;
}

function setServerTrialDisabled() {
  /* no-op */
}

module.exports = {
  verifyActivationCode,
  getActivationState,
  getUploadCredentials,
  getUploadCredentialsOrUnactivatedPlaceholder,
  getUploadPara1OrTest,
  UNACTIVATED_UPLOAD_PARA2,
  RESPONSE_CODE,
  saveActivation,
  applyLoginFetchResult,
  isServerTrialDisabled,
  setServerTrialDisabled,
  activationFilePath,
};
