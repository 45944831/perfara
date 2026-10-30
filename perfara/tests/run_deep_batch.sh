#!/bin/bash
# 批量运行深度测试套件（perfara/tests/deep/）。
#
# 退出码是这个脚本过去最大的坑：`"$PY" … | tail -25` 之后 `echo "[exit=$?]"` 读到的
# 是 tail 的状态，tail 永远成功，于是所有套件都打印 exit=0，「deep 全绿」并不成立。
# 现在统一开 pipefail、用 rc 变量接住真实退出码，末尾汇总并以非零码收尾。
cd /e/WorkBuddy1/2026-10-19-13-59-27 || exit 2
set -o pipefail
export NODE_PATH="C:/Users/user/.workbuddy/binaries/node/workspace/node_modules"
export no_proxy="127.0.0.1,localhost" NO_PROXY="127.0.0.1,localhost"
export PYTHONIOENCODING=utf-8
NODE="C:/Users/user/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
PY="E:/WorkBuddy1/2026-10-19-13-59-27/tools/.venv/Scripts/python.exe"   # 带 sqlalchemy/uvicorn
OUT=perfara/tests/_run_out
mkdir -p "$OUT"

SUMMARY=()
FAIL_NAMES=()

report() {
  local name="$1" rc="$2"
  SUMMARY+=("$(printf '%-24s exit=%s' "$name" "$rc")")
  if [ "$rc" -ne 0 ]; then FAIL_NAMES+=("$name"); fi
}

run_node() {
  local name="$1"; shift
  echo "============================================================"
  echo ">>> [$name]"
  echo "============================================================"
  local rc=0
  ( cd perfara/tests/deep && "$NODE" "$@" 2>&1 | tail -30 ) || rc=$?
  echo "    [exit=$rc]"
  report "$name" "$rc"
  sleep 1
}

run_py() {
  local name="$1"; shift
  echo "============================================================"
  echo ">>> [$name]"
  echo "============================================================"
  local rc=0
  "$PY" "$@" 2>&1 | tail -30 || rc=$?
  echo "    [exit=$rc]"
  report "$name" "$rc"
  sleep 1
}

run_py   "launcher_process"     perfara/tests/deep/launcher_process_test.py
run_py   "launcher_port"        perfara/tests/deep/launcher_port_test.py
run_py   "loading_algo"         perfara/tests/deep/loading_algo_consistency.py
run_node "report_edge"          ../deep/report_edge_test.js
run_py   "upload_edge"          perfara/tests/deep/upload_edge_test.py
run_node "compare_lanes"        ../deep/compare_lanes_test.js
run_node "trough_shots"         ../deep/trough_shots_test.js
run_node "trough_shots_ui"      ../deep/trough_shots_ui_test.js
# 弱网总结分析：段状态机 + 接线静态检查；再用合成 data.weaknet 渲染报告页核对数值
run_node "weaknet_report"       ../deep/weaknet_report_test.js
run_node "weaknet_report_ui"    ../deep/weaknet_report_ui_test.js
# 弱网二级界面：host 用真引擎（需 PERFARA_WEAKNET_SRC 指向 WeakNet 源码，未设则只跑接线检查）；
# 页面用 Playwright + 假 perfAPI，不依赖 Electron
run_node "weaknet_host"         ../deep/weaknet_host_test.js
run_node "weaknet_page_ui"      ../deep/weaknet_page_ui_test.js
# 手机 USB 接管：adb reverse + 写手机系统代理，用假 runner 跑成功/被拒/回滚各分支
run_node "phone_proxy"          ../deep/phone_proxy_test.js
# 系统代理残留：开启前快照、崩溃后还原（内存注册表替身，不碰本机设置）
run_node "sysproxy_residue"     ../deep/sysproxy_residue_test.js
# 应用桌面名：合成 AXML/ARSC 验证解析与缓存重试；界面用假 perfAPI 验证渐进更新与排序
run_node "app_labels"           ../deep/app_labels_test.js
run_node "app_labels_ui"        ../deep/app_labels_ui_test.js
run_node "pc_launch_injection"  ../deep/pc_launch_injection_test.js
# 种子库体检：默认模式会真跑 exe（慢），批量里只查仓库内的种子库；
# exe 内嵌种子库由 tools/scan_seed_db.py 作为发布门禁单独把关。
run_py   "seed_integrity"       perfara/tests/deep/seed_integrity_test.py --src
# XSS 探测：上传恶意字段 → 看板/单文件报告渲染，网络可达路径必须安全（本地报告库只记 RISK）
run_node "xss_deep"             ../deep/xss_deep_test.js
# 接口深度用例与看板实时端到端：需要起临时服务，放最后避免相互占端口
run_py   "api_deep"             perfara/tests/deep/api_deep_test.py
run_node "spa_live_e2e"         ../deep/spa_live_e2e_test.js

echo
echo "==================== 汇总 ===================="
for line in "${SUMMARY[@]}"; do echo "  $line"; done
if [ ${#FAIL_NAMES[@]} -gt 0 ]; then
  echo "--------------------------------------------"
  echo "失败 ${#FAIL_NAMES[@]}/${#SUMMARY[@]}: ${FAIL_NAMES[*]}"
  echo "DEEP_BATCH_FAILED"
  exit 1
fi
echo "全部 ${#SUMMARY[@]} 套通过"
echo "ALL_DEEP_DONE"
exit 0
