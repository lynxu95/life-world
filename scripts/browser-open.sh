#!/bin/bash
# 开一个带调试口的 Chrome，用对方平时那份资料与登录状态。
#
#   bash browser-open.sh [端口]        默认 9222
#   LIFE_WORLD_CHROME_PROFILE=/…/dir   指定资料目录
#   CHROME_BIN=/…/chrome               指定浏览器可执行文件
#
# 这是一个**示例脚本**：Chrome 在各系统里的位置、启动方式、能不能从当前环境
# 访问到调试口都不一样。脚本会先探测本机，探测不到就直说「这台机器没有可用的
# 调试口方案」并退出——浏览器不是主功能，AI 可以照着下面几种写法改成适合本机的版本。
set -u

PORT="${1:-9222}"
ENDPOINT="http://127.0.0.1:${PORT}/json/version"
OS="$(uname -s)"

if curl -s -m 2 "$ENDPOINT" >/dev/null 2>&1; then
  echo "已经开着了：http://127.0.0.1:${PORT}"
  exit 0
fi

say_ok() {
  echo "开好了：http://127.0.0.1:${PORT}"
  echo "看标签页：curl -s http://127.0.0.1:${PORT}/json/list"
  echo "开新页：curl -X PUT \"http://127.0.0.1:${PORT}/json/new?url=https://example.com\""
}

wait_port() {
  local i
  for i in $(seq 1 30); do
    sleep 0.5
    if curl -s -m 1 "$ENDPOINT" >/dev/null 2>&1; then say_ok; return 0; fi
  done
  return 1
}

case "$OS" in
  Darwin)
    # macOS：Chrome 就在 .app 里，不需要 X11；资料目录用 Application Support
    BIN="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
    PROFILE="${LIFE_WORLD_CHROME_PROFILE:-$HOME/Library/Application Support/google-chrome-agent}"
    if [ ! -x "$BIN" ]; then
      echo "✗ 没找到 Chrome（${BIN}）"
      echo "  装了别的 Chromium 系浏览器就指一下：CHROME_BIN=/Applications/Chromium.app/Contents/MacOS/Chromium bash $0"
      echo "  这台机器没有可用的调试口方案，浏览器功能跳过。"
      exit 1
    fi
    nohup "$BIN" \
      --remote-debugging-port="$PORT" \
      --user-data-dir="$PROFILE" \
      --no-first-run --no-default-browser-check \
      >/tmp/life-world-chrome.log 2>&1 &
    ;;

  Linux)
    if grep -qi microsoft /proc/version 2>/dev/null; then
      # WSL：自己没有图形浏览器，只能去拉 Windows 那个 Chrome；
      # 它的调试口只绑 Windows 的 127.0.0.1，WSL 里默认连不上，需要端口转发。
      WIN_CHROME="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
      if [ ! -x "$WIN_CHROME" ]; then
        WIN_CHROME="/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
      fi
      if [ ! -x "$WIN_CHROME" ]; then
        echo "✗ WSL 里没找到 Windows 的 Chrome"
        echo "  这台机器没有可用的调试口方案，浏览器功能跳过。"
        exit 1
      fi
      "$WIN_CHROME" --remote-debugging-port="$PORT" --user-data-dir='C:\chrome-agent' \
        --no-first-run --no-default-browser-check >/dev/null 2>&1 &
      sleep 2
      echo "· 已在 Windows 侧启动 Chrome（调试口 ${PORT}）"
      echo "· WSL 默认连不到 Windows 的 127.0.0.1。两种办法："
      echo "  a) 开了「镜像网络模式」的 WSL2：直接就是 127.0.0.1，不用转发"
      echo "  b) 否则在**管理员 PowerShell**里转发（还要放行防火墙该端口）："
      echo "     netsh interface portproxy add v4tov4 listenport=${PORT} listenaddress=0.0.0.0 connectport=${PORT} connectaddress=127.0.0.1"
      echo "     New-NetFirewallRule -DisplayName life-world-chrome -Direction Inbound -LocalPort ${PORT} -Protocol TCP -Action Allow"
      echo "  然后把 127.0.0.1 换成 Windows 主机地址：$(ip route 2>/dev/null | awk '/^default/{print $3; exit}')"
      exit 2
    fi
    # 普通 Linux：要图形会话（X11/Wayland）+ Chrome 在 PATH 里
    PROFILE="${LIFE_WORLD_CHROME_PROFILE:-$HOME/.config/google-chrome-agent}"
    BIN="${CHROME_BIN:-$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser || true)}"
    if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
      echo "✗ 没找到 Chrome / Chromium（google-chrome / chromium 都不在 PATH）"
      echo "  这台机器没有可用的调试口方案，浏览器功能跳过。"
      exit 1
    fi
    for d in 1 0; do
      if [ -S "/tmp/.X11-unix/X${d}" ]; then export DISPLAY=":${d}"; break; fi
    done
    # 纯 Wayland（没有 XWayland）时 Chrome 靠 WAYLAND_DISPLAY 起
    if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
      echo "· 没探测到图形会话（DISPLAY / WAYLAND_DISPLAY 都空）：多半是无头服务器，浏览器起不来"
    fi
    AUTH=$(ls /run/user/"$(id -u)"/xauth_* 2>/dev/null | head -1)
    [ -n "$AUTH" ] && export XAUTHORITY="$AUTH"
    # 已经有一个不带调试口的 Chrome 在跑时，新命令只会被转交给它，调试口永远开不出来
    if pgrep -x google-chrome >/dev/null 2>&1 || pgrep -x chrome >/dev/null 2>&1 || pgrep -x chromium >/dev/null 2>&1; then
      echo "已经有一个 Chrome 开着，但没带调试口。先关掉它再来。"
      exit 1
    fi
    rm -f "$PROFILE"/Singleton* 2>/dev/null
    nohup "$BIN" \
      --remote-debugging-port="$PORT" \
      --user-data-dir="$PROFILE" \
      --no-first-run --no-default-browser-check \
      >/tmp/life-world-chrome.log 2>&1 &
    ;;

  *)
    echo "✗ 不认识的系统：${OS}；这台机器没有可用的调试口方案，浏览器功能跳过。"
    exit 1
    ;;
esac

if wait_port; then exit 0; fi
echo "没起来，看看 /tmp/life-world-chrome.log"
exit 1
