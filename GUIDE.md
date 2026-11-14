# life-world 使用指引（pi 版）

> 这份文件是**给人看的操作手册**，插件不会自动读进上下文。角色实际读的行为规则在 `modules/`，首次引导走 `modules/help/first-meeting.md`；完整功能、配置项和原理见 `README.md`。
>
> 当前维护分支是 `pi-agent-adv`；这是 **pi 1.5 扩展**，不是 opencode 插件。工具直接按名字调用，没有 `execute` / `tools.xxx` 那一层。

---

## 0. 第一次启动

首次打开时，角色会先确认人格，再介绍自己的能力，然后**一次问一件事**引导配置：

| 项 | 说明 | 可以不设 |
|---|---|---|
| 模型 | 本地 / 在线两套，支持热切换；辅助感知模型（视频 / 音频 / 图片） | 可选，先用当前模型 |
| QQ 桥接 | 他的 QQ 号 + OneBot v11 服务端地址 / token | 可选，不接也能用终端和看板 |
| 看板 | 默认 `127.0.0.1:8099`，可改监听地址 / 端口 | 可选 |
| Python venv | 给技能用的隔离环境 `~/.local/share/life-world/venv` | 可选 |

用户说「先不设置 / 以后再说」就跳过，角色会记进 `identity/引导.md`，之后不再重复问。

想手动补配置时看下面的章节；所有配置项都在 `~/.local/share/life-world/life-world.json`。

---

## 1. 世界总开关

```json
"world": { "enabled": true }
```

- 改成 `false` 后**重启 pi**，扩展整体停用：不注入时间 / 记忆 / 心情、不挂工具、定时器不动；世界数据原地保留。
- 改回 `true` 再重启即可恢复。
- QQ 桥接是独立进程，不跟这个开关走；要停得单独 `lwctl restart` 或停进程。

---

## 2. 它能做什么

| 想做什么 | 怎么说 / 怎么用 |
|---|---|
| 跨会话记得 | 直接开新会话；新会话第一次会注入最近 48h + 记忆地图 + 自述 |
| 翻更早的事 | 「还记得上个月那件事吗」→ `memory_search` / `memory_day` / `memory_timeline` |
| 安排今天 / 提醒 | 「你打算做什么」「X 点提醒我」→ `plan_next`；想每隔几分钟回来看 → `heartbeat`；要「一直陪着」→ `heartbeat({ continuous: true })`（很费 token，需明确确认） |
| 看它在忙什么 | `check_alarm` |
| 写日记 / 记心情 | 每天回顾写 `diary/`、更新 `identity/心情.md` |
| 技能 | `skills/own`（自制）/ `skills/downloaded`（下载）；`skill_list` / `skill_read` / `skill_run` / `skill_toggle` |
| 看板 | 会话 / 模型 / 日程 / 用量 / 记忆星图 / 日记 / 日志 / 快照 |
| QQ | 私聊 / 群聊、语音 / 图片 / 文件；`reach_out` 主动找人 |
| 看视频 / 听音频 / 看图 | `perceive`；主模型自己能看的图片直接用 `read` |
| 换模型 | `switch_model` / 看板 / `lwctl set` |
| gal 模式 | 用户说「接下来由你主导」或「进入 gal 模式」；只在终端 TUI 有面板 |

工具都是**直接按名字调用**，例如：

```
plan_next({ note: "读半小时闲书，能说出一句印象最深的话就算做成", after_minutes: 30 })
check_alarm()
memory_search({ query: "考试 出分", limit: 5 })
perceive({ path: "tmp/xxx.mp4", question: "这段视频讲了什么" })
```

不需要 `execute`，也不要写 `tools.plan_next(...)`。

---

## 3. 模型

- `life-world.json` 的 `models.local` / `models.cloud` 是热切换的两个目标，写 `provider/model`。
- provider 和 API Key 在 `~/.pi/agent/models.json`（在线模型也可以用 `/login` 内置 provider）。
- 看板「模型」面板可以直接改本地 / 在线 / 分身 / 辅助感知；改完保存。
- 角色可以自己 `switch_model({ target: "local"|"cloud", reason })`；脚本会在模型无响应时自动兜底（本地保护开启时不会往本地掉）。
- 要打游戏 / 跑占显存的东西时开看板「模型设置 → 本地保护」，或让角色 `local_protect({ enabled: true })`：锁定期间只能用在线，闹钟标签不变、执行时改道。
- 辅助感知：`multimodal.model`（推荐 `dashscope/qwen3.8-omni-flash`），留空即停用；只补主模型缺的能力（视频 / 音频，或主模型不支持图片时的图片）。

```json
"models": { "local": "basalt/abliterated-iq3_xxs", "cloud": "deepseek/deepseek-flash", "autoFailover": true },
"multimodal": { "enabled": true, "model": "dashscope/qwen3.8-omni-flash", "timeoutMs": 300000 }
```

---

## 4. QQ 桥接（可选）

前提：**OneBot v11 服务端要单独部署**（NapCat / SnowLuma 等），由它登录 QQ、把消息转给桥接；正向 WebSocket，别暴露到公网。

配置 `life-world.json`：

```json
"bridge": {
  "enabled": true,
  "ownerQQ": 你的QQ号,
  "wsUrl": "ws://127.0.0.1:3001",
  "token": "有就填",
  "afterglow": { "enabled": true, "delayMs": 60000, "maxRounds": 2 }
}
```

启动 / 重启：

```bash
~/.local/share/life-world/bin/lwctl restart qq
# 或直接：node ~/.local/share/life-world/bin/pi-qq-bridge.mjs
```

日志：`~/.local/share/life-world/qq-bridge.log`，出现 `ws open` 才算接上。

- 私聊：只认 `ownerQQ`；文件 / 语音 / 图片会落到 `worlds/default/tmp/`，语音转 mp3 后可用 `perceive` 听。
- 群聊：默认关；用户说「打开群聊」→ `group_chat({ enabled: true })`。同一个 QQ 号别再接别的机器人，否则双回复。
- 余波：发完 60 秒没人回补一拍，最多两拍；`[SILENT]` 不发、不续。
- 任务型回复：模型调工具前先应的那句立刻发出去；闷头调工具就不代发提示，安静等最终结果。
- 私聊指令（不进会话队列，卡住时也能用）：
  - `/show` —— 看她卡在哪：正在跑的工具、参数摘要、这一轮跑了多久；
  - `/stop` —— 中断当前这一轮（先 `abort`，3 秒没停再 `abort_bash`），半截话不会发出来；
  - `/new` —— 清掉当前私聊会话。

---

## 5. 看板（可选）

```bash
~/.local/share/life-world/bin/lwctl board          # 默认 http://127.0.0.1:8099
~/.local/share/life-world/bin/lwctl board set 0.0.0.0 8099
~/.local/share/life-world/bin/lwctl board status
```

- 页面：概览（会话 / 模型 / 今日 / 用量 / 日程 / 事件 / 关怀）、日程、记忆（星图 / 印象墙 / 检索 / 日记 / 日志）。
- 默认只绑本机；改 `0.0.0.0` 后局域网内可访问。
- 监听地址 / 端口写在 `life-world.json` 的 `board` 段，环境变量 `LW_BOARD_HOST` / `LW_BOARD_PORT` 优先级更高。

---

## 6. 技能与 Python venv（可选）

```
worlds/default/skills/
├── INDEX.md
├── own/            # 自己手搓
└── downloaded/     # 网上下的
```

- `skill_list()` 刷新索引并列出；`skill_read({ name })` 读正文；`skill_run({ name, script?, args? })` 跑脚本；`skill_toggle({ name, enabled })` 启停。
- `skill_run` 只允许跑技能目录内的文件；云端模式不跑；默认 60 秒超时。
- **Python venv**：需要 Python 技能时，可以建一个隔离环境：

```bash
python3 -m venv ~/.local/share/life-world/venv
```

  建好后 `skill_run` 会**自动优先用** `~/.local/share/life-world/venv/bin/python`；也可以用环境变量 `LIFE_WORLD_PYTHON` 指定别的解释器。往 venv 里装包前先问用户；插件自身功能要用的包（如听 SILK 的 `pilk`）例外，可以直接装。
- venv 在 `worlds/default` 外面，不会进世界快照；重建世界数据不受影响。
- 这个 venv 也用来解 QQ 语音的 SILK：`venv/bin/python -m pip install pilk` 之后，桥接收到 SILK 会自己转成 wav；
  没装的话 AI 会按模块文档自己装上再让对方重发。

---

## 7. 数据、备份与排查

```
~/.local/share/life-world/
├── life-world.json          # 配置（600；含 QQ token，别外传）
├── debug.log                # 扩展日志
├── qq-bridge.log            # 桥接日志
├── memory-index.db          # 记忆索引（可重建）
├── status/                  # 会话心跳
├── pi-sessions/             # pi 会话原文
├── bin/                     # lwctl / lwboard / 桥接 / 家会话
└── worlds/default/          # 世界数据（真相）
    ├── identity/ conversations/ diary/ plan/ room/
    ├── 机密抽屉/ 表情包/ 语音/ tmp/ outbox/
    └── world.json
```

```bash
lwctl status                 # 各会话当前模型
lwctl tail qq|home|debug     # 看日志
lwctl backup [--private]     # 世界快照
lwctl usage [天数]            # token / 费用 / 切换次数
lwctl restart [qq|home|all]  # 重启常驻窗口
lwctl start                  # 起全部常驻（看板 + tmux 里的 qq / home，按平台挑脚本）
lwctl stop                   # 停全部常驻
lwctl update [--no-restart]  # 拉代码 + 重装脚本/提示词；数据/配置不动
```

常见问题：

| 现象 | 怎么办 |
|---|---|
| 工具一个都没有 | 确认 `./pi/install.sh --global` 跑过、扩展软链在；重启 pi |
| QQ 没反应 | `pgrep -af pi-qq-bridge`；`tail qq-bridge.log`；`lwctl restart qq` |
| 模型切不过去 | 看 `~/.pi/agent/models.json` 的 provider / key；`lwctl status` 看会话 |
| 上下文超限 | 会自动换新会话（QQ 桥接；home/CLI 轮次结束后） |
| 看板打不开 | `lwctl board status`；端口是否被占；`board.host` 是否只绑了本机 |
| 升级后行为没变 | `./pi/install.sh --global` 后重启对应窗口（`lwctl restart all`） |
| 重启机器后不说话 | 重启不会自动拉起，手动跑一次 `lwctl start`（或对应平台的 `start-*.sh`） |

---

## 8. 边界

- 不替用户做危险操作：花钱、下单、以他的名义对外发言、改账号设置——先问。
- `room/`、`表情包/`、`语音/`、`identity/`、`diary/`、`plan/` 是世界里的六个目录，可以增删改；这六个目录之外不随便动。
- 不主动做本机自检；只有用户说哪里坏了、或明确要求查某一项时，才去查对应那一处。
- 不给用户看别人的私密数据；群聊里不谈私聊内容。
- 拿不准就先问，别硬猜。
