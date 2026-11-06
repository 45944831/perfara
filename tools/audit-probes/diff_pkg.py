import os
import zipfile
import zlib

ZIP = r"E:\WorkBuddy1\2026-10-19-13-59-27\release\交付_20261029\Perfara_Portable_20261029_r10.zip"
SRC = r"E:\WorkBuddy1\2026-10-19-13-59-27\perfara"
SKIP_TOP = {"dist", "_seed", "client-patch", "tests", "__pycache__", ".venv"}

zi = zipfile.ZipFile(ZIP)
zent = {i.filename: (i.file_size, i.CRC) for i in zi.infolist() if not i.is_dir()}

local = {}
for root, dirs, files in os.walk(SRC):
    rel = os.path.relpath(root, SRC).replace("\\", "/")
    if rel == ".":
        dirs[:] = [d for d in dirs if d not in SKIP_TOP]
        rel = ""
    for f in files:
        p = os.path.join(root, f)
        r = (rel + "/" + f).lstrip("/")
        local[r] = p


def crc(p):
    c = 0
    with open(p, "rb") as fh:
        for b in iter(lambda: fh.read(1 << 20), b""):
            c = zlib.crc32(b, c)
    return c & 0xFFFFFFFF


only_zip = [n for n in zent if n not in local]
only_local = [n for n in local if n not in zent]
diff = []
for n in zent:
    if n in local:
        s, c = zent[n]
        if os.path.getsize(local[n]) != s or crc(local[n]) != c:
            diff.append(n)

print("zip-only:", len(only_zip))
for n in only_zip[:25]:
    print("  +", n)
print("local-only:", len(only_local))
for n in only_local[:25]:
    print("  -", n)
print("content-diff:", len(diff))
for n in diff[:25]:
    print("  *", n)
