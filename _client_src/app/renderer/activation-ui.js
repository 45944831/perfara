'use strict';

(function initActivationUI() {
  let _activated = false;
  let _blockHintTimer = 0;
  /** 未激活试用：配置初始池（秒）与会话剩余（由主进程 trial-budget 维护） */
  let _trialInitialSec = 0;
  let _trialRemainingSec = 0;
  /** 来自 config 的 unactivatedTrialSec；>1 且未激活时隐藏顶栏激活按钮/状态/提醒 */
  let _configUnactivatedTrialSec = 0;
  /** 与 activitecode.json 中 responseCode 一致；hideActivationHints 由主进程按 0/1/2/4 与是否校验通过计算 */
  let _responseCode;
  let _hideActivationHints = false;
  /** code=4 最高优先（含已激活/有效期内须显示有效期）；code=2、UID 不一致等同理；优先级高于未激活试用隐藏 */
  let _mustShowActivationBar = false;

  function ensureBlockHint() {
    let el = document.getElementById('activation-block-hint');
    if (el) return el;
    const btn = document.getElementById('btn-activation');
    if (!btn || !btn.parentNode) return null;
    el = document.createElement('span');
    el.id = 'activation-block-hint';
    el.className = 'activation-block-hint';
    el.setAttribute('aria-live', 'polite');
    el.hidden = true;
    btn.insertAdjacentElement('afterend', el);
    return el;
  }

  function showActivationRequiredHint() {
    if (
      !_activated &&
      _trialInitialSec > 0 &&
      _trialRemainingSec > 0 &&
      !_mustShowActivationBar
    ) {
      return;
    }
    const el = ensureBlockHint();
    if (!el) return;
    if (_blockHintTimer) {
      clearTimeout(_blockHintTimer);
      _blockHintTimer = 0;
    }
    el.textContent = '请先激活';
    el.hidden = false;
    _blockHintTimer = setTimeout(() => {
      el.hidden = true;
      _blockHintTimer = 0;
    }, 5000);
  }

  function hideActivationBlockHint() {
    if (_blockHintTimer) {
      clearTimeout(_blockHintTimer);
      _blockHintTimer = 0;
    }
    const el = document.getElementById('activation-block-hint');
    if (el) el.hidden = true;
  }

  async function openActivationModal() {
    ensureModal();
    const wrap = document.getElementById('activation-modal');
    const msgEl = document.getElementById('activation-msg');
    if (msgEl) {
      msgEl.hidden = true;
      msgEl.textContent = '';
      msgEl.className = 'activation-msg';
    }
    if (wrap) wrap.hidden = false;
    try {
      const uid = await window.perfAPI.getMachineUid();
      const inp = document.getElementById('activation-uid-inp');
      if (inp) inp.value = uid;
    } catch (_) {}
    const codeInp = document.getElementById('activation-code-inp');
    if (codeInp) {
      codeInp.value = '';
      try {
        const state = await window.perfAPI.activationGetState();
        if (state.savedCode) {
          codeInp.value = state.savedCode;
        }
      } catch (_) {}
      requestAnimationFrame(() => codeInp.focus());
    }
  }

  function ensureModal() {
    if (document.getElementById('activation-modal')) return;
    const wrap = document.createElement('div');
    wrap.id = 'activation-modal';
    wrap.className = 'activation-modal-root';
    wrap.hidden = true;
    wrap.innerHTML = `
<div class="activation-modal-backdrop"></div>
<div class="activation-modal-panel" role="dialog" aria-modal="true" aria-labelledby="activation-modal-title">
  <button type="button" id="activation-modal-close" class="activation-modal-close" aria-label="关闭">×</button>
  <div class="activation-login-card">
    <div class="activation-login-head">
      <div class="activation-login-avatar" aria-hidden="true">
        <svg class="activation-login-avatar-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 12a4 4 0 100-8 4 4 0 000 8z" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>
          <path d="M4 20a8 8 0 0116 0" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>
        </svg>
      </div>
      <h2 id="activation-modal-title" class="activation-login-title">激活</h2>
      <p class="activation-login-sub">请输入激活码以继续使用</p>
    </div>
    <div class="activation-field activation-field-row">
      <label class="activation-label" for="activation-uid-inp">用户名</label>
      <input id="activation-uid-inp" type="text" readonly class="activation-input activation-input--uid" spellcheck="false" />
    </div>
    <div class="activation-field activation-field-row">
      <label class="activation-label" for="activation-code-inp">激活码</label>
      <input id="activation-code-inp" type="text" class="activation-input activation-input--code" placeholder="请输入激活码" spellcheck="false" autocomplete="off" />
    </div>
    <p id="activation-msg" class="activation-msg" hidden></p>
    <div class="activation-login-actions">
      <button type="button" id="activation-submit" class="btn btn-primary activation-btn-submit">激活</button>
      <button type="button" id="activation-fetch-url" class="activation-link-btn">获取激活码</button>
    </div>
  </div>
</div>`;
    document.body.appendChild(wrap);

    document.getElementById('activation-modal-close').onclick = () => {
      wrap.hidden = true;
    };
    wrap.querySelector('.activation-modal-backdrop').onclick = () => {
      wrap.hidden = true;
    };
    document.getElementById('activation-fetch-url').onclick = async () => {
      const msg = document.getElementById('activation-msg');
      msg.hidden = false;
      msg.textContent = '正在打开浏览器…';
      msg.className = 'activation-msg activation-msg--info';
      try {
        const r = await window.perfAPI.activationOpenFetchUrl();
        msg.textContent = r.ok ? '已在浏览器中打开获取页面。' : (r.reason || '打开失败');
        msg.className = r.ok ? 'activation-msg activation-msg--ok' : 'activation-msg activation-msg--err';
      } catch (e) {
        msg.textContent = e.message || String(e);
        msg.className = 'activation-msg activation-msg--err';
      }
    };
    document.getElementById('activation-submit').onclick = async () => {
      const code = (document.getElementById('activation-code-inp').value || '').trim();
      const msg = document.getElementById('activation-msg');
      msg.hidden = false;
      msg.className = 'activation-msg activation-msg--info';
      msg.textContent = '校验中…';
      try {
        const r = await window.perfAPI.activationSubmit(code);
        if (r.ok) {
          msg.className = 'activation-msg activation-msg--ok';
          msg.textContent = '激活成功。';
          _activated = true;
          hideActivationBlockHint();
          document.body.classList.remove('not-activated');
          document.body.classList.remove('trial-mode');
          applyStatus({ activated: true, expiryLabel: r.expiryLabel });
          wrap.hidden = true;
          updateActivationBarVisibility();
        } else if (r.saved) {
          msg.hidden = false;
          msg.className = 'activation-msg activation-msg--warn';
          msg.textContent = r.reason
            ? `激活码已保存，但未通过校验：${r.reason}`
            : '激活码已保存，但未通过校验。';
          _activated = false;
          document.body.classList.add('not-activated');
          await refresh();
        } else {
          msg.hidden = true;
          window.alert(r.reason || '未激活，请先激活');
          void openActivationModal();
        }
      } catch (e) {
        msg.hidden = true;
        window.alert('未激活，请先激活');
        void openActivationModal();
      }
    };
  }

  function applyStatus(state) {
    const el = document.getElementById('activation-status');
    if (!el) return;
    if (state.hideActivationHints) {
      el.textContent = '';
      el.classList.remove('activation-status--warn');
      el.classList.remove('activation-status--ok');
      return;
    }
    const ok = state.activated === true && !!state.expiryLabel;
    if (ok) {
      el.textContent = '有效期至 ' + state.expiryLabel;
      el.classList.remove('activation-status--warn');
      el.classList.add('activation-status--ok');
    } else {
      el.textContent = state.message || '未激活：请点击「激活」完成验证';
      el.classList.add('activation-status--warn');
      el.classList.remove('activation-status--ok');
    }
  }

  function clickAllowed(t) {
    if (t.closest('#activation-modal')) return true;
    if (t.closest('#btn-activation')) return true;
    if (t.closest('#activation-status')) return true;
    if (t.closest('#activation-block-hint')) return true;
    if (t.closest('.topbar-left')) return true;
    return false;
  }

  function blockIfNeeded(e) {
    if (_activated) return;
    if (_trialInitialSec > 0 && _trialRemainingSec > 0 && !_mustShowActivationBar) return;
    if (clickAllowed(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    showActivationRequiredHint();
  }

  function updateActivationBarVisibility() {
    const trialPoolActive =
      !_activated && _trialInitialSec > 0 && _trialRemainingSec > 0;
    /** 试用会话内且非强制展示：隐藏顶栏「激活」与状态（含图中未激活提示），与 code=0/1 校验失败共存时仍以试用为准 */
    const hideByTrial = trialPoolActive && !_mustShowActivationBar;
    document.body.classList.toggle('trial-hide-activation-bar', hideByTrial);
    const btnAct = document.getElementById('btn-activation');
    const statusEl = document.getElementById('activation-status');
    if (btnAct) btnAct.hidden = hideByTrial || _hideActivationHints;
    if (statusEl) statusEl.hidden = hideByTrial || _hideActivationHints;
    if (hideByTrial) hideActivationBlockHint();
  }

  async function refresh() {
    ensureModal();
    try {
      let cfgOut = {};
      try {
        cfgOut = (await window.perfAPI.getConfigOut()) || {};
      } catch (_) {}
      _configUnactivatedTrialSec = Math.max(
        0,
        Math.floor(Number(cfgOut.unactivatedTrialSec) || 0),
      );

      let trial = { initialSec: 0, remainingSec: 0, activated: false };
      try {
        trial = (await window.perfAPI.trialBudgetGet()) || trial;
      } catch (_) {
        trial.initialSec = _configUnactivatedTrialSec;
        trial.remainingSec = _configUnactivatedTrialSec;
      }
      _trialInitialSec =
        trial.initialSec != null ? Math.max(0, Math.floor(Number(trial.initialSec))) : 0;
      _trialRemainingSec =
        trial.remainingSec != null ? Math.max(0, Math.floor(Number(trial.remainingSec))) : 0;

      const state = await window.perfAPI.activationGetState();
      _activated = state.activated === true;
      _responseCode =
        state.responseCode != null && Number.isFinite(Number(state.responseCode))
          ? Number(state.responseCode)
          : undefined;
      _hideActivationHints = state.hideActivationHints === true;
      _mustShowActivationBar = state.mustShowActivationBar === true;
      document.body.classList.toggle('not-activated', !_activated);
      document.body.classList.toggle(
        'trial-mode',
        !_activated &&
          _trialInitialSec > 0 &&
          _trialRemainingSec > 0 &&
          !_mustShowActivationBar,
      );
      if (_activated) hideActivationBlockHint();
      applyStatus(state);
      updateActivationBarVisibility();
      const uidInp = document.getElementById('activation-uid-inp');
      if (uidInp && state.uid) uidInp.value = state.uid;
      try {
        const uid = await window.perfAPI.getMachineUid();
        if (uidInp) uidInp.value = uid;
      } catch (_) {}
      const codeInp = document.getElementById('activation-code-inp');
      if (codeInp && state.savedCode) {
        codeInp.value = state.savedCode;
      }
    } catch (err) {
      _activated = false;
      _responseCode = undefined;
      _hideActivationHints = false;
      _mustShowActivationBar = false;
      applyStatus({ activated: false, message: '无法读取激活状态：' + (err.message || String(err)) });
      document.body.classList.add('not-activated');
      document.body.classList.toggle(
        'trial-mode',
        !_activated &&
          _trialInitialSec > 0 &&
          _trialRemainingSec > 0 &&
          !_mustShowActivationBar,
      );
      updateActivationBarVisibility();
    }
  }

  window.__perfActivation = {
    openActivationModal: () => void openActivationModal(),
    refresh: () => void refresh(),
  };

  window.addEventListener('DOMContentLoaded', () => {
    ensureModal();
    const btn = document.getElementById('btn-activation');
    if (btn) {
      btn.addEventListener('click', () => void openActivationModal());
    }
    document.addEventListener('click', blockIfNeeded, true);
    try {
      window.perfAPI.onActivationRefresh(() => void refresh());
    } catch (_) {}
    try {
      window.perfAPI.onTrialBudgetTick(() => void refresh());
    } catch (_) {}
    try {
      window.perfAPI.onTrialBudgetChanged(() => void refresh());
    } catch (_) {}
    try {
      window.perfAPI.onTrialBudgetExhausted(async () => {
        await refresh();
        if (!_activated) void openActivationModal();
      });
    } catch (_) {}
    refresh();
  });
})();
