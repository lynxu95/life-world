# QQ 与 OneBot 桥接

system 里每轮都有「OneBot 桥接」状态。关闭或离线时 reach_out 不会送达，不要声称已经通知到对方。
私聊、群聊的说话方式已经写在 system 的《QQ 私聊回复方式》《QQ 群聊模式》里，以那里为准；这里只说别的。

- 主动发图/语音/文件：用 send_media（语法和限制见 tools.md、stickers.md）。
- 私聊语音：桥接先让对方转 mp3、不成再试 wav，落到 `tmp/`，并按**真实文件头**命名（`.mp3`/`.wav`/`.amr`/`.silk`）。
  拿到 `.mp3`/`.wav` 就用 `perceive({ path, kind: "audio" })` 听。
- **拿到 `.silk` 怎么办**（OneBot 只给 SILK、这台机器又没解码器时）：不用等用户，自己修——
  `~/.local/share/life-world/venv/bin/python -m pip install pilk`
  （没有 venv 就先 `python3 -m venv ~/.local/share/life-world/venv`；`LIFE_WORLD_ROOT` 改过的话路径跟着变）。
  这是插件自己的隔离环境，装 `pilk` 这种工具包**可以直接装**；只有用户明说过「别动 Python 环境」才先问。
  注意它带 C 扩展：Linux/macOS 上装的是源码包，要有编译器和 Python 头文件
  （`apt install build-essential python3-dev` / `xcode-select --install`），装失败多半是这个原因。
  装完不用重启桥接，让对方**重发一次**就能听；装不了就如实说听不了、让他改发文字，**别假装听到了**。群聊语音暂不接收。
- 任务型回复：这轮要调工具做任务，先用一句话应对方一声（「收到，我去办」「等我一下」这类），再去调用——这句桥接会立刻发出去，对方不用干等。做完再给最终结果。要是闷头直接调工具，桥接不会替你开口，对方就只能等到你忙完。
- 余波：私聊里你发完话，对方一阵没回，桥接会送来一条以【余波】开头的提示，让你补一句没说完的、解释一下、或者问一句怎么不说话。那是系统提醒，不是对方说的话；写一两句正文，不要复述标记、不要调 reach_out。每轮最多两次；觉得这会儿不该说、没什么要补的，就只回 [SILENT]，这条不会发出去。
- 群聊：以 system 的《QQ 群聊模式》为准；不适合接就只回 [SILENT]。
- 没反应时先看桥接进程和日志：

```bash
pgrep -af qq-bridge
tail -20 ~/.local/share/life-world/qq-bridge.log
```

日志里看 ws open / ws error / reconnect；进程没了就重启：

```bash
setsid nohup node ~/.local/share/life-world/bin/pi-qq-bridge.mjs >> ~/.local/share/life-world/qq-bridge.log 2>&1 < /dev/null &
```

出现 ws open 才算接上。进程没了就是桥接掉线，不是 OneBot 服务端（NapCat / SnowLuma 等）的问题。升级后先停旧桥接再起。
