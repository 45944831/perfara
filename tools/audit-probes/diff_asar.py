import hashlib
import json
import os
import struct

ASAR = r"E:\WorkBuddy1\2026-10-19-13-59-27\perfara\collector\resources\app.asar"
SRC = r"E:\WorkBuddy1\2026-10-19-13-59-27\_client_src\app"

with open(ASAR, "rb") as f:
    data = f.read()

# asar: uint32 4, uint32 header_size_pickle, uint32 header_string_size, uint32 json_len, json
a, b, c, d = struct.unpack("<IIII", data[:16])
header_len = struct.unpack("<I", data[12:16])[0]
header = json.loads(data[16:16 + header_len].decode("utf-8"))
base = 8 + b  # 8-byte size prefix + pickle payload

files = {}


def walk(node, path):
    for name, info in node.get("files", {}).items():
        p = (path + "/" + name).lstrip("/")
        if "files" in info:
            walk(info, p)
        else:
            files[p] = info


walk(header, "")

print("asar entries:", len(files))
missing, diff, same = [], [], 0
for p, info in files.items():
    sp = os.path.join(SRC, p.replace("/", os.sep))
    if not os.path.exists(sp):
        missing.append(p)
        continue
    off = int(info.get("offset", 0))
    size = int(info.get("size", 0))
    blob = data[base + off: base + off + size]
    h = hashlib.sha256(blob).hexdigest()
    lh = hashlib.sha256(open(sp, "rb").read()).hexdigest()
    if h == lh:
        same += 1
    else:
        diff.append(p)

print("identical:", same)
print("missing in source:", len(missing), missing[:10])
print("content differs:", len(diff), diff[:10])

# 反向：源码里有哪些文件没进 asar
src_files = []
for root, dirs, fs in os.walk(SRC):
    rel = os.path.relpath(root, SRC).replace("\\", "/")
    for f in fs:
        src_files.append((rel + "/" + f).lstrip("/") if rel != "." else f)
extra = [p for p in src_files if p not in files]
print("source files not in asar:", len(extra))
for p in extra[:30]:
    print("  -", p)
