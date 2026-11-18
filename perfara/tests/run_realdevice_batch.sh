#!/bin/bash
# 真机回归：adb.js 的 FPS / jank 口径改动后，跑全部依赖真机的套件
# 用法: bash perfara/tests/run_realdevice_batch.sh <deviceId> [packageName]
#
# 设备 ID 必须显式传入：本文件会进公开仓库，不能把本机设备序列号写成默认值。
# 可选：GAME_PKG=com.xxx.yyy 时额外跑一遍「游戏场景」e2e（游戏包名同理不入库）。
#
# 注意：默认包名用 com.android.chrome —— 脱敏后部分用例的默认值曾是占位包名
# com.example.game，设备上不存在，默认跑法必然「应用未安装」失败。
_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$_HERE/env.sh"          # S-09：项目根 / NODE / PY 统一在此解析（原来三套脚本各写一份）
D="${1:?用法: run_realdevice_batch.sh <deviceId> [packageName]}"
P="${2:-com.android.chrome}"
OUT=perfara/tests/_run_out
mkdir -p "$OUT"
LOG="$OUT/realdevice_$(date +%Y%m%d-%H%M%S).log"
# ⚠️ 变量名不能叫 TMP：系统已导出 TMP=<用户 Temp 目录>，bash 给「已导出的同名变量」
#    重新赋值会保留 export 属性，子进程 adb 会把 TMP 当成目录在里面建 adb.log，
#    而 mktemp 建的是文件 → `cannot open ...\adb.log` → adb server 起不来。
#    之前没暴露，是因为 server 一直在跑；被 kill 后测试才触发。
RUNLOG="$(mktemp)"

# 直接取 node 的退出码：走 `node | tail` 管道时 $? 是 tail 的状态，永远 0
run() {
  local name="$1"; shift
  {
    echo "============================================================"
    echo ">>> [$name]"
    echo "============================================================"
  } | tee -a "$LOG"
  ( cd perfara/tests/realdevice && "$NODE" "$@" > "$RUNLOG" 2>&1 )
  local code=$?
  tail -30 "$RUNLOG" | tee -a "$LOG"
  echo "    [exit=$code]" | tee -a "$LOG"
  sleep 1
}

run "jank_algo"         jank_algo_test.js
run "probe_adb"         probe_adb.js "$D"
run "walkthrough_s1"    realdevice_walkthrough_s1.js "$D"
run "walkthrough_s2"    realdevice_walkthrough_s2.js "$D" "$P"
run "walkthrough_s3"    realdevice_walkthrough_s3.js "$D" "$P"
run "fps_render"        fps_render_test.js "$D"
run "tinyjank"          tinyjank_framestats_test.js "$D"
run "preflight_real"    preflight_real_test.js "$D"
run "preflight_breaker" preflight_breaker_test.js
run "trace_capture"     trace_capture_realdevice.js "$D"
run "new_metrics"       new_metrics_realdevice.js "$D" "$P"
run "net_scope"         net_scope_realdevice.js "$D" "$P"
run "trough_overrun"    trough_overrun_realdevice.js "$D" "$P"
run "trough_shot"       trough_shot_realdevice.js "$D" "$P" 45
run "e2e_browser"       e2e_realdevice.js "$D" com.android.chrome
# S-07：第二轮修复（FIX-11/13/14）的真机验收，此前没登记进任何批处理。
# 它直接驱动**源码**的 adb.js（不是 app.asar），所以能证明修复在真机上真的生效。
run "round2_realdevice" round2_realdevice.js "$D" "$P"
# 弱网 USB 接管专项：会真的改手机系统代理并起拔线守护，串号只从环境变量进。
# 未设置 PERFARA_TEST_SERIAL 时跳过（不能拿本机序列号当默认值，本文件会进公开仓库）。
if [ -n "${PERFARA_TEST_SERIAL:-}" ]; then
  # 弱网 USB 接管专项从 PERFARA_PKG_ROOT（解包后的当前交付包）取采集端；
  # 不设时脚本会回退到写死的旧包路径（已被清理 → ENOENT）。透传为 PERFARA_RD_ROOT。
  if [ -n "${PERFARA_PKG_ROOT:-}" ]; then
    export PERFARA_RD_ROOT="$PERFARA_PKG_ROOT/collector"
    run "weaknet_phone" weaknet_phone_realdevice.js
  else
    echo "    [skip] weaknet_phone：未设置 PERFARA_PKG_ROOT（脚本默认指向的旧包已清理，需先解包当前交付包）"
  fi
else
  echo "    [skip] weaknet_phone：未设置 PERFARA_TEST_SERIAL（串号不入库，需现场指定）"
fi
# 真包参数准确性：启动解包后的 collector，用 adb 独立基准核对 FPS/CPU/PSS/刷新率。
# 需要先解包发布包并指定 PERFARA_PKG_ROOT（未指定时跳过，默认批处理仍只跑源码侧）。
# 2026-11-15 首次跑出 2 项红：D-19 刷新率取错字段、D-20 data.js 缺 loading 段。
if [ -n "${PERFARA_PKG_ROOT:-}" ]; then
  # run() 会 cd 到 perfara/tests/realdevice，相对路径在那里解析不到 → 统一转绝对路径。
  # 不转的话 param_accuracy_pkg 的 existsSync(ROOT/collector/Perfara.exe) 会失败、
  # 回退到 ROOT 本身去找 Perfara.exe（那是启动器不是采集端）→ 误报包不完整。
  case "$PERFARA_PKG_ROOT" in
    /*|[A-Za-z]:/*) PKG_ROOT_ABS="$PERFARA_PKG_ROOT" ;;
    *)               PKG_ROOT_ABS="$PROJ/$PERFARA_PKG_ROOT" ;;
  esac
  PERFARA_PKG_ROOT="$PKG_ROOT_ABS" run "param_accuracy_pkg" param_accuracy_pkg.js "$D" "$P" 60
else
  echo "    [skip] param_accuracy_pkg：未设置 PERFARA_PKG_ROOT（先解包发布包再跑）"
fi
if [ -n "${GAME_PKG:-}" ]; then
  run "e2e_game"        e2e_realdevice.js "$D" "$GAME_PKG"
else
  echo "    [skip] e2e_game：未设置 GAME_PKG（游戏包名不入库，需现场指定）"
fi

rm -f "$RUNLOG"
echo "ALL_REALDEVICE_DONE  log=$LOG"
