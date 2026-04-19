from functools import lru_cache
import os
try:
    from pydantic_settings import BaseSettings  # pydantic v2
except Exception:
    from pydantic import BaseSettings  # fallback for v1

CONFIGS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "chart-configs"))
os.makedirs(CONFIGS_DIR, exist_ok=True)


class Settings(BaseSettings):
    """保留 session_secret 仅兼容旧环境变量；当前 API 不再使用 Session。"""

    session_secret: str = "dev-webperf-session-change-me"

    class Config:
        env_prefix = "WEBPERF_"


@lru_cache()
def get_settings() -> Settings:
    return Settings()

