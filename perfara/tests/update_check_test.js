/**
 * 新版本提示：离线回归（不联网、不依赖 Electron）
 *  1) 版本比较 / URL 白名单（版本号为 1.0→1.10→2.0… 序列式）
 *  2) 网络层用假 request 注入，覆盖成功 / 同版本 / 旧日期 tag / draft / 非法地址 / 超时 / 报错
 *  3) 接线一致性：4 个采集页都引入脚本、CSS 能真正隐藏、preload↔main 通道对称
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const APP = path.resolve(__dirname, '..', '..', '_client_src', 'app');
const UC = require(path.join(APP, 'src', 'update-check.js'));
const VER = require(path.join(APP, 'src', 'app-version.js'));
const SCHEME = require(path.join(APP, 'src', 'version-scheme.js'));
const WT = require(path.join(APP, 'src', 'window-title.js'));

// 「更新的版本」不能写死：每次发版把 APP_VERSION 提上去，写死的常量就会变成
// 同版本，用例会从「有新版本」退化成 null 直接崩溃。统一按当前版本推下一个。
const NEWER = 'v' + SCHEME.nextVersion(VER.APP_VERSION);

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : ' → ' + JSON.stringify(extra))); }
}

// ── 1. 版本比较 ─────────────────────────────────────────────────────────────
console.log('\n[A] 版本比较');
check('v 前缀被忽略', UC.compareVersions('v1.10', '1.10') === 0);
check('新版 > 旧版', UC.isNewerVersion('v1.1', '1.0'));
check('同版本不提示', !UC.isNewerVersion('v' + VER.APP_VERSION, VER.APP_VERSION));
check('次版本 10 > 9', UC.isNewerVersion('v1.10', '1.9'));
check('进位 2.0 > 1.10', UC.isNewerVersion('v2.0', '1.10'));
check('旧版不提示', !UC.isNewerVersion('v1.9', '1.10'));
check('⚠️ 历史日期 tag 不误报', !UC.isNewerVersion('v2026.11.02', VER.APP_VERSION));
check('空版本不报错', UC.compareVersions('', '') === 0 && !UC.isNewerVersion('', ''));
check('本地版本未知时不误报', !UC.isNewerVersion('v1.1', ''));
check('远端 tag 异常时不误报', !UC.isNewerVersion('release-candidate', VER.APP_VERSION));
check('三段式版本不误报', !UC.isNewerVersion('v1.0.0', VER.APP_VERSION));
check('解析结果含主/次版本', UC.parseVersion('v1.10').major === 1 && UC.parseVersion('v1.10').minor === 10);

// ── 2. URL 白名单 ───────────────────────────────────────────────────────────
console.log('\n[B] 跳转地址白名单');
const O = VER.GITHUB_OWNER;
const R = VER.GITHUB_REPO;
const GOOD = 'https://github.com/' + O + '/' + R + '/releases/tag/' + NEWER;
check('合法 Release 页', UC.sanitizeReleaseUrl(GOOD, O, R) === GOOD);
check('去掉 query/hash', UC.sanitizeReleaseUrl(GOOD + '?a=1#x', O, R) === GOOD);
check('拒绝 http', UC.sanitizeReleaseUrl('http://github.com/' + O + '/' + R + '/releases/tag/x', O, R) === null);
check('拒绝钓鱼域名', UC.sanitizeReleaseUrl('https://github.com.evil.com/' + O + '/' + R + '/releases/tag/x', O, R) === null);
check('拒绝别的仓库', UC.sanitizeReleaseUrl('https://github.com/hacker/other/releases/tag/x', O, R) === null);
check('拒绝非 releases 路径', UC.sanitizeReleaseUrl('https://github.com/' + O + '/' + R + '/issues/1', O, R) === null);
check('拒绝路径穿越', UC.sanitizeReleaseUrl('https://github.com/' + O + '/' + R + '/releases/../evil', O, R) === null);
check('拒绝非字符串', UC.sanitizeReleaseUrl(null, O, R) === null);
check('拒绝 javascript:', UC.sanitizeReleaseUrl('javascript:alert(1)', O, R) === null);

// ── 3. 网络层（假 request） ────────────────────────────────────────────────
function fakeRes(status, body) {
  const res = new EventEmitter();
  res.statusCode = status;
  res.resume = () => {};
  setTimeout(() => {
    if (status === 200) {
      res.emit('data', Buffer.from(body));
      res.emit('end');
    }
  }, 0);
  return res;
}
function fakeRequest(mode, payload, spy) {
  return (url, options, cb) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    if (spy) spy(url, options);
    setTimeout(() => {
      if (mode === 'timeout') { req.emit('timeout'); return; }
      if (mode === 'error') { req.emit('error', new Error('ENOTFOUND')); return; }
      cb(fakeRes(Number(mode) || 200, payload));
    }, 0);
    return req;
  };
}
function releaseBody(over) {
  return JSON.stringify(Object.assign({
    tag_name: NEWER,
    name: 'Perfara ' + NEWER.slice(1),
    html_url: GOOD,
    published_at: '2026-11-04T10:00:00Z',
    draft: false,
    prerelease: false,
  }, over || {}));
}
const baseOpts = (impl, currentVersion) => ({
  owner: O, repo: R, currentVersion: currentVersion || VER.APP_VERSION, timeoutMs: 50, requestImpl: impl,
});

(async () => {
  console.log('\n[C] 拉取与判定');
  let seen = null;
  let r = await UC.fetchLatestRelease(baseOpts(fakeRequest('200', releaseBody(), (u, o) => { seen = { u, o }; })));
  check('新版本返回 update', r.ok === true && r.update && r.update.tag === NEWER && r.update.url === GOOD, r);
  check('请求 GitHub 官方 API', seen && seen.u === 'https://api.github.com/repos/' + O + '/' + R + '/releases/latest', seen && seen.u);
  check('带 User-Agent', seen && seen.o.headers['User-Agent'] === 'Perfara-UpdateCheck');
  check('带超时配置', seen && seen.o.timeoutMs === 50);
  check('publishedAt 透传', r.update.publishedAt === '2026-11-04T10:00:00Z');

  r = await UC.fetchLatestRelease(baseOpts(fakeRequest('200', releaseBody({ tag_name: 'v' + VER.APP_VERSION }))));
  check('同版本不提示', r.ok === true && r.update === null, r);
  r = await UC.fetchLatestRelease(baseOpts(fakeRequest('200', releaseBody({ tag_name: 'v1.9' })), '1.10'));
  check('旧版本不提示', r.ok === true && r.update === null, r);
  r = await UC.fetchLatestRelease(baseOpts(fakeRequest('200', releaseBody({ tag_name: 'v1.10' })), '1.9'));
  check('1.10 > 1.9 能提示', r.ok === true && r.update && r.update.tag === 'v1.10', r);
  r = await UC.fetchLatestRelease(baseOpts(fakeRequest('200', releaseBody({ tag_name: 'v2.0' })), '1.10'));
  check('2.0 > 1.10 能提示', r.ok === true && r.update && r.update.tag === 'v2.0', r);
  r = await UC.fetchLatestRelease(baseOpts(fakeRequest('200', releaseBody({ tag_name: 'v2026.11.02' }))));
  check('⚠️ 历史日期 tag 不提示', r.ok === true && r.update === null && r.reason === 'legacy date-based tag', r);
  r = await UC.fetchLatestRelease(baseOpts(fakeRequest('200', releaseBody({ tag_name: 'release-candidate' }))));
  check('格式异常 tag 不提示', r.ok === true && r.update === null && r.reason === 'unsupported tag format', r);
  r = await UC.fetchLatestRelease(baseOpts(fakeRequest('200', releaseBody({ prerelease: true }))));
  check('prerelease 不提示', r.ok === true && r.update === null, r);
  r = await UC.fetchLatestRelease(baseOpts(fakeRequest('200', releaseBody({ draft: true }))));
  check('draft 不提示', r.ok === true && r.update === null, r);
  r = await UC.fetchLatestRelease(baseOpts(fakeRequest('200', releaseBody({ html_url: 'https://evil.example/x' }))));
  check('非法地址不提示', r.ok === true && r.update === null, r);
  r = await UC.fetchLatestRelease(baseOpts(fakeRequest('200', releaseBody({ tag_name: '' }))));
  check('缺 tag 不提示', r.ok === true && r.update === null, r);
  r = await UC.fetchLatestRelease(baseOpts(fakeRequest('403', '')));
  check('限流 403 静默失败', r.ok === false && !!r.reason, r);
  r = await UC.fetchLatestRelease(baseOpts(fakeRequest('timeout', '')));
  check('超时静默失败', r.ok === false && !!r.reason, r);
  r = await UC.fetchLatestRelease(baseOpts(fakeRequest('error', '')));
  check('网络错误静默失败', r.ok === false && !!r.reason, r);
  r = await UC.fetchLatestRelease(baseOpts(fakeRequest('200', 'not-json')));
  check('非法 JSON 静默失败', r.ok === false && !!r.reason, r);
  r = await UC.fetchLatestRelease(baseOpts(fakeRequest('200', 'null')));
  check('空 payload 静默失败', r.ok === false && !!r.reason, r);
  r = await UC.fetchLatestRelease(baseOpts(fakeRequest('200', JSON.stringify([]))));
  check('数组 payload 静默失败', r.ok === false && !!r.reason, r);

  // ── 4. 接线一致性 ────────────────────────────────────────────────────────
  console.log('\n[D] 界面接线');
  const RENDERER = path.join(APP, 'renderer');
  for (const f of ['index.html', 'pc.html', 'iphone.html', 'iphone_gpu.html']) {
    const html = fs.readFileSync(path.join(RENDERER, f), 'utf8');
    check(f + ' 引入 update-notice.js', html.indexOf('<script src="update-notice.js"></script>') !== -1);
  }
  const css = fs.readFileSync(path.join(RENDERER, 'style.css'), 'utf8');
  check('CSS 显式还原 [hidden]', /\.update-notice\[hidden\]\s*\{\s*display:\s*none/.test(css));
  const notice = fs.readFileSync(path.join(RENDERER, 'update-notice.js'), 'utf8');
  check('标签文字是「新版本」', notice.indexOf("label.textContent = '新版本'") !== -1);
  check('默认隐藏', notice.indexOf('btn.hidden = true') !== -1);
  check('点击才跳转', notice.indexOf('api.openAppUpdate') !== -1);
  check('不弹窗/不自动跳转', !/\balert\s*\(|\bconfirm\s*\(|showMessageBox|new Notification|location\s*=/.test(notice));
  check('订阅事件推送', notice.indexOf('api.onAppUpdate(render)') !== -1);
  const preload = fs.readFileSync(path.join(APP, 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
  check('preload 暴露 3 个接口', ['getAppUpdate', 'onAppUpdate', 'openAppUpdate'].every(k => preload.indexOf(k + ':') !== -1));
  check('main 注册 get-app-update', main.indexOf("ipcMain.handle('get-app-update'") !== -1);
  check('main 注册 open-app-update', main.indexOf("ipcMain.handle('open-app-update'") !== -1);
  check('main 用白名单再校验', main.indexOf('sanitizeReleaseUrl(') !== -1);
  check('main 广播到所有窗口', main.indexOf('BrowserWindow.getAllWindows()') !== -1);
  check('main 启动时检查一次', /setTimeout\(\(\) => \{ runAppUpdateCheck\(\); \}, 5000\)/.test(main));
  check('运行中不再周期检查', !/setInterval[\s\S]{0,120}runAppUpdateCheck/.test(main) && main.indexOf('APP_UPDATE_INTERVAL_MS') === -1);
  check('检查失败不重试', main.indexOf('失败也不重试') !== -1);
  const zipTool = fs.readFileSync(path.resolve(__dirname, '..', '..', 'tools', 'make_release_zip.py'), 'utf8');
  check('发版可写 version.txt', zipTool.indexOf('--app-version=') !== -1 && zipTool.indexOf("'version.txt'") !== -1);
  check('发版不再按日期推断版本', !/strftime\(['"]%Y\.%m\.%d['"]\)/.test(zipTool));
  check('发版支持自动递增', zipTool.indexOf("app_ver_arg == 'next'") !== -1);

  // ── 5. 窗口标题：版本号 + 新版本标记 ────────────────────────────────────
  console.log('\n[E] 标题栏版本号 / 新版本标记');
  check('版本号去 v 前缀', WT.normalizeVersion('v1.10') === '1.10');
  check('版本号去空白', WT.normalizeVersion('  1.10 ') === '1.10');
  check('非版本号不误改', WT.normalizeVersion('vv') === 'vv');
  check('空版本安全', WT.normalizeVersion('') === '' && WT.normalizeVersion(null) === '');
  const base = 'Perfara - 移动端性能工具  v1.0';
  check('标题后带版本号', WT.formatWindowTitle({ appName: 'Perfara', version: '1.0' }) === base);
  check('标题带新版本标记', WT.formatWindowTitle({ appName: 'Perfara', version: 'v1.0', hasUpdate: true }) === base + '  · 新版本可用');
  check('无版本时只有标题', WT.formatWindowTitle({ appName: 'Perfara' }) === 'Perfara - 移动端性能工具');
  check('应用名缺省', WT.formatWindowTitle({ version: '1.10' }).indexOf('Perfara离线版 - 移动端性能工具') === 0);
  check('不会出现 vv', !WT.formatWindowTitle({ appName: 'Perfara', version: 'v2.10' }).includes('vv'));

  const brand = fs.readFileSync(path.join(RENDERER, 'apply-app-brand.js'), 'utf8');
  check('renderer 同步主进程标题', brand.indexOf('api.getWindowTitle') !== -1 && brand.indexOf('document.title = t.title') !== -1);
  check('旧 preload 兼容兜底', brand.indexOf('api.getAppName') !== -1);
  check('preload 暴露 getWindowTitle', preload.indexOf('getWindowTitle:') !== -1);
  check('main 注册 get-window-title', main.indexOf("ipcMain.handle('get-window-title'") !== -1);
  check('main 用统一标题函数', main.indexOf('title: buildWindowTitle()') !== -1 && main.indexOf('applyWindowTitle()') !== -1);
  check('document.title 不冲掉版本号', /page-title-updated[\s\S]{0,220}applyWindowTitle/.test(main));
  check('检查结果刷新标题', /function broadcastAppUpdate[\s\S]{0,420}applyWindowTitle\(\)/.test(main));
  check('版本号只读一次且共用', main.indexOf('currentVersion: getAppVersionCached()') !== -1);
  check('切换页面后标题仍带标记', /did-finish-load[\s\S]{0,320}applyWindowTitle\(\)/.test(main));
  check('顶栏提示带当前版本', notice.indexOf('info.currentVersion') !== -1);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试自身异常:', e);
  process.exit(1);
});
