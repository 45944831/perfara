'use strict';

/**
 * 未激活试用：本进程会话内全局剩余秒数。打开软件后首次需要时从配置初始化；
 * 仅在实际采集中每满 10 秒减 10；停止采集则暂停扣减。
 */

let _remaining = null;
let _collectTimer = null;

function effectiveTrialSec(app, activationStore, readConfigOut) {
  const cfg = readConfigOut();
  let base = Math.max(0, Math.floor(Number(cfg.unactivatedTrialSec) || 0));
  if (activationStore.isServerTrialDisabled(app)) base = 0;
  return base;
}

function clearCollectTimer() {
  if (_collectTimer) {
    clearInterval(_collectTimer);
    _collectTimer = null;
  }
}

/** 登录拉取或激活成功后调用，使下次按新策略重新初始化 */
function resetSession() {
  _remaining = null;
  clearCollectTimer();
}

function ensureInit(app, getMachineUid, activationStore, readConfigOut) {
  if (_remaining !== null) return;
  const uid = getMachineUid();
  if (activationStore.getActivationState(app, uid).activated) {
    _remaining = -1;
    return;
  }
  _remaining = effectiveTrialSec(app, activationStore, readConfigOut);
}

/**
 * 开始采集前：已激活则放行；未激活且剩余<=0 则拒绝。
 */
function canStartCollect(app, getMachineUid, activationStore, readConfigOut) {
  ensureInit(app, getMachineUid, activationStore, readConfigOut);
  const uid = getMachineUid();
  if (activationStore.getActivationState(app, uid).activated) {
    return { ok: true };
  }
  if (_remaining <= 0) {
    return { ok: false, reason: '试用时长已用完，请激活后继续使用' };
  }
  return { ok: true, remainingSec: _remaining };
}

function onCollectStarted(app, getMachineUid, activationStore, readConfigOut, sendToRenderer) {
  ensureInit(app, getMachineUid, activationStore, readConfigOut);
  const uid = getMachineUid();
  if (activationStore.getActivationState(app, uid).activated) return;
  if (_remaining <= 0) return;
  clearCollectTimer();
  _collectTimer = setInterval(() => {
    _remaining = Math.max(0, _remaining - 10);
    sendToRenderer('trial-budget-tick', { remainingSec: _remaining });
    if (_remaining <= 0) {
      clearCollectTimer();
      sendToRenderer('trial-budget-exhausted', {});
    }
  }, 10000);
}

function onCollectStopped() {
  clearCollectTimer();
}

function getBudgetState(app, getMachineUid, activationStore, readConfigOut) {
  ensureInit(app, getMachineUid, activationStore, readConfigOut);
  const uid = getMachineUid();
  const act = activationStore.getActivationState(app, uid);
  const initial = effectiveTrialSec(app, activationStore, readConfigOut);
  if (act.activated) {
    return { activated: true, remainingSec: null, initialSec: initial };
  }
  const rem = _remaining === -1 ? 0 : Math.max(0, _remaining);
  return {
    activated: false,
    remainingSec: rem,
    initialSec: initial,
  };
}

module.exports = {
  resetSession,
  clearCollectTimer,
  canStartCollect,
  onCollectStarted,
  onCollectStopped,
  getBudgetState,
};
