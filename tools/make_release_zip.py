"""把构建产物打成 zip。

用法：
    python make_release_zip.py changes <源目录> <输出.zip>   # 只打改动文件
    python make_release_zip.py full    <源目录> <输出.zip>   # 打完整便携版（较大，建议后台跑）
"""
import os
import sys
import time
import zipfile

# 完整便携版里这些是运行期产生的日志/缓存，不进发布包
SKIP_SUFFIX = {'.log', '.tmp'}
SKIP_DIR = {'logs', 'crashDumps'}


def add(zf, src, mode):
    n = 0
    total = 0
    for root, dirs, files in os.walk(src):
        if mode == 'full':
            dirs[:] = [d for d in dirs if d not in SKIP_DIR]
        for f in sorted(files):
            if mode == 'full' and os.path.splitext(f)[1].lower() in SKIP_SUFFIX:
                continue
            full = os.path.join(root, f)
            rel = os.path.relpath(full, src)
            try:
                zf.write(full, rel.replace('\\', '/'), zipfile.ZIP_DEFLATED)
                n += 1
                total += os.path.getsize(full)
            except OSError as e:
                print('  跳过（被占用）:', rel, e)
    return n, total


def main():
    mode = sys.argv[1]
    src = sys.argv[2]
    out = sys.argv[3]
    t0 = time.time()
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        n, total = add(zf, src, mode)
    size = os.path.getsize(out)
    print(f'打包完成: {out}')
    print(f'  文件 {n} 个，原始 {total/1048576:.1f}MB -> 压缩后 {size/1048576:.1f}MB '
          f'(压缩率 {(1 - size / max(total, 1)) * 100:.0f}%)，耗时 {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
