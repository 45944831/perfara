# -*- coding: utf-8 -*-
"""
清理工作区无用文件：备份副本、构建中间产物、虚拟环境、测试脚本、过程截图。

设计原则：
  1) 只删"可从别处重建 / 已归档"的东西，源码与构建配置一律保留；
  2) 删除前把清单写到报告文件，可追溯；
  3) 支持 --dry-run 预演，默认必须显式 --apply 才真删。
"""
import os
import sys
import shutil
import argparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 直接整体删除的目录（备份副本 / 中间产物 / 已归档的过程资产）
DIRS = [
    '_asar_backup',                # 588M：7 份旧 app.asar 备份
    '_asar_build',                 # 4.1M：打包中间目录
    '_perfdog_opt_backup',         # 74M：Perfdog 优化前备份
    '_perfdog_opt_evidence',       # 516K
    '_backup_metricinfo',          # 204K
    '_backup_20261019_metricinfo', # 204K
    '_removed-from-portable',      # 23M：从便携版剔除的文件
    '_evidence_compare', '_evidence_metric_info', '_evidence_openloc',
    '_evidence_overlap', '_evidence_readability', '_evidence_realdevice',
    '_evidence_shared',            # 证据截图（已归档 F 盘）
    'perfara/tests',               # 测试脚本（已归档 F 盘）
    'perfara/.venv',               # 75M：Python 虚拟环境
    'perfara/build',               # 36M：PyInstaller 中间产物
    'perfara/dist',                # 23M：PyInstaller 产物
    'perfara/logs',                # 运行日志
    'Perfara-Portable',            # 470M：便携版产物副本（F 盘已有 zip）
    'build/launcher/build', 'build/launcher/dist',
    'build/launcher-offline/build', 'build/launcher-offline/dist',
]

# 直接删除的文件
FILES = [
    '_asar_build.asar',            # 76M：打包中间产物
]

# 根目录散落的过程截图与报告（已归档 F 盘）
ROOT_PATTERNS = ('.png', '.jpg', '.jpeg', '.gif')

# 必须保留（即使匹配到上面的模式）
KEEP_ROOT_FILES = {'Readme.md'}


def dir_size(p):
    total = 0
    for r, _d, ns in os.walk(p):
        for n in ns:
            try:
                total += os.path.getsize(os.path.join(r, n))
            except OSError:
                pass
    return total


def human(n):
    for u in ('B', 'KB', 'MB', 'GB'):
        if n < 1024:
            return '%.1f%s' % (n, u)
        n /= 1024.0
    return '%.1fTB' % n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='真正执行删除（默认仅预演）')
    args = ap.parse_args()

    targets = []
    for rel in DIRS:
        p = os.path.join(ROOT, rel.replace('/', os.sep))
        if os.path.isdir(p):
            targets.append(('dir', rel, dir_size(p)))
    for rel in FILES:
        p = os.path.join(ROOT, rel)
        if os.path.isfile(p):
            targets.append(('file', rel, os.path.getsize(p)))
    for n in sorted(os.listdir(ROOT)):
        p = os.path.join(ROOT, n)
        if not os.path.isfile(p) or n in KEEP_ROOT_FILES:
            continue
        if n.lower().endswith(ROOT_PATTERNS):
            targets.append(('file', n, os.path.getsize(p)))

    total = sum(s for _k, _r, s in targets)
    print('清理目标 %d 项，合计 %s' % (len(targets), human(total)))
    print('-' * 62)
    for kind, rel, size in targets:
        print('  [%s] %-42s %10s' % (kind, rel, human(size)))

    # 保留项提示
    print('\n保留（源码 / 构建配置 / 运行时）：')
    for rel in ('_client_src', 'tools', 'perfara/backend', 'perfara/frontend',
                'perfara/server', 'perfara/collector', 'build/launcher/Perfara.spec',
                'build/launcher-offline/Perfara离线版.spec'):
        p = os.path.join(ROOT, rel.replace('/', os.sep))
        if os.path.exists(p):
            print('  keep  %s' % rel)

    if not args.apply:
        print('\n（预演模式，未删除任何文件。加 --apply 执行）')
        return

    print('\n开始删除...')
    freed = 0
    failed = []
    for kind, rel, size in targets:
        p = os.path.join(ROOT, rel.replace('/', os.sep))
        try:
            if kind == 'dir':
                shutil.rmtree(p)
            else:
                os.remove(p)
            freed += size
        except Exception as e:
            failed.append((rel, str(e)))
    # 清 __pycache__
    for r, ds, _ns in os.walk(ROOT):
        if '__pycache__' in ds:
            fp = os.path.join(r, '__pycache__')
            try:
                freed += dir_size(fp)
                shutil.rmtree(fp)
                ds.remove('__pycache__')
            except Exception:
                pass
    print('实际释放 %s' % human(freed))
    if failed:
        print('失败 %d 项：' % len(failed))
        for rel, err in failed:
            print('   %s -> %s' % (rel, err))


if __name__ == '__main__':
    sys.exit(main())
