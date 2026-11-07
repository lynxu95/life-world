/**
 * worlds/backup —— 世界数据的 git 快照
 *
 * 每次把 worlds/default 的内容同步进 worlds/backup/default/，再 git commit；
 * git 只存有变化的 blob，重复内容不额外占空间。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const ROOT = process.env.LIFE_WORLD_ROOT || join(homedir(), ".local/share/life-world")
const SRC = join(ROOT, "worlds/default")
const BACKUP = join(ROOT, "worlds/backup")
const DST = join(BACKUP, "default")

const BASE_ITEMS = ["identity", "conversations", "diary", "plan", "room", "表情包", "语音", "world.json"]

function git(args) {
  return spawnSync("git", args, { cwd: BACKUP, encoding: "utf8" })
}

export function backupWorld({ includePrivate = false } = {}) {
  if (!existsSync(SRC)) return { ok: false, msg: `没有世界目录：${SRC}` }
  mkdirSync(DST, { recursive: true })
  if (!existsSync(join(BACKUP, ".git"))) {
    git(["init", "-q"])
    git(["config", "user.email", "life-world@localhost"])
    git(["config", "user.name", "life-world"])
  }
  const items = [...BASE_ITEMS, ...(includePrivate ? ["机密抽屉"] : [])]
  for (const item of items) {
    const from = join(SRC, item)
    if (!existsSync(from)) continue
    cpSync(from, join(DST, item), { recursive: true, force: true })
  }
  writeFileSync(join(BACKUP, ".gitignore"), "*.tmp\n")
  git(["add", "-A"])
  const message = `snapshot ${new Date().toISOString()}${includePrivate ? " (private)" : ""}`
  const commit = git(["commit", "-m", message, "--allow-empty"])
  const out = `${commit.stdout || ""}${commit.stderr || ""}`.trim()
  const ok = commit.status === 0
  return { ok, msg: ok ? `快照完成：${message}` : `快照失败：${out.slice(0, 200)}`, dir: BACKUP }
}

export function backupLog(limit = 5) {
  if (!existsSync(join(BACKUP, ".git"))) return []
  const r = git(["log", `-n${limit}`, "--format=%h %ad %s", "--date=iso"])
  if (r.status !== 0) return []
  return String(r.stdout || "").trim().split("\n").filter(Boolean)
}

export function backupSize() {
  if (!existsSync(DST)) return "0MB"
  let total = 0
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      try { total += statSync(p).size } catch { /* ignore */ }
    }
  }
  try { walk(DST) } catch { /* ignore */ }
  return `${(total / 1024 / 1024).toFixed(1)}MB`
}

// 作为脚本直接调用：node world-backup.mjs [--private]
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = backupWorld({ includePrivate: process.argv.includes("--private") })
  console.log(r.msg)
  process.exit(r.ok ? 0 : 2)
}
