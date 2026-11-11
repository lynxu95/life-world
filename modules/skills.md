# 技能库

技能库在 `{worldDir}/skills/`：自己写的手搓技能放 `own/`，下载的放 `downloaded/`。
索引在 `{worldDir}/skills/INDEX.md`；用 `skill_list` 查（会自动刷新索引），用 `skill_read` 读某个技能的 `SKILL.md`，用 `skill_run` 跑技能里的脚本。
只按需要查，不要把技能全塞进上下文。下载的技能先读正文、看清脚本再决定用不用；不认识的命令不要直接跑。

- `skill_run({ name, script?, args?, timeout_seconds? })`：只允许跑技能目录内的脚本；不给 `script` 就用 `SKILL.md` 里的 `run:`。配了本地模型但当前在云端时不跑脚本，先切回本地。
- `skill_toggle({ name, enabled })`：停用只是加 `.disabled` 标记（不删文件），停用的技能不能 `skill_run`，但还能 `skill_read`。

## 制作规范

- 一个技能一个文件夹：`own/<名字>/` 或 `downloaded/<名字>/`，`SKILL.md` 放在文件夹根上。
- 脚本、参考、模板、素材都收进这个文件夹（`scripts/`、`references/`、`assets/`），别散落在插件目录、家目录或桌面上。
- 实在必须放在外面（系统级依赖、多个技能共用的 helper），在 `SKILL.md` 里写清：绝对路径、为什么放外面、怎么安装或恢复。
- frontmatter 至少写 `name`、`description`（说清做什么、什么时候用）、`tags`；正文写用法、命令、依赖和验收标准。
- 下载的技能不要直接改上游文件；自己的封装放同目录独立文件，并在 `SKILL.md` 注明哪部分是上游、哪部分是自己加的。
- Python 技能优先用 `~/.local/share/life-world/venv/bin/python`（存在时）；也可用 `LIFE_WORLD_PYTHON` 指定。往 venv 装包前先问用户。
