"""扫描发布 zip 内的文本条目，检查是否残留设备序列号 / 真机型号 / 真实包名。

用法：
    python tools/scan_release_zip.py <a.zip> [b.zip ...]
    python tools/scan_release_zip.py --patterns <模式文件> <a.zip> ...

模式来源见 tools/sensitive_patterns.py（默认读 release/_audit/sensitive_patterns.txt，
该目录已被 gitignore，真实序列号不落库）。只解压体积较小且后缀为文本类的条目，
避免把 200MB+ 的包整体解压。
"""
import os
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sensitive_patterns  # noqa: E402

TEXT_SUFFIX = ('.js', '.json', '.html', '.htm', '.py', '.md', '.txt', '.css',
               '.yml', '.yaml', '.cfg', '.ini', '.log', '.csv')
MAX_BYTES = 6 * 1024 * 1024


def scan(path, patterns):
    hits = {}
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            if info.is_dir() or info.file_size > MAX_BYTES:
                continue
            if not info.filename.lower().endswith(TEXT_SUFFIX):
                continue
            try:
                txt = z.read(info).decode('utf-8', 'ignore')
            except Exception:
                continue
            for label, pat in patterns:
                if pat.search(txt):
                    hits.setdefault(label, []).append(info.filename)
    return hits


def main(argv):
    explicit = None
    if '--patterns' in argv:
        i = argv.index('--patterns')
        explicit = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]

    zips = [a for a in argv if a.lower().endswith('.zip')]
    if not zips:
        print('usage: scan_release_zip.py [--patterns FILE] <a.zip> [...]')
        return 2

    patterns = sensitive_patterns.load(explicit)
    print('使用 %d 条模式\n' % len(patterns))

    dirty = 0
    for path in zips:
        print('=== %s (%d B) ===' % (os.path.basename(path), os.path.getsize(path)))
        hits = scan(path, patterns)
        if not hits:
            print('  CLEAN: 0 命中')
        else:
            dirty += 1
            for label, files in hits.items():
                print('  HIT %s -> %d 文件' % (label, len(files)))
                for f in files[:6]:
                    print('       ', f)
        print()

    print('合计：%d 个包，%d 个有命中' % (len(zips), dirty))
    return 1 if dirty else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
