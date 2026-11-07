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
} else {
  console.log(`lwctl · life-world 会话工具

  lwctl                              交互菜单（推荐）
  lwctl status                       打印会话与模型
  lwctl targets                      列出可切换目标
  lwctl set <target> <model> [原因]  直接切换

  target：qq / home / group:<群号> / cli
  model ：local / cloud / provider/model`)
}
