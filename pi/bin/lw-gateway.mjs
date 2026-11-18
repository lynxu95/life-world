#!/usr/bin/env node
/**
 * life-world · OpenAI 兼容网关
 *
 * 给 AnimaVN / 桌宠这类只会说 OpenAI 协议的客户端一个 baseURL：
 *   - GET  /v1/models
 *   - POST /v1/chat/completions（stream / 非 stream）
 *
 * 规矩：
 *   - 客户端发来的历史全部丢弃，只取最后一条 user；人格和记忆都以 life-world 为准
 *   - 网关跑一台专属的 pi 会话（LIFE_WORLD_ROLE=api），跟 QQ/home 共用同一套世界数据
 *   - 模型在 life-world.json 的 gateway.model 里选（local / cloud / provider/model）
 *   - 监听地址、端口、token、超时都在 gateway 段；默认只听 127.0.0.1
 *
 * 用法：node lw-gateway.mjs
 */
import http from "node:http"
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { spawn } from "node:child_process"
import { isMessageEnd, isAgentSettled, isAssistant, isToolUse, isError, errorMessage, isExtensionUIRequest, isResponse, responseOk, responseError, settledAborted, textOf, usageOf, reqPrompt, reqAbort, reqAbortBash, reqExtensionUIResponse } from "./rpc-adapter.mjs"

const ROOT = process.env.LIFE_WORLD_ROOT || join(homedir(), ".local/share/life-world")
const CONFIG_FILE = join(ROOT, "life-world.json")
const LOG = join(ROOT, "gateway.log")
const HERE = dirname(fileURLToPath(import.meta.url))
const PI = process.env.PI_BIN || "pi"
const EXT = process.env.LIFE_WORLD_EXT || join(HERE, "../ext/life-world.ts")
const SESSION_DIR = join(ROOT, "pi-sessions")
const WORLD = join(ROOT, "worlds/default")
const WORLD_TMP = join(WORLD, "tmp")
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_IMAGES = 4

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")) } catch { return fallback }
}
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`
  try { appendFileSync(LOG, line + "\n", { mode: 0o600 }) } catch { /* ignore */ }
  if (process.stdout.isTTY) console.log(line)
}
const rotate = () => {
  try { if (existsSync(LOG) && statSync(LOG).size > 2 * 1024 * 1024) renameSync(LOG, `${LOG}.1`) } catch { /* ignore */ }
}
rotate()
setInterval(rotate, 6 * 3600_000).unref?.()

const cfg = readJson(CONFIG_FILE, {})
const g = cfg.gateway || {}
if (g.enabled !== true && !process.env.LW_GATEWAY_FORCE) {
  console.log("gateway 没开（life-world.json 的 gateway.enabled=false），退出。")
  process.exit(0)
}
const HOST = String(process.env.LW_GATEWAY_HOST || g.host || "127.0.0.1")
const PORT = Number(process.env.LW_GATEWAY_PORT || g.port || 8100)
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`gateway 端口不合法：${process.env.LW_GATEWAY_PORT || g.port}`)
  process.exit(1)
}
const TOKEN = String(process.env.LW_GATEWAY_TOKEN || g.token || "")
const TIMEOUT_ON = g.timeoutEnabled !== false
const TIMEOUT_MS = Math.max(10, Math.min(3600, Number(g.timeoutSec) || 120)) * 1000
const MODELS = cfg.models || {}
const pickModel = () => {
  const want = String(g.model || "cloud").trim()
  if (want === "local") return MODELS.local || ""
  if (want === "cloud" || want === "current" || !want) return MODELS.cloud || ""
  return want
}
function modelWithLocks() {
  const pick = pickModel()
  // 两个锁只对「生效会话」名单里的会话生效；网关的 role 是 api，不在名单里就别吃锁
  const roles = Array.isArray(MODELS.autoFailoverRoles) ? MODELS.autoFailoverRoles.map((x) => String(x).trim()).filter(Boolean) : ["qq", "home"]
  if (!roles.includes("api")) return pick
  const readLock = (file) => {
    const p = join(ROOT, file)
    if (!existsSync(p)) return { exists: false, on: false }
    try { return { exists: true, on: JSON.parse(readFileSync(p, "utf8"))?.enabled !== false } }
    catch { return { exists: true, on: true } }  // 坏文件按锁定处理，和扩展/lwctl 一致
  }
  const lock = readLock("local-lock.json")
  if (lock.on) return MODELS.cloud || pick
  const pin = readLock("local-pin.json")
  if (pin.on) return MODELS.local || pick
  return pick
}
let MODEL = modelWithLocks()
const LOOPBACK = /^(127\.0\.0\.1|localhost|::1|\[::1\])$/i.test(HOST)
if (!LOOPBACK && !TOKEN) {
  console.error(`gateway 监听 ${HOST} 但没有设 token；局域网暴露前先在看板里填一个 token。`)
  log("refuse to start", `host=${HOST} no token`)
  process.exit(1)
}

// 每个 profile 只追加一段“终端约定”，人格和记忆不变
const PROFILES = {
  default: "",
  vn: [
    "【终端约定 · 视觉小说】这是 galgame 终端，你的回复会逐句演出。",
    "每句台词的行首必须写一个表情标签，格式是 <sprite:表情>，例如：<sprite:微笑>「哥哥回来啦～」",
    "标签单独写，不要放进引号或括号里，不要写动作或主语；表情 2~5 个字。",
    "可用表情：平静 / 微笑 / 开心 / 温柔 / 认真 / 担心 / 难过 / 哭 / 惊讶 / 慌张 / 害羞 / 疑惑 / 生气 / 害怕 / 厌恶 / 忧郁。",
    "旁白和其他角色的话前面不用写标签。不要解释格式。",
  ].join("\n"),
  pet: [
    "【终端约定 · 桌宠】这是一个小桌宠窗口，回复要短，一两句就好，不要长篇。",
  ].join("\n"),
}

// ———————————————— pi RPC 会话 ————————————————
let child = null
let buf = ""
let pending = null
let stopping = false
let backoff = 2000
let startedAt = 0
let chain = Promise.resolve()
let gen = 0

const buildArgs = () => ["--mode", "rpc", ...(MODEL ? ["--model", MODEL] : []),
  "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-extensions",
  "-e", EXT, "--session-dir", SESSION_DIR, "--name", "api"]

function startChild() {
  if (stopping) return
  // 每次拉起都按当前配置和「生效会话」名单重算一次：改了名单不必重启网关
  MODEL = modelWithLocks()
  const args = buildArgs()
  buf = ""
  const myGen = ++gen
  try { mkdirSync(SESSION_DIR, { recursive: true }) } catch (e) { log("session dir failed", String(e)) }
  try { mkdirSync(WORLD, { recursive: true }) } catch { /* ignore */ }
  const c = spawn(PI, args, {
    cwd: WORLD, // 相对路径写进世界目录，别落在插件根目录
    env: { ...process.env, TZ: process.env.TZ || "Asia/Shanghai", LIFE_WORLD_ROOT: ROOT, LIFE_WORLD_ROLE: "api", LIFE_WORLD_CHANNEL: "cli" },
    stdio: ["pipe", "pipe", "pipe"],
  })
  child = c
  startedAt = Date.now()
  log("gateway pi start", c.pid, "model", MODEL || "(default)", "gen", myGen)
  c.stdout.on("data", (d) => {
    if (c !== child || myGen !== gen) return
    buf += String(d)
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "")
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      handleRpc(msg)
    }
  })
  c.stderr.on("data", (d) => { if (c === child && myGen === gen) log("stderr", String(d).slice(0, 300)) })
  c.stdin.on("error", (e) => {
    if (c !== child || myGen !== gen) return
    log("stdin error", String(e))
    resetSession("会话管道断了，稍后再试")
  })
  c.on("error", (e) => {
    if (c !== child || myGen !== gen) return
    log("spawn error", String(e))
    child = null
    failPending("网关进程启动失败")
    const wait = backoff
    backoff = Math.min(60_000, backoff * 2)
    setTimeout(() => { if (myGen === gen) startChild() }, wait)
  })
  c.on("exit", (code, signal) => {
    if (myGen !== gen) return
    if (c !== child) return
    child = null
    failPending(`会话退出（${code ?? signal}）`)
    if (stopping) return
    if (Date.now() - startedAt > 60_000) backoff = 2000
    const wait = backoff
    backoff = Math.min(60_000, backoff * 2)
    log(`restart in ${wait}ms`)
    setTimeout(() => { if (myGen === gen) startChild() }, wait)
  })
}

function handleRpc(msg) {
  if (isResponse(msg)) {
    // 只处理自己这条 prompt 的失败响应，别误伤别的请求
    if (!responseOk(msg) && pending && msg.id && msg.id === pending.id) {
      const p = pending
      pending = null
      if (p.timer) clearTimeout(p.timer)
      p.reject(new Error(responseError(msg)))
      resetSession("模型请求失败，会话已重置")
    }
    return
  }
  if (!pending || pending.gen !== gen) return
  if (isMessageEnd(msg) && isAssistant(msg)) {
    if (isError(msg)) { pending.error = errorMessage(msg) || "模型报错"; return }
    // 工具轮也会收尾，用量按轮累加，别只算最后一段
    const u = usageOf(msg)
    if (u) {
      for (const k of ["input", "output", "cacheRead", "cacheWrite"]) {
        const n = Number(u[k])
        if (Number.isFinite(n)) pending.usage[k] = (pending.usage[k] || 0) + n
      }
    }
    if (isToolUse(msg)) return
    const text = textOf(msg)
    if (text) pending.texts.push(text)
    return
  }
  if (isAgentSettled(msg)) {
    const p = pending
    pending = null
    if (p.timer) clearTimeout(p.timer)
    if (p.timedOut) p.reject(new Error("等太久了（超时）"))
    else if (p.error && !p.texts.length) p.reject(new Error(p.error))
    else p.resolve({ text: p.texts.join("\n").trim(), usage: p.usage })
    return
  }
  if (isExtensionUIRequest(msg)) {
    try { child?.stdin.write(JSON.stringify(reqExtensionUIResponse(msg.id)) + "\n") } catch { /* ignore */ }
  }
}

function resetSession(reason) {
  failPending(reason)
  const dying = child
  child = null
  gen++
  try { dying?.kill("SIGTERM") } catch { /* ignore */ }
  setTimeout(() => { if (!child && !stopping) startChild() }, 500)
}

function failPending(reason) {
  if (!pending) return
  const p = pending
  pending = null
  if (p.timer) clearTimeout(p.timer)
  p.reject(new Error(reason))
}

function waitForChild(ms) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const tick = () => { if (child) return resolve(true); if (Date.now() - t0 > ms) return resolve(false); setTimeout(tick, 100) }
    tick()
  })
}

let queued = 0
function ask(text, scope, images = []) {
  if (queued >= 20) return Promise.reject(new Error("网关排队太多（20 个），稍后再试"))
  queued++
  const run = async () => {
    try {
    if (!child && !(await waitForChild(8000))) throw new Error("会话还没起来，稍后再试")
    return new Promise((resolve, reject) => {
      for (const c of [child]) if (!c || c.stdin.destroyed) return reject(new Error("会话没起来"))
      const id = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const p = { id, gen, scope, texts: [], usage: {}, error: "", resolve, reject, timer: null, timedOut: false }
      pending = p
      if (TIMEOUT_ON) {
        p.timer = setTimeout(() => {
          p.timedOut = true
          log("timeout", `${TIMEOUT_MS}ms`)
          try {
            child?.stdin.write(JSON.stringify(reqAbort()) + "\n")
            child?.stdin.write(JSON.stringify(reqAbortBash()) + "\n")
          } catch { /* ignore */ }
          // 3 秒还不 settle：作废这一代进程，换新的再放行队列
          setTimeout(() => {
            if (pending !== p) return
            failPending("等太久了（超时）")
            const dying = child
            child = null
            gen++  // 旧进程之后的事件一律丢弃
            try { dying?.kill("SIGTERM") } catch { /* ignore */ }
            setTimeout(() => { if (!child && !stopping) startChild() }, 500)
          }, 3000)
        }, TIMEOUT_MS)
      }
      try {
        if (!child || child.stdin.destroyed) throw new Error("会话没起来")
        child.stdin.write(JSON.stringify(reqPrompt(id, text, images)) + "\n")
      } catch (e) { resetSession(String(e)) }
    })
    } finally { queued-- }
  }
  chain = chain.then(run, run)
  return chain
}

// ———————————————— HTTP ————————————————
const json = (res, code, obj) => {
  const body = JSON.stringify(obj)
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), ...cors(res.lwReq) })
  res.end(body)
}
const ALLOW_ORIGINS = Array.isArray(g.allowOrigins) ? g.allowOrigins.map(String) : []
const cors = (req) => {
  const origin = String(req?.headers?.origin || "")
  if (!origin || !ALLOW_ORIGINS.length) return {}
  if (!ALLOW_ORIGINS.includes("*") && !ALLOW_ORIGINS.includes(origin)) return {}
  return {
    "Access-Control-Allow-Origin": ALLOW_ORIGINS.includes("*") ? "*" : origin,
    "Access-Control-Allow-Headers": "authorization, content-type, x-lw-profile",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  }
}
const err = (res, code, message, type = "invalid_request_error") =>
  json(res, code, { error: { message, type, param: null, code: null } })
const STREAM_GRACE_MS = 3000
/** 模型失败归类：超时 504，其余算上游 502 */
function errInfo(e) {
  const msg = String(e?.message || e)
  const timeout = TIMEOUT_ON && /超时|等太久/.test(msg)
  return { msg, type: timeout ? "timeout_error" : "upstream_error", code: timeout ? 504 : 502 }
}
/** OpenAI usage：只用 pi 报上来的真实用量；没有就不编（之前恒 0 / 字符数冒充 token） */
function usagePayload(u) {
  if (!u) return null
  const input = Number(u.input || 0), output = Number(u.output || 0)
  const read = Number(u.cacheRead || 0), write = Number(u.cacheWrite || 0)
  if (![input, output, read, write].every(Number.isFinite)) return null
  const prompt = input + read + write
  if (prompt <= 0 && output <= 0) return null
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: prompt + output,
    prompt_tokens_details: { cached_tokens: read },
  }
}

function authorized(req) {
  if (!TOKEN) return true
  return String(req.headers.authorization || "") === `Bearer ${TOKEN}`
}

const MIME_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/gif": "gif" }
/** 只认 data URL；远程 image_url 不代下（避免被当 SSRF 跳板） */
let lastTmpClean = 0
function cleanupTmp() {
  if (Date.now() - lastTmpClean < 3600_000) return
  lastTmpClean = Date.now()
  try {
    if (!existsSync(WORLD_TMP)) return
    const cutoff = Date.now() - 24 * 3600_000
    const files = readdirSync(WORLD_TMP).filter((f) => f.startsWith("api-")).map((f) => {
      try { const st = statSync(join(WORLD_TMP, f)); return { f, mtime: st.mtimeMs, size: st.size } } catch { return null }
    }).filter(Boolean).sort((a, b) => b.mtime - a.mtime)  // 新 → 旧
    const keep = new Set()
    let total = 0
    for (const x of files) {
      if (x.mtime < cutoff || keep.size >= 200 || total + x.size > 200 * 1024 * 1024) continue
      keep.add(x.f); total += x.size
    }
    for (const x of files) if (!keep.has(x.f)) { try { unlinkSync(join(WORLD_TMP, x.f)) } catch { /* ignore */ } }
  } catch { /* ignore */ }
}

function parseDataUrl(url) {
  // 客户端可能把 base64 换行包裹：先去掉所有空白再匹配
  const m = String(url || "").replace(/\s+/g, "").match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i)
  if (!m) return null
  const mimeType = m[1].toLowerCase()
  const ext = MIME_EXT[mimeType]
  if (!ext) return null
  const data = m[2]
  const bytes = Math.floor((data.length * 3) / 4)
  if (bytes > MAX_IMAGE_BYTES) return { tooLarge: true }
  return { mimeType, ext, data, bytes }
}
function extractUser(messages) {
  if (!Array.isArray(messages)) return { text: "", images: [], saved: [], skipped: 0 }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role !== "user") continue
    const c = m.content
    if (typeof c === "string") return { text: c.trim(), images: [], saved: [], skipped: 0 }
    if (!Array.isArray(c)) return { text: "", images: [], saved: [], skipped: 0 }
    const text = c.filter((p) => p && p.type === "text").map((p) => String(p.text || "")).join(" ").trim()
    cleanupTmp()
    const images = [], saved = []
    let skipped = 0
    for (const part of c) {
      if (!part || part.type !== "image_url") continue
      if (images.length >= MAX_IMAGES) { skipped++; continue }
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url
      const got = parseDataUrl(url)
      if (!got || got.tooLarge) { skipped++; continue }
      images.push({ type: "image", data: got.data, mimeType: got.mimeType })
      // 同时落一份到 tmp，方便缺视觉的模型用 read/perceive 再看
      try {
        mkdirSync(WORLD_TMP, { recursive: true, mode: 0o700 })
        const file = join(WORLD_TMP, `api-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${got.ext}`)
        writeFileSync(file, Buffer.from(got.data, "base64"), { mode: 0o600 })
        saved.push(`worlds/default/tmp/${file.split("/").pop()}`)
      } catch { /* 落盘失败不影响把图发给模型 */ }
    }
    return { text, images, saved, skipped }
  }
  return { text: "", images: [], saved: [], skipped: 0 }
}

const server = http.createServer(async (req, res) => {
  res.lwReq = req
  try {
  if (req.method === "OPTIONS") { res.writeHead(204, cors(req)); return res.end() }
  let url
  try { url = new URL(req.url, `http://${req.headers.host || "localhost"}`) }
  catch { return err(res, 400, "URL 不合法", "invalid_request_error") }
  if (!authorized(req)) return err(res, 401, "未授权：token 不对", "authentication_error")
  // 回环绑定时校验 Host（防 DNS rebinding）；带 Origin 且不在白名单的一律 403（即使不发 CORS 头）
  const reqHost = String(req.headers.host || "")
  if (LOOPBACK && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(reqHost)) return err(res, 403, "Host 不被接受")
  const reqOrigin = String(req.headers.origin || "")
  if (reqOrigin && !ALLOW_ORIGINS.length) return err(res, 403, "浏览器跨源请求被拒绝；需要就配置 gateway.allowOrigins")
  if (reqOrigin && !ALLOW_ORIGINS.includes("*") && !ALLOW_ORIGINS.includes(reqOrigin)) return err(res, 403, "Origin 不在 allowOrigins 里")
  if (req.method === "POST" && !String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    return err(res, 415, "Content-Type 必须是 application/json")
  }
  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, model: MODEL, child: !!child, busy: !!pending })
  if (req.method === "GET" && url.pathname === "/v1/models") {
    return json(res, 200, {
      object: "list",
      data: [
        { id: "life-world", object: "model", created: 0, owned_by: "life-world" },
        { id: "life-world-vn", object: "model", created: 0, owned_by: "life-world" },
        { id: "life-world-pet", object: "model", created: 0, owned_by: "life-world" },
      ],
    })
  }
  if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") return err(res, 404, "没有这个接口")
  let body = ""
  for await (const chunk of req) {
    body += chunk
    if (body.length > 48 * 1024 * 1024) return err(res, 413, "请求太大（上限 48MB；单张图片 ≤8MB，最多 4 张）")
  }
  let payload = {}
  try { payload = JSON.parse(body || "{}") } catch { return err(res, 400, "body 不是合法 JSON") }
  const user = extractUser(payload.messages)
  if (!user.text && !user.images.length) return err(res, 400, "没有 user 消息（或图片格式不支持）；这个网关只认最后一条 user，客户端历史会被丢弃")
  const modelId = String(payload.model || "life-world")
  const profile = String(req.headers["x-lw-profile"] || (modelId.includes("-vn") ? "vn" : modelId.includes("-pet") ? "pet" : "default"))
  const hint = Object.hasOwn(PROFILES, profile) ? PROFILES[profile] : ""
  const note = user.saved.length
    ? `\n（图片已存到 ${user.saved.join("、")}，备查。）`
    : user.skipped ? `\n（有 ${user.skipped} 张图片没接收：只收 data URL，单张 ≤8MB，最多 4 张。）` : ""
  const bodyText = (user.text || (user.images.length ? "（对方发来一张图片）" : "")) + note
  const prompt = hint ? `${hint}\n\n${bodyText}` : bodyText
  log("ask", profile, (user.text || "[image]").slice(0, 60), `imgs=${user.images.length}`)
  const id = `chatcmpl-${Date.now().toString(36)}`
  const stream = payload.stream === true
  let send = null
  // 客户端中途断开：只停自己这一轮（排队中的请求别误伤）
  const scope = {}
  res.on("close", () => { if (!res.writableEnded && pending && pending.scope === scope) { try { child?.stdin.write(JSON.stringify(reqAbort()) + "\n") } catch { /* ignore */ } } })
  const started = ask(prompt, scope, user.images)
  let early = null
  if (stream) {
    // 先给模型 3 秒：快速失败就回真正的 HTTP 错误，别用 200 包个 error chunk（有些客户端会当空回复）
    let graceTimer = null
    early = await Promise.race([
      started.then((r) => ({ ok: true, r }), (e) => ({ ok: false, e })),
      new Promise((r) => { graceTimer = setTimeout(() => r(null), STREAM_GRACE_MS) }),
    ])
    if (early) clearTimeout(graceTimer)
    if (early && !early.ok) {
      const { msg, type, code } = errInfo(early.e)
      log("ask failed before stream", msg.slice(0, 120))
      return err(res, code, msg, type)
    }
    // 超过 3 秒还在生成：先回声 + 保活，生成完再分块吐内容
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", ...cors(req) })
    send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`) } catch { /* client gone */ } }
    send({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelId, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })
  }
  // 生成期间发 SSE 注释保活，别让客户端等太久先断
  const ping = stream ? setInterval(() => { try { res.write(": ping\n\n") } catch { /* ignore */ } }, 15000) : null
  let result = null
  try { result = early && early.ok ? early.r : await started }
  catch (e) {
    if (ping) clearInterval(ping)
    const { msg, type, code } = errInfo(e)
    log("ask failed mid-stream", msg.slice(0, 120))
    // 流已经开了：发 error 事件就结束，不发 [DONE]——否则客户端会把半截回复当成正常收尾
    if (stream) { send({ error: { message: msg, type } }); return res.end() }
    return err(res, code, msg, type)
  }
  if (ping) clearInterval(ping)
  const reply = result?.text || "（她这次没说出话）"
  const usage = usagePayload(result?.usage)
  if (stream) {
    const chars = Array.from(reply)
    for (let i = 0; i < chars.length; i += 12) {
      send({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelId, choices: [{ index: 0, delta: { content: chars.slice(i, i + 12).join("") }, finish_reason: null }] })
      await new Promise((r) => setTimeout(r, 30))
    }
    send({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelId, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
    // 按 OpenAI 的约定：要了 stream_options.include_usage 才在最后补一条用量
    if (usage && payload.stream_options?.include_usage) {
      send({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelId, choices: [], usage })
    }
    res.write("data: [DONE]\n\n")
    return res.end()
  }
  const out = {
    id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: modelId,
    choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
  }
  if (usage) out.usage = usage
  return json(res, 200, out)
  } catch (e) {
    log("handler error", String(e))
    try { if (!res.headersSent) err(res, 500, "网关内部错误") } catch { /* ignore */ }
  }
})
server.on("error", (e) => { log("server error", String(e)); console.error(`gateway listen 失败：${String(e)}`); process.exit(1) })
process.on("unhandledRejection", (e) => log("unhandledRejection", String(e)))
process.on("uncaughtException", (e) => { log("uncaughtException", String(e)); process.exit(1) })

server.listen(PORT, HOST, () => log(`gateway on http://${HOST}:${PORT}`, `model=${MODEL || "(default)"}`, `timeout=${TIMEOUT_ON ? TIMEOUT_MS + "ms" : "off"}`))

function shutdown(code = 0) {
  stopping = true
  try { child?.kill("SIGTERM") } catch { /* ignore */ }
  server.close(() => process.exit(code))
  setTimeout(() => process.exit(code), 1500).unref?.()
}
process.on("SIGTERM", () => shutdown(0))
process.on("SIGINT", () => shutdown(0))
process.on("exit", () => { try { child?.kill("SIGTERM") } catch { /* ignore */ } })

startChild()
