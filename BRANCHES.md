# 分支导航

> 本文件在 `opencode`（原 `main`）分支上，属于早期存档。

## 当前状态

| 分支 | 状态 | 说明 |
|---|---|---|
| `pi-agent-adv` | **当前维护 / 默认** | 唯一在维护的 pi 版；新功能都进这里 |
| `opencode`（原 `main`） | 存档 | 早期 opencode 插件版，**功能不全** |

`pi-agent` / `pi-agent-v2` 已删除，提交用归档 tag 保留：

- `archive/pi-agent-20261111`
- `archive/pi-agent-v2-20261111`
- `archive/main-20261111`（改名前的 `main`）

## 怎么用

- 当前安装 / 开发：

  ```bash
  git clone -b pi-agent-adv https://github.com/lynxu95/life-world
  ```

- 需要旧版代码：`git checkout <tag>`，例如 `git checkout archive/pi-agent-v2-20261111`
- 世界数据统一在 `~/.local/share/life-world/`，切换分支不丢；换分支前建议先 `lwctl backup`
- 当前维护版的文档与安装步骤见根目录 `README.md` 和 `pi/README.md`
