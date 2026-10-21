#!/bin/bash
# 批量运行深度测试套件（perfara/tests/deep/）：启动器 / 算法一致性 / 报告边界 / 上传畸形 / 对比泳道
cd /e/WorkBuddy1/2026-10-19-13-59-27
export NODE_PATH="C:/Users/user/.workbuddy/binaries/node/workspace/node_modules"
export no_proxy="127.0.0.1,localhost" NO_PROXY="127.0.0.1,localhost"
NODE="C:/Users/user/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
PY="E:/WorkBuddy1/2026-10-19-13-59-27/tools/.venv/Scripts/python.exe"   # 带 sqlalchemy/uvicorn
OUT=perfara/tests/_run_out
mkdir -p "$OUT"

run_node() {
  local name="$1"; shift
  echo "============================================================"
  echo ">>> [$name]"
  echo "============================================================"
  ( cd perfara/tests/deep && "$NODE" "$@" 2>&1 | tail -25 )
  echo "    [exit=$?]"
  sleep 1
}

run_py() {
  local name="$1"; shift
  echo "============================================================"
  echo ">>> [$name]"
  echo "============================================================"
  "$PY" "$@" 2>&1 | tail -25
  echo "    [exit=$?]"
  sleep 1
}

run_py   "launcher_process"     perfara/tests/deep/launcher_process_test.py
run_py   "loading_algo"         perfara/tests/deep/loading_algo_consistency.py
run_node "report_edge"          ../deep/report_edge_test.js
run_py   "upload_edge"          perfara/tests/deep/upload_edge_test.py
run_node "compare_lanes"        ../deep/compare_lanes_test.js

echo "ALL_DEEP_DONE"
