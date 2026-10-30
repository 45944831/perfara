'use strict';

/**
 * 弱网测试时段追踪。
 *
 * WeakNet 是独立进程，采样点里没有任何「弱网」字段，等报告写完再去问它已经来不及
 * （进程可能早退了）。所以采集期间按固定间隔轮询它的控制接口，把「限速开启」的
 * 时段记成段，随 data.js 落盘；报告页据此渲染「弱网总结分析」，没开弱网就没有段。
 *
 * 只有一个来源：本机引擎的控制接口（127.0.0.1:8899，端口被占时顺延）。
 * USB 接管的手机不用装 App：手机流量经 adb reverse 进本机引擎，限速就在本机做，
 * 段按「手机」归类（见 phoneUsb）。
 */

const http = require('http');

const CTRL_PORT = Number(process.env.PERFARA_WEAKNET_CTRL || 8899) || 8899;
/**
 * 轮询间隔。状态只在段边界上有意义，2 s 足够分辨「开了多久」，
 * 又不至于为了一份报告在主进程里每秒解析一次 /api/status（每次几 KB）。
 */
const POLL_MS = 2000;
const REQ_TIMEOUT_MS = 900;
/** 连续这么多次探不到接口，认为 WeakNet 已退出：把开着的段按最后一次成功时刻收口 */
const LOST_LIMIT = 3;

function _num(v) {
  return (typeof v === 'number' && isFinite(v)) ? v : null;
}

/** 参数指纹：只有真正影响网络表现的数字参与，`name` 变不算换场景 */
function _profileSig(prof) {
  if (!prof || typeof prof !== 'object') return '';
  return Object.keys(prof).sort()
    .map((k) => (k === 'name' ? '' : k + ':' + prof[k]))
    .join(',');
}

function _clone(o) {
  return o && typeof o === 'object' ? JSON.parse(JSON.stringify(o)) : {};
}

/**
 * 段状态机：喂进每一次轮询结果，产出「限速开启」的时段。
 * 与轮询解耦，单测可以直接按时间点喂状态，不用等真实计时器。
 */
class WeaknetSegments {
  constructor() {
    this.segments = [];
    this.reachable = false;
    this.lastOkTs = 0;
    this.lost = 0;
    this._cur = null;
    /** PC 端限速段是否要记成「手机」（USB 接管时手机流量走的就是这个引擎） */
    this.phoneUsb = false;
  }

  /** @param {{pc?:object}} results @param {number} now ms */
  feed(results, now) {
    const ts = (typeof now === 'number') ? now : Date.now();
    const has = results && results.pc;
    if (!has) {
      // 一次连不上不代表关掉了（进程忙、端口刚转发好都可能抖一下）：先按原样
      // 保持段开着，连续 LOST_LIMIT 次才认定 WeakNet 退出，并按最后一次成功的
      // 时刻收口 —— 不能用「发现它没了」的时刻，那会把弱网时段凭空拉长几秒。
      this.lost += 1;
      if (this.lost >= LOST_LIMIT) this._close(this.lastOkTs || ts);
      return;
    }
    this.reachable = true;
    this.lastOkTs = ts;
    this.lost = 0;

    const active = this._activeOf(results);
    if (!active) {
      this._close(ts);
      return;
    }

    const st = active.st;
    const prof = (st.profile && typeof st.profile === 'object') ? st.profile : {};
    const key = String(st.preset_key || '');
    const name = String(prof.name || key || '弱网');
    const sig = _profileSig(prof);
    const scope = (st.scope && typeof st.scope === 'object') ? String(st.scope.mode || '') : '';
    const scopeCount = (st.scope && Array.isArray(st.scope.list)) ? st.scope.list.length : 0;
    const stats = (st.stats && typeof st.stats === 'object') ? st.stats : {};
    const down = _num(stats.down);
    const up = _num(stats.up);

    // 换来源 / 换场景 / 中途改参数：旧段收口，新段从这一刻起算
    if (this._cur && (this._cur.source !== active.source || this._cur.key !== key ||
        this._cur._sig !== sig)) {
      this._close(ts);
    }
    if (!this._cur) {
      this._cur = {
        start: ts, end: ts,
        source: active.source,
        key, name, scope, scopeCount,
        profile: _clone(prof),
        _sig: sig,
        _down0: down, _up0: up,
        _downLast: down, _upLast: up,
      };
      return;
    }
    this._cur.end = ts;
    this._cur.name = name;
    if (down != null) this._cur._downLast = down;
    if (up != null) this._cur._upLast = up;
  }

  /** USB 接管的手机，流量就是被这个本机引擎限的，来源要记成手机。 */
  _activeOf(results) {
    if (!results || !results.pc || !results.pc.limit_on) return null;
    return { source: this.phoneUsb ? 'android' : 'pc', st: results.pc };
  }

  _close(ts) {
    if (!this._cur) return;
    const seg = this._cur;
    this._cur = null;
    seg.end = Math.max(seg.start, ts || this.lastOkTs || Date.now());
    if (seg._down0 != null && seg._downLast != null) {
      seg.downBytes = Math.max(0, seg._downLast - seg._down0);
    }
    if (seg._up0 != null && seg._upLast != null) {
      seg.upBytes = Math.max(0, seg._upLast - seg._up0);
    }
    delete seg._down0; delete seg._downLast;
    delete seg._up0; delete seg._upLast;
    delete seg._sig;
    this.segments.push(seg);
  }

  /** 收口并取走全部段（取走后清空，避免下一轮采集带上上一轮的数据） */
  finish(now) {
    this._close((typeof now === 'number') ? now : Date.now());
    const out = this.segments;
    this.segments = [];
    return out;
  }
}

// ─── 轮询：把接口结果喂给状态机 ──────────────────────────────────────────────

function _getJson(port, cb) {
  let done = false;
  const finish = (err, obj) => {
    if (done) return;
    done = true;
    cb(err, obj);
  };
  let req = null;
  try {
    req = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout: REQ_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return finish(new Error('HTTP ' + res.statusCode));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        // 正常响应含最近 60 条事件，几十 KB；超过这个量说明端点不是 WeakNet
        if (body.length > 512 * 1024) {
          try { req.destroy(); } catch (_) {}
          finish(new Error('payload 过大'));
        }
      });
      res.on('end', () => {
        try { finish(null, JSON.parse(body)); } catch (e) { finish(e); }
      });
      res.on('error', (e) => finish(e));
    });
  } catch (e) {
    return finish(e);
  }
  req.on('timeout', () => { try { req.destroy(); } catch (_) {} finish(new Error('timeout')); });
  req.on('error', (e) => finish(e));
}

/** @type {NodeJS.Timeout|null} */
let _timer = null;
let _state = null;
let _pcPort = CTRL_PORT;

function _poll() {
  if (!_state) return;
  const st = _state;
  _getJson(_pcPort, (_err, data) => {
    if (!st) return;
    st.feed(data && typeof data === 'object' ? { pc: data } : {}, Date.now());
  });
}

/**
 * 开始追踪。
 * @param {{ ctrlPort?: number, phoneUsb?: boolean }} [opts]
 *   ctrlPort：本机引擎握手后的实际控制端口（端口被占时会被顺延），省略用默认 8899；
 *   phoneUsb：手机开着 USB 接管时为 true，本机引擎的限速段记到「手机」名下
 */
function start(opts) {
  stop();
  _state = new WeaknetSegments();
  _state.phoneUsb = !!(opts && opts.phoneUsb);
  const c = opts && Number(opts.ctrlPort);
  _pcPort = (c && c > 0 && c < 65536) ? c : CTRL_PORT;
  _poll();
  _timer = setInterval(_poll, POLL_MS);
  if (_timer && typeof _timer.unref === 'function') _timer.unref();
}

/**
 * 采集中途接管/解除手机时同步来源标签。
 * 只在采集中才有效果（没有活跃的状态机就什么都不做）；下一段按新来源记。
 */
function setPhoneUsb(on) {
  if (_state) _state.phoneUsb = !!on;
}

/**
 * 结束追踪并取出结果。返回的段已全部收口，可直接写进 data.js。
 * @returns {{ ctrlPort:number, pollMs:number, reachable:boolean, segments:Array }}
 */
function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  const st = _state;
  const port = _pcPort;
  _state = null;
  _pcPort = CTRL_PORT;
  if (!st) return { ctrlPort: port, pollMs: POLL_MS, reachable: false, segments: [] };
  return {
    ctrlPort: port,
    pollMs: POLL_MS,
    reachable: st.reachable,
    segments: st.finish(Date.now()),
  };
}

module.exports = { start, stop, setPhoneUsb, WeaknetSegments, CTRL_PORT, POLL_MS };
