#!/usr/bin/env python3
"""
单命令启动前后端（同端口）：python /绝对路径/web-perf/serve.py

FastAPI 需要 ASGI 服务；本脚本在进程内调用 uvicorn.run，无需在命令行单独输入 uvicorn。
工作目录、数据库路径均默认按本文件所在项目根目录解析为绝对路径。
（兼容 Python 3.6+。）
"""
import os
import sys
import asyncio
from pathlib import Path

# Python 3.6 无 asyncio.run（3.7+ 才有），uvicorn 会调用；最小兼容（长期仍建议 Python 3.8+）
if sys.version_info < (3, 7) and not hasattr(asyncio, "run"):

    def _asyncio_run(coro):
        loop = asyncio.get_event_loop()
        return loop.run_until_complete(coro)

    asyncio.run = _asyncio_run

# 项目根目录（本文件所在目录的绝对路径）
ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# 数据库：未设置环境变量时使用 <根>/data/webperf.db
_db = os.environ.get("WEB_PERF_DB")
if not _db:
    os.environ["WEB_PERF_DB"] = str(ROOT / "data" / "webperf.db")


def main() -> None:
    host = os.environ.get("WEBPERF_HOST", "0.0.0.0")
    port = int(os.environ.get("WEBPERF_PORT", "8000"))

    import uvicorn

    print(f"ROOT={ROOT}", flush=True)
    print(f"WEB_PERF_DB={os.environ['WEB_PERF_DB']}", flush=True)
    print(f"listen http://{host}:{port}/", flush=True)

    uvicorn.run(
        "backend.app:app",
        host=host,
        port=port,
        workers=1,
        reload=False,
    )


if __name__ == "__main__":
    main()
