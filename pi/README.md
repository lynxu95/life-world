# life-world · pi 版

> 本目录是 life-world 的 **pi 1.5.0 版**，仓库里只有这一版。
> 分支：`pi-agent-adv` 是**当前唯一维护的版本**；`pi-agent` / `pi-agent-v2` 已归档（对应 tag 保留），
> 早期 opencode 插件版的源码已从仓库移除（归档 tag：`archive/main-20261111`）。
>
> 评估与决策见 vault：`AI/开发中项目/life-world 迁 pi · 扩展点评估.md`；
> 实施记录见 `AI/开发中项目/piagent 迁移 worklog.md`。

## 它是什么

把 life-world 从 opencode 插件搬到 pi 的原生扩展点：

- **工具**：`plan_next` / `check_alarm` / `check_proactive` / `cancel_alarm` / `reach_out` / `send_media` / `group_chat` / `kaomoji` / `memory_search` / `memory_day` / `memory_timeline` / `skill_list` / `skill_read` / `skill_run` / `skill_toggle` / `perceive` / `delegate` / `gal_choice` / `switch_model` / `local_protect` / `web_search` / `bg_run` / `bg_status` / `bg_output` / `bg_kill`
- **后台任务**：`bg_run` 把生图、转码、长脚本扔到 detached 进程，立刻返回 job id；`bg_status` / `bg_output` 查状态和输出，`bg_kill` 停掉。同时最多 3 个，日志 7 天清理、超 20MB 截断
- **模型热切换**：`switch_model` 让角色自己决定本地 / 在线；模型无响应立即切、工具连续失败两次切云端，另有脚本探活兜底；`local_protect` 可临时锁在在线
- **机密抽屉**：切云端前把之前的对话与机密文件收进 `worlds/default/机密抽屉/`，`用户画像-私密.md` 不预加载、本地需要时自己读，云端禁止打开该目录；没配本地模型则整个抽屉不启用
- **闹钟带模型**：`plan_next` 可指定到点用 `local` / `cloud`，定时器触发前先切过去
- **联网搜索**：`web_search` 走 TinyFish keyless，免 API Key
- **每轮状态**：`input` 事件把时间、心情、桥接状态拼进当前用户消息（不改 system，保护缓存）
- **归档**：`message_end` 写 `conversations/YYYY-MM-DD.jsonl`
- **记忆**：新会话首轮注入最近 48h / 2000 字 + 3 天记忆地图 + 自述；检索走 FTS5（`memory-index.db`，trigram，≥3 字 MATCH / 2 字 LIKE 回退）
- **记忆增强（pi-agent-adv）**：ACT-R 基级激活、Hebbian 联想、每日印象整理；看板 3D 记忆星图（全屏、星云背景随旋转）
- **定时器**：`LIFE_WORLD_ROLE=home` 的进程每 30 秒检查闹钟 / 每日回顾 / 早上兜底，用 `pi.sendMessage(triggerTurn)` 唤醒
- **QQ 桥接**：OneBot v11 正向 WS ↔ `pi --mode rpc`；私聊、余波、outbox、图片/语音/文件、基础群聊
  - 配了 `models.cloud` 时，**群聊会话优先在线模型**（判官也用在线模型），私聊仍用 `LIFE_WORLD_MODEL`（通常本地）
  - 群聊触发：@ / 关键词 / 5% 随机插话；群聊配置热加载（2 秒缓存），改 `life-world.json` 不用重启
- **子代理**：`delegate` 起独立 `pi -p` 子进程，零第三方扩展，深度限制 1 层
- **gal**：`gal_choice` 工具用 `ctx.ui.select` 抛单选面板（仅终端 TUI；QQ 无面板）

## 要求

| 项 | 要求 |
|---|---|
| pi | **1.5.0+** |
| Node | **22.19+**（桥接用全局 WebSocket；记忆索引用 `node:sqlite`，要 ≥ 22.13） |
| OneBot | 任意 OneBot v11 正向 WS 服务端（SnowLuma / NapCat 等；只在跑 QQ 桥接时需要） |
| 系统 | **Linux / macOS / WSL**（原生 Windows 走 WSL；TUI 不是必须） |
| 常驻 | `tmux`（QQ 桥接和家会话跑在里面；`lwctl start` 一键拉起） |
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
git clone -b pi-agent-adv https://github.com/lynxu95/life-world
cd life-world

./pi/install.sh --global     # 全局：所有 pi 会话都加载（默认）
# 或
./pi/install.sh --project   # 项目级：只在 life-world 目录生效
```

它做这几件事：

0. 先打印环境检查（系统 / Node 版本 / tmux / ffmpeg），缺什么会给出对应平台的安装提示；
1. 建 `~/.local/share/life-world/{worlds/default,pi-sessions}`；
2. 把 `data/kaomoji.json` 复制成 `~/.local/share/life-world/pi-kaomoji.json`；
3. 用 `build-prompt.mjs` 生成两份：`modules/*.md` → `pi/prompt/world.md`（进 system，只放必须常驻的）；
   `modules/help/*.md` → `~/.local/share/life-world/help.md`（不进 system，AI 需要时自己 read）；
4. 把扩展软链到 pi 的自动发现目录：
   - 全局：`~/.pi/agent/extensions/life-world/index.ts`
   - 项目级：`<仓库>/.pi/extensions/life-world/index.ts`
5. 把 `browser-*`、`pi-qq-bridge.mjs`、`pi-home-rpc.mjs`、`lwboard.mjs`、三份 `start-{linux,macos,wsl}.sh` 复制到 `~/.local/share/life-world/bin/`，并放一份扩展在 `~/.local/share/life-world/ext/`（桥接脚本默认从那里找）。

**扩展会自己在每轮开始前确保世界规则在 system 里**（`prompt/world.md` 缺失时用 `modules/` 现拼，同时把 `modules/help/` 写成 `$ROOT/help.md`），所以不需要 `--append-system-prompt`，也不需要改 `APPEND_SYSTEM.md`。

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

## 记忆检索与遗忘曲线

- **FTS5**：归档时写入 `memory-index.db`（trigram，WAL + busy_timeout），`memory_search` 优先查索引：≥3 字 `MATCH/BM25`，2 字 `LIKE`；历史回填只在 home 进程做，避免多进程抢锁。
- **不做向量检索**：本分支只走 FTS5 + ACT-R/Hebbian，不装 `transformers.js`、不建 `vec` 表；需要 jina 语义相似检索请参考已归档的 `pi-agent-v2` 分支。
- **遗忘曲线**：每条记忆带强度（初始 1.0）。被检索命中 +`hitBoost`（上限 `maxStrength`）；每天按 `halfLifeDays` 衰减（下限 `minStrength`），只降权不删除。排序权重 = `0.7 + 0.3*min(1, strength/2)`。

```json
"memory": {
  "decay": { "enabled": true, "halfLifeDays": 30, "hitBoost": 0.15, "maxStrength": 3, "minStrength": 0.1 }
}
```

本分支不需要语义依赖；`./pi/install.sh --semantic` 已移除。

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
  "weatherCity": "上海"
}
```

- **安静时段**：`quietStart ~ quietEnd`（可跨午夜）内不发随机消息；
- **看板可开关**：`lwctl board` 页面里勾掉「随机想起」即全天安静；
- **随机想起**：安静时段外，距上次至少 `randomMinGapHours` 小时，每个 tick（30 秒）以 `randomChancePerTick` 概率触发一次「想起你」，角色自己决定 `reach_out` 还是 `[SILENT]`；
- **天气**：早上兜底唤醒时用 `wttr.in` 取 `weatherCity` 的天气，附在唤醒文本里。

## 守护与清理

- **桥接守护**：家会话每个 tick 检查 `status/qq-*.json` 心跳；超过 `guard.staleSeconds` 没更新就调 `lwctl restart qq` 拉起，冷却 `guard.cooldownMinutes`。
- **家会话自愈**：`home-rpc.mjs` 的 pi 子进程退出后自动重启（2s 起指数退避，最长 60s；稳定跑满 1 分钟重置），`SIGTERM/SIGINT` 时才真正退出。
- **tmp 清理**：每天一次，删除 `worlds/default/tmp/` 里超过 `cleanup.tmpMaxAgeHours` 的附件。
- **日志轮转**：`debug.log`（5MB）、`qq-bridge.log`、`home-rpc.log` 超限自动切 `.1`。

```json
"guard": { "enabled": true, "staleSeconds": 300, "cooldownMinutes": 10, "allowRestart": true },
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
  "multimodal": { "enabled": false, "model": "", "timeoutMs": 300000, "warnImageBytes": 8388608, "warnVideoBytes": 209715200 },
  "localModel": { "enabled": true, "keepRecent": 20, "foldToolResults": 6, "resultChars": 300 },
  "models": {
    "local": "basalt/abliterated-iq3_xxs",
    "cloud": "deepseek/deepseek-flash",
    "autoFailover": true,
    "localHealthUrl": "",
    "cloudHealthUrl": "",
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
lwctl backup --gc                  # 压缩快照仓库
lwctl backup --reset               # 彻底删掉快照目录（手动清理用）
lwctl backups                      # 看最近快照
lwctl tail [qq|home|debug] [行数]   # 看日志
lwctl restart [qq|home|all]        # 重启常驻窗口
lwctl start                        # 起全部常驻（按平台挑 start-*.sh）
lwctl stop                         # 停全部常驻
lwctl update [--no-restart] [--project] [--branch <分支>]
                                   # 拉代码 + 重装脚本/提示词；数据/配置不动，默认重启
lwctl usage [天数]                 # 用量：token / 云端本地 / 切换次数
```

原理：每个扩展进程每 5 秒写一份心跳到 `~/.local/share/life-world/status/`；`lwctl` / 看板把命令**追加**到 `control/commands-YYYY-MM-DD.jsonl`（每行一条，唯一 id），目标进程按 `(at, id)` 水位轮询、执行后回执到 `control-acks/<id>-<roleKey>.json`。超过 60 秒的命令只推进水位不执行，重启不会重放；同一秒连发多条也不会互相覆盖。旧版 `control.json` 只做一次性兼容读取。配了本地模型时，切到在线会打开该会话的机密抽屉；没配本地模型（纯云端实例）则不启用抽屉，云端可看全量上下文与记忆块。

### 用量统计

`lwctl usage [天数]` 直接扫 `pi-sessions/*.jsonl` 里的 assistant usage：按天统计请求数、输入/输出/缓存读 token、费用、云端 vs 本地请求数，以及模型切换次数。

### 记忆星图与印象墙

看板分「概览 / 记忆」两页。记忆页的「记忆星图」：Canvas 做 3D 投影，可拖拽旋转/滚轮缩放/点击，支持**全屏**。背景是一张星云照片（`pi/bin/nebula.jpg`，lwboard 通过 `/nebula.jpg` 提供），跟着 yaw/pitch 平移；上面叠两层柔焦雾 + 一层分形云团，中心浓、外侧薄，缓慢呼吸/漂移。中心白色主星是自动注入的 identity 文档（我是谁/心情/用户画像/模型规范），不常显标签、**悬停或选中时显示**；主星之间是白色虚线，轻微呼吸发光。内外圈**差速旋转**：内圈快、外圈慢，平均速度保持原速。印象是金色大星，环形排列，金色虚线只连**真实来源日期**的记忆。召回边会随机跑青绿电流（普通边最快，短期印象紫、速度居中，长期印象金/日记琥珀最慢），点击节点沿边放电；悬停时旋转降速并聚焦邻居，普通节点悬停才显示标题。图例可分别开关记忆/日记/印象/文档，另有「连线」开关可隐藏所有连线与流动光点、只看星体分布（偏好记在浏览器本地）。下方是 `identity/印象.md` 的印象墙，可点「立即整理」额外触发一次，不会占用 05:00 的每日整理。

### Web 看板

```bash
lwctl board                      # 启动：默认 http://127.0.0.1:8099
lwctl board set 0.0.0.0 8099     # 保存监听地址/端口并重启
lwctl board status               # 运行状态、地址、接口
lwctl board stop
```

页面分「概览 / 记忆」两页：概览放会话、模型、用量、AI 日程、主动关怀；记忆放星图、印象墙、检索、日记、日志。概览的 **AI 日程**只列 `plan_next` 的闹钟，随机想起不显示。监听地址/端口写在 `life-world.json` 的 `board` 段。

### 世界快照

`worlds/backup/` 是一个独立的 git 仓库，`lwctl backup` 把 `worlds/default` 的 identity / conversations / diary / plan / room / 表情包 / 语音 / world.json 同步进去再提交；`--private` 才带上 `机密抽屉/`。git 增量存储，重复内容不重复占空间。

家会话每天 `backup.hour` 点后自动快照一次（`life-world.json` 的 `backup` 段，`includePrivate` 默认 false）；快照在子进程里跑，不阻塞主会话。**不做自动清理**：`lwctl backup --gc` 压缩、`lwctl backup --reset` 整个删除，由你决定。

### 技能库

- 世界目录下 `skills/own/`（自制）和 `skills/downloaded/`（下载）分开放；每个技能一个文件夹，`SKILL.md` 在根上；
- `skills/INDEX.md` 自动生成；AI 用 `skill_list()` 查索引、`skill_read({ name })` 读正文、`skill_run({ name, script? })` 跑脚本，平时不把列表注入上下文；
- `skill_run` 只允许跑技能目录内的文件；不给 `script` 就用 `SKILL.md` 的 `run:`；默认 60 秒超时、输出截断 2 万字符；配了本地模型又不在本地时不跑；
- `skill_toggle({ name, enabled })` 停用只是加 `.disabled` 标记，不删文件；
- 群聊不注册这四个工具；下载的技能会提示先确认内容；
- 脚本 / 参考 / 素材收在技能文件夹里，放外面的要在 `SKILL.md` 写清绝对路径和原因；`pi/examples/skills/own/时间/` 是示例。

### 日程 / 心跳

- `plan_next({ note, at|after_minutes, model })` 开一个**活动**，到点唤醒并保持 `active`；
- `heartbeat({ reason, every_minutes, note })` 起一条**心跳串**，独立于日程、固定间隔自动续跳（最多 60 跳），同时最多 2 条；`heartbeat_stop` 停掉；
- 心跳到点若 home 正在跑一轮，会顺延 30 秒再试，不会被跳过；
- 下一条主活动开始时，上一条还 `active` 的活动会被强制关闭并提醒；
- `cancel_alarm({ id })` 关闭日程；看板「日程 / 心跳」页可暂停/继续/关闭，心跳可单独停止；
- 安静时段只限制「随机想念」，不拦日程和心跳。

### 辅助感知

`perceive({ path, question, kind? })`：本地文件或公网 URL。图片主模型能看就直接 `read`，不走辅助；视频/音频、以及主模型不支持图片时的图片才交给 `multimodal.model`。本地 Base64 超 10MB 会先压缩，压不进去会返回建议分段；URL 直接传给百炼。B 站/抖音直链被防盗链挡住时，下载到 `tmp/`（低清晰度、只下相关片段、看完删）再喂本地文件；工具压缩产生的临时文件即时清理。完整限制和 DashScope provider 模板见根 README《辅助感知（多模态）》。

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

附件：图片超过 8MB 会自动缩到 1568px（需要 `imagemagick` 或 `ffmpeg`）；私聊工作文件不设大小上限，流式落盘到 `worlds/default/tmp/` 后把路径交给模型；群文件默认单文件 100MB、单批 200MB（`bridge.group.maxFileBytes` / `maxBatchBytes`）。

### SnowLuma / NapCat 只监听 127.0.0.1 时

从其他机器/容器连不上时，用 SSH 隧道（示例用文档保留地址 `192.0.2.10`，换成你自己的宿主机）：

```bash
sshpass -f /path/to/pw ssh -N -L 127.0.0.1:3001:127.0.0.1:3001 user@192.0.2.10
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
├── bin/rpc-adapter.mjs      pi RPC 报文契约（升级只改这里）
├── bin/qq-bridge.mjs        OneBot WS ↔ pi RPC 桥接
├── bin/home-rpc.mjs         家会话 RPC 常驻（定时器）
├── build-prompt.mjs         从 ../modules/*.md 生成 prompt/world.md；从 ../modules/help/*.md 生成 $ROOT/help.md
├── install.sh               安装/生成提示词
├── config.example.json      配置示例
└── prompt/world.md          生成物（install.sh 产出，不提交也行）
```
