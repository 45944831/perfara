"""下架指定 Release 的下载资产：先备份元数据，再删资产，最后在正文顶部加下架说明。

用法：
    python tools/withdraw_release_asset.py <token> v2026.10.21 v2026.10.20
    python tools/withdraw_release_asset.py <token> --reason stale v2026.10.23

--reason 决定下架说明的措辞：
    leak （默认）包里含未脱敏的真实数据（序列号 / 机型 / 包名），为免继续分发而下架
    db           误打包开发期测试数据库（含设备 UDID、测试用户名），同上
    stale        包本身干净，但已被更新版本取代（缺关键修复），避免用户下到旧逻辑

设计要点：
- 先落备份（release JSON 含资产 id / size / digest），需要恢复时有据可查；
- 正文说明幂等：不认标记串，按结构剥掉顶部通告区再重写。
  历史上有两种写法（本脚本写的、早期手写的），都长成「连续 > 行 → 空行 → ---」，
  所以按结构剥比按标记串剥可靠 —— 旧版只认标记串，遇到手写通告会叠成两段；
- 通告里的「请改用」指针统一指向 NEW_TAG。已被取代的版本若仍指向另一个同样下架的
  版本，用户点过去就是死路，必须一并纠正；
- 只删资产，不删 Release、不删 tag —— 变更说明保留作记录。
"""
import json
import os
import ssl
import sys
import urllib.request

REPO = '45944831/perfara'
API = 'https://api.github.com/repos/' + REPO
NEW_TAG = 'v2026.10.27'
CTX = ssl._create_unverified_context()

REASONS = {
    'leak': '该版打包文件内含未脱敏的真实数据（设备序列号 / 机型 / 应用包名等），为免继续分发，已删除压缩包资产。',
    'db': '该版误打包了开发期测试数据库 `data/webperf.db`（含测试项目、设备 UDID 与测试用户名），为免继续分发，已删除压缩包资产。',
    'stale': '该版已被后续修复版取代（缺少卡顿分级口径与 iOS/PC 无帧数据的修复），为避免用户下到旧逻辑，已删除压缩包资产。',
}


def call(url, token, method='GET', payload=None):
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Authorization', 'token ' + token)
    req.add_header('Accept', 'application/vnd.github+json')
    if data:
        req.add_header('Content-Type', 'application/json; charset=utf-8')
    with urllib.request.urlopen(req, timeout=90, context=CTX) as r:
        body = r.read()
        return r.status, (json.loads(body) if body else None)


def note_block(reason='leak'):
    return (
        '> **⚠️ 本版本的下载包已下架**\n'
        '>\n'
        '> %s\n'
        '> 请改用 **%s**：https://github.com/%s/releases/tag/%s\n'
        '> 本页变更说明保留，仅作记录。正文中「资产说明 / 校验 / 点下方资产下载」等段落\n'
        '> 均为发布当时的记录，对应压缩包已删除，不可再下载。\n\n---\n\n'
        % (REASONS.get(reason, REASONS['leak']), NEW_TAG, REPO, NEW_TAG)
    )


def strip_leading_note(body):
    """剥掉正文顶部的下架通告区，返回真正的变更说明。

    通告区形态固定：开头若干 `>` 行（中间可能夹空行），随后一条 `---` 分隔线。
    不认具体标记串 —— 早期手写的通告措辞不同，按串匹配会漏掉，导致新旧两段叠在一起。
    只有在确认「顶部确实是 > 开头的引用块」且「其后找到 --- 分隔线」时才裁剪；
    否则原样返回，避免误删正文。
    """
    lines = body.split('\n')
    seen_quote = False
    for idx, line in enumerate(lines):
        s = line.strip()
        if not s:
            continue
        if s.startswith('>'):
            seen_quote = True
            continue
        if seen_quote and len(s) >= 3 and not s.strip('-'):
            return '\n'.join(lines[idx + 1:]).lstrip('\n')
        # 引用块里冒出正文：说明没有分隔线，结构不可信，不动
        break
    return body


def main():
    argv = sys.argv[1:]
    if not argv:
        print('usage: withdraw_release_asset.py <token> [--reason leak|stale] <tag> [tag...]')
        return 1
    reason = 'leak'
    if '--reason' in argv:
        i = argv.index('--reason')
        if i + 1 >= len(argv):
            print('--reason 后面要跟措辞：%s' % ' / '.join(REASONS))
            return 1
        reason = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    if reason not in REASONS:
        print('未知措辞 %r，可选：%s' % (reason, ' / '.join(REASONS)))
        return 1
    token = argv[0]
    tags = argv[1:]
    if not tags:
        print('usage: withdraw_release_asset.py <token> [--reason leak|stale] <tag> [tag...]')
        return 1
    print('下架说明措辞: %s\n' % reason)

    outdir = os.path.join('release', '交付_20261022', '_github_backup')
    os.makedirs(outdir, exist_ok=True)

    for tag in tags:
        status, rel = call(API + '/releases/tags/' + tag, token)
        print('=== %s (release id=%s, assets=%d) ===' % (tag, rel['id'], len(rel['assets'])))

        backup = os.path.join(outdir, 'release_%s.json' % tag)
        json.dump(rel, open(backup, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        print('  备份: %s (%d B)' % (backup, os.path.getsize(backup)))

        for a in rel['assets']:
            st, _ = call(API + '/releases/assets/%d' % a['id'], token, method='DELETE')
            print('  删除资产 %s (id=%d, %d B, %s) -> HTTP %s'
                  % (a['name'], a['id'], a['size'], a.get('digest'), st))

        body = strip_leading_note(rel.get('body') or '')
        st, upd = call(API + '/releases/%d' % rel['id'], token, method='PATCH',
                       payload={'body': note_block(reason) + body})
        print('  正文更新 -> HTTP %s, 剩余资产 %d' % (st, len(upd.get('assets') or [])))
        print()

    return 0


if __name__ == '__main__':
    sys.exit(main())
