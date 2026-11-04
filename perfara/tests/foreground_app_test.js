/**
 * 启动时自动选中真机前台应用：离线回归（不联网、不依赖 Electron / adb）
 *  A) dumpsys / HOME resolver 输出解析（含真机实测形态，包名一律用示例占位）
 *  B) 系统桌面判定：HOME 精确比对 + 包名形态兜底 + 读不到前台一律保持原样
 *  C) 汇总判定
 *  D) 接线一致性：adb → main → preload → renderer → asar 打包清单
 */
'use strict';
const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..', '..', '_client_src', 'app');
const F = require(path.join(APP, 'src', 'foreground-app.js'));
const read = (p) => fs.readFileSync(path.join(APP, p), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : ' → ' + JSON.stringify(extra))); }
}

const GAME = 'com.example.game';
const ACT_DUMP = [
  `    topResumedActivity=ActivityRecord{b510e4a u0 ${GAME}/.MainActivity} t1121}`,
  `  ResumedActivity: ActivityRecord{b510e4a u0 ${GAME}/.MainActivity} t1121}`,
].join('\n');
const WIN_DUMP = [
  `  mCurrentFocus=Window{93abae u0 ${GAME}/${GAME}.MainActivity}`,
  `  mFocusedApp=ActivityRecord{b510e4a u0 ${GAME}/.MainActivity} t1121}`,
].join('\n');
const HOME_OUT = [
  'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true',
  'com.android.launcher/.Launcher',
].join('\n');

// ── A. 输出解析 ─────────────────────────────────────────────────────────────
console.log('\n[A] dumpsys / HOME 解析');
check('topResumedActivity 行取到包名', F.parseForegroundPackage(ACT_DUMP) === GAME, F.parseForegroundPackage(ACT_DUMP));
check('完整 component', F.parseComponent(`  mCurrentFocus=Window{x u0 ${GAME}/${GAME}.MainActivity}`).component === `${GAME}/${GAME}.MainActivity`);
check('window dump 也能取到包名', F.parseForegroundPackage(WIN_DUMP) === GAME, F.parseForegroundPackage(WIN_DUMP));
check('点开头的 Activity 类名合法', F.parseComponent(`ActivityRecord{x u0 ${GAME}/.MainActivity}`).pkg === GAME);
check('带 $ 的内部类合法', F.parseComponent(`Window{x u0 ${GAME}/${GAME}.Main$Sub}`).component === `${GAME}/${GAME}.Main$Sub`);
check('空输出返回 null', F.parseForegroundPackage('') === null && F.parseForegroundPackage(null) === null);
check('前台为 null 不误取', F.parseForegroundPackage('    topResumedActivity=null\n  mCurrentFocus=null') === null);
check('文件路径不当成包名', F.parseComponent('    baseDir=/data/app/com.example/base.apk') === null);
check('非法包名被挡掉', F.parseComponent('  mCurrentFocus=Window{x u0 com/com.Main}') === null);
check('无常见标记时 ActivityRecord 兜底',
  F.parseForegroundPackage(`  Hist #0: ActivityRecord{aaa u0 ${GAME}/.Main} t1}`) === GAME);
check('HOME --brief 输出取到桌面包', F.parseHomePackage(HOME_OUT) === 'com.android.launcher', F.parseHomePackage(HOME_OUT));
check('HOME 无结果返回 null', F.parseHomePackage('No activity found\n') === null && F.parseHomePackage('') === null);
check('HOME 只取组件行、不吃 priority 行', F.parseHomePackage('priority=0 match=0x108000\ncom.vendor.home/.Home') === 'com.vendor.home');

// ── B. 系统桌面判定 ─────────────────────────────────────────────────────────
console.log('\n[B] 系统桌面判定');
check('HOME 精确命中', F.isDesktopForeground('com.android.launcher', 'com.android.launcher'));
check('普通应用不判桌面', !F.isDesktopForeground(GAME, 'com.android.launcher'));
check('HOME 拿不到时按包名形态兜底', F.isDesktopForeground('com.android.launcher3', null));
check('nexuslauncher 形态命中', F.isDesktopForeground('com.google.android.apps.nexuslauncher', null));
check('miui/vivo 类 .home 命中', F.isLauncherLike('com.vendor.home'));
check('systemui（锁屏/下拉）命中', F.isLauncherLike('com.android.systemui'));
check('系统设置不算桌面', !F.isLauncherLike('com.android.settings'));
check('读不到前台一律保持原样', F.isDesktopForeground(null, 'com.android.launcher'));
check('包名带 launcher 字样但非桌面的第三方应用不误判为纯包名字段', F.isLauncherLike('com.example.launcherboard') === false);

// ── C. 汇总 ─────────────────────────────────────────────────────────────────
console.log('\n[C] 汇总判定');
const SNAP = { activityDump: ACT_DUMP, windowDump: WIN_DUMP, homeResolve: HOME_OUT };
let r = F.parseForegroundApp(SNAP);
check('正在运行应用 → 可自动选中', r.pkg === GAME && r.isDesktop === false && r.reason === 'ok', r);
check('同时带出桌面包名', r.homePkg === 'com.android.launcher', r);
r = F.parseForegroundApp({ ...SNAP, activityDump: '', windowDump: '' });
check('读不到前台 → 保持原样', r.pkg === null && r.isDesktop === true && r.reason === 'no-foreground', r);
r = F.parseForegroundApp({ ...SNAP, activityDump: '  ResumedActivity: ActivityRecord{x u0 com.android.launcher/.Launcher t1}', windowDump: '' });
check('停在系统桌面 → 保持原样', r.isDesktop === true && r.reason === 'desktop-home', r);
r = F.parseForegroundApp({ ...SNAP, activityDump: '  mResumedActivity: ActivityRecord{x u0 com.vendor.home/.Home t1}', windowDump: '', homeResolve: '' });
check('HOME 命令失效时仍能认出桌面', r.isDesktop === true && r.reason === 'desktop-launcher', r);
r = F.parseForegroundApp({ activityDump: '', windowDump: WIN_DUMP, homeResolve: HOME_OUT });
check('activity dump 空时 window dump 兜底', r.pkg === GAME && r.isDesktop === false, r);
r = F.parseForegroundApp(null);
check('空快照不抛异常', r.isDesktop === true && r.pkg === null, r);

// ── D. 接线一致性 ───────────────────────────────────────────────────────────
console.log('\n[D] 接线一致性');
const adb = read('src/adb.js');
const main = read('main.js');
const preload = read('preload.js');
const renderer = read('renderer/renderer.js');
check('adb 导出 getForegroundSnapshot', /getForegroundSnapshot/.test(adb) && /module\.exports[\s\S]*getForegroundSnapshot/.test(adb));
check('adb 三路取数齐全', /ResumedActivity/.test(adb)
  && /mCurrentFocus\|mFocusedApp/.test(adb)
  && /android\.intent\.category\.HOME/i.test(adb));
check('adb 三路并行且各自吞异常', /Promise\.all\(\[/.test(adb) && /catch\(\(\) => ''\)/.test(adb));
check('main 引入纯逻辑模块', /require\('\.\/src\/foreground-app'\)/.test(main));
check('main 两个 IPC 通道', /ipcMain\.handle\('get-foreground-app'/.test(main) && /ipcMain\.handle\('get-foreground-app-label'/.test(main));
check('main 两个通道都做参数校验', /拒绝 get-foreground-app/.test(main) && /if \(bad\) return '';/.test(main));
check('main 桌面前不解析应用名', /if \(!r\.pkg \|\| r\.isDesktop\) return r;/.test(main));
check('main 应用名有 6s 上限', /6000/.test(main) && /Promise\.race/.test(main));
check('preload 两个接口与通道对称', /getForegroundApp: \(deviceId\) => ipcRenderer\.invoke\('get-foreground-app'/.test(preload)
  && /ipcRenderer\.invoke\('get-foreground-app-label'/.test(preload));
check('renderer 调自动选中函数', /autoSelectForegroundApp\(deviceId\)/.test(renderer));
check('renderer 桌面时直接返回', /!info \|\| !info\.pkg \|\| info\.isDesktop/.test(renderer));
check('renderer 不覆盖用户已选应用', /selApp\.value\) return/.test(renderer));
check('renderer 采集中不自动选', /if \(isCollecting \|\| !selApp\) return;/.test(renderer));
check('renderer 系统应用补可选项', /allPackages\.push\(row\)/.test(renderer));
check('renderer 用轮次号丢弃过期结果', /_autoSelectRunId/.test(renderer) && /runId !== _autoSelectRunId/.test(renderer));
check('renderer 自动选中后刷新设备信息条', /scheduleDeviceInfoBar\(\);/.test(renderer));
check('preload 不在桌面时改界面（判定留给 renderer）', /桌面时不改界面/.test(preload));

// 打包清单：build_app.py 按目录整体收集 src/*.js，新增模块会自动进 asar。
// 这里静态断言收集规则，避免哪天改成白名单后把新文件漏掉。
const py = fs.readFileSync(path.resolve(__dirname, '..', '..', 'tools', 'build_app.py'), 'utf8');
check('build_app.py 按目录收集 src（新模块会进 asar）', /src/.test(py) && /collect/.test(py));
check('build_app.py 未改成文件名白名单', !/WHITELIST|ALLOW_FILES/.test(py));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
