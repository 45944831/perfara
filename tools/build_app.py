"""Perfara 客户端 app.asar 瘦身打包工具。

背景：源码树 _client_src/app 里带有大量运行期用不到的文件（echarts 全量发行包含
31MB source map、8MB iOS 调试镜像、3.4MB 推广视频、历史 zip 包等），原 pack 会把
它们原样塞进 asar，导致包体 77MB、启动时要解析上千条 header 条目。

本工具在打包时按规则过滤，**不改动源码树**（源码树仍保留完整依赖，便于开发/回滚），
产出体积减少 90%+ 的 app.asar，并打印剔除明细。

用法：
    python build_app.py                     # 打包并部署到 perfara/ 与 Perfara-Portable/
    python build_app.py --dry-run           # 只看会剔除什么、最终体积多少，不写包
    python build_app.py --out <path.asar>   # 只打包到指定路径，不部署
"""
import json
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, '_client_src', 'app')

# ── 排除规则 ────────────────────────────────────────────────────────────────
# 1) 整个目录（运行期无任何引用，属开发遗留物 / 素材）
EXCLUDE_DIRS = {
    'devimages',    # iOS DeveloperDiskImage.dmg（8.1MB）。iOS 采集走 `ios image auto` 联网挂载，不读本地镜像
    '推广web',       # 推广页素材，含 3.4MB ads.mp4
    'ios脚本',       # iOS 采集脚本源码副本；运行期实际用的是包外 resources/ios-tools/**/Scripts/*.pyc
}
# 2) 后缀
EXCLUDE_SUFFIXES = {
    '.map',   # echarts 发行包里的 source map，占 ~31MB
    '.zip',   # perfara.zip / code.zip，历史归档
    '.dmg',
    '.mp4',
}
# 3) 精确相对路径
EXCLUDE_FILES = {
    'psetsdoc.md',
}

# echarts：运行期只用 dist/echarts.min.js（script 标签直引，不走 require），
# 其余 dist/*.js、lib/、theme/、i18n/、extension/、ssr/ 全不需要。
ECHARTS_KEEP = {
    'node_modules/echarts/package.json',
    'node_modules/echarts/index.js',
    'node_modules/echarts/dist/echarts.min.js',
    'node_modules/echarts/dist/package.json',
}

# 整包剔除的目录前缀。
# zrender 2.42MB / 255 个文件：dist/echarts.min.js 是 UMD 构建，已把 zrender
# 打进去了；全仓检索无 require('zrender')，4 个渲染页也只用 script 标签引
# echarts.min.js，所以运行期零引用。
EXCLUDE_PREFIXES = (
    'node_modules/zrender/',
)


def rel_posix(full):
    return os.path.relpath(full, SRC).replace('\\', '/')


def is_excluded(rel):
    """返回剔除原因；None 表示保留。仅对文件调用。"""
    parts = rel.split('/')
    if parts[0] in EXCLUDE_DIRS:
        return '目录 ' + parts[0]
    for pref in EXCLUDE_PREFIXES:
        if rel.startswith(pref):
            return '目录 ' + pref.rstrip('/').split('/')[-1]
    # echarts 白名单：只有 KEEP 里的文件进包，其余全剔（含 lib/ theme/ dist 其它构建产物）
    if parts[0] == 'node_modules' and len(parts) > 1 and parts[1] == 'echarts':
        if rel in ECHARTS_KEEP:
            return None
        return 'echarts 未使用文件'
    if rel in EXCLUDE_FILES:
        return '文档'
    ext = os.path.splitext(rel)[1].lower()
    if ext in EXCLUDE_SUFFIXES:
        return '后缀 ' + ext
    return None


def dir_size(full):
    """统计目录内所有文件的总大小（被整个剔除的目录用于报告）。"""
    total = 0
    for root, _dirs, names in os.walk(full):
        for n in names:
            try:
                total += os.path.getsize(os.path.join(root, n))
            except OSError:
                pass
    return total


def collect():
    kept, dropped = [], []
    for root, dirs, names in os.walk(SRC, topdown=True):
        dirs.sort()
        rel_root = rel_posix(root)
        depth0 = rel_root == '.'
        # 顶层目录整体剔除：不再递归，但要统计体积写进报告
        if depth0:
            remain = []
            for d in dirs:
                if d in EXCLUDE_DIRS:
                    dropped.append((d + '/', dir_size(os.path.join(root, d)), '目录 ' + d))
                else:
                    remain.append(d)
            dirs[:] = remain
        for n in sorted(names):
            full = os.path.join(root, n)
            rel = rel_posix(full)
            reason = is_excluded(rel)
            (dropped if reason else kept).append((rel, os.path.getsize(full), reason))
    return kept, dropped


def pack(files, out_asar):
    """按给定清单打包（offset 顺序分配，格式与 Electron asar 一致）。"""
    tree = {}
    blobs = []
    offset = 0
    for rel, size, _ in sorted(files, key=lambda x: x[0]):
        full = os.path.join(SRC, rel)
        node = tree
        parts = rel.split('/')
        for p in parts[:-1]:
            node = node.setdefault(p, {'files': {}})['files']
        node[parts[-1]] = {'size': size, 'offset': str(offset)}
        offset += size
        blobs.append(full)

    js = json.dumps({'files': tree}, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    L = len(js)
    with open(out_asar, 'wb') as f:
        f.write(struct.pack('<I', 4))
        f.write(struct.pack('<I', 8 + L))
        f.write(struct.pack('<I', 4 + L))
        f.write(struct.pack('<I', L))
        f.write(js)
        for b in blobs:
            with open(b, 'rb') as g:
                while True:
                    chunk = g.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
    return len(blobs), offset


def human(n):
    for u in ('B', 'KB', 'MB', 'GB'):
        if n < 1024 or u == 'GB':
            return f'{n:.0f}{u}' if u == 'B' else f'{n:.1f}{u}'
        n /= 1024.0


def main():
    args = sys.argv[1:]
    dry = '--dry-run' in args
    out = None
    if '--out' in args:
        out = args[args.index('--out') + 1]

    kept, dropped = collect()
    ksize = sum(s for _, s, _ in kept)
    dsize = sum(s for _, s, _ in dropped)
    total = ksize + dsize

    print('=' * 62)
    print(f'源码树    {human(total)}  ({len(kept) + len(dropped)} 个文件)')
    print(f'打进包    {human(ksize)}  ({len(kept)} 个文件)')
    print(f'剔除      {human(dsize)}  ({len(dropped)} 个文件, {dsize * 100.0 / max(total, 1):.1f}%)')
    print('-' * 62)
    by_reason = {}
    for _, s, reason in dropped:
        by_reason.setdefault(reason, [0, 0])
        by_reason[reason][0] += 1
        by_reason[reason][1] += s
    for reason, (cnt, size) in sorted(by_reason.items(), key=lambda x: -x[1][1]):
        print(f'  {reason:<22} {cnt:>5} 个  {human(size):>9}')
    print('=' * 62)

    if dry:
        return

    dest = out or os.path.join(ROOT, '_asar_build', 'app.asar')
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    n, size = pack(kept, dest)
    print(f'已打包 -> {dest}  ({n} 个文件, {human(size)})')

    if out:
        return

    targets = [
        os.path.join(ROOT, 'perfara', 'collector', 'resources', 'app.asar'),
        os.path.join(ROOT, 'Perfara-Portable', 'collector', 'resources', 'app.asar'),
    ]
    import shutil
    for t in targets:
        if os.path.exists(os.path.dirname(t)):
            shutil.copyfile(dest, t)
            print(f'已部署 -> {t}')


if __name__ == '__main__':
    main()
