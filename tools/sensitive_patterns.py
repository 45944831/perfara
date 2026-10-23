"""敏感串模式定义。放在 release/ 下（已被 gitignore），不进版本库。

格式：每行 `标签<TAB>正则`，# 开头为注释，空行忽略。
新增要核查的内容（新机型、新包名等）直接追加行即可，脚本无需改动。
"""
import os
import re

# 默认位置：release/_audit/sensitive_patterns.txt（release/ 不入库）
DEFAULT_PATHS = (
    os.path.join('release', '_audit', 'sensitive_patterns.txt'),
    os.path.join('..', 'release', '_audit', 'sensitive_patterns.txt'),
)

# 兜底通用规则：不依赖任何具体值，用于模式文件缺失时仍能抓到明显泄漏
GENERIC = (
    ('疑似设备序列号（14 位以上大写字母数字）', r'\b[A-Z0-9]{14,}\b'),
    ('非示例包名（排除 com.example / com.android）',
     r'\bcom\.(?!example\.|android\.)[a-z0-9_]+\.[a-z0-9_.]+\b'),
)


def load(explicit=None):
    """返回 [(标签, 编译后的正则), ...]。"""
    paths = (explicit,) if explicit else DEFAULT_PATHS
    for p in paths:
        if p and os.path.isfile(p):
            out = []
            with open(p, encoding='utf-8') as f:
                for line in f:
                    line = line.rstrip('\n')
                    if not line.strip() or line.lstrip().startswith('#'):
                        continue
                    if '\t' not in line:
                        continue
                    label, pat = line.split('\t', 1)
                    out.append((label.strip(), re.compile(pat.strip())))
            if out:
                return out
    return [(label, re.compile(pat)) for label, pat in GENERIC]
