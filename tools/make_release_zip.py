"""把构建产物打成 zip。

用法：
    python make_release_zip.py changes <源目录> <输出.zip>   # 只打改动文件
    python make_release_zip.py full    <源目录> <输出.zip>   # 打完整便携版（较大，建议后台跑）

full 模式会剔除「运行期用不到」的体积项（见 PRUNE_PREFIXES / PRUNE_SITE_PKGS /
PRUNE_FLAT_DIRS / PRUNE_SCRIPT_STEMS）。
这些文件仍保留在源目录里（不删本地文件），只是不进发布包 —— 出问题改这里重打即可。
"""
import os
import sys
import time
import zipfile

# 完整便携版里这些是运行期产生的日志/缓存/数据，不进发布包
SKIP_SUFFIX = {
    '.log', '.tmp',
    # SQLite 主库 + WAL 模式（database.py 的 PRAGMA）的 -wal / -shm：
    # 全是运行期数据，绝不能打进发布包（否则等于把别人的数据发出去）。
    # 便携版首次启动会自建空库，无需预置。
    '.db', '.db-wal', '.db-shm', '.db-journal',
}
SKIP_DIR = {'logs', 'crashDumps', '__pycache__'}
# 只在源目录**顶层**跳过的目录。
# 注意不能放进 SKIP_DIR：`frontend/dist` 是前端构建产物，必须保留。
# 而 perfara/build（PyInstaller 中间产物 37MB）、perfara/dist（22MB 的
# PerfaraServer.exe 副本）只是构建副产物，绝不能进发布包。
# client-patch 是「给旧版 app.asar 打激活移除补丁」的历史说明与补丁文件，
# 激活链路已彻底清除，该目录不再需要随包分发。
SKIP_DIR_ROOT = {'build', 'dist', 'client-patch'}

# ── 发布包体积剔除清单 ──────────────────────────────────────────────────────
# 依据 docs/优化方案-体积与性能.md 的 S1 / S2。
# 均为「运行期零引用」项；本地源目录不做删除，只是不放进 zip。
_PY = 'collector/resources/ios-tools/python'
PRUNE_PREFIXES = (
    # S0：data/ 下**全部**运行期产物，整目录剔除。
    # 只挡 `.db` 不够：`webperf.db.bak-20261023-111846` 这种手工备份后缀不是 .db，
    # 会连库里的测试记录（owner_uid、iOS UDID、采集数据）一起打进发布包。
    # data/ 由 backend.paths.ensure_data_dir() 首次启动自建，无需预置任何文件。
    #
    # 注意：**种子库不在这里**。exe 首次启动用的种子库是编进 PerfaraServer.exe 的
    # `_seed/webperf.db`（见 perfara_server.spec），与本目录的 data/ 无关。
    'data/',
    # _seed/ 是构建期输入（build_exe.bat 把它编进 PerfaraServer.exe），运行期不读；
    # 随包再放一份等于同一个库发两遍。
    '_seed/',
    # S0-④：报告目录里的运行期产物（最近一次 data.js、本地报告库、低谷截图）。
    # 这些文件带着打包机上的绝对路径（截图 url=file:///E:/...）和自测数据；
    # 用户端由「停止采集」自己生成，首次打开时缺失是正常状态。
    'collector/resources/reports/data.js',
    'collector/resources/reports/data.json',
    'collector/resources/reports/shots/',
    'collector/resources/reports/history/',
    # 启动器为子进程准备的运行期临时目录（PyInstaller onefile 的 _MEI 解包产物）。
    # 每次启动都会重建，绝不能打进发布包。
    '.run/',
    # S0-②：测试套件不随包分发（58 条目，含 realdevice/_shots 下的界面截图）。
    # 用户不需要，也没人会在解压后的便携包里跑测试。
    'tests/',
    # S0-③：iOS 开发者镜像（8.46MB）纯死重。
    # 全仓检索 devimage / DeveloperDiskImage：源码、backend、app.asar、内置 Python 的
    # site-packages 均 0 处引用；ios-collector.js 走的是 `ios image auto`（联网下载并挂载）。
    # 且该 dmg 自身已压缩，zip 内几乎不缩（8,464,365 → 8,456,926），8.46MB 原样计入包体。
    'collector/resources/ios-tools/devimages/',
    # S1：27.7MB 的 GPU 采样样例 JSON。全仓无读取代码，ios_gpulow.exe 也不按名读它
    # （二进制内检索无 "lowgpu.json" 字面量，只有模块名 ios_lowgpucounters）。
    'collector/resources/ios-tools/bin/lowgpu.json',
    # S2-①：纯运行期无用
    _PY + '/python/tcl/',            # 9.0MB tkinter 运行时
    _PY + '/python/DLLs/tcl86t.dll',
    _PY + '/python/DLLs/tk86t.dll',
    _PY + '/python/include/',        # 2.3MB C 头文件，运行期无用
    _PY + '/python/libs/',           # 556K 导入库
    _PY + '/python/Lib/idlelib/',
    _PY + '/python/Lib/ensurepip/',
    _PY + '/python/Lib/pydoc_data/',
    _PY + '/python/Lib/venv/',
    _PY + '/python/Lib/test/',
    _PY + '/notebooks/',
)

# S2-③ / S2-④：按**包名**剔除，而不是写死 `site-packages/uncompyle6/` 这种完整路径。
# 之前写死路径只删掉了包体，`uncompyle6-3.9.3.dist-info/` 和 `Scripts/uncompyle6.exe`
# 都漏在包里（xdis / spark_parser / pip 同样如此，合计约 1.6MB）。
#   - 反编译工具（uncompyle6 / xdis / spark_parser）：pymobiledevice3 运行期不引用
#   - pip：只在装包时用，ensurepip 已剔除，pip 也不再有意义
# 元数据（*-*.dist-info/）与包体同生命周期，包体没了它只剩噪音。
PRUNE_SITE_PKGS = ('uncompyle6', 'xdis', 'spark_parser', 'pip')
# 被剔包对应的控制台启动器（Scripts/*.exe）。这些 exe 只是
# `python.exe -m <pkg>` 的壳，包体已剔除，留着必然报 ModuleNotFoundError。
PRUNE_SCRIPT_STEMS = ('uncompyle6', 'pydisasm', 'spark-parser-coverage', 'pip')

_SP = _PY + '/python/Lib/site-packages/'
_SCRIPTS = _PY + '/python/Scripts/'

# WinPython 启动器（Spyder / VS Code / Jupyter 快捷方式），采集端从不调用。
# 只剔除 `ios-tools/python/` **这一层**的 exe，绝不碰 python/python/python.exe。
# 注意不能用 fnmatch('dir/*.exe')：fnmatch 的 `*` 会跨 `/` 匹配，
# 那样会把 python/python/python.exe 一起剔掉，iOS 采集直接失效。
PRUNE_FLAT_DIRS = {
    _PY + '/': ('.exe',),
}

# 保守起见不动的东西（写在这里是为了让后来人知道「不是漏了」）：
#   site-packages/setuptools + _distutils_hack + distutils-precedence.pth
#   —— .pth 在解释器启动时就会被 site.py 执行，删 setuptools 而不删 .pth
#   会让每次启动都往 stderr 打 traceback，可能干扰采集输出解析。
#   site-packages/pkg_resources —— 同上，与 setuptools 同生命周期。


def pruned(rel):
    """返回剔除原因；None 表示保留。rel 为 posix 风格相对路径。"""
    for pref in PRUNE_PREFIXES:
        if rel == pref or rel.startswith(pref):
            return 'S1/S2 体积剔除'
    for base, exts in PRUNE_FLAT_DIRS.items():
        if rel.startswith(base):
            tail = rel[len(base):]
            if '/' in tail:
                continue          # 只处理该目录下的直接子文件，不跨层
            for ext in exts:
                if tail.lower().endswith(ext):
                    return 'S2 WinPython 启动器'
    # site-packages 下被剔包的包体 + 同名 dist-info（版本号不写死）
    if rel.startswith(_SP):
        tail = rel[len(_SP):]
        for pkg in PRUNE_SITE_PKGS:
            if tail.startswith(pkg + '/'):
                return 'S2 反编译/pip 包体'
            if tail.startswith(pkg + '-') and '.dist-info/' in tail:
                return 'S2 反编译/pip 元数据'
    # 被剔包在 Scripts/ 下的控制台启动器（只看该层直接子文件）
    if rel.startswith(_SCRIPTS):
        tail = rel[len(_SCRIPTS):]
        if '/' not in tail and tail.lower().endswith('.exe'):
            stem = tail[:-4].lower()
            for s in PRUNE_SCRIPT_STEMS:
                if stem == s or stem.startswith(s):
                    return 'S2 反编译/pip 启动器'
    return None


def add(zf, src, mode):
    n = 0
    total = 0
    skipped = 0
    skipped_bytes = 0
    for root, dirs, files in os.walk(src):
        if mode == 'full':
            depth0 = os.path.abspath(root) == os.path.abspath(src)
            skip = set(SKIP_DIR) | (SKIP_DIR_ROOT if depth0 else set())
            dirs[:] = [d for d in dirs if d not in skip]
        for f in sorted(files):
            full = os.path.join(root, f)
            rel = os.path.relpath(full, src).replace('\\', '/')
            if mode == 'full':
                ext = os.path.splitext(f)[1].lower()
                if ext in SKIP_SUFFIX:
                    continue
                if pruned(rel):
                    try:
                        skipped_bytes += os.path.getsize(full)
                    except OSError:
                        pass
                    skipped += 1
                    continue
            try:
                zf.write(full, rel, zipfile.ZIP_DEFLATED)
                n += 1
                total += os.path.getsize(full)
            except OSError as e:
                print('  跳过（被占用）:', rel, e)
    return n, total, skipped, skipped_bytes


def main():
    mode = sys.argv[1]
    src = sys.argv[2]
    out = sys.argv[3]
    t0 = time.time()
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        n, total, skipped, skipped_bytes = add(zf, src, mode)
    size = os.path.getsize(out)
    print(f'打包完成: {out}')
    print(f'  文件 {n} 个，原始 {total/1048576:.1f}MB -> 压缩后 {size/1048576:.1f}MB '
          f'(压缩率 {(1 - size / max(total, 1)) * 100:.0f}%)，耗时 {time.time() - t0:.0f}s')
    if mode == 'full' and skipped:
        print(f'  体积剔除 {skipped} 个文件 / {skipped_bytes/1048576:.1f}MB'
              f'（S2 内置 Python 裁剪：tcl/include/libs/idlelib/ensurepip/pydoc_data/venv'
              f' + pip/反编译工具包体及元数据 + WinPython 启动器；源目录未删除）')


if __name__ == '__main__':
    main()
