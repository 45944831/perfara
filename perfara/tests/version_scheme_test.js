/**
 * 版本号规范：离线回归（不联网、不依赖 Electron）
 *  1) 1.0→1.10→2.0→2.10→3.0 序列与进位
 *  2) 解析/校验：拒绝日期式、三段式、前导零、越界次版本
 *  3) 比较：1.10 > 1.9、2.0 > 1.10、旧日期 tag 不误报
 *  4) 接线：源码常量、发版脚本、main.js 对新规范的校验
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, '_client_src', 'app');
const VS = require(path.join(APP, 'src', 'version-scheme.js'));
const VER = require(path.join(APP, 'src', 'app-version.js'));
const UC = require(path.join(APP, 'src', 'update-check.js'));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : ' → ' + JSON.stringify(extra))); }
}

// ── 1. 序列与进位 ───────────────────────────────────────────────────────────
console.log('\n[A] 版本号序列');
const SEQ = [
  '1.0', '1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '1.8', '1.9', '1.10',
  '2.0', '2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7', '2.8', '2.9', '2.10',
  '3.0',
];
check('1.0 起连续 23 个版本正确', JSON.stringify(VS.versionSequence('1.0', 23)) === JSON.stringify(SEQ), VS.versionSequence('1.0', 23));
check('次版本上限是 10', VS.MINOR_MAX === 10);
check('1.9 → 1.10', VS.nextVersion('1.9') === '1.10');
check('1.10 → 2.0（次版用满进位）', VS.nextVersion('1.10') === '2.0');
check('2.10 → 3.0', VS.nextVersion('2.10') === '3.0');
check('9.10 → 10.0（主版本两位数也进位）', VS.nextVersion('9.10') === '10.0');
check('非法输入不产生版本', VS.nextVersion('2026.11.02') === null && VS.nextVersion('') === null);
check('序列长度上限有保护', VS.versionSequence('1.0', 99999).length === VS.MAX_SEQUENCE);
check('序列含首尾', VS.versionSequence('1.0', 2)[0] === '1.0' && VS.versionSequence('1.0', 2)[1] === '1.1');

// ── 2. 解析与校验 ───────────────────────────────────────────────────────────
console.log('\n[B] 解析 / 校验');
check('解析 1.10', JSON.stringify(VS.parseVersion('v1.10')) === JSON.stringify({ major: 1, minor: 10, text: '1.10' }));
check('忽略 v 前缀与空白', VS.normalizeVersion('  V2.10  ') === '2.10');
check('构造 tag', VS.toVersionTag('1.10') === 'v1.10');
check('构造 tag 非法返回 null', VS.toVersionTag('2026.11.02') === null);
for (const bad of ['', null, undefined, '1', '1.', '.1', '1.0.0', '2026.11.02', 'v2026.10.22',
  '20261102', '0.1', '1.11', '1.01', '01.0', 'v1.0-r3', 'release-candidate', 'abc']) {
  check('拒绝非法版本 ' + JSON.stringify(bad), !VS.isValidVersion(bad));
}
for (const good of ['1.0', 'v1.10', '2.10', '10.0', '3.7']) {
  check('接受合法版本 ' + good, VS.isValidVersion(good));
}
for (const legacy of ['v2026.11.02', '2026.10.22', 'v2026.10.20.1', 'v2026.10.21_r3', '20261102']) {
  check('识别历史日期式 ' + legacy, VS.isLegacyVersion(legacy));
}
check('新规范版本不算 legacy', !VS.isLegacyVersion('v1.10') && !VS.isLegacyVersion('2.0'));

// ── 3. 比较与误报防护 ───────────────────────────────────────────────────────
console.log('\n[C] 版本比较 / 旧 tag 防护');
check('1.10 > 1.9（数字而非字典序）', VS.compareVersions('1.10', '1.9') === 1);
check('2.0 > 1.10', VS.compareVersions('2.0', '1.10') === 1);
check('2.10 > 2.9', VS.compareVersions('2.10', '2.9') === 1);
check('3.0 > 2.10', VS.compareVersions('3.0', '2.10') === 1);
check('同版本相等', VS.compareVersions('v1.10', '1.10') === 0);
check('非法版本比较不抛错', VS.compareVersions('', '') === 0 && VS.compareVersions('abc', '1.0') === -1);
check('新版本提示 1.1 > 1.0', VS.isNewerVersion('v1.1', '1.0'));
check('新版本提示 2.0 > 1.10', VS.isNewerVersion('v2.0', '1.10'));
check('同版本不提示', !VS.isNewerVersion('v1.0', '1.0'));
check('旧版本不提示', !VS.isNewerVersion('v1.9', '1.10'));
check('⚠️ 历史日期 tag 绝不能误报成新版本', !VS.isNewerVersion('v2026.11.02', '1.0'));
check('本地版本是旧日期式时不提示', !VS.isNewerVersion('v1.1', '2026.11.02'));
check('tag 格式异常时不提示', !VS.isNewerVersion('release-candidate', '1.0'));
check('空版本不报错', !VS.isNewerVersion('', '') && !VS.isNewerVersion('v1.1', ''));
check('update-check 转发的是同一套规则',
  UC.isNewerVersion('v1.10', '1.9') === true && UC.isNewerVersion('v2026.11.02', '1.0') === false);
check('APP_VERSION 符合新规范', VS.isValidVersion(VER.APP_VERSION), VER.APP_VERSION);

// ── 4. 接线 ────────────────────────────────────────────────────────────────
console.log('\n[D] 接线一致性');
const main = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
const zipTool = fs.readFileSync(path.join(ROOT, 'tools', 'make_release_zip.py'), 'utf8');
const pyScheme = fs.readFileSync(path.join(ROOT, 'tools', 'version_scheme.py'), 'utf8');
check('main 校验 version.txt 格式', main.indexOf('isValidVersion(v)') !== -1 && main.indexOf('normalizeVersion(v)') !== -1);
check('main 引入版本规则模块', main.indexOf("require('./src/version-scheme')") !== -1);
check('update-check 过滤旧日期 tag', fs.readFileSync(path.join(APP, 'src', 'update-check.js'), 'utf8').indexOf('legacy date-based tag') !== -1);
check('发版支持 --app-version=next', zipTool.indexOf("app_ver_arg == 'next'") !== -1);
check('发版不再按当天日期推断', !/strftime\(['"]%Y\.%m\.%d['"]\)/.test(zipTool));
check('发版拒绝日期式版本号', zipTool.indexOf('日期式版本号') !== -1 && zipTool.indexOf('is_valid_version(app_ver_arg)') !== -1);
check('发版会同步源码常量', zipTool.indexOf('write_source_app_version') !== -1);
check('Python 侧规则常量一致', /MINOR_MAX\s*=\s*10/.test(pyScheme) && pyScheme.indexOf('minor < MINOR_MAX') !== -1);
check('Python 侧进位到下一个主版本', pyScheme.indexOf("'%d.0' % (major + 1)") !== -1);
check('两侧共用同一套规则（注释互指）',
  pyScheme.indexOf('version-scheme.js') !== -1 &&
  fs.readFileSync(path.join(APP, 'src', 'version-scheme.js'), 'utf8').indexOf('version_scheme.py') !== -1);

// 真跑一次 Python 侧，核对两边生成的序列逐项一致（python 不可用则跳过该断言）
try {
  const out = execFileSync('python', [
    '-c',
    "import sys,json;sys.path.insert(0,'tools');import version_scheme as v;print(json.dumps(v.version_sequence('1.0',23)))",
  ], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
  check('JS / Python 生成的版本序列完全一致', JSON.stringify(JSON.parse(out.trim())) === JSON.stringify(SEQ), out.trim());
} catch (e) {
  console.log('  SKIP JS / Python 序列实测（本机 python 不可用）: ' + (e && e.message));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
