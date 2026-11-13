#!/bin/bash
# life-world 启动脚本（Linux）
#
#   bash ~/.local/share/life-world/bin/start-linux.sh          # 起：看板 + tmux 里的 QQ 桥接与家会话
#   bash ~/.local/share/life-world/bin/start-linux.sh --stop   # 停
#
# 不注册任何开机项：重启之后自己跑一下这条就行，脚本本身不碰系统配置。
set -u

ROOT="${LIFE_WORLD_ROOT:-$HOME/.local/share/life-world}"

node_ok() { # 版本 ≥ 22.13 才算合格（记忆索引要 node:sqlite）
  local v major rest minor
  v="$("$1" -v 2>/dev/null | sed 's/^v//')"
  [ -n "$v" ] || return 1
  major="${v%%.*}"; rest="${v#*.}"; minor="${rest%%.*}"
  [ "${major:-0}" -gt 22 ] || { [ "${major:-0}" -eq 22 ] && [ "${minor:-0}" -ge 13 ]; }
}

pick_node() {
  local c first=""
  for c in "$(command -v node 2>/dev/null || true)" \
           "$HOME/.local/bin/node" "$HOME/.pi/agent/bin/node" \
           /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node \
           "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    [ -n "$first" ] || first="$c"
    if node_ok "$c"; then echo "$c"; return 0; fi
  done
  # 没有达标的：退回第一个能跑的，外面会提示版本偏低
  [ -n "$first" ] && { echo "$first"; return 0; }
  return 1
}

NODE="${LIFE_WORLD_NODE:-}"
if [ -n "$NODE" ]; then
  case "$NODE" in
    /*) ;;
    *) NODE="$(command -v "$NODE" 2>/dev/null || true)" ;;
  esac
  if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
    echo "✗ LIFE_WORLD_NODE 指向的 node 不可用：${LIFE_WORLD_NODE}" >&2
    exit 1
  fi
else
  NODE="$(pick_node)"
fi
if [ -z "$NODE" ]; then
  echo "✗ 找不到 node；装好 Node 22.13+，或用 LIFE_WORLD_NODE=/绝对路径/node 指定" >&2
  exit 1
fi
# 一律用绝对路径：相对路径会把当前目录塞进 PATH
case "$NODE" in /*) ;; *) NODE="$(cd "$(dirname "$NODE")" && pwd)/$(basename "$NODE")" ;; esac
node_ok "$NODE" || echo "⚠ 当前 node 版本偏低（$("$NODE" -v 2>/dev/null)）：记忆索引 / 星图会用不了，建议升到 22.13+"

# 常驻脚本要用的目录：node、pi、tmux 都可能在用户目录里
export PATH="$(dirname "$NODE"):$HOME/.local/bin:$HOME/.pi/agent/bin:/usr/local/bin:$PATH"
export TZ="${TZ:-Asia/Shanghai}"
export LIFE_WORLD_ROOT="$ROOT"

if [ "${1:-}" = "--stop" ]; then
  "$NODE" "$ROOT/bin/lwctl" board stop 2>/dev/null || true
  if command -v tmux >/dev/null 2>&1; then tmux kill-session -t '=life-world' 2>/dev/null && echo "已停 tmux 会话 life-world"; fi
  exit 0
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "· 没装 tmux：只起看板，QQ 桥接和家会话起不来（sudo apt install tmux）"
fi

echo "[$(date '+%F %T')] life-world 启动（Linux）：$ROOT"
rc=0
"$NODE" "$ROOT/bin/lwctl" board start || { echo "⚠ 看板没起来（不影响 QQ / 家会话）"; rc=1; }
"$NODE" "$ROOT/bin/lwctl" restart all || { echo "⚠ 常驻窗口没起来：检查 tmux 是否装了、pi 是否在 PATH"; rc=1; }
exit "$rc"
