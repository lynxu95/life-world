#!/usr/bin/env node
/**
 * life-world · pi home session (RPC 常驻，跑定时器)
 *
 * 用途：测试/部署时给「家会话」一个不带 TUI 的常驻进程。
 * 扩展在 LIFE_WORLD_ROLE=home 下每 30 秒检查闹钟/回顾/兜底，并通过
 * pi.sendMessage(triggerTurn) 唤醒自己；这里把 assistant 文本打到日志。
 *
 * 用法：
 *   TZ=Asia/Shanghai node home-rpc.mjs
 *   TEST_MS=90000 node home-rpc.mjs    # 测试时自动退出
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { spawn } from "node:child_process"
import { isMessageEnd, isAgentSettled, isExtensionUIRequest, isAssistant, textOf, reqExtensionUIResponse } from "./rpc-adapter.mjs"

const ROOT = process.env.LIFE_WORLD_ROOT || join(homedir(), ".local/share/life-world")
const LOG = join(ROOT, "home-rpc.log")
const HERE = dirname(fileURLToPath(import.meta.url))
const PI = process.env.PI_BIN || "pi"
const EXT = process.env.LIFE_WORLD_EXT || join(HERE, "../ext/life-world.ts")
const MODEL = process.env.LIFE_WORLD_MODEL || "deepseek-flash"
const TZ = process.env.TZ || "Asia/Shanghai"
const SESSION_DIR = join(ROOT, "pi-sessions")
mkdirSync(SESSION_DIR, { recursive: true })
// 日志超过 5MB 就轮转
try {
  if (existsSync(LOG) && statSync(LOG).size > 5 * 1024 * 1024) {
    try { if (existsSync(`${LOG}.1`)) renameSync(`${LOG}.1`, `${LOG}.2`) } catch { /* ignore */ }
    renameSync(LOG, `${LOG}.1`)
  }
} catch { /* ignore */ }

// 长期不重启也要轮转
setInterval(() => {
  try {
    if (existsSync(LOG) && statSync(LOG).size > 5 * 1024 * 1024) {
      try { if (existsSync(`${LOG}.1`)) renameSync(`${LOG}.1`, `${LOG}.2`) } catch { /* ignore */ }
      renameSync(LOG, `${LOG}.1`)
    }
  } catch { /* ignore */ }
}, 6 * 60 * 60_000).unref?.()

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`
  try { appendFileSync(LOG, line + "\n", { mode: 0o600 }) } catch { /* ignore */ }
  if (process.stdout.isTTY) console.log(line)
}

const args = ["--mode", "rpc", "--model", MODEL, "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-extensions", "-e", EXT, "--session-dir", SESSION_DIR, "--name", "home"]
let child = null
let buf = ""
let stopping = false
let backoffMs = 2000
let startedAt = 0

/** 拉起 home 子进程；异常退出后自动重启（指数退避，稳定跑满 1 分钟就重置） */
function startChild() {
  if (stopping) return
  buf = ""
  const c = spawn(PI, args, {
    env: { ...process.env, TZ, LIFE_WORLD_ROOT: ROOT, LIFE_WORLD_ROLE: "home", LIFE_WORLD_CHANNEL: "cli" },
    stdio: ["pipe", "pipe", "pipe"],
  })
  child = c
  startedAt = Date.now()
  log("home rpc start", c.pid)
  c.stdout.on("data", (d) => {
    if (c !== child) return
    buf += String(d)
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "")
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (isMessageEnd(msg) && isAssistant(msg)) {
        const text = textOf(msg)
        if (text) log("assistant", text.slice(0, 300))
      } else if (isAgentSettled(msg)) {
        log("agent settled")
      } else if (isExtensionUIRequest(msg)) {
        // 无头会话没人能点面板：立即回 cancelled，避免整轮 agent 卡死
        try { c.stdin.write(JSON.stringify(reqExtensionUIResponse(msg.id)) + "\n") } catch { /* ignore */ }
      }
    }
  })
  c.stderr.on("data", (d) => { if (c === child) log("stderr", String(d).slice(0, 300)) })
  c.on("error", (e) => {
    log("home rpc spawn error", String(e))
    // spawn 失败时不一定有 exit，自己安排重启
    if (c !== child) return
    child = null
    if (stopping) return
    const wait = backoffMs
    backoffMs = Math.min(60_000, backoffMs * 2)
    log(`home rpc restart in ${wait}ms`)
    setTimeout(startChild, wait)
  })
  c.on("exit", (code, signal) => {
    if (c !== child) return
    child = null
    log("home rpc exit", code, signal)
    if (stopping) { process.exit(code || 0); return }
    if (Date.now() - startedAt > 60_000) backoffMs = 2000
    const wait = backoffMs
    backoffMs = Math.min(60_000, backoffMs * 2)
    log(`home rpc restart in ${wait}ms`)
    // 不能 unref：没有子进程时靠这个定时器把进程撑住，否则会直接退出
    setTimeout(startChild, wait)
  })
}

startChild()
function shutdown(code = 0) {
  stopping = true
  try { child?.kill("SIGTERM") } catch { /* ignore */ }
  process.exit(code)
}
process.on("exit", () => { try { child?.kill("SIGTERM") } catch { /* ignore */ } })
process.on("SIGTERM", () => shutdown(0))
process.on("SIGINT", () => shutdown(0))
if (process.env.TEST_MS) setTimeout(() => { log("test done"); shutdown(0) }, Number(process.env.TEST_MS))
