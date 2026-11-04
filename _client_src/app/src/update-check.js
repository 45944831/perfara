'use strict';

/**
 * 新版本检查：纯逻辑 + 可注入的网络层，不依赖 Electron，便于离线单测。
 *
 * 约束（离线版定位）：
 *  1) 任何失败（无网 / DNS / 超时 / 限流 / 响应异常）都只返回 { ok:false }，
 *     由调用方静默忽略 —— 不弹窗、不写界面日志、不阻塞启动；
 *  2) 只请求 GitHub 官方 API，不加载任何远程脚本/资源；
 *  3) 跳转地址必须由本模块白名单重建，渲染进程不能传入任意 URL。
 */
const https = require('https');
// 版本号规范（1.0→1.10→2.0→2.10…）统一由 version-scheme.js 定义，
// 这里只做转发，保证 UI 标题、本地版本判定与远端 tag 判定用的是同一套规则。
const {
  parseVersion,
  isValidVersion,
  isLegacyVersion,
  compareVersions,
  isNewerVersion,
} = require('./version-scheme');

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 512 * 1024;

/**
 * 只接受本仓库的 Release 页面，且用固定前缀重建 URL（丢弃 query/hash）。
 * 用于防止把 API 返回的、或被篡改的任意地址交给 shell.openExternal。
 */
function sanitizeReleaseUrl(raw, owner, repo) {
  if (typeof raw !== 'string' || !raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com') return null;
  const prefix = '/' + owner + '/' + repo + '/releases/';
  if (!u.pathname.startsWith(prefix) || u.pathname.indexOf('..') !== -1) return null;
  return 'https://github.com' + u.pathname;
}

/** 默认网络实现；requestImpl 可在测试里替换成假的 request */
function defaultRequest(url, options, callback) {
  const req = https.get(url, options, callback);
  req.setTimeout(options.timeoutMs || DEFAULT_TIMEOUT_MS, () => {
    req.destroy(new Error('request timeout'));
  });
  return req;
}

function requestJson(url, timeoutMs, requestImpl) {
  return new Promise((resolve, reject) => {
    const options = {
      timeoutMs,
      headers: {
        // GitHub API 明确要求 User-Agent，否则直接 403
        'User-Agent': 'Perfara-UpdateCheck',
        Accept: 'application/vnd.github+json',
      },
    };
    let req;
    try {
      req = requestImpl(url, options, (res) => {
        const status = res.statusCode || 0;
        if (status !== 200) {
          try { res.resume(); } catch (_) {}
          reject(new Error('HTTP ' + status));
          return;
        }
        const chunks = [];
        let size = 0;
        let done = false;
        res.on('data', (chunk) => {
          if (done) return;
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            done = true;
            chunks.length = 0;
            try { req.destroy(); } catch (_) {}
            reject(new Error('response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (done) return;
          done = true;
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (_) {
            reject(new Error('invalid JSON'));
          }
        });
        res.on('error', (e) => { if (!done) { done = true; reject(e); } });
      });
    } catch (e) {
      reject(e);
      return;
    }
    if (!req || typeof req.on !== 'function') {
      reject(new Error('bad request implementation'));
      return;
    }
    req.on('timeout', () => {
      try { req.destroy(); } catch (_) {}
      reject(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

/**
 * 拉取最新 Release 并判断是否需要提示。
 * @returns {Promise<{ok:boolean, update?:{tag:string,name:string,url:string,publishedAt:string}|null, reason?:string}>}
 */
async function fetchLatestRelease(options) {
  const o = options || {};
  const owner = o.owner || '45944831';
  const repo = o.repo || 'perfara';
  const currentVersion = String(o.currentVersion || '');
  const timeoutMs = o.timeoutMs || DEFAULT_TIMEOUT_MS;
  const url = 'https://api.github.com/repos/' +
    encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/releases/latest';
  try {
    const body = await requestJson(url, timeoutMs, o.requestImpl || defaultRequest);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, reason: 'invalid payload' };
    }
    // /releases/latest 本身已排除 draft/prerelease，这里再兜一层
    if (body.draft || body.prerelease) {
      return { ok: true, update: null, reason: 'draft or prerelease' };
    }
    const tag = String(body.tag_name || '').trim();
    const pageUrl = sanitizeReleaseUrl(body.html_url, owner, repo);
    if (!tag || !pageUrl) {
      return { ok: true, update: null, reason: 'missing tag or url' };
    }
    // 版本号已从日期式（v2026.11.02）改为 1.0→1.10→2.0… 序列式。
    // GitHub 上仍挂着大量历史日期 tag，若按纯数字段比较，2026 会被当成比 1 大，
    // 用户一启动就会看到指向旧包的「新版本」。这里显式过滤掉不合规范的 tag。
    if (!isValidVersion(tag)) {
      return {
        ok: true,
        update: null,
        reason: isLegacyVersion(tag) ? 'legacy date-based tag' : 'unsupported tag format',
      };
    }
    if (!isNewerVersion(tag, currentVersion)) {
      return { ok: true, update: null };
    }
    return {
      ok: true,
      update: {
        tag,
        name: String(body.name || tag),
        url: pageUrl,
        publishedAt: String(body.published_at || ''),
      },
    };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_BODY_BYTES,
  parseVersion,
  isValidVersion,
  isLegacyVersion,
  compareVersions,
  isNewerVersion,
  sanitizeReleaseUrl,
  fetchLatestRelease,
};
