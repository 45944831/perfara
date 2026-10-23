#!/bin/bash
# 真机回归：adb.js 的 FPS / jank 口径改动后，跑全部依赖真机的套件
# 用法: bash perfara/tests/run_realdevice_batch.sh <deviceId> [packageName]
#
# 设备 ID 必须显式传入：本文件会进公开仓库，不能把本机设备序列号写成默认值。
# 可选：GAME_PKG=com.xxx.yyy 时额外跑一遍「游戏场景」e2e（游戏包名同理不入库）。
#
# 注意：默认包名用 com.android.chrome —— 脱敏后部分用例的默认值曾是占位包名
# com.example.game，设备上不存在，默认跑法必然「应用未安装」失败。
cd /e/WorkBuddy1/2026-10-19-13-59-27
export NODE_PATH="C:/Users/user/.workbuddy-ai/binaries/node/workspace/node_modules"
NODE="C:/Users/user/.workbuddy-ai/binaries/node/versions/22.22.2-6/node.exe"
D="${1:?用法: run_realdevice_batch.sh <deviceId> [packageName]}"
P="${2:-com.android.chrome}"
OUT=perfara/tests/_run_out
mkdir -p "$OUT"
LOG="$OUT/realdevice_$(date +%Y%m%d-%H%M%S).log"
TMP="$(mktemp)"

# 直接取 node 的退出码：走 `node | tail` 管道时 $? 是 tail 的状态，永远 0
run() {
  local name="$1"; shift
  {
    echo "============================================================"
    echo ">>> [$name]"
    echo "============================================================"
  } | tee -a "$LOG"
  ( cd perfara/tests/realdevice && "$NODE" "$@" > "$TMP" 2>&1 )
  local code=$?
  tail -30 "$TMP" | tee -a "$LOG"
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
run "e2e_browser"       e2e_realdevice.js "$D" com.android.chrome
if [ -n "${GAME_PKG:-}" ]; then
  run "e2e_game"        e2e_realdevice.js "$D" "$GAME_PKG"
else
  echo "    [skip] e2e_game：未设置 GAME_PKG（游戏包名不入库，需现场指定）"
fi

rm -f "$TMP"
echo "ALL_REALDEVICE_DONE  log=$LOG"
