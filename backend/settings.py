from functools import lru_cache
import os
try:
    from pydantic_settings import BaseSettings  # pydantic v2
except Exception:
    from pydantic import BaseSettings  # fallback for v1

from .paths import resource, user_data

# 打包后 chart-configs 随只读资源一起解包；源码运行时即 backend/chart-configs。
_cfg_dir = resource("backend", "chart-configs")
if not _cfg_dir.is_dir():
    _cfg_dir = user_data("backend", "chart-configs")
CONFIGS_DIR = str(_cfg_dir)
try:
    os.makedirs(CONFIGS_DIR, exist_ok=True)
except OSError:
    pass


class Settings(BaseSettings):
    """保留 session_secret 仅兼容旧环境变量；当前 API 不再使用 Session。"""

    session_secret: str = "dev-webperf-session-change-me"

    class Config:
        env_prefix = "WEBPERF_"


@lru_cache()
def get_settings() -> Settings:
    return Settings()

