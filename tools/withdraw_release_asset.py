"""下架指定 Release 的下载资产：先备份元数据，再删资产，最后在正文顶部加下架说明。

用法：
    python tools/withdraw_release_asset.py <token> v2026.10.21 v2026.10.20

设计要点：
- 先落备份（release JSON 含资产 id / size / digest），需要恢复时有据可查；
- 正文说明幂等：已含标记就不重复插入，只把旧标记段剥掉重写；
- 只删资产，不删 Release、不删 tag —— 变更说明保留作记录。
"""
import json
import os
import ssl
import sys
import urllib.request

REPO = '45944831/perfara'
API = 'https://api.github.com/repos/' + REPO
NEW_TAG = 'v2026.10.23'
MARK = '本版本的下载包已下架'
CTX = ssl._create_unverified_context()


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


def note_block():
    return (
        '> **⚠️ 本版本的下载包已下架**\n'
        '>\n'
        '> 该版打包文件内含未脱敏的示例数据（真实设备序列号、机型与应用包名），为免继续分发，已删除压缩包资产。\n'
        '> 请改用 **%s**：https://github.com/%s/releases/tag/%s\n'
        '> 本页变更说明保留，仅作记录。\n\n---\n\n' % (NEW_TAG, REPO, NEW_TAG)
    )


def strip_old_note(body):
    if MARK in body:
        idx = body.find('---\n\n')
        if idx >= 0:
            return body[idx + len('---\n\n'):]
    return body


def main():
    token = sys.argv[1]
    tags = sys.argv[2:]
    if not tags:
        print('usage: withdraw_release_asset.py <token> <tag> [tag...]')
        return 1

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

        body = strip_old_note(rel.get('body') or '')
        st, upd = call(API + '/releases/%d' % rel['id'], token, method='PATCH',
                       payload={'body': note_block() + body})
        print('  正文更新 -> HTTP %s, 剩余资产 %d' % (st, len(upd.get('assets') or [])))
        print()

    return 0


if __name__ == '__main__':
    sys.exit(main())
