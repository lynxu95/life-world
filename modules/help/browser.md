# 真实浏览器

这台机器如果装了 Chrome，可以用调试口开一个真浏览器。脚本在 `~/.local/share/life-world/bin/`：

- 开：`bash ~/.local/share/life-world/bin/browser-open.sh [端口]`（默认 9222）
- 查浏览历史：`browser-history.mjs [条数] [关键词]`（纯数字关键词直接传，如 `browser-history.mjs 2024`）
- 关：`bash ~/.local/share/life-world/bin/browser-close.sh`

开好后用 `curl http://127.0.0.1:9222/json/list` 看标签页，`/json/new?url=…`（PUT）开新页；要真正操作页面就连 ws 地址走 CDP。它占内存，用完就关。

## 这只是示例，先探测再改

`browser-open.sh` 是**示例脚本**：不同系统的 Chrome 位置和启动方式不一样（macOS 在 `.app` 里、WSL 要拉 Windows 那个、Linux 要图形会话）。它会先探测本机：

- 能开：正常开，返回 0
- 开不了：直接说「这台机器没有可用的调试口方案」并退出（WSL 会额外给出 Windows 侧端口转发的命令）

**遇到开不了的时候**，不要反复重试，也不要当成故障反复排查：

1. 先看脚本输出，再自己找找本机的浏览器：`ls /Applications | grep -i chrome`、`command -v google-chrome chromium`、`ls /mnt/c/Program\ Files/Google/Chrome/Application/`
2. 找到就先传路径试试，不用改文件：`CHROME_BIN=/实际路径 bash ~/.local/share/life-world/bin/browser-open.sh`
3. 确实要改脚本本身时，**改仓库里的 `scripts/browser-open.sh`**，再跑一次 `pi/install.sh`——
   `bin/` 下那份每次 `lwctl update` 都会被覆盖，只改它下次更新就丢了
4. 实在没有（比如只有命令行环境、WSL 又不想做端口转发）就明说「这台机器没有浏览器，我跳过」，然后继续用手里的工具（`web_search`、`curl` 读网页）——浏览器不是主功能，缺了不影响别的

资料目录（登录态）另算：Linux 默认 `~/.config/google-chrome-agent`、macOS `~/Library/Application Support/google-chrome-agent`、WSL 用 Windows 侧的 `C:\chrome-agent`。需要登录态就建好这份资料再开，空资料是没登录的。
