"""最小可用的 asar 读写工具（不依赖 node）。

用法：
    python asar_tool.py list  <app.asar> [关键词]
    python asar_tool.py extract <app.asar> <内部路径> <输出文件>
    python asar_tool.py extract-all <app.asar> <输出目录>
    python asar_tool.py pack <源目录> <输出.asar>
"""
import json
import os
import struct
import sys


def read_header(path):
    with open(path, "rb") as f:
        head = f.read(16)
        # 布局：[u32 4][u32 8+L][u32 4+L][u32 L][json(L)][data...]
        header_size = struct.unpack("<I", head[4:8])[0]
        f.seek(16)
        raw = f.read(max(0, header_size - 8))
    return json.loads(raw.rstrip(b"\x00").decode("utf-8")), 8 + header_size


def walk(node, prefix="", out=None):
    if out is None:
        out = []
    for name, meta in (node.get("files") or {}).items():
        p = f"{prefix}/{name}" if prefix else name
        if "files" in meta:
            walk(meta, p, out)
        else:
            out.append((p, meta))
    return out


def extract_one(asar, inner, out_path, data_start=None, header=None):
    if header is None:
        header, data_start = read_header(asar)
    entries = dict(walk(header))
    if inner not in entries:
        raise KeyError(inner)
    meta = entries[inner]
    size = int(meta.get("size", 0))
    off = data_start + int(meta.get("offset", 0))
    with open(asar, "rb") as f:
        f.seek(off)
        data = f.read(size)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(data)
    return out_path


def extract_all(asar, out_dir):
    header, data_start = read_header(asar)
    entries = walk(header)
    with open(asar, "rb") as f:
        for p, meta in entries:
            if meta.get("unpacked"):
                continue
            size = int(meta.get("size", 0))
            off = data_start + int(meta.get("offset", 0))
            dst = os.path.join(out_dir, *p.split("/"))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            f.seek(off)
            data = f.read(size)
            with open(dst, "wb") as g:
                g.write(data)
    return len(entries)


def pack(src_dir, out_asar):
    """把目录打包成 asar（offset 顺序分配）。"""
    files = {}
    blobs = []
    offset = 0
    for root, _dirs, names in os.walk(src_dir):
        names.sort()
        for n in sorted(names):
            full = os.path.join(root, n)
            rel = os.path.relpath(full, src_dir).replace("\\", "/")
            size = os.path.getsize(full)
            node = files
            parts = rel.split("/")
            for part in parts[:-1]:
                node = node.setdefault(part, {"files": {}})["files"]
            node[parts[-1]] = {"size": size, "offset": str(offset)}
            offset += size
            blobs.append(full)

    header = {"files": files}
    js = json.dumps(header, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    L = len(js)
    # 与 Electron asar 一致：[u32 4][u32 8+L][u32 4+L][u32 L][json][files...]
    with open(out_asar, "wb") as f:
        f.write(struct.pack("<I", 4))
        f.write(struct.pack("<I", 8 + L))
        f.write(struct.pack("<I", 4 + L))
        f.write(struct.pack("<I", L))
        f.write(js)
        for b in blobs:
            with open(b, "rb") as g:
                while True:
                    chunk = g.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
    return out_asar


def main():
    cmd = sys.argv[1]
    if cmd == "list":
        header, data_start = read_header(sys.argv[2])
        kw = sys.argv[3].lower() if len(sys.argv) > 3 else ""
        entries = walk(header)
        print(f"data_start={data_start} files={len(entries)}")
        for p, meta in entries:
            if not kw or kw in p.lower():
                print(f"{int(meta.get('size', 0)):>12}  {p}")
    elif cmd == "extract":
        print(extract_one(sys.argv[2], sys.argv[3], sys.argv[4]))
    elif cmd == "extract-all":
        print("files:", extract_all(sys.argv[2], sys.argv[3]))
    elif cmd == "pack":
        print(pack(sys.argv[2], sys.argv[3]))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
