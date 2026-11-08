# life-world · pi agent adv

> **这是 `adv` 分支（第 3 条 pi 分支）的 README。**
> 分支顺序：`main` = opencode 插件版；`pi-agent` = 轻量稳定版；`pi-agent-v2` = 增强版（记忆索引 / 语义检索 / 遗忘曲线 / 模型热切换 / 机密抽屉 / 主动关怀 / 看板 / 快照与守护）；`adv` = 在 v2 上继续做实验（ACT-R 激活、Hebbian 联想、印象整理、3D 记忆星图）。adv 暂未合回 v2。

给 [pi coding agent](https://github.com/earendil-works/pi) 里的陪伴角色一个会记得、会生活的世界。所有能力都跑在**本地文件 + 本地进程**上，聊天默认用本地模型，需要时借在线模型的算力。

## 目录

- [功能一览](#功能一览)
- [安装](#安装)
- [升级 / 迁移](#升级--迁移)
- [配置](#配置)
- [记忆系统](#记忆系统)
- [本地 / 在线模型](#本地--在线模型)
- [隐私：机密抽屉](#隐私机密抽屉)
- [主动关怀](#主动关怀)
- [QQ 桥接](#qq-桥接)
- [定时与家会话](#定时与家会话)
- [工具](#工具)
- [lwctl 运维命令](#lwctl-运维命令)
- [Web 看板](#web-看板)
- [数据位置](#数据位置)
- [和其它三个分支的区别](#和其它三个分支的区别)
- [已知限制](#已知限制)

---

## 功能一览

| 能力 | 说明 |
|---|---|
| 跨会话记忆 | 对话原文归档 JSONL；新会话在第一次可安全注入时补最近 48h + 记忆地图 + 自述 |
| FTS5 检索 | `memory_search` 查本地索引，中文 trigram；3 字以上 BM25、2 字 LIKE 回退 |
| 可选语义检索 | CPU 跑 `jina-embeddings-v2-base-zh`，与 FTS 混合排序；不装依赖自动退回 FTS |
| 遗忘曲线 | 每条记忆有强度：命中加强、按半衰期衰减，只降权不删 |
| ACT-R 激活 | 检索排序叠加频率 × 近因的基级激活（`B = ln(Σ (now−t)^−d)`） |
| Hebbian 联想 | 共同召回自动连边，检索时一跳扩散带出关联记忆 |
| 印象整理 | 每天把近期对话/日记归纳成 `identity/印象.md`，本地/云端都注入 |
| 记忆星图 | 看板 3D 星图：全屏、星云背景随旋转、印象连线回真实来源 |
| 模型热切换 | `switch_model` / 看板 / `lwctl` 都能切；脚本级故障切换 |
| 机密抽屉 | 切云端前收起前文、云端禁读，切回本地恢复 |
| 主动关怀 | 随机想起、安静时段、早晨天气 |
| QQ 桥接 | 私聊 + 群聊；群聊优先在线模型；图片自动缩、文件不限大小 |
| 定时 | 闹钟可指定到点用哪个模型；每日回顾、早上兜底 |
| Web 看板 | 会话/模型/用量/记忆星图/日记/日志/快照，一页看完 |
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
git clone -b adv https://github.com/lynxu95/life-world
cd life-world
./pi/install.sh --global     # 所有 pi 会话加载；只想在仓库目录用改成 --project
```

安装脚本会：建世界目录、复制颜文字库、生成世界规则、软链扩展，并把 `browser-*`、`pi-qq-bridge.mjs`、`pi-home-rpc.mjs`、`lwctl`、`lwboard` 等放进 `~/.local/share/life-world/bin/`。

### 3. 可选：语义检索依赖

```bash
./pi/install.sh --semantic
```

装 `@huggingface/transformers`（约 480MB，含 onnxruntime）到 `pi/node_modules`。第一次开启会在 `~/.local/share/life-world/models/` 下载 jina 模型（约 157MB）。不装也能用，只是 `memory_search` 走 FTS5。

### 4. 配模型

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

### 5. 常驻

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

从 `pi-agent-v2` 升到 `adv`（数据目录不变）：

```bash
git fetch origin && git checkout adv && git pull
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
  "bridge": {
    "enabled": true,
    "ownerQQ": 123456789,
    "wsUrl": "ws://127.0.0.1:3001",
    "token": "",
    "afterglow": { "enabled": true, "delayMs": 60000, "maxRounds": 2 },
    "group": { "enabled": false, "keywords": ["铃"], "interjectChance": 0.05, "cooldownMs": 8000 }
  },
  "subagent": { "model": "deepseek-flash" },
  "localModel": { "enabled": true, "keepRecent": 20, "foldToolResults": 6, "resultChars": 300, "foldingThinkingTurns": 0 },
  "models": {
    "local": "basalt/abliterated-iq3_xxs",
    "cloud": "deepseek/deepseek-flash",
    "autoFailover": true,
    "localHealthUrl": "http://127.0.0.1:8081/health",
    "cloudHealthUrl": "https://api.deepseek.com/models",
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
    "semantic": { "enabled": false, "model": "Xenova/jina-embeddings-v2-base-zh", "dtype": "q8", "backfillLimit": 5000 },
    "decay": { "enabled": true, "halfLifeDays": 30, "hitBoost": 0.15, "maxStrength": 3, "minStrength": 0.1 },
    "actr": { "enabled": true, "decay": 0.5, "weight": 0.2, "maxAccess": 50 },
    "association": { "enabled": true, "weight": 0.1, "learnRate": 0.05, "decayPerDay": 0.02, "maxWeight": 1, "maxNeighbors": 50, "bootstrap": true },
    "impression": { "enabled": true, "hour": 5, "days": 3, "maxItems": 5 }
  }
}
```

- 总开关：`world.enabled=false` 会让扩展整体停用（需重启 pi）；
- 本地模型留空：热切换的 local 目标失效、机密抽屉停用；
- 在线模型留空：群聊回落到 `LIFE_WORLD_MODEL`。

## 记忆系统

**真相永远是文件**：`worlds/default/conversations/*.jsonl`、`diary/*.md`、`plan/*.md`、`room/*.md`、`identity/*.md`。SQLite 只是索引，删了能重建。

- **FTS5**：`memory-index.db`（trigram 分词，WAL + busy_timeout），归档时增量写入；历史由单个进程加锁回填（500 条一事务）。
- **语义检索**（可选）：`vec` 表存 768 维向量；文本截 512 字；FTS 与语义结果合并去重后，再交给 ACT-R/联想层加权；换模型自动清空向量并重建。
- **遗忘曲线**：`mem` 表存 strength/uses/last_used；检索命中 +`hitBoost`，每天按 `halfLifeDays` 衰减；排序权重 `0.7 + 0.3*min(1, strength/2)`，只降权不删。
- **记忆工具**：`memory_search`（关键词/时间/角色/范围/前后文）、`memory_day`（某天）、`memory_timeline`（一段时间的摘要）。

### ACT-R 激活与联想扩散（adv 新增）

- **ACT-R 基级激活**：每条记忆记录被检索命中的次数与时间（`access` 表），排序用 `B = ln(Σ (now−tₖ)^(−d))`（d≈0.5），同时体现近因与频率；关闭 `memory.actr.enabled` 则退回旧的强度衰减。
- **共现自举**：首次建图时，同一天相邻的对话先生成弱边（0.03，略高于每日清理阈值 0.02），之后谁先被一起召回谁就变强；
- **Hebbian 联想**：同一次检索的前几名会两两连边（`edges` 表），权重按 `learnRate` 增强、每日按 `decayPerDay` 衰减；检索时从种子做一跳扩散，把关联记忆带上来。
- 只记录 `memory_search` 真正召回的记忆；每轮强制注入历史不算“访问”。看板的记忆星图直接读 `access`/`edges`，远近与亮度就是激活/关联。

### 印象整理（adv 新增）

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

模型是“身体”，人格是“人”：世界规则明确要求不要自称 DeepSeek/千问等模型名。

## 隐私：机密抽屉

- 切到**任意非本地模型**前，先按会话打开 `worlds/default/机密抽屉/sessions/<sessionId>.json`，把切换前的对话与工具结果对云端屏蔽；写不进去就拒绝切换（fail-closed）。
- 云端请求里看不到切换前历史；`用户画像-私密.md` **不预加载**，本地需要时自己读，云端禁止打开整个 `机密抽屉/`（`read/write/edit/grep/find/ls/bash` 命中即拦）。
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
- **群聊**：每个群一个 `qq-group-<群号>`；配了 `models.cloud` 时群聊与判官都用在线模型；群配置 2 秒热加载；
- **触发**：@ / 关键词 / 随机插话概率；冷却与频率上限可配；
- **附件**：图片 >8MB 自动缩到 1568px（需 imagemagick/ffmpeg），文件不设上限、流式落盘到 `tmp/`；
- **余波**：发完 60 秒没回补一拍，最多两拍，`[SILENT]` 不发；
- **outbox**：`reach_out` 写文件，桥接补发最近 3 天；
- **/new**：清当前私聊会话。

OneBot 只监听 `127.0.0.1` 时用 SSH 隧道；同机部署直接 `ws://127.0.0.1:3001`。

## 定时与家会话

- `plan_next` 定任务时可指定 `model: local|cloud`，到点先切模型再唤醒；
- 家会话（`home-rpc.mjs`，`LIFE_WORLD_ROLE=home`）负责：闹钟、每日回顾（默认 23 点）、早上兜底（默认 09:00 后）、桥接守护、每日快照/清理/衰减；
- 家会话每次重启新建会话，连续性靠归档记忆；QQ 私聊不变。

## 工具

`plan_next` · `check_alarm` · `cancel_alarm` · `reach_out` · `send_media` · `group_chat` · `kaomoji` · `memory_search` · `memory_day` · `memory_timeline` · `delegate` · `gal_choice` · `switch_model` · `web_search`

- `web_search` 走 TinyFish keyless，免 API Key；
- `delegate` 起独立 `pi -p` 子进程，深度 1 层；
- `gal_choice` 终端单选面板，自动追加「其他（自己输入）」。

## lwctl 运维命令

```bash
lwctl                       # 交互菜单：看会话、切模型
lwctl status                # 各会话当前模型
lwctl set qq cloud          # 直接切
lwctl backup [--private]    # 世界快照到 worlds/backup（git 增量）
lwctl backups               # 最近快照
lwctl backup --gc           # 压缩快照仓库
lwctl backup --reset        # 删除快照目录（手动清理）
lwctl tail [qq|home|debug]  # 看日志
lwctl restart [qq|home|all] # 重启常驻窗口
lwctl usage [天数]           # token/费用/云端本地/切换次数
lwctl board [start|stop]    # Web 看板
```

心跳：每个 pi 进程每 5 秒写 `status/<role>-<pid>.json`；看板/lwctl 只显示 PID 存活且 90 秒内有过心跳的会话。`lwctl set` 通过 `control.json` 下发，目标进程回执到 `control-state.json`。

## Web 看板

```bash
lwctl board            # http://127.0.0.1:8099
LW_BOARD_HOST=0.0.0.0 lwctl board   # 允许局域网访问
```

页面：会话与模型切换、模型设置（下拉自 `pi --list-models`）、主动关怀开关、7 天用量、**记忆星图**（Canvas 3D 投影 + 星云背景图（压暗/模糊/暗角，跟随星图一起旋转），可拖拽旋转/滚轮缩放/**全屏**：记忆点按角色/类型着色，大小=激活/关联；日记金色；**印象是带光环的大星**，沿中心环排列、常显对象名，并用金色虚线连回**真实来源日期**的记忆；点任意星看原文）、**印象墙**（含「立即整理」，不影响 05:00 的每日整理）、FTS5 记忆检索、日记与某天对话、日志、手动快照。版面为「主视区 + 右侧控制栏」，窄屏自动单列。

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
├── memory-index.db          # FTS5 + 向量 + 强度索引（可重建）
├── models/                  # 语义模型缓存（157MB，可选）
├── pi-sessions/             # pi 会话文件
├── status/                  # 会话心跳
├── control.json / control-state.json
├── life-world.json          # 配置
├── pi-kaomoji.json
└── bin/                     # 安装的脚本
```

## 和其它三个分支的区别

| | `main`（opencode） | `pi-agent`（轻量） | `pi-agent-v2`（增强） | `adv`（本分支，实验） |
|---|---|---|---|---|
| 宿主 | opencode 插件 | pi 1.5 扩展 | pi 1.5 扩展 | pi 1.5 扩展 |
| 记忆检索 | 双字扫描 | 双字扫描 | FTS5 + 可选语义 + 遗忘曲线 | 同上 + ACT-R 激活 + Hebbian 联想 |
| 印象整理 | 无 | 无 | 无 | 每日归纳 + 本地/云端注入 |
| 模型 | 固定 | 热切换 + 自动兜底 | 同上 + 看板/lwctl 手切 | 同上 |
| 隐私抽屉 | 无 | 有 | 有（按会话、云端禁读） | 同上；纯云端不启用 |
| 主动关怀 | 无 | 无 | 随机想起/安静时段/天气 | 同上 |
| 看板 | 无 | 无 | Web 看板 | 看板 + 3D 记忆星图（全屏/星云） |
| 快照/守护/清理 | 无 | 无 | git 快照、桥接守护、tmp/日志清理 | 同上 |
| 定位 | 存档 | 轻量稳定 | 多功能 | 实验田 |

## 已知限制

- `adv` 是实验分支，暂未合回 `pi-agent-v2`；检索权重、印象调度、星图布局还可能继续调；
- 记忆星图背景图是 `pi/bin/nebula.jpg`，由 lwboard 的 `/nebula.jpg` 路由提供；换图只换文件，覆盖倍数在 `board.html` 里调；
- 语义检索是**可选**功能：依赖 480MB、模型 157MB，首次加载约 17 秒；CPU 回填历史较慢，进程需常驻一会儿才补全；
- 语义质量取决于语料与模型，纯关键词查询仍以 FTS5 为准；
- 看板无鉴权，默认只监听本机；
- 群会话不跨桥接重启保留（靠归档记忆续上）；
- 家会话每次启动是新会话（归档记忆负责连续）；
- 备份不做自动清理，用 `lwctl backup --gc/--reset` 手动处理；
- 所有功能面向 Linux；macOS 未做完整验证。
