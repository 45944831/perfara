#!/bin/bash
# 测试套件的公共环境（S-09）
#
# 背景：run_offline / run_deep / run_realdevice 三套批处理此前各写一份 Node 路径，
# 且分处 ~/.workbuddy 与 ~/.workbuddy-ai 两处安装。换机、升级 Node/Python 时只要
# 改漏一处就会有一套跑不起来，而 run_realdevice 那套要连真机才暴露，最难排查。
# 现在统一在这里解析，脚本开头 `. "$HERE/env.sh"` 即可。
#
# 解析顺序：~/.workbuddy 优先（主安装），再试 ~/.workbuddy-ai；
# 同目录下多个版本时取版本号最大的那个（sort -V）。
#
# 导出：PROJ（项目根，并已 cd 过去）、NODE、NODE_PATH、PY、PY_VENV

_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ="$(cd "$_HERE/../.." && pwd)"
cd "$PROJ" || { echo "env.sh: 进不去项目根 $PROJ" >&2; return 2 2>/dev/null || exit 2; }

# Git Bash 里 $HOME 是 /c/Users/xxx 形式，而 node.exe / python.exe 是原生 Windows
# 程序，NODE_PATH 这类环境变量不会做路径转换，必须喂 C:/... 形式。
if command -v cygpath >/dev/null 2>&1; then
  _HOME_WIN="$(cygpath -m "$HOME")"
else
  _HOME_WIN="$HOME"
fi

# 在某一类 binaries 下取版本号最大的可执行文件。
# 成功后设置 _RES_EXE（完整路径）与 _RES_BASE（安装根），供调用方取同根的其他路径。
_resolve() {
  local kind="$1" exe="$2" base d
  for base in "$_HOME_WIN/.workbuddy" "$_HOME_WIN/.workbuddy-ai"; do
    [ -d "$base/binaries/$kind/versions" ] || continue
    d="$(ls -1 "$base/binaries/$kind/versions" 2>/dev/null \
         | grep -E '^[0-9]' | sort -V | tail -1)"
    if [ -n "$d" ] && [ -x "$base/binaries/$kind/versions/$d/$exe" ]; then
      _RES_EXE="$base/binaries/$kind/versions/$d/$exe"
      _RES_BASE="$base"
      return 0
    fi
  done
  return 1
}

if _resolve node node.exe; then
  NODE="$_RES_EXE"
  NODE_PATH="$_RES_BASE/binaries/node/workspace/node_modules"
else
  NODE="$(command -v node)"
  NODE_PATH=""
fi

if _resolve python python.exe; then
  PY="$_RES_EXE"
else
  PY="$(command -v python)"
fi

# 深度测试需要 sqlalchemy/uvicorn，用项目内的 venv；缺失时退回系统 Python
# （此时 deep 里依赖后端的用例会失败，属预期）。
PY_VENV="$PROJ/tools/.venv/Scripts/python.exe"
[ -x "$PY_VENV" ] || PY_VENV="$PY"
# 脚本里常把它拼进 `cd xxx && "$PY_VENV" ...` 之类的位置，统一换成 C:/ 形式，
# 免得「有时能跑、有时报 No such file」全看当时的工作目录。
if command -v cygpath >/dev/null 2>&1; then
  PY_VENV="$(cygpath -m "$PY_VENV")"
fi

export NODE NODE_PATH PY PY_VENV PROJ
export PYTHONIOENCODING=utf-8
# 本机自测全是 127.0.0.1，别让系统代理把它们劫走。
export no_proxy="127.0.0.1,localhost" NO_PROXY="127.0.0.1,localhost"

# 自检：路径存在性直接报出来，省得被测脚本跑到一半才说「找不到 node」。
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "env.sh: 找不到 node.exe（试过 ~/.workbuddy 与 ~/.workbuddy-ai）" >&2
fi
if [ -z "$PY" ] || [ ! -x "$PY" ]; then
  echo "env.sh: 找不到 python.exe（试过 ~/.workbuddy 与 ~/.workbuddy-ai）" >&2
fi
