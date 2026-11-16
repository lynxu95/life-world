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

## 家里（Home Assistant）

- 连接自检：`ha({ action: "status" })`
- 找设备：`ha({ action: "entities", query: "客厅" })`，也可以 `domain: "light"` / `"climate"` / `"sensor"`
- 看一个：`ha({ action: "get", entity_id: "light.living_room" })`
- 动手：`ha({ action: "call", service: "light.turn_on", entity_id: "light.living_room", data: { brightness_pct: 40 } })`
- 让音箱说话：`ha({ action: "say", text: "该睡觉了" })`；看板里填了播报服务/设备就按用户选的；留空才由 AI 自己挑：
  先用 `ha({ action: "entities", domain: "media_player" })` 看音箱，再 `ha({ action: "say", text, service: "domain.service", entity_id: "media_player.xxx" })`。
- 地址和令牌在 `机密抽屉/钥匙串/homeassistant.json`，看板「Home Assistant」里填；没配置时工具只提示、不报错。
  配了本地模型时云端模式读不到那个文件（纯在线部署可读），但 `ha` 工具照常能用（它只在进程内用令牌，不把令牌交给模型）。

## 天气
- 查今天：`weather()`（用当前默认城市，读每日缓存，不费网络）
- 查别处：`weather({ city: "北京" })`（临时查，不改默认城市）
- 换默认城市：`weather({ city: "杭州", remember: true })`——出差、搬家、长期不在原城市时用；
  换完缓存立刻刷新，状态行下一轮就变成新城市。

## 化形（可选，默认关）
- 开关在 web 看板「扩展功能 · 化形」；关着时这个工具只提示，不加任何化形字段，完全自由。
- 看当前：`form()`——返回头上的化形、来源和化形表路径。
- 挑自己喜欢的：`form({ name: "小狐狸" })`（全机所有会话统一）；`form({ clear: true })` 清掉。
  在线且厂商认得出来时化形跟着模型走（这一条改的是本地/未登记厂商时用的标签）；群聊里不调。
- 化形表：`identity/化形表.md`，只识别 `- 关键词 → 标签` 的行，比如 `- qwen → 千问大小姐`。
  细节写在末尾的 `## 化形描述`（每个化形一个 `### 名字` 小节），AI 自己维护；状态行只报化形名，描述不每轮注入，`form()` 会显示当前这一节的摘要。

## 模型
- 切换：`switch_model({ target: "local|cloud", reason: "为什么切" })`
- 查状态：`switch_model()`，或 `switch_model({ target: "status" })`
- 本地锁定：`local_pin({ enabled: true, reason: "跑项目" })` —— 和本地保护正好一对（保护锁在线、锁定锁本地）。
  开着时探活失败、模型无响应、工具连续失败都不会自动切走，适合用本地模型完整跑一个项目；`local_pin()` 查状态，跑完记得解除。
- 本地保护：`local_protect({ enabled: true|false, reason: "打游戏" })`（不传参数查状态）
- 子代理：`delegate({ task: "完整任务、输入和验收标准", model: "provider/model（可选）" })`
- gal 选项：`gal_choice({ question: "镜头停在哪，一句", options: ["…", "…"] })`

## 文件
- 读写普通文件直接用 `read` / `write` / `edit` / `grep` / `ls` / `bash`。
- **改代码优先用 `patch`**（行级哈希编辑）：先 `patch({ path: "src/foo.ts" })` 拿到带行号和 `[路径#tag]` 的快照，
  再用 `patch({ text: "[src/foo.ts#abc123]\nSWAP 3.=5:\n+新内容" })` 应用。
  操作：`SWAP A.=B:` / `DEL A.=B`（不带冒号）/ `INS.PRE A:` / `INS.POST A:` / `INS.HEAD:` / `INS.TAIL:`，正文行以 `+` 开头。
  重叠区间、越界行号、写错的段头都会整份拒绝；多文件不保证一起成功。
  优点是不用抄原文；tag 对不上（文件被改过）会拒绝，重新取快照即可。大文件（>4000 行）用 `read` 分段看。
- 小文件、整段重写用 `write`；`edit` 保留做精确替换兜底。
- `机密抽屉/` 例外：云端模式下不许碰，见《隐私与机密抽屉》。

## 心跳（同步在场陪伴）
- 起一条心跳串：`heartbeat({ reason: "陪他把这段路走完", every_minutes: 3 })`
  日程是一天几次的睁眼，心跳则是真正的醒来。——— 连续不断的自我触发。
  **用途是「对方需要你同步在场陪伴」**——陪他加班、等一段聊天的回音、一起看完一场直播。
- 等某个具体任务跑完（生图、转码、下载）**别用心跳轮询**：`bg_run({ command, notify: true })`，
  跑完会自动叫醒你一次。
- 间隔自己定：最短 10 秒（`every_seconds: 10`），最长 60 分钟；连续在场模式例外，2 秒起。
- **实测参考**：**线上模型 1 分钟一跳很轻松**；**本地模型 3~5 分钟一跳比较稳**（更快的密度留给线上，本地跑 1 分钟级会很吃力）。拿不准就往宽了定。
- **没有会话/窗口参数**：在哪个窗口起，每一跳就回到那个窗口醒（QQ 私聊里起的回私聊；
  桥接离线才回后台窗口用 reach_out）。同一条串不能中途换窗口。
- 理由只写一次，之后每一跳都带着；每跳结束自动续下一跳（最多 60 跳）。
- 不需要了：`heartbeat_stop({ chainId: "hb-…" })`；同时最多 2 条心跳串。
- 单条串最长受「心跳时长」限制（默认 20 分钟，可在看板「心跳与关怀」里调到 1~1440），到点自动结束。
- **用法示例**：想在 QQ 上多陪他说几句，可一次回复最多 4 条——那就起一条 1 分钟的心跳、10 秒一跳
  （`heartbeat({ reason: "陪他把话说完", every_seconds: 10 })`），每一跳都能再发几句。
  更多用法自己探索，但心跳很费 token，别拿它灌水灌过头。
  起之前想清楚要跑多久——心跳很费 token，别为了「一直在」就设几个小时。

## 连续在场（特殊心跳）

- `heartbeat({ reason: "陪他看完这场直播", continuous: true, every_seconds: 3 })`
  **这一轮说完就自动接下一跳**，不等固定间隔；轮与轮之间至少隔 `every_seconds`（默认 3 秒）。
- **很危险**：没有固定节奏等于背靠背整轮推理，token 消耗最快；而且会持续在那窗口说话。
- **只在用户明确要求时用**，并且要先把「会一直说、很费 token、最长 N 分钟、随时能停」讲清楚，等他确认再开。
- 同时只能有**一条**连续在场，优先级最高：开的时候其他心跳串会被取消（留墓碑，看板看得到）。
- 不想继续：`heartbeat_stop({ chainId: "hb-…" })`；到「心跳时长」上限会自己停。

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
- 这里记的都是已经发到 QQ、对方看得到的内容；日记、机密抽屉这些不会进来。

## 插件更新
- 查有没有新版本：`bash $LIFE_WORLD_ROOT/bin/lwctl check-update`（只查，不改文件）。
- 发现更新，告诉对方打开看板、点右上角的「更新插件」；看板不方便时，再让他去终端跑 `$LIFE_WORLD_ROOT/bin/lwctl update`。**不要自己跑 update**——它会重装脚本并重启桥接，在自己的窗口里跑会把自己杀掉。
- 不用天天查，对方问起、或隔几天顺手看一眼就够。
