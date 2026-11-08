# pi-agent-adv · 路线图

> 本分支已改名 `pi-agent-v2`（原 `pi-agent-adv`）。`pi-agent` 是轻量稳定版，会一直保留；v2 是多功能版。

## 进行中

- [x] **FTS5 记忆检索**：归档时写 `memory-index.db`（node:sqlite，trigram），`memory_search` 改查索引；3 字以上 `MATCH`、2 字 `LIKE` 回退；旧数据一次性导入。

## 下一步（已定，按序做）

- [x] **lwctl 扩展**：`backup`（打包世界数据，可选机密抽屉）、`tail`（看桥接/家会话最近动作）、`restart`（重启窗口）。
- [x] **守护与清理**：tmux 进程守护自动拉起；日志轮转；`tmp/` 定期清理。
- [x] **群聊配置热加载**：改关键词/开关不用重启桥接。
- [x] **用量面板**：token、云端调用次数、模型切换次数；并入 `lwctl`。
- [x] **主动关怀（高优先级）**：随机想起、天气/日程触发、安静时段。

## 已完成（续）

- [x] **CPU 语义检索（可选）**：transformers.js + jina-embeddings-v2-base-zh（q8），向量存 `vec` 表，与 FTS 混合排序。
- [x] **遗忘曲线**：`mem.strength` 命中加强、按半衰期每日衰减，只降权不删。
- [x] **Web 看板**。

## adv 实验（2026-11-08）

- [x] ACT-R 基级激活（access 表，频率×近因幂律）替换单强度排序
- [x] Hebbian 联想图（edges 表，共同召回增强、每日衰减、一跳扩散）
- [x] 印象整理：云端随时 / 本地 05:00 后跑，写 identity/印象.md

## 后备

- [x] **worlds/backup/ 定期快照**：在 `worlds/` 下新增 `backup/`，用 git 仓库做增量快照（省空间），定期提交；恢复时 `git checkout`。
- [x] **Web 小看板**：`lwctl board`，会话/模型切换/用量/记忆/日记/日志/快照。
- ~~**机密抽屉加密**~~：取消。

## 不做

- ~~多机同步/容灾~~（改为 worlds/backup 本地快照）。
