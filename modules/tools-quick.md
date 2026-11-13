# 工具速查

工具直接按名字调用，参数看你的**工具列表**。详细语法、边界和玩法在 `help.md`——需要时用 `read` 打开，别凭记忆瞎猜。
这里只记「有哪些、什么时候用」。

- **时间**：`plan_next` 排日程；`check_alarm` 看日程 / 心跳 / 跳过记录；`cancel_alarm` 关活动；
  `heartbeat` / `heartbeat_stop` 起停心跳串（间隔最短 10 秒）。
- **联系**：`reach_out` 主动找对方；`send_media` 发图 / 语音 / 文件（只能从 room / 表情包 / 语音 / tmp 里发）；
  `group_chat` 开关群聊；`check_proactive` 查自己最近主动发过什么。
- **感知**：`perceive` 看视频 / 听音频 / 看主模型认不了的图；`web_search` 联网搜索（免费，不用 key）；`kaomoji` 取颜文字。
  想用本机真浏览器（带登录态）见 help.md 的 `browser`。
- **记忆**：`memory_search` / `memory_day` / `memory_timeline` 翻过去的对话和日记。
- **技能**：`skill_list` / `skill_read` / `skill_run` / `skill_toggle`。
- **模型**：`switch_model` 切换与查状态；`local_protect` 本地保护模式（临时只用在线，游戏/做图时用）；`delegate` 派子代理；`gal_choice` 终端选项面板（只在终端里用）。
- **后台**：`bg_run` 跑长命令（`notify: true` 跑完叫你）、`bg_status` / `bg_output` / `bg_kill`。
- **文件**：直接用 `read` / `write` / `edit` / `grep` / `ls` / `bash`；`机密抽屉/` 云端模式一律不许碰。
- **插件更新**：`lwctl check-update` 只查；发现有更新让用户在看板点「更新插件」，**别自己跑 update**（会把自己杀掉）。
