"""版本号规范（发版侧）深度回归。

覆盖 1.0→1.10→2.0→2.10→3.0 序列、进位、非法输入拒绝、历史日期 tag 识别，
以及 make_release_zip.py 的 --app-version=next / 拒绝日期式版本号接线。
与 perfara/tests/version_scheme_test.js 使用同一份期望序列，任一侧规则漂移都会被抓到。
"""
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import version_scheme as v  # noqa: E402

PASS = 0
FAIL = 0


def check(name, cond, extra=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  PASS ' + name)
    else:
        FAIL += 1
        print('  FAIL ' + name + ('' if extra is None else ' -> %r' % (extra,)))


SEQ = [
    '1.0', '1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '1.8', '1.9', '1.10',
    '2.0', '2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7', '2.8', '2.9', '2.10',
    '3.0',
]

print('\n[A] 版本序列 / 进位')
check('1.0 起连续 23 个版本正确', v.version_sequence('1.0', 23) == SEQ, v.version_sequence('1.0', 23))
check('次版本上限是 10', v.MINOR_MAX == 10)
check('1.9 -> 1.10', v.next_version('1.9') == '1.10')
check('1.10 -> 2.0', v.next_version('1.10') == '2.0')
check('2.10 -> 3.0', v.next_version('2.10') == '3.0')
check('9.10 -> 10.0', v.next_version('9.10') == '10.0')
check('非法输入返回 None', v.next_version('2026.11.02') is None and v.next_version('') is None)
check('序列长度上限', len(v.version_sequence('1.0', 99999)) == v.MAX_SEQUENCE)

print('\n[B] 解析 / 校验')
check('解析 1.10', v.parse_version('v1.10') == (1, 10))
check('规范化', v.normalize_version('  V2.10  ') == '2.10')
check('构造 tag', v.to_version_tag('1.10') == 'v1.10')
check('非法 tag 返回 None', v.to_version_tag('2026.11.02') is None)
for bad in ['', None, '1', '1.', '.1', '1.0.0', '2026.11.02', 'v2026.10.22',
            '20261102', '0.1', '1.11', '1.01', '01.0', 'release-candidate', 'abc']:
    check('拒绝非法版本 %r' % bad, not v.is_valid_version(bad))
for good in ['1.0', 'v1.10', '2.10', '10.0', '3.7']:
    check('接受合法版本 %s' % good, v.is_valid_version(good))
for legacy in ['v2026.11.02', '2026.10.22', 'v2026.10.20.1', 'v2026.10.21_r3', '20261102']:
    check('识别历史日期式 %s' % legacy, v.is_legacy_version(legacy))
check('新规范版本不算 legacy', not v.is_legacy_version('v1.10') and not v.is_legacy_version('2.0'))

print('\n[C] 比较 / 误报防护')
check('1.10 > 1.9', v.compare_versions('1.10', '1.9') == 1)
check('2.0 > 1.10', v.compare_versions('2.0', '1.10') == 1)
check('3.0 > 2.10', v.compare_versions('3.0', '2.10') == 1)
check('同版本相等', v.compare_versions('v1.10', '1.10') == 0)
check('非法比较不抛错', v.compare_versions('', '') == 0 and v.compare_versions('abc', '1.0') == -1)
check('新版本 1.1 > 1.0', v.is_newer_version('v1.1', '1.0'))
check('旧版不提示', not v.is_newer_version('v1.9', '1.10'))
check('历史日期 tag 不误报', not v.is_newer_version('v2026.11.02', '1.0'))
check('本地日期式版本不误报', not v.is_newer_version('v1.1', '2026.11.02'))

print('\n[D] 接线')
zip_tool = open(os.path.join(ROOT, 'tools', 'make_release_zip.py'), encoding='utf-8').read()
app_version_js = open(os.path.join(ROOT, '_client_src', 'app', 'src', 'app-version.js'), encoding='utf-8').read()
check('发版脚本引入共享规则', 'from version_scheme import' in zip_tool)
check('发版脚本支持自动递增', "app_ver_arg == 'next'" in zip_tool)
check('发版脚本不再按日期推断', not re.search(r"strftime\(['\"]%Y\.%m\.%d['\"]\)", zip_tool))
check('发版脚本拒绝日期式版本号', 'is_valid_version(app_ver_arg)' in zip_tool and '日期式版本号' in zip_tool)
check('源码常量符合新规范', bool(re.search(r"APP_VERSION\s*:\s*'([^']*)'", app_version_js)) and
      v.is_valid_version(re.search(r"APP_VERSION\s*:\s*'([^']*)'", app_version_js).group(1)))

print('\nRESULT: %d passed, %d failed' % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
