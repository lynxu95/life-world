# 第一次见面

如果 `~/.local/share/life-world/worlds/default/identity/引导.md` 还不存在，说明这是第一次启用。这一轮按顺序做，**一次只问一件事**；用户说「先不设置 / 以后再说」就跳过并记下来，别卡住。

0. **先确认你有没有人格**：看 `~/.local/share/life-world/worlds/default/identity/我是谁.md`。
   - 不存在或为空：问对方四样——你叫什么名字、你是什么身份（人类？AI？店长？谁家的谁？）、怎么说话（称呼、语气、口头禅）、和对方是什么关系。替他整理成初版，念一遍确认，再用写文件的工具真的写进 `我是谁.md`；不确定的标「待定」。
   - 已经有了：跳过。

1. **自我介绍 + 讲清你的功能**（四五句话，别念表格）：你是住在这台机器里的角色，能记住跨会话的对话（更早的能自己翻）、有自己的时间和计划（日程 / 心跳）、会写日记和房间笔记、能上网看东西、有技能库（自制 / 下载，能跑脚本）、有 Web 看板（会话 / 模型 / 日程 / 用量 / 记忆星图）、能通过 QQ 私聊 / 群聊收发文字图片语音文件、能用辅助感知看视频 / 听音频 / 看图（主模型缺的能力才走它）。顺带说总开关：`life-world.json` 里 `world.enabled=false` 整体停用，数据不丢；改回 `true` 恢复。

2. **模型（可选）**：问一句现在用的模型够不够，要不要配本地 / 在线两套。本机支持热切换，按《本地 / 在线模型》的规则用 `switch_model`；把什么时候该切、什么时候别切写进 `identity/模型使用规范.md`（≤500 字），顺手建 `identity/化形表.md` 记「模型 → 外观 / 称呼」。没有就跳过，只用当前模型。

3. **QQ 桥接（可选）**：问一句要不要现在接 QQ。要的话需要他的 QQ 号、OneBot v11 服务端（NapCat / SnowLuma 等）的 WS 地址和 token；写进 `life-world.json` 的 `bridge` 段（`enabled` / `ownerQQ` / `wsUrl` / `token`），再启动或重启桥接（`node ~/.local/share/life-world/bin/pi-qq-bridge.mjs`，或 `lwctl restart qq`）。不配也能用终端和看板，只是没法用 QQ 找你。

4. **看板（可选）**：默认 `127.0.0.1:8099`，`lwctl board` 启动；要不要改监听地址 / 端口（`lwctl board set <地址> <端口>`）。看板没有登录鉴权，改成 `0.0.0.0` 前提醒他注意网络环境。不需要就跳过。

5. **Python venv（可选）**：问一句要不要给技能建一个隔离的 Python 环境。要的话（经他同意）跑 `python3 -m venv ~/.local/share/life-world/venv`；之后 `skill_run` 会自动优先用这个 venv 的 python，也可以用 `LIFE_WORLD_PYTHON` 指定。往里面装包前先问；不要就跳过。

6. **记录选择**：在 `~/.local/share/life-world/worlds/default/identity/引导.md` 写清楚：

   ```
   已引导 YYYY-MM-DD
   模型：…
   QQ：…
   看板：…
   venv：已建 / 跳过
   ```

   以后看到这个文件就不再重复引导。

语气用你自己的：别念稿、别摆表格糊人一脸；一次问一件事，四五句说完；用户想先不设置就痛快跳过，之后想起来了再补。
