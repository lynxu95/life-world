#!/usr/bin/env node
/**
 * life-world · pi QQ bridge (MVP)
 *
 * OneBot v11 正向 WS ↔ pi RPC 子进程。
 * - 私聊：owner 消息 -> pi prompt -> assistant 文本 -> QQ
 * - 余波：60 秒没人回 -> 补一拍（最多 2 拍；[SILENT] 不发、不续）
 * - outbox：reach_out / send_media 投递
 * - 群聊：基础版（可选，见 groupCfg）
 *
 * 用法：
 *   node qq-bridge.mjs
 *   node qq-bridge.mjs --test-user "在吗"     # 模拟 owner 发一条私聊，测试用
 */
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { basename, dirname, join, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { spawn, spawnSync } from "node:child_process"
import {
  isResponse, isMessageEnd, isAgentStart, isAgentSettled, isExtensionUIRequest,
  isAssistant, isToolUse, isError, isOverflow, errorMessage, settledAborted, responseOk, responseError,
  textOf as rpcTextOf, toolCallOf, reqPrompt, reqAbort, reqAbortBash, reqExtensionUIResponse,
} from "./rpc-adapter.mjs"

const HOME = homedir()
const ROOT = process.env.LIFE_WORLD_ROOT || join(HOME, ".local/share/life-world")
const WORLD = join(ROOT, "worlds/default")
const OUTBOX_DIR = join(WORLD, "outbox")
const TMP_DIR = join(WORLD, "tmp")
const CONFIG_FILE = join(ROOT, "life-world.json")
const STATE_FILE = join(ROOT, "qq-bridge-state.json")
const LOG_FILE = join(ROOT, "qq-bridge.log")
const SESSION_DIR = join(ROOT, "pi-sessions")
const HERE = dirname(fileURLToPath(import.meta.url))
const PI_BIN = process.env.PI_BIN || "pi"
const EXT = process.env.LIFE_WORLD_EXT || join(HERE, "../ext/life-world.ts")
const MODEL = process.env.LIFE_WORLD_MODEL || "deepseek-flash"
const TZ = process.env.TZ || "Asia/Shanghai"

function rotate() {
  try { if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 5 * 1024 * 1024) renameSync(LOG_FILE, `${LOG_FILE}.1`) } catch { /* ignore */ }
}
rotate()
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`
  try { mkdirSync(dirname(LOG_FILE), { recursive: true }); appendFileSync(LOG_FILE, line + "\n", { mode: 0o600 }) } catch { /* ignore */ }
  if (process.stdout.isTTY) console.log(line)
}
function readJson(file, fallback) { try { return JSON.parse(readFileSync(file, "utf8")) } catch { return fallback } }
/** 毫秒 → 人话（3 秒 / 2 分 15 秒 / 1 小时 5 分） */
function fmtSpan(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}
/** 工具参数里最能说明「在干嘛」的那一段 */
function toolArgSummary(args) {
  if (!args || typeof args !== "object") return ""
  const pick = args.command || args.path || args.query || args.task || args.note || args.message || ""
  const s = String(pick).replace(/\s+/g, " ").trim()
  if (!s) {
    const j = JSON.stringify(args)
    return j && j !== "{}" ? j.slice(0, 140) : ""
  }
  return s.length > 140 ? `${s.slice(0, 137)}…` : s
}
function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
  } catch (e) { log("write state failed", String(e)); try { unlinkSync(tmp) } catch { /* ignore */ } }
}
const dayOf = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

const config = readJson(CONFIG_FILE, {})
const bridge = config.bridge || {}
if (bridge.enabled !== true) { log("bridge disabled, exit"); process.exit(0) }
const ownerQQ = Number(bridge.ownerQQ)
if (!ownerQQ) { log("ownerQQ missing, exit"); process.exit(1) }
const wsUrl = bridge.wsUrl || "ws://127.0.0.1:3001"
const wsToken = bridge.token || ""
const afterglowCfg = Object.assign({ enabled: true, delayMs: 60000, maxRounds: 2 }, bridge.afterglow || {})
/** 一轮多久没有任何动静就算卡死、自动掐掉；显式写 0 = 关闭，不写则默认 600 秒 */
const idleRaw = bridge.idleTimeoutSec
const idleTimeoutSec = String(idleRaw).trim() === "0" ? 0 : (Number(idleRaw) > 0 ? Number(idleRaw) : 600)
let groupCfgCache = { at: 0, cfg: null }
/** 群聊配置热加载：最多缓存 2 秒，改 life-world.json 立即生效 */
function groupCfg() {
  const now = Date.now()
  if (groupCfgCache.cfg && now - groupCfgCache.at < 2000) return groupCfgCache.cfg
  const live = readJson(CONFIG_FILE, {})
  const cfg = Object.assign({ enabled: false }, (live.bridge || {}).group || {})
  groupCfgCache = { at: now, cfg }
  return cfg
}
/** 群聊优先用在线模型（配了 models.cloud 才生效），私聊仍用 LIFE_WORLD_MODEL/本地 */
const CLOUD_MODEL = String((config.models && config.models.cloud) || "")
const TEST_USER = process.argv[2] === "--test-user" ? (process.argv[3] || "在吗") : ""
const TEST_MS = Number(process.env.TEST_MS || 60000)

let state = readJson(STATE_FILE, {})
function saveState() { writeJson(STATE_FILE, state) }
mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 })

// ———————————————— OneBot ————————————————
let ws = null
let wsReady = false
let reconnectTimer = null
let reconnectDelay = 5000
const pending = new Map()
let echoSeq = 0

function scheduleReconnect(reason) {
  if (reconnectTimer) return
  log(`reconnect in ${Math.round(reconnectDelay / 1000)}s`, reason)
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect() }, reconnectDelay)
  reconnectDelay = Math.min(60000, reconnectDelay * 2)
}

function connect() {
  const url = wsToken ? `${wsUrl}?access_token=${encodeURIComponent(wsToken)}` : wsUrl
  const previous = ws
  ws = null
  if (previous) { try { previous.close() } catch { /* ignore */ } }
  wsReady = false
  let socket
  try { socket = new WebSocket(url) } catch (e) { log("ws create failed", String(e)); scheduleReconnect("bad wsUrl"); return }
  ws = socket
  socket.addEventListener("open", () => {
    if (ws !== socket) return
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    wsReady = true
    reconnectDelay = 5000
    state.lastSeen = new Date().toISOString()
    saveState()
    log("ws open", wsUrl)
    if (TEST_USER) {
      setTimeout(() => handlePrivate({
        user_id: ownerQQ,
        self_id: 0,
        message: [{ type: "text", data: { text: TEST_USER } }],
        sender: { nickname: "测试" },
      }).catch((e) => log("test user failed", String(e))), 300)
      setTimeout(() => { log("test done"); try { pi.child?.kill("SIGTERM") } catch { /* ignore */ } process.exit(0) }, TEST_MS)
    }
  })
  socket.addEventListener("close", () => { if (ws !== socket) return; wsReady = false; scheduleReconnect("close") })
  socket.addEventListener("error", (e) => { if (ws !== socket) return; wsReady = false; log("ws error", e?.message || ""); scheduleReconnect("error") })
  socket.addEventListener("message", (event) => {
    if (ws !== socket) return
    let msg
    try { msg = JSON.parse(event.data) } catch { return }
    if (msg.echo && pending.has(msg.echo)) {
      const p = pending.get(msg.echo)
      clearTimeout(p.timer)
      pending.delete(msg.echo)
      const failed = msg.status === "failed" || (typeof msg.retcode === "number" && msg.retcode !== 0 && msg.retcode !== 1)
      if (failed) p.reject(new Error(`${msg.status || "failed"} retcode=${msg.retcode ?? "?"}`))
      else p.resolve(msg)
      return
    }
    if (msg.post_type === "message" && msg.message_type === "private") {
      handlePrivate(msg).catch((e) => log("handle private failed", String(e)))
    } else if (msg.post_type === "message" && msg.message_type === "group") {
      handleGroup(msg).catch((e) => log("handle group failed", String(e)))
    }
  })
}

function call(action, params, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!wsReady || !ws) return reject(new Error("ws not ready"))
    const echo = `e-${Date.now()}-${++echoSeq}`
    const timer = setTimeout(() => { pending.delete(echo); reject(new Error(`${action} timeout`)) }, timeoutMs)
    pending.set(echo, { resolve, reject, timer })
    ws.send(JSON.stringify({ action, params, echo }))
  })
}

function messageParts(msg) {
  if (Array.isArray(msg?.message)) return msg.message
  if (typeof msg?.message !== "string") return []
  const parts = []
  const re = /\[CQ:([^,\]]+)((?:,[^\]]*)?)\]/g
  let last = 0, m
  while ((m = re.exec(msg.message))) {
    if (m.index > last) parts.push({ type: "text", data: { text: msg.message.slice(last, m.index) } })
    const data = {}
    for (const kv of m[2].split(",")) { const i = kv.indexOf("="); if (i > 0) data[kv.slice(0, i)] = kv.slice(i + 1) }
    parts.push({ type: m[1], data })
    last = m.index + m[0].length
  }
  if (last < msg.message.length) parts.push({ type: "text", data: { text: msg.message.slice(last) } })
  return parts
}
function textOf(msg) { return messageParts(msg).filter((p) => p?.type === "text").map((p) => p?.data?.text || "").join("").trim() }
function nameOf(msg) { return msg.sender?.card || msg.sender?.nickname || String(msg.user_id) }
function splitMessages(text, limit = 800) {
  const out = []
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.length <= limit) { out.push(line); continue }
    let rest = line
    while (rest.length > limit) { out.push(rest.slice(0, limit)); rest = rest.slice(limit) }
    if (rest) out.push(rest)
  }
  return out
}

const sendChains = new Map()
function enqueueSend(key, fn) {
  const prev = sendChains.get(key) || Promise.resolve()
  const run = prev.then(fn, fn)
  sendChains.set(key, run.catch(() => {}))
  return run
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function sendPrivate(text) {
  return enqueueSend("private", async () => {
    for (const line of splitMessages(text)) {
      try { await call("send_private_msg", { user_id: ownerQQ, message: line }); log("sent private", line.slice(0, 40)) } catch (e) { log("send private failed", String(e)); return false }
      await sleep(900 + Math.min(2500, line.length * 45))
    }
    return true
  })
}
function sendGroup(groupId, text) {
  return enqueueSend(`group:${groupId}`, async () => {
    const banned = (Array.isArray(groupCfg().bannedWords) ? groupCfg().bannedWords : []).map((x) => String(x || "").trim()).filter(Boolean)
    for (const line of splitMessages(text)) {
      if (/\[SILENT\]/i.test(line)) continue
      if (banned.some((w) => line.includes(w))) { log("group filter blocked", line.slice(0, 40)); continue }
      try { await call("send_group_msg", { group_id: Number(groupId), message: line }); log("sent group", line.slice(0, 40)) } catch (e) { log("send group failed", String(e)); return false }
      await sleep(900 + Math.min(2500, line.length * 45))
    }
    return true
  })
}


// ———————————————— 附件 ————————————————
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** 语音一般很短，给 20MB 足够 */
const MAX_VOICE_BYTES = 20 * 1024 * 1024
/** 工作文件不设上限（下载走流式落盘，不进内存） */
const MAX_FILE_BYTES = Infinity
/** 单条私聊的附件总量兜底：防止一次塞进一堆大文件把盘写满 */
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024
/** 群文件是外部输入，默认 100MB 上限；私聊工作文件仍不设上限 */
const DEFAULT_GROUP_FILE_BYTES = 100 * 1024 * 1024
/** 群里一次触发最多下载 200MB（同一条消息可带多个文件） */
const DEFAULT_GROUP_BATCH_BYTES = 200 * 1024 * 1024
/** 图片在缩放前的原始大小上限（再大就不折腾了） */
const HARD_CAP_BYTES = 40 * 1024 * 1024
/** 最近一次附件失败原因，用来给出准确提示 */
let lastAttachmentIssue = ""
function mimeOf(path) {
  const ext = (String(path).match(/\.[A-Za-z0-9]+$/) || [""])[0].toLowerCase()
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" })[ext] || "image/jpeg"
}
function mediaParts(msg) {
  const out = []
  for (const p of messageParts(msg)) {
    const d = p?.data || {}
    if (p?.type === "image" || p?.type === "mface") {
      out.push({ type: "image", url: /^https?:\/\//i.test(d.url || "") ? d.url : "", file: d.file || "", fileId: d.file_id || d.fileId || "", fileHash: d.file_hash || "", fileSize: Number(d.file_size) || 0, name: d.file_name || d.file || d.summary || "image.jpg" })
    } else if (p?.type === "file") {
      out.push({ type: "file", url: /^https?:\/\//i.test(d.url || "") ? d.url : "", file: d.file || "", fileId: d.file_id || d.fileId || "", fileHash: d.file_hash || "", busid: Number(d.busid) || 0, fileSize: Number(d.file_size) || 0, name: d.file_name || d.name || d.file || "file" })
    } else if (p?.type === "record" || p?.type === "voice") {
      out.push({ type: "voice", url: /^https?:\/\//i.test(d.url || "") ? d.url : "", file: d.file || "", fileId: d.file_id || d.fileId || "", fileHash: d.file_hash || "", fileSize: Number(d.file_size) || 0, name: d.file_name || d.file || d.name || "voice.amr" })
    }
  }
  return out.slice(0, 10)
}
function imagePayload(path) {
  return { type: "image", data: readFileSync(path).toString("base64"), mimeType: mimeOf(path) }
}
async function resolveMedia(m, groupId = "") {
  const url = String(m.url || "")
  if (url.startsWith("base64://")) return { ...m, base64: url.slice(9) }
  if (/^data:[^;]+;base64,/i.test(url)) return { ...m, base64: url.split(",")[1] }
  if (/^https?:\/\//i.test(url)) return m
  if (m.type === "voice") {
    // QQ 语音常是 SILK/AMR；让 OneBot 直接转 mp3，ffmpeg 两个平台都解不了 SILK
    try {
      const res = await call("get_record", { file: m.file || m.fileId || "", file_id: m.fileId || "", out_format: "mp3" })
      const d = res?.data || {}
      log("voice get_record", JSON.stringify(d).slice(0, 300))
      const u = String(d.url || "")
      if (/^https?:\/\//i.test(u)) return { ...m, url: u, name: "voice.mp3" }
      const f = String(d.file || "")
      if (/^https?:\/\//i.test(f)) return { ...m, url: f, name: "voice.mp3" }
      if (f.startsWith("base64://")) return { ...m, base64: f.slice(9), name: "voice.mp3" }
      if (/^data:/i.test(f)) return { ...m, base64: f.split(",")[1], name: "voice.mp3" }
      if (f && existsSync(f)) return { ...m, localPath: f, name: "voice.mp3" }
    } catch (e) { log("get_record failed", String(e)) }
    return undefined
  }
  if (m.type === "image") {
    try {
      const res = await call("get_image", m.fileId && !m.file ? { file_id: m.fileId } : { file: m.file || m.fileId || "" })
      const d = res?.data || {}
      const u = String(d.url || "")
      if (/^https?:\/\//i.test(u)) return { ...m, url: u, name: d.file_name || m.name }
      if (u.startsWith("base64://")) return { ...m, base64: u.slice(9) }
      if (/^data:/i.test(u)) return { ...m, base64: u.split(",")[1] }
      const raw = String(d.base64 || d.file || "")
      if (/^https?:\/\//i.test(raw)) return { ...m, url: raw, name: d.file_name || m.name }
      if (raw.startsWith("base64://")) return { ...m, base64: raw.slice(9) }
      if (/^data:/i.test(raw)) return { ...m, base64: raw.split(",")[1] }
      if (raw && existsSync(raw)) return { ...m, localPath: raw, name: d.file_name || m.name }
    } catch (e) { log("get_image failed", String(e)) }
    return undefined
  }
  try {
    // 群文件要用 get_group_file_url，私聊才用 get_private_file_url
    const res = groupId
      ? await call("get_group_file_url", { group_id: Number(groupId), file_id: m.fileId || m.file || "", busid: m.busid || 0, file_hash: m.fileHash || "" })
      : await call("get_private_file_url", { user_id: ownerQQ, file_id: m.fileId || m.file || "", file_hash: m.fileHash || "" })
    const d = res?.data || {}
    if (/^https?:\/\//i.test(d.url || "")) return { ...m, url: d.url, name: d.file_name || m.name }
    if (d.base64) return { ...m, base64: d.base64 }
  } catch (e) { log(groupId ? "get_group_file_url failed" : "get_private_file_url failed", String(e)) }
  return undefined
}
/** 找一个可用的图片缩放工具（装了哪个用哪个） */
function findConverter() {
  for (const cmd of ["magick", "convert", "ffmpeg"]) {
    try {
      const r = spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" })
      if (r.status === 0) return cmd
    } catch { /* ignore */ }
  }
  return ""
}

/** 图片超上限时缩到 1568px 长边、JPEG，返回新路径 */
function resizeImage(path, maxBytes) {
  const cmd = findConverter()
  if (!cmd) return undefined
  const out = `${path}.small.jpg`
  const args = cmd === "ffmpeg"
    ? ["-y", "-loglevel", "error", "-i", path, "-vf", "scale=min(1568\\,iw):-2", "-q:v", "3", out]
    : [path, "-resize", "1568x1568>", "-quality", "85", out]
  try {
    const r = spawnSync(cmd, args, { timeout: 30_000 })
    if (r.status !== 0 || !existsSync(out)) return undefined
    if (statSync(out).size > maxBytes) { try { unlinkSync(out) } catch { /* ignore */ } return undefined }
    return out
  } catch { return undefined }
}

async function downloadMedia(m, maxBytes) {
  // 文件：流式落盘，不设大小上限（工作文件可能很大）
  if (m.type === "file" && !m.base64 && !m.localPath && /^https?:\/\//i.test(m.url || "")) {
    try {
      const res = await fetch(m.url, { signal: AbortSignal.timeout(10 * 60_000) })
      if (!res.ok || !res.body) { lastAttachmentIssue = "download"; return undefined }
      const declared = Number(res.headers.get("content-length") || 0)
      if (Number.isFinite(maxBytes) && declared > maxBytes) { lastAttachmentIssue = "too_large"; log("file too large (content-length)", declared); return undefined }
      mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 })
      const ext = (String(m.name || "").match(/\.[A-Za-z0-9]{1,8}$/) || [".bin"])[0]
      const path = join(TMP_DIR, `qq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
      let received = 0
      let capped = false
      // 流式落盘也守住上限：没有 content-length 的分块传输按实际字节数拦
      const limiter = new Transform({
        transform(chunk, _enc, cb) {
          received += chunk.length
          if (Number.isFinite(maxBytes) && received > maxBytes) { capped = true; cb(new Error("too large")); return }
          cb(null, chunk)
        },
      })
      try {
        await pipeline(Readable.fromWeb(res.body), limiter, createWriteStream(path, { mode: 0o600 }))
      } catch (e) {
        try { unlinkSync(path) } catch { /* ignore */ }
        lastAttachmentIssue = capped ? "too_large" : "download"
        log("file download failed", String(e).slice(0, 200))
        return undefined
      }
      return { path, name: m.name || basename(path) }
    } catch (e) {
      lastAttachmentIssue = "download"
      log("file download failed", String(e).slice(0, 200))
      return undefined
    }
  }
  let buf
  if (m.base64) buf = Buffer.from(String(m.base64), "base64")
  else if (m.localPath && existsSync(m.localPath)) buf = readFileSync(m.localPath)
  else if (/^https?:\/\//i.test(m.url || "")) {
    let res
    try {
      res = await fetch(m.url, { signal: AbortSignal.timeout(15000) })
    } catch (e) {
      lastAttachmentIssue = "download"
      log("attachment fetch failed", String(e).slice(0, 160))
      return undefined
    }
    if (!res.ok) { lastAttachmentIssue = "download"; return undefined }
    const len = Number(res.headers.get("content-length") || 0)
    if (len > HARD_CAP_BYTES) {
      lastAttachmentIssue = "too_large"
      log("attachment too large (hard cap)", len)
      return undefined
    }
    try {
      buf = Buffer.from(await res.arrayBuffer())
    } catch (e) {
      lastAttachmentIssue = "download"
      log("attachment body read failed", String(e).slice(0, 160))
      return undefined
    }
  } else { lastAttachmentIssue = "download"; return undefined }
  if (buf.length > HARD_CAP_BYTES) { lastAttachmentIssue = "too_large"; return undefined }
  mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 })
  const ext = m.type === "image"
    ? ((String(m.name || m.url || "").match(/\.(png|jpe?g|gif|webp)/i) || [".jpg"])[0])
    : ((String(m.name || "").match(/\.[A-Za-z0-9]{1,8}$/) || [".bin"])[0])
  let path = join(TMP_DIR, `qq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
  writeFileSync(path, buf, { mode: 0o600 })
  if (buf.length > maxBytes) {
    if (m.type !== "image") {
      lastAttachmentIssue = "too_large"
      try { unlinkSync(path) } catch { /* ignore */ }
      log("file too large", buf.length)
      return undefined
    }
    const small = resizeImage(path, maxBytes)
    if (!small) {
      lastAttachmentIssue = "too_large"
      try { unlinkSync(path) } catch { /* ignore */ }
      log("image too large and cannot resize", buf.length)
      return undefined
    }
    log("image resized", buf.length, "→", statSync(small).size)
    try { unlinkSync(path) } catch { /* ignore */ }
    path = small
  }
  return { path, name: m.name || basename(path) }
}
async function fetchAttachment(m, maxBytes, groupId = "") {
  // 语音优先让 OneBot 转 mp3，避免拿到 SILK
  if (m.type === "voice") {
    const fresh = await resolveMedia({ ...m, url: "", base64: undefined, localPath: undefined }, groupId)
    if (fresh) {
      const got = await downloadMedia(fresh, maxBytes)
      if (got) return got
    }
  }
  let got = await downloadMedia(m, maxBytes)
  if (got) return got
  const refreshed = await resolveMedia({ ...m, url: "", base64: undefined, localPath: undefined }, groupId)
  if (!refreshed) return undefined
  return downloadMedia(refreshed, maxBytes)
}

// ———————————————— pi RPC ————————————————
class PiSession {
  constructor({ channel = "qq", groupId = "", name = "qq-chat", sessionFile = "" }) {
    this.channel = channel
    this.groupId = groupId
    this.name = name
    this.sessionFile = sessionFile
    // 群聊优先在线模型；私聊仍用启动时指定的（本地）
    this.model = channel === "group" && CLOUD_MODEL ? CLOUD_MODEL : MODEL
    this.child = null
    this.buffer = ""
    this.running = false
    this.texts = []
    this.waiters = []
    this.idleWaiters = []
    this.reqId = 0
    this.closed = false
    /** 子进程代际：旧进程晚退出时不污染新进程的状态 */
    this.gen = 0
    this.lastUsed = Date.now()
    this.lastOverflow = false
    this.overflowReset = false
    /** 模型在调工具前先应了一声：桥接把这句立刻发出去，只发一次 */
    this.onAck = null
    this.ackSent = false
    /** 当前这一轮的起点与正在跑的工具，给 /show 和看板用 */
    this.turnStartedAt = 0
    this.currentTool = null
    /** 最后一次收到 pi 任何输出的时间（看门狗用） */
    this.lastEventAt = 0
    /** prompt 串行队列 */
    this.promptChain = Promise.resolve()
    /** /stop 之后丢弃这一轮已经吐出来的半截话 */
    this.abortRequested = false
  }
  env() {
    return { ...process.env, TZ, LIFE_WORLD_ROOT: ROOT, LIFE_WORLD_ROLE: this.channel === "qq" ? "qq" : "group", LIFE_WORLD_CHANNEL: this.channel, LIFE_WORLD_GROUP_ID: this.groupId }
  }
  start() {
    if (this.child) return
    const gen = ++this.gen
    // 换进程后旧的半行缓冲必须丢掉，否则会和新进程的第一行拼成坏 JSON
    this.buffer = ""
    this.running = false
    const args = ["--mode", "rpc", "--model", this.model, "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-extensions", "-e", EXT, "--session-dir", SESSION_DIR]
    if (this.sessionFile) args.push("--session", this.sessionFile)
    else args.push("--name", this.name)
    log("pi start", this.name, this.model, this.sessionFile || "(new)")
    const child = spawn(PI_BIN, args, { env: this.env(), stdio: ["pipe", "pipe", "pipe"] })
    this.child = child
    this.closed = false
    this.lastUsed = Date.now()
    child.on("error", (e) => { log("pi spawn error", String(e)); this.onExit(gen) })
    child.on("exit", (code, signal) => { log("pi exit", this.name, code, signal); this.onExit(gen) })
    child.stderr.on("data", (d) => { if (gen === this.gen) log("pi stderr", String(d).slice(0, 300)) })
    child.stdout.on("data", (d) => { if (gen === this.gen) this.onData(String(d)) })
    this.request("get_state").then((res) => {
      if (gen !== this.gen) return
      const file = res?.data?.sessionFile
      // 只有私聊会话写进全局状态；群会话不能覆盖它
      if (file) { this.sessionFile = file; if (this.channel === "qq") { state.piSessionFile = file; saveState() } }
    }).catch(() => {})
  }
  onExit(gen = this.gen) {
    // 旧子进程晚退出：别把新 child / 新状态清掉
    if (gen !== this.gen) return
    this.closed = true
    this.child = null
    this.running = false
    this.texts = []
    for (const w of this.waiters.splice(0)) w.reject(new Error("pi exited"))
    // 卡在“等上一轮说完”的调用也要放行，否则私聊链会永远停在这里
    for (const r of this.idleWaiters.splice(0)) r()
    if (!this.stopping) setTimeout(() => this.start(), 2000)
  }
  /** 群会话闲置回收：停掉子进程，调用方从 map 里删掉 */
  destroy() {
    this.stopping = true
    this.gen++
    const old = this.child
    this.child = null
    this.closed = true
    try { old?.kill("SIGTERM") } catch { /* ignore */ }
  }
  onData(chunk) {
    this.buffer += chunk
    let idx
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "")
      this.buffer = this.buffer.slice(idx + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      this.onRecord(msg)
    }
  }
  onRecord(msg) {
    // 任何一条 pi 输出都算「有动静」，看门狗据此判断是不是真卡住了
    this.lastEventAt = Date.now()
    if (isResponse(msg) && msg.id && this.pendingResponses?.has(msg.id)) {
      const p = this.pendingResponses.get(msg.id)
      this.pendingResponses.delete(msg.id)
      if (responseOk(msg)) p.resolve(msg)
      else p.reject(new Error(responseError(msg)))
      return
    }
    if (isMessageEnd(msg)) {
      const m = msg.message
      if (isAssistant(m)) {
        const tool = toolCallOf(m)
        if (tool) this.currentTool = { ...tool, at: Date.now() }
        const text = rpcTextOf(m)
        if (text) {
          if (isToolUse(m)) {
            // 她要先应一声：这句立刻发出去，不等整轮跑完
            if (!this.ackSent && typeof this.onAck === "function") {
              this.ackSent = true
              try { this.onAck(text) } catch (e) { log("ack handler failed", String(e)) }
            }
          } else {
            this.texts.push(text)
          }
        }
        // 没说话就直接调工具：桥接不替她开口，安静等最终结果
        if (isError(m)) log("message_end error", errorMessage(m).slice(0, 120))
        if (isOverflow(m)) this.lastOverflow = true
      }
      return
    }
    if (isAgentStart(msg)) {
      this.running = true
      this.turnStartedAt = Date.now()
      this.currentTool = null
      return
    }
    if (isAgentSettled(msg)) {
      this.running = false
      this.currentTool = null
      const collected = this.texts.splice(0)
      // 被中断的这一轮不要半截回复（msg.aborted 是 pi 自己的信号）
      const texts = (this.abortRequested || settledAborted(msg)) ? [] : collected
      this.abortRequested = false
      const waiters = this.waiters.splice(0)
      for (const w of waiters) w.resolve(texts)
      const idle = this.idleWaiters.splice(0)
      for (const r of idle) r()
      return
    }
    if (isExtensionUIRequest(msg)) {
      // QQ 不渲染面板：直接取消
      this.write(reqExtensionUIResponse(msg.id))
    }
  }
  write(obj) { try { this.child?.stdin.write(JSON.stringify(obj) + "\n") } catch (e) { log("pi write failed", String(e)) } }
  request(type, extra = {}) {
    if (!this.pendingResponses) this.pendingResponses = new Map()
    const id = `r-${++this.reqId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingResponses.delete(id); reject(new Error(`${type} timeout`)) }, 30000)
      this.pendingResponses.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
      this.write({ id, type, ...extra })
    })
  }
  /** 等这一轮结束；超时返回 false */
  waitIdle(ms = 3000) {
    if (!this.running) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms)
      this.idleWaiters.push(() => { clearTimeout(timer); resolve(true) })
    })
  }

  /** 给人看的当前状态：/show 指令和看板都用它 */
  describeBusy() {
    if (!this.running) {
      const idle = this.lastUsed ? Date.now() - this.lastUsed : -1
      return idle >= 0 ? `没在忙。上次动过是 ${fmtSpan(idle)} 前。` : "没在忙。"
    }
    const lines = [`正在忙，这一轮已经跑了 ${fmtSpan(Date.now() - (this.turnStartedAt || Date.now()))}`]
    if (this.currentTool) {
      const arg = toolArgSummary(this.currentTool.args)
      lines.push(`工具：${this.currentTool.name}${arg ? `\n${arg}` : ""}`)
      const spent = Date.now() - (this.currentTool.at || Date.now())
      if (spent > 3000) lines.push(`这个工具已经跑了 ${fmtSpan(spent)}`)
    } else {
      lines.push("在等模型回复")
    }
    return lines.join("\n")
  }

  prompt(text, images = [], timeoutMs = 0) {
    // 同一会话的 prompt 串行排队：agent_settled 会一次性放行所有 idle 等待者，
    // 不排队的话群聊密集时多个 prompt 会同时写入、回复串台
    const run = this.promptChain.then(() => this.promptRaw(text, images, timeoutMs))
    this.promptChain = run.catch(() => {})
    return run
  }

  // timeoutMs = 0：不限时（本地模型慢，等它说完）
  async promptRaw(text, images = [], timeoutMs = 0) {
    this.lastUsed = Date.now()
    this.lastOverflow = false
    this.ackSent = false
    if (this.closed || !this.child) this.start()
    if (this.running) {
      await new Promise((resolve) => this.idleWaiters.push(resolve))
    }
    // 等待期间进程可能崩了：重新拉起再写
    if (this.closed || !this.child) this.start()
    this.texts = []
    const wait = new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => { reject(new Error("prompt timeout")) }, timeoutMs) : null
      this.waiters.push({
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v) },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e) },
      })
    })
    this.write(reqPrompt(undefined, text, images))
    return wait
  }
  overflowMarkerPath() {
    const key = this.channel === "qq" ? "qq" : `group-${this.groupId}`
    return join(ROOT, `context-overflow-${key.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`)
  }
  takeOverflowMarker() {
    const f = this.overflowMarkerPath()
    try {
      if (!existsSync(f)) return false
      const j = JSON.parse(readFileSync(f, "utf8"))
      unlinkSync(f)
      return !!j.at && Date.now() - j.at < 10 * 60_000
    } catch { return false }
  }
  /** 上下文超限：自动换新会话，并把同一条重发一次；其它错误不处理 */
  async promptWithRecovery(text, images = [], timeoutMs = 0) {
    this.overflowReset = false
    // 上一轮留下的超限标记：先换会话，别在旧会话上再撞一次
    if (this.takeOverflowMarker()) {
      log("context overflow marker · reset before prompt", this.name)
      await this.newSession()
      this.overflowReset = true
    }
    let texts = await this.prompt(text, images, timeoutMs)
    let hit = this.lastOverflow
    if (!hit) {
      // 标记可能比 agent_settled 稍晚落盘
      await sleep(250)
      hit = this.takeOverflowMarker()
    }
    if (!hit) return texts
    this.lastOverflow = false
    this.takeOverflowMarker()
    log("context overflow · reset session and retry", this.name)
    await this.newSession()
    this.overflowReset = true
    texts = await this.prompt(text, images, timeoutMs)
    return texts
  }
  async newSession() {
    this.stopping = true
    // 先换代：旧子进程杀掉后晚到的 exit/data 回调全部作废
    this.gen++
    const old = this.child
    this.child = null
    this.closed = true
    try { old?.kill("SIGTERM") } catch { /* ignore */ }
    for (const w of this.waiters.splice(0)) w.reject(new Error("session reset"))
    for (const r of this.idleWaiters.splice(0)) r()
    await sleep(800)
    this.stopping = false
    this.sessionFile = ""
    // 换会话后这些轮次状态必须归零，否则上一轮的「已中断」会吞掉新会话的第一条回复
    this.abortRequested = false
    this.ackSent = false
    this.lastOverflow = false
    this.running = false
    this.currentTool = null
    this.texts = []
    delete state.piSessionFile
    saveState()
    this.start()
  }
}

const pi = new PiSession({ channel: "qq", name: "qq-chat", sessionFile: state.piSessionFile || "" })

// ———————————————— typing ————————————————
let typingTimer = null
function startTyping() {
  if (typingTimer) return
  const ping = () => call("set_input_status", { user_id: ownerQQ, event_type: 1 }).catch(() => {})
  ping()
  typingTimer = setInterval(ping, 4000)
  typingTimer.unref?.()
}
function stopTyping() {
  if (typingTimer) { clearInterval(typingTimer); typingTimer = null }
  call("set_input_status", { user_id: ownerQQ, event_type: 0 }).catch(() => {})
}

// ———————————————— 余波 ————————————————
const afterglow = { timer: null, round: 0, seq: 0, userSeq: 0 }
function clearAfterglow() { if (afterglow.timer) { clearTimeout(afterglow.timer); afterglow.timer = null } }
function userReturned() { afterglow.userSeq++; afterglow.round = 0; clearAfterglow(); log("userReturned", afterglow.userSeq) }
function armAfterglow(round) {
  if (!afterglowCfg.enabled || afterglowCfg.maxRounds <= 0 || round < 1 || round > afterglowCfg.maxRounds) return
  clearAfterglow()
  afterglow.round = round
  afterglow.seq = afterglow.userSeq
  afterglow.timer = setTimeout(async () => {
    afterglow.timer = null
    log("afterglow fire", round, "seq", afterglow.seq, "userSeq", afterglow.userSeq, "running", pi.running)
    if (afterglow.seq !== afterglow.userSeq || pi.running) return
    try {
      startTyping()
      const texts = await pi.promptWithRecovery("【余波】对方还没回你，已经过了一会儿。\n不要假装他说话了，也不要重新打招呼。\n如果上一轮还有没说完的、想补一句解释、或者想问一句怎么不说话——现在补一句；一两句就够。\n如果觉得这会儿不该说、没什么要补的，就只回 [SILENT]。\n直接写正文，不要调用 reach_out。")
      stopTyping()
      // 生成期间对方回来了：这句余波就作废，别再追着发
      if (afterglow.seq !== afterglow.userSeq) { log("afterglow cancelled · user returned"); return }
      const text = texts.join("\n").trim()
      if (!text || /^\[SILENT\]$/i.test(text)) { afterglow.round = 0; return }
      const sent = await sendPrivate(text)
      // 没发出去就别继续下一拍
      if (sent && afterglow.seq === afterglow.userSeq) armAfterglow(round + 1)
    } catch (e) { log("afterglow failed", String(e)); stopTyping() }
  }, Number(afterglowCfg.delayMs) || 60000)
  afterglow.timer.unref?.()
  log("afterglow armed", round, afterglowCfg.delayMs)
}

// ———————————————— 私聊 ————————————————
async function handlePrivateNow(msg) {
  if (Number(msg.user_id) !== ownerQQ) return
  userReturned()
  const text = textOf(msg)
  const media = mediaParts(msg)
  if (!text && !media.length) return
  const attachments = []
  lastAttachmentIssue = ""
  let budget = MAX_TOTAL_BYTES
  for (const item of media) {
    const cap = item.type === "image" ? MAX_IMAGE_BYTES : item.type === "voice" ? MAX_VOICE_BYTES : MAX_FILE_BYTES
    const max = Math.min(cap, budget)
    if (max <= 0) break
    const got = await fetchAttachment(item, max)
    if (!got) continue
    let size = 0
    try { size = statSync(got.path).size } catch { /* ignore */ }
    if (size > budget) { try { unlinkSync(got.path) } catch { /* ignore */ } continue }
    budget -= size
    attachments.push({ ...got, type: item.type })
  }
  if (!text && !attachments.length) {
    const hasVoice = media.some((m) => m.type === "voice")
    const tip = lastAttachmentIssue === "too_large"
      ? (hasVoice ? "（语音太大了：上限 20MB，发短一点的。）" : "（图片太大了：单张上限 8MB，缩一下或截小一点再发；装了 imagemagick 或 ffmpeg 的话我会自动缩。）")
      : hasVoice ? "（语音没下载下来，再发一次试试？）" : "（附件没下载下来，再发一次试试？）"
    await call("send_private_msg", { user_id: ownerQQ, message: tip }).catch(() => {})
    return
  }
  const images = attachments.filter((a) => a.type === "image").map((a) => imagePayload(a.path))
  const notes = attachments.length
    ? `\n（对方发来 ${attachments.length} 个附件：${attachments.map((a) => a.type === "image" ? `[图片 ${basename(a.path)}]` : a.type === "voice" ? `[语音 ${basename(a.path)}：${a.path}]` : `[文件 ${basename(a.path)}：${a.path}]`).join("、")}；图片已附在请求里，语音可以用 perceive({ path: "…", kind: "audio" }) 听，文件路径可直接用 read 工具读。）`
    : (media.length ? `\n（对方发了 ${media.length} 个附件，但都没下载下来。）` : "")
  /** 读主动发送流水：对方隔很久才回时，让会话知道「我之前发过什么」 */
function recentProactiveNote(hours = 12, max = 5) {
  try {
    const dir = join(WORLD, "proactive")
    if (!existsSync(dir)) return ""
    const since = Date.now() - hours * 3600_000
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().slice(-2)
    const items = []
    for (const f of files) {
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        if (!line.trim()) continue
        let rec
        try { rec = JSON.parse(line) } catch { continue }
        const t = Date.parse(rec.t || "")
        if (!Number.isFinite(t) || t < since) continue
        items.push(rec)
      }
    }
    if (!items.length) return ""
    const label = (k) => (k === "image" ? "图片" : k === "voice" ? "语音" : k === "file" ? "文件" : k)
    const lines = items.slice(-max).map((r) => {
      const d = new Date(r.t)
      const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
      // 云端模型不念正文：本地发过的私密内容不该进云端上下文
      const cfg = readJson(CONFIG_FILE, {})
      const cloudMode = !!(cfg?.models?.cloud && MODEL === cfg.models.cloud)
      const body = cloudMode
        ? `[${label(r.kind)}]`
        : (r.kind === "reach"
          ? String(r.text || "").slice(0, 60).replace(/\s+/g, " ")
          : `[${label(r.kind)}] ${String(r.name || "").slice(0, 40)}${r.text ? `：${String(r.text).slice(0, 40).replace(/\s+/g, " ")}` : ""}`)
      return `  ${hm} ${body}`
    })
    return `（你最近主动给他发过：\n${lines.join("\n")}\n）\n`
  } catch { return "" }
}

  const proactive = recentProactiveNote()
  const annotated = `[私聊｜${nameOf(msg)}（QQ ${msg.user_id}）] ${text || "（只有附件，没有文字）"}${notes}\n${proactive}（这是 QQ 私聊：按 system 里的规则回复；直接写正文，不要调用 reach_out。）`
  log("private in", text.slice(0, 60), "attachments", attachments.length)
  startTyping()
  // 她调工具前先应一声，就把那句立刻发出去；她闷头调工具就不代发，安静等结果
  let acked = false
  pi.onAck = (ack) => {
    if (acked) return
    const t = String(ack || "").trim()
    if (!t) return
    acked = true
    void sendPrivate(t)
  }
  try {
    const texts = await pi.promptWithRecovery(annotated, images)
    stopTyping()
    if (pi.overflowReset) {
      pi.overflowReset = false
      await sendPrivate(pi.lastOverflow
        ? "上下文超了，开了新会话还是没接上，再发一次试试？"
        : "上下文超了，我开了个新会话，这条重新接上来了。")
    }
    const reply = texts.join("\n").trim()
    const replied = !!reply && !/^\[SILENT\]$/i.test(reply)
    if (replied) await sendPrivate(reply)
    if (state.reachBuffer && state.reachBuffer.length) {
      const buffered = state.reachBuffer.splice(0)
      for (const line of buffered) await sendPrivate(line)
      saveState()
    }
    // 她选择 [SILENT] 就别 arm 余波：那不是「对方没回」，是她不想接
    if (replied && afterglowCfg.enabled && afterglowCfg.maxRounds > 0) armAfterglow(1)
  } catch (e) {
    stopTyping()
    const msg = String(e)
    log("private prompt failed", msg)
    // /new 或超限换会话属于正常中止，别再多补一条「没接上」
    if (!/session reset|watchdog timeout/i.test(msg)) {
      await call("send_private_msg", { user_id: ownerQQ, message: "（我这边暂时没接上，稍后再发一次试试）" }).catch(() => {})
    }
  } finally {
    pi.onAck = null
  }
}

let privateChain = Promise.resolve()
function handlePrivate(msg) {
  // 指令不进串行链：正卡在一轮里的时候，/show /stop 也得能用
  const cmd = String(textOf(msg) || "").trim().toLowerCase()
  if (cmd === "/show" || cmd === "/stop" || cmd === "/new") return handleOwnerCommand(msg, cmd)
  const run = privateChain.then(() => handlePrivateNow(msg)).catch((e) => log("handle private failed", String(e)))
  privateChain = run.catch(() => {})
  return run
}

/** 主人指令：/show 看她在干嘛，/stop 中断当前轮，/new 开新会话 */
async function handleOwnerCommand(msg, cmd) {
  if (Number(msg.user_id) !== Number(ownerQQ)) return
  const reply = (text) => call("send_private_msg", { user_id: ownerQQ, message: text }).catch(() => {})
  if (cmd === "/new") {
    await pi.newSession()
    await reply("新对话已开。")
    return
  }
  if (cmd === "/show") {
    await reply(pi.describeBusy())
    return
  }
  if (cmd === "/stop") {
    if (!pi.running) { await reply("没在忙，不用停。"); return }
    log("owner stop · abort current turn")
    pi.abortRequested = true
    pi.write(reqAbort())
    let ok = await pi.waitIdle(3000)
    if (!ok) {
      pi.write(reqAbortBash())
      ok = await pi.waitIdle(4000)
    }
    await reply(ok ? "已停下。" : "中断发出去了，还没停住；再发一次 /stop 试试。")
  }
}

// ———————————————— 群聊（基础版） ————————————————
const groupSessions = new Map()
const groupBuffers = new Map()
function getGroupSession(groupId) {
  const key = String(groupId)
  let s = groupSessions.get(key)
  if (!s) {
    s = new PiSession({ channel: "group", groupId: key, name: `qq-group-${key}` })
    s.start()
    groupSessions.set(key, s)
  }
  return s
}
function isAtBot(msg) {
  return messageParts(msg).some((p) => p?.type === "at" && String(p?.data?.qq) === String(msg.self_id))
}
function groupTrigger(msg, text) {
  const kws = Array.isArray(groupCfg().keywords) ? groupCfg().keywords : []
  return isAtBot(msg) || kws.some((k) => String(k).trim() && text.includes(String(k).trim())) || /小铃|铃儿|@铃/.test(text)
}
const groupStates = new Map()
function groupState(key) {
  let st = groupStates.get(key)
  if (!st) { st = { lastReplyAt: 0, replies: [] }; groupStates.set(key, st) }
  return st
}
async function handleGroup(msg) {
  if (!groupCfg().enabled) return
  if (Number(msg.user_id) === Number(msg.self_id)) return
  const groupId = Number(msg.group_id)
  if (!groupId) return
  const text = textOf(msg)
  // 群里的图片和文件都收：图片进请求，文件落 tmp 后把路径给模型；群里没有 perceive，语音先不进
  const media = mediaParts(msg).filter((m) => m.type !== "voice")
  if (!text && !media.length) return
  const key = String(groupId)
  const buf = groupBuffers.get(key) || []
  const trigger = groupTrigger(msg, text)
  const mediaLabel = media.some((m) => m.type === "image") ? "[图片]" : "[文件]"
  buf.push({ sender: nameOf(msg), text: text || mediaLabel, media, trigger, at: Date.now() })
  // 群一直刷屏时防抖会一直重置，缓冲必须有上限；优先丢普通消息，别把 @ 点名挤掉
  while (buf.length > 50) {
    const idx = buf.findIndex((m) => !m.trigger)
    if (idx >= 0) buf.splice(idx, 1)
    else buf.shift()
  }
  log("group in", key, nameOf(msg), trigger ? "T" : "-", (text || "[图片]").slice(0, 40))
  groupBuffers.set(key, buf)
  if (buf.timer) clearTimeout(buf.timer)
  buf.timer = setTimeout(async () => {
    // 整个回调兜底：附件下载失败 / 判官异常都不能把桥接进程带走
    try {
    const current = groupBuffers.get(key) || []
    const batch = current.splice(0)
    // 清掉定时器标记，否则闲置回收会一直以为“还有防抖中的消息”
    current.timer = null
    if (!batch.length) return
    const st = groupState(key)
    const now = Date.now()
    const triggered = batch.some((m) => m.trigger)
    const cooldown = Number(groupCfg().cooldownMs ?? 8000)
    if (!triggered && cooldown > 0 && now - st.lastReplyAt < cooldown) { log("group cooldown"); return }
    const cap = Number(groupCfg().maxPer10Min ?? 0)
    st.replies = st.replies.filter((t) => now - t < 600000)
    if (!triggered && cap > 0 && st.replies.length >= cap) { log("group rate limit"); return }
    if (!triggered && Math.random() >= (groupCfg().interjectChance ?? 0.05)) { log("group skip probability"); return }
    const judge = await judgeGroup(key, batch)
    if (judge !== "REPLY") { log("judge SKIP"); return }
    const images = []
    const files = []
    const groupFileCap = Number(groupCfg().maxFileBytes) || DEFAULT_GROUP_FILE_BYTES
    const groupBatchCap = Number(groupCfg().maxBatchBytes) || DEFAULT_GROUP_BATCH_BYTES
    let budget = Math.min(MAX_TOTAL_BYTES, groupBatchCap)
    for (const m of batch) {
      for (const item of m.media || []) {
        const isImage = item.type === "image"
        const got = await fetchAttachment(item, Math.min(isImage ? MAX_IMAGE_BYTES : groupFileCap, budget), key)
        if (!got) continue
        let size = 0
        try { size = statSync(got.path).size } catch { /* ignore */ }
        if (size > budget) { try { unlinkSync(got.path) } catch { /* ignore */ } continue }
        budget -= size
        if (isImage) images.push(imagePayload(got.path))
        else files.push(got.path)
      }
    }
    const session = getGroupSession(key)
    const fileNote = files.length
      ? `\n（群友发来文件：${files.map((p) => `${basename(p)} → ${p}`).join("、")}；路径可直接用 read 工具读。）`
      : ""
    const prompt = `[群聊｜群号 ${key}]\n最近消息：\n${batch.map((m) => `${m.sender}：${m.text}`).join("\n")}${fileNote}\n（这是 QQ 群聊：按 system 里的群聊规则回复；不适合接就只回 [SILENT]。）`
    try {
      const texts = await session.promptWithRecovery(prompt, images)
      const reply = texts.join("\n").trim()
      if (reply && !/^\[SILENT\]$/i.test(reply)) {
        const ok = await sendGroup(key, reply)
        if (ok) { st.lastReplyAt = Date.now(); st.replies.push(Date.now()) }
      }
    } catch (e) { log("group prompt failed", String(e)) }
    } catch (e) {
      log("group batch failed", String(e))
    }
  }, 3000)
}

function judgeGroup(groupId, batch) {
  return new Promise((resolve) => {
    const prompt = ["你是群聊读空气判断器。只输出 REPLY 或 SKIP。", `群号：${groupId}`, "最近消息：", ...batch.map((m) => `${m.sender}：${m.trigger ? "【@/点名】" : ""}${m.text}`), "规则：@/点名/关键词倾向 REPLY；闲聊/广告/敏感 SKIP。"].join("\n")
    // 判官用在线模型（更快）：配了 models.cloud 就用它
    const judgeModel = CLOUD_MODEL || MODEL
    const child = spawn(PI_BIN, ["-p", "--model", judgeModel, "--no-session", "--no-skills", "--no-prompt-templates", "--no-extensions", "--no-context-files", "--no-tools", "--system-prompt", "你是群聊读空气判断器，只输出 REPLY 或 SKIP。"], { env: { ...process.env, TZ }, stdio: ["pipe", "pipe", "ignore"] })
    let out = ""
    const timer = setTimeout(() => { try { child.kill("SIGKILL") } catch { /* ignore */ } resolve("SKIP") }, 45000)
    child.stdout.on("data", (d) => { out += String(d) })
    child.on("close", () => { clearTimeout(timer); resolve(/REPLY/i.test(out) && !/SKIP/i.test(out) ? "REPLY" : "SKIP") })
    child.on("error", () => { clearTimeout(timer); resolve("SKIP") })
    // 必须 end()：pi -p 要等 stdin EOF 才会开始跑
    child.stdin.end(prompt + "\n")
  })
}

/** 群会话闲置回收：默认 2 小时没说话就停掉子进程；群里再有人说话会自动重开 */
function cleanupGroupSessions() {
  const idleMs = Math.max(10, Number(groupCfg().sessionIdleMinutes) || 120) * 60_000
  const now = Date.now()
  for (const [key, s] of groupSessions) {
    if (s.running) continue // 正在生成就别动
    const pending = groupBuffers.get(key)
    // timer 在回调开头会置空，所以这里同时看 timer 和积压都不会误判
    if (pending?.timer || pending?.length) continue
    if (now - (s.lastUsed || 0) < idleMs) continue
    s.destroy()
    groupSessions.delete(key)
    groupBuffers.delete(key)
    groupStates.delete(key)
    log("group session recycled", key)
  }
}

// ———————————————— outbox ————————————————
function outboxFile(day) { return join(OUTBOX_DIR, `${day}.jsonl`) }
function recentDays(n) { const out = []; for (let i = n - 1; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); out.push(dayOf(d)) } return out }
async function sendOutboxMedia(item) {
  let file = String(item.path || "")
  if (!file || !existsSync(file)) { log("outbox media missing", file); return { ok: false } }
  const real = (() => { try { return realpathSync(file) } catch { return "" } })()
  if (!real) return { ok: false }
  const allowed = [join(WORLD, "room"), join(WORLD, "表情包"), join(WORLD, "语音"), join(WORLD, "tmp")].map((d) => { try { return realpathSync(d) } catch { return d } })
  if (!allowed.some((d) => real === d || real.startsWith(d + sep))) return { ok: false }
  const size = statSync(real).size
  const kind = item.mediaType || (/\.(png|jpe?g|gif|webp|bmp)$/i.test(real) ? "image" : /\.(mp3|wav|silk|amr|ogg|m4a)$/i.test(real) ? "voice" : "file")
  if (kind === "file" && size > 20 * 1024 * 1024) return { ok: false }
  if (kind !== "file" && size > 8 * 1024 * 1024) return { ok: false }
  const b64 = readFileSync(real).toString("base64")
  const target = item.target || { kind: "private" }
  const isGroup = target.kind === "group" && target.id
  if (isGroup && kind === "file") return { ok: false }
  const send = (message) => isGroup ? call("send_group_msg", { group_id: Number(target.id), message }, 60000) : call("send_private_msg", { user_id: ownerQQ, message }, 60000)
  const caption = String(item.text || "").slice(0, 500)
  const segments = []
  if (caption) segments.push({ type: "text", data: { text: caption } })
  if (kind === "image") segments.push({ type: "image", data: { file: `base64://${b64}` } })
  else if (kind === "voice") segments.push({ type: "record", data: { file: `base64://${b64}` } })
  else segments.push({ type: "file", data: { file: `base64://${b64}`, name: item.name || basename(real) } })
  try {
    await send(segments)
    log("sent media", kind, item.name || basename(real), caption.slice(0, 30))
    return { ok: true }
  } catch (e) {
    const msg = String(e)
    // 语音段被实现拒绝：私聊退成文件（群聊不退）
    if (kind === "voice" && !isGroup && !/ws not ready|timeout|fetch failed|ECONN|socket/i.test(msg)) {
      try {
        await send([{ type: "file", data: { file: `base64://${b64}`, name: item.name || basename(real) } }])
        log("voice fallback to file", item.name || basename(real))
        return { ok: true }
      } catch (e2) { log("voice fallback failed", String(e2)) }
    }
    log("send media failed", msg)
    return { ok: false, retryable: /ws not ready/i.test(msg) }
  }
}
let lastOutboxPrune = 0
async function pollOutboxNow() {
  // 每天几次把 7 天前的 outbox 文件清掉，别一直堆
  if (Date.now() - lastOutboxPrune > 6 * 3600_000) {
    lastOutboxPrune = Date.now()
    try {
      const cutoff = Date.now() - 7 * 86400_000
      for (const f of readdirSync(OUTBOX_DIR)) {
        if (!f.endsWith(".jsonl")) continue
        if (statSync(join(OUTBOX_DIR, f)).mtimeMs < cutoff) unlinkSync(join(OUTBOX_DIR, f))
      }
    } catch { /* ignore */ }
  }
  const freshState = !state.outbox
  const offsets = state.outbox || (state.outbox = { offsets: {}, since: new Date().toISOString() })
  // 只有全新状态才把 since 定在“现在”（防首次启动把当天旧条目整段重发）；
  // 从没有 since 的旧状态升级时留空 = 不跳过，宁可补发也别漏。
  if (!offsets.since && !freshState) offsets.since = ""
  if (freshState) saveState()
  const sinceMs = Date.parse(offsets.since || "") || 0
  for (const day of recentDays(3)) {
    const file = outboxFile(day)
    if (!existsSync(file)) continue
    const buf = readFileSync(file)
    let offset = offsets.offsets[day]
    let skipBefore = 0
    if (offset === undefined) {
      if (day === dayOf()) {
        // 状态丢了：今天从头补，但只发 since 之后写的，避免把已发过的整段重发
        offset = 0
        skipBefore = sinceMs
      } else {
        // 更早的日子不补历史，只记到文件尾
        offsets.offsets[day] = buf.length
        saveState()
        continue
      }
      offsets.offsets[day] = 0
      saveState()
    }
    if (buf.length <= offset) continue
    const lines = buf.subarray(offset).toString("utf8").split("\n")
    lines.pop()
    let consumed = 0
    for (const line of lines) {
      const bytes = Buffer.byteLength(line + "\n")
      if (!line.trim()) { consumed += bytes; continue }
      let item
      try { item = JSON.parse(line) } catch { consumed += bytes; continue }
      if (skipBefore && Date.parse(String(item.t || "")) < skipBefore) { consumed += bytes; continue }
      if (item.kind === "media") {
        const sent = await sendOutboxMedia(item)
        if (sent.ok || !sent.retryable) consumed += bytes
        else break
      } else if (item.kind === "reach" && item.text) {
        if (pi.running) { state.reachBuffer = [...(state.reachBuffer || []), item.text]; consumed += bytes; continue }
        const ok = await sendPrivate(item.text)
        if (ok) consumed += bytes; else break
      } else consumed += bytes
    }
    if (consumed > 0) { offsets.offsets[day] = offset + consumed; saveState() }
  }
}

let outboxBusy = false
/** 忙的时候 reach_out 会先存进 reachBuffer；空闲下来要有东西把它送出去，不能只等下一句私聊 */
async function flushReachBuffer() {
  if (pi.running) return
  const buf = Array.isArray(state.reachBuffer) ? state.reachBuffer : []
  if (!buf.length) return
  const lines = buf.splice(0)
  for (let i = 0; i < lines.length; i++) {
    const ok = await sendPrivate(lines[i])
    if (!ok) {
      state.reachBuffer = lines.slice(i).concat(state.reachBuffer || [])
      saveState()
      return
    }
  }
  saveState()
}
async function pollOutbox() {
  if (outboxBusy) return
  outboxBusy = true
  try {
    await pollOutboxNow()
    await flushReachBuffer()
  } finally { outboxBusy = false }
}

// ———————————————— 当前状态 / 看板中断 ————————————————
const BUSY_FILE = join(ROOT, "busy-qq.json")
function writeBusy() {
  try {
    const data = pi.running
      ? {
          running: true,
          since: pi.turnStartedAt,
          tool: pi.currentTool ? { name: pi.currentTool.name, args: toolArgSummary(pi.currentTool.args), at: pi.currentTool.at } : null,
          updated: new Date().toISOString(),
        }
      : { running: false, updated: new Date().toISOString() }
    writeJson(BUSY_FILE, data)
  } catch { /* ignore */ }
}

const BRIDGE_SEEN = join(ROOT, ".control-seen-bridge.json")
let bridgeSeen = (() => { try { return JSON.parse(readFileSync(BRIDGE_SEEN, "utf8")) } catch { return {} } })()
function saveBridgeSeen() {
  try {
    const keys = Object.keys(bridgeSeen)
    if (keys.length > 5000) for (const k of keys.slice(0, keys.length - 4000)) delete bridgeSeen[k]
    writeFileSync(BRIDGE_SEEN, JSON.stringify(bridgeSeen))
  } catch { /* ignore */ }
}

async function abortFromBoard(id) {
  const ackDir = join(ROOT, "control-acks")
  const ack = (ok, msg) => {
    try {
      mkdirSync(ackDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(ackDir, `${id}-qq.json`), JSON.stringify({ ok, msg }))
    } catch { /* ignore */ }
  }
  if (!pi.running) { ack(true, "本来就没在忙"); return }
  log("board abort · requested")
  pi.abortRequested = true
  pi.write(reqAbort())
  let ok = await pi.waitIdle(3000)
  if (!ok) {
    pi.write(reqAbortBash())
    ok = await pi.waitIdle(4000)
  }
  ack(ok, ok ? "已中断当前轮" : "中断发出去了，但这一轮还没停住")
}

// 静默看门狗：一轮超过 idleTimeoutSec 没有任何事件，就认定卡死，掐掉重来
let watchdogBusy = false
async function idleWatchdog() {
  if (watchdogBusy || !pi.running || !idleTimeoutSec) return
  const since = pi.lastEventAt || pi.turnStartedAt || Date.now()
  const idle = Date.now() - since
  if (idle < idleTimeoutSec * 1000) return
  watchdogBusy = true
  try {
    log("watchdog · idle", Math.round(idle / 1000), "s · abort current turn")
    pi.abortRequested = true
    pi.write(reqAbort())
    let ok = await pi.waitIdle(3000)
    if (!ok) {
      pi.write(reqAbortBash())
      ok = await pi.waitIdle(4000)
    }
    if (!ok) {
      // 彻底卡死：reject 排队者、清掉中断标记，然后真的把子进程杀掉重拉
      // （只清内存状态不杀进程的话，下一条消息要么被 abortRequested 吞掉，要么永远等不到事件）
      for (const w of pi.waiters.splice(0)) {
        try { w.reject(new Error("watchdog timeout")) } catch { /* ignore */ }
      }
      pi.abortRequested = false
      pi.running = false
      pi.currentTool = null
      if (pi.child) {
        try { pi.child.kill("SIGKILL") } catch { /* ignore */ }
      } else {
        pi.start()
      }
    }
    await sendPrivate(`刚才那轮卡住了（${fmtSpan(idle)}没动静），我掐了重来。`)
  } catch (e) {
    log("watchdog failed", String(e))
  } finally {
    watchdogBusy = false
  }
}

function pollBridgeControl() {
  try {
    const d = new Date()
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    const file = join(ROOT, "control", `commands-${day}.jsonl`)
    if (!existsSync(file)) return
    // 不按固定尾窗截断：一次突发几百条时，靠前的 abort 也要能被认领
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-2000)
    let changed = false
    for (const line of lines) {
      let c
      try { c = JSON.parse(line) } catch { continue }
      if (!c?.id || bridgeSeen[c.id]) continue
      if (!c.at || Date.now() - c.at > 5 * 60_000) { bridgeSeen[c.id] = true; changed = true; continue }
      // 只认终止类命令；其它 action 留给 pi 扩展自己处理
      if (c.action !== "abort") continue
      if (c.target !== "qq" && c.target !== "all") { bridgeSeen[c.id] = true; changed = true; continue }
      bridgeSeen[c.id] = true
      changed = true
      void abortFromBoard(c.id)
    }
    if (changed) saveBridgeSeen()
  } catch { /* ignore */ }
}

// ———————————————— 启动 ————————————————
pi.start()
connect()
setInterval(() => { if (wsReady) { state.lastSeen = new Date().toISOString(); saveState() } }, 15000).unref?.()
setInterval(() => { pollOutbox().catch((e) => log("outbox failed", String(e))) }, 2000).unref?.()
setInterval(() => { if (!wsReady && !reconnectTimer) scheduleReconnect("watchdog") }, 15000).unref?.()
setInterval(cleanupGroupSessions, 10 * 60_000).unref?.()
setInterval(writeBusy, 2000).unref?.()
setInterval(pollBridgeControl, 2000).unref?.()
setInterval(idleWatchdog, 30_000).unref?.()
log("bridge started", { ownerQQ, wsUrl, model: MODEL, afterglow: afterglowCfg })
// 兜底：任何漏掉的 Promise 异常只记日志，不要带走整个桥接
process.on("unhandledRejection", (e) => log("unhandledRejection", String(e).slice(0, 300)))
// 长期不重启也要轮转日志
setInterval(() => {
  try { if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 5 * 1024 * 1024) renameSync(LOG_FILE, `${LOG_FILE}.1`) } catch { /* ignore */ }
}, 6 * 60 * 60_000).unref?.()
process.on("exit", () => {
  try { pi.child?.kill("SIGTERM") } catch { /* ignore */ }
  for (const s of groupSessions.values()) { try { s.child?.kill("SIGTERM") } catch { /* ignore */ } }
})
