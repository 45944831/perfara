#!/usr/bin/env python3
"""版本号规则「双实现」一致性静态守卫。

单一真值源是 tools/version_scheme.py 的 RULE_SPEC；客户端镜像
_client_src/app/src/version-scheme.js 必须逐字对齐它。JS 文件位于并行改动目录，
本次不改其对外行为，因此把「显式引用/校验」落在守卫脚本里：逐项比对常量、
正则与进位规则，任何一侧漂移都会在这里 FAIL。

与 perfara/tests/version_scheme_test.js 互补：后者是运行时护栏（真跑 Python
比对生成的序列），本脚本是纯静态源码比对（不需要 node），两者都不能删。

用法：python tools/check_version_scheme_sync.py
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import version_scheme as vs  # noqa: E402

ROOT = os.path.dirname(HERE)
PY_SRC = os.path.join(HERE, 'version_scheme.py')
JS_SRC = os.path.join(ROOT, '_client_src', 'app', 'src', 'version-scheme.js')

PASS = 0
FAIL = 0


def check(name, cond, detail=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  PASS ' + name)
    else:
        FAIL += 1
        print('  FAIL ' + name + ((' -> ' + detail) if detail else ''))


def js_const(src, name):
    m = re.search(r'const\s+' + re.escape(name) + r'\s*=\s*(\d+)\s*;', src)
    return m.group(1) if m else None


def js_regex(src, name):
    # 正则字面量里不含 '/'，取两个 '/' 之间的原文即可。
    m = re.search(r'const\s+' + re.escape(name) + r'\s*=\s*/([^/\n]+)/;', src)
    return m.group(1) if m else None


def main():
    if not os.path.isfile(JS_SRC):
        print('[错误] 找不到客户端镜像:', JS_SRC)
        return 2
    with open(JS_SRC, encoding='utf-8') as f:
        js = f.read()
    with open(PY_SRC, encoding='utf-8') as f:
        py = f.read()

    spec = vs.RULE_SPEC
    print('=== 版本号规则双实现一致性静态守卫 ===')
    print('真值源: tools/version_scheme.py (RULE_SPEC)')
    print('镜像:   _client_src/app/src/version-scheme.js')

    check('MINOR_MAX = %s' % spec['MINOR_MAX'],
          js_const(js, 'MINOR_MAX') == str(spec['MINOR_MAX']),
          'JS=%r' % js_const(js, 'MINOR_MAX'))
    check('MAX_SEQUENCE = %s' % spec['MAX_SEQUENCE'],
          js_const(js, 'MAX_SEQUENCE') == str(spec['MAX_SEQUENCE']),
          'JS=%r' % js_const(js, 'MAX_SEQUENCE'))
    check('VERSION_RE 与真值源一致',
          js_regex(js, 'VERSION_RE') == spec['VERSION_RE'],
          'py=%r js=%r' % (spec['VERSION_RE'], js_regex(js, 'VERSION_RE')))
    check('LEGACY_RE 与真值源一致',
          js_regex(js, 'LEGACY_RE') == spec['LEGACY_RE'],
          'py=%r js=%r' % (spec['LEGACY_RE'], js_regex(js, 'LEGACY_RE')))

    js_carry = 'p.minor < MINOR_MAX' in js and "(p.major + 1) + '.0'" in js
    py_carry = 'minor < MINOR_MAX' in py and "'%d.0' % (major + 1)" in py
    check('进位规则（minor < MINOR_MAX / 主版本进位）两侧一致', js_carry and py_carry)

    # 双向「明确标注」：两边都得指到对方，防止有人只改一侧还以为只有一个实现。
    check('JS 镜像显式标注 Python 真值源', 'version_scheme.py' in js)
    check('Python 真值源显式标注 JS 镜像', 'version-scheme.js' in py)

    print('RESULT: %d passed, %d failed' % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
