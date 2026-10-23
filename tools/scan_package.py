"""发布包泄漏审计：zip 内文本条目 + 内嵌 app.asar 全量扫描。

为什么需要单独一个脚本：
  `scan_release_zip.py` 只扫文本后缀，`app.asar` 是二进制容器会被跳过 ——
  而前端/主进程代码全在 asar 里，恰恰是最该查的地方（v2026.10.22 的
  reports/history 泄漏就发生在 asar 内）。

用法：
    python tools/scan_package.py <包.zip> [更多.zip ...]
    python tools/scan_package.py --patterns <模式文件> <包.zip>

退出码：0 = 干净；1 = 有命中；2 = 参数错误。
"""
import io
import os
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sensitive_patterns  # noqa: E402
import asar_tool  # noqa: E402

TEXT_SUFFIX = ('.js', '.json', '.html', '.htm', '.py', '.md', '.txt', '.css',
               '.yml', '.yaml', '.cfg', '.ini', '.log', '.csv', '.sh', '.bat', '.spec')
MAX_BYTES = 8 * 1024 * 1024


def scan_text(text, patterns):
    hits = []
    for label, pat in patterns:
        if pat.search(text):
            hits.append(label)
    return hits


def scan_zip_entry(zf, info, patterns, out):
    if info.is_dir() or info.file_size > MAX_BYTES:
        return
    if not info.filename.lower().endswith(TEXT_SUFFIX):
        return
    try:
        txt = zf.read(info).decode('utf-8', 'ignore')
    except Exception:
        return
    for label in scan_text(txt, patterns):
        out.setdefault(label, []).append(info.filename)


def scan_asar(path, patterns, out, prefix):
    """解包 asar 到临时目录后逐文件扫（asar 是 JSON 头 + 拼接内容，不能直接正则）。"""
    tmp = tempfile.mkdtemp(prefix='pf-asar-scan-')
    try:
        asar_tool.extract_all(path, tmp)
    except Exception as e:
        out.setdefault('__asar_extract_error__', []).append('%r' % (e,))
        return
    for root, _dirs, files in os.walk(tmp):
        for fn in files:
            fp = os.path.join(root, fn)
            rel = os.path.relpath(fp, tmp).replace('\\', '/')
            try:
                if os.path.getsize(fp) > MAX_BYTES:
                    continue
                with open(fp, 'rb') as f:
                    txt = f.read().decode('utf-8', 'ignore')
            except Exception:
                continue
            for label in scan_text(txt, patterns):
                out.setdefault(label, []).append('%s!%s' % (prefix, rel))


def scan_package(path, patterns):
    out = {}
    with zipfile.ZipFile(path) as zf:
        for info in zf.infolist():
            scan_zip_entry(zf, info, patterns, out)
            if info.filename.lower().endswith('.asar'):
                # 从 zip 里取出 asar 再解
                tmpd = tempfile.mkdtemp(prefix='pf-asar-')
                ap = os.path.join(tmpd, os.path.basename(info.filename))
                with open(ap, 'wb') as f:
                    f.write(zf.read(info))
                scan_asar(ap, patterns, out, info.filename)
    return out


def main(argv):
    explicit = None
    if '--patterns' in argv:
        i = argv.index('--patterns')
        explicit = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    zips = [a for a in argv if a.lower().endswith('.zip')]
    if not zips:
        print('usage: scan_package.py [--patterns FILE] <a.zip> [...]')
        return 2

    patterns = sensitive_patterns.load(explicit)
    print('使用 %d 条模式\n' % len(patterns))

    dirty = 0
    for path in zips:
        print('=== %s (%d B) ===' % (os.path.basename(path), os.path.getsize(path)))
        hits = scan_package(path, patterns)
        if not hits:
            print('  CLEAN: 0 命中（含 asar 全量）')
        else:
            dirty += 1
            for label, files in hits.items():
                print('  HIT %s -> %d 处' % (label, len(files)))
                for f in files[:8]:
                    print('       ', f)
        print()

    print('合计：%d 个包，%d 个有命中' % (len(zips), dirty))
    return 1 if dirty else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
