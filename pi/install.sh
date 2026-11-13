#!/bin/bash
# life-world pi 安装
#
#   ./pi/install.sh --global      # 全局：所有 pi 会话都加载（默认）
#   ./pi/install.sh --project     # 项目级：只在 life-world 仓库目录生效
#   ./pi/install.sh --uninstall   # 移除全局扩展（世界数据保留）
#   ./pi/install.sh --project-uninstall
#
# 需要：pi 1.5.0+。Node 22+ 只在跑 QQ 桥接/家会话时需要；
# build-prompt 有 node 就用，没有就由扩展运行时从 modules 现拼。
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
ROOT="${LIFE_WORLD_ROOT:-$HOME/.local/share/life-world}"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
MODE="${1:---global}"

check_pi() {
  if ! command -v pi >/dev/null 2>&1; then
    echo "⚠ 没找到 pi 命令；装好 pi 后再跑一次本脚本"
    return
  fi
  local ver
  # 末尾的 || true 不能省：pipefail + set -e 会让「读不到版本」直接中止整个安装
  ver="$(pi --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  if [ -z "$ver" ]; then
    echo "· 读不到 pi 版本（不影响安装）"
    return
  fi
  local major minor
  major="$(echo "$ver" | cut -d. -f1)"
  minor="$(echo "$ver" | cut -d. -f2)"
  if [ "$major" -lt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -lt 5 ]; }; then
    echo "⚠ 当前 pi ${ver}，低于 1.5.0；life-world 依赖 1.5 的扩展 API 和 rpc 协议，请先 pi update"
  else
    echo "  ✓ pi $ver"
  fi
}

check_deps() {
  echo "== 环境检查 =="
  local os
  case "$(uname -s)" in
    Darwin) os="macOS" ;;
    Linux)
      if grep -qi microsoft /proc/version 2>/dev/null; then os="WSL"; else os="Linux"; fi ;;
    *) os="$(uname -s)" ;;
  esac
  echo "  系统：$os"

  if command -v node >/dev/null 2>&1; then
    local nv nmajor nminor
    nv="$(node -v 2>/dev/null | sed 's/^v//' || true)"
    nmajor="$(echo "$nv" | cut -d. -f1)"
    nminor="$(echo "$nv" | cut -d. -f2)"
    if [ "${nmajor:-0}" -gt 22 ] || { [ "${nmajor:-0}" -eq 22 ] && [ "${nminor:-0}" -ge 13 ]; }; then
      echo "  ✓ Node ${nv}（记忆索引可用）"
    else
      echo "  ⚠ Node ${nv:-?} 低于 22.13：记忆索引/星图用不了；pi 整体建议 22.19+，升一下更稳"
    fi
  else
    echo "  ⚠ 没装 node：QQ 桥接、家会话、看板都起不来（终端里的扩展本体还能跑）"
  fi

  if command -v tmux >/dev/null 2>&1; then
    echo "  ✓ tmux（常驻窗口用得上）"
  else
    if [ "$os" = "macOS" ]; then
      echo "  · 没装 tmux：常驻窗口起不来，brew install tmux"
    else
      echo "  · 没装 tmux：常驻窗口起不来，apt install tmux"
    fi
  fi

  if command -v ffmpeg >/dev/null 2>&1 || command -v magick >/dev/null 2>&1 || command -v convert >/dev/null 2>&1; then
    echo "  ✓ 图片/音频处理工具"
  else
    echo "  · 没装 ffmpeg / imagemagick：超过 8MB 的图片不会自动缩，其它不受影响"
  fi

  echo "  · 启动常驻：装好后跑 ${ROOT}/bin/lwctl start（或对应平台的 bin/start-*.sh）"
}

ensure_world() {
  echo "== 世界目录 =="
  mkdir -p "$ROOT" "$ROOT/worlds/default" "$ROOT/pi-sessions"
  chmod 700 "$ROOT" "$ROOT/worlds/default" 2>/dev/null || true
  # 记录仓库路径，给 lwctl update 用
  printf '%s\n' "$(cd "$SRC/.." && pwd)" > "$ROOT/repo-path"
  chmod 600 "$ROOT/repo-path" 2>/dev/null || true
  # 记住这次是全局装还是项目级装，lwctl update 要沿用，别把 project 静默改成 global
  printf '%s\n' "${MODE#--}" > "$ROOT/install-mode"
  chmod 600 "$ROOT/install-mode" 2>/dev/null || true
  cp "$SRC/../data/kaomoji.json" "$ROOT/pi-kaomoji.json"
  echo "  ✓ 颜文字库 → $ROOT/pi-kaomoji.json"
  # 配套脚本：只装 pi 版实际引用的
  mkdir -p "$ROOT/bin"
  cp "$SRC"/../scripts/browser-* "$ROOT/bin/" 2>/dev/null || true
  cp "$SRC"/bin/qq-bridge.mjs "$ROOT/bin/pi-qq-bridge.mjs" 2>/dev/null || true
  cp "$SRC"/bin/home-rpc.mjs "$ROOT/bin/pi-home-rpc.mjs" 2>/dev/null || true
  cp "$SRC"/bin/lwctl.mjs "$ROOT/bin/lwctl" 2>/dev/null || true
  cp "$SRC"/bin/world-backup.mjs "$ROOT/bin/world-backup.mjs" 2>/dev/null || true
  cp "$SRC"/bin/usage-stats.mjs "$ROOT/bin/usage-stats.mjs" 2>/dev/null || true
  cp "$SRC"/bin/rpc-adapter.mjs "$ROOT/bin/rpc-adapter.mjs"
  if [ ! -f "$ROOT/bin/rpc-adapter.mjs" ]; then
    echo "✗ 缺少 rpc-adapter.mjs —— 桥接和家会话都起不来，安装中止" >&2
    exit 1
  fi
  cp "$SRC"/bin/control-queue.mjs "$ROOT/bin/control-queue.mjs" 2>/dev/null || true
  cp "$SRC"/bin/lwboard.mjs "$ROOT/bin/lwboard.mjs" 2>/dev/null || true
  cp "$SRC"/bin/board.html "$ROOT/bin/board.html" 2>/dev/null || true
  cp "$SRC"/bin/nebula.jpg "$ROOT/bin/nebula.jpg" 2>/dev/null || true
  # 三平台的启动脚本（不注册开机项，自己决定什么时候跑）
  cp "$SRC"/bin/start-*.sh "$ROOT/bin/" 2>/dev/null || true
  chmod +x "$ROOT/bin"/start-*.sh 2>/dev/null || true
  chmod +x "$ROOT/bin/lwctl" 2>/dev/null || true
  # 桥接/家会话默认从 ../ext 找扩展；装到 bin/ 后要有一份对应位置
  mkdir -p "$ROOT/ext"
  ln -sfn "$SRC/ext/life-world.ts" "$ROOT/ext/life-world.ts"
  chmod +x "$ROOT/bin"/*.sh "$ROOT/bin"/*.mjs 2>/dev/null || true
  echo "  ✓ 配套脚本 → $ROOT/bin/（pi-qq-bridge.mjs / pi-home-rpc.mjs）"
}

build_prompt() {
  if command -v node >/dev/null 2>&1; then
    echo "== 生成静态世界提示词 =="
    LIFE_WORLD_ROOT="$ROOT" node "$SRC/build-prompt.mjs"
  else
    echo "== 跳过 build-prompt（没有 node；扩展会在运行时从 modules 现拼）=="
  fi
}

link_extension() { # $1 = target dir
  local dest="$1"
  mkdir -p "$dest"
  if [ -e "$dest/index.ts" ] && [ ! -L "$dest/index.ts" ]; then
    local bak="$dest/index.ts.bak-$(date +%Y%m%d-%H%M%S)"
    mv "$dest/index.ts" "$bak"
    echo "  · 已有 index.ts 备份到 $bak"
  fi
  ln -sfn "$SRC/ext/life-world.ts" "$dest/index.ts"
  echo "  ✓ 扩展 → $dest/index.ts"
}

case "$MODE" in
  --global)
    check_pi
    check_deps
    ensure_world
    build_prompt
    echo "== 全局扩展 =="
    link_extension "$AGENT_DIR/extensions/life-world"
    cat <<EOF

完成。以后直接敲 \`pi\` 就会带 life-world（扩展会自动注入世界规则）。
⚠ 全局模式会让所有 pi 会话都加载 life-world；只想在仓库目录用，改跑
   ./pi/install.sh --project

QQ 桥接（可选）：
  1. 配置 $ROOT/life-world.json 的 bridge 段（参考 pi/config.example.json）
  2. TZ=Asia/Shanghai node $SRC/bin/qq-bridge.mjs
  3. 家会话定时器：TZ=Asia/Shanghai node $SRC/bin/home-rpc.mjs
EOF
    ;;
  --project)
    check_pi
    check_deps
    ensure_world
    build_prompt
    PROJECT="${LIFE_WORLD_PROJECT:-$(cd "$SRC/.." && pwd)}"
    echo "== 项目级扩展 =="
    link_extension "$PROJECT/.pi/extensions/life-world"
    cat <<EOF

完成。在 $PROJECT 里打开 \`pi\`（首次需要批准项目信任）。
项目级不会影响其他目录的 pi 会话。
EOF
    ;;
  --uninstall)
    rm -f "$AGENT_DIR/extensions/life-world/index.ts"
    echo "已移除全局扩展（世界数据保留在 ${ROOT}）"
    ;;
  --project-uninstall)
    PROJECT="${LIFE_WORLD_PROJECT:-$(cd "$SRC/.." && pwd)}"
    rm -f "$PROJECT/.pi/extensions/life-world/index.ts"
    echo "已移除项目级扩展（世界数据保留）"
    ;;
  -h|--help)
    echo "用法：./pi/install.sh [--global|--project|--uninstall|--project-uninstall]"
    ;;
  *)
    echo "未知参数：$MODE"
    echo "用法：./pi/install.sh [--global|--project|--uninstall|--project-uninstall]"
    exit 1
    ;;
esac
