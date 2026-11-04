'use strict';

/**
 * 版本号规范（自 v1.0 起）：`主版本.次版本`，次版本 0~10，用满进位。
 *
 *   1.0 → 1.1 → … → 1.9 → 1.10 → 2.0 → … → 2.10 → 3.0 → …
 *
 * 为什么弃用日期式（2026.11.02）：每次发版都要对齐当天日期、tag 与包内容容易错位，
 * 且 GitHub /releases/latest 上仍挂着历史日期 tag；若按纯数字段比较，2026 会被当成
 * 比 1 大，新包用户一启动就会看到指向旧包的「新版本」。因此：
 *   - 只有符合本规范的 tag 才参与「新版本」判定；
 *   - 历史日期式 tag 一律识别为 legacy 并忽略（宁可漏报，绝不误报）。
 *
 * 纯函数、不依赖 Electron，客户端主进程与离线测试共用；
 * Python 侧的规则见 tools/version_scheme.py，两边必须保持一致。
 */
const MINOR_MAX = 10;
const MAX_SEQUENCE = 200;
const VERSION_RE = /^[vV]?(\d{1,4})\.(\d{1,2})$/;
// 历史日期式标识：v2026.11.02 / v2026.10.20.1 / v2026.10.21_r3 / 20261102
const LEGACY_RE = /^[vV]?(?:(?:19|20)\d{2}[.\-_]|\d{8}(?:[.\-_]|$))/;

/**
 * 解析新规范版本号；不合规范返回 null。
 * 拒绝：主版本 0、次版本 > 10、前导零（1.01）、三段式（1.0.0）、非数字、日期式。
 */
function parseVersion(v) {
  const m = VERSION_RE.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major < 1 || minor > MINOR_MAX) return null;
  if (String(major) !== m[1] || String(minor) !== m[2]) return null;
  return { major, minor, text: major + '.' + minor };
}

function isValidVersion(v) {
  return parseVersion(v) !== null;
}

/** 历史日期式版本标识，不参与新版本提示 */
function isLegacyVersion(v) {
  return LEGACY_RE.test(String(v == null ? '' : v).trim());
}

/** 规范化：去掉 v 前缀与首尾空白；不合规范返回空串 */
function normalizeVersion(v) {
  const p = parseVersion(v);
  return p ? p.text : '';
}

/** 构造 Release tag，如 v1.10；不合规范返回 null */
function toVersionTag(v) {
  const p = parseVersion(v);
  return p ? 'v' + p.text : null;
}

/** a > b 返回 1，a < b 返回 -1；任一不合法按「较小」处理，都不合法返回 0 */
function compareVersions(a, b) {
  const A = parseVersion(a);
  const B = parseVersion(b);
  if (!A && !B) return 0;
  if (!A) return -1;
  if (!B) return 1;
  if (A.major !== B.major) return A.major > B.major ? 1 : -1;
  if (A.minor !== B.minor) return A.minor > B.minor ? 1 : -1;
  return 0;
}

/** 两侧都必须是合法新规范版本；旧日期 tag / 本地版本未知一律漏报 */
function isNewerVersion(latest, current) {
  if (!isValidVersion(latest) || !isValidVersion(current)) return false;
  return compareVersions(latest, current) > 0;
}

/** 下一个版本号：1.9→1.10，1.10→2.0，2.10→3.0 */
function nextVersion(v) {
  const p = parseVersion(v);
  if (!p) return null;
  return p.minor < MINOR_MAX
    ? p.major + '.' + (p.minor + 1)
    : (p.major + 1) + '.0';
}

/** 从 start 起生成 count 个连续版本号（含 start），用于文档/测试核对序列 */
function versionSequence(start, count) {
  const out = [];
  let cur = normalizeVersion(start);
  const n = Math.min(Math.max(Number(count) || 0, 0), MAX_SEQUENCE);
  for (let i = 0; i < n && cur; i++) {
    out.push(cur);
    cur = nextVersion(cur);
  }
  return out;
}

module.exports = {
  MINOR_MAX,
  MAX_SEQUENCE,
  parseVersion,
  isValidVersion,
  isLegacyVersion,
  normalizeVersion,
  toVersionTag,
  compareVersions,
  isNewerVersion,
  nextVersion,
  versionSequence,
};
