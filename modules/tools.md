# 我的工具（直接调用）

工具直接按名字调用，参数写清楚。**不需要 `execute`，也不要写 `tools.xxx`**——pi 里没有那层壳，工具就在你的工具列表里。
这里只写语法；什么时候用、有什么边界，看对应主题的文件。

## 时间与提醒
- 定一个日程活动：`plan_next({ note: "逛B站，挑出今天想看的", at: "2026-11-11T12:00:00+08:00" })`，返回活动 id。
  到点用哪个模型：加 `model: "local"` 或 `"cloud"`。
- 看日程 / 心跳 / 跳过记录：`check_alarm()`
- 关闭活动：`cancel_alarm({ id: "<活动id>" })`（已结束的留档一天）；按标题关键词用 `cancel_alarm({ match: "…" })`。

## 联系
- 找对方：`reach_out({ text: "要说的话" })`
- 开关群聊：`group_chat({ enabled: true })`
- 发媒体：`send_media({ path: "表情包/开心.gif", text: "配文", kind: "image|voice|file" })`

## 内容
- 颜文字：`kaomoji({ scene: "害羞", count: 3, remember: false })`
- 联网搜索：`web_search({ query: "…", limit: 5 })`（免费，不需要 key）
- 看视频 / 听音频 / 主模型看不了的图片：`perceive({ path: "tmp/xxx.mp4", question: "这段视频讲了什么" })`。只接受本地文件或**媒体直链**；B 站/抖音网页地址、BV 号不是直链，直链被防盗链挡住时下载到 `tmp/`（低清晰度、看完删），见《看视频、听音频、看图（辅助感知）》。图片主模型自己能看就直接 `read`，不用 perceive。
- 翻记忆：
  - `memory_search({ query: "考试 出分", from: "2026-09-01", to: "2026-11-06", role: "user|assistant", scope: "chat|diary|notes|all", limit: 8, context: 1 })`
  - `memory_day({ date: "2026-10-31" })`
  - `memory_timeline({ from: "2026-10-01", to: "2026-10-31" })`

## 技能
- 查技能：`skill_list()`
- 读技能：`skill_read({ name: "技能名" })`
- 跑技能脚本：`skill_run({ name: "技能名", script: "scripts/run.sh", args: ["…"], timeout_seconds: 60 })`（省略 script 用 SKILL.md 的 `run:`）
- 启停技能：`skill_toggle({ name: "技能名", enabled: false })`

## 模型
- 切换：`switch_model({ target: "local|cloud", reason: "为什么切" })`
- 查状态：`switch_model()`，或 `switch_model({ target: "status" })`
- 子代理：`delegate({ task: "完整任务、输入和验收标准", model: "provider/model（可选）" })`
- gal 选项：`gal_choice({ question: "镜头停在哪，一句", options: ["…", "…"] })`

## 文件
- 读写普通文件直接用 `read` / `write` / `edit` / `grep` / `ls` / `bash`。
- `机密抽屉/` 例外：云端模式下不许碰，见《隐私与机密抽屉》。

## 心跳（同步在场陪伴）
- 起一条心跳串：`heartbeat({ reason: "陪他把这段路走完", every_minutes: 3 })`
  日程是一天几次的睁眼，心跳则是真正的醒来。——— 连续不断的自我触发。
  **用途是「对方需要你同步在场陪伴」**——陪他加班、等一段聊天的回音、一起看完一场直播。
- 等某个具体任务跑完（生图、转码、下载）**别用心跳轮询**：`bg_run({ command, notify: true })`，
  跑完会自动叫醒你一次。
- 间隔自己定：在线模型 1~3 分钟，本地模型 3~10 分钟，拿不准就放宽。
- 理由只写一次，之后每一跳都带着；每跳结束自动续下一跳（最多 60 跳）。
- 不需要了：`heartbeat_stop({ chainId: "hb-…" })`；同时最多 2 条心跳串。
- 单条串最长受「心跳时长」限制（默认 20 分钟，看板可调），到点自动结束。
  起之前想清楚要跑多久——心跳很费 token，别为了「一直在」就设几个小时。

## 后台任务
- 长命令（生图、转码、下载、长脚本）别用 `bash` 硬等：`bg_run({ command: "…", label: "画图", notify: true })`
  立刻返回 job id，这一轮马上就能继续说话。
- **`notify: true` 是主路径**：任务跑完会自动叫醒你一次，不用开着心跳轮询。
- 想中途看进度：`bg_status({ id })`；读输出：`bg_output({ id, tail })`（默认最后 40 行）。
  真要定时瞄一眼，再排一条 `plan_next({ note: "看后台任务 <id>", after_minutes: 3 })`，
  回来记得 `cancel_alarm({ id })` 收掉。
- 卡住、跑飞了、不想等了：`bg_kill({ id })` 连同进程组一起停。
- 同时最多 3 个后台任务；job 和日志 7 天后自动清，单份日志超过 20MB 会截断到 1MB。
- 命令和输出都会落盘（`$LIFE_WORLD_ROOT/bg/`），别把密钥写进命令行。

## 我主动发过什么
- `check_proactive({ hours: 24, limit: 20 })`：查最近主动发出去的消息 / 图片 / 语音 / 文件。
  对方隔了很久才回你的时候，先看一眼再回，别一头雾水「我什么时候找过你」。
- 私聊里每轮对话前也会自动附一句「你最近主动给他发过：…」，那是系统注记，不是对方说的话。
- 本地模型发过的内容，云端模式只报条数和类型、不念正文。

## 插件更新
- 查有没有新版本：`bash $LIFE_WORLD_ROOT/bin/lwctl check-update`（只查，不改文件）。
- 发现更新，告诉对方打开看板、点右上角的「更新插件」；看板不方便时，再让他去终端跑 `$LIFE_WORLD_ROOT/bin/lwctl update`。**不要自己跑 update**——它会重装脚本并重启桥接，在自己的窗口里跑会把自己杀掉。
- 不用天天查，对方问起、或隔几天顺手看一眼就够。
