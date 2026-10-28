#!/bin/bash
# 起一个隔离的临时库服务（8019），跑 test_api_full.py，跑完自动收
set -uo pipefail
cd /e/WorkBuddy1/2026-10-19-13-59-27

PY="E:/WorkBuddy1/2026-10-19-13-59-27/tools/.venv/Scripts/python.exe"
export no_proxy="127.0.0.1,localhost"
export NO_PROXY="127.0.0.1,localhost"

TMPDB=$(mktemp -d)/webperf.db
cp perfara/data/webperf.db "$TMPDB"
echo "[临时库] $TMPDB"

export WEB_PERF_DB="$TMPDB"
export PERFARA_HOME="$(dirname "$TMPDB")"

# 后台起服务（必须在 perfara/ 目录下才能 import backend）
# server_header=False 与 launcher.py 保持一致，否则这里测出来的响应头和真实启动不一样
( cd perfara && "$PY" -c "
import uvicorn, sys
from backend.app import app
uvicorn.run(app, host='127.0.0.1', port=8019, log_level='warning', server_header=False)
" ) > perfara/tests/_run_out/svc_8019.log 2>&1 &
SVC=$!
echo "[服务] pid=$SVC"

# 等就绪
for i in $(seq 1 40); do
  if curl -s --max-time 2 -o /dev/null "http://127.0.0.1:8019/api/health"; then
    echo "[就绪] ${i} 次探测后成功"; break
  fi
  sleep 0.5
done

echo "============================================================"
echo ">>> [test_api_full]"
echo "============================================================"
$PY perfara/tests/test_api_full.py 2>&1 | tail -40
echo "    [exit=$?]"

kill $SVC 2>/dev/null
wait $SVC 2>/dev/null
echo "[服务已停止]"
echo "ALL_API_DONE"
