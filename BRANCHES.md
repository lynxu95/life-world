# 分支导航

life-world 同一个仓库里有四条分支。默认分支 `main` 是 opencode 插件版；另外三条是 pi 1.5 的移植与演进。
选之前先看「为什么会有四条」和「一张表」，再看「血缘关系」和「怎么选」。

## 为什么会有四条

- `main`（opencode）：最早的原版，依赖 opencode v2 的插件和共享服务。本地小模型经 opencode 调用效果不理想。
- `pi-agent`：把 opencode 版的能力基本移植到 pi 1.5，做了少量优化；定位是轻量、稳定。
- `pi-agent-v2`：pi 的扩展点很方便继续开发，于是在 pi-agent 上继续加功能（FTS5、语义检索、看板、快照、守护），形成增强版。
- `pi-agent-adv`：在 v2 上继续做记忆架构实验（ACT-R、Hebbian、印象、记忆星图），后来移除向量，形成仿生版。

## 一张表

| 分支 | 宿主 | 定位 | 记忆与检索 | 印象整理 | 看板 | 适合 |
|---|---|---|---|---|---|---|
| `main` | opencode v2 插件 | 原始版，零运行时依赖 | 跨会话注入 + 双字扫描 + 日记/笔记检索 | 无 | 无 | 还在用 opencode v2 |
| `pi-agent` | pi 1.5 扩展 | 轻量稳定（opencode 功能的 pi 移植 + 少量优化） | 归档 + 双字扫描 + 遗忘曲线 | 无 | 无 | 想从 opencode 迁到 pi，只要稳定 |
| `pi-agent-v2` | pi 1.5 扩展 | 增强 + 本地小模型向量 | FTS5 + 可选 jina 语义混合 + 遗忘曲线 | 无 | Web 看板 + 记忆星图 | 机器带得动 embedding，想要“意思相近”的检索 |
| `pi-agent-adv` | pi 1.5 扩展 | 仿生神经实验 | FTS5 + 遗忘曲线 + ACT-R 激活 + Hebbian 联想 | 每日归纳 + 注入 | 看板 + 记忆星图 + 印象墙 | 想要可解释、靠使用长出来的记忆；接受实验性 |

`pi-agent-v2` 和 `pi-agent-adv` 共享同一套 lwctl / lwboard / 看板前端；区别只在记忆架构：v2 保留向量，adv 去向量、换成 ACT-R + Hebbian + 印象。

## 血缘关系

> 提交号截至 2026-11-08，后续会继续前进。

```
main (opencode)
 └─ pi-agent (pi 1.5 轻量)
     └─ pi-agent-v2 (增强版基线 08fb636)
         ├─ pi-agent-v2 (c45374a)   # 保留向量 + 同步 lw 脚本/看板
         └─ pi-agent-adv (ebfea7d)  # 去向量，ACT-R/Hebbian/印象
```

- `pi-agent` 是 opencode 能力向 pi 1.5 的移植版，做了少量优化，定位轻量稳定。
- `pi-agent-v2` 因为 pi 的扩展点方便二次开发，在 pi-agent 上继续加：FTS5、语义检索、看板、快照、守护。
- `pi-agent-adv` 从 v2 的 `08fb636` 分出做记忆架构实验：ACT-R、Hebbian、印象、记忆星图；随后把语义向量从 adv 移除，形成“仿生版”。
- 两条 pi 高级分支不是简单的包含关系：v2 保留向量，adv 去向量；非记忆架构的 lw 脚本/看板更新两边同步。

## 怎么选

- 还在 opencode v2 → `main`
- 想要 pi 1.5、但机器弱/只想稳定 → `pi-agent`
- 想用本地小模型做“语义相近”的检索 → `pi-agent-v2`（装 `./pi/install.sh --semantic`）
- 想要可解释的仿生记忆（激活/联想/印象/星图），不需要向量 → `pi-agent-adv`
- 生产实例：395 跑 `pi-agent-adv`；测试容器 debian 用于试验。

## 安装

```bash
git clone -b <branch> https://github.com/lynxu95/life-world
cd life-world
./pi/install.sh --global
```

- `main` 是 opencode 插件，安装方式见 main 的 README。
- 三条 pi 分支用 `pi/install.sh`；v2 的 `--semantic` 装向量依赖，adv 没有这个参数。
- 世界数据统一在 `~/.local/share/life-world/`，切分支不丢；换分支前建议先 `lwctl backup`。

## 维护约定

- 记忆架构改动只在对应分支：向量 → v2；ACT-R/Hebbian/印象 → adv。
- lwctl / lwboard / 看板 / install 等非记忆架构更新，v2 和 adv 同步。
- `main` 是 opencode 存档，不再跟 pi 分支合并。
