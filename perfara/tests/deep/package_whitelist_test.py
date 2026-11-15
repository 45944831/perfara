"""发布包报告目录白名单的行为测试（S-04）。

`tools/make_release_zip.py` 里 `collector/resources/reports/` 从「扩展名黑名单」反转成
「文件名白名单」后，正确性不能只靠 grep 常量名——必须真的调用 `pruned()` 看判定结果。
本测试直接把打包脚本当模块导入，对一组真实路径断言「该留的留、该剔的剔」。

顺带守住两条配套承诺：
  - `check_reports_assets()` 在白名单文件缺失时要中止打包（否则会把页面资源一起挡掉）
  - `perf2.html`（已停用的旧报告页）不得在白名单里

用法：python perfara/tests/deep/package_whitelist_test.py
"""
import importlib.util
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent.parent

spec = importlib.util.spec_from_file_location(
    "make_release_zip", REPO / "tools" / "make_release_zip.py")
MRZ = importlib.util.module_from_spec(spec)
spec.loader.exec_module(MRZ)

results = []


def check(name, ok, detail=""):
    detail = "" if detail == "" else str(detail)
    results.append((name, bool(ok), detail))
    print(("  PASS  " if ok else "  FAIL  ") + name + (("  | " + detail) if detail else ""))


D = 'collector/resources/reports/'

# 交付资源：必须保留
KEEP = ['perf.html', 'library.html', 'echarts.min.js']
# 运行期产物 / 停用页：必须剔除
DROP = [
    'Perfara_Chrome(com.android.chrome)_20261114-202035.xlsx',
    'Perfara_PC_20261114.xls',
    'data.js',
    'data.json',
    'perf2.html',
    'diagnostics.json',        # 将来可能新增的产物类型：白名单默认挡住
    'trough_export.csv',
    'shot_01.png',
]


def main():
    for name in KEEP:
        check('保留交付资源 %s' % name, MRZ.pruned(D + name) is None, MRZ.pruned(D + name))
    for name in DROP:
        reason = MRZ.pruned(D + name)
        check('剔除 %s' % name, reason is not None, reason or '未剔除')

    # 子目录（本地报告库 / 低谷截图）整目录剔除
    for sub in ('history/index.json', 'history/20261114-202035-x.js', 'shots/a/b.jpg'):
        check('剔除子目录文件 %s' % sub, MRZ.pruned(D + sub) is not None)

    # 白名单里不得出现停用页
    check('perf2.html 不在白名单', 'perf2.html' not in MRZ.REPORTS_ALLOW, sorted(MRZ.REPORTS_ALLOW))

    # 白名单文件真的存在（缺一个就该中止打包）
    try:
        MRZ.check_reports_assets(str(REPO / 'perfara'))
        check('白名单文件齐全时 check_reports_assets 通过', True)
    except SystemExit as e:
        check('白名单文件齐全时 check_reports_assets 通过', False, e)

    # 少一个文件必须中止（用临时目录模拟，不动真实资源）
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        for n in KEEP[:-1]:
            p = Path(tmp) / D / n
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text('x', encoding='utf-8')
        try:
            MRZ.check_reports_assets(tmp)
            check('白名单文件缺失时中止打包', False, '没有抛 SystemExit')
        except SystemExit as e:
            check('白名单文件缺失时中止打包', True, str(e)[:60])

    passed = sum(1 for _, ok, _ in results if ok)
    failed = len(results) - passed
    print('-' * 60)
    print('结果：%d PASS / %d FAIL' % (passed, failed))
    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
