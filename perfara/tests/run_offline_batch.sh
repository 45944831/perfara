#!/bin/bash
# 批量运行离线测试套件（不含真机、不含需外部服务的）
cd /e/WorkBuddy1/2026-10-19-13-59-27
export NODE_PATH="C:/Users/user/.workbuddy/binaries/node/workspace/node_modules"
NODE="C:/Users/user/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
PY="C:/Users/user/.workbuddy/binaries/python/versions/3.13.12/python.exe"
OUT=perfara/tests/_run_out
mkdir -p "$OUT"
TMP="$(mktemp)"
FAILED=()

# ⚠️ 退出码必须直接取被测进程的：写成 `cmd | tail` 再取 $? 拿到的是 tail 的状态，
#    永远 0 —— 之前整套批量「全绿」其实可能是假的。
_emit() {
  local name="$1" code="$2"
  echo "    [exit=$code]"
  [ "$code" -ne 0 ] && FAILED+=("$name(exit=$code)")
  return 0
}

run_node() {
  local name="$1"; shift
  echo "============================================================"
  echo ">>> [$name]"
  echo "============================================================"
  ( cd perfara/tests && "$NODE" "$@" > "$TMP" 2>&1 )
  local code=$?
  tail -25 "$TMP"
  _emit "$name" "$code"
  sleep 1
}

run_py() {
  local name="$1"; shift
  echo "============================================================"
  echo ">>> [$name]"
  echo "============================================================"
  "$PY" "$@" > "$TMP" 2>&1
  local code=$?
  tail -25 "$TMP"
  _emit "$name" "$code"
  sleep 1
}

# 用**内置** python 跑：iOS 采集脚本依赖包内的 ios_device，系统 python 没有
run_bundled() {
  local name="$1"; shift
  echo "============================================================"
  echo ">>> [$name] (bundled python)"
  echo "============================================================"
  "perfara/collector/resources/ios-tools/python/python/python.exe" "$@" > "$TMP" 2>&1
  local code=$?
  tail -30 "$TMP"
  _emit "$name" "$code"
  sleep 1
}

run_node "jank_algo"            realdevice/jank_algo_test.js
run_bundled "fps_no_data"       perfara/tests/test_fps_no_data.py
run_node "lazy_module"          realdevice/lazy_module_test.js
run_node "metric_group"         realdevice/metric_group_consistency.js
run_node "serialize_bench"      realdevice/report_serialize_bench.js
run_node "dedupe_metrics"       realdevice/dedupe_metrics_test.js
run_node "compare_report"       realdevice/compare_report_test.js
run_node "shared_report"        realdevice/shared_report_test.js
run_node "chart_perf_bench"     realdevice/chart_perf_bench.js
run_node "fps_legend_overlap"   realdevice/fps_legend_overlap_test.js
run_node "perf_html"            e2e_metric_config/run_perf_html_test.js
run_node "library"              e2e_metric_config/run_library_test.js
run_node "collector_pages"      e2e_metric_config/run_collector_pages_test.js
run_node "metric_info"          e2e_metric_config/run_metric_info_test.js
run_node "open_location"        e2e_metric_config/run_open_location_test.js
run_node "check_readability"    e2e_metric_config/check_readability.js

rm -f "$TMP"
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "ALL_OFFLINE_DONE  但有失败: ${FAILED[*]}"
  exit 1
fi
echo "ALL_OFFLINE_DONE  全部通过"
