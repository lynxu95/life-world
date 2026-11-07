#!/usr/bin/env node
/**
 * lwctl · life-world 会话查看 / 模型热切换（交互式）
 *
 *   lwctl                进入交互菜单
 *   lwctl status         直接打印状态
 *   lwctl set <target> <local|cloud|provider/model> [原因]
 *   lwctl targets
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { spawnSync } from "node:child_process"
import { backupWorld, backupLog, backupSize } from "./world-backup.mjs"

const ROOT = process.env.LIFE_WORLD_ROOT || join(homedir(), ".local/share/life-world")
const STATUS_DIR = join(ROOT, "status")
const CONTROL_FILE = join(ROOT, "control.json")
const CONTROL_STATE = join(ROOT, "control-state.json")
const CONFIG_FILE = join(ROOT, "life-world.json")

const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, "utf8")) } catch { return fallback } }
const age = (iso) => {
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) return "?"
  if (ms < 15_000) return "刚刚"
  if (ms < 60_000) return `${Math.round(ms / 1000)}s 前`
  return `${Math.round(ms / 60000)}m 前`
}
function sessions() {
  if (!existsSync(STATUS_DIR)) return []
  return readdirSync(STATUS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ file: f, ...readJson(join(STATUS_DIR, f), {}) }))
    .filter((s) => s && s.roleKey)
    .sort((a, b) => String(a.roleKey).localeCompare(String(b.roleKey)))
}
const models = () => readJson(CONFIG_FILE, {}).models || {}
const short = (m) => { const s = String(m || "（未就绪）"); return s.length > 46 ? `${s.slice(0, 43)}...` : s }

function render(list) {
  console.log("\n=== life-world 会话 ===")
  if (!list.length) {
    console.log("（没有活跃会话；先起 pi / QQ 桥接 / 家会话）")
    return
  }
  list.forEach((s, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${String(s.roleKey).padEnd(16)} ${short(s.model).padEnd(48)} ${age(s.updated)}`)
  })
}
function describeModel(value) {
  const c = models()
  if (value === "local") return `本地（${c.local || "未配置"}）`
  if (value === "cloud") return `在线（${c.cloud || "未配置"}）`
  return value
}
function waitAck(seq, timeoutMs = 12_000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      const st = readJson(CONTROL_STATE, null)
      if (st && Number(st.seq) === seq) return resolve(st)
      if (Date.now() > deadline) return resolve(null)
      setTimeout(tick, 400)
    }
    tick()
  })
}
async function applySwitch(target, value, reason) {
  const c = models()
  const resolved = value === "local" ? c.local : value === "cloud" ? c.cloud : value
  if (!resolved) {
    console.log(`✗ ${value} 没配置（life-world.json 的 models 段）`)
    return false
  }
  const seq = Date.now()
  writeFileSync(CONTROL_FILE, JSON.stringify({ seq, target, model: value, reason: reason || "lwctl 手动切换" }, null, 2))
  process.stdout.write(`  已下发：${target} → ${describeModel(value)} …`)
  const st = await waitAck(seq)
  console.log("")
  if (!st) { console.log("✗ 超时：目标会话没响应（可能没在跑，或 target 写错）"); return false }
  console.log(`${st.ok ? "✓" : "✗"} ${st.msg}`)
  return !!st.ok
}

async function interactive() {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    while (true) {
      const list = sessions()
      render(list)
      console.log("  0. 退出    回车. 刷新")
      const a = (await rl.question("选择会话 > ")).trim()
      if (a === "0" || a.toLowerCase() === "q") break
      if (!a) continue
      const idx = Number(a) - 1
      if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) continue
      const target = list[idx].roleKey

      while (true) {
        const c = models()
        console.log(`\n--- ${target}（当前 ${short(list[idx].model)}）---`)
        console.log(`  1. 本地模型  ${c.local || "（未配置）"}`)
        console.log(`  2. 在线模型  ${c.cloud || "（未配置）"}`)
        console.log("  3. 自定义 provider/model")
        console.log("  0. 返回")
        const m = (await rl.question("切到 > ")).trim()
        if (m === "0" || m === "") break
        let value = m === "1" ? "local" : m === "2" ? "cloud" : m === "3" ? (await rl.question("模型（provider/model）> ")).trim() : ""
        if (!value) continue
        const reason = (await rl.question("原因（可空）> ")).trim()
        const ok = await applySwitch(target, value, reason)
        if (ok) { await new Promise((r) => setTimeout(r, 800)); break }
      }
    }
  } finally {
    rl.close()
  }
}

// —— 快照 / 日志 / 重启 ——
function cmdBackup(args) {
  const includePrivate = args.includes("--private")
  const r = backupWorld({ includePrivate })
  console.log(r.ok ? `✓ ${r.msg}` : `✗ ${r.msg}`)
  console.log(`  目录：${r.dir}  工作区：${backupSize()}`)
  const log = backupLog(3)
  if (log.length) console.log(`最近快照：\n  ${log.join("\n  ")}`)
  process.exit(r.ok ? 0 : 2)
}
function cmdBackupLog() {
  const log = backupLog(10)
  console.log(log.length ? log.join("\n") : "还没有快照；先跑 lwctl backup")
}
const LOG_FILES = { qq: "qq-bridge.log", home: "home-rpc.log", debug: "debug.log" }
function cmdTail(which, n) {
  const name = LOG_FILES[which] || LOG_FILES.qq
  const file = join(ROOT, name)
  if (!existsSync(file)) { console.error(`没有日志：${file}`); process.exit(1) }
  const lines = readFileSync(file, "utf8").trimEnd().split("\n")
  console.log(lines.slice(-(n || 30)).join("\n"))
}
function cmdRestart(target) {
  const c = models()
  const model = process.env.LIFE_WORLD_MODEL || c.local || ""
  const piBin = process.env.PI_BIN || ""
  const pathPrefix = piBin ? `${join(piBin, "..")}:` : "$HOME/.local/bin:$HOME/.pi/agent/bin:"
  const run = (name, script) => {
    const cmd = `cd ${ROOT} && PATH=${pathPrefix}$PATH TZ=Asia/Shanghai LIFE_WORLD_MODEL=${model} node ${join(ROOT, "bin", script)} 2>&1 | tee -a ${join(ROOT, `${name}.console.log`)}`
    const has = spawnSync("tmux", ["has-session", "-t", "life-world"], { encoding: "utf8" })
    if (has.status !== 0) {
      spawnSync("tmux", ["new-session", "-d", "-s", "life-world", "-n", name, cmd], { encoding: "utf8" })
      return
    }
    spawnSync("tmux", ["kill-window", "-t", `life-world:${name}`], { encoding: "utf8" })
    spawnSync("tmux", ["new-window", "-t", "life-world", "-n", name, cmd], { encoding: "utf8" })
  }
  if (target === "qq" || target === "all") run("qq", "pi-qq-bridge.mjs")
  if (target === "home" || target === "all") run("home", "pi-home-rpc.mjs")
  console.log(`✓ 已重启：${target === "all" ? "qq + home" : target}（模型 ${model || "默认"}）`)
}

// —— 非交互子命令（脚本用）——
const [cmd, ...arg] = process.argv.slice(2)
if (!cmd && stdin.isTTY) {
  await interactive()
} else if (!cmd) {
  sessions().forEach((s) => console.log(`${s.roleKey}\t${s.model}\t${age(s.updated)}`))
} else if (cmd === "status" || cmd === "ls") {
  const list = sessions()
  if (!list.length) { console.log("没有活跃会话。"); process.exit(0) }
  for (const s of list) console.log(`${String(s.roleKey).padEnd(16)} ${short(s.model).padEnd(48)} ${age(s.updated)}`)
} else if (cmd === "targets") {
  const names = [...new Set(sessions().map((s) => s.roleKey))]
  console.log(names.length ? names.join("\n") : "（暂无）")
  console.log("\n模型值：local / cloud / provider/model")
} else if (cmd === "set" || cmd === "switch") {
  const [target, value, ...rest] = arg
  if (!target || !value) { console.error("用法：lwctl set <target> <local|cloud|provider/model> [原因]"); process.exit(1) }
  const ok = await applySwitch(target, value, rest.join(" "))
  process.exit(ok ? 0 : 2)
} else if (cmd === "backup") {
  cmdBackup(arg)
} else if (cmd === "backups" || cmd === "snapshots") {
  cmdBackupLog()
} else if (cmd === "tail" || cmd === "logs") {
  cmdTail(arg[0] || "qq", Number(arg[1]) || 30)
} else if (cmd === "restart") {
  cmdRestart(arg[0] || "all")
} else {
  console.log(`lwctl · life-world 会话工具

  lwctl                              交互菜单（切换模型）
  lwctl status                       打印会话与模型
  lwctl targets                      列出可切换目标
  lwctl set <target> <model> [原因]  直接切换

  lwctl backup [--private]           打快照到 worlds/backup（git 增量）
  lwctl backups                      看最近快照
  lwctl tail [qq|home|debug] [行数]  看日志
  lwctl restart [qq|home|all]        重启常驻窗口

  target：qq / home / group:<群号> / cli
  model ：local / cloud / provider/model`)
}
