from sqlalchemy import Column, Integer, String, DateTime, Text, ForeignKey
from sqlalchemy.orm import relationship
from datetime import datetime
from .database import Base


class Project(Base):
    __tablename__ = "projects"
    id = Column(Integer, primary_key=True, index=True)
    package_name = Column(String, index=True, nullable=True)
    app_name = Column(String, index=True, nullable=True)
    display_name = Column(String, index=True, nullable=True)
    platform = Column(String, index=True, nullable=True)  # android, ios, ios_gpu, pc
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)

    test_runs = relationship("TestRun", back_populates="project")


class WebUser(Base):
    """Web 登录用户：uid 与客户端设备 UID 一致，首次成功登录时写入。"""

    __tablename__ = "web_users"
    id = Column(Integer, primary_key=True, index=True)
    uid = Column(String(128), unique=True, index=True, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class TestRun(Base):
    __tablename__ = "test_runs"
    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), index=True)
    category = Column(String, index=True)  # from uploaded json "category"
    content_hash = Column(String, index=True, nullable=True)  # for dedup
    # 上传方 UID（POST /api/upload 的 uid）；列表/详情/去重均只看此字段
    owner_uid = Column(String(128), index=True, nullable=True)
    # 备用字段，仅存储，不参与权限与查询逻辑（不建索引：库里从来没有这两个索引）
    para1 = Column(String(128), nullable=True)
    para2 = Column(String(256), nullable=True)
    started_at = Column(DateTime, index=True)  # parsed from json, or now()
    ended_at = Column(DateTime, nullable=True)
    device = Column(String, nullable=True)  # model/version info, optional
    label = Column(String, nullable=True)  # scenario label or filename

    raw_json = Column(Text, nullable=True)  # store the original payload
    summary = Column(Text, nullable=True)  # compact metrics for list view
    share_md5 = Column(String(32), index=True, nullable=True)  # public link token (random, legacy name)

    project = relationship("Project", back_populates="test_runs")
    metric_blobs = relationship("MetricBlob", back_populates="test_run")


class MetricBlob(Base):
    __tablename__ = "metric_blobs"
    id = Column(Integer, primary_key=True, index=True)
    test_run_id = Column(Integer, ForeignKey("test_runs.id"), index=True)
    # a compact store per time series chunk; keep generic for all categories
    # structure: {"timestamp": [...], "series": {"metric.path": [values...]}, "meta": {...}}
    content = Column(Text, nullable=False)

    test_run = relationship("TestRun", back_populates="metric_blobs")


class ProjectAlias(Base):
    __tablename__ = "project_aliases"
    id = Column(Integer, primary_key=True, index=True)
    # 别名按 UID 隔离：为空的历史行由迁移按同包名测试的 owner 回填，回填不到则不再展示。
    owner_uid = Column(String(128), index=True, nullable=True)
    package_name = Column(String, index=True, nullable=True)
    app_name = Column(String, index=True, nullable=True)
    display_name = Column(String, index=True, nullable=True)


class PerfaraDemoSnapshot(Base):
    """演示 UID perfara123：仅可访问此处登记的 test_run_id；不由应用自动插入新行，需运维手动维护。"""

    __tablename__ = "perfara_demo_snapshot"
    test_run_id = Column(Integer, primary_key=True, index=True)


class ParsedInfo(Base):
    __tablename__ = "parsed_info"
    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, index=True)
    test_run_id = Column(Integer, index=True)
    category = Column(String, index=True)
    device = Column(String, nullable=True)
    package_name = Column(String, nullable=True)
    app_name = Column(String, nullable=True)
    summary_json = Column(Text, nullable=True)  # JSON string snapshot
    created_at = Column(DateTime, default=datetime.utcnow, index=True)

