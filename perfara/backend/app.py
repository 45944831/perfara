"""FastAPI 应用入口：app 创建、中间件、异常处理器、router 注册、
静态资源挂载与 SPA fallback。

业务路由按 domain 拆到 ``routers/`` 包（见 ``routers/__init__.py``）。拆分后
所有路由路径、HTTP 方法、响应模型、状态码、鉴权依赖逐字不变；include_router
顺序固定，尤其 SPA fallback 必须最后注册。
"""
import os
import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles

from .database import Base, engine
from .paths import APP_ROOT, resource
from .version import __version__
from .logging_setup import setup_logging

from .routers._common import _cors_allow_origins
from .routers import health, upload, projects, tests, aliases, chart_configs, admin


# Initialize logging to <可写目录>/logs/app.log（打包后即 exe 同级的 logs/）
_log_file = setup_logging(str(APP_ROOT))
logging.getLogger(__name__).info("Logging initialized at %s", _log_file)

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Web Performance Dashboard API", version=__version__)


# SQLite INTEGER 为有符号 64 位；超过 2**63-1 的 Python int 传给 SQLite 会抛
# OverflowError（此前未加约束时会以 500 泄漏给客户端）。路径/查询里的整型 id
# 一律用 le=_MAX_SQLITE_INT 约束；此全局处理器作为兜底，任何漏网的超大整数
# 也返回 400 而不是 500。
@app.exception_handler(OverflowError)
async def _overflow_error_handler(request: Request, exc: OverflowError):
    return JSONResponse(
        status_code=400,
        content={"detail": "integer parameter out of range"},
    )


app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_allow_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 响应压缩：首屏 JS 1.35MB → 约 451KB，列表 JSON 约 -80%。
# 本机访问收益有限，但 --host 0.0.0.0 局域网部署时差别明显；
# minimum_size 过滤掉小响应，已压缩资源（png/zip）不会被重复压缩。
app.add_middleware(GZipMiddleware, minimum_size=1024)


# ── router 注册（顺序与原单体一致，勿调整）────────────────────────────────────
# /api/tests/distinct-* 必须早于 /api/tests/{test_id}；SPA fallback 必须最后。
app.include_router(health.router)
app.include_router(upload.router)
app.include_router(projects.router)
app.include_router(tests.router)
app.include_router(aliases.router)
app.include_router(chart_configs.router)
app.include_router(admin.router)
app.include_router(projects.router_info)

# NOTE: Frontend static mounting is moved to the bottom of this file,
# after all API routes are registered, to avoid 404/405 on /api/*.

# Frontend static + SPA fallback (so /tests?testid=... works when pasted).
# 打包后前端产物位于只读资源目录，源码运行时为项目根的 frontend/dist。
FRONTEND_DIST = str(resource("frontend", "dist"))
FRONTEND_INDEX = os.path.join(FRONTEND_DIST, "index.html")
PERFARA_AD_DIR = str(resource("perfara-ad"))

try:
    if os.path.isdir(PERFARA_AD_DIR):
        app.mount("/ads", StaticFiles(directory=PERFARA_AD_DIR, html=True), name="perfara_ad")
except Exception as _mount_err:
    logging.getLogger(__name__).exception("Mount perfara-ad /ads failed: %s", _mount_err)

# Windows 注册表可能把 .js 映射为 text/plain（部分机器 HKCU\SOFTWARE\Classes\.js 被改写），
# 导致浏览器拒绝执行 <script type="module">，SPA 白屏。挂载前显式修正关键 MIME。
try:
    import mimetypes as _mimetypes
    _mimetypes.add_type("text/javascript", ".js")
    _mimetypes.add_type("text/javascript", ".mjs")
    _mimetypes.add_type("application/wasm", ".wasm")
    _mimetypes.add_type("image/svg+xml", ".svg")
except Exception as _mime_err:
    logging.getLogger(__name__).exception("Fix MIME types failed: %s", _mime_err)

try:
    if os.path.exists(os.path.join(FRONTEND_DIST, "assets")):
        class _ImmutableAssets(StaticFiles):
            """Vite 产物名带内容哈希，可长期缓存。"""

            async def get_response(self, path, scope):
                resp = await super().get_response(path, scope)
                resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
                return resp

        app.mount(
            "/assets",
            _ImmutableAssets(directory=os.path.join(FRONTEND_DIST, "assets")),
            name="assets",
        )
except Exception as _mount_err:
    logging.getLogger(__name__).exception("Mount assets failed: %s", _mount_err)


def _static_response(path: str) -> FileResponse:
    # index.html 必须每次回源（否则发版后仍跑旧 JS）；其余文件（favicon 等）名字无哈希，短缓存。
    resp = FileResponse(path)
    if os.path.abspath(path) == os.path.abspath(FRONTEND_INDEX):
        resp.headers["Cache-Control"] = "no-cache"
    else:
        resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


@app.get("/{full_path:path}", include_in_schema=False)
def spa_fallback(full_path: str):
    # Never hijack API routes or /ads (served by StaticFiles mount)
    if full_path.startswith("api"):
        raise HTTPException(status_code=404, detail="Not Found")
    if full_path == "ads" or full_path.startswith("ads/"):
        raise HTTPException(status_code=404, detail="Not Found")
    # Serve real file if exists (e.g. favicon.ico)
    try:
        dist_root = os.path.abspath(FRONTEND_DIST)
        cand = os.path.abspath(os.path.join(dist_root, full_path))
        # 必须落在 dist 目录**内**：startswith(dist) 会把同层的 dist_backup/、dist-old/
        # 也算进来，那些非发布目录里的文件会被当静态资源发出去。
        in_dist = cand == dist_root or cand.startswith(dist_root + os.sep)
        if in_dist and os.path.isfile(cand):
            return _static_response(cand)
    except Exception:
        pass
    # SPA fallback to index.html
    if os.path.exists(FRONTEND_INDEX):
        return _static_response(FRONTEND_INDEX)
    raise HTTPException(status_code=404, detail="Not Found")
