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
import { chmodSync, existsSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { createRequire } from "node:module"
import { spawn } from "node:child_process"
import { backupWorld, backupLog, backupSize } from "./world-backup.mjs"
import { usageStats } from "./usage-stats.mjs"
import { appendCommand, waitAck } from "./control-queue.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.LIFE_WORLD_ROOT || join(homedir(), ".local/share/life-world")
const WORLD = join(ROOT, "worlds/default")
const CONFIG_FILE = join(ROOT, "life-world.json")
const STATUS_DIR = join(ROOT, "status")
const MEM_INDEX_FILE = join(ROOT, "memory-index.db")
const boardCfg = (() => {
  try {
    const c = JSON.parse(readFileSync(CONFIG_FILE, "utf8"))
    return c && typeof c.board === "object" && c.board ? c.board : {}
  } catch { return {} }
})()
const PORT = Number(process.env.LW_BOARD_PORT || boardCfg.port || 8099) || 8099
const HOST = String(process.env.LW_BOARD_HOST || boardCfg.host || "127.0.0.1")
/** 分支能力：v2 没有印象整理，adv 有；v2 的 board.html 会据此隐藏印象墙 */
const FEATURES = { impressions: true }

const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, "utf8")) } catch { return fallback } }

// —— 检查插件更新（只读；结果由 lwctl check-update 写进 update-check.json）——
const UPDATE_CHECK_FILE = join(ROOT, "update-check.json")
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000
let updateBusy = false
// 安装后叫 lwctl；直接在仓库里跑时是 lwctl.mjs
const LWCTL = existsSync(join(HERE, "lwctl")) ? join(HERE, "lwctl") : join(HERE, "lwctl.mjs")
function runUpdateCheck() {
  if (updateBusy) return false
  updateBusy = true
  const child = spawn(process.execPath, [LWCTL, "check-update", "--json"], {
    env: { ...process.env, LIFE_WORLD_ROOT: ROOT },
    stdio: "ignore",
  })
  const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } updateBusy = false }, 90_000)
  child.on("close", () => { clearTimeout(timer); updateBusy = false })
  child.on("error", () => { clearTimeout(timer); updateBusy = false })
  return true
}
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
/** 浏览器同源 POST 才放行：挡住别的网页用表单偷偷触发的 POST */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true // curl / 本机脚本没有 Origin，照常放行
  const norm = (h) => {
    const s = String(h || "").toLowerCase()
    const [host, port] = s.split(":")
    return `${host === "localhost" ? "127.0.0.1" : host}:${port || ""}`
  }
  try {
    const u = new URL(origin)
    const target = norm(u.host)
    // 反向代理常把 Host 改成本机，再看一眼转发的原始 Host
    const candidates = [req.headers.host, String(req.headers["x-forwarded-host"] || "").split(",")[0].trim()]
    return candidates.some((h) => h && norm(h) === target)
  } catch { return false }
}

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
    .map((s) => {
      // QQ 桥接会把自己当前在跑什么写进 busy-qq.json
      const busy = s.roleKey === "qq" ? readJson(join(ROOT, "busy-qq.json"), null) : null
      const fresh = busy && Date.now() - Date.parse(busy.updated || 0) < 15_000
      return {
        roleKey: s.roleKey,
        model: s.model || "",
        updated: s.updated || "",
        pid: s.pid,
        sessionId: s.sessionId || "",
        busy: fresh && busy.running ? { since: busy.since || 0, tool: busy.tool || null } : null,
      }
    })
    .filter((s) => s.model)
    .filter((s) => pidAlive(Number(s.pid)) && Date.now() - Date.parse(s.updated || 0) < 90_000)
    .sort((a, b) => String(a.roleKey).localeCompare(String(b.roleKey)))
}
/** AI 日程：只取 world.json 里 plan_next 排的闹钟；随机想起不在 alarms 里 */
function scheduleList(limit = 50) {
  const state = readJson(join(WORLD, "world.json"), {})
  const alarms = Array.isArray(state.alarms) ? state.alarms : []
  const now = Date.now()
  return alarms
    .filter((a) => a && Number.isFinite(Date.parse(a.at)))
    // active 主活动会长期保留，at 是过去时间，不放进时间线，避免挤掉未来闹钟
    .filter((a) => !(a.kind === "main" && (a.status === "active" || a.status === "closed")))
    // 已执行的留档不进时间线；心跳有自己的一块面板，也不重复展示
    .filter((a) => a.status !== "fired" && !(a.kind === "sub" && a.chainId))
    .filter((a) => !a.kind || Date.parse(a.at) >= now - 5 * 60_000)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(0, limit)
    .map((a) => ({
      id: String(a.id || ""),
      at: String(a.at),
      note: String(a.note || "").slice(0, 300),
      model: String(a.model || ""),
      setAt: String(a.setAt || ""),
    }))
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

function parseImpressions(target = join(WORLD, "identity", "印象.md")) {
  const file = target
  if (!existsSync(file)) return { raw: "", items: [] }
  const raw = readFileSync(file, "utf8")
  const items = []
  for (const line of raw.split("\n")) {
    const m = line.match(/^-\s*\[([^\]]+)\]\s*(.+)$/)
    if (!m) continue
    const body = m[2]
    items.push({
      subject: m[1].trim(),
      text: body.replace(/[（(][^）)]*[）)]\s*$/, "").trim(),
      meta: (body.match(/[（(]([^）)]*)[）)]\s*$/) || [])[1] || "",
    })
  }
  return { raw, items }
}

function dayOfLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 健康探活：显式地址优先，否则从 models.json 或内置 provider 表推导 /models */
const PROVIDER_BASE = {
  deepseek: "https://api.deepseek.com",
  "qwen-token-plan-cn": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
}
function providerBase(provider) {
  try {
    const custom = String(readJson(join(homedir(), ".pi/agent/models.json"), {})?.providers?.[provider]?.baseUrl || "")
    if (custom) return custom
  } catch { /* ignore */ }
  return PROVIDER_BASE[provider] || ""
}
function providerKey(provider) {
  try {
    const k = String(readJson(join(homedir(), ".pi/agent/auth.json"), {})?.[provider]?.key || "")
    if (k) return k
  } catch { /* ignore */ }
  try { return String(readJson(join(homedir(), ".pi/agent/models.json"), {})?.providers?.[provider]?.apiKey || "") } catch { return "" }
}
async function probeModel(ref, explicitUrl) {
  const id = String(ref || "")
  const provider = id.includes("/") ? id.slice(0, id.indexOf("/")) : ""
  const base = providerBase(provider).replace(/\/+$/, "")
  const url = String(explicitUrl || (base ? `${base}/models` : ""))
  if (!url) return { state: "unknown", url: "", detail: "没配健康地址" }
  const key = providerKey(provider)
  try {
    const r = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(4000) })
    return { state: r.ok ? "ok" : "bad", url, code: r.status }
  } catch (e) {
    return { state: "bad", url, error: String(e?.message || e) }
  }
}
function readTail(file, max) {
  try { const s = readFileSync(file, "utf8"); return s.slice(-max) } catch { return "" }
}

/** 从印象 meta 里解析「来源：」段的日期；全日期与 MM-DD 分开处理，避免把 2026-11-05 切成 26-11 */
function sourceDays(meta) {
  const text = String(meta || "")
  const m = text.match(/来源[:：]\s*([^；;）)]*)/)
  const section = m ? m[1] : ""
  if (!section) return []
  const last = text.match(/最后验证[:：]\s*(\d{4})-(\d{2})-(\d{2})/)
  const baseYear = last ? Number(last[1]) : new Date().getFullYear()
  const days = new Set()
  const full = /(\d{4})-(\d{2})-(\d{2})/g
  let x
  while ((x = full.exec(section))) days.add(`${x[1]}-${x[2]}-${x[3]}`)
  const short = /(?<![\d-])(\d{2})-(\d{2})(?![\d-])/g
  while ((x = short.exec(section))) {
    const mm = Number(x[1]), dd = Number(x[2])
    let year = baseYear
    if (last) {
      const bm = Number(last[2]), bd = Number(last[3])
      if (mm > bm + 6 || (bm <= 2 && mm >= 11)) year = baseYear - 1
    }
    days.add(`${year}-${x[1]}-${x[2]}`)
  }
  return [...days]
}

function memoryGraph(limit = 400) {
  const db = openMem()
  if (!db) return { nodes: [], links: [], stats: {} }
  const cfg = readJson(CONFIG_FILE, {})
  const now = Date.now()
  const dRaw = Number(cfg?.memory?.actr?.decay)
  const d = Number.isFinite(dRaw) ? dRaw : 0.5
  const access = new Map()
  const todayStr = dayOfLocal()
  let todayAccess = 0
  try {
    for (const r of db.prepare("SELECT id, t FROM access").all()) {
      const t = Date.parse(String(r.t)) || 0
      if (!t) continue
      const key = String(r.id)
      if (!access.has(key)) access.set(key, [])
      access.get(key).push(t)
      if (dayOfLocal(new Date(t)) === todayStr) todayAccess++
    }
  } catch { /* ignore */ }
  const edges = (() => { try { return db.prepare("SELECT a, b, w FROM edges").all() } catch { return [] } })()
  const degree = new Map()
  for (const e of edges) {
    degree.set(String(e.a), (degree.get(String(e.a)) || 0) + 1)
    degree.set(String(e.b), (degree.get(String(e.b)) || 0) + 1)
  }
  const rows = (() => { try { return db.prepare("SELECT id, t, role, text FROM msg ORDER BY rowid DESC LIMIT 20000").all() } catch { return [] } })()
  const actOf = (times) => {
    if (!times || !times.length) return 0
    let sum = 0
    for (const t of times) sum += Math.pow(Math.max(0.001, (now - t) / 1000), -d)
    return sum > 0 ? Math.log(sum) : 0
  }
  const all = rows.map((r) => {
    const id = String(r.id)
    const t = String(r.t || "")
    return {
      id,
      t,
      day: dayOfLocal(new Date(t)),
      role: String(r.role || ""),
      content: String(r.text || "").slice(0, 240),
      activation: Number(actOf(access.get(id)).toFixed(3)),
      degree: degree.get(id) || 0,
      hits: (access.get(id) || []).length,
    }
  })
  let maxAct = 1e-6
  let maxDeg = 1
  for (const n of all) {
    if (n.activation > maxAct) maxAct = n.activation
    if (n.degree > maxDeg) maxDeg = n.degree
  }
  for (const n of all) n.score = (n.activation / maxAct) * 0.7 + (n.degree / maxDeg) * 0.3
  all.sort((a, b) => b.score - a.score)
  // 特殊节点：日记、印象（不参与 400 上限挤占）
  const diaryDir = join(WORLD, "diary")
  const diaries = []
  if (existsSync(diaryDir)) {
    for (const f of readdirSync(diaryDir).filter((x) => x.endsWith(".md")).sort().slice(-14)) {
      const body = readFileSync(join(diaryDir, f), "utf8")
      const title = body.split("\n").map((l) => l.replace(/^[#>\s-]+/, "").trim()).find(Boolean) || ""
      diaries.push({ id: `diary-${f.replace(/\.md$/, "")}`, kind: "diary", t: `${f.replace(/\.md$/, "")}T20:00:00`, day: f.replace(/\.md$/, ""), role: "diary", content: title.slice(0, 120), subject: f.replace(/\.md$/, ""), activation: 0, degree: 0, hits: 0, score: 0.6 })
    }
  }
  const SHORT_IMPRESSION_FILE = join(WORLD, "identity", "印象-短期.md")
  const impressions = [
    ...parseImpressions().items.map((it) => ({ ...it, short: false })),
    ...parseImpressions(SHORT_IMPRESSION_FILE).items.map((it) => ({ ...it, short: true })),
  ].map((it, i) => {
    const dayMatch = String(it.meta || "").match(/最后验证：\s*(\d{4}-\d{2}-\d{2})/)
    // 短期印象是独立的一种星（kind: short），不和长期印象混在一圈
    return { id: it.short ? `simp-${i}` : `imp-${i}`, kind: it.short ? "short" : "impression", short: it.short, t: dayMatch ? `${dayMatch[1]}T09:00:00` : new Date().toISOString(), role: "impression", content: it.text, subject: it.subject, meta: it.meta, activation: 0, degree: 0, hits: 0, score: it.short ? 0.9 : 1.2 }
  })
  // 印象的来源节点：按来源日期从全量消息里取，不用「全站 top5」硬凑
  const impTargets = new Map()
  const extraNodes = []
  const extraIds = new Set()
  for (const im of impressions) {
    const wanted = new Set(sourceDays(im.meta))
    let targets = []
    if (wanted.size) {
      targets = all.filter((n) => wanted.has(n.day)).sort((a, b) => b.score - a.score).slice(0, 5)
    }
    impTargets.set(im.id, targets)
    for (const t of targets) if (!extraIds.has(t.id)) { extraIds.add(t.id); extraNodes.push(t) }
  }
  const specials = [...diaries, ...impressions]
  // 自动注入的人格文档：星图中心最亮的几颗星
  const IDENTITY_DOCS = [
    { file: "我是谁.md", label: "我是谁" },
    { file: "心情.md", label: "心情" },
    { file: "用户画像.md", label: "用户画像" },
    { file: "模型使用规范.md", label: "模型规范" },
    { file: "化形表.md", label: "化形" },
    { file: "印象.md", label: "长期印象" },
    { file: "印象-短期.md", label: "短期印象" },
  ]
  const identityNodes = []
  for (const doc of IDENTITY_DOCS) {
    const path = join(WORLD, "identity", doc.file)
    if (!existsSync(path)) continue
    let text = ""
    try { text = readFileSync(path, "utf8").trim() } catch { continue }
    if (!text) continue
    let mtime = now
    try { mtime = statSync(path).mtimeMs } catch { /* ignore */ }
    identityNodes.push({
      id: `doc-${doc.file}`,
      kind: "identity",
      t: new Date(mtime).toISOString(),
      role: "identity",
      content: text.slice(0, 800),
      subject: doc.label,
      file: `identity/${doc.file}`,
      activation: 0,
      degree: 0,
      hits: 0,
      score: 2,
    })
  }
  const identityLinks = []
  for (let i = 0; i < identityNodes.length; i++) {
    for (let j = i + 1; j < identityNodes.length; j++) {
      identityLinks.push({ source: identityNodes[i].id, target: identityNodes[j].id, w: 0.8, kind: "identity" })
    }
  }
  const pickedMsgs = all.slice(0, Math.max(50, Math.min(1000, limit)))
  const pickedIds = new Set(pickedMsgs.map((n) => n.id))
  // 来源节点最多再补 120 个，避免极端情况下把图撑爆
  const extraPicked = extraNodes.filter((n) => !pickedIds.has(n.id)).slice(0, 120)
  const picked = [...pickedMsgs, ...extraPicked, ...specials, ...identityNodes]
  const ids = new Set(picked.map((n) => n.id))
  const links = edges
    .filter((e) => ids.has(String(e.a)) && ids.has(String(e.b)))
    .sort((a, b) => (Number(b.w) || 0) - (Number(a.w) || 0))
    .slice(0, 5000)
    .map((e) => ({ source: String(e.a), target: String(e.b), w: Number(e.w) || 0, kind: "recall" }))
  // 日记 → 当天前 5 条消息
  const byDayList = new Map()
  for (const n of pickedMsgs) {
    if (!byDayList.has(n.day)) byDayList.set(n.day, [])
    byDayList.get(n.day).push(n)
  }
  for (const dnode of diaries) {
    const targets = (byDayList.get(dnode.subject) || []).slice().sort((a, b) => b.score - a.score).slice(0, 5)
    for (const t of targets) links.push({ source: dnode.id, target: t.id, w: 0.35, kind: "diary" })
  }
  // 印象 → 真正的来源日期消息；没有来源就不断线
  for (const im of impressions) {
    for (const t of impTargets.get(im.id) || []) {
      // 短期印象的边单独一种（short）：看板据此走紫色、介于普通与印象之间的脉冲
      if (ids.has(t.id)) links.push({ source: im.id, target: t.id, w: 0.55, kind: im.kind === "short" ? "short" : "impression" })
    }
  }
  for (const l of identityLinks) links.push(l)
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
      impressions: impressions.length,
      docs: identityNodes.length,
    },
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`)
  try {
    if (req.method === "POST" && !sameOrigin(req)) return json(res, 403, { ok: false, msg: "跨站请求被拒绝" })
    if (req.method === "GET" && url.pathname === "/nebula.jpg") {
      const file = join(HERE, "nebula.jpg")
      if (!existsSync(file)) { res.writeHead(404); res.end(); return }
      const data = readFileSync(file)
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" })
      res.end(data)
      return
    }
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
        subagent: c.subagent || {},
        modelMode: readJson(join(ROOT, "model-mode.json"), null),
        mood: (() => {
          try {
            const s = readFileSync(join(WORLD, "identity", "心情.md"), "utf8")
            const line = s.split("\n").map((x) => x.trim()).find((x) => x && !x.startsWith("#"))
            return line ? line.replace(/^[-*]\s*/, "").slice(0, 200) : ""
          } catch { return "" }
        })(),
        care: { ...DEFAULT_CARE, ...(c.care || {}) },
        features: FEATURES,
        heartbeatMaxMinutes: (() => {
          const v = Number(c.world && c.world.heartbeatMaxMinutes)
          return Number.isFinite(v) && v > 0 ? Math.max(10, Math.min(1440, Math.round(v))) : 20
        })(),
        heartbeatEnabled: !(c.world && c.world.heartbeatEnabled === false),
        update: readJson(UPDATE_CHECK_FILE, null),
        updateResult: readJson(join(ROOT, "update-result.json"), null),
        board: { host: HOST, port: PORT },
        schedule: scheduleList(),
        usage: overviewCache.data.usage,
        backup: overviewCache.data.backup,
        available: await availableModels(),
        multimodal: (c.multimodal || {}),
        bridge: { enabled: !!(c.bridge && c.bridge.enabled), group: { enabled: !!(c.bridge && c.bridge.group && c.bridge.group.enabled) } },
        pid: process.pid,
        now: new Date().toISOString(),
      })
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      const c = readJson(CONFIG_FILE, {})
      const m = c.models || {}
      const [local, cloud] = await Promise.all([
        probeModel(m.local, m.localHealthUrl),
        probeModel(m.cloud, m.cloudHealthUrl),
      ])
      let bridge = { state: "unknown", lastSeen: "" }
      try {
        const s = readJson(join(ROOT, "qq-bridge-state.json"), {})
        const ts = Date.parse(s.lastSeen || 0)
        bridge = { state: ts && Date.now() - ts < 120_000 ? "ok" : "bad", lastSeen: s.lastSeen || "" }
      } catch { /* ignore */ }
      const backup = { size: backupSize(), last: (backupLog(1) || [])[0] || "" }
      return json(res, 200, { local, cloud, bridge, backup, now: new Date().toISOString() })
    }
    if (req.method === "GET" && url.pathname === "/api/plan") {
      const date = url.searchParams.get("date") || dayOfLocal()
      const file = join(WORLD, "plan", `${date}.md`)
      let text = ""
      try { text = readFileSync(file, "utf8") } catch { /* ignore */ }
      const items = []
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/)
        if (m) items.push({ done: m[1].toLowerCase() === "x", text: m[2].trim().slice(0, 200) })
      }
      return json(res, 200, { date, exists: !!text, total: items.length, done: items.filter((x) => x.done).length, items: items.slice(0, 30) })
    }
    if (req.method === "GET" && url.pathname === "/api/alarms") {
      const state = readJson(join(WORLD, "world.json"), {})
      const alarms = Array.isArray(state.alarms) ? state.alarms : []
      return json(res, 200, { alarms, now: Date.now() })
    }
    if (req.method === "POST" && url.pathname === "/api/alarm") {
      const data = await body(req)
      const op = String(data.op || "")
      const id = String(data.id || "")
      if (!id || !["pause", "resume", "close", "fire_now", "stop_chain"].includes(op)) return json(res, 400, { ok: false, msg: "缺少 id 或操作不支持" })
      const cmd = appendCommand(ROOT, { target: "home", action: "alarm", op, alarmId: id, reason: "lwboard 闹钟操作" })
      const st = await waitAck(ROOT, cmd.id, "home", 8000)
      return json(res, 200, st ? { ok: !!st.ok, msg: st.msg } : { ok: false, msg: "超时：家会话没响应（闹钟由 home 进程执行）" })
    }
    if (req.method === "GET" && url.pathname === "/api/activity") {
      const date = url.searchParams.get("date") || dayOfLocal()
      const hours = Array(24).fill(0)
      let total = 0
      const db = openMem()
      if (db) {
        try {
          const rows = db.prepare("select t from msg where day = ?").all(date)
          total = rows.length
          for (const r of rows) {
            const d = new Date(String(r.t || ""))
            if (!Number.isNaN(d.getTime())) hours[d.getHours()]++
          }
        } catch { /* ignore */ }
      }
      return json(res, 200, { date, hours, total })
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      const events = []
      let m
      const re = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z) (model switch|failover|alarm model|backup ·|impression ·|sendTime)(.*)$/gm
      const debug = readTail(join(ROOT, "debug.log"), 200_000)
      while ((m = re.exec(debug))) events.push({ t: m[1], text: `${m[2]}${m[3]}`.trim().slice(0, 180) })
      const re2 = /^\[(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\] (sent private|pi start|bridge started|judge SKIP)(.*)$/gm
      const qb = readTail(join(ROOT, "qq-bridge.log"), 120_000)
      while ((m = re2.exec(qb))) events.push({ t: m[1], text: `${m[2]}${m[3]}`.trim().slice(0, 180) })
      events.sort((a, b) => String(a.t).localeCompare(String(b.t)))
      return json(res, 200, { events: events.slice(-30) })
    }
    if (req.method === "GET" && url.pathname === "/api/memory") {
      const q = url.searchParams.get("q") || ""
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit")) || 20))
      return json(res, 200, { rows: memorySearch(q, limit) })
    }
    if (req.method === "GET" && url.pathname === "/api/node") {
      const id = String(url.searchParams.get("id") || "")
      if (!id) return json(res, 400, { error: "missing id" })
      if (id.startsWith("doc-")) {
        const allowed = new Set(["我是谁.md", "心情.md", "用户画像.md", "模型使用规范.md", "化形表.md", "印象.md", "印象-短期.md"])
        const file = id.slice(4)
        if (!allowed.has(file)) return json(res, 404, { error: "not found" })
        const path = join(WORLD, "identity", file)
        if (!existsSync(path)) return json(res, 404, { error: "not found" })
        return json(res, 200, { id, content: readFileSync(path, "utf8") })
      }
      if (id.startsWith("diary-")) {
        const day = id.slice(6)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(res, 404, { error: "not found" })
        const path = join(WORLD, "diary", `${day}.md`)
        if (!existsSync(path)) return json(res, 404, { error: "not found" })
        return json(res, 200, { id, content: readFileSync(path, "utf8") })
      }
      const db = openMem()
      if (!db) return json(res, 503, { error: "index unavailable" })
      try {
        const row = db.prepare("SELECT text FROM msg WHERE id = ?").get(id)
        if (!row) return json(res, 404, { error: "not found" })
        return json(res, 200, { id, content: String(row.text || "") })
      } catch { return json(res, 500, { error: "query failed" }) }
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
      const cmd = appendCommand(ROOT, { target, action: "model", model: value, reason: "lwboard 手动切换" })
      // 全部切换只下发，不逐个等回执；会话 5 秒内自己轮询生效
      if (target === "all") return json(res, 200, { ok: true, msg: "已下发全部切换" })
      const st = await waitAck(ROOT, cmd.id, target)
      return json(res, 200, st ? { ok: !!st.ok, msg: st.msg } : { ok: false, msg: "超时：目标会话没响应" })
    }
    if (req.method === "POST" && url.pathname === "/api/abort") {
      const data = await body(req)
      const target = String(data.target || "")
      if (target !== "qq" && target !== "home") return json(res, 400, { ok: false, msg: "只能中断 qq / home" })
      // qq 由桥接自己消费（它握着 pi 子进程），home 由扩展在会话内 abort
      const cmd = appendCommand(ROOT, { target, action: "abort", reason: "lwboard 中断当前轮" })
      const st = await waitAck(ROOT, cmd.id, target, 12_000)
      return json(res, 200, st ? { ok: !!st.ok, msg: st.msg } : { ok: false, msg: "超时：会话没响应中断" })
    }
    if (req.method === "POST" && url.pathname === "/api/restart") {
      const data = await body(req)
      const target = String(data.target || "")
      if (!target) return json(res, 400, { ok: false, msg: "缺少 target" })
      // home 单独重启；qq 与群会话都挂在同一个桥接进程上，重启桥接即可
      const which = target === "home" ? "home" : (target === "qq" || target.startsWith("group-")) ? "qq" : ""
      if (!which) return json(res, 400, { ok: false, msg: "这个会话不支持重启" })
      const lwctl = [join(HERE, "lwctl"), join(HERE, "lwctl.mjs")].find((p) => existsSync(p))
      if (!lwctl) return json(res, 500, { ok: false, msg: "找不到 lwctl" })
      const r = await new Promise((resolve) => {
        const child = spawn(process.execPath, [lwctl, "restart", which], { cwd: ROOT, env: { ...process.env, LIFE_WORLD_ROOT: ROOT } })
        let out = ""
        child.stdout.on("data", (d) => { out += String(d) })
        child.stderr.on("data", (d) => { out += String(d) })
        const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } resolve({ code: -1, out }) }, 30_000)
        child.on("exit", (code) => { clearTimeout(timer); resolve({ code, out }) })
        child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: String(e) }) })
      })
      const msg = String(r.out || "").trim().slice(0, 300)
      return json(res, 200, { ok: r.code === 0, msg: msg || (r.code === 0 ? "已重启" : "重启失败") })
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
      return json(res, 200, { ...parseImpressions(), short: parseImpressions(join(WORLD, "identity", "印象-短期.md")) })
    }
    if (req.method === "POST" && url.pathname === "/api/impressions/run") {
      const data = await body(req)
      const scope = data && data.scope === "short" ? "short" : "long"
      const cmd = appendCommand(ROOT, { target: "home", action: "impression", scope, reason: `看板手动整理${scope === "short" ? "短期印象" : "长期印象"}` })
      const st = await waitAck(ROOT, cmd.id, "home", 15000)
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
      if (typeof data.subagent === "string") {
        cfg.subagent = cfg.subagent || {}
        cfg.subagent.model = data.subagent.trim()
      }
      if (typeof data.multimodal === "string") {
        cfg.multimodal = cfg.multimodal || {}
        cfg.multimodal.model = data.multimodal.trim()
        cfg.multimodal.enabled = !!cfg.multimodal.model
      }
      writeAtomic(CONFIG_FILE, JSON.stringify(cfg, null, 2))
      return json(res, 200, { ok: true, models: { local: cfg.models.local, cloud: cfg.models.cloud }, subagent: cfg.subagent || {}, multimodal: cfg.multimodal || {} })
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
    if (req.method === "POST" && url.pathname === "/api/update-run") {
      // 真更新：交给 lwctl，detached 跑——它会重启看板（连自己一起），不能等在这里
      try { unlinkSync(join(ROOT, "update-result.json")) } catch { /* ignore */ }
      const env = { ...process.env, LIFE_WORLD_ROOT: ROOT }
      delete env.LW_BOARD_HOST
      delete env.LW_BOARD_PORT
      const child = spawn(process.execPath, [LWCTL, "update"], {
        env,
        cwd: ROOT,
        detached: true,
        stdio: ["ignore", openSync(join(ROOT, "update-run.log"), "a"), openSync(join(ROOT, "update-run.log"), "a")],
      })
      child.on("error", (e) => console.error("[lwboard] spawn lwctl update failed:", String(e)))
      child.unref()
      return json(res, 200, { ok: true, msg: "正在更新，看板会短暂断开，十几秒后刷新本页" })
    }
    if (req.method === "POST" && url.pathname === "/api/heartbeat-limit") {
      const data = await body(req)
      const v = Math.round(Number(data.minutes))
      if (!Number.isFinite(v) || v < 10 || v > 1440) return json(res, 400, { ok: false, msg: "心跳时长要在 10-1440 分钟之间" })
      let c = {}
      if (existsSync(CONFIG_FILE)) {
        try { c = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) }
        catch { return json(res, 400, { ok: false, msg: "life-world.json 解析失败，拒绝覆盖" }) }
      }
      if (!c || typeof c !== "object" || Array.isArray(c)) return json(res, 400, { ok: false, msg: "配置不是对象，拒绝写入" })
      c.world = { ...(c.world || {}), heartbeatMaxMinutes: v }
      if (typeof data.enabled === "boolean") c.world.heartbeatEnabled = data.enabled
      try { writeAtomic(CONFIG_FILE, JSON.stringify(c, null, 2)) } catch (e) {
        return json(res, 500, { ok: false, msg: `写配置失败：${String(e)}` })
      }
      return json(res, 200, { ok: true, msg: data.enabled === false ? "已保存：心跳已关闭" : `已保存：单次心跳最长 ${v} 分钟` })
    }
    if (req.method === "POST" && url.pathname === "/api/board-address") {
      const data = await body(req)
      const host = String(data.host || "").trim()
      const port = Number(data.port)
      if (!host || !/^[A-Za-z0-9_.:-]+$/.test(host)) return json(res, 400, { ok: false, msg: "监听地址不合法" })
      if (!Number.isInteger(port) || port < 1 || port > 65535) return json(res, 400, { ok: false, msg: "端口要在 1-65535" })
      const c = readJson(CONFIG_FILE, {})
      c.board = { ...(c.board || {}), host, port }
      try { writeAtomic(CONFIG_FILE, JSON.stringify(c, null, 2)) } catch (e) {
        return json(res, 500, { ok: false, msg: `写配置失败：${String(e)}` })
      }
      // 换监听地址要重启看板才生效；同样 detached，别把自己杀掉
      // 注意别把当前进程的 LW_BOARD_HOST/PORT 传下去，否则 lwctl 会用旧值覆盖新配置
      const env = { ...process.env, LIFE_WORLD_ROOT: ROOT }
      delete env.LW_BOARD_HOST
      delete env.LW_BOARD_PORT
      const child = spawn(process.execPath, [LWCTL, "board", "restart"], {
        env,
        cwd: ROOT,
        detached: true,
        stdio: ["ignore", openSync(join(ROOT, "board-restart.log"), "a"), openSync(join(ROOT, "board-restart.log"), "a")],
      })
      child.on("error", (e) => console.error("[lwboard] spawn lwctl board restart failed:", String(e)))
      child.unref()
      return json(res, 200, { ok: true, msg: `已保存 ${host}:${port}，正在重启看板` })
    }
    if (req.method === "POST" && url.pathname === "/api/update-check") {
      const started = runUpdateCheck()
      return json(res, 200, {
        ok: started,
        msg: started ? "正在检查更新，稍等几秒刷新" : "上一次检查还没结束",
        update: readJson(UPDATE_CHECK_FILE, null),
      })
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
  // 启动 30 秒后查一次，之后每 6 小时查一次；结果给页面顶部的更新提示
  setTimeout(runUpdateCheck, 30_000).unref()
  setInterval(runUpdateCheck, UPDATE_EVERY_MS).unref()
})
