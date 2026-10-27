from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, declarative_base
import os
import sqlite3

from .paths import ensure_data_dir

# 打包后默认落在 exe 同级的 data/ 下，源码运行时为项目根的 data/。
DB_PATH = os.environ.get("WEB_PERF_DB") or str(ensure_data_dir() / "webperf.db")
DB_PATH = os.path.abspath(DB_PATH)
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

SQLALCHEMY_DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


@event.listens_for(engine, "connect")
def _sqlite_pragma(dbapi_conn, _connection_record):
    """每条连接建立时下发 PRAGMA。

    默认 journal_mode=DELETE + synchronous=FULL 时，每次上传都要等 fsync，
    且采集端上传与看板轮询并发时容易 `database is locked`。
    WAL 让读写互不阻塞，NORMAL 只对 checkpoint 做同步，busy_timeout 给出重试窗口。
    """
    try:
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.execute("PRAGMA temp_store=MEMORY")
        cur.close()
    except Exception:
        # PRAGMA 失败不应阻塞连接（只读介质 / 老版本 sqlite 等极端情况）
        pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def ensure_sqlite_migrations():
    """
    Minimal auto-migration for SQLite in dev:
    - Add 'content_hash' and 'summary' columns to 'test_runs' if missing.
    - Create 'perfara_demo_snapshot' / 'parsed_info' if missing（演示快照不自动从 test_runs 灌数据）.
    """
    try:
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        cur.execute("PRAGMA table_info(test_runs)")
        cols = [row[1] for row in cur.fetchall()]
        if "content_hash" not in cols:
            cur.execute("ALTER TABLE test_runs ADD COLUMN content_hash TEXT")
        if "summary" not in cols:
            cur.execute("ALTER TABLE test_runs ADD COLUMN summary TEXT")
        if "para1" not in cols:
            cur.execute("ALTER TABLE test_runs ADD COLUMN para1 TEXT")
        if "para2" not in cols:
            cur.execute("ALTER TABLE test_runs ADD COLUMN para2 TEXT")
        if "share_md5" not in cols:
            cur.execute("ALTER TABLE test_runs ADD COLUMN share_md5 TEXT")
            try:
                cur.execute("CREATE INDEX IF NOT EXISTS ix_test_runs_share_md5 ON test_runs (share_md5)")
            except Exception:
                pass
        if "owner_uid" not in cols:
            cur.execute("ALTER TABLE test_runs ADD COLUMN owner_uid TEXT")
            try:
                cur.execute("CREATE INDEX IF NOT EXISTS ix_test_runs_owner_uid ON test_runs (owner_uid)")
            except Exception:
                pass
            # 历史数据：原将 UID 存在 para1，迁移到 owner_uid
            try:
                cur.execute(
                    "UPDATE test_runs SET owner_uid = para1 WHERE owner_uid IS NULL AND para1 IS NOT NULL AND trim(para1) != ''"
                )
            except Exception:
                pass
        # backfill share_md5 for existing rows (md5(str(id)))
        # 原写法是 `if "share_md5" in cols or True:` —— 条件恒真，导致每次启动都把
        # 整张表读进内存再逐行跳过（`SELECT id, share_md5 FROM test_runs` 无 WHERE）。
        # 本函数在模块导入时执行，库大了就是可感知的启动开销。
        # 现在只在真有缺失行时才动手，且由 SQL 负责筛选。
        try:
            import hashlib
            cur.execute(
                "SELECT id FROM test_runs WHERE share_md5 IS NULL OR share_md5 = ''"
            )
            missing = cur.fetchall()
            for (rid,) in missing:
                token = hashlib.md5(str(rid).encode("utf-8")).hexdigest()
                cur.execute("UPDATE test_runs SET share_md5=? WHERE id=?", (token, rid))
        except Exception:
            pass
        try:
            cur.execute("DROP INDEX IF EXISTS uq_project_content_hash")
        except Exception:
            pass
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='web_users'")
        if not cur.fetchone():
            cur.execute(
                """
                CREATE TABLE web_users (
                    id INTEGER PRIMARY KEY,
                    uid TEXT UNIQUE NOT NULL,
                    created_at TEXT,
                    updated_at TEXT
                )
                """
            )
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='perfara_demo_snapshot'")
        if not cur.fetchone():
            cur.execute("CREATE TABLE perfara_demo_snapshot (test_run_id INTEGER PRIMARY KEY)")
        # perfara123 仅可读此表中的 test_run_id；不在迁移里从 test_runs 自动灌入，避免新数据进入演示快照。
        # 固定演示集由运维手动 INSERT；库内已有行始终保留。
        # parsed_info
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='parsed_info'")
        if not cur.fetchone():
            cur.execute(
                """
                CREATE TABLE parsed_info (
                    id INTEGER PRIMARY KEY,
                    project_id INTEGER,
                    test_run_id INTEGER,
                    category TEXT,
                    device TEXT,
                    package_name TEXT,
                    app_name TEXT,
                    summary_json TEXT,
                    created_at TEXT
                )
                """
            )
        conn.commit()
        conn.close()
    except Exception:
        # Best-effort, ignore if fails
        pass

ensure_sqlite_migrations()

