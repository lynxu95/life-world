#!/bin/bash
# 关掉带调试口开起来的那个浏览器实例。
#
# 只认「正在监听这个端口的进程」，而且命令行里必须带 --remote-debugging-port=<端口>
# ——避免把正连着调试口的 CDP 客户端、或用户自己占着这个端口的别的服务一起杀掉。
# 不碰用户自己平时开着的、没带调试口的浏览器。
set -u
PORT="${1:-9222}"

# lsof 不加 -sTCP:LISTEN 会把「对端端口是 PORT」的连接也列出来
LISTENERS=""
if command -v lsof >/dev/null 2>&1; then
  LISTENERS="$(lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null | head -5)"
fi

killed=0
if [ -n "$LISTENERS" ]; then
  for p in $LISTENERS; do
    CMD="$(ps -p "$p" -o command= 2>/dev/null || true)"
    case "$CMD" in
      # 端口后面必须是空白或结尾，别把 9222 误配成 92220
      *"--remote-debugging-port=${PORT} "*|*"--remote-debugging-port=${PORT}") kill "$p" 2>/dev/null && killed=1 ;;
      *) echo "跳过 PID ${p}（不是带调试口起的浏览器：${CMD:0:80}）" ;;
    esac
  done
else
  # 退回去按启动参数匹配；带上边界，9222 不能顺带命中 92220
  pkill -f -- "--remote-debugging-port=${PORT}([[:space:]]|$)" 2>/dev/null && killed=1
fi

sleep 1
if curl -s -m 1 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  echo "还在跑（可能不是用 browser-open.sh 起的？调试口 ${PORT} 仍有响应）"
  exit 1
else
  [ "$killed" = "1" ] && echo "关掉了" || echo "没有找到这个调试口的浏览器（可能本来就没开）"
fi
