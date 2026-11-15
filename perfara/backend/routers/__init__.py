"""按 domain 拆分的 APIRouter 集合。

``app.py`` 只负责创建 app、注册中间件与 include_router；各路由的路径、
HTTP 方法、响应模型、状态码、鉴权依赖与原单体逐字一致。
include 顺序由 ``app.py`` 固定，务必保持（尤其 /api/tests/distinct-* 必须
先于 /api/tests/{test_id} 注册，SPA fallback 必须最后）。
"""
