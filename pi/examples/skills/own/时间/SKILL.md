---
name: 时间
description: 报当前本地时间和星期。对方问「现在几点 / 今天星期几」时用。
tags: 查询,时间,示例
run: bash scripts/now.sh
---

# 时间

示例技能，用来演示技能库怎么跑脚本。

## 用法

- 直接跑默认入口：`skill_run({ name: "时间" })`（走 frontmatter 的 `run:`）
- 指定脚本：`skill_run({ name: "时间", script: "scripts/now.sh" })`

## 输出

一行文本，格式 `YYYY-MM-DD HH:MM:SS 星期 时区`，例如：

```
2026-11-11 09:30:00 Wednesday CST
```

## 依赖

`date`（POSIX 自带），不需要额外安装。

## 验收

退出码 0，输出里带当天日期和星期，就算成功。
