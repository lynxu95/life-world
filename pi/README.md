# life-world · pi 版

> 本目录是 life-world 的 **pi 1.5.0 移植版**，独立于仓库根目录的 opencode 插件。
> 分支：`pi-agent`（`main` 仍是 opencode 版）。
>
> 评估与决策见 vault：`AI/开发中项目/life-world 迁 pi · 扩展点评估.md`；
> 实施记录见 `AI/开发中项目/piagent 迁移 worklog.md`。

## 它是什么

把 life-world 从 opencode 插件搬到 pi 的原生扩展点：

- **工具**：`plan_next` / `check_alarm` / `cancel_alarm` / `reach_out` / `send_media` / `group_chat` / `kaomoji` / `memory_search` / `memory_day` / `memory_timeline` / `delegate` / `gal_choice` / `switch_model` / `web_search`
- **模型热切换**：`switch_model` 让角色自己决定本地 / 在线；模型无响应立即切、工具连续失败两次切云端，另有脚本探活兜底
- **机密抽屉**：切云端前把之前的对话与机密文件收进 `worlds/default/机密抽屉/`，`用户画像-私密.md` 不预加载、本地需要时自己读，云端禁止打开该目录；没配本地模型则整个抽屉不启用
- **闹钟带模型**：`plan_next` 可指定到点用 `local` / `cloud`，定时器触发前先切过去
- **联网搜索**：`web_search` 走 TinyFish keyless，免 API Key
- **每轮状态**：`input` 事件把时间、心情、桥接状态拼进当前用户消息（不改 system，保护缓存）
- **归档**：`message_end` 写 `conversations/YYYY-MM-DD.jsonl`
- **记忆**：新会话首轮注入最近 48h / 2000 字 + 3 天记忆地图 + 自述；检索走 FTS5（`memory-index.db`，trigram，≥3 字 MATCH / 2 字 LIKE 回退）
- **定时器**：`LIFE_WORLD_ROLE=home` 的进程每 30 秒检查闹钟 / 每日回顾 / 早上兜底，用 `pi.sendMessage(triggerTurn)` 唤醒
- **QQ 桥接**：OneBot v11 正向 WS ↔ `pi --mode rpc`；私聊、余波、outbox、图片/语音/文件、基础群聊
  - 配了 `models.cloud` 时，**群聊会话优先在线模型**（判官也用在线模型），私聊仍用 `LIFE_WORLD_MODEL`（通常本地）
  - 群聊触发：@ / 关键词 / 5% 随机插话；配置在桥接启动时读取，改完需重启
- **子代理**：`delegate` 起独立 `pi -p` 子进程，零第三方扩展，深度限制 1 层
- **gal**：`gal_choice` 工具用 `ctx.ui.select` 抛单选面板（仅终端 TUI；QQ 无面板）

## 要求

| 项 | 要求 |
|---|---|
| pi | **1.5.0+** |
| Node | **22.19+**（桥接用全局 WebSocket；build-prompt 用 Node） |
| OneBot | 任意 OneBot v11 正向 WS 服务端（SnowLuma / NapCat 等；只在跑 QQ 桥接时需要） |
| 系统 | Linux（tmux 可选；TUI 不是必须） |
| 可选 | `imagemagick` / `ffmpeg`（超 8MB 的 QQ 图片自动缩） |

## 安装

### 0. 先装 pi

```bash
curl -fsSL https://pi.dev/install.sh | sh
# 或：npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version   # 1.5.0+
```

如果 `pi` 不在 PATH（常见于 `~/.local/bin` 或 `~/.pi/agent/bin`），把它加进 shell 配置，或者在脚本里设 `PI_BIN=/绝对路径/pi`。

### 1. 装 life-world

```bash
git clone -b pi-agent https://github.com/lynxu95/life-world
cd life-world

./pi/install.sh --global     # 全局：所有 pi 会话都加载（默认）
# 或
./pi/install.sh --project   # 项目级：只在 life-world 目录生效
```

它做五件事：

1. 建 `~/.local/share/life-world/{worlds/default,pi-sessions}`；
2. 把 `data/kaomoji.json` 复制成 `~/.local/share/life-world/pi-kaomoji.json`；
3. 用 `build-prompt.mjs` 把仓库 `modules/*.md` 拼成 `pi/prompt/world.md`；
4. 把扩展软链到 pi 的自动发现目录：
   - 全局：`~/.pi/agent/extensions/life-world/index.ts`
   - 项目级：`<仓库>/.pi/extensions/life-world/index.ts`
5. 把 `browser-*`、`pi-qq-bridge.mjs`、`pi-home-rpc.mjs` 复制到 `~/.local/share/life-world/bin/`，并放一份扩展在 `~/.local/share/life-world/ext/`（桥接脚本默认从那里找）。

**扩展会自己在每轮开始前确保世界规则在 system 里**（`prompt/world.md` 缺失时用 `modules/` 现拼），所以不需要 `--append-system-prompt`，也不需要改 `APPEND_SYSTEM.md`。

装完直接：

```bash
pi          # TUI，已经带 life-world
```

移除：

```bash
./pi/install.sh --uninstall           # 全局
./pi/install.sh --project-uninstall   # 项目级
```

> 不要用 `pi/config.example.json` 覆盖已有的 `~/.local/share/life-world/life-world.json`；只把 `bridge` 段和 `subagent` 段按需合并。

## 主动关怀

`life-world.json` 的 `care` 段：

```json
"care": {
  "enabled": true,
  "quietStart": "23:30",
  "quietEnd": "08:00",
  "randomEnabled": true,
  "randomMinGapHours": 3,
  "randomChancePerTick": 0.02,
  "weatherEnabled": true,
  "weatherCity": "石家庄"
}
```

- **安静时段**：`quietStart ~ quietEnd`（可跨午夜）内不发随机消息；
- **随机想起**：安静时段外，距上次至少 `randomMinGapHours` 小时，每个 tick（30 秒）以 `randomChancePerTick` 概率触发一次「想起你」，角色自己决定 `reach_out` 还是 `[SILENT]`；
- **天气**：早上兜底唤醒时用 `wttr.in` 取 `weatherCity` 的天气，附在唤醒文本里。

## 守护与清理

- **桥接守护**：家会话每个 tick 检查 `status/qq-*.json` 心跳；超过 `guard.staleSeconds` 没更新就调 `lwctl restart qq` 拉起，冷却 `guard.cooldownMinutes`。
- **tmp 清理**：每天一次，删除 `worlds/default/tmp/` 里超过 `cleanup.tmpMaxAgeHours` 的附件。
- **日志轮转**：`debug.log`（5MB）、`qq-bridge.log`、`home-rpc.log` 超限自动切 `.1`。

```json
"guard": { "enabled": true, "staleSeconds": 180, "cooldownMinutes": 10 },
"cleanup": { "tmpMaxAgeHours": 72 }
```

## 配置

`~/.local/share/life-world/life-world.json`：

```json
{
  "bridge": {
    "enabled": true,
    "ownerQQ": 123456789,
    "wsUrl": "ws://127.0.0.1:3001",
    "token": "",
    "afterglow": { "enabled": true, "delayMs": 60000, "maxRounds": 2 },
    "group": { "enabled": false, "keywords": ["铃"] }
  },
  "subagent": { "model": "deepseek-flash" },
  "localModel": { "enabled": true, "keepRecent": 20, "foldToolResults": 6, "resultChars": 300 },
  "models": {
    "local": "basalt/abliterated-iq3_xxs",
    "cloud": "deepseek/deepseek-flash",
    "autoFailover": true,
    "localHealthUrl": "http://127.0.0.1:8081/health",
    "cloudHealthUrl": "https://api.deepseek.com/models",
    "probeTimeoutMs": 4000,
    "cooldownMs": 60000
  }
}
```

完整示例见 `pi/config.example.json`。

> 总开关：`world.enabled=false` 会让扩展整体停用（工具、注入、定时器都不挂），**需重启 pi 生效**；世界数据原地保留。

### 模型使用规范

`worlds/default/identity/模型使用规范.md`（≤500 字）会被注入 system，和 `心情.md` 同级。写清楚什么时候用本地、什么时候切在线，以及切换礼仪；角色会照着执行，用户也可以随时改这份文档。

`models.local` / `models.cloud` 就是热切换的两个目标，写 `provider/model`：

- 在线模型（如 `deepseek/deepseek-flash`）用 pi 内置目录 + `~/.pi/agent/auth.json` 的凭据；
- 自建/本地模型（如 `basalt/abliterated-iq3_xxs`）先在 `~/.pi/agent/models.json` 里注册 provider（baseUrl / api / apiKey），再用 `provider/model` 引用。

本地模型实测与推荐的优化参数见仓库根 README《本地模型实测》（RTX 5060 Ti + Basalt + Qwen3.8-Flash-Next IQ3_XXS 搭配 DeepSeek Flash）。

`models.local` 留空则不启用热切换（机密抽屉也随之停用）；`autoFailover` 打开时，扩展在每轮开始前探活当前模型，挂了就自动切到另一个（冷却 `cooldownMs`，防止来回抖）。

### 机密抽屉

切到云端前，扩展会把切换前的对话与工具读到的内容收进 `worlds/default/机密抽屉/`（按天 `${dayOf()}.jsonl`），云端请求只保留当前这条任务；切回本地自动恢复。抽屉按会话隔离（`sessions/<sessionId>.json`），一个会话合上不影响另一个；读不出来按“开着”处理（宁多挡不漏）。

`机密抽屉/用户画像-私密.md` **不预加载**：本地模式只提示位置，需要时自己 `read`；云端模式下整个 `机密抽屉/` 禁止 `read / write / edit / grep / find / ls / bash`，递归翻 world 目录也会拦；碰到会提示切回本地。没配 `models.local` 时抽屉整体停用。

触发自动切换的规则：模型无响应（`stopReason=error`）立即切；工具连续失败两次，从本地切到云端看看情况；`/model` 手动切换由 `model_select` 同步开关抽屉。

### 会话查看与热切换（lwctl）

`install.sh` 会把 `lwctl` 装到 `~/.local/share/life-world/bin/`：

```bash
lwctl          # 交互菜单：列出会话 → 选一个 → 选本地/在线/自定义模型
lwctl status   # 直接打印：qq / home / cli / group:<群号> 现在各用什么模型
lwctl targets  # 列出当前可切换目标
lwctl set qq cloud        # 脚本方式：把 QQ 私聊切到在线
lwctl set home local
lwctl set group:894742315 cloud

lwctl backup [--private]           # 世界数据快照到 worlds/backup（git 增量）
lwctl backups                      # 看最近快照
lwctl tail [qq|home|debug] [行数]   # 看日志
lwctl restart [qq|home|all]        # 重启常驻窗口
```

原理：每个扩展进程每 5 秒写一份心跳到 `~/.local/share/life-world/status/`；`lwctl` 下发命令到 `control.json`，目标进程轮询后调用 `pi.setModel` 并回执到 `control-state.json`。切到在线时同样会打开该会话的机密抽屉。

### 世界快照

`worlds/backup/` 是一个独立的 git 仓库，`lwctl backup` 把 `worlds/default` 的 identity / conversations / diary / plan / room / 表情包 / 语音 / world.json 同步进去再提交；`--private` 才带上 `机密抽屉/`。git 增量存储，重复内容不重复占空间。

家会话每天 `backup.hour` 点后自动快照一次（`life-world.json` 的 `backup` 段，`includePrivate` 默认 false）。

### 闹钟带模型

`plan_next({ note, at|after_minutes, model: "local"|"cloud" })`：到点时定时器先切到指定模型再唤醒。《模型使用规范》建议定任务时就写清楚用哪个。

## 界面整洁

- `~/.pi/agent/settings.json` 加 `"hideThinkingBlock": true`：隐藏思考块；
- 工具输出默认折叠，`Ctrl+O` 展开/收起；每个工具自带紧凑 renderer；
- 时间/心情/桥接状态走 `before_agent_start` 的隐藏消息，不再出现在用户消息正文里。

## 启动

```bash
# 私聊桥接
TZ=Asia/Shanghai node pi/bin/qq-bridge.mjs

# 家会话（定时器）
TZ=Asia/Shanghai node pi/bin/home-rpc.mjs

# 单独测扩展（显式加载；全局安装后直接 pi 也行）
pi -p --model deepseek-flash --no-skills --no-prompt-templates \
  -e pi/ext/life-world.ts "调用 check_alarm"
```

`PI_BIN` / `LIFE_WORLD_EXT` / `LIFE_WORLD_PROMPT` / `LIFE_WORLD_MODEL` 都可用环境变量覆盖；默认从 `bin/` 相对定位扩展与提示词。

> tmux 新窗口不读 `.zshrc`：`pi` 若在 `~/.local/bin`，启动命令里补 `PATH=$HOME/.local/bin:$PATH`，或显式设 `PI_BIN=$HOME/.local/bin/pi`。

附件：图片超过 8MB 会自动缩到 1568px（需要 `imagemagick` 或 `ffmpeg`）；工作文件不设大小上限，流式落盘到 `worlds/default/tmp/` 后把路径交给模型。

### SnowLuma / NapCat 只监听 127.0.0.1 时

从其他机器/容器连不上时，用 SSH 隧道（以宿主机 `192.168.0.195` 为例）：

```bash
sshpass -f /path/to/pw ssh -N -L 127.0.0.1:3001:127.0.0.1:3001 lynxu@192.168.0.195
```

桥接仍连 `ws://127.0.0.1:3001`。也可以把 OneBot 的 WS host 改成 `0.0.0.0` 后重启服务，但那是动线上服务，自己权衡。

## 测试

```bash
# 模拟 owner 发一条私聊，跑完整链路（会真的发到 QQ）
TZ=Asia/Shanghai TEST_MS=45000 node pi/bin/qq-bridge.mjs --test-user "在吗"
```

## 与 opencode 版的对应

| opencode | pi |
|---|---|
| `tool.transform` + `execute` 绕路 | `registerTool`，模型直接调用 |
| 每轮 system 注入 | `before_agent_start` 隐藏消息 |
| `opencode.db` 归档 | `message_end` 写 JSONL |
| HTTP `sendHome` | `pi.sendMessage(triggerTurn)` |
| 桥接 HTTP API | pi RPC JSONL |
| 在线子代理提示 | `switch_model` 热切换 + 脚本级故障切换 |
| 内置 websearch（5 家供应商，需 Key） | `web_search`，TinyFish keyless 免 Key |
| 会话列表 | 磁盘 JSONL 树，`pi -r` 挑回 |
| QQ 私聊 / 群聊风格块 | 同样注入（按 `LIFE_WORLD_CHANNEL`） |

## 文件

```
pi/
├── ext/life-world.ts        pi 扩展（工具/注入/归档/定时器/delegate/gal）
├── bin/qq-bridge.mjs        OneBot WS ↔ pi RPC 桥接
├── bin/home-rpc.mjs         家会话 RPC 常驻（定时器）
├── build-prompt.mjs         从 ../modules/*.md 生成 prompt/world.md
├── install.sh               安装/生成提示词
├── config.example.json      配置示例
└── prompt/world.md          生成物（install.sh 产出，不提交也行）
```
