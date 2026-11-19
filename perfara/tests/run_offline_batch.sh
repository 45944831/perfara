#!/bin/bash
# 批量运行离线测试套件（不含真机、不含需外部服务的）
_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$_HERE/env.sh"          # S-09：项目根 / NODE / PY 统一在此解析（原来三套脚本各写一份）
OUT=perfara/tests/_run_out
mkdir -p "$OUT"
# ⚠️ 变量名不能叫 TMP：系统已导出 TMP=<用户 Temp 目录>，重新赋值会保留 export 属性，
#    子进程（尤其 adb）会把 TMP 当目录用而失败。用全新名字。
RUNLOG="$(mktemp)"
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
  ( cd perfara/tests && "$NODE" "$@" > "$RUNLOG" 2>&1 )
  local code=$?
  tail -25 "$RUNLOG"
  _emit "$name" "$code"
  sleep 1
}

run_py() {
  local name="$1"; shift
  echo "============================================================"
  echo ">>> [$name]"
  echo "============================================================"
  "$PY" "$@" > "$RUNLOG" 2>&1
  local code=$?
  tail -25 "$RUNLOG"
  _emit "$name" "$code"
  sleep 1
}

# 用**内置** python 跑：iOS 采集脚本依赖包内的 ios_device，系统 python 没有
run_bundled() {
  local name="$1"; shift
  echo "============================================================"
  echo ">>> [$name] (bundled python)"
  echo "============================================================"
  "perfara/collector/resources/ios-tools/python/python/python.exe" "$@" > "$RUNLOG" 2>&1
  local code=$?
  tail -30 "$RUNLOG"
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
# 报告页深色主题配色守卫：会话级指标/卡顿归因/取证片段三区块的浅底浅字回归（2026-11-17 截图 bug）
run_node "report_theme"         e2e_metric_config/run_report_theme_test.js
# 报告页口径提示守卫：schemaVersion=8 无「当前为 2」误报（2026-11-17 截图 bug）
run_node "schema_notice"        e2e_metric_config/run_schema_notice_test.js
run_node "library"              e2e_metric_config/run_library_test.js
run_node "collector_pages"      e2e_metric_config/run_collector_pages_test.js
run_node "metric_order"         e2e_metric_config/run_metric_order_test.js
run_node "foreground_app"       foreground_app_test.js
run_node "foreground_app_ui"    foreground_app_ui_test.js
run_node "adb_server_cleanup"   adb_server_cleanup_test.js
# 采集口径三件套（离线，纯函数 + 源码断言）：
#   thermal_source   温度分层 / 单位换算
#   perf_param_audit 算法算错（comm 错位、热插拔、GPU 累计、滚动窗口）
#   perf_source_audit 采集源本身（错采 / 漏采 / 重复采集）
run_node "thermal_source"       realdevice/thermal_source_test.js
run_node "perf_param_audit"     realdevice/perf_param_audit_test.js
run_node "perf_source_audit"    realdevice/perf_source_audit_test.js
run_node "chart_scroll_perf"    realdevice/chart_scroll_perf_test.js
run_node "version_scheme"       version_scheme_test.js
run_node "metric_schema"        metric_schema_test.js
run_node "pc_script_source"     pc_script_source_test.js
run_node "frame_metrics"        frame_metrics_test.js
run_node "accuracy_fixes"       accuracy_fixes_test.js
# 时间基准守卫：速率类 dt 必须走单调时钟（墙钟回拨会把读数放大 2~10 倍）。
# 漏登记过一次，导致这批断言只在手工跑时生效。
run_node "clock_base"           clock_base_test.js
run_node "round2_fixes"         round2_fixes_test.js
run_node "overhead_history"     overhead_history_test.js
# P1 采集参数优化：GPU 通道无节点降频（连续 null 后 1/20 探测，恢复即全速）
run_node "gpu_channel_throttle" gpu_channel_throttle_test.js
# P2a 采集参数优化：mem 重通道超时熔断（1200ms 预算，超时回退缓存 PSS + lite）
run_node "mem_channel_timeout"  mem_channel_timeout_test.js
run_node "update_check"         update_check_test.js
run_node "update_notice_ui"     update_notice_ui_test.js
run_node "metric_info"          e2e_metric_config/run_metric_info_test.js
run_node "open_location"        e2e_metric_config/run_open_location_test.js
run_node "check_readability"    e2e_metric_config/check_readability.js
# S-07：这两个此前没登记进任何批处理，等于「写了永远不会被跑」。
# android_start_ux：渲染端「点开始」之后的三类「点了没反应」（playwright + Edge，不需要真机）
run_node "android_start_ux"     e2e_metric_config/run_android_start_ux_test.js
# pc_realdevice：直接驱动内置 Python 采本机进程（12 秒），验字段完整性与「读不到折成 null」
run_node "pc_realdevice"        realdevice/pc_realdevice_test.js

rm -f "$RUNLOG"
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "ALL_OFFLINE_DONE  但有失败: ${FAILED[*]}"
  exit 1
fi
echo "ALL_OFFLINE_DONE  全部通过"
