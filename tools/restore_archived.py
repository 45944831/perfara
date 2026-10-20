# -*- coding: utf-8 -*-
"""
把清理时归档到 F 盘的内容还原回工作区原位。

归档来源：F:\\Perfara_构建产物_20261020\\
  - 测试脚本归档_20261020.zip  -> perfara/tests/
  - 证据截图归档/*             -> _evidence_*/ 、根目录截图/*.png *.md

用法：
  python tools/restore_archived.py            # 全部还原
  python tools/restore_archived.py --tests    # 只还原测试脚本
  python tools/restore_archived.py --evidence # 只还原证据截图
已存在的文件默认跳过（不覆盖），加 --overwrite 覆盖。
"""
import os
import sys
import shutil
import zipfile
import argparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARCHIVE = r'F:\Perfara_构建产物_20261020'
TESTS_ZIP = os.path.join(ARCHIVE, '测试脚本归档_20261020.zip')
EVIDENCE = os.path.join(ARCHIVE, '证据截图归档')


def restore_tests(overwrite=False):
    if not os.path.isfile(TESTS_ZIP):
        print('未找到归档：%s' % TESTS_ZIP)
        return 0
    dest = os.path.join(ROOT, 'perfara', 'tests')
    os.makedirs(dest, exist_ok=True)
    n = 0
    with zipfile.ZipFile(TESTS_ZIP) as z:
        for info in z.infolist():
            name = info.filename
            # 归档时以 tests 为根，这里去掉根前缀
            parts = name.split('/')
            if parts and parts[0] == 'tests':
                parts = parts[1:]
            rel = '/'.join(parts)
            if not rel:
                continue
            target = os.path.join(dest, rel.replace('/', os.sep))
            if info.is_dir():
                os.makedirs(target, exist_ok=True)
                continue
            if os.path.exists(target) and not overwrite:
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(info) as src, open(target, 'wb') as out:
                shutil.copyfileobj(src, out)
            n += 1
    print('还原测试脚本 %d 个文件 -> perfara/tests/' % n)
    return n


def restore_evidence(overwrite=False):
    if not os.path.isdir(EVIDENCE):
        print('未找到归档：%s' % EVIDENCE)
        return 0
    n = 0
    for entry in sorted(os.listdir(EVIDENCE)):
        src = os.path.join(EVIDENCE, entry)
        if entry == '根目录截图':
            # 根目录散落的 png/md
            for f in sorted(os.listdir(src)):
                t = os.path.join(ROOT, f)
                if os.path.exists(t) and not overwrite:
                    continue
                shutil.copy2(os.path.join(src, f), t)
                n += 1
        elif os.path.isdir(src):
            t = os.path.join(ROOT, entry)
            if os.path.isdir(t) and not overwrite:
                continue
            if os.path.isdir(t):
                shutil.rmtree(t, ignore_errors=True)
            shutil.copytree(src, t)
            n += 1
    print('还原证据目录/截图 %d 项 -> 工作区' % n)
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tests', action='store_true')
    ap.add_argument('--evidence', action='store_true')
    ap.add_argument('--overwrite', action='store_true')
    args = ap.parse_args()

    total = 0
    if args.tests or not (args.tests or args.evidence):
        total += restore_tests(args.overwrite)
    if args.evidence or not (args.tests or args.evidence):
        total += restore_evidence(args.overwrite)
    print('完成，共还原 %d 项' % total)


if __name__ == '__main__':
    sys.exit(main())
