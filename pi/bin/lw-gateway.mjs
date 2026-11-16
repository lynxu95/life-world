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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { spawn } from "node:child_process"
import { isMessageEnd, isAgentSettled, isAssistant, isToolUse, isError, errorMessage, isExtensionUIRequest, isResponse, responseOk, responseError, settledAborted, textOf, reqPrompt, reqAbort, reqAbortBash, reqExtensionUIResponse } from "./rpc-adapter.mjs"

const ROOT = process.env.LIFE_WORLD_ROOT || join(homedir(), ".local/share/life-world")
const CONFIG_FILE = join(ROOT, "life-world.json")
const LOG = join(ROOT, "gateway.log")
const HERE = dirname(fileURLToPath(import.meta.url))
const PI = process.env.PI_BIN || "pi"
const EXT = process.env.LIFE_WORLD_EXT || join(HERE, "../ext/life-world.ts")
const SESSION_DIR = join(ROOT, "pi-sessions")

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
const MODEL = modelWithLocks()
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
    "每句台词单独一行，行首标一个表情标签，例如：[微笑] 哥哥回来啦～",
    "可用表情：平静 / 微笑 / 大笑 / 害羞 / 生气 / 难过 / 惊讶 / 困 / 疑惑。",
    "不要解释格式，不要写旁白以外的说明。",
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

// 网关只负责聊天：命令行层先挡一道（扩展里还有运行时白名单兜底）
const DENY_TOOLS = [
  "bash", "write", "edit", "patch", "read", "grep", "find", "ls",
  "bg_run", "bg_kill", "bg_list", "bg_output", "bg_status",
  "reach_out", "send_media", "ha", "switch_model", "local_protect", "local_pin",
  "delegate", "skill_run", "skill_toggle", "skill_install", "skill_remove",
  "skill_list", "skill_read", "group_chat", "check_alarm", "check_proactive",
  "plan_next", "cancel_alarm", "heartbeat", "heartbeat_stop", "gal_choice",
].join(",")

const args = ["--mode", "rpc", ...(MODEL ? ["--model", MODEL] : []),
  "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-extensions",
  "-xt", DENY_TOOLS,
  "-e", EXT, "--session-dir", SESSION_DIR, "--name", "api"]

function startChild() {
  if (stopping) return
  buf = ""
  const myGen = ++gen
  mkdirSync(SESSION_DIR, { recursive: true })
  const c = spawn(PI, args, {
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
    failPending("会话管道断了，稍后再试")
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
    }
    return
  }
  if (!pending || pending.gen !== gen) return
  if (isMessageEnd(msg) && isAssistant(msg)) {
    if (isError(msg)) { pending.error = errorMessage(msg) || "模型报错"; return }
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
    else p.resolve(p.texts.join("\n").trim())
    return
  }
  if (isExtensionUIRequest(msg)) {
    try { child?.stdin.write(JSON.stringify(reqExtensionUIResponse(msg.id)) + "\n") } catch { /* ignore */ }
  }
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

function ask(text, scope) {
  const run = async () => {
    if (!child && !(await waitForChild(8000))) throw new Error("会话还没起来，稍后再试")
    return new Promise((resolve, reject) => {
      for (const c of [child]) if (!c || c.stdin.destroyed) return reject(new Error("会话没起来"))
      const id = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const p = { id, gen, scope, texts: [], error: "", resolve, reject, timer: null, timedOut: false }
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
        child.stdin.write(JSON.stringify(reqPrompt(id, text)) + "\n")
      } catch (e) { failPending(String(e)) }
    })
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

function authorized(req) {
  if (!TOKEN) return true
  return String(req.headers.authorization || "") === `Bearer ${TOKEN}`
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return ""
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role !== "user") continue
    const c = m.content
    if (typeof c === "string") return c.trim()
    if (Array.isArray(c)) return c.filter((p) => p && p.type === "text").map((p) => String(p.text || "")).join(" ").trim()
    return ""
  }
  return ""
}

const server = http.createServer(async (req, res) => {
  res.lwReq = req
  try {
  if (req.method === "OPTIONS") { res.writeHead(204, cors(req)); return res.end() }
  let url
  try { url = new URL(req.url, `http://${req.headers.host || "localhost"}`) }
  catch { return err(res, 400, "URL 不合法", "invalid_request_error") }
  if (!authorized(req)) return err(res, 401, "未授权：token 不对", "authentication_error")
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
    if (body.length > 2 * 1024 * 1024) return err(res, 413, "请求太大")
  }
  let payload = {}
  try { payload = JSON.parse(body || "{}") } catch { return err(res, 400, "body 不是合法 JSON") }
  const userText = lastUserText(payload.messages)
  if (!userText) return err(res, 400, "没有 user 消息；这个网关只认最后一条 user，客户端历史会被丢弃")
  const modelId = String(payload.model || "life-world")
  const profile = String(req.headers["x-lw-profile"] || (modelId.includes("-vn") ? "vn" : modelId.includes("-pet") ? "pet" : "default"))
  const hint = Object.hasOwn(PROFILES, profile) ? PROFILES[profile] : ""
  const prompt = hint ? `${hint}\n\n${userText}` : userText
  log("ask", profile, userText.slice(0, 60))
  const id = `chatcmpl-${Date.now().toString(36)}`
  const stream = payload.stream === true
  let send = null
  if (stream) {
    // 先回声，客户端不用干等；生成完再分块吐内容
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", ...cors(req) })
    send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`) } catch { /* client gone */ } }
    send({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelId, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })
  }
  // 客户端中途断开：只停自己这一轮（排队中的请求别误伤）
  const scope = {}
  res.on("close", () => { if (!res.writableEnded && pending && pending.scope === scope) { try { child?.stdin.write(JSON.stringify(reqAbort()) + "\n") } catch { /* ignore */ } } })
  let reply = ""
  try { reply = await ask(prompt, scope) }
  catch (e) {
    if (stream) { send({ error: { message: String(e?.message || e), type: "timeout_error" } }); try { res.write("data: [DONE]\n\n") } catch { /* ignore */ } return res.end() }
    return err(res, 504, String(e?.message || e), "timeout_error")
  }
  if (!reply) reply = "（她这次没说出话）"
  if (stream) {
    const chars = Array.from(reply)
    for (let i = 0; i < chars.length; i += 12) {
      send({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelId, choices: [{ index: 0, delta: { content: chars.slice(i, i + 12).join("") }, finish_reason: null }] })
      await new Promise((r) => setTimeout(r, 30))
    }
    send({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelId, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
    res.write("data: [DONE]\n\n")
    return res.end()
  }
  return json(res, 200, {
    id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: modelId,
    choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: Array.from(reply).length, total_tokens: Array.from(reply).length },
  })
  } catch (e) {
    log("handler error", String(e))
    try { if (!res.headersSent) err(res, 500, "网关内部错误") } catch { /* ignore */ }
  }
})
server.on("error", (e) => { log("server error", String(e)); console.error(`gateway listen 失败：${String(e)}`); process.exit(1) })
process.on("unhandledRejection", (e) => log("unhandledRejection", String(e)))
process.on("uncaughtException", (e) => log("uncaughtException", String(e)))

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
