# life-world · pi agent

> **当前维护分支：`pi-agent-adv`（唯一在维护的 pi 版）。**
> `pi-agent` / `pi-agent-v2` 已归档，归档 tag 保留提交：`archive/pi-agent-20261111`、`archive/pi-agent-v2-20261111`；`opencode`（原 `main`）是早期 opencode 插件版，**功能不全**，保留存档。分支状态见[分支状态](#分支状态)。

给 [pi coding agent](https://github.com/earendil-works/pi) 里的陪伴角色一个会记得、会生活的世界。所有能力都跑在**本地文件 + 本地进程**上，聊天默认用本地模型，需要时借在线模型的算力。

## 目录

- [功能一览](#功能一览)
- [安装](#安装)
- [升级 / 迁移](#升级--迁移)
- [配置](#配置)
- [记忆系统](#记忆系统)
- [本地 / 在线模型](#本地--在线模型)
- [技能库](#技能库)
- [辅助感知（多模态）](#辅助感知多模态)
- [隐私：机密抽屉](#隐私机密抽屉)
- [主动关怀](#主动关怀)
- [QQ 桥接](#qq-桥接)
- [定时与家会话](#定时与家会话)
- [工具](#工具)
- [lwctl 运维命令](#lwctl-运维命令)
- [Web 看板](#web-看板)
- [数据位置](#数据位置)
- [分支状态](#分支状态)
- [已知限制](#已知限制)

---

## 功能一览

| 能力 | 说明 |
|---|---|
| 跨会话记忆 | 对话原文归档 JSONL；新会话在第一次可安全注入时补最近 48h + 记忆地图 + 自述 |
| FTS5 检索 | `memory_search` 查本地索引，中文 trigram；3 字以上 BM25、2 字 LIKE 回退 |
| 遗忘曲线 | 每条记忆有强度：命中加强、按半衰期衰减，只降权不删 |
| ACT-R 激活 | 检索排序叠加频率 × 近因的基级激活（`B = ln(Σ (now−t)^−d)`） |
| Hebbian 联想 | 共同召回自动连边，检索时一跳扩散带出关联记忆 |
| 印象整理 | 每天把近期对话/日记归纳成 `identity/印象.md`，本地/云端都注入 |
| 记忆星图 | 看板 3D 星图：全屏、星云背景随旋转、印象连线回真实来源 |
| 模型热切换 | `switch_model` / 看板 / `lwctl` 都能切；脚本级故障切换 |
| 机密抽屉 | 切云端前收起前文、云端禁读，切回本地恢复 |
| 主动关怀 | 随机想起、安静时段、早晨天气 |
| QQ 桥接 | 私聊 + 群聊；群聊优先在线模型；图片自动缩、文件不限大小；群会话闲置回收 |
| 定时 | 活动到点唤醒；子闹钟短间隔自我唤醒，忙时跳过，主活动关闭连带关闭 |
| 辅助感知 | `perceive` 看视频/听音频/看图；主模型能看的图片不走辅助；适配 Qwen-Omni |
| 控制队列 | `lwctl` / 看板命令追加队列、按 id 回执；并发/同毫秒不再丢命令 |
| 超限自动换会话 | 上下文超限不切模型：QQ 自动新会话+重发，home/CLI 自动新会话 |
| 技能库 | `own` / `downloaded` + `INDEX.md`；`skill_list/read/run/toggle` |
| Web 看板 | 会话/模型/AI 日程/用量/记忆星图/日记/日志/快照，一页看完 |
| 运维 | `lwctl` 状态、切换、日志、重启、快照、用量；桥接守护、tmp 清理、日志轮转 |

## 安装

**要求**

| 项 | 说明 |
|---|---|
| pi | **1.5.0+** |
| Node | **22.19+**（pi 安装器自带；桥接/索引/看板都用它） |
| 系统 | Linux（tmux 可选，常驻推荐） |
| 可选 | `imagemagick` 或 `ffmpeg`（超大 QQ 图片自动缩）；OneBot v11 服务端（跑 QQ 桥接才需要） |

### 1. 装 pi

```bash
curl -fsSL https://pi.dev/install.sh | sh
# 或：npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version   # 1.5.0+
```

`pi` 常装在 `~/.local/bin` 或 `~/.pi/agent/bin`，记得进 PATH；tmux 新窗口不读 `.zshrc`，脚本里可用 `PI_BIN=/绝对路径/pi`。

### 2. 装 life-world

```bash
git clone -b pi-agent-adv https://github.com/lynxu95/life-world
cd life-world
./pi/install.sh --global     # 所有 pi 会话加载；只想在仓库目录用改成 --project
```

安装脚本会：建世界目录、复制颜文字库、生成世界规则、软链扩展，并把 `browser-*`、`pi-qq-bridge.mjs`、`pi-home-rpc.mjs`、`lwctl`、`lwboard` 等放进 `~/.local/share/life-world/bin/`。

### 3. 配模型

在线模型：容器里跑 `pi` → `/login deepseek`（或设 `DEEPSEEK_API_KEY`）。

本地模型：在 `~/.pi/agent/models.json` 注册 provider，例如：

```json
{
  "providers": {
    "basalt": {
      "baseUrl": "http://127.0.0.1:8081/v1",
      "api": "openai-completions",
      "apiKey": "liugongfu",
      "models": [{ "id": "abliterated-iq3_xxs", "contextWindow": 262144, "maxTokens": 32768, "input": ["text","image"] }]
    }
  }
}
```

然后在 `life-world.json` 的 `models` 段写 `local` / `cloud`（见下）。

### 4. 常驻

```bash
tmux new-session -d -s life-world -n qq   'TZ=Asia/Shanghai LIFE_WORLD_MODEL=basalt/abliterated-iq3_xxs node ~/life-world/pi/bin/qq-bridge.mjs'
tmux new-window  -t life-world -n home   'TZ=Asia/Shanghai LIFE_WORLD_MODEL=basalt/abliterated-iq3_xxs node ~/life-world/pi/bin/home-rpc.mjs'
lwctl board                              # Web 看板
```

### 卸载

```bash
./pi/install.sh --uninstall        # 或 --project-uninstall
```

世界数据保留在 `~/.local/share/life-world/`。

## 升级 / 迁移

从 `pi-agent-v2`（已归档）升到 `pi-agent-adv`（数据目录不变）：

```bash
git fetch origin && git checkout pi-agent-adv && git pull
./pi/install.sh --global
```

- 数据目录结构不变，`worlds/default`、`pi-sessions`、`life-world.json` 直接沿用；
- 新配置项（`memory`、`care`、`backup`、`guard`、`cleanup`）没有写就用默认值；
- 首次启动会在后台补齐记忆索引。

## 配置

`~/.local/share/life-world/life-world.json`（完整示例见 `pi/config.example.json`）：

```json
{
  "world": { "enabled": true, "running": true, "reviewHour": 23, "fallbackWakeTime": "09:00" },
  "board": { "host": "127.0.0.1", "port": 8099 },
  "bridge": {
    "enabled": true,
    "ownerQQ": 123456789,
    "wsUrl": "ws://127.0.0.1:3001",
    "token": "",
    "afterglow": { "enabled": true, "delayMs": 60000, "maxRounds": 2 },
    "group": { "enabled": false, "keywords": ["铃"], "interjectChance": 0.05, "cooldownMs": 8000, "sessionIdleMinutes": 120, "maxFileBytes": 104857600, "maxBatchBytes": 209715200 }
  },
  "subagent": { "model": "deepseek-flash" },
  "multimodal": { "enabled": false, "model": "", "timeoutMs": 300000, "warnImageBytes": 8388608, "warnVideoBytes": 209715200 },
  "localModel": { "enabled": true, "keepRecent": 20, "foldToolResults": 6, "resultChars": 300, "foldingThinkingTurns": 0 },
  "models": {
    "local": "basalt/abliterated-iq3_xxs",
    "cloud": "deepseek/deepseek-flash",
    "autoFailover": true,
    "localHealthUrl": "",
    "cloudHealthUrl": "",
    "probeTimeoutMs": 4000,
    "cooldownMs": 60000
  },
  "care": {
    "enabled": true, "quietStart": "23:30", "quietEnd": "08:00",
    "randomEnabled": true, "randomMinGapHours": 3, "randomChancePerTick": 0.02,
    "weatherEnabled": true, "weatherCity": "石家庄"
  },
  "backup": { "enabled": true, "hour": 4, "includePrivate": false },
  "guard": { "enabled": true, "staleSeconds": 300, "cooldownMinutes": 10, "allowRestart": true },
  "cleanup": { "tmpMaxAgeHours": 72 },
  "memory": {
    "decay": { "enabled": true, "halfLifeDays": 30, "hitBoost": 0.15, "maxStrength": 3, "minStrength": 0.1 },
    "actr": { "enabled": true, "decay": 0.5, "weight": 0.2, "maxAccess": 50 },
    "association": { "enabled": true, "weight": 0.1, "learnRate": 0.05, "decayPerDay": 0.02, "maxWeight": 1, "maxNeighbors": 50, "bootstrap": true },
    "impression": { "enabled": true, "hour": 5, "days": 3, "maxItems": 5 }
  }
}
```

- 总开关：`world.enabled=false` 会让扩展整体停用（需重启 pi）；
- 本地模型留空：热切换的 local 目标失效、机密抽屉停用；
- 在线模型留空：群聊回落到 `LIFE_WORLD_MODEL`；
- `board.host/port`：看板监听地址与端口；`lwctl board set` 会自动保存并重启，`LW_BOARD_HOST` / `LW_BOARD_PORT` 环境变量优先级更高。

## 记忆系统

**真相永远是文件**：`worlds/default/conversations/*.jsonl`、`diary/*.md`、`plan/*.md`、`room/*.md`、`identity/*.md`。SQLite 只是索引，删了能重建。

- **FTS5**：`memory-index.db`（trigram 分词，WAL + busy_timeout），归档时增量写入；历史由单个进程加锁回填（500 条一事务）。
- **检索路线**：FTS5 字面命中 → ACT-R 激活 + Hebbian 联想加权；本分支**不做向量检索**，需要“语义相近”的检索请参考已归档的 `pi-agent-v2`。
- **遗忘曲线**：`mem` 表存 strength/uses/last_used；检索命中 +`hitBoost`，每天按 `halfLifeDays` 衰减；排序权重 `0.7 + 0.3*min(1, strength/2)`，只降权不删。
- **记忆工具**：`memory_search`（关键词/时间/角色/范围/前后文）、`memory_day`（某天）、`memory_timeline`（一段时间的摘要）。

### ACT-R 激活与联想扩散（pi-agent-adv 新增）

- **ACT-R 基级激活**：每条记忆记录被检索命中的次数与时间（`access` 表），排序用 `B = ln(Σ (now−tₖ)^(−d))`（d≈0.5），同时体现近因与频率；关闭 `memory.actr.enabled` 则退回旧的强度衰减。
- **共现自举**：首次建图时，同一天相邻的对话先生成弱边（0.03，略高于每日清理阈值 0.02），之后谁先被一起召回谁就变强；
- **Hebbian 联想**：同一次检索的前几名会两两连边（`edges` 表），权重按 `learnRate` 增强、每日按 `decayPerDay` 衰减；检索时从种子做一跳扩散，把关联记忆带上来。
- 只记录 `memory_search` 真正召回的记忆；每轮强制注入历史不算“访问”。看板的记忆星图直接读 `access`/`edges`，远近与亮度就是激活/关联。

### 印象整理（pi-agent-adv 新增）

每天一次，把最近 `impression.days` 天的对话/日记/笔记交给模型归纳成最多 `impression.maxItems` 条“印象”，写进 `identity/印象.md`（带来源、置信度、最后验证）。合并更新，不重复、不写私密细节。

- 每天一次，统一在 `impression.hour`（默认 05:00）之后跑；
- **配了本地模型**：先切到本地模型再生成，切换失败会记日志并按当前模型继续；
- **纯云端模式**（未配 `models.local`）：直接用当前在线模型跑，不切模型，也不启用机密抽屉；
- 印象**本地和云端都会注入**（只放判断，不含私密细节）；
- 看板「立即整理」可额外触发一次，不占 05:00 的额度；只有任务真正送进会话才写回执，不再“假成功”。

实测配置（RTX 5060 Ti 16G + Basalt + Qwen3.8-Flash-Next IQ3_XXS，搭配 DeepSeek Flash）：插件稳定运行，日常聊天质量不错，世界探索交给在线模型。

## 本地 / 在线模型

- 角色自己切：`switch_model({ target: "local"|"cloud"|"provider/model", reason })`；
- 人能切：`lwctl` 交互菜单 / `lwctl set qq cloud` / 看板按钮；
- 脚本兜底：模型无响应立即切另一个；工具连续失败两次从本地切云端；每轮探活（`autoFailover`）；
- 切换记录写进会话，恢复会话时保留；
- 规范文件 `worlds/default/identity/模型使用规范.md`（建议 ≤500 字）会注入 system，说明什么时候切、切换礼仪。

模型是“化形”，不是人格：本地是家、在线是进机房借算力；换模型不换人，名字和关系不变。这具身子是谁家的可以照实说，不需要回避。

## 技能库

自己的小工具和网上下的技能，按「自制 / 下载」分开放在世界目录：

```
worlds/default/skills/
├── INDEX.md          # 自动生成的索引
├── own/              # 自己手搓
│   └── weather/
│       ├── SKILL.md
│       └── scripts/
└── downloaded/       # 网上下的
    └── jd-price/
        └── SKILL.md
```

- AI 平时只知道技能库和索引在哪，不会把技能列表塞进上下文；
- `skill_list()`：扫描两个目录、刷新 `INDEX.md`，返回「技能 / 说明 / 标签 / 来源 / 状态 / 路径」；
- `skill_read({ name })`：需要正文时才读 `SKILL.md`；下载的技能会提示先确认内容；
- `skill_run({ name, script?, args?, timeout_seconds? })`：只允许跑技能目录内的脚本，默认最多 60 秒、输出截断 2 万字符；不给 `script` 就用 `SKILL.md` 的 `run:`；配了本地模型又不在本地时不跑（避免脚本读到私密资料）；
- `skill_toggle({ name, enabled })`：停用只是加 `.disabled` 标记，不删文件；停用的技能不能跑，但还能读；
- 群聊不注册这四个工具。`pi/examples/skills/own/时间/` 是一份可直接复制过去试的示例。

`SKILL.md` 最少写 frontmatter：

```markdown
---
name: weather
description: 查天气。想知道某地今天/明天的天气时用。
tags: 查询,天气
run: bash scripts/weather.sh
---

# 天气
`skill_run({ name: "weather" })` 会跑 `scripts/weather.sh`；也可以直接指定脚本。
```

制作规范：一个技能一个文件夹，脚本 / 参考 / 素材都收在里面；实在要放外面，在 `SKILL.md` 写清绝对路径、原因和恢复方法；下载的技能不要改上游文件。

## 辅助感知（多模态）

主模型只负责它本来就有的能力；**缺的模态**才交给辅助感知模型（推荐 Qwen3.8-Omni-Flash）：

- **视频、音频**：pi 的输入模态只有 `text/image`，必须走辅助模型；
- **图片**：主模型 `input` 含 `image` 就直接 `read`，**不走辅助**；只有主模型不支持图片时才交给辅助；
- `perceive({ path, question })`：本地文件或公网 URL。本地 Base64 超过 10MB 会先压缩（图片缩图、音视频按目标码率转码；需要 `ffmpeg` 或 `imagemagick`），压不进去就如实告诉 AI 去和用户商量分段；URL 直接交给百炼服务端拉取，不本地中转；
- **B 站 / 抖音**：直链常被防盗链挡住（Referer/UA/cookie），Omni 服务端拉不动；下载到 `tmp/`（低清晰度、只下相关片段、看完删）再喂本地文件。工具压缩产生的临时文件即时清理；
- 看板「模型 → 辅助感知」选 `provider/model`，留空即停用。
- 实测：Qwen3.8-Omni-Flash 图片 / 视频可用（395 生产，2026-11-11）；B 站/抖音直链被防盗链挡住时按下面的下载流程走。

Qwen3.8-Omni-Flash 官方限制：图片 URL 20MB/张、音频 2GB/3 小时、视频 2GB/2 小时；Base64 一律**编码后 <10MB**。推荐在 `~/.pi/agent/models.json` 注册 DashScope provider：

```json
"dashscope": {
  "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "api": "openai-completions",
  "apiKey": "sk-…",
  "models": [{ "id": "qwen3.8-omni-flash", "contextWindow": 1000000, "maxTokens": 8192, "input": ["text", "image"] }]
}
```

然后把 `multimodal.model` 设成 `dashscope/qwen3.8-omni-flash`。`input` 写 `text/image` 只是让 pi 的模型列表认识它；音视频由扩展直接调 API。

**边界**：`perceive` 只读 `room/`、`表情包/`、`语音/`、`tmp/`，机密抽屉直接拒绝；不会把主模型能做的事默认丢给 Omni。

## 隐私：机密抽屉

- 切到**任意非本地模型**前，先按会话打开 `worlds/default/机密抽屉/sessions/<sessionId>.json`，把切换前的对话与工具结果对云端屏蔽；写不进去就拒绝切换（fail-closed）。
- 云端请求里看不到切换前历史，只会看到一句「【机密内容，请回家后再看】」；`用户画像-私密.md` **不预加载**，本地需要时自己读，云端禁止打开整个 `机密抽屉/`（`read/write/edit/grep/find/ls/bash` 命中即拦）。
- 切回本地自动恢复；没配 `models.local` 时抽屉整体停用。
- 按会话隔离，一个会话合上不影响另一个；状态文件坏了按“开着”处理。

## 主动关怀

- 安静时段外，距上次至少 `randomMinGapHours` 小时，每 tick 以 `randomChancePerTick` 概率触发一次「想起你」，角色自己决定 `reach_out` 还是 `[SILENT]`；
- 关掉 `randomEnabled` = 全天安静（看板可一键开关）；
- 早上兜底唤醒时用 `wttr.in` 取 `weatherCity` 的天气附在文本里。

## QQ 桥接

```
QQ ←→ OneBot v11 正向 WS ←→ pi/bin/qq-bridge.mjs ←→ pi --mode rpc
```

- **私聊**：固定会话 `qq-chat`，文件持久化，重启接着聊；
- **群聊**：每个群一个 `qq-group-<群号>`；配了 `models.cloud` 时群聊与判官都用在线模型；群配置 2 秒热加载；闲置 `group.sessionIdleMinutes`（默认 120 分钟）后回收子进程，有人说话会自动重开；
- **触发**：@ / 关键词 / 随机插话概率；冷却与频率上限可配；
- **附件**：图片 >8MB 自动缩到 1568px（需 imagemagick/ffmpeg），私聊文件不设上限、流式落盘到 `tmp/`；群聊也收文件（默认单文件 100MB、单批 200MB，`group.maxFileBytes` / `group.maxBatchBytes` 可调；只给 base64 的实现仍受 40MB 内存上限），路径交给模型读；**私聊语音**会让 OneBot 转成 mp3 落到 `tmp/`，AI 用 `perceive(kind=audio)` 听，群聊语音暂不处理；
- **余波**：发完 60 秒没回补一拍，最多两拍，`[SILENT]` 不发；生成期间对方回来了这句就作废，没发出去也不续下一拍；
- **outbox**：`reach_out` 写文件，桥接补发最近 3 天；状态文件丢了只补 `since` 之后的新条目，不会把当天已发过的整段重发；
- **/new**：清当前私聊会话。

OneBot 只监听 `127.0.0.1` 时用 SSH 隧道；同机部署直接 `ws://127.0.0.1:3001`。

## 定时与家会话

- `plan_next` 开活动时可指定 `model: local|cloud`，到点先切模型再唤醒；
- **活动 / 子闹钟**：活动开始后可以挂一组短间隔的子闹钟（`plan_next({ parent, times/after_minutes })`），同一活动任意 30 分钟最多 3 条；子闹钟到点若 AI 正忙就跳过并记一笔，下次醒来时提醒它 review；下一条主活动开始时上一项还没关，会强制关闭并提醒；安静时段只管随机想念，不管主/子闹钟；
- 家会话（`home-rpc.mjs`，`LIFE_WORLD_ROLE=home`）负责：闹钟、每日回顾（默认 23 点）、早上兜底（默认 09:00 后）、桥接守护、每日快照/清理/衰减；
- `home-rpc.mjs` 的 pi 子进程退出后自动重启（2s 起指数退避，最长 60s；稳定跑满 1 分钟重置）；
- 家会话每次重启新建会话，连续性靠归档记忆；QQ 私聊不变。

## 工具

`plan_next` · `check_alarm` · `cancel_alarm` · `reach_out` · `send_media` · `group_chat` · `kaomoji` · `memory_search` · `memory_day` · `memory_timeline` · `skill_list` · `skill_read` · `skill_run` · `skill_toggle` · `perceive` · `delegate` · `gal_choice` · `switch_model` · `web_search`

- `web_search` 走 TinyFish keyless，免 API Key；
- `delegate` 起独立 `pi -p` 子进程，深度 1 层；
- `gal_choice` 终端单选面板，自动追加「其他（自己输入）」。

## lwctl 运维命令

```bash
lwctl                       # 交互菜单：会话/看板/快照/日志/用量/重启
lwctl status                # 各会话当前模型
lwctl set qq cloud          # 直接切
lwctl backup [--private]    # 世界快照到 worlds/backup（git 增量）
lwctl backups               # 最近快照
lwctl backup --gc           # 压缩快照仓库
lwctl backup --reset        # 删除快照目录（手动清理）
lwctl tail [qq|home|debug]  # 看日志
lwctl restart [qq|home|all] # 重启常驻窗口
lwctl usage [天数]           # token/费用/云端本地/切换次数
lwctl board [start|stop|restart|status]  # Web 看板
lwctl board set <地址> <端口>             # 保存监听设置并重启（如 0.0.0.0 8099）
lwctl board host <地址>                   # 只改监听地址（0.0.0.0 = 局域网）
lwctl board port <端口>                   # 只改监听端口
```

心跳：每个 pi 进程每 5 秒写 `status/<role>-<pid>.json`；看板/lwctl 只显示 PID 存活且 90 秒内有过心跳的会话。`lwctl set` / 看板操作追加到 `control/commands-YYYY-MM-DD.jsonl`，目标进程按 `(at, id)` 水位消费、回执到 `control-acks/`；连点/并发不会被覆盖，同一毫秒也不会吞命令。

## Web 看板

```bash
lwctl board                     # 默认 http://127.0.0.1:8099
lwctl board set 0.0.0.0 8099    # 保存为局域网可访问，并重启看板
lwctl board host 0.0.0.0        # 只改监听地址
lwctl board port 8098           # 只改监听端口
lwctl board status              # 看运行状态、地址、接口是否正常
lwctl board stop                # 停止
```

监听地址和端口写在 `life-world.json` 的 `board` 段；`LW_BOARD_HOST` / `LW_BOARD_PORT` 环境变量优先级更高，适合临时覆盖。

页面分「概览 / 记忆」两个标签页：

- **概览**：会话、模型设置、主动关怀、7 天用量、**AI 日程**（`plan_next` 的闹钟，随机想起不显示）。
- **记忆**：**记忆星图**（Canvas 3D + 跟随旋转的星云背景 + 中心浓/外侧薄的柔焦雾 + 上层分形云团；中心白色主星是自动注入的 identity 文档——我是谁/心情/用户画像/模型规范，主星之间是白色虚线、轻微呼吸发光；内外圈差速旋转（内快外慢，平均速度不变）；印象是金色大星，金色虚线连真实来源；召回边随机跑神经电流，普通边快、金色/琥珀边慢；点击节点沿边放电；悬停降速并聚焦邻居，普通节点与主星悬停都显示标题，主星选中也显示；支持拖拽/缩放/全屏）、**印象墙**（含「立即整理」，不影响 05:00 的每日整理）、FTS5 记忆检索、日记/某天、日志、手动快照。

**安全**：默认只绑 `127.0.0.1`，没有登录鉴权；改成 `0.0.0.0` 前请确认网络环境。

## 数据位置

```
~/.local/share/life-world/
├── worlds/default/          # 世界数据（真相）
│   ├── identity/            # 我是谁、用户画像、心情、模型使用规范
│   ├── conversations/       # 对话原文 JSONL
│   ├── diary/ plan/ room/
│   ├── 机密抽屉/             # 私密画像 + 抽屉状态/原文
│   ├── 表情包/ 语音/ outbox/ tmp/
│   └── world.json           # 闹钟与每日标记
├── worlds/backup/           # git 快照（不含 models/node_modules）
├── memory-index.db          # FTS5 + 强度 + 激活/联想索引（可重建）
├── pi-sessions/             # pi 会话文件
├── status/                  # 会话心跳
├── control/                   # 控制命令队列（commands-YYYY-MM-DD.jsonl）
├── control-acks/              # 每条命令的回执
├── control.json / control-state.json   # 旧版兼容（只读一次）
├── life-world.json          # 配置
├── pi-kaomoji.json
└── bin/                     # 安装的脚本
```

## 分支状态

| 分支 | 状态 | 说明 |
|---|---|---|
| `pi-agent-adv` | **当前维护** | 唯一在维护的 pi 版；新功能都进这里 |
| `pi-agent` | 已归档 | 轻量稳定版；归档 tag `archive/pi-agent-20261111` |
| `pi-agent-v2` | 已归档 | 增强版（保留向量检索）；归档 tag `archive/pi-agent-v2-20261111` |
| `opencode`（原 `main`） | 存档 | 早期 opencode 插件版，**功能不全**；归档 tag `archive/main-20261111` |

> 归档分支不再接收功能更新；需要旧版代码时用对应 tag 检出。`pi-agent-adv` 不依赖 v2 的语义向量检索，二者是并行实现，不是前后代关系。

## 已知限制

- 记忆星图背景图是 `pi/bin/nebula.jpg`，由 lwboard 的 `/nebula.jpg` 路由提供；换图只换文件，覆盖倍数在 `board.html` 里调；
- 本分支不做向量检索；需要语义相似检索时参考已归档的 `pi-agent-v2`（保留 jina 向量 + FTS 混合），或自行接；
- 辅助感知的 `perceive` 是扩展直连模型 API，**不计入 pi 会话用量统计**；看板「今日 / 用量 · 7 天」已写明口径；
- 上下文超限会自动换会话：QQ/群聊由桥接 `newSession` + 重发同一条，home/CLI 在轮次结束后自动新会话；不再误切模型；
- B 站/抖音直链常被防盗链挡住（Referer/UA/cookie），Omni 服务端拉不动；按《辅助感知》里的下载流程走（低清晰度、只下相关片段、看完删）；
- 看板无鉴权，默认只监听本机；
- 群会话不跨桥接重启保留（靠归档记忆续上）；
- 家会话每次启动是新会话（归档记忆负责连续）；
- 备份不做自动清理，用 `lwctl backup --gc/--reset` 手动处理；
- 所有功能面向 Linux；macOS 未做完整验证。
