#!/usr/bin/env node
/**
 * lwboard · life-world 本地 Web 看板（只监听 127.0.0.1）
 *
 *   node lwboard.mjs                 默认 http://127.0.0.1:8099
 *   LW_BOARD_PORT=9000 node lwboard.mjs
 *
 * 提供：会话/模型、模型热切换、用量、记忆检索、日记、日志、快照。
 */
import http from "node:http"
import { chmodSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { createRequire } from "node:module"
import { spawn } from "node:child_process"
import { backupWorld, backupLog, backupSize } from "./world-backup.mjs"
import { usageStats } from "./usage-stats.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.LIFE_WORLD_ROOT || join(homedir(), ".local/share/life-world")
const WORLD = join(ROOT, "worlds/default")
const CONFIG_FILE = join(ROOT, "life-world.json")
const STATUS_DIR = join(ROOT, "status")
const CONTROL_FILE = join(ROOT, "control.json")
const CONTROL_STATE = join(ROOT, "control-state.json")
const MEM_INDEX_FILE = join(ROOT, "memory-index.db")
const PORT = Number(process.env.LW_BOARD_PORT || 8099)
const HOST = process.env.LW_BOARD_HOST || "127.0.0.1"

const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, "utf8")) } catch { return fallback } }
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, file)
  try { chmodSync(file, 0o600) } catch { /* ignore */ }
}

let modelsCache = { at: 0, list: [] }
let modelsInFlight = null
const DEFAULT_CARE = { enabled: true, quietStart: "23:30", quietEnd: "08:00", randomEnabled: true, randomMinGapHours: 3, randomChancePerTick: 0.02, weatherEnabled: true, weatherCity: "" }
function piBin() {
  const candidates = [process.env.PI_BIN, join(homedir(), ".local/bin/pi"), join(homedir(), ".pi/agent/bin/pi"), "/usr/local/bin/pi", "/usr/bin/pi"]
  return candidates.find((p) => p && existsSync(p)) || ""
}
async function availableModels() {
  if (Date.now() - modelsCache.at < 60_000) return modelsCache.list
  if (modelsInFlight) return modelsInFlight
  const bin = piBin()
  if (!bin) { modelsCache = { at: Date.now(), list: [] }; return [] }
  modelsInFlight = (async () => {
  const list = await new Promise((resolve) => {
    let out = ""
    const child = spawn(bin, ["--list-models"], {
      env: { ...process.env, PATH: `${dirname(bin)}:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}` },
      stdio: ["ignore", "pipe", "ignore"],
    })
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } resolve([]) }, 20_000)
    child.stdout.on("data", (d) => { out += String(d) })
    child.on("close", () => {
      clearTimeout(timer)
      const rows = []
      for (const line of out.split("\n")) {
        const cols = line.trim().split(/\s{2,}/)
        if (cols.length < 2 || cols[0] === "provider") continue
        rows.push({ ref: `${cols[0]}/${cols[1]}`, provider: cols[0], model: cols[1] })
      }
      resolve(rows)
    })
    child.on("error", () => { clearTimeout(timer); resolve([]) })
  })
  modelsCache = { at: Date.now(), list }
  return list
  })().finally(() => { modelsInFlight = null })
  return modelsInFlight
}

let overviewCache = { at: 0, data: null }
const json = (res, code, data) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
  res.end(JSON.stringify(data))
}

function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
function sessions() {
  if (!existsSync(STATUS_DIR)) return []
  return readdirSync(STATUS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(join(STATUS_DIR, f), null))
    .filter((s) => s && s.roleKey)
    .map((s) => ({ roleKey: s.roleKey, model: s.model || "", updated: s.updated || "", pid: s.pid, sessionId: s.sessionId || "" }))
    .filter((s) => pidAlive(Number(s.pid)) && Date.now() - Date.parse(s.updated || 0) < 90_000)
    .sort((a, b) => String(a.roleKey).localeCompare(String(b.roleKey)))
}

let memDb
function openMem() {
  if (memDb !== undefined) return memDb
  try {
    const req = createRequire(import.meta.url)
    const { DatabaseSync } = req("node:sqlite")
    memDb = new DatabaseSync(MEM_INDEX_FILE, { readOnly: true })
  } catch { memDb = null }
  return memDb
}
function memorySearch(q, limit) {
  const db = openMem()
  if (!db) return []
  const query = String(q || "").trim()
  if (!query) return []
  try {
    if (query.replace(/\s+/g, "").length >= 3) {
      const phrase = `"${query.replace(/"/g, '""')}"`
      return db.prepare("SELECT m.t AS t, m.role AS role, m.text AS text FROM msg_fts JOIN msg m ON m.id = msg_fts.id WHERE msg_fts MATCH ? ORDER BY bm25(msg_fts) LIMIT ?").all(phrase, limit)
    }
    const like = `%${query.replace(/[\\%_]/g, "\\$&")}%`
    return db.prepare("SELECT t, role, text FROM msg WHERE text LIKE ? ESCAPE '\\' ORDER BY t DESC LIMIT ?").all(like, limit)
  } catch { return [] }
}
function diaryList(days = 14) {
  const dir = join(WORLD, "diary")
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse().slice(0, days).map((f) => {
    const body = readFileSync(join(dir, f), "utf8")
    const title = body.split("\n").map((l) => l.replace(/^[#>\s-]+/, "").trim()).find(Boolean) || ""
    return { date: f.replace(/\.md$/, ""), title: title.slice(0, 40) }
  })
}
function dayView(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { diary: "", chat: [] }
  const diaryFile = join(WORLD, "diary", `${date}.md`)
  const convFile = join(WORLD, "conversations", `${date}.jsonl`)
  const diary = existsSync(diaryFile) ? readFileSync(diaryFile, "utf8") : ""
  const chat = []
  if (existsSync(convFile)) {
    for (const line of readFileSync(convFile, "utf8").split("\n")) {
      if (!line.trim()) continue
      try { const r = JSON.parse(line); if (r.t && r.text) chat.push(r) } catch { /* ignore */ }
    }
  }
  return { diary, chat }
}
const LOG_FILES = { qq: "qq-bridge.log", home: "home-rpc.log", debug: "debug.log" }
function tail(target, n) {
  const file = join(ROOT, LOG_FILES[target] || LOG_FILES.qq)
  if (!existsSync(file)) return `（没有 ${file}）`
  const lines = readFileSync(file, "utf8").trimEnd().split("\n")
  return lines.slice(-Math.max(1, Math.min(500, n))).join("\n")
}
function waitAck(seq, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      const st = readJson(CONTROL_STATE, null)
      if (st && Number(st.seq) === seq) return resolve(st)
      if (Date.now() > deadline) return resolve(null)
      setTimeout(tick, 300)
    }
    tick()
  })
}

function body(req) {
  return new Promise((resolve) => {
    let raw = ""
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    req.on("data", (c) => {
      raw += c
      if (raw.length > 1e6) { finish({}); try { req.destroy() } catch { /* ignore */ } }
    })
    req.on("end", () => { try { finish(JSON.parse(raw || "{}")) } catch { finish({}) } })
    req.on("close", () => finish({}))
    req.on("error", () => finish({}))
  })
}

function parseImpressions() {
  const file = join(WORLD, "identity", "印象.md")
  if (!existsSync(file)) return { raw: "", items: [] }
  const raw = readFileSync(file, "utf8")
  const items = []
  for (const line of raw.split("\n")) {
    const m = line.match(/^-\s*\[([^\]]+)\]\s*(.+)$/)
    if (!m) continue
    const body = m[2]
    items.push({
      subject: m[1].trim(),
      text: body.replace(/（[^）]*）\s*$/, "").trim(),
      meta: (body.match(/（([^）]*)）\s*$/) || [])[1] || "",
    })
  }
  return { raw, items }
}

function memoryGraph(limit = 400) {
  const db = openMem()
  if (!db) return { nodes: [], links: [], stats: {} }
  const now = Date.now()
  const d = 0.5
  const access = new Map()
  const todayStr = new Date().toISOString().slice(0, 10)
  let todayAccess = 0
  try {
    for (const r of db.prepare("SELECT id, t FROM access").all()) {
      const t = Date.parse(String(r.t)) || 0
      if (!t) continue
      const key = String(r.id)
      if (!access.has(key)) access.set(key, [])
      access.get(key).push(t)
      if (String(r.t).slice(0, 10) === todayStr) todayAccess++
    }
  } catch { /* ignore */ }
  const edges = (() => { try { return db.prepare("SELECT a, b, w FROM edges").all() } catch { return [] } })()
  const degree = new Map()
  for (const e of edges) {
    degree.set(String(e.a), (degree.get(String(e.a)) || 0) + 1)
    degree.set(String(e.b), (degree.get(String(e.b)) || 0) + 1)
  }
  const rows = (() => { try { return db.prepare("SELECT id, t, role, text FROM msg").all() } catch { return [] } })()
  const actOf = (times) => {
    if (!times || !times.length) return 0
    let sum = 0
    for (const t of times) sum += Math.pow(Math.max(0.001, (now - t) / 1000), -d)
    return sum > 0 ? Math.log(sum) : 0
  }
  const all = rows.map((r) => {
    const id = String(r.id)
    return {
      id,
      t: String(r.t || ""),
      role: String(r.role || ""),
      content: String(r.text || "").slice(0, 240),
      activation: Number(actOf(access.get(id)).toFixed(3)),
      degree: degree.get(id) || 0,
      hits: (access.get(id) || []).length,
    }
  })
  const maxAct = Math.max(1e-6, ...all.map((n) => n.activation))
  const maxDeg = Math.max(1, ...all.map((n) => n.degree))
  for (const n of all) n.score = (n.activation / maxAct) * 0.7 + (n.degree / maxDeg) * 0.3
  all.sort((a, b) => b.score - a.score)
  const picked = all.slice(0, Math.max(50, Math.min(1000, limit)))
  const ids = new Set(picked.map((n) => n.id))
  const links = edges
    .filter((e) => ids.has(String(e.a)) && ids.has(String(e.b)))
    .map((e) => ({ source: String(e.a), target: String(e.b), w: Number(e.w) || 0 }))
  const avgAct = picked.length ? picked.reduce((s, n) => s + n.activation, 0) / picked.length : 0
  return {
    nodes: picked,
    links,
    stats: {
      nodes: rows.length,
      edges: edges.length,
      todayAccess,
      avgActivation: Number(avgAct.toFixed(3)),
      shown: picked.length,
      impressions: parseImpressions().items.length,
    },
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`)
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const file = join(HERE, "board.html")
      const data = readFileSync(file)
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(data)
      return
    }
    if (req.method === "GET" && url.pathname === "/api/overview") {
      const c = readJson(CONFIG_FILE, {})
      if (!overviewCache.data || Date.now() - overviewCache.at > 10_000) {
        overviewCache = {
          at: Date.now(),
          data: { usage: usageStats(7), backup: { size: backupSize(), last: backupLog(3) } },
        }
      }
      return json(res, 200, {
        sessions: sessions(),
        models: c.models || {},
        care: { ...DEFAULT_CARE, ...(c.care || {}) },
        usage: overviewCache.data.usage,
        backup: overviewCache.data.backup,
        available: await availableModels(),
        pid: process.pid,
        now: new Date().toISOString(),
      })
    }
    if (req.method === "GET" && url.pathname === "/api/memory") {
      const q = url.searchParams.get("q") || ""
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit")) || 20))
      return json(res, 200, { rows: memorySearch(q, limit) })
    }
    if (req.method === "GET" && url.pathname === "/api/diary") {
      return json(res, 200, { list: diaryList(14) })
    }
    if (req.method === "GET" && url.pathname === "/api/day") {
      return json(res, 200, dayView(url.searchParams.get("date") || ""))
    }
    if (req.method === "GET" && url.pathname === "/api/logs") {
      const target = url.searchParams.get("target") || "qq"
      const n = Number(url.searchParams.get("n")) || 120
      return json(res, 200, { text: tail(target, n) })
    }
    if (req.method === "POST" && url.pathname === "/api/model") {
      const data = await body(req)
      const target = String(data.target || "")
      const value = String(data.value || "")
      if (!target || !value) return json(res, 400, { ok: false, msg: "缺少 target / value" })
      const c = readJson(CONFIG_FILE, {})
      const m = c.models || {}
      const resolved = value === "local" ? m.local : value === "cloud" ? m.cloud : value
      if (!resolved) return json(res, 400, { ok: false, msg: `${value} 没配置` })
      const seq = Date.now()
      writeFileSync(CONTROL_FILE, JSON.stringify({ seq, target, model: value, reason: "lwboard 手动切换" }, null, 2))
      const st = await waitAck(seq)
      return json(res, 200, st ? { ok: !!st.ok, msg: st.msg } : { ok: false, msg: "超时：目标会话没响应" })
    }
    if (req.method === "POST" && url.pathname === "/api/care") {
      const data = await body(req)
      let cfg = {}
      if (existsSync(CONFIG_FILE)) {
        try { cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) }
        catch { return json(res, 400, { ok: false, msg: "life-world.json 解析失败，拒绝覆盖" }) }
      }
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return json(res, 400, { ok: false, msg: "配置不是对象，拒绝写入" })
      cfg.care = cfg.care || {}
      for (const key of ["quietStart", "quietEnd"]) {
        if (typeof data[key] !== "string") continue
        const v = data[key].trim()
        if (v && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) {
          return json(res, 400, { ok: false, msg: `时间格式不对：${v}（要 HH:MM，例如 23:30）` })
        }
      }
      if (typeof data.randomEnabled === "boolean") cfg.care.randomEnabled = data.randomEnabled
      if (typeof data.quietStart === "string") cfg.care.quietStart = data.quietStart.trim()
      if (typeof data.quietEnd === "string") cfg.care.quietEnd = data.quietEnd.trim()
      writeAtomic(CONFIG_FILE, JSON.stringify(cfg, null, 2))
      return json(res, 200, { ok: true, care: cfg.care })
    }
    if (req.method === "GET" && url.pathname === "/api/impressions") {
      return json(res, 200, parseImpressions())
    }
    if (req.method === "POST" && url.pathname === "/api/impressions/run") {
      const seq = Date.now()
      writeFileSync(CONTROL_FILE, JSON.stringify({ seq, target: "home", action: "impression", reason: "看板手动整理" }, null, 2))
      const st = await waitAck(seq, 15000)
      return json(res, 200, st ? { ok: !!st.ok, msg: st.msg } : { ok: false, msg: "超时：家会话没响应（可能没在跑）" })
    }
    if (req.method === "GET" && url.pathname === "/api/memory-graph") {
      const limit = Number(url.searchParams.get("limit")) || 400
      return json(res, 200, memoryGraph(limit))
    }
    if (req.method === "POST" && url.pathname === "/api/models") {
      const data = await body(req)
      let cfg = {}
      if (existsSync(CONFIG_FILE)) {
        try { cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) }
        catch { return json(res, 400, { ok: false, msg: "life-world.json 解析失败，拒绝覆盖" }) }
      }
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return json(res, 400, { ok: false, msg: "配置不是对象，拒绝写入" })
      cfg.models = cfg.models || {}
      if (typeof data.local === "string") cfg.models.local = data.local.trim()
      if (typeof data.cloud === "string") cfg.models.cloud = data.cloud.trim()
      writeAtomic(CONFIG_FILE, JSON.stringify(cfg, null, 2))
      return json(res, 200, { ok: true, models: { local: cfg.models.local, cloud: cfg.models.cloud } })
    }
    if (req.method === "POST" && url.pathname === "/api/backup") {
      const ok = await new Promise((resolve) => {
        const child = spawn(process.execPath, [join(HERE, "world-backup.mjs")], {
          env: { ...process.env, LIFE_WORLD_ROOT: ROOT }, stdio: "ignore",
        })
        const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } resolve(false) }, 120_000)
        child.on("close", (code) => { clearTimeout(timer); resolve(code === 0) })
        child.on("error", () => { clearTimeout(timer); resolve(false) })
      })
      return json(res, 200, { ok, msg: ok ? "快照完成" : "快照失败" })
    }
    json(res, 404, { error: "not found" })
  } catch (e) {
    if (res.headersSent) { try { res.end() } catch { /* ignore */ } return }
    json(res, 500, { error: String(e) })
  }
})

process.on("unhandledRejection", (e) => console.error("[lwboard] unhandled", e))
server.on("error", (e) => { console.error(`[lwboard] server error: ${String(e)}`) })
server.listen(PORT, HOST, () => {
  console.log(`lwboard → http://${HOST}:${PORT}`)
})
