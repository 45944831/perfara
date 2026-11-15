#!/usr/bin/env python3
"""发布包体积只读清点（不删除任何文件、不生成 zip、不运行出包）。

批次 3.3：清点 perfara/collector/ 下的 iOS 工具链、ios_device 相关路径、
site-packages 可裁项，并估算应用现有 PRUNE / SKIP 规则能省多少字节。

统计直接复用 make_release_zip.py 的 pruned() / SKIP_SUFFIX / SKIP_DIR 等规则，
而不是另写一份判断 —— 这样清点数字不会与真实打包逻辑漂移。

用法：
    python tools/inventory_package.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_release_zip as mrz  # noqa: E402

REPO = os.path.dirname(HERE)
COLLECTOR = os.path.join(REPO, 'perfara', 'collector')
IT = os.path.join(COLLECTOR, 'resources', 'ios-tools')
PY_HOME = os.path.join(IT, 'python', 'python')
SP = os.path.join(PY_HOME, 'Lib', 'site-packages')
SCRIPTS = os.path.join(PY_HOME, 'Scripts')
PSETS = os.path.join(SCRIPTS, 'psets', 'pdm')
IOS_DEVICE = os.path.join(PSETS, 'ios_device')

SKIP_FILENAMES = getattr(mrz, 'SKIP_FILENAMES', set())


def dir_size(p):
    if os.path.isfile(p):
        return os.path.getsize(p)
    t = 0
    for r, d, fs in os.walk(p):
        for f in fs:
            try:
                t += os.path.getsize(os.path.join(r, f))
            except OSError:
                pass
    return t


def mb(n):
    return f'{n / 1048576:9.2f} MB'


def files_under(root):
    out = []
    for r, d, fs in os.walk(root):
        for f in fs:
            out.append(os.path.join(r, f))
    return out


def main():
    if not os.path.isdir(COLLECTOR):
        print('[错误] 找不到扫描目录:', COLLECTOR)
        return 2

    allf = files_under(COLLECTOR)
    total_bytes = sum(os.path.getsize(f) for f in allf)

    print('=== Perfara 发布包体积只读清点（不删任何文件 / 不生成 zip）===')
    print('扫描目录: perfara/collector/   （在发布包内对应 collector/ 前缀）')
    print(f'文件 {len(allf)} 个 / 合计 {mb(total_bytes)}')

    # ── A. iOS 工具链 ────────────────────────────────────────────────────────
    print('\n--- A. iOS 工具链（ios-tools 三大块，方案所称重复载体）---')
    it_total = 0
    for name in ('bin', 'devimages', 'python'):
        p = os.path.join(IT, name)
        s = dir_size(p)
        it_total += s
        print(f'  {name:<12}{mb(s)}')
    print(f'  {"三大块合计":<12}{mb(it_total)}')
    exe_total = sum(os.path.getsize(os.path.join(IT, 'bin', f))
                    for f in os.listdir(os.path.join(IT, 'bin'))
                    if f.lower().endswith('.exe')) if os.path.isdir(os.path.join(IT, 'bin')) else 0
    script_copies = [f for f in allf if os.path.dirname(f) == SCRIPTS and
                     os.path.basename(f).lower().startswith(
                         ('collect_ios', 'gpu_counters', 'collect_pc'))]
    sc_bytes = sum(os.path.getsize(f) for f in script_copies)
    print(f'  bin/ 两个打包采集器 exe: {mb(exe_total)}')
    print(f'  Scripts/ 采集脚本 .py/.pyc 副本: {len(script_copies)} 个 / {mb(sc_bytes)}')
    print(f'  psets/pdm/ios_device 源码包: {mb(dir_size(IOS_DEVICE))}')

    # ── B. ios_device 相关路径 ──────────────────────────────────────────────
    print('\n--- B. ios_device 相关路径 ---')
    path_hits = 0
    py_n = pyc_n = rel_bytes = 0
    for r, d, fs in os.walk(COLLECTOR):
        for x in list(d) + list(fs):
            if 'ios_device' in os.path.join(r, x).lower():
                path_hits += 1
        for f in fs:
            p = os.path.join(r, f)
            if 'ios_device' in p.lower():
                rel_bytes += os.path.getsize(p)
                if f.endswith('.py'):
                    py_n += 1
                elif f.endswith('.pyc'):
                    pyc_n += 1
    print(f'  含 ios_device 的路径条目（目录 + 文件）: {path_hits}')
    print(f'  .py 文件: {py_n} / .pyc 文件: {pyc_n} / 相关文件字节合计: {mb(rel_bytes)}')
    print(f'  psets/pdm 整目录: {mb(dir_size(PSETS))}')

    # ── C. site-packages 已覆盖可裁项 ───────────────────────────────────────
    print('\n--- C. site-packages 中 PRUNE 已覆盖的可裁项 ---')
    c_total = 0
    if os.path.isdir(SP):
        for pkg in mrz.PRUNE_SITE_PKGS:
            parts = [os.path.join(SP, e.name) for e in os.scandir(SP)
                     if e.name == pkg or (e.name.startswith(pkg + '-') and e.is_dir())]
            s = sum(dir_size(p) for p in parts)
            c_total += s
            print(f'  {pkg:<14}{mb(s)}（包体 + dist-info）')
    exe_n = exe_bytes = 0
    if os.path.isdir(SCRIPTS):
        for e in os.scandir(SCRIPTS):
            if e.is_file() and e.name.lower().endswith('.exe'):
                stem = e.name[:-4].lower()
                if any(stem == s or stem.startswith(s) for s in mrz.PRUNE_SCRIPT_STEMS):
                    exe_n += 1
                    exe_bytes += e.stat().st_size
    c_total += exe_bytes
    print(f'  Scripts 启动器 {exe_n} 个: {mb(exe_bytes)}')
    print(f'  {"合计":<14}{mb(c_total)}  （已由 PRUNE_SITE_PKGS / PRUNE_SCRIPT_STEMS 剔除）')

    # ── D. 现有规则的预估节省 ───────────────────────────────────────────────
    print('\n--- D. 应用现有 PRUNE / SKIP 规则的预估节省 ---')
    nd = bd = ns = bs = np = bp = 0
    for full in allf:
        f = os.path.basename(full)
        sz = os.path.getsize(full)
        rel = 'collector/' + os.path.relpath(full, COLLECTOR).replace('\\', '/')
        mid_dirs = rel.split('/')[:-1]
        if any(p in mrz.SKIP_DIR for p in mid_dirs):
            nd += 1
            bd += sz
            continue
        if os.path.splitext(f)[1].lower() in mrz.SKIP_SUFFIX or f.lower() in SKIP_FILENAMES:
            ns += 1
            bs += sz
            continue
        if mrz.pruned(rel):
            np += 1
            bp += sz
    print(f'  SKIP_DIR 目录级排除:              {nd:5d} 个 / {mb(bd)}')
    print(f'  SKIP_SUFFIX / SKIP_FILENAMES:      {ns:5d} 个 / {mb(bs)}')
    print(f'  PRUNE_PREFIXES / FLAT_DIRS / SITE: {np:5d} 个 / {mb(bp)}')
    print(f'  >>> 合计预估节省: {mb(bd + bs + bp)} / {nd + ns + np} 个文件')
    print('  （SKIP_DIR_ROOT 仅作用于打包源根顶层，本清点范围内无对应目录，未计入）')

    # ── E. 候选裁剪项与保守判断 ────────────────────────────────────────────
    print('\n--- E. 候选裁剪项与保守判断（本次未删除任何文件）---')
    demo_tests = dir_size(os.path.join(PSETS, 'demo')) + dir_size(os.path.join(PSETS, 'tests'))
    print(f'  [可裁·本次已补进 PRUNE] psets/pdm/demo/ + tests/: {mb(demo_tests)}')
    print(f'  [不可裁] psets/pdm/ios_device/: {mb(dir_size(IOS_DEVICE))}'
          '  —— collect_ios.py 通过 sys.path.insert 引用，是运行期依赖')
    orphan_pyc = [f for f in allf if os.path.dirname(f) == SCRIPTS and
                  f.lower().endswith('.pyc') and
                  not os.path.isfile(os.path.join(SCRIPTS, os.path.basename(f)[:-1]))]
    op_bytes = sum(os.path.getsize(f) for f in orphan_pyc)
    print(f'  [不可裁] Scripts/ 下无对应 .py 的 .pyc: {len(orphan_pyc)} 个 / {mb(op_bytes)}'
          '  —— 可能运行期直接加载，勿把 .pyc 加进 SKIP_SUFFIX')
    print(f'  [需人工确认] bin/ 两个打包采集器 exe: {mb(exe_total)}'
          '  —— 能否合并超出本次范围，不动')
    print('  [需人工确认] site-packages 其余项（sqlite_bro / srptools / wppm / sv_ttk / execjs 等）'
          '  —— 未确证运行期零引用，不动')
    print('\n（本脚本只读；PRUNE/SKIP 规则的唯一实现在 tools/make_release_zip.py）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
