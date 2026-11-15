#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""列出 JS 里的空 catch（`catch (_) {}` 这类），并区分「带注释」与「裸吞」。

背景（S-05）：全项目 150 处空 catch，绝大多数是 `try { child.kill() } catch (_) {}`
这类 best-effort 清理，模式本身没问题；问题在于**没有注释**——读代码的人分不清
「这里失败无所谓」和「这里失败被静默了」。

用法：
  python tools/scan_empty_catch.py            # 汇总（按文件）
  python tools/scan_empty_catch.py --list     # 逐条列出
  python tools/scan_empty_catch.py --budget   # 只输出每个文件的计数，供测试比对

退出码：始终 0（这是扫描工具，不是门禁；门禁见
perfara/tests/deep/empty_catch_budget_test.js）。
"""
import argparse
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCAN_DIRS = [
    '_client_src/app/src',
    '_client_src/app/renderer',
    '_client_src/app',
]
SCAN_EXTRA = ['main.js', 'preload.js']

# 空 catch 的几种写法：
#   catch (_) {}
#   catch (e) { }
#   catch { }                      （可选 catch 绑定，ES2019）
#   catch (_) { /* 注释 */ }        → 带注释，算「已说明」
RE_EMPTY = re.compile(
    r'catch\s*(?:\([^)]*\))?\s*\{\s*(?P<body>[^{}]*?)\s*\}', re.S)


def iter_files():
    seen = set()
    for d in SCAN_DIRS:
        full = os.path.join(ROOT, d)
        if not os.path.isdir(full):
            continue
        for name in sorted(os.listdir(full)):
            if not name.endswith('.js'):
                continue
            # 必须 normpath：SCAN_DIRS 里的 '_client_src/app' 与下面 SCAN_EXTRA 拼出来的
            # '_client_src\\app\\main.js' 分隔符不同，不归一化会把 main.js 数两遍。
            p = os.path.normpath(os.path.join(full, name))
            if p in seen or not os.path.isfile(p):
                continue
            seen.add(p)
            yield p
    for name in SCAN_EXTRA:
        p = os.path.normpath(os.path.join(ROOT, '_client_src', 'app', name))
        if os.path.isfile(p) and p not in seen:
            seen.add(p)
            yield p


def blank_noncode(src):
    """把注释替换成等长空格（保留换行与全部偏移）。

    不这么做的话，注释里写的 `` `catch (_) {}` `` 会被正则当成真代码统计进去——
    本文件的说明性注释里就有，一加注释计数反而上涨。偏移保持不变，行号才对得上。

    只处理注释，**不碰字符串字面量**：JS 的正则字面量（如 /['"]/g）里带引号，
    按字符串规则去置空会把后面的整段代码一起吃掉，反而漏统计。
    """
    out = list(src)
    i, n = 0, len(src)

    def wipe(a, b):
        for k in range(a, min(b, n)):
            if out[k] != '\n':
                out[k] = ' '

    while i < n:
        c = src[i]
        if c == '/' and i + 1 < n and src[i + 1] == '/':
            j = src.find('\n', i)
            j = n if j < 0 else j
            wipe(i, j)
            i = j
        elif c == '/' and i + 1 < n and src[i + 1] == '*':
            j = src.find('*/', i + 2)
            j = n if j < 0 else j + 2
            wipe(i, j)
            i = j
        else:
            i += 1
    return ''.join(out)


def _documented(src, start, end):
    """空 catch 的「已说明」判定：块内注释 / 同行前后注释 / 紧邻上一行注释。

    只看块内会把两种常见写法误判成裸吞：`// 归档失败不能影响主流程` 写在 try 前一行，
    以及 `try {...} catch (_) {}   // 同上` 写在行尾。都被判成裸吞，反而逼人去加重复注释。
    """
    line_start = src.rfind('\n', 0, start) + 1
    before = src[line_start:start]
    if '//' in before or '/*' in before:
        return True
    line_end = src.find('\n', end)
    after = src[end:] if line_end < 0 else src[end:line_end]
    if '//' in after or '/*' in after:
        return True
    # 往上找最近的非空行
    pos = line_start
    for _ in range(4):
        if pos <= 0:
            break
        prev_end = pos - 1
        prev_start = src.rfind('\n', 0, prev_end) + 1
        prev = src[prev_start:prev_end].strip()
        pos = prev_start
        if not prev:
            continue
        return prev.startswith('//') or prev.startswith('/*') or prev.startswith('*')
    return False


def scan(path):
    with open(path, encoding='utf-8', errors='replace') as f:
        src = f.read()
    code = blank_noncode(src)
    out = []
    for m in RE_EMPTY.finditer(code):
        body = m.group('body').strip()
        # 只留「真空白」或「仅注释」（注释在 code 里已被置空，故只剩空白一种）
        if body:
            continue
        line = src[:m.start()].count('\n') + 1
        out.append({
            'line': line,
            'commented': _documented(src, m.start(), m.end()),
            'text': '',
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--budget', action='store_true')
    args = ap.parse_args()

    total = 0
    commented = 0
    per_file = {}
    for p in iter_files():
        hits = scan(p)
        if not hits:
            continue
        rel = os.path.relpath(p, ROOT).replace('\\', '/')
        per_file[rel] = len(hits)
        total += len(hits)
        commented += sum(1 for h in hits if h['commented'])
        if args.list:
            for h in hits:
                mark = '注释' if h['commented'] else '裸吞'
                print('%s:%d  [%s]' % (rel, h['line'], mark))
                if h['text']:
                    print('    %s' % h['text'])

    if args.budget:
        print(json.dumps(per_file, indent=2, sort_keys=True, ensure_ascii=False))
        return 0

    if not args.list:
        print('%-46s %6s' % ('文件', '空catch'))
        print('-' * 56)
        for rel, n in sorted(per_file.items(), key=lambda kv: -kv[1]):
            print('%-46s %6d' % (rel, n))
    print('-' * 56)
    print('合计 %d 处，其中带注释 %d 处，裸吞 %d 处，涉及 %d 个文件'
          % (total, commented, total - commented, len(per_file)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
