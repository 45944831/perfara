'use strict';

/**
 * 「启动即选中真机前台应用」的纯判定层。
 *
 * 不 require adb / electron，只吃 adb 命令的原始输出，方便离线回归：
 *   - activityDump : dumpsys activity activities 里 grep 出的 ResumedActivity 行
 *   - windowDump   : dumpsys window 里 grep 出的 mCurrentFocus / mFocusedApp 行
 *   - homeResolve  : cmd package resolve-activity --brief ...CATEGORY.HOME 的输出
 *
 * 之所以要把 HOME resolver 一起问出来：各厂商桌面包名五花八门，硬编码清单一定会漏。
 * 用系统自己给出的默认桌面包名做精确比对，再用包名形态兜它的底（老设备没有 cmd）。
 *
 * 判定为「系统桌面」时**不改动界面**（保持原来的 -- 选择应用 -- 样式），
 * 拿不到前台也一样静默放过：自动填充是便利功能，绝不能变成干扰。
 */

// 合法 Android 包名：至少两段，段首字母，其余字母/数字/下划线。
// 用它挡掉 /data/app/...、文件路径、URL 之类同样含斜杠的噪声。
const PKG_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
// ActivityRecord{... u0 com.example.game/.MainActivity} / Window{... u0 com.foo/com.foo.Main}
// 要求包名前面是行首、空白或 {，避免把路径里的片段误当包名。
const COMPONENT_RE = /(?:^|[\s{])([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)\/([A-Za-z0-9_.$]+)/;

/** dumpsys 里按可信度排列的前台标记（越靠前越能代表用户当前看到的界面） */
const FG_KEYS = [
  'topResumedActivity',
  'ResumedActivity',
  'mResumedActivity',
  'mFocusedApp',
  'mCurrentFocus',
];

/** 从一行里抠出 pkg/Component；不是合法包名就返回 null */
function parseComponent(line) {
  if (typeof line !== 'string') return null;
  const m = COMPONENT_RE.exec(line);
  if (!m || !PKG_RE.test(m[1])) return null;
  return { pkg: m[1], component: `${m[1]}/${m[2]}` };
}

/**
 * 解析前台包名。
 * 先按标记名逐轮找（避免 grep 输出顺序决定结果），再在 ActivityRecord/Window 行里兜底，
 * 最后才整段兜底——有些 ROM 会把前台写在没有常见标记的自定义行里。
 */
function parseForegroundPackage(output) {
  const lines = String(output == null ? '' : output).split(/\r?\n/);
  for (const key of FG_KEYS) {
    for (const line of lines) {
      if (line.indexOf(key) === -1) continue;
      const hit = parseComponent(line);
      if (hit) return hit.pkg;
    }
  }
  for (const line of lines) {
    if (!/ActivityRecord\{|Window\{|Resumed|Focus/i.test(line)) continue;
    const hit = parseComponent(line);
    if (hit) return hit.pkg;
  }
  return null;
}

/** resolve-activity --brief 的最后一形如 com.android.launcher/.Launcher */
function parseHomePackage(output) {
  const lines = String(output == null ? '' : output).split(/\r?\n/);
  let found = null;
  for (const line of lines) {
    const hit = parseComponent(line.trim());
    if (hit) found = hit.pkg;
  }
  return found;
}

/**
 * 包名形态兜底：HOME resolver 拿不到时（旧 Android 无 cmd、命令被 ROM 阉割），
 * 仍能认出常见桌面 / 锁屏 / 最近任务界面。
 */
function isLauncherLike(pkg) {
  if (!pkg || typeof pkg !== 'string') return false;
  const seg = pkg.split('.').pop() || '';
  return /launcher\d*$/i.test(seg)
    || /^(home|homescreen|systemui|recents|keyguard)$/i.test(seg);
}

/** 是否为「系统桌面」等不应自动选中的界面 */
function isDesktopForeground(pkg, homePkg) {
  if (!pkg) return true;                              // 读不到前台 → 保持原样
  if (homePkg && pkg === homePkg) return true;
  return isLauncherLike(pkg);
}

/**
 * 汇总判定。
 * @returns {{pkg: string|null, homePkg: string|null, isDesktop: boolean, reason: string}}
 *   reason: ok / no-foreground / desktop-home / desktop-launcher
 */
function parseForegroundApp(snapshot) {
  const s = snapshot || {};
  const pkg = parseForegroundPackage(s.activityDump)
    || parseForegroundPackage(s.windowDump)
    || null;
  const homePkg = parseHomePackage(s.homeResolve);
  if (!pkg) return { pkg: null, homePkg, isDesktop: true, reason: 'no-foreground' };
  if (homePkg && pkg === homePkg) {
    return { pkg, homePkg, isDesktop: true, reason: 'desktop-home' };
  }
  if (isLauncherLike(pkg)) {
    return { pkg, homePkg, isDesktop: true, reason: 'desktop-launcher' };
  }
  return { pkg, homePkg, isDesktop: false, reason: 'ok' };
}

module.exports = {
  parseComponent,
  parseForegroundPackage,
  parseHomePackage,
  isLauncherLike,
  isDesktopForeground,
  parseForegroundApp,
};
