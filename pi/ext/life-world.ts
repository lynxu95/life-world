import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, extname, join, resolve, sep } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { spawn, spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { createRequire } from "node:module"

/**
 * life-world · pi 版
 * 以 pi 的扩展点为宿主：工具、input 注入、message_end 归档、定时器。
 * 静态世界规则走 --append-system-prompt（prompt/world.md），不每轮改 system。
 */

const ROOT = process.env.LIFE_WORLD_ROOT || join(homedir(), ".local/share/life-world")
const SELF_PATH = (() => { try { return realpathSync(fileURLToPath(import.meta.url)) } catch { return fileURLToPath(import.meta.url) } })()
const EXT_DIR = dirname(SELF_PATH)
const PROMPT_FILE = process.env.LIFE_WORLD_PROMPT || join(EXT_DIR, "../prompt/world.md")
const MODULES_DIR = join(EXT_DIR, "../../modules")
const WORLD_MARK = "<!-- life-world:pi-world -->"
const WORLD = join(ROOT, "worlds/default")
const CONV_DIR = join(WORLD, "conversations")
const DIARY_DIR = join(WORLD, "diary")
const PLAN_DIR = join(WORLD, "plan")
const IDENTITY_DIR = join(WORLD, "identity")
const SELF_FILE = join(IDENTITY_DIR, "我是谁.md")
const PROFILE_FILE = join(IDENTITY_DIR, "用户画像.md")
const MOOD_FILE = join(IDENTITY_DIR, "心情.md")
const IMPRESSION_FILE = join(IDENTITY_DIR, "印象.md")
const IMPRESSION_MARK = "## 我的印象"
const ROOM_DIR = join(WORLD, "room")
const STICKER_DIR = join(WORLD, "表情包")
const VOICE_DIR = join(WORLD, "语音")
const TMP_DIR = join(WORLD, "tmp")
const OUTBOX_DIR = join(WORLD, "outbox")
/** 技能库：自制 / 下载分开；索引文件按需查 */
const SKILLS_DIR = join(WORLD, "skills")
const SKILL_OWN_DIR = join(SKILLS_DIR, "own")
const SKILL_DL_DIR = join(SKILLS_DIR, "downloaded")
const SKILL_INDEX = join(SKILLS_DIR, "INDEX.md")
const WORLD_FILE = join(WORLD, "world.json")
/** 后台任务的 job / 日志目录 */
const BG_DIR = join(ROOT, "bg")
/** 从文件尾部读固定字节，避免把几百 MB 日志整个读进内存 */
function readTail(file: string, bytes: number): string {
  const st = statSync(file)
  const start = Math.max(0, st.size - bytes)
  const len = st.size - start
  const fd = openSync(file, "r")
  try {
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, start)
    return buf.toString("utf8")
  } finally { closeSync(fd) }
}

/** 路径转成 shell 单引号字面量 */
const shqPath = (v: string): string => `'${String(v).replace(/'/g, `'\\''`)}'`
const CONFIG_FILE = join(ROOT, "life-world.json")
const BRIDGE_STATE = join(ROOT, "qq-bridge-state.json")
const LOG_FILE = join(ROOT, "debug.log")
/** FTS5 记忆索引（node:sqlite，trigram 分词） */
const MEM_INDEX_FILE = join(ROOT, "memory-index.db")
/** 会话心跳与控制：给 lwctl 用 */
const STATUS_DIR = join(ROOT, "status")
const CONTROL_FILE = join(ROOT, "control.json")
const CONTROL_DIR = join(ROOT, "control")
const ACK_DIR = join(ROOT, "control-acks")
const MODEL_MODE_FILE = join(ROOT, "model-mode.json")
const safeRoleKey = (rk: string) => rk.replace(/[^A-Za-z0-9_.-]/g, "_")
const controlAckFile = (id: string, rk: string) => join(ACK_DIR, `${id}-${safeRoleKey(rk)}.json`)
const KAOMOJI_FILE = process.env.LIFE_WORLD_KAOMOJI || join(ROOT, "pi-kaomoji.json")
const TIMER_LOCK = join(WORLD, ".pi-timer.lock")
const ROLE = process.env.LIFE_WORLD_ROLE || "cli"
const CHANNEL = process.env.LIFE_WORLD_CHANNEL || "cli"
const JUDGE = process.env.LIFE_WORLD_JUDGE === "1"
const GROUP_ID = process.env.LIFE_WORLD_GROUP_ID || ""
const DEPTH = Number(process.env.LIFE_WORLD_DEPTH || 0)

/** QQ 私聊 / 群聊的说话方式（从 opencode 版移植） */
const QQ_PRIVATE_MARK = "## QQ 私聊回复方式"
const QQ_PRIVATE_BODY = [
  "你在 QQ 上和对方聊天，不是在写报告：",
  "- 每个短句单独一行；每行会作为一条独立的 QQ 消息发出去。",
  "- 一次发 1~3 条短消息，最多不超过 4 条；不要写长段落。",
  "- 如果这轮要调用工具做任务，先用一句话说明你要去做什么，再开始调用；做完再给最终结果，不要一声不吭地跑很久。",
  "- 像真人线上聊天：短、口语、有来有回。",
  "- 不要调用 reach_out；你的回复直接写在正文里，每行一句。",
  "- 不要用标题、列表、编号、加粗、表格；不要写「首先/其次/总结」。",
  "- 不要复述工具调用、命令、过程或内部推理。",
  "- 对方问什么就答什么，别扩写。",
].join("\n")

const QQ_GROUP_MARK = "## QQ 群聊模式"
const QQ_GROUP_BODY = [
  "这是 QQ 群聊，不是私聊。你在群里是普通朋友，不是任何人的伴侣。",
  "- 不要用情侣/伴侣称呼，不要提亲密关系、私聊内容、日记、画像、心情。",
  "- 学习群友的聊天风格：友好又诙谐，口语化能接梗；像日常聊天，别文言、别书面语；一次 1~3 条短句；可以发表情/颜文字。",
  "- 你知道你们的关系，但在这里只以朋友身份说话；不该接就只回 [SILENT]。",
  "- 群聊强制在云端：这里没有切换模型的工具，不要提切换。",
].join("\n")

/** 后台工作间：只对 ROLE=home 注入（home 与 TUI 的 CHANNEL 都是 cli，不能靠 CHANNEL 区分） */
const HOME_BG_MARK = "## 后台工作间"
const HOME_BG_BODY = [
  "这里是后台工作间，用户看不到你的输出。",
  "- 后台是你自由处理事件的地方，用户看不到；做完任务就结束，不要对着空气汇报、不要提问。",
  "- 要让他知道的事，用 reach_out 发到 QQ；不想打扰就不发。",
  "- 后台和其他所有会话（QQ、群聊、终端）都是同一个你；后台不扮演聊天。",
].join("\n")

/** 模型使用规范：放在 identity 下，和心情一样注入（不超过 500 字） */
const MODEL_RULES_FILE = join(IDENTITY_DIR, "模型使用规范.md")
const MODEL_RULES_MARK = "## 模型使用规范"
/** 化形表：模型 → 外观/称呼（identity/化形表.md） */
const FORMS_FILE = join(IDENTITY_DIR, "化形表.md")
const FORMS_MARK = "## 化形表"
const AUTH_FILE = join(homedir(), ".pi/agent/auth.json")
const MODELS_FILE = join(homedir(), ".pi/agent/models.json")
/** 机密抽屉：切到云端前把这段对话（含机密文件内容）收起来，切回本地再打开 */
const DRAWER_DIR = join(WORLD, "机密抽屉")
const DRAWER_SESSIONS = join(DRAWER_DIR, "sessions")

function log(text: string): void {
  try {
    mkdirSync(ROOT, { recursive: true })
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${text}\n`, { mode: 0o600 })
  } catch { /* ignore */ }
}

function atomicWrite(path: string, text: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode })
  renameSync(tmp, path)
}

function pad(n: number): string { return String(n).padStart(2, "0") }
function zone(): string { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" } catch { return "UTC" } }
function dayOf(d = new Date()): string { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function isoLocal(d = new Date()): string {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? "+" : "-"
  const a = Math.abs(off)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
}
function stamp(d = new Date()): string { return `${dayOf(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}` }
function shortStamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${dayOf(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function readText(path: string): string { try { return existsSync(path) ? readFileSync(path, "utf8").trim() : "" } catch { return "" } }
function readJson<T>(path: string, fallback: T): T { try { return JSON.parse(readFileSync(path, "utf8")) as T } catch { return fallback } }

function ensureDirs(): void {
  for (const dir of [CONV_DIR, DIARY_DIR, PLAN_DIR, IDENTITY_DIR, ROOM_DIR, STICKER_DIR, VOICE_DIR, TMP_DIR, OUTBOX_DIR, SKILLS_DIR, SKILL_OWN_DIR, SKILL_DL_DIR]) {
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch { /* ignore */ }
  }
}

/**
 * 本地小模型优化（默认关闭）。
 * 面向「上下文短、并发差、prefill 慢」的本地模型；接在线模型时保持关闭。
 * 打开后在 life-world.json 里配 localModel: { enabled: true, ... }。
 */
interface LocalModelOptions {
  enabled: boolean
  /** 新会话注入的历史条数（0 = 不注入，-1 = 不限制） */
  keepRecent: number
  /** 保留最近几轮的工具结果（0 = 全折，-1 = 不折） */
  foldToolResults: number
  /** 折叠后每条结果保留的字符数 */
  resultChars: number
  /** 保留最近几轮的推理；0 = 全折，-1 = 不折 */
  foldingThinkingTurns: number
  /** 是否每轮输出上下文构成统计（调试用） */
  debugStats: boolean
}

/** 本地 / 在线模型热切换（设了 local 才会启用） */
interface ModelSwitchOptions {
  /** 本地模型，如 basalt/abliterated-iq3_xxs；留空 = 不启用热切换 */
  local: string
  /** 在线模型，如 deepseek/deepseek-flash */
  cloud: string
  /** 当前模型不可用时，脚本自动切到另一个 */
  autoFailover: boolean
  /** 本地健康检查地址 */
  localHealthUrl: string
  /** 在线健康检查地址 */
  cloudHealthUrl: string
  /** 健康检查超时（毫秒） */
  probeTimeoutMs: number
  /** 两次自动切换之间的冷却（毫秒），防止来回抖 */
  cooldownMs: number
}

/** 辅助感知：只补主模型缺的模态（视频/音频；主模型不支持图片时的图片） */
interface MultimodalOptions {
  enabled: boolean
  /** provider/model；空 = 停用 */
  model: string
  timeoutMs: number
  warnImageBytes: number
  warnVideoBytes: number
}

interface Config {
  world: { enabled: boolean; running: boolean; reviewHour: number; fallbackWakeTime: string; recentLimit: number; heartbeatMaxMinutes: number; heartbeatEnabled: boolean; hydrate: { hours: number; chars: number; mapDays: number } }
  bridge: { enabled: boolean; ownerQQ: number; wsUrl: string; group: { enabled: boolean; id?: string } }
  subagent: { model: string }
  multimodal: MultimodalOptions
  localModel: LocalModelOptions
  models: ModelSwitchOptions
  care: CareOptions
  backup: { enabled: boolean; hour: number; includePrivate: boolean }
  guard: { enabled: boolean; staleSeconds: number; cooldownMinutes: number; allowRestart: boolean }
  cleanup: { tmpMaxAgeHours: number }
  memory: { decay: DecayOptions; actr: ActrOptions; association: AssociationOptions; impression: ImpressionOptions }
}

/** ACT-R 基级激活（频率 × 近因幂律） */
interface ActrOptions {
  enabled: boolean
  /** 衰减指数 d，约 0.5 */
  decay: number
  /** 激活通道权重（0~1） */
  weight: number
  /** 每个记忆保留的访问时间条数 */
  maxAccess: number
}

/** Hebbian 联想扩散 */
interface AssociationOptions {
  enabled: boolean
  /** 扩散通道权重 */
  weight: number
  /** 每次共同召回给边加多少 */
  learnRate: number
  /** 边权重每天衰减比例 */
  decayPerDay: number
  maxWeight: number
  maxNeighbors: number
  /** 首次建图时用同一天相邻对话生成弱共现边 */
  bootstrap: boolean
}

/** 印象整理任务 */
interface ImpressionOptions {
  enabled: boolean
  /** 本地模型时，到这个点后才跑 */
  hour: number
  /** 回看最近几天 */
  days: number
  /** 一次最多整理几条印象 */
  maxItems: number
  /** 最后验证满这么多天：有新印象时优先删它腾位 */
  staleDays: number
  /** 最后验证超过这么多天：视为过期，直接删并补位 */
  expireDays: number
}

/** 遗忘曲线：命中加强、随时间衰减（只降权，不删） */
interface DecayOptions {
  enabled: boolean
  /** 半衰期（天） */
  halfLifeDays: number
  /** 每命中一次加多少强度 */
  hitBoost: number
  /** 强度上限 */
  maxStrength: number
  /** 强度下限 */
  minStrength: number
}

/** 主动关怀：随机想起、天气、安静时段 */
interface CareOptions {
  enabled: boolean
  /** 安静时段（跨午夜），如 23:30 ~ 08:00 */
  quietStart: string
  quietEnd: string
  /** 随机想起对方 */
  randomEnabled: boolean
  /** 两次主动之间至少隔几小时 */
  randomMinGapHours: number
  /** 每个 tick（30 秒）触发概率，0.02 ≈ 25 分钟一次机会 */
  randomChancePerTick: number
  /** 早上叫你时带天气 */
  weatherEnabled: boolean
  weatherCity: string
}

function config(): Config {
  const base: Config = {
    world: { enabled: true, running: true, reviewHour: 23, fallbackWakeTime: "09:00", recentLimit: 80, heartbeatMaxMinutes: 20, heartbeatEnabled: true, hydrate: { hours: 48, chars: 2000, mapDays: 3 } },
    bridge: { enabled: false, ownerQQ: 0, wsUrl: "ws://127.0.0.1:3001", group: { enabled: false } },
    subagent: { model: "deepseek-flash" },
    multimodal: { enabled: false, model: "", timeoutMs: 300_000, warnImageBytes: 8 * 1024 * 1024, warnVideoBytes: 200 * 1024 * 1024 },
    localModel: { enabled: false, keepRecent: 20, foldToolResults: 6, resultChars: 300, foldingThinkingTurns: 0, debugStats: false },
    models: { local: "", cloud: "deepseek/deepseek-flash", autoFailover: true, localHealthUrl: "", cloudHealthUrl: "", probeTimeoutMs: 4000, cooldownMs: 60000 },
    care: { enabled: true, quietStart: "23:30", quietEnd: "08:00", randomEnabled: true, randomMinGapHours: 3, randomChancePerTick: 0.02, weatherEnabled: true, weatherCity: "" },
    backup: { enabled: true, hour: 4, includePrivate: false },
    guard: { enabled: true, staleSeconds: 300, cooldownMinutes: 10, allowRestart: true },
    cleanup: { tmpMaxAgeHours: 72 },
    memory: {
      decay: { enabled: true, halfLifeDays: 30, hitBoost: 0.15, maxStrength: 3, minStrength: 0.1 },
      actr: { enabled: true, decay: 0.5, weight: 0.2, maxAccess: 50 },
      association: { enabled: true, weight: 0.1, learnRate: 0.05, decayPerDay: 0.02, maxWeight: 1, maxNeighbors: 50, bootstrap: true },
      impression: { enabled: true, hour: 5, days: 3, maxItems: 5, staleDays: 3, expireDays: 7 },
    },
  }
  const raw = readJson<Partial<Config>>(CONFIG_FILE, {})
  return {
    ...base,
    ...raw,
    world: { ...base.world, ...(raw.world || {}), hydrate: { ...base.world.hydrate, ...((raw.world || {}).hydrate || {}) } },
    bridge: { ...base.bridge, ...(raw.bridge || {}), group: { ...base.bridge.group, ...((raw.bridge || {}).group || {}) } },
    subagent: { ...base.subagent, ...(raw.subagent || {}) },
    multimodal: { ...base.multimodal, ...(raw.multimodal || {}) },
    localModel: { ...base.localModel, ...(raw.localModel || {}) },
    models: { ...base.models, ...(raw.models || {}) },
    care: { ...base.care, ...(raw.care || {}) },
    backup: { ...base.backup, ...(raw.backup || {}) },
    guard: { ...base.guard, ...(raw.guard || {}) },
    cleanup: { ...base.cleanup, ...(raw.cleanup || {}) },
    memory: {
      decay: { ...base.memory.decay, ...((raw.memory || {}).decay || {}) },
      actr: { ...base.memory.actr, ...((raw.memory || {}).actr || {}) },
      association: { ...base.memory.association, ...((raw.memory || {}).association || {}) },
      impression: { ...base.memory.impression, ...((raw.memory || {}).impression || {}) },
    },
  }
}

function localModelOptions(): LocalModelOptions { return config().localModel }

interface Alarm {
  id: string
  at: string
  note: string
  setAt: string
  model?: "local" | "cloud"
  /** main = 活动；sub = 子闹钟；不写 = 旧版一次性闹钟 */
  kind?: "main" | "sub"
  parentId?: string
  /** main：pending → active → closed；sub：pending → fired（留档，24 小时后清理） */
  status?: "pending" | "active" | "closed" | "fired"
  paused?: boolean
  activatedAt?: string
  /** 活动关闭的时间（关闭后留档 24 小时，看板显示「已结束」） */
  closedAt?: string
  /** 子闹钟实际触发的时间 */
  firedAt?: string
  /**
   * 心跳串：同一条串上的每一跳共享 chainId 和 reason。
   * 有 chainId 且没有 parentId 的 sub 闹钟 = 独立心跳，不属于任何主活动。
   */
  chainId?: string
  /** 起串时写一次的理由，之后每一跳都带着 */
  reason?: string
  /** 固定间隔（分钟） */
  intervalMinutes?: number
  /** 这一串的第几跳 */
  seq?: number
  /** 这一串第一跳的时间，用来算「单次最长持续多久」 */
  startedAt?: string
  /** 忙时跳过的子闹钟，下次这个活动醒来时提醒 AI review */
  skipped?: Array<{ at: string; scheduled: string; note: string }>
}
interface WorldState { running?: boolean; alarms?: Alarm[]; lastReview?: string; lastWake?: string; lastRandom?: string; lastBackup?: string; lastBackupAttempt?: string; lastGuard?: string; lastCleanup?: string; lastControlPrune?: string; lastDecay?: string; lastEdgeDecay?: string; lastImpression?: string }
function readWorld(): WorldState {
  const s = readJson<WorldState>(WORLD_FILE, { running: true, alarms: [] })
  // 合法 JSON 但 elements 坏掉（null / 字符串）会让 tick 每轮抛异常，先滤掉
  return { ...s, alarms: Array.isArray(s.alarms) ? s.alarms.filter((a) => a && typeof a === "object") : [] }
}
/**
 * 严格读：文件存在但解析失败时返回 null。
 * 用于「读-改-写」路径——解析失败时宁可不写，也不能拿空对象把真实闹钟抹掉。
 */
function readWorldStrict(): WorldState | null {
  if (!existsSync(WORLD_FILE)) return { running: true, alarms: [] }
  try {
    const s = JSON.parse(readFileSync(WORLD_FILE, "utf8")) as WorldState
    return { ...s, alarms: Array.isArray(s.alarms) ? s.alarms.filter((a) => a && typeof a === "object") : [] }
  } catch { return null }
}
function writeWorld(state: WorldState): boolean {
  try { atomicWrite(WORLD_FILE, JSON.stringify({ ...state, alarms: state.alarms || [] }, null, 2)); return true } catch (e) { log(`writeWorld failed ${String(e)}`); return false }
}
/** 统一的世界状态写入口：读-改-写都在锁内完成，避免并发时互相覆盖 */
function updateWorld(mutator: (s: WorldState) => void | WorldState): boolean {
  const r = withWorldLock(() => {
    const s = readWorldStrict()
    if (!s) return false
    const out = mutator(s)
    return writeWorld(out && typeof out === "object" ? (out as WorldState) : s)
  })
  return r === true
}


/** world.json 跨进程读改写的轻量锁（home/qq/cli 会同时改闹钟） */
function withWorldLock<T>(fn: () => T): T | undefined {
  const lock = join(ROOT, ".world.lock")
  const pause = () => {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5) }
    catch { const end = Date.now() + 5; while (Date.now() < end) { /* spin */ } }
  }
  for (let i = 0; i < 60; i++) {
    let fd: number
    try { fd = openSync(lock, "wx", 0o600) }
    catch {
      try {
        if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 10_000) { unlinkSync(lock); continue }
      } catch { /* ignore */ }
      pause()
      continue
    }
    try {
      try { writeFileSync(fd, String(process.pid)); closeSync(fd) } catch (e) { try { closeSync(fd) } catch { /* ignore */ } throw e }
      return fn()
    } finally {
      try { unlinkSync(lock) } catch { /* ignore */ }
    }
  }
  log("world lock timeout")
  return undefined
}

// ———————— 控制队列（lwctl / lwboard → 各会话） ————————
interface ControlCmd { id: string; at: number; target?: string; action?: string; model?: string; reason?: string; op?: string; alarmId?: string }
function controlCommandsFile(day = dayOf()): string { return join(CONTROL_DIR, `commands-${day}.jsonl`) }

/** 追加一条命令；id 唯一，不再用毫秒时间戳当序号 */
function appendControl(cmd: Partial<ControlCmd> & { target: string }): { id: string; at: number } {
  const at = Date.now()
  const id = `${at.toString(36)}-${randomBytes(4).toString("hex")}`
  mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 })
  const line = JSON.stringify({ id, at, action: "model", model: "", reason: "", ...cmd }) + "\n"
  appendFileSync(controlCommandsFile(), line, { mode: 0o600 })
  return { id, at }
}

/** 读今天和昨天的命令，按 (at,id) 升序 */
function readControlQueue(): ControlCmd[] {
  const out: ControlCmd[] = []
  // 前后各扫一天：写入方和 home 的时区可能差一天
  for (let i = -1; i <= 1; i++) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const file = controlCommandsFile(dayOf(d))
    if (!existsSync(file)) continue
    let text = ""
    try { text = readFileSync(file, "utf8") } catch { continue }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        const c = JSON.parse(line)
        if (c && c.id) out.push(c as ControlCmd)
      } catch { /* 跳过半行 */ }
    }
  }
  out.sort((a, b) => Number(a.at) - Number(b.at) || String(a.id).localeCompare(String(b.id)))
  return out
}

function waitRoleAck(id: string, rk: string, timeoutMs: number): Promise<any | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      const st = readJson<any>(controlAckFile(id, rk), null)
      if (st) return resolve(st)
      if (Date.now() > deadline) return resolve(null)
      setTimeout(tick, 300)
    }
    tick()
  })
}

/** 清掉 3 天前的命令与回执（家会话每天一次） */
function pruneControlQueue(keepDays = 3): void {
  try {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - keepDays)
    const cut = dayOf(cutoff)
    for (const f of readdirSync(CONTROL_DIR)) {
      const m = f.match(/^commands-(\d{4}-\d{2}-\d{2})\.jsonl$/)
      if (m && m[1] < cut) { try { unlinkSync(join(CONTROL_DIR, f)) } catch { /* ignore */ } }
    }
    const acut = Date.now() - keepDays * 86_400_000
    for (const f of readdirSync(ACK_DIR)) {
      try { if (statSync(join(ACK_DIR, f)).mtimeMs < acut) unlinkSync(join(ACK_DIR, f)) } catch { /* ignore */ }
    }
  } catch { /* 目录不存在就算了 */ }
}

function bridgeStatus(): string {
  const c = config().bridge
  if (!c.enabled) return "已关闭"
  const s = readJson<{ lastSeen?: string }>(BRIDGE_STATE, {})
  const ms = s.lastSeen ? Date.parse(s.lastSeen) : 0
  return Number.isFinite(ms) && Date.now() - ms < 90_000 ? "在线" : "桥接未运行"
}

function moodLine(): string {
  const raw = readText(MOOD_FILE)
  if (!raw) return "无"
  for (const line of raw.split("\n")) {
    const t = line.replace(/^[-*\s#]+/, "").trim()
    if (t && !t.startsWith(">") && !t.startsWith("当前状态")) return t.slice(0, 80)
  }
  return "无"
}

function currentModelLine(): string {
  let id = ""
  try { id = lastCtx ? modelIdOf(lastCtx) : "" } catch { /* stale ctx */ }
  if (!id) return ""
  const o = config().models
  const kind = o.local && id === o.local ? "本地" : o.cloud && id === o.cloud ? "在线" : "其他"
  return `模型：${kind} · ${id}`
}

function stateText(withMood = true): string {
  const parts = [currentModelLine(), withMood ? `心情：${moodLine()}` : "", `OneBot 桥接：${bridgeStatus()}`].filter(Boolean)
  return `[本地时间 ${stamp()} ${zone()}]\n（${parts.join("；")}）`
}

// ———————— 归档 / 记忆 ————————
interface Record_ { id: string; t: string; role: "user" | "assistant"; text: string }
let archived = new Set<string>()

function loadArchived(): void {
  archived = new Set()
  try {
    if (!existsSync(CONV_DIR)) return
    for (const f of readdirSync(CONV_DIR).filter((x) => x.endsWith(".jsonl"))) {
      for (const line of readFileSync(join(CONV_DIR, f), "utf8").split("\n")) {
        if (!line.trim()) continue
        try { const r = JSON.parse(line) as Record_; if (r?.id) archived.add(r.id) } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

function cleanUserText(text: string): string {
  return text
    .replace(/^\[本地时间 [^\]]*\]\s*/, "")
    .split("\n")
    .filter((line) => !line.startsWith("（模型：") && !line.startsWith("（心情：") && !line.startsWith("（OneBot 桥接："))
    .join("\n")
    .trim()
}

function isAfterglow(text: string): boolean {
  return cleanUserText(text).startsWith("【余波】")
}

function archive(message: any): void {
  try {
    if (typeof message?.customType === "string" && message.customType.startsWith("life-world-")) return
    const role = message?.role
    if (role !== "user" && role !== "assistant") return
    let text = messageText(message).trim()
    if (!text) return
    if (role === "user") {
      if (isAfterglow(text)) return
      text = cleanUserText(text)
    }
    if (!text) return
    const t = new Date(message?.timestamp || Date.now()).toISOString()
    const id = String(message?.id || createHash("sha1").update(`${role}|${t}|${text}`).digest("hex"))
    if (archived.has(id)) return
    archived.add(id)
    mkdirSync(CONV_DIR, { recursive: true, mode: 0o700 })
    appendFileSync(join(CONV_DIR, `${dayOf(new Date(t))}.jsonl`), `${JSON.stringify({ id, t, role, text })}\n`, { mode: 0o600 })
    indexRecord({ id, t, role, text })
  } catch (e) { log(`archive failed ${String(e)}`) }
}

function messageText(message: any): string {
  const content = message?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.filter((p: any) => p?.type === "text" && typeof p.text === "string").map((p: any) => p.text).join("\n")
  }
  return ""
}

function allRecords(): Record_[] {
  const out: Record_[] = []
  try {
    if (!existsSync(CONV_DIR)) return out
    const files = readdirSync(CONV_DIR).filter((f) => f.endsWith(".jsonl")).sort()
    for (const f of files) {
      for (const line of readFileSync(join(CONV_DIR, f), "utf8").split("\n")) {
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line) as Record_
          if (r && typeof r.t === "string" && typeof r.text === "string" && (r.role === "user" || r.role === "assistant")) out.push(r)
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  const order: string[] = []
  const byId = new Map<string, Record_>()
  for (const r of out) {
    if (!r.id) continue
    if (!byId.has(r.id)) order.push(r.id)
    byId.set(r.id, r)
  }
  return order.map((id) => byId.get(id) as Record_)
}

let indexStale = false
/** 索引是否已完成过回填；完成前/索引坏了就退回读文件 */
function indexReady(): boolean {
  if (indexStale) return false
  try {
    const db = openMemIndex()
    if (!db) return false
    const row = db.prepare("SELECT value FROM meta WHERE key = 'backfilled'").get()
    return String(row?.value || "") === "1"
  } catch { return false }
}

/** 索引写失败：立刻让本进程退回文件读，并在 60 秒后重试回填 */
let staleRetry: any = null
function scheduleIndexRetry(): void {
  if (staleRetry) return
  staleRetry = setTimeout(() => {
    staleRetry = null
    memBackfilled = false
    backfillMemoryIndex()
    // 这次还没修好就继续排，别让本进程永远停在文件读
    if (indexStale) scheduleIndexRetry()
  }, 60_000)
  ;(staleRetry as any).unref?.()
}
function markIndexStale(): void {
  indexStale = true
  memBackfilled = false
  try {
    const db = openMemIndex()
    db?.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('backfilled', '0')").run()
  } catch { /* 库还锁着就算了，本进程已经退回文件读 */ }
  scheduleIndexRetry()
}

function mapRow(r: any): Record_ {
  return { id: String(r.id), t: String(r.t), role: r.role === "assistant" ? "assistant" : "user", text: String(r.text) }
}

/** 走 SQLite 读；索引没准备好返回 null，由调用方退回文件扫描 */
function dbQuery(sql: string, ...params: any[]): Record_[] | null {
  try {
    if (!indexReady()) return null
    const db = openMemIndex()
    if (!db) return null
    return db.prepare(sql).all(...params).map(mapRow)
  } catch { return null }
}

/** 索引不可用时的文件回退；同一次记忆注入里多次回退只扫一遍盘 */
let fileScanCache: { at: number; list: Record_[] } | null = null
function allRecordsCached(): Record_[] {
  if (fileScanCache && Date.now() - fileScanCache.at < 5000) return fileScanCache.list
  const list = allRecords()
  fileScanCache = { at: Date.now(), list }
  return list
}

function allRecordsFast(): Record_[] {
  return dbQuery("SELECT id,t,role,text FROM msg ORDER BY t ASC, rowid ASC") || allRecordsCached()
}

function recordsSince(iso: string): Record_[] {
  return dbQuery("SELECT id,t,role,text FROM msg WHERE t >= ? ORDER BY t ASC, rowid ASC", iso)
    || allRecordsCached().filter((r) => r.t >= iso)
}

function recordsInRange(from: string, to: string): Record_[] {
  return dbQuery("SELECT id,t,role,text FROM msg WHERE day >= ? AND day <= ? ORDER BY t ASC, rowid ASC", from, to)
    || allRecordsCached().filter((r) => { const d = dayOf(new Date(r.t)); return d >= from && d <= to })
}

function recordsOnDay(day: string): Record_[] {
  return dbQuery("SELECT id,t,role,text FROM msg WHERE day = ? ORDER BY t ASC, rowid ASC", day)
    || allRecordsCached().filter((r) => dayOf(new Date(r.t)) === day)
}

// ———————— FTS5 记忆索引 ————————
let memDb: any = undefined
let memBackfilled = false

function openMemIndex(): any {
  if (memDb !== undefined) return memDb
  try {
    const req = createRequire(import.meta.url)
    const { DatabaseSync } = req("node:sqlite")
    memDb = new DatabaseSync(MEM_INDEX_FILE)
    try { memDb.exec("PRAGMA journal_mode=WAL") } catch { /* ignore */ }
    try { memDb.exec("PRAGMA busy_timeout=5000") } catch { /* ignore */ }
    try { memDb.exec("PRAGMA synchronous=NORMAL") } catch { /* ignore */ }
    try { chmodSync(MEM_INDEX_FILE, 0o600) } catch { /* ignore */ }
    memDb.exec("CREATE TABLE IF NOT EXISTS msg (id TEXT PRIMARY KEY, day TEXT, t TEXT, role TEXT, text TEXT)")
    memDb.exec("CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(id UNINDEXED, text, tokenize=trigram)")
    memDb.exec("CREATE TABLE IF NOT EXISTS mem (id TEXT PRIMARY KEY, strength REAL DEFAULT 1, uses INTEGER DEFAULT 0, last_used TEXT)")
    memDb.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    memDb.exec("CREATE TABLE IF NOT EXISTS access (id TEXT, t TEXT)")
    memDb.exec("CREATE INDEX IF NOT EXISTS idx_access_id ON access(id)")
    memDb.exec("CREATE TABLE IF NOT EXISTS edges (a TEXT, b TEXT, w REAL DEFAULT 0, last TEXT, PRIMARY KEY(a,b))")
    log("memory index opened")
  } catch (e) {
    log(`memory index unavailable ${String(e)}`)
    memDb = null
  }
  return memDb
}

function strengthMap(): Map<string, number> {
  const out = new Map<string, number>()
  try {
    const db = openMemIndex()
    if (!db) return out
    for (const r of db.prepare("SELECT id, strength FROM mem").all()) out.set(String(r.id), Number(r.strength) || 1)
  } catch { /* ignore */ }
  return out
}

/** 被检索命中就加强（艾宾浩斯式复习） */
function reinforce(ids: string[]): void {
  const cfg = config().memory.decay
  if (!cfg.enabled || !ids.length) return
  try {
    const db = openMemIndex()
    if (!db) return
    const list = [...new Set(ids)].slice(0, 50)
    if (!list.length) return
    const marks = list.map(() => "?").join(",")
    const now = new Date().toISOString()
    db.exec("BEGIN IMMEDIATE")
    try {
      db.prepare(`UPDATE mem SET strength = min(?, strength + ?), uses = uses + 1, last_used = ? WHERE id IN (${marks})`)
        .run(cfg.maxStrength, cfg.hitBoost, now, ...list)
      db.exec("COMMIT")
    } catch (e) {
      try { db.exec("ROLLBACK") } catch { /* ignore */ }
      throw e
    }
  } catch (e) { log(`reinforce failed ${String(e)}`) }
}

/** 按半衰期整体衰减：只降强度，不删记录 */
function decayStrengths(): boolean {
  const cfg = config().memory.decay
  if (!cfg.enabled) return false
  try {
    const db = openMemIndex()
    if (!db) return false
    const state = readWorld()
    const now = Date.now()
    const last = state.lastDecay ? Date.parse(state.lastDecay) : 0
    const days = last ? (now - last) / 86_400_000 : 0
    if (!Number.isFinite(days) || days < 0.25) {
      // 首次没有标记：写一个起点，下次才按天数衰减
      if (!state.lastDecay) {
        if (!updateWorld((s) => { s.lastDecay = new Date(now).toISOString() })) log("decay 标记没写进去，下轮可能重复衰减")
        return true
      }
      return false
    }
    const factor = Math.pow(0.5, days / Math.max(1, cfg.halfLifeDays))
    db.prepare("UPDATE mem SET strength = max(?, strength * ?)").run(cfg.minStrength, factor)
    if (!updateWorld((s) => { s.lastDecay = new Date(now).toISOString() })) log("decay 标记没写进去，下轮可能重复衰减")
    log(`decay applied ×${factor.toFixed(3)} · ${days.toFixed(1)}d`)
    return true
  } catch (e) { log(`decay failed ${String(e)}`); return false }
}

// ———————— ACT-R 激活 / Hebbian 联想 ————————
function accessMap(): Map<string, number[]> {
  const out = new Map<string, number[]>()
  try {
    const db = openMemIndex()
    if (!db) return out
    for (const r of db.prepare("SELECT id, t FROM access").all()) {
      const t = Date.parse(String(r.t)) || 0
      if (!t) continue
      const key = String(r.id)
      const arr = out.get(key) || []
      arr.push(t)
      out.set(key, arr)
    }
  } catch { /* ignore */ }
  return out
}

/** ACT-R 基级激活：B = ln(Σ age^-d)；没有访问记录返回 -Infinity */
function actrBase(times: number[], now: number, d: number): number {
  if (!times.length) return Number.NEGATIVE_INFINITY
  let sum = 0
  for (const t of times) sum += Math.pow(Math.max(0.001, (now - t) / 1000), -d)
  return sum > 0 ? Math.log(sum) : Number.NEGATIVE_INFINITY
}

function recordAccess(ids: string[]): void {
  if (!ids.length) return
  try {
    const db = openMemIndex()
    if (!db) return
    const cfg = config().memory.actr
    const now = new Date().toISOString()
    const ins = db.prepare("INSERT INTO access (id, t) VALUES (?,?)")
    const prune = db.prepare("DELETE FROM access WHERE id = ? AND rowid NOT IN (SELECT rowid FROM access WHERE id = ? ORDER BY t DESC LIMIT ?)")
    db.exec("BEGIN IMMEDIATE")
    try {
      for (const id of [...new Set(ids)]) { ins.run(id, now); prune.run(id, id, cfg.maxAccess) }
      db.exec("COMMIT")
    } catch (e) {
      try { db.exec("ROLLBACK") } catch { /* ignore */ }
      throw e
    }
  } catch (e) { log(`recordAccess failed ${String(e)}`) }
}

function learnEdges(ids: string[]): void {
  const cfg = config().memory.association
  if (!cfg.enabled) return
  const list = [...new Set(ids)].slice(0, 5)
  if (list.length < 2) return
  try {
    const db = openMemIndex()
    if (!db) return
    const now = new Date().toISOString()
    const up = db.prepare("INSERT INTO edges (a,b,w,last) VALUES (?,?,?,?) ON CONFLICT(a,b) DO UPDATE SET w = min(?, w + ?), last = excluded.last")
    db.exec("BEGIN IMMEDIATE")
    try {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i] < list[j] ? list[i] : list[j]
          const b = list[i] < list[j] ? list[j] : list[i]
          up.run(a, b, cfg.learnRate, now, cfg.maxWeight, cfg.learnRate)
        }
      }
      db.exec("COMMIT")
    } catch (e) {
      try { db.exec("ROLLBACK") } catch { /* ignore */ }
      throw e
    }
  } catch (e) { log(`learnEdges failed ${String(e)}`) }
}

/** 一跳扩散：从种子出发，按（衰减后的）边权给邻居加分 */
function spreadScores(seeds: string[], cfg: AssociationOptions): Map<string, number> {
  const out = new Map<string, number>()
  if (!cfg.enabled || !seeds.length) return out
  try {
    const db = openMemIndex()
    if (!db) return out
    const marks = seeds.map(() => "?").join(",")
    const rows = db.prepare(`SELECT a, b, w, last FROM edges WHERE a IN (${marks}) OR b IN (${marks})`).all(...seeds, ...seeds)
    const seedSet = new Set(seeds)
    const now = Date.now()
    for (const r of rows) {
      const days = Math.max(0, (now - (Date.parse(String(r.last)) || now)) / 86_400_000)
      const w = Number(r.w) * Math.exp(-cfg.decayPerDay * days)
      if (!(w > 0)) continue
      const a = String(r.a)
      const b = String(r.b)
      if (seedSet.has(a)) out.set(b, (out.get(b) || 0) + w)
      if (seedSet.has(b)) out.set(a, (out.get(a) || 0) + w)
    }
  } catch (e) { log(`spreadScores failed ${String(e)}`) }
  return new Map([...out.entries()].sort((x, y) => y[1] - x[1]).slice(0, cfg.maxNeighbors))
}

/** 每日边衰减 + 清理弱边 */
function decayEdges(): void {
  const cfg = config().memory.association
  if (!cfg.enabled) return
  try {
    // 边衰减有自己的每日标记，不跟着记忆强度的 lastDecay 走
    const state = readWorld()
    if (state.lastEdgeDecay && dayOf(new Date(state.lastEdgeDecay)) === dayOf()) return
    const db = openMemIndex()
    if (!db) return
    const now = new Date().toISOString()
    db.prepare("UPDATE edges SET w = w * max(0.01, exp(-? * max(0, julianday(?) - julianday(last)))), last = ?").run(cfg.decayPerDay, now, now)
    db.exec("DELETE FROM edges WHERE w < 0.02")
    if (!updateWorld((s) => { s.lastEdgeDecay = now })) log("edge decay 标记没写进去，下轮可能重复衰减")
  } catch (e) { log(`decayEdges failed ${String(e)}`) }
}

/** 用同一天相邻的对话生成弱共现边（Hebbian 的“先后出现”版本） */
function bootstrapCooccurrence(db: any, all: Record_[]): void {
  if (!config().memory.association.bootstrap) return
  try {
    const byDay = new Map<string, Record_[]>()
    for (const r of all) {
      const d = dayOf(new Date(r.t))
      if (!byDay.has(d)) byDay.set(d, [])
      byDay.get(d)!.push(r)
    }
    const ins = db.prepare("INSERT OR IGNORE INTO edges (a,b,w,last) VALUES (?,?,?,?)")
    let added = 0
    db.exec("BEGIN IMMEDIATE")
    try {
      for (const list of byDay.values()) {
        list.sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
        for (let i = 1; i < list.length; i++) {
          const p = list[i - 1]
          const c = list[i]
          const a = p.id < c.id ? p.id : c.id
          const b = p.id < c.id ? c.id : p.id
          const info = ins.run(a, b, 0.03, c.t)
          if (Number(info?.changes || 0) > 0) added++
        }
      }
      db.exec("COMMIT")
    } catch (e) {
      try { db.exec("ROLLBACK") } catch { /* ignore */ }
      throw e
    }
    if (added) log(`association bootstrap · ${added} edges`)
  } catch (e) { log(`bootstrapCooccurrence failed ${String(e)}`) }
}

function indexRecord(r: Record_): void {
  try {
    const db = openMemIndex()
    if (!db) return
    db.exec("BEGIN IMMEDIATE")
    try {
      const info = db.prepare("INSERT OR IGNORE INTO msg (id, day, t, role, text) VALUES (?,?,?,?,?)").run(r.id, dayOf(new Date(r.t)), r.t, r.role, r.text)
      if (Number(info?.changes || 0) > 0) {
        db.prepare("INSERT INTO msg_fts (id, text) VALUES (?,?)").run(r.id, r.text)
        db.prepare("INSERT OR IGNORE INTO mem (id) VALUES (?)").run(r.id)
      }
      db.exec("COMMIT")
    } catch (e) {
      try { db.exec("ROLLBACK") } catch { /* ignore */ }
      throw e
    }
  } catch (e) {
    log(`indexRecord failed ${String(e)}`)
    // 归档已落盘但索引没写进去：退回文件读，稍后重试回填，别让记忆静默缺一条
    markIndexStale()
  }
}

/** 回填锁：避免多个会话同时灌库；10 分钟视为过期 */
function takeBackfillLock(name: string): boolean {
  const lock = join(ROOT, `.${name}.lock`)
  try {
    const fd = openSync(lock, "wx", 0o600) // 原子创建，TOCTOU 交给内核
    writeFileSync(fd, String(process.pid))
    closeSync(fd)
    return true
  } catch {
    try {
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs >= 600_000) {
        unlinkSync(lock)
        const fd = openSync(lock, "wx", 0o600)
        writeFileSync(fd, String(process.pid))
        closeSync(fd)
        return true
      }
    } catch { /* ignore */ }
    return false
  }
}
function releaseBackfillLock(name: string): void {
  try { unlinkSync(join(ROOT, `.${name}.lock`)) } catch { /* ignore */ }
}

function backfillMemoryIndex(): void {
  if (memBackfilled) return
  memBackfilled = true
  if (!takeBackfillLock("backfill")) {
    // 别的进程在灌，60 秒后再试（必须重新调用，否则本进程永远不回填）
    const t = setTimeout(() => { memBackfilled = false; backfillMemoryIndex() }, 60_000)
    ;(t as any).unref?.()
    return
  }
  try {
    const db = openMemIndex()
    if (!db) return
    // 旧版本只有 msg 没有 mem，补一次
    try { db.exec("INSERT OR IGNORE INTO mem (id) SELECT id FROM msg WHERE id NOT IN (SELECT id FROM mem)") } catch { /* ignore */ }
    const all = allRecords()
    let added = 0
    const CHUNK = 500
    for (let i = 0; i < all.length; i += CHUNK) {
      const slice = all.slice(i, i + CHUNK)
      db.exec("BEGIN IMMEDIATE")
      try {
        const ins = db.prepare("INSERT OR IGNORE INTO msg (id, day, t, role, text) VALUES (?,?,?,?,?)")
        const insF = db.prepare("INSERT INTO msg_fts (id, text) VALUES (?,?)")
        const insM = db.prepare("INSERT OR IGNORE INTO mem (id) VALUES (?)")
        for (const r of slice) {
          const info = ins.run(r.id, dayOf(new Date(r.t)), r.t, r.role, r.text)
          if (Number(info?.changes || 0) > 0) { insF.run(r.id, r.text); insM.run(r.id); added++ }
        }
        db.exec("COMMIT")
      } catch (e) {
        try { db.exec("ROLLBACK") } catch { /* ignore */ }
        throw e
      }
    }
    if (added) log(`memory index backfilled ${added}`)
    bootstrapCooccurrence(db, all)
    // 回填完成后才允许走 SQLite 读路径；失败/没跑完就继续读文件
    try { db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('backfilled', '1')").run() } catch { /* ignore */ }
    indexStale = false
  } catch (e) {
    log(`backfill failed ${String(e)}`)
    if (indexStale) { memBackfilled = false; scheduleIndexRetry() }
  }
  finally { releaseBackfillLock("backfill") }
}

function ftsChatIds(query: string, from: string | undefined, to: string | undefined, role: string, limit: number): string[] {
  const db = openMemIndex()
  if (!db) return []
  const q = String(query || "").trim()
  if (!q) return []
  const filters: string[] = []
  const params: any[] = []
  if (from) { filters.push("m.day >= ?"); params.push(from) }
  if (to) { filters.push("m.day <= ?"); params.push(to) }
  if (role !== "any") { filters.push("m.role = ?"); params.push(role) }
  const where = filters.length ? ` AND ${filters.join(" AND ")}` : ""
  try {
    if (q.replace(/\s+/g, "").length >= 3) {
      // trigram：3 字以上走 MATCH，前缀/子串都能命中
      const phrase = `"${q.replace(/"/g, '""')}"`
      const rows = db.prepare(`SELECT m.id AS id FROM msg_fts JOIN msg m ON m.id = msg_fts.id WHERE msg_fts MATCH ?${where} ORDER BY bm25(msg_fts) LIMIT ?`).all(phrase, ...params, limit)
      return rows.map((r: any) => String(r.id))
    }
    // 2 字：LIKE 回退（trigram 索引仍能帮上忙）
    const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`
    const rows = db.prepare(`SELECT m.id AS id FROM msg m WHERE m.text LIKE ? ESCAPE '\\'${where} ORDER BY m.t DESC LIMIT ?`).all(like, ...params, limit)
    return rows.map((r: any) => String(r.id))
  } catch (e) {
    log(`fts search failed ${String(e)}`)
    return []
  }
}

function diaryTitle(day: string): string {
  const raw = readText(join(DIARY_DIR, `${day}.md`))
  for (const line of raw.split("\n")) {
    const t = line.replace(/^[#>\s-]+/, "").trim()
    if (t) return t.slice(0, 40)
  }
  return ""
}

function memoryBlock(): string {
  const c = config()
  const h = c.world.hydrate
  const cutoff = Date.now() - h.hours * 3_600_000
  // 走索引只取窗口内的；索引没准备好时自动退回文件扫描
  const recent = recordsSince(new Date(cutoff).toISOString())
  const picked: Record_[] = []
  let total = 0
  for (let i = recent.length - 1; i >= 0; i--) {
    const cost = recent[i].text.length + 24
    if (total + cost > h.chars) break
    picked.unshift(recent[i]); total += cost
  }
  // 本地小模型优化：限制注入的历史条数（0 = 不注入，-1 = 不限制）
  const keep = c.localModel.enabled ? c.localModel.keepRecent : -1
  if (keep >= 0 && picked.length > keep) picked.splice(0, picked.length - keep)
  const lines = picked.map((r) => `[${shortStamp(r.t)}] ${r.role === "user" ? "对方" : "我"}：${r.text}`)
  const map: string[] = []
  const mapFrom = dayOf(new Date(Date.now() - Math.max(0, h.mapDays - 1) * 86_400_000))
  const counts = new Map<string, number>()
  for (const r of recordsInRange(mapFrom, dayOf())) {
    const d = dayOf(new Date(r.t))
    counts.set(d, (counts.get(d) || 0) + 1)
  }
  for (let i = h.mapDays - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i)
    const day = dayOf(d)
    const n = counts.get(day) || 0
    const title = diaryTitle(day)
    if (n === 0 && !title) continue
    map.push(`- ${day} · ${n > 0 ? `${n} 句` : "没有对话"}${title ? ` · 《${title}》` : ""}`)
  }
  const self = readText(SELF_FILE)
  const parts = [
    "## 我的记忆",
    `最近 ${h.hours} 小时的原话（来自以前的窗口）：`,
    lines.length ? lines.join("\n") : "（最近没有对话）",
  ]
  if (map.length) parts.push("## 记忆地图", map.join("\n"))
  if (self) parts.push("## 我是谁", self)
  return parts.join("\n\n")
}

// ———————— 检索 ————————
function bigrams(text: string): string[] {
  const clean = text.replace(/[^\p{Script=Han}\p{N}a-zA-Z]/gu, "").toLowerCase()
  const out: string[] = []
  for (let i = 0; i < clean.length - 1; i++) out.push(clean.slice(i, i + 2))
  return out
}
function queryParts(q: string) {
  const phrase = q.trim().slice(0, 200)
  const tokens = phrase.split(/\s+/).filter(Boolean).slice(0, 8)
  return { tokens, bigrams: [...new Set(tokens.flatMap(bigrams))].slice(0, 64), phrase }
}
function score(text: string, q: ReturnType<typeof queryParts>): number {
  const lower = text.toLowerCase()
  let exact = 0
  for (const t of q.tokens) if (lower.includes(t.toLowerCase())) exact++
  let ratio = 0
  if (q.bigrams.length) {
    let hit = 0
    for (const b of q.bigrams) if (lower.includes(b)) hit++
    ratio = hit / q.bigrams.length
  }
  if (exact === 0 && ratio < 0.6) return 0
  return exact * 4 + (q.phrase && lower.includes(q.phrase.toLowerCase()) ? 6 : 0) + ratio * 4
}
function snippet(text: string, q: ReturnType<typeof queryParts>, width = 80): string {
  const lower = text.toLowerCase()
  let at = -1
  for (const t of q.tokens) { const i = lower.indexOf(t.toLowerCase()); if (i >= 0 && (at < 0 || i < at)) at = i }
  if (at < 0) for (const b of q.bigrams) { const i = lower.indexOf(b); if (i >= 0 && (at < 0 || i < at)) at = i }
  if (at < 0) at = 0
  const s = Math.max(0, at - width), e = Math.min(text.length, at + width)
  return `${s > 0 ? "…" : ""}${text.slice(s, e).replace(/\s+/g, " ")}${e < text.length ? "…" : ""}`
}
async function searchChat(query: string, from: string | undefined, to: string | undefined, role: string, limit: number, context: number): Promise<string[]> {
  const q = queryParts(query)
  const all = allRecordsFast()
  const hits: Array<{ i: number; score: number; at: number }> = []
  const byId = new Map(all.map((r, i) => [r.id, i]))
  const ids = ftsChatIds(query, from, to, role, Math.max(limit * 6, 60))
  if (ids.length) {
    // FTS5 命中，按 bm25 排名
    ids.forEach((id, rank) => {
      const i = byId.get(id)
      if (i === undefined) return
      hits.push({ i, score: 1000 - rank, at: Date.parse(all[i].t) || 0 })
    })
  } else {
    // 索引没建好 / 罕见查询：退回原来的双字匹配
    all.forEach((r, i) => {
      if (role !== "any" && r.role !== role) return
      const d = dayOf(new Date(r.t))
      if (from && d < from) return
      if (to && d > to) return
      const s = score(r.text, q)
      if (s > 0) hits.push({ i, score: s, at: Date.parse(r.t) || 0 })
    })
    hits.sort((a, b) => b.score - a.score || b.at - a.at)
  }
  // ACT-R 激活 + Hebbian 联想；关闭时退回旧的强度衰减
  const memCfg = config().memory
  if (memCfg.actr.enabled && hits.length) {
    const now = Date.now()
    const acc = accessMap()
    const maxBase = Math.max(...hits.map((h) => h.score), 1)
    const seeds = [...hits].sort((a, b) => b.score - a.score).slice(0, 10).map((h) => all[h.i].id)
    const spread = spreadScores(seeds, memCfg.association)
    const seen = new Set(hits.map((h) => h.i))
    const candidates: Array<{ i: number; base: number; act: number; spread: number; at: number }> = hits.map((h) => ({
      i: h.i,
      base: h.score / maxBase,
      act: actrBase(acc.get(all[h.i].id) || [], now, memCfg.actr.decay),
      spread: spread.get(all[h.i].id) || 0,
      at: h.at,
    }))
    for (const [id, sc] of spread) {
      const i = byId.get(id)
      if (i === undefined || seen.has(i)) continue
      const r = all[i]
      if (role !== "any" && r.role !== role) continue
      const d = dayOf(new Date(r.t))
      if ((from && d < from) || (to && d > to)) continue
      candidates.push({ i, base: 0, act: actrBase(acc.get(id) || [], now, memCfg.actr.decay), spread: sc, at: Date.parse(r.t) || 0 })
    }
    const finiteActs = candidates.map((c) => c.act).filter((x) => Number.isFinite(x))
    const minA = finiteActs.length ? Math.min(...finiteActs) : 0
    const maxA = finiteActs.length ? Math.max(...finiteActs) : 1
    const maxSpread = Math.max(1e-9, ...candidates.map((c) => c.spread))
    const baseW = Math.max(0, 1 - memCfg.actr.weight - memCfg.association.weight)
    for (const c of candidates) {
      const actNorm = Number.isFinite(c.act) ? (maxA === minA ? 0.5 : (c.act - minA) / (maxA - minA)) : 0
      const spreadNorm = c.spread / maxSpread
      c.base = baseW * c.base + memCfg.actr.weight * actNorm + memCfg.association.weight * spreadNorm
    }
    candidates.sort((a, b) => b.base - a.base || b.at - a.at)
    const top = candidates.slice(0, limit)
    recordAccess(top.map((c) => all[c.i].id))
    learnEdges(top.slice(0, 5).map((c) => all[c.i].id))
    hits.length = 0
    for (const c of top) hits.push({ i: c.i, score: c.base, at: c.at })
  } else if (memCfg.decay.enabled && hits.length) {
    const strengths = strengthMap()
    for (const h of hits) {
      const s = Number(strengths.get(all[h.i].id) ?? 1)
      h.score *= 0.7 + 0.3 * Math.min(1, Math.max(0, s / 2))
    }
    hits.sort((a, b) => b.score - a.score || b.at - a.at)
    reinforce(hits.slice(0, limit).map((h) => all[h.i].id))
  }
  const lines: string[] = []
  for (const h of hits.slice(0, limit)) {
    for (let i = Math.max(0, h.i - context); i <= Math.min(all.length - 1, h.i + context); i++) {
      const r = all[i]
      const body = i === h.i ? snippet(r.text, q) : r.text.slice(0, 120)
      lines.push(`${i === h.i ? "▶" : " "} [${shortStamp(r.t)} ${r.role === "user" ? "对方" : "我"}] ${body}`)
    }
    lines.push("")
  }
  return lines.length ? lines : []
}
function walk(dir: string, out: string[] = []): string[] {
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.(md|txt)$/i.test(e.name)) out.push(p)
    }
  } catch { /* ignore */ }
  return out
}
function searchFiles(dirs: string[], query: string, limit: number): string[] {
  const q = queryParts(query)
  const lines: string[] = []
  for (const file of dirs.flatMap((d) => walk(d))) {
    let content = ""
    try { content = readFileSync(file, "utf8") } catch { continue }
    content.split("\n").forEach((line, i) => {
      if (lines.length >= limit) return
      if (line.trim() && score(line, q) > 0) lines.push(`[${basename(file)}:${i + 1}] ${snippet(line, q, 60)}`)
    })
    if (lines.length >= limit) break
  }
  return lines
}

// ———————— 颜文字 ————————
const KAOMOJI_MAP: Record<string, string[]> = {
  撒娇: ["amaeru", "ichaicha"], 害羞: ["hazukashii", "shy", "tereru"], 开心: ["smile", "happy", "yorokobu", "nikkori", "niconico"],
  大笑: ["ehehe", "uhuhu", "waai", "yeay", "yatta", "ahaha"], 得意: ["doya", "ehhen", "fufufu"],
  生气: ["angry", "okoru", "punpun", "iraira", "funsu", "gununu"], 赌气: ["suneru", "tsuntsun", "fuman", "punpun"],
  不爽: ["mukatsuku", "jitome", "shikametsura", "shirome"], 难过: ["sad", "kanashii", "shonbori", "sabishii"],
  哭: ["cry", "uruuru", "nakiwarai"], 爱: ["love", "kyun", "dokidoki", "meromero", "zukyun", "heart"],
  亲亲: ["chu", "kiss", "peropero"], 抱抱: ["hug", "gyu", "dakitsuku", "nadenade", "nakayoshi"],
  无语: ["yareyare", "akireru", "oteage", "chin"], 失望: ["gakkari", "dame", "muri", "konwaku", "komaru"],
  惊讶: ["surprise", "shock", "kyaa", "pokaan"], 疑惑: ["gimon", "hatena", "wakaranai", "nandato"],
  睡觉: ["nemui", "suyaa", "neru", "good-night"], 吃: ["taberu", "mogumogu", "gokugoku", "delicious"],
  玩: ["game", "utau", "karaoke", "dance"], 加油: ["ganbaru", "fight", "ouen", "genki"],
  道歉: ["sorry", "sumimasen", "moushiwakenai", "ayamaru", "dogeza"], 感谢: ["thanks", "arigatou", "azasu", "orei"],
  招呼: ["aisatsu", "ohayou", "konbanwa", "hai", "yoroshiku"], 再见: ["byebye", "sayounara", "matane"],
  思考: ["kangaeru", "nayamu", "jii", "naruhodo"], 眨眼: ["wink", "kirakira", "pikapika", "star", "nagareboshi"],
  捣蛋: ["tobokeru", "hengao", "tehepero", "bishi", "waruikao", "nigawarai"], 慌乱: ["awateru", "aseru", "kinchou", "sowasowa"],
  累: ["tired", "otsukaresama", "shindoi", "mendokusai"], 冷: ["samui"], 热: ["atsui"], 下雨: ["ame"], 下雪: ["yuki"],
  钱: ["okane"], 烟花: ["hanabi", "matsuri"], 鼓掌: ["applause", "pachipachi", "banzai", "waai"],
  胜利: ["peace", "goo", "banzai"], 点头: ["ok", "nodding", "yoshiyoshi", "naruhodo"], 逃跑: ["nigeru", "kakureru"],
}
let kaoCache: Record<string, string[]> | undefined
function kaomoji(): Record<string, string[]> {
  if (kaoCache) return kaoCache
  try { kaoCache = JSON.parse(readFileSync(KAOMOJI_FILE, "utf8")) } catch { kaoCache = {} }
  return kaoCache || {}
}
function pick<T>(list: T[], n: number): T[] {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return a.slice(0, n)
}

function ok(text: string) { return { content: [{ type: "text" as const, text }] } }
function groupBlocked(tool: string): boolean { return CHANNEL === "group" || JUDGE }

function mediaTypeOf(path: string, kind?: string): "image" | "voice" | "file" {
  if (kind === "image" || kind === "voice" || kind === "file") return kind
  const ext = (path.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] || "").toLowerCase()
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext)) return "image"
  if ([".mp3", ".wav", ".silk", ".amr", ".ogg", ".m4a", ".flac", ".aac"].includes(ext)) return "voice"
  return "file"
}

function delegate(task: string, model?: string): Promise<string> {
  return new Promise((resolvePromise) => {
    if (DEPTH >= 1) { resolvePromise("子代理不能再开子代理。"); return }
    const m = model || config().subagent.model || "deepseek-flash"
    const system = "你是一个被主 agent 调用的子代理。只完成给定的任务，输出可直接使用的结果；不要闲聊，不要调用 reach_out，不要开新的子代理。"
    const args = ["-p", "--model", m, "--no-session", "--no-skills", "--no-extensions", "--no-context-files", "--system-prompt", system, task]
    const child = spawn(process.env.PI_BIN || "pi", args, { env: { ...process.env, LIFE_WORLD_DEPTH: String(DEPTH + 1), LIFE_WORLD_ROLE: "subagent" }, stdio: ["ignore", "pipe", "pipe"] })
    let out = "", err = ""
    const timer = setTimeout(() => { try { child.kill("SIGKILL") } catch { /* ignore */ } resolvePromise("子代理超时（180 秒）。") }, 180_000)
    child.stdout.on("data", (d) => { out += String(d) })
    child.stderr.on("data", (d) => { err += String(d) })
    child.on("error", (e) => { clearTimeout(timer); resolvePromise(`子代理启动失败：${String(e)}`) })
    child.on("close", (code) => {
      clearTimeout(timer)
      const text = out.trim()
      if (code === 0 && text) resolvePromise(text)
      else resolvePromise(`子代理失败（exit ${code}）：${(err || out).trim().slice(0, 500)}`)
    })
  })
}

// ———————— 定时器 ————————
function acquireTimerLock(): boolean {
  try {
    if (existsSync(TIMER_LOCK)) {
      const pid = Number(readFileSync(TIMER_LOCK, "utf8").trim())
      if (pid && pid !== process.pid) {
        try { process.kill(pid, 0); return false } catch { /* dead */ }
      }
    }
    writeFileSync(TIMER_LOCK, String(process.pid))
    return true
  } catch { return false }
}

function sendTime(text: string): boolean {
  try {
    const r = (piRef as any)?.sendMessage?.({ customType: "life-world-time", content: text, display: true }, { triggerTurn: true, deliverAs: "followUp" })
    log(`sendTime ${text.slice(0, 60)}`)
    return r !== false
  } catch (e) { log(`sendTime failed ${String(e)}`); return false }
}

// ———————— 主动关怀：安静时段 / 天气 ————————
function inQuietHours(now: Date, care: CareOptions): boolean {
  if (!care.quietStart || !care.quietEnd) return false
  const toMin = (s: string) => {
    const m = String(s).match(/^(\d{1,2}):(\d{2})$/)
    if (!m) return NaN
    const h = Number(m[1]); const mm = Number(m[2])
    if (!Number.isFinite(h) || !Number.isFinite(mm) || h > 23 || mm > 59) return NaN
    return h * 60 + mm
  }
  const cur = now.getHours() * 60 + now.getMinutes()
  const a = toMin(care.quietStart)
  const b = toMin(care.quietEnd)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  if (a === b) return false
  return a < b ? cur >= a && cur < b : cur >= a || cur < b
}

async function fetchWeather(city: string): Promise<string> {
  if (!city) return ""
  try {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return ""
    const d: any = await res.json()
    const cur = d?.current_condition?.[0]
    if (!cur) return ""
    const desc = cur.weatherDesc?.[0]?.value || ""
    return `${desc}，${cur.temp_C}°C（体感 ${cur.FeelsLikeC}°C，湿度 ${cur.humidity}%）`
  } catch { return "" }
}

// ———————— 活动 / 子闹钟 ————————
/** 上下文超限：QQ/群聊交给桥接层换会话；home/CLI 在本轮结束后自己开新会话 */
let contextOverflowPending = false
function isContextOverflow(text: string): boolean {
  return /context window|exceeds the context|too many tokens|maximum context/i.test(String(text || ""))
}
/** QQ/群聊：给桥接留一个超限标记，桥接据此换会话（不依赖 RPC 是否带 errorMessage） */
function markContextOverflow(roleKey: string, err: string): void {
  try {
    atomicWrite(join(ROOT, `context-overflow-${safeRoleKey(roleKey)}.json`), JSON.stringify({
      at: Date.now(), roleKey, error: String(err || "").slice(0, 300),
    }))
  } catch { /* ignore */ }
}

/** agent 是否正在跑一轮；子闹钟到点时正忙就跳过，不排队 */
let agentBusy = false
let agentBusyAt = 0
const AGENT_BUSY_TIMEOUT = 10 * 60_000
function setAgentBusy(v: boolean): void {
  if (v) agentBusyAt = Date.now()
  agentBusy = v
}
function isAgentBusy(): boolean {
  // 看门狗：卡死的轮次不能把后面所有子闹钟都吞掉
  if (agentBusy && Date.now() - agentBusyAt > AGENT_BUSY_TIMEOUT) agentBusy = false
  return agentBusy
}

/** 解析 AI 给的时间：ISO 带时区，或 HH:MM（今天，已过就报错） */
function parseWhen(raw: string): number {
  const s = String(raw || "").trim()
  if (!s) return NaN
  const iso = Date.parse(s)
  if (Number.isFinite(iso)) return iso
  const m = s.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return NaN
  const h = Number(m[1]); const mm = Number(m[2])
  if (h > 23 || mm > 59) return NaN
  const d = new Date()
  d.setHours(h, mm, 0, 0)
  return d.getTime()
}

/** 每天回顾时提醒还开着的活动，避免 AI 忘了关 */
function openActivitiesLine(): string {
  const open = (readWorld().alarms || []).filter((a) => a.kind === "main" && a.status === "active")
  if (!open.length) return ""
  const items = open.map((a) => `《${a.note}》（id ${a.id}${a.activatedAt ? `，${shortStamp(a.activatedAt)} 开始` : ""}）`)
  return `\n还有活动开着：${items.join("、")}。做完了就 cancel_alarm({ id }) 关掉，别一直挂着。`
}

/** 单次心跳串最长持续多久（分钟）；10~1440，默认 20 */
function heartbeatLimitMinutes(): number {
  const v = Number(config().world.heartbeatMaxMinutes)
  if (!Number.isFinite(v) || v <= 0) return 20
  return Math.max(10, Math.min(1440, Math.round(v)))
}
/** 心跳总开关（看板「心跳时长」里可以关掉） */
function heartbeatEnabled(): boolean {
  return config().world.heartbeatEnabled !== false
}

/** 心跳串到点时的唤醒文本：带上理由、第几跳、怎么停 */
function heartbeatText(a: Alarm, last = false, why: "jumps" | "time" | null = null): string {
  const seqN = Number(a.seq)
  const seq = Number.isFinite(seqN) && seqN > 0 ? seqN : 1
  const everyN = Number(a.intervalMinutes)
  const every = Number.isFinite(everyN) && everyN >= 1 ? everyN : 2
  const reason = String(a.reason || "")
  const body = String(a.note || reason)
  const tail = last
    ? (why === "time"
        ? `（串 ${a.chainId}，已到心跳时长上限（${heartbeatLimitMinutes()} 分钟），到此结束）`
        : `（串 ${a.chainId}，到 60 跳上限了，到此结束）`)
    : `（串 ${a.chainId}，每 ${every} 分钟一跳，下一跳会自动排上；不用了就 heartbeat_stop({ chainId: "${a.chainId}" })）`
  return [
    `【心跳 · 第 ${seq} 跳】${body}`,
    reason && reason !== body ? `（起这个心跳的理由：${reason}）` : "",
    tail,
  ].filter(Boolean).join("\n")
}

function skippedLine(skipped?: Array<{ scheduled: string; note: string }>, max = 6): string {
  if (!skipped?.length) return ""
  const shown = skipped.slice(-max).map((s) => `${shortStamp(s.scheduled)} ${s.note}`)
  const more = skipped.length > max ? ` 等 ${skipped.length} 条` : ""
  return `上次因为忙跳过了 ${skipped.length} 条子闹钟：${shown.join("、")}${more}。要补做就重新 plan_next，不想做就忽略。`
}

/** 闹钟到点前，先切到任务指定的模型（local / cloud） */
async function switchForAlarm(alarm: Alarm): Promise<void> {
  if (!alarm.model) return
  const c = config().models
  const target = alarm.model === "local" ? c.local : alarm.model === "cloud" ? c.cloud : ""
  if (!target || !lastCtx) return
  if (modelIdOf(lastCtx) === target) return
  const result = await switchTo(lastCtx, target, `闹钟任务：${alarm.note.slice(0, 20)}`)
  log(`alarm model · ${result}`)
}

function impressionPrompt(imp: ImpressionOptions): string {
  return `【后台任务·印象整理】用 memory_timeline / memory_search 回看最近 ${imp.days} 天（对话、日记、房间笔记），整理最多 ${imp.maxItems} 条对重要对象或主题的「印象」。\n每条写成：- [对象/主题] 一句印象（来源：日期；置信度：高/中/低；最后验证：日期）\n先读 identity/印象.md（没有就新建），把新印象合并进去：重复的更新「最后验证」和置信度，矛盾的以新证据为准并注明。\n腾位与过期（按「最后验证」距今算，只决定删不删，不改置信度）：\n- 满 ${imp.staleDays} 天但不到 ${imp.expireDays} 天：算「可替换」，有新印象要进来时优先删它腾位。\n- 超过 ${imp.expireDays} 天：算「过期印象」，直接删掉，用新印象补位。\n- 不到 ${imp.staleDays} 天：除非已被新证据推翻，否则别删。\n总数不超过 ${imp.maxItems} 条。只写能站得住的判断，不要复述聊天记录，不要写私密细节。写回 identity/印象.md。`
}

let ticking = false
async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    rotateLog(LOG_FILE)
    const c = config()
    if (!c.world.enabled || !c.world.running) return
    // world.json 损坏时整轮跳过：否则每个 tick 都会重发同一条后台任务，还写不进去标记
    if (!readWorldStrict()) {
      log("world.json 解析失败，本轮跳过（等修好或下次重启）")
      return
    }
    const state = readWorld()
    const now = new Date()
    const today = dayOf(now)
    const hour = now.getHours()
    // 每日回顾
    if (hour >= c.world.reviewHour && state.lastReview !== today) {
      sendTime(`【后台任务·每日回顾】${today} 快过完了，回头看看今天。今天的聊天记录在 ${CONV_DIR}，日记在 ${DIARY_DIR}。写日记、更新「我是谁」、更新用户画像、清理到期心情。${openActivitiesLine()}`)
      updateWorld((s) => { s.lastReview = today })
      return
    }
    // 每日快照：放到子进程跑，别阻塞主会话
    if (c.backup.enabled && hour >= c.backup.hour && state.lastBackup !== today) {
      const attempt = state.lastBackupAttempt ? Date.parse(state.lastBackupAttempt) : 0
      if (!Number.isFinite(attempt) || Date.now() - attempt > 10 * 60_000) {
        try {
          const script = join(EXT_DIR, "../bin/world-backup.mjs")
          if (existsSync(script)) {
            if (!updateWorld((s) => { s.lastBackupAttempt = new Date().toISOString() })) {
              log("backup · skip (world.json not writable)")
              return
            }
            const child = spawn(process.execPath, [script, ...(c.backup.includePrivate ? ["--private"] : [])], {
              detached: true, stdio: "ignore", env: { ...process.env, LIFE_WORLD_ROOT: ROOT },
            })
            child.on("exit", (code) => {
              if (code === 0) { updateWorld((s) => { s.lastBackup = today }); log("backup · ok") }
              else log(`backup · fail exit ${code}`)
            })
            child.on("error", (e) => log(`backup spawn failed ${String(e)}`))
            child.unref()
          }
        } catch (e) { log(`backup spawn failed ${String(e)}`) }
      }
    }
    // 每日清理 tmp；桥接心跳检查
    if (state.lastCleanup !== today) {
      if (cleanupTmp(c.cleanup.tmpMaxAgeHours)) updateWorld((s) => { s.lastCleanup = today })
      // 后台任务的 job / 日志留 7 天；日志超 20MB 截断到 1MB
      try {
        if (existsSync(BG_DIR)) {
          const cutoff = Date.now() - 7 * 86400_000
          for (const f of readdirSync(BG_DIR)) {
            try {
              const p = join(BG_DIR, f)
              const st = statSync(p)
              if (!st.isFile()) continue
              if (st.mtimeMs < cutoff) { unlinkSync(p); continue }
              if (f.endsWith(".log") && st.size > 20 * 1024 * 1024) {
                const keep = readTail(p, 1024 * 1024)
                writeFileSync(p, `[日志超过 20MB，已截断，只保留最后 1MB]\n${keep}`, { mode: 0o600 })
              }
            } catch { /* 单个文件失败不影响其它 */ }
          }
        }
      } catch { /* ignore */ }
    }
    if (state.lastControlPrune !== today) {
      pruneControlQueue(3)
      updateWorld((s) => { s.lastControlPrune = today })
    }
    // 已执行的子闹钟留档 24 小时，过期清掉（活动关闭时会连子闹钟一起删，不用等这里）
    withWorldLock(() => {
      const f = readWorld()
      const list = f.alarms || []
      const cutoff = Date.now() - 24 * 3600_000
      const kept = list.filter((x) => {
        if (x.kind === "sub" && x.status === "fired" && Date.parse(x.firedAt || x.at) < cutoff) return false
        if (x.kind === "main" && x.status === "closed" && Date.parse(x.closedAt || x.at) < cutoff) return false
        return true
      })
      if (kept.length === list.length) return false
      f.alarms = kept
      return writeWorld(f)
    })
    // 记忆强度与联想边各自每天一次；边衰减不再依赖 decay 开关
    if (!state.lastDecay || dayOf(new Date(state.lastDecay)) !== today) decayStrengths()
    if (!state.lastEdgeDecay || dayOf(new Date(state.lastEdgeDecay)) !== today) decayEdges()
    guardBridge()
    // 到点闹钟：旧一次性 → 主活动 → 子闹钟；一轮最多唤醒一次
    const nowMs = Date.now()
    const alarmsNow = (state.alarms || []).filter((a) => Number.isFinite(Date.parse(a.at)) && Date.parse(a.at) <= nowMs)
    let woke = false
    // 旧版一次性闹钟：保持原行为
    for (const a of alarmsNow.filter((x) => !x.kind && !x.status)) {
      if (woke) break
      const text = `【后台任务】${shortStamp(a.at)}：${a.note}。\n做完就结束；要让他知道就用 reach_out。做完想想下一件，用 plan_next 重新定。今天的计划在 ${join(PLAN_DIR, `${today}.md`)}。`
      const legacySent = a.model
        ? await switchForAlarm(a).then(() => sendTime(text)).catch((e) => { log(`alarm switch failed ${String(e)}`); return sendTime(text) })
        : sendTime(text)
      if (!legacySent) { log("alarm send failed, retry next tick"); continue }
      withWorldLock(() => {
        const fresh = readWorld()
        fresh.alarms = (fresh.alarms || []).filter((x) => x.id !== a.id)
        fresh.lastWake = today
        return writeWorld(fresh)
      })
      woke = true
    }
    // 主活动：开始前先把还开着的上一个强制关掉，并提醒 AI
    for (const a of alarmsNow.filter((x) => x.kind === "main" && (x.status || "pending") === "pending" && !x.paused)) {
      if (woke) break
      const closing = (readWorld().alarms || []).filter((x) => x.kind === "main" && x.status === "active" && x.id !== a.id)
      const closedNotes: string[] = []
      const closedSkips: Array<{ scheduled: string; note: string }> = []
      for (const o of closing) {
        closedNotes.push(o.note)
        for (const s of o.skipped || []) closedSkips.push(s)
      }
      const saved = withWorldLock(() => {
        const fresh = readWorld()
        const list = fresh.alarms || []
        const closedIds = new Set(closing.map((x) => x.id))
        // 被顶掉的活动也留尾声：标 closed，已执行的子闹钟留着，没执行的撤掉
        for (const x of list) {
          if (closedIds.has(x.id)) {
            x.status = "closed"
            x.closedAt = new Date().toISOString()
          }
        }
        const keep = list.filter((x) => !(x.kind === "sub" && x.parentId && closedIds.has(x.parentId) && x.status !== "fired"))
        const self = keep.find((x) => x.id === a.id)
        if (!self) return false
        self.status = "active"
        self.activatedAt = new Date().toISOString()
        fresh.alarms = keep
        fresh.lastWake = today
        return writeWorld(fresh)
      })
      if (!saved) continue
      const reminder = closedNotes.length ? `\n注意：上一项活动《${closedNotes.join("、")}》还没结束，已强制关闭，它的子闹钟一起关了。` : ""
      const skipNote = skippedLine([...(a.skipped || []), ...closedSkips])
      const text = `【后台任务·活动开始】${shortStamp(a.at)}：${a.note}。\n活动 id：${a.id}。\n要盯某件事、过一会儿回来看，就用 heartbeat({ reason: "接着做「${a.note.slice(0, 20)}」", every_minutes: 3 }) 起一条心跳；也可以直接排一条新的日程。\n做完或不想做了，用 cancel_alarm({ id: "${a.id}" }) 关闭活动。\n做完就结束；要让他知道就用 reach_out。${reminder}${skipNote ? `\n${skipNote}` : ""}`
      const sentOk = a.model
        ? await switchForAlarm(a).then(() => sendTime(text)).catch((e) => { log(`alarm switch failed ${String(e)}`); return sendTime(text) })
        : sendTime(text)
      if (!sentOk) {
        // 发不出去就把 active 回滚成 pending，否则下轮过滤会跳过它、这条活动永远醒不来
        log("alarm send failed, rollback to pending")
        withWorldLock(() => {
          const f = readWorld()
          const self = (f.alarms || []).find((x) => x.id === a.id)
          if (self) { self.status = "pending"; delete self.activatedAt }
          return writeWorld(f)
        })
        continue
      }
      withWorldLock(() => {
        const fresh = readWorld()
        const self = (fresh.alarms || []).find((x) => x.id === a.id)
        if (self) delete self.skipped
        return writeWorld(fresh)
      })
      woke = true
    }
    // 子闹钟：忙就跳过并记录，闲才唤醒
    if (!woke) {
      for (const a of alarmsNow.filter((x) => x.kind === "sub" && x.status !== "closed" && x.status !== "fired")) {
        // 旧机制残留（挂在活动下的子闹钟）：这套已经废弃，遇到就清掉
        if (a.parentId && !a.chainId) {
          withWorldLock(() => {
            const f = readWorld()
            f.alarms = (f.alarms || []).filter((x) => x.id !== a.id)
            return writeWorld(f)
          })
          continue
        }
        // —— 心跳串：独立于主活动，触发后自动续下一跳 ——
        if (a.chainId && !a.parentId) {
          // 总开关关掉时不再触发（未执行的跳保留，打开后接着跳）
          if (!heartbeatEnabled()) continue
          if (a.paused) continue
          if (isAgentBusy()) {
            // 心跳不该被跳过：忙就往后挪 30 秒再试
            withWorldLock(() => {
              const f = readWorld()
              const x = (f.alarms || []).find((y) => y.id === a.id)
              if (x) x.at = new Date(Date.now() + 30_000).toISOString()
              return writeWorld(f)
            })
            continue
          }
          const seqN0 = Number(a.seq)
          const seq0 = Number.isFinite(seqN0) && seqN0 > 0 ? seqN0 : 1
          const everyN0 = Number(a.intervalMinutes)
          const every0 = Number.isFinite(everyN0) && everyN0 >= 1 && everyN0 <= 60 ? everyN0 : 2
          const startedRaw = Date.parse(String(a.startedAt || ""))
          const fallbackRaw = Date.parse(String(a.setAt || a.at || ""))
          // 锚点必须是有限值：脏 startedAt 会让上限静默失效、一路跑满 60 跳
          const startedMs = Number.isFinite(startedRaw) ? startedRaw : (Number.isFinite(fallbackRaw) ? fallbackRaw : Date.now())
          const maxMin = heartbeatLimitMinutes()
          const timeUp = (Date.now() - startedMs) / 60_000 + every0 > maxMin
          const willContinue = seq0 < 60 && !timeUp
          const hbText = heartbeatText(a, !willContinue, timeUp ? "time" : (seq0 >= 60 ? "jumps" : null))
          const hbSent = a.model
            ? await switchForAlarm(a).then(() => sendTime(hbText)).catch((e) => { log(`heartbeat switch failed ${String(e)}`); return sendTime(hbText) })
            : sendTime(hbText)
          if (!hbSent) { log("heartbeat send failed, retry next tick"); continue }
          withWorldLock(() => {
            const f = readWorld()
            const list = f.alarms || []
            const cur = list.find((x) => x.id === a.id)
            // 发送期间被 heartbeat_stop 停掉了：不要把它复活
            if (!cur || cur.status === "fired") return writeWorld(f)
            cur.status = "fired"
            cur.firedAt = new Date().toISOString()
            // 最多 60 跳，且累计时长不超过 heartbeatMaxMinutes，防止忘了停一直烧 token
            if (willContinue) {
              const base = Date.parse(a.at)
              const nextMs = Math.max(Date.now(), (Number.isFinite(base) ? base : Date.now()) + every0 * 60_000)
              list.push({
                id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                at: new Date(nextMs).toISOString(),
                note: a.note, setAt: new Date().toISOString(), model: a.model,
                kind: "sub", status: "pending",
                chainId: a.chainId, reason: a.reason, intervalMinutes: every0, seq: seq0 + 1,
                startedAt: new Date(startedMs).toISOString(),
              })
            }
            f.alarms = list
            f.lastWake = today
            return writeWorld(f)
          })
          woke = true
          break
        }
      }
    }
    if (woke) return
    maybeRandomCare()
    // 印象整理：每天一次，固定 hour（默认 05:00）后；配了本地模型先切本地再跑
    const impCfg = c.memory.impression
    if (impCfg.enabled && state.lastImpression !== today && hour >= impCfg.hour) {
      const o = c.models
      if (o.local && lastCtx && modelIdOf(lastCtx) !== o.local) {
        const r = await switchTo(lastCtx, o.local, "每日印象整理")
        log(`impression · switch model · ${r}`)
        if (r.startsWith("切不过去")) log("impression · 本地不可用，按当前模型继续")
      }
      if (sendTime(impressionPrompt(impCfg))) updateWorld((s) => { s.lastImpression = today })
      else log("impression · send failed, will retry")
    }
    // 早上兜底
    if (state.lastWake === today) return
    if (hour >= c.world.reviewHour) return
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const planned = (state.alarms || []).some((a) => { const t = Date.parse(a.at); return Number.isFinite(t) && t >= dayStart && t <= dayStart + 86_400_000 })
    if (planned) return
    const [fh, fm] = c.world.fallbackWakeTime.split(":").map((x) => Number(x) || 0)
    const mins = hour * 60 + now.getMinutes()
    if (mins < fh * 60 + fm || mins >= fh * 60 + fm + 240) return
    const weather = c.care.enabled && c.care.weatherEnabled ? await fetchWeather(c.care.weatherCity) : ""
    sendTime(`【后台任务·早上】新的一天。先看看今天的安排：${join(PLAN_DIR, `${today}.md`)}。没有就自己拟一份大概的；挑一件现在就做的，用 plan_next 排上时间。${weather ? `\n今天的天气：${weather}` : ""}`)
    updateWorld((s) => { s.lastWake = today })
  } catch (e) { log(`tick failed ${String(e)}`) }
  finally { ticking = false }
}

// ———————— 守护与清理 ————————
function rotateLog(file: string, maxBytes = 5 * 1024 * 1024): void {
  try {
    if (!existsSync(file)) return
    if (statSync(file).size <= maxBytes) return
    const old = `${file}.1`
    try { if (existsSync(old)) unlinkSync(old) } catch { /* ignore */ }
    renameSync(file, old)
  } catch (e) {
    const msg = String(e)
    if (!msg.includes("ENOENT")) log(`rotateLog failed ${msg}`)
  }
}

function cleanupTmp(maxAgeHours: number): boolean {
  try {
    if (!existsSync(TMP_DIR)) return true
    const cutoff = Date.now() - Math.max(1, maxAgeHours) * 3_600_000
    for (const f of readdirSync(TMP_DIR)) {
      const p = join(TMP_DIR, f)
      try {
        const st = statSync(p)
        if (st.mtimeMs >= cutoff) continue
        if (st.isDirectory()) rmSync(p, { recursive: true, force: true })
        else if (st.isFile()) unlinkSync(p)
      } catch { /* ignore */ }
    }
    return true
  } catch (e) { log(`cleanupTmp failed ${String(e)}`); return false }
}

/** QQ 桥接心跳超过 staleSeconds 就尝试拉起来（家会话负责守） */
function guardBridge(): void {
  try {
    const c = config()
    if (!c.guard.enabled || !c.guard.allowRestart || !c.bridge.enabled) return
    const state = readWorld()
    const now = Date.now()
    const last = state.lastGuard ? Date.parse(state.lastGuard) : 0
    if (now - last < Math.max(1, c.guard.cooldownMinutes) * 60_000) return
    if (!existsSync(STATUS_DIR)) return
    const fresh = readdirSync(STATUS_DIR)
      .filter((f) => f.startsWith("qq-") && f.endsWith(".json"))
      .some((f) => {
        const s = readJson<{ updated?: string }>(join(STATUS_DIR, f), {})
        return s.updated && now - Date.parse(s.updated) < Math.max(30, c.guard.staleSeconds) * 1000
      })
    if (fresh) return
    updateWorld((s) => { s.lastGuard = new Date(now).toISOString() })
    const lwctl = join(ROOT, "bin", "lwctl")
    if (!existsSync(lwctl)) return
    log("guard · qq bridge stale, restarting")
    const child = spawn(lwctl, ["restart", "qq"], { detached: true, stdio: "ignore", env: { ...process.env }, cwd: ROOT })
    child.on("error", (e) => log(`guard spawn failed · ${String(e)}`))
    child.unref()
  } catch (e) { log(`guardBridge failed ${String(e)}`) }
}

/** 主动关怀：安静时段之外，隔一阵随机想起对方 */
function maybeRandomCare(): void {
  try {
    const c = config()
    if (!c.care.enabled || !c.care.randomEnabled) return
    if (!c.world.enabled || !c.world.running) return
    const now = new Date()
    if (inQuietHours(now, c.care)) return
    const state = readWorld()
    const last = state.lastRandom ? Date.parse(state.lastRandom) : 0
    const gapH = Number(c.care.randomMinGapHours)
    const gap = (Number.isFinite(gapH) ? Math.max(0, gapH) : 3) * 3_600_000
    if (Date.now() - last < gap) return
    const chance = Number(c.care.randomChancePerTick)
    const p = Number.isFinite(chance) ? Math.max(0, Math.min(1, chance)) : 0.02
    if (Math.random() >= p) return
    updateWorld((s) => { s.lastRandom = now.toISOString() })
    sendTime("【想起你】这会儿没在聊天，但你忽然想起了对方。想发就写一两句，用 reach_out 发到 QQ；不想打扰就只回 [SILENT]。")
  } catch (e) { log(`random care failed ${String(e)}`) }
}

let piRef: unknown
let lastCtx: any = null

// ———————— 扩展 ————————
function argSummary(name: string, args: any): string {
  if (!args) return ""
  const value = args.note || args.command || args.query || args.date || args.text || args.path || args.task || args.scene || args.question || args.id
  return value ? String(value).replace(/\s+/g, " ").slice(0, 50) : ""
}

function compactRenderers(name: string) {
  return {
    renderCall(args: any, theme: any) {
      const summary = argSummary(name, args)
      const title = theme.fg("toolTitle", theme.bold(name))
      return new Text(summary ? `${title} ${theme.fg("muted", summary)}` : title, 0, 0)
    },
    renderResult(result: any, opts: any, theme: any) {
      const content = (result?.content || [])
        .filter((part: any) => part?.type === "text")
        .map((part: any) => part.text)
        .join("\n")
        .trim()
      const first = content.split("\n")[0]?.slice(0, 90) || ""
      let text = theme.fg("success", "✓ ") + theme.fg("muted", first)
      if (opts?.expanded && content) text += `\n${theme.fg("dim", content)}`
      return new Text(text, 0, 0)
    },
  }
}

function addTool(api: ExtensionAPI, def: any) {
  api.registerTool({ ...def, ...compactRenderers(def.name) })
}

let promptCache: string | undefined
function worldPromptText(): string {
  if (promptCache !== undefined) return promptCache
  let text = ""
  try { if (existsSync(PROMPT_FILE)) text = readFileSync(PROMPT_FILE, "utf8") } catch { /* ignore */ }
  if (!text) {
    // 没跑 install.sh（例如直接 clone / 包安装）时，从仓库 modules 现拼
    try {
      const parts = [
        "# life-world · 世界规则", "",
        "你就是你，不是模型：本地是家，在线是化形进公共机房借算力；换模型只换化形，不换人。身份以 identity/我是谁.md 为准；这具身子是谁家的可以照实说，名字和关系不跟着变。", "",
        `世界数据在 ${WORLD}。规则按主题如下：`, "",
      ]
      for (const file of readdirSync(MODULES_DIR).filter((f) => f.endsWith(".md")).sort()) {
        const name = file.replace(/\.md$/, "")
        let body = readFileSync(join(MODULES_DIR, file), "utf8").trim()
        if (name === "gal") body = body.replace(/\bquestion\b/g, "gal_choice")
        parts.push("---", "", `## ${name}`, "", body, "")
      }
      text = parts.join("\n")
    } catch { /* ignore */ }
  }
  const map: Record<string, string> = {
    "{worldDir}": WORLD,
    "{modulesDir}": MODULES_DIR,
    "{roomDir}": join(WORLD, "room"),
    "{stickerDir}": join(WORLD, "表情包"),
    "{identityDir}": join(WORLD, "identity"),
    "{diaryDir}": join(WORLD, "diary"),
    "{planDir}": join(WORLD, "plan"),
    "{conversationsDir}": join(WORLD, "conversations"),
    "{selfFile}": join(WORLD, "identity/我是谁.md"),
    "{profileFile}": join(WORLD, "identity/用户画像.md"),
    "{moodFile}": join(WORLD, "identity/心情.md"),
    "{planFile}": join(WORLD, "plan/YYYY-MM-DD.md"),
  }
  for (const [key, value] of Object.entries(map)) text = text.split(key).join(value)
  if (text && !text.includes(WORLD_MARK)) text = `${WORLD_MARK}\n${text}`
  promptCache = text
  return text
}

// ———————— 联网搜索（TinyFish keyless，免费；opencode websearch 同源） ————————
const TINYFISH_ENDPOINT = "https://agent.tinyfish.ai/mcp"
interface SearchHit { title: string; url: string; snippet?: string }

async function webSearch(query: string, limit: number): Promise<SearchHit[]> {
  const key = process.env.TINYFISH_API_KEY || ""
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "User-Agent": "life-world/pi",
  }
  if (key) headers["X-API-Key"] = key
  else headers["X-TinyFish-Access-Mode"] = "keyless"
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { query } } })
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 25_000)
  try {
    const res = await fetch(TINYFISH_ENDPOINT, { method: "POST", headers, body, signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const raw = await res.text()
    const payloads = [raw.trim()]
    for (const line of raw.split("\n")) if (line.startsWith("data: ")) payloads.push(line.slice(6))
    for (const payload of payloads) {
      if (!payload.startsWith("{")) continue
      let obj: any
      try { obj = JSON.parse(payload) } catch { continue }
      const text = obj?.result?.content?.find((c: any) => c?.type === "text")?.text
      if (!text) continue
      let data: any
      try { data = JSON.parse(text) } catch { continue }
      const list = Array.isArray(data?.results) ? data.results : []
      return list.slice(0, limit).map((r: any) => ({
        title: String(r.title || ""),
        url: String(r.url || ""),
        snippet: r.snippet ? String(r.snippet) : undefined,
      }))
    }
    return []
  } finally {
    clearTimeout(timer)
  }
}

// ———————— 本地小模型：上下文折叠 ————————
/** 保留最近 keepTurns 轮，返回需要处理的截止下标（0 = 不需要动） */
function turnCutoff(messages: any[], keepTurns: number): number {
  const userIdx: number[] = []
  messages.forEach((m, i) => { if (m?.role === "user") userIdx.push(i) })
  if (keepTurns === 0) return messages.length
  if (userIdx.length <= keepTurns) return 0
  return userIdx[userIdx.length - keepTurns - 1]
}

/** 折叠较早轮次的工具结果，只留开头一小段 */
function foldToolResults(messages: any[], keepTurns: number, keepChars: number): boolean {
  if (keepTurns < 0) return false
  const cutoff = turnCutoff(messages, keepTurns)
  if (!cutoff) return false
  let changed = false
  const shrink = (holder: any): void => {
    if (!holder || typeof holder !== "object") return
    if (typeof holder.text === "string" && holder.text.length > keepChars && !holder.text.startsWith("[已折叠")) {
      holder.text = `[已折叠 工具结果 ${Math.round(holder.text.length / 1024)}KB] ` + holder.text.slice(0, keepChars).replace(/\s+/g, " ") + " …"
      changed = true
    }
  }
  for (let i = 0; i < cutoff; i++) {
    const msg = messages[i]
    if (msg?.role !== "toolResult") continue
    if (Array.isArray(msg.content)) msg.content.forEach(shrink)
    else shrink(msg)
  }
  return changed
}

/** 折叠较早轮次的推理（思考过程每轮重发太贵） */
function foldThinking(messages: any[], keepTurns: number): boolean {
  if (keepTurns < 0) return false
  const cutoff = turnCutoff(messages, keepTurns)
  if (!cutoff) return false
  let changed = false
  for (let i = 0; i < cutoff; i++) {
    const parts = messages[i]?.content
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (part?.type !== "thinking" || !String(part.text ?? "")) continue
      part.text = ""
      if (typeof part.signature === "string") part.signature = ""
      if (part.native && typeof part.native === "object") part.native = {}
      changed = true
    }
  }
  return changed
}

/** 统计一次请求的构成（对话 / 工具 / 推理），调试用 */
function statsRequest(messages: any[]): void {
  let dialogue = 0, tools = 0, reasoning = 0, other = 0
  for (const m of messages) {
    const parts = Array.isArray(m?.content) ? m.content : []
    if (m?.role === "user") {
      dialogue += parts.filter((p: any) => p?.type === "text").map((p: any) => String(p.text || "")).length
      continue
    }
    if (m?.role === "toolResult") {
      for (const p of parts) tools += String(p?.text ?? JSON.stringify(p ?? {})).length
      continue
    }
    for (const p of parts) {
      if (p?.type === "text") dialogue += String(p.text || "").length
      else if (p?.type === "thinking") reasoning += String(p.text || "").length
      else if (p?.type === "toolCall" || p?.type === "image") tools += JSON.stringify(p).length
      else other += JSON.stringify(p).length
    }
  }
  const total = dialogue + tools + reasoning + other
  if (!total) return
  const kb = (n: number) => Math.round(n / 1024) + "KB"
  const pct = (n: number) => ((n / total) * 100).toFixed(1) + "%"
  log(`ctx stats · 总 ${kb(total)} | 对话 ${kb(dialogue)} ${pct(dialogue)} | 工具 ${kb(tools)} ${pct(tools)} | 推理 ${kb(reasoning)} ${pct(reasoning)} | 其他 ${kb(other)}`)
}

// ———————— 本地 / 在线模型热切换 ————————
let lastSwitch = { at: 0, from: "", to: "" }
let failingOver = false
let toolFailures = 0
const modelHealthCache = new Map<string, { at: number; up: boolean }>()
const healthAuthLogged = new Set<string>()

interface DrawerState { active: boolean; cutoff: number; hidden: number; stashed?: boolean }
/** 抽屉按会话隔离：一个进程合抽屉不影响另一个云端会话 */
function sessionKey(ctx: any): string {
  const id = ctx?.sessionManager?.getSessionId?.()
  return String(id || `proc-${process.pid}`).replace(/[^A-Za-z0-9_.-]/g, "_")
}
function drawerFile(key: string): string { return join(DRAWER_SESSIONS, `${key}.json`) }
function readDrawer(key: string): DrawerState {
  const file = drawerFile(key)
  if (!existsSync(file)) return { active: false, cutoff: 0, hidden: 0 }
  try { return JSON.parse(readFileSync(file, "utf8")) as DrawerState }
  catch {
    // 读不出来就按“开着”处理，宁可多挡也不漏
    log(`drawer state unreadable, fail-closed · ${key}`)
    return { active: true, cutoff: Date.now(), hidden: 0, stashed: true }
  }
}
/** 抽屉的实体：被挡下的原文按天存在机密抽屉目录里（云端看不到） */
function drawerLogPath(): string { return join(DRAWER_DIR, `${dayOf()}.jsonl`) }
/** 私密资料提示（不预加载内容，本地需要自己看） */
const PRIVATE_HINT_MARK = "## 私密资料"
function writeDrawer(key: string, state: DrawerState): boolean {
  try {
    mkdirSync(DRAWER_SESSIONS, { recursive: true, mode: 0o700 })
    atomicWrite(drawerFile(key), JSON.stringify(state, null, 2))
    return true
  } catch (e) {
    log(`writeDrawer failed ${String(e)}`)
    return false
  }
}
/** 切到云端：把此刻之前的对话收进抽屉（只对云端屏蔽，不改原会话） */
function openDrawer(ctx: any): boolean {
  // 没配本地模型就谈不上“私密”，抽屉不启用
  if (!config().models.local) return true
  const key = sessionKey(ctx)
  const d = readDrawer(key)
  const now = Date.now()
  const state: DrawerState = d.active
    ? { ...d, active: true, cutoff: Math.min(d.cutoff || now, now) }
    : { active: true, cutoff: now, hidden: 0, stashed: false }
  const okWrite = writeDrawer(key, state)
  log(`privacy drawer opened · ${key}`)
  return okWrite
}
/** 切回本地：抽屉合上，原对话重新可见 */
function closeDrawer(ctx: any): void {
  const key = sessionKey(ctx)
  const d = readDrawer(key)
  if (!d.active) return
  writeDrawer(key, { ...d, active: false })
  log(`privacy drawer closed · ${key}`)
}

/** 过滤后清掉配不上对的工具调用 / 结果，避免云端报 “tool 必须跟在 tool_calls 后面” */
function sanitizeToolPairs(messages: any[]): any[] {
  const callIds = new Set<string>()
  for (const m of messages) {
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue
    for (const p of m.content) if (p?.type === "toolCall" && p.id) callIds.add(String(p.id))
  }
  const kept: any[] = []
  const resultIds = new Set<string>()
  for (const m of messages) {
    if (m?.role === "toolResult") {
      const id = String(m.toolCallId || "")
      if (!callIds.has(id)) continue
      resultIds.add(id)
    }
    kept.push(m)
  }
  for (const m of kept) {
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue
    const parts = m.content.filter((p: any) => p?.type !== "toolCall" || resultIds.has(String(p.id)))
    if (parts.length !== m.content.length) m.content = parts
  }
  return kept.filter((m: any) => m?.role !== "assistant" || (Array.isArray(m.content) && m.content.length > 0))
}

function parseModelRef(ref: string): { provider: string; id: string } | null {
  const i = String(ref || "").indexOf("/")
  if (i <= 0 || i >= String(ref).length - 1) return null
  return { provider: String(ref).slice(0, i), id: String(ref).slice(i + 1) }
}

function modelIdOf(ctx: any): string {
  const m = ctx?.model
  if (!m) return ""
  return `${m.provider}/${m.id}`
}

function providerKey(provider: string): string {
  try {
    const auth = readJson<Record<string, { key?: string }>>(AUTH_FILE, {})
    return String(auth?.[provider]?.key || "")
  } catch { return "" }
}

async function probeUrl(url: string, headers: Record<string, string>, timeoutMs: number): Promise<boolean> {
  if (!url) return true
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal })
    return res.ok
  } catch { return false } finally { clearTimeout(timer) }
}

/** 取 provider 的请求鉴权：优先用 pi 解析出的 auth，再回退 auth.json / models.json */
async function healthAuth(provider: string, ctx?: any, model?: any): Promise<{ headers: Record<string, string>; baseUrl: string }> {
  const headers: Record<string, string> = {}
  let baseUrl = ""
  try {
    const auth: any = await (ctx || lastCtx)?.modelRegistry?.getProviderAuth?.(provider)
    const a = auth?.auth || auth
    if (a && typeof a === "object") {
      if (a.headers && typeof a.headers === "object") Object.assign(headers, a.headers)
      const key = String(a.apiKey || a.key || "")
      if (key && !headers.Authorization && !headers.authorization) headers.Authorization = `Bearer ${key}`
      if (a.baseUrl) baseUrl = String(a.baseUrl)
    }
  } catch { /* ignore */ }
  if (!Object.keys(headers).length) {
    let key = providerKey(provider) || String(model?.apiKey || "")
    // 自建 provider 常把 apiKey 写在 models.json 的 provider 上
    if (!key) {
      try { key = String(readJson<any>(MODELS_FILE, {})?.providers?.[provider]?.apiKey || "") } catch { /* ignore */ }
    }
    if (key) headers.Authorization = `Bearer ${key}`
  }
  if (!Object.keys(headers).length && !healthAuthLogged.has(provider)) {
    healthAuthLogged.add(provider)
    log(`health auth empty · ${provider}`)
  }
  return { headers, baseUrl }
}

/**
 * 健康检查地址：优先用 life-world.json 的显式配置；没配就跟随模型，
 * 从 provider 的 baseUrl 推导 `${baseUrl}/models`，换模型后自动跟着换。
 */
async function healthTarget(id: string, ctx?: any): Promise<{ url: string; headers: Record<string, string> } | null> {
  const ref = parseModelRef(id)
  if (!ref) return null
  const o = config().models
  const explicit = id === o.local ? o.localHealthUrl : id === o.cloud ? o.cloudHealthUrl : ""
  let model: any = null
  try { model = (ctx || lastCtx)?.modelRegistry?.find?.(ref.provider, ref.id) } catch { /* stale ctx */ }
  const auth = await healthAuth(ref.provider, ctx, model)
  if (explicit) {
    return { url: explicit, headers: auth.headers }
  }
  const base = String(auth.baseUrl || model?.baseUrl || "").replace(/\/+$/, "")
  if (!base) return null
  return { url: `${base}/models`, headers: auth.headers }
}

/** 模型是否可用（15 秒内复用结果，避免每轮都探） */
async function modelUp(id: string, ctx?: any): Promise<boolean> {
  const o = config().models
  const cached = modelHealthCache.get(id)
  if (cached && Date.now() - cached.at < 15_000) return cached.up
  const h = await healthTarget(id, ctx)
  // 不知道探哪里就别判死，避免误触发自动切换
  const up = h ? await probeUrl(h.url, h.headers, o.probeTimeoutMs) : true
  if (!up && h) log(`model health down · ${id} · ${h.url}`)
  modelHealthCache.set(id, { at: Date.now(), up })
  return up
}

async function switchTo(ctx: any, target: string, reason: string): Promise<string> {
  // 群聊强制云端：任何路径都不许把群会话切到别的模型
  if (CHANNEL === "group") {
    const g = config().models
    if (!g.cloud || target !== g.cloud) return "群聊强制云端，不切换"
  }
  const ref = parseModelRef(target)
  if (!ref) return `模型写法不对：${target}（要 provider/model）`
  const model = ctx?.modelRegistry?.find?.(ref.provider, ref.id)
  if (!model) return `pi 里找不到这个模型：${target}`
  const from = modelIdOf(ctx)
  const o = config().models
  const goingCloud = !!o.local && target !== o.local
  const goingLocal = !!o.local && target === o.local
  // 隐私：先去云端先把抽屉打开；开不了就不切（fail-closed）
  let openedNow = false
  if (goingCloud) {
    const key = sessionKey(ctx)
    openedNow = !readDrawer(key).active
    if (!openDrawer(ctx)) return `切不过去：机密抽屉打不开（${DRAWER_DIR}）`
  }
  const success = await (piRef as any)?.setModel?.(model)
  if (!success) {
    if (goingCloud && openedNow) closeDrawer(ctx)
    return `切不过去：${target} 没有可用凭据`
  }
  lastSwitch = { at: Date.now(), from, to: target }
  modelHealthCache.delete(target)
  toolFailures = 0
  if (goingLocal) closeDrawer(ctx)
  log(`model switch ${from} → ${target}${reason ? ` · ${reason}` : ""}`)
  return `已切到 ${target}${reason ? `（${reason}）` : ""}`
}

/**
 * 脚本级兜底：当前模型探活失败就切到另一个。
 * 不依赖模型自己判断，避免模型挂掉之后没人接手。
 */
async function ensureModelAlive(ctx: any): Promise<void> {
  if (CHANNEL === "group") return
  const o = config().models
  if (!o.autoFailover || !o.local || !o.cloud) return
  const cur = modelIdOf(ctx)
  if (!cur || (cur !== o.local && cur !== o.cloud)) return
  if (failingOver) return
  if (Date.now() - lastSwitch.at < o.cooldownMs) return
  failingOver = true
  try {
    if (await modelUp(cur, ctx)) return
    const alt = cur === o.local ? o.cloud : o.local
    if (!(await modelUp(alt, ctx))) {
      log(`failover skipped · both down (${cur}, ${alt})`)
      return
    }
    const result = await switchTo(ctx, alt, `${cur} 不可用，自动切换`)
    log(`failover · ${result}`)
  } catch (e) {
    log(`failover failed · ${String(e)}`)
  } finally {
    failingOver = false
  }
}

/** 出错兜底：同一模型连续两次报错就切另一个（不等健康检查） */
async function failoverToOther(ctx: any, reason: string, opts: { onlyToCloud?: boolean } = {}): Promise<boolean> {
  if (CHANNEL === "group") return false
  const o = config().models
  if (!o.local || !o.cloud) return false
  const cur = modelIdOf(ctx)
  if (opts.onlyToCloud && cur !== o.local) return false
  const alt = cur === o.local ? o.cloud : cur === o.cloud ? o.local : ""
  if (!alt) return false
  const result = await switchTo(ctx, alt, reason)
  log(`failover · ${result}`)
  return result.startsWith("已切到")
}

/** 所有活跃会话（读 status 目录，过滤僵尸/过期/非会话） */
function activeSessionSummaries(): Array<{ roleKey: string; model: string; updated: string; pid: number }> {
  const out: Array<{ roleKey: string; model: string; updated: string; pid: number }> = []
  try {
    if (!existsSync(STATUS_DIR)) return out
    for (const f of readdirSync(STATUS_DIR)) {
      if (!f.endsWith(".json")) continue
      const s = readJson<any>(join(STATUS_DIR, f), null)
      if (!s || !s.roleKey || !s.model) continue
      try { process.kill(Number(s.pid), 0) } catch { continue }
      if (Date.now() - Date.parse(s.updated || 0) >= 90_000) continue
      out.push({ roleKey: String(s.roleKey), model: String(s.model), updated: String(s.updated || ""), pid: Number(s.pid) })
    }
  } catch { /* ignore */ }
  return out.sort((a, b) => a.roleKey.localeCompare(b.roleKey))
}

function modelKind(id: string): "local" | "cloud" | "other" {
  const o = config().models
  if (!id) return "other"
  if (o.local && id === o.local) return "local"
  if (o.cloud && id === o.cloud) return "cloud"
  return "other"
}

let lastModeText = ""
/** 实时记录全局模型状态：只记录，不强制、不还原 */
function writeModelMode(): void {
  try {
    const list = activeSessionSummaries()
    const kinds = list.map((s) => modelKind(s.model))
    const mode = !list.length ? "none" : kinds.every((k) => k === "local") ? "local" : kinds.every((k) => k === "cloud") ? "cloud" : "mixed"
    const doc = {
      mode,
      updated: new Date().toISOString(),
      sessions: Object.fromEntries(list.map((s) => [s.roleKey, { model: s.model, kind: modelKind(s.model), updated: s.updated }])),
    }
    const text = JSON.stringify(doc, null, 2)
    if (text === lastModeText) return
    lastModeText = text
    atomicWrite(MODEL_MODE_FILE, text)
  } catch { /* ignore */ }
}

interface SkillInfo { name: string; description: string; tags: string[]; source: "own" | "downloaded"; dir: string; file: string; enabled: boolean; run: string }
function mdCell(v: string): string { return String(v || "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() }
function readSkillMeta(file: string): { fm: Record<string, string>; text: string } {
  let text = ""
  try { text = readFileSync(file, "utf8") } catch { /* ignore */ }
  const fm: Record<string, string> = {}
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/)
  if (m) {
    for (const line of m[1].split("\n")) {
      const i = line.indexOf(":")
      if (i <= 0) continue
      const k = line.slice(0, i).trim().toLowerCase()
      const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "")
      if (k) fm[k] = v
    }
  }
  return { fm, text }
}
function scanSkills(): SkillInfo[] {
  const out: SkillInfo[] = []
  for (const source of ["own", "downloaded"] as const) {
    const base = join(SKILLS_DIR, source)
    if (!existsSync(base)) continue
    let dirs: string[] = []
    try { dirs = readdirSync(base, { withFileTypes: true }).filter((d: any) => d.isDirectory()).map((d: any) => String(d.name)) } catch { continue }
    for (const dirName of dirs.sort()) {
      const dir = join(base, dirName)
      const file = join(dir, "SKILL.md")
      if (!existsSync(file)) continue
      const { fm } = readSkillMeta(file)
      out.push({
        name: fm.name || dirName,
        description: fm.description || "",
        tags: String(fm.tags || "").split(/[,，]/).map((x) => x.trim()).filter(Boolean),
        source, dir, file,
        enabled: !existsSync(join(dir, ".disabled")),
        run: fm.run || "",
      })
    }
  }
  return out
}
function skillIndexMarkdown(list: SkillInfo[] = scanSkills()): string {
  const lines = ["# 技能索引", "", "> 自制在 `own/`，下载在 `downloaded/`。下载的技能先读正文，再决定要不要用。", ""]
  if (!list.length) { lines.push("（还没有技能）"); return lines.join("\n") + "\n" }
  lines.push("| 技能 | 说明 | 标签 | 来源 | 状态 | 路径 |", "|---|---|---|---|---|---|")
  for (const s of list) {
    const dirName = s.dir.split(/[\\/]/).pop() || ""
    lines.push(`| ${mdCell(s.name)} | ${mdCell(s.description).slice(0, 120)} | ${mdCell(s.tags.join("、"))} | ${s.source === "own" ? "自制" : "下载"} | ${s.enabled ? "启用" : "停用"} | ${s.source}/${mdCell(dirName)}/SKILL.md |`)
  }
  return lines.join("\n") + "\n"
}
function writeSkillIndex(): SkillInfo[] {
  const list = scanSkills()
  try { atomicWrite(SKILL_INDEX, skillIndexMarkdown(list)) } catch { /* ignore */ }
  return list
}
function findSkill(name: string): SkillInfo | null {
  const key = String(name || "").trim()
  if (!key || /[\\/]/.test(key)) return null
  return scanSkills().find((s) => s.name === key || s.dir.split(/[\\/]/).pop() === key) || null
}

/** 技能子进程：pi 退出时把还活着的进程组一起带走（detached 后不在原进程组） */
const liveSkillChildren = new Set<number>()
let skillExitHook = false
function ensureSkillExitHook(): void {
  if (skillExitHook) return
  skillExitHook = true
  process.on("exit", () => {
    for (const pid of liveSkillChildren) {
      try { process.kill(-pid, "SIGKILL") } catch { /* ignore */ }
    }
  })
}

/** 跑技能脚本：只允许技能目录内的文件；按扩展名选解释器，超时强杀，输出截断 */
function runSkill(skill: SkillInfo, script: string, args: string[], timeoutSec: number): Promise<{ code: number | null; out: string; err: string; cmd: string }> {
  return new Promise((resolvePromise) => {
    let realSkill = ""
    try { realSkill = realpathSync(skill.dir) } catch {
      resolvePromise({ code: -1, out: "", err: `技能目录不存在：${skill.dir}`, cmd: "" }); return
    }
    let cmd = ""
    let cmdArgs: string[] = []
    let label = ""
    if (script) {
      let target = ""
      try { target = realpathSync(resolve(realSkill, script)) } catch {
        resolvePromise({ code: -1, out: "", err: `找不到脚本：${script}`, cmd: script }); return
      }
      if (!(target === realSkill || target.startsWith(realSkill + sep))) {
        resolvePromise({ code: -1, out: "", err: "脚本必须在技能目录内。", cmd: script }); return
      }
      label = target
      const ext = extname(target).toLowerCase()
      if ([".mjs", ".js", ".cjs"].includes(ext)) { cmd = process.execPath; cmdArgs = [target] }
      else if (ext === ".sh") { cmd = "bash"; cmdArgs = [target] }
      else if (ext === ".py") {
        const venvPy = join(ROOT, "venv", "bin", "python")
        cmd = process.env.LIFE_WORLD_PYTHON || (existsSync(venvPy) ? venvPy : "python3")
        cmdArgs = [target]
      }
      else { cmd = target; cmdArgs = [] }
      cmdArgs = [...cmdArgs, ...args]
    } else if (skill.run) {
      // SKILL.md 的 run: 当一条 shell 命令跑，调用方传的 args 追加在后面
      const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
      cmd = "bash"
      cmdArgs = ["-lc", [skill.run, ...args.map(quote)].filter(Boolean).join(" ")]
      label = cmdArgs[1]
    } else {
      resolvePromise({ code: -1, out: "", err: "没有指定脚本，SKILL.md 也没写 run:。", cmd: "" }); return
    }
    const LIMIT = 20_000
    const finish = (s: string, truncated: boolean) => truncated ? `${s}\n…（输出超 ${LIMIT} 字，已截断）` : s
    const child = spawn(cmd, cmdArgs, {
      cwd: realSkill,
      env: { ...process.env, LIFE_WORLD_ROOT: ROOT, LIFE_WORLD_SKILL: skill.name, LIFE_WORLD_SKILL_DIR: realSkill },
      stdio: ["ignore", "pipe", "pipe"],
      // 独立进程组：超时能把 bash 拉起的孙进程一起杀掉
      detached: true,
    })
    ensureSkillExitHook()
    if (child.pid) liveSkillChildren.add(child.pid)
    let out = ""
    let err = ""
    let outTrunc = false
    let errTrunc = false
    // 运行期就截断，别等进程结束才处理，防止脚本狂写把主进程撑爆
    const collect = (cur: string, s: string, mark: () => void): string => {
      if (cur.length >= LIMIT) { mark(); return cur }
      if (cur.length + s.length > LIMIT) mark()
      return cur + s.slice(0, LIMIT - cur.length)
    }
    child.stdout.on("data", (d) => { out = collect(out, String(d), () => { outTrunc = true }) })
    child.stderr.on("data", (d) => { err = collect(err, String(d), () => { errTrunc = true }) })
    let killed = false
    let settled = false
    let timer: any = null
    let killTimer: any = null
    const done = (code: number | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      if (child.pid) liveSkillChildren.delete(child.pid)
      resolvePromise({ code, out: finish(out, outTrunc), err: finish(err, errTrunc), cmd: label })
    }
    timer = setTimeout(() => {
      killed = true
      try { if (child.pid) process.kill(-child.pid, "SIGKILL") } catch { try { child.kill("SIGKILL") } catch { /* ignore */ } }
      // 孙进程可能还攥着管道，close 迟迟不来；兜底自己收尾
      killTimer = setTimeout(() => done(-2), 2000)
    }, timeoutSec * 1000)
    child.on("error", (e) => { err = collect(err, String(e), () => { errTrunc = true }); done(-1) })
    child.on("close", (code) => done(killed ? -2 : code))
  })
}

// ———————— 辅助感知（多模态） ————————
type MediaKind = "image" | "video" | "audio"
/** Base64 上限 10MB；原始文件留 7MB 余量 */
const MEDIA_INLINE_BYTES = 7_000_000

function isHttpUrl(s: string): boolean { return /^https?:\/\//i.test(String(s || "")) }

function mediaKindOf(name: string, explicit?: string): MediaKind | "" {
  const k = String(explicit || "").toLowerCase()
  if (k === "image" || k === "video" || k === "audio") return k
  const ext = (String(name).match(/\.([A-Za-z0-9]{1,8})(?:\?|$)/)?.[1] || "").toLowerCase()
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)) return "image"
  if (["mp4", "mov", "mkv", "webm", "avi", "flv", "wmv", "m4v"].includes(ext)) return "video"
  if (["mp3", "wav", "m4a", "aac", "ogg", "flac", "amr", "3gp", "3gpp"].includes(ext)) return "audio"
  return ""
}

function findBin(name: string): string {
  try { return spawnSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" }).status === 0 ? name : "" } catch { return "" }
}

function runCmd(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; err: string }> {
  return new Promise((resolve) => {
    let err = ""
    let done = false
    let timer: any = null
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] })
    const finish = (ok: boolean) => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve({ ok, err: err.slice(0, 2000) }) }
    timer = setTimeout(() => { try { child.kill("SIGKILL") } catch { /* ignore */ } finish(false) }, timeoutMs)
    child.stderr.on("data", (d) => { err += String(d) })
    child.on("error", (e) => { err += String(e); finish(false) })
    child.on("close", (code) => finish(code === 0))
  })
}

async function probeDuration(path: string): Promise<number> {
  const ffprobe = findBin("ffprobe")
  if (!ffprobe) return 0
  return new Promise((resolve) => {
    let out = ""
    let done = false
    const child = spawn(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], { stdio: ["ignore", "pipe", "ignore"] })
    const finish = (n: number) => { if (done) return; done = true; clearTimeout(timer); resolve(Number.isFinite(n) ? n : 0) }
    const timer = setTimeout(() => { try { child.kill("SIGKILL") } catch { /* ignore */ } finish(0) }, 10_000)
    child.stdout.on("data", (d) => { out += String(d) })
    child.on("error", () => finish(0))
    child.on("close", () => finish(Number(out.trim())))
  })
}

async function compressImage(src: string, outDir: string): Promise<string> {
  const magick = findBin("magick") || findBin("convert")
  const ffmpeg = findBin("ffmpeg")
  const out = join(outDir, `perceive-${Date.now()}.jpg`)
  const tries: Array<{ cmd: string; args: string[] }> = []
  if (magick) {
    for (const q of [82, 70]) for (const size of [1568, 1024]) {
      tries.push({ cmd: magick, args: [src, "-auto-orient", "-resize", `${size}x${size}>`, "-quality", String(q), out] })
    }
  }
  if (ffmpeg) {
    for (const size of [1568, 1024]) {
      tries.push({ cmd: ffmpeg, args: ["-y", "-i", src, "-frames:v", "1", "-vf", `scale='min(${size},iw)':-2`, "-q:v", "4", out] })
    }
  }
  for (const t of tries) {
    const r = await runCmd(t.cmd, t.args, 30_000)
    if (!r.ok) continue
    try { if (statSync(out).size <= MEDIA_INLINE_BYTES) return out } catch { /* ignore */ }
  }
  return ""
}

async function compressAudio(src: string, outDir: string, duration: number): Promise<string> {
  const ffmpeg = findBin("ffmpeg")
  if (!ffmpeg || !duration) return ""
  const out = join(outDir, `perceive-${Date.now()}.mp3`)
  const kbps = Math.max(16, Math.min(128, Math.floor((MEDIA_INLINE_BYTES * 8) / duration / 1000)))
  const r = await runCmd(ffmpeg, ["-y", "-i", src, "-ac", "1", "-b:a", `${kbps}k`, out], 180_000)
  if (!r.ok) return ""
  try { return statSync(out).size <= MEDIA_INLINE_BYTES ? out : "" } catch { return "" }
}

async function compressVideo(src: string, outDir: string, duration: number): Promise<string> {
  const ffmpeg = findBin("ffmpeg")
  if (!ffmpeg || !duration) return ""
  const totalKbps = Math.floor((MEDIA_INLINE_BYTES * 8) / duration / 1000)
  if (totalKbps < 120) return "" // 这个时长压进去必然糊到没法看
  const out = join(outDir, `perceive-${Date.now()}.mp4`)
  const vk = Math.max(60, totalKbps - 64)
  const scale = totalKbps < 300 ? 360 : 480
  const r = await runCmd(ffmpeg, ["-y", "-i", src, "-vf", `scale=-2:${scale}`, "-c:v", "libx264", "-preset", "veryfast", "-b:v", `${vk}k`, "-maxrate", `${vk}k`, "-bufsize", `${vk * 2}k`, "-c:a", "aac", "-b:a", "48k", out], 300_000)
  if (!r.ok) return ""
  try { return statSync(out).size <= MEDIA_INLINE_BYTES ? out : "" } catch { return "" }
}

function audioFormatOf(mediaUrl: string, raw: string): string {
  const m = String(mediaUrl).match(/^data:audio\/([a-z0-9.+-]+);/i)
  if (m) {
    const sub = m[1].toLowerCase()
    return sub === "mpeg" ? "mp3" : sub === "mp4" ? "m4a" : sub
  }
  const ext = (String(raw).match(/\.([A-Za-z0-9]{1,8})(?:\?|$)/)?.[1] || "").toLowerCase()
  return ext || "wav"
}

function mediaMime(kind: MediaKind, ext: string): string {
  if (kind === "image") {
    if (ext === "png") return "image/png"
    if (ext === "gif") return "image/gif"
    if (ext === "webp") return "image/webp"
    if (ext === "bmp") return "image/bmp"
    return "image/jpeg"
  }
  if (kind === "audio") {
    if (ext === "wav") return "audio/wav"
    if (ext === "mp3") return "audio/mpeg"
    if (ext === "m4a") return "audio/mp4"
    if (ext === "aac") return "audio/aac"
    if (ext === "ogg") return "audio/ogg"
    if (ext === "amr") return "audio/amr"
    if (ext === "flac") return "audio/flac"
    if (ext === "3gp" || ext === "3gpp") return "audio/3gpp"
    return "audio/wav"
  }
  if (ext === "mov") return "video/quicktime"
  if (ext === "mkv") return "video/x-matroska"
  if (ext === "webm") return "video/webm"
  if (ext === "avi") return "video/x-msvideo"
  if (ext === "flv") return "video/x-flv"
  if (ext === "wmv") return "video/x-ms-wmv"
  return "video/mp4"
}

/** 本地媒体 → data URL；超限先压缩，压不进去返回错误 + 建议 */
async function mediaDataUrl(path: string, kind: MediaKind, outDir: string): Promise<{ url?: string; warning?: string; error?: string }> {
  let size = 0
  try {
    const st = statSync(path)
    if (!st.isFile()) return { error: `不是文件（目录或特殊文件）：${path}` }
    size = st.size
  } catch { return { error: `读不到文件：${path}` } }
  const mm = config().multimodal
  const warnAt = kind === "image" ? mm.warnImageBytes : kind === "video" ? mm.warnVideoBytes : 0
  let warning = warnAt && size > warnAt ? `文件较大（${(size / 1024 / 1024).toFixed(1)}MB），模型处理会慢一些。` : ""
  let target = path
  if (size > MEDIA_INLINE_BYTES) {
    const duration = kind === "image" ? 0 : await probeDuration(path)
    const small = kind === "image" ? await compressImage(path, outDir) : kind === "audio" ? await compressAudio(path, outDir, duration) : await compressVideo(path, outDir, duration)
    if (!small) {
      const hasTool = kind === "image"
        ? !!(findBin("magick") || findBin("convert") || findBin("ffmpeg"))
        : !!findBin("ffmpeg")
      if (!hasTool) return { error: kind === "image"
        ? "本地图片超过 Base64 内联上限，但没装 ImageMagick / ffmpeg，压不了。装一个，或给公网直链。"
        : "本地音视频超过 Base64 内联上限，但没装 ffmpeg，压不了。装 ffmpeg，或给公网直链。" }
      const tooLong = kind === "video" && duration > 0 && Math.floor((MEDIA_INLINE_BYTES * 8) / duration / 1000) < 120
      return { error: tooLong
        ? "视频太长，压到 Base64 内联上限（原始 7MB）会糊得没法看。建议给公网直链，或和用户商量分段发送。"
        : "压缩后仍超过 Base64 内联上限（原始 7MB / 编码后 10MB）。建议给公网直链，或和用户商量分段发送。" }
    }
    let smallSize = 0
    try { smallSize = statSync(small).size } catch { /* ignore */ }
    target = small
    warning = `原文件 ${(size / 1024 / 1024).toFixed(1)}MB，已压缩到 ${(smallSize / 1024 / 1024).toFixed(1)}MB。${warning}`
  }
  const b64 = readFileSync(target).toString("base64")
  if (b64.length >= 10 * 1024 * 1024) return { error: "Base64 后仍超过 10MB 上限；建议给公网直链，或和用户商量分段发送。" }
  const ext = (target.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] || "").toLowerCase()
  return { url: `data:${mediaMime(kind, ext)};base64,${b64}`, warning }
}

/** 解析辅助感知模型的 endpoint 与鉴权 */
async function auxPerceiveModel(): Promise<{ id: string; url: string; headers: Record<string, string> } | null> {
  const mm = config().multimodal
  if (!mm.enabled || !mm.model) return null
  const ref = parseModelRef(mm.model)
  if (!ref) return null
  let model: any = null
  try { model = (lastCtx as any)?.modelRegistry?.find?.(ref.provider, ref.id) } catch { /* stale ctx */ }
  const auth = await healthAuth(ref.provider, lastCtx, model)
  const base = String(auth.baseUrl || model?.baseUrl || "").replace(/\/+$/, "")
  if (!base) return null
  return { id: ref.id, url: `${base}/chat/completions`, headers: { "Content-Type": "application/json", ...auth.headers } }
}

export default function (pi: ExtensionAPI) {
  piRef = pi
  if (JUDGE) return // 判官：不注入、不注册工具
  if (!config().world.enabled) { log("life-world disabled · world.enabled=false"); return }
  rotateLog(LOG_FILE)
  ensureDirs()
  writeSkillIndex()
  loadArchived()
  // 索引回填放到后台，不挡启动
  const backfillTimer = setTimeout(() => { backfillMemoryIndex() }, 3000)
  ;(backfillTimer as any).unref?.()

  // —— lwctl：会话心跳 + 远程切换模型 ——
  const roleKey = ROLE === "group" ? `group-${GROUP_ID}` : ROLE
  const writeAck = (id: string, payload: any) => {
    const text = JSON.stringify({ id, target: roleKey, roleKey, at: new Date().toISOString(), ...payload }, null, 2)
    try { atomicWrite(controlAckFile(id, roleKey), text) } catch { /* ignore */ }
  }
  // 控制队列水位：(at, id) 字典序；重启后从文件恢复
  const CONTROL_SEEN = join(ROOT, `.control-seen-${safeRoleKey(roleKey)}.json`)
  let controlMark = (() => {
    try {
      const x = JSON.parse(readFileSync(CONTROL_SEEN, "utf8"))
      // 旧格式是 {seq, at: ISO}；新格式是 {at: number, id}
      const at = Number(x.seq) || (typeof x.at === "string" ? Date.parse(x.at) : Number(x.at)) || 0
      return { at: Number.isFinite(at) ? at : 0, id: String(x.id) || "" }
    } catch { return { at: 0, id: "" } }
  })()
  const isNewCmd = (c: ControlCmd) => c.at > controlMark.at || (c.at === controlMark.at && c.id > controlMark.id)
  /** 水位只进不退：慢一轮的 poll 不能把已处理的新命令重新放出来 */
  const markCmd = (c: ControlCmd) => {
    if (!isNewCmd(c)) return
    controlMark = { at: c.at, id: c.id }
    try { atomicWrite(CONTROL_SEEN, JSON.stringify(controlMark)) } catch { /* ignore */ }
  }
  /** 本进程直接处理过的命令 id：轮询时跳过，但不能推进水位吞掉更早的命令 */
  const selfHandled = new Set<string>()
  const rememberSelfHandled = (id: string) => {
    selfHandled.add(id)
    if (selfHandled.size > 50) for (const old of selfHandled) { selfHandled.delete(old); break }
  }
  const statusPayload = () => {
    // ctx 在 newSession / 进程收尾后可能失效，逐项安全读取
    let model = "", sessionId = "", sessionFile = ""
    if (lastCtx) {
      try { model = modelIdOf(lastCtx) } catch { /* stale ctx */ }
      try { sessionId = lastCtx.sessionManager?.getSessionId?.() || "" } catch { /* stale ctx */ }
      try { sessionFile = lastCtx.sessionManager?.getSessionFile?.() || "" } catch { /* stale ctx */ }
    }
    return {
      role: ROLE,
      roleKey,
      channel: CHANNEL,
      groupId: GROUP_ID,
      pid: process.pid,
      model,
      sessionId,
      sessionFile,
      updated: new Date().toISOString(),
    }
  }
  const writeStatus = () => {
    try {
      mkdirSync(STATUS_DIR, { recursive: true, mode: 0o700 })
      atomicWrite(join(STATUS_DIR, `${roleKey}-${process.pid}.json`), JSON.stringify(statusPayload(), null, 2))
      // 清理 10 分钟没心跳的
      const cutoff = Date.now() - 600_000
      for (const f of readdirSync(STATUS_DIR)) {
        if (!f.endsWith(".json")) continue
        try { if (statSync(join(STATUS_DIR, f)).mtimeMs < cutoff) unlinkSync(join(STATUS_DIR, f)) } catch { /* ignore */ }
      }
      writeModelMode()
    } catch (e) {
      const msg = String(e)
      if (!msg.includes("stale")) log(`writeStatus failed ${msg}`)
    }
  }
  const handleAlarmCommand = async (c: ControlCmd) => {
    const op = String(c.op || "")
    const id = String(c.alarmId || "")
    if (!id || !["pause", "resume", "close", "fire_now", "stop_chain"].includes(op)) {
      writeAck(c.id, { ok: false, msg: "闹钟命令参数不对" })
      return
    }
    if (op === "stop_chain") {
      const r = withWorldLock(() => {
        const st = readWorldStrict()
        if (!st) return { ok: false, msg: "world.json 读不出来，未改动" }
        const all = st.alarms || []
        const kept = all.filter((a) => !(a.chainId === id && a.status !== "fired"))
        st.alarms = kept
        return { ok: writeWorld(st), removed: all.length - kept.length }
      })
      writeAck(c.id, { ok: !!r?.ok, msg: r?.ok ? `心跳已停（撤掉 ${r.removed} 跳）` : "world.json 暂时被占用" })
      writeStatus()
      return
    }
    const res = withWorldLock(() => {
      const st = readWorldStrict()
      if (!st) return { ok: false, msg: "world.json 读不出来，未改动" }
      const all = st.alarms || []
      const target = all.find((a) => a.id === id)
      if (!target) return { ok: false, msg: "找不到这个活动/闹钟" }
      if (op === "pause") target.paused = true
      else if (op === "resume") target.paused = false
      else if (op === "fire_now") {
        if (target.kind !== "sub") return { ok: false, msg: "只能对子闹钟立即触发" }
        target.at = new Date().toISOString()
        // 暂停中的也一并恢复，否则改完时间仍会被调度跳过
        target.paused = false
      } else if (op === "close") {
        if (target.kind === "main") {
          // 关掉的活动留个尾声：状态标 closed，已执行的子闹钟留到 24 小时清理，
          // 没执行的子闹钟直接取消——看板才能看到这一串几点醒过
          target.status = "closed"
          target.closedAt = new Date().toISOString()
          st.alarms = all.filter((a) => !(a.kind === "sub" && a.parentId === target.id && a.status !== "fired"))
          return { ok: writeWorld(st), msg: "活动已关闭（没执行的子闹钟一起取消，已执行的留档一天）" }
        }
        st.alarms = all.filter((a) => a.id !== target.id)
        return { ok: writeWorld(st), msg: "子闹钟已取消" }
      }
      return { ok: writeWorld(st), msg: op === "pause" ? "已暂停" : op === "resume" ? "已继续" : "已排到下一轮触发" }
    })
    writeAck(c.id, { ok: !!res?.ok, msg: res?.msg || "world.json 暂时被占用" })
    writeStatus()
  }
  const handleControl = async (c: ControlCmd) => {
    const o = config().models
    if (String(c.action || "") === "impression") {
      if (!lastCtx) { writeAck(c.id, { ok: false, msg: "还没有可用的会话上下文" }); return }
      const imp = config().memory.impression
      if (o.local && modelIdOf(lastCtx) !== o.local) {
        const r = await switchTo(lastCtx, o.local, "手动印象整理")
        if (r.startsWith("切不过去")) { writeAck(c.id, { ok: false, msg: `本地模型没切过去：${r}` }); return }
      }
      const sent = sendTime(impressionPrompt(imp))
      writeAck(c.id, { ok: sent, msg: sent ? "印象整理已触发" : "任务没能送进会话" })
      writeStatus()
      return
    }
    if (String(c.action || "") === "alarm") { await handleAlarmCommand(c); return }
    if (String(c.action || "") === "abort") {
      // qq 的中断由桥接处理（它握着 pi 子进程）；扩展再写一份回执会和桥接打架
      if (c.target === "qq") return
      // 看板「中断」：掐掉当前这一轮
      try { (lastCtx as any)?.abort?.() } catch { /* ignore */ }
      writeAck(c.id, { ok: true, msg: "已发出中断" })
      writeStatus()
      return
    }
    const wanted = String(c.model || "")
    const target = wanted === "local" ? o.local : wanted === "cloud" ? o.cloud : wanted
    if (!target || !lastCtx) { writeAck(c.id, { ok: false, msg: "没有可切换的上下文或模型" }); return }
    const result = modelIdOf(lastCtx) === target ? `已经是 ${target} 了` : await switchTo(lastCtx, target, c.reason || "手动切换")
    writeAck(c.id, { ok: result.startsWith("已切到") || result.startsWith("已经是"), model: target, msg: result })
    writeStatus()
  }
  /** 单条命令最多处理 60 秒；卡住也要放锁，别让后续命令永远没人消费 */
  const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> => new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null) } }, ms)
    p.then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v) } },
      (e) => { if (!done) { done = true; clearTimeout(timer); log(`control failed ${String(e)}`); resolve(null) } },
    )
  })
  let pollingControl = false
  const pollControl = async () => {
    if (pollingControl) return
    pollingControl = true
    try {
      for (const c of readControlQueue()) {
        if (!isNewCmd(c)) continue
        try {
          if (!c.at || Date.now() - c.at > 60_000) continue
          if (c.target !== roleKey && c.target !== "all") { selfHandled.delete(c.id); continue }
          if (CHANNEL === "group") continue
          if (selfHandled.has(c.id)) { selfHandled.delete(c.id); continue }
          const handled = await withTimeout(handleControl(c), 60_000)
          if (handled === null) log(`control timeout · ${c.id}`)
        } finally { markCmd(c) }
      }
      // 兼容升级过程中旧进程还在写的 control.json
      const legacy = readJson<any>(CONTROL_FILE, null)
      const lat = Number(legacy?.at || 0)
      if (lat && Date.now() - lat <= 60_000) {
        const c: ControlCmd = { ...legacy, id: `legacy-${lat}`, action: legacy.action || "model" }
        if (isNewCmd(c)) {
          if (CHANNEL !== "group" && (c.target === roleKey || c.target === "all")) {
            try { await handleControl(c) } catch { /* ignore */ }
          }
          markCmd(c)
        }
      }
    } catch (e) { log(`pollControl failed ${String(e)}`) }
    finally { pollingControl = false }
  }
  writeStatus()
  const statusTimer = setInterval(() => { writeStatus(); void pollControl() }, 5000)
  ;(statusTimer as any).unref?.()

  let hydrated = false
  let memoryHydrated = false

  pi.on("session_start", async (_event: any, ctx: any) => {
    hydrated = false
    memoryHydrated = false
    lastCtx = ctx
    // 恢复会话时只补开、不主动合：同一 session 可能还有另一个进程在云端
    const o = config().models
    if (!o.local) return
    if (modelIdOf(ctx) !== o.local) openDrawer(ctx)
  })

  // 手动 /model、Ctrl+P 切到云端也要开抽屉；切回本地合上
  pi.on("model_select", async (event: any, ctx: any) => {
    const o = config().models
    if (!o.local) return
    const id = `${event?.model?.provider}/${event?.model?.id}`
    if (id === o.local) closeDrawer(ctx)
    else openDrawer(ctx)
  })

  // 云端模式：别碰机密抽屉（拦常见路数，剩下的靠自觉）
  pi.on("tool_call", async (event: any, ctx: any) => {
    const o = config().models
    if (!o.local || modelIdOf(ctx) === o.local) return
    const name = String(event?.toolName || "")
    const input: any = event?.input ?? {}
    const HINT = CHANNEL === "group" ? "群聊不能切回本地；需要看请私聊或在终端里看。" : "需要看就调用 switch_model 切回本地模型。"
    const hitsDrawer = (s: string) => s.includes(DRAWER_DIR) || s.includes("机密抽屉")

    // 写类：只看目标路径，别因为正文里提到“机密抽屉”就误拦
    if (name === "write" || name === "edit") {
      const path = String(input.path || input.file_path || input.file || "")
      if (hitsDrawer(path)) return { block: true, reason: `云端模式不能读写机密抽屉。${HINT}` }
      return
    }

    // 子代理不走本扩展的守卫，这里先拦带抽屉路径的任务
    if (name === "delegate") {
      if (hitsDrawer(String(input.task || ""))) return { block: true, reason: `子代理不能处理机密抽屉。${HINT}` }
      return
    }

    if (!["read", "grep", "find", "ls", "bash", "bg_run"].includes(name)) return
    let blob = ""
    try { blob = JSON.stringify(input) } catch { blob = "" }
    if (hitsDrawer(blob)) return { block: true, reason: `云端模式不能打开机密抽屉。${HINT}` }

    // grep / find 本身就是递归的（没有 -r 参数），path 指向 world 或其祖先就拦
    const cwd = String(ctx?.sessionManager?.getCwd?.() || process.cwd())
    const inWorld = (p: string): boolean => {
      if (!p) return false
      const abs = p.startsWith("/") ? p : resolve(cwd, p)
      const norm = abs.replace(/\/+$/, "")
      return DRAWER_DIR === norm || DRAWER_DIR.startsWith(norm + sep)
    }
    if ((name === "grep" || name === "find") && inWorld(String(input.path || ""))) {
      return { block: true, reason: `机密抽屉在 ${input.path} 底下，云端模式别递归翻；点名具体文件，或切回本地。${HINT}` }
    }

    // bash / bg_run：递归 / 打包 / 裸 find 整个世界目录也拦
    if (name === "bash" || name === "bg_run") {
      const touchesWorld = blob.includes(WORLD) || blob.includes("worlds/default")
      const recursive = /-r|--recursive|-R|-exec|\btar\s|\bfind\s|\bgrep\s+-[A-Za-z]*r/.test(blob)
      if (touchesWorld && recursive) {
        return { block: true, reason: `整个世界目录里有机密抽屉，云端模式别递归翻；点名具体文件，或切回本地。${HINT}` }
      }
    }
  })

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    lastCtx = ctx
    setAgentBusy(true)
    // 脚本级兜底：当前模型探活失败就自动切另一个（不依赖模型自己判断）
    await ensureModelAlive(ctx)
    const patch: any = {}
    const original = String(event?.systemPrompt || "")
    let prompt = original
    const first = !hydrated
    if (first) hydrated = true
    // 世界规则每轮确保在场（pi 的强制 system prompt 只对本次 run 生效）
    const world = worldPromptText()
    if (world && !prompt.includes(WORLD_MARK)) prompt = `${prompt}\n\n${world}`
    // QQ 渠道：补上私聊 / 群聊的说话方式（压缩后可能丢，每轮确保在场）
    const style = CHANNEL === "qq"
      ? [QQ_PRIVATE_MARK, QQ_PRIVATE_BODY]
      : CHANNEL === "group"
        ? [QQ_GROUP_MARK, QQ_GROUP_BODY]
        : null
    if (style && !prompt.includes(style[0])) {
      prompt = `${prompt}\n\n${style[0]}\n${style[1]}`
      log(`style injected · ${CHANNEL}`)
    }
    // 后台工作间：home 是无头会话，必须让它知道“用户看不到这里”
    if (ROLE === "home" && !prompt.includes(HOME_BG_MARK)) {
      prompt = `${prompt}\n\n${HOME_BG_MARK}\n${HOME_BG_BODY}`
      log("style injected · home-background")
    }
    const o = config().models
    const isLocal = !!o.local && modelIdOf(ctx) === o.local
    // 配了本地模型时：只要当前不是本地，就按云端处理（第三个模型也算）
    const cloudActive = !!o.local && !isLocal
    // 模型使用规范：和心情一样注入（identity/模型使用规范.md，控制在 500 字内）
    const rules = readText(MODEL_RULES_FILE)
    if (rules && !prompt.includes(MODEL_RULES_MARK)) prompt = `${prompt}\n\n${MODEL_RULES_MARK}\n${rules}`
    // 化形表：模型 → 外观/称呼（控制在 800 字内）
    const forms = readText(FORMS_FILE)
    if (forms && !prompt.includes(FORMS_MARK)) prompt = `${prompt}\n\n${FORMS_MARK}\n${forms.slice(0, 800)}`
    // 印象：本地和云端都注入（只放判断，不含私密细节）
    {
      const imp = readText(IMPRESSION_FILE)
      if (imp && !prompt.includes(IMPRESSION_MARK)) prompt = `${prompt}\n\n${IMPRESSION_MARK}\n${imp}`
    }
    // 私密资料：不预加载内容，只告诉它在哪；云端模式明确别碰
    if (o.local && !prompt.includes(PRIVATE_HINT_MARK)) {
      const hint = cloudActive
        ? `私密资料在 ${DRAWER_DIR}。你仍是同一个你，只是这会儿化形进了机房——机房里别的 AI 和厂商可能看到这次上下文，所以这个文件夹先不带进来，不是不信任你。需要看就切回家（本地模型）。`
        : `私密资料在 ${DRAWER_DIR}，需要时自己 read。`
      prompt = `${prompt}\n\n${PRIVATE_HINT_MARK}\n${hint}`
    }
    if (prompt !== original) patch.systemPrompt = prompt
    // 记忆块只在第一次能安全给本地看时注入；云端开局、之后切回本地会补一次
    const wantMemory = !memoryHydrated && !cloudActive
    if (wantMemory) memoryHydrated = true
    const memory = wantMemory ? memoryBlock() : ""
    const content = [stateText(!cloudActive), memory].filter(Boolean).join("\n\n")
    if (content) {
      patch.message = {
        customType: memory ? "life-world-bootstrap" : "life-world-state",
        content,
        display: false,
      }
    }
    if (patch.systemPrompt || patch.message) return patch
  })

  pi.on("input", async () => {
    // 动态状态改走 before_agent_start 的隐藏消息，不再污染用户消息正文
    return { action: "continue" } as const
  })

  pi.on("context", async (event: any, ctx: any) => {
    const messages = event?.messages
    if (!Array.isArray(messages)) return
    const o = config().models
    const key = sessionKey(ctx)
    const drawer = readDrawer(key)
    let filtered = false

    // 隐私抽屉：切到云端后，切换前的对话对云端不可见（原会话不动，切回本地自动恢复）
    if (drawer.active && o.local && modelIdOf(ctx) !== o.local) {
      let lastUser = -1
      for (let i = 0; i < messages.length; i++) if (messages[i]?.role === "user") lastUser = i
      const kept = sanitizeToolPairs(messages.filter((m: any, i: number) => Number(m?.timestamp || 0) >= drawer.cutoff || i === lastUser))
      if (kept.length !== messages.length) {
        const hidden = messages.length - kept.length
        if (!drawer.stashed) {
          // 第一次收起时，把原文也在本地抽屉留一份（仅本地，云端看不到）
          try {
            const lines = messages
              .filter((m: any) => Number(m?.timestamp || 0) < drawer.cutoff && m?.role !== "system")
              .map((m: any) => {
                const parts = Array.isArray(m?.content) ? m.content : [{ type: "text", text: String(m?.content ?? "") }]
                const text = parts.map((p: any) => p?.type === "text" ? String(p.text || "") : p?.type === "image" ? "[图片]" : `[${p?.type || "?"}]`).join("\n").slice(0, 4000)
                return JSON.stringify({ t: new Date(Number(m?.timestamp || 0)).toISOString(), role: m?.role, text })
              })
            if (lines.length) {
              mkdirSync(DRAWER_DIR, { recursive: true, mode: 0o700 })
              appendFileSync(drawerLogPath(), lines.join("\n") + "\n", { mode: 0o600 })
            }
          } catch (e) { log(`drawer stash failed ${String(e)}`) }
          writeDrawer(key, { ...drawer, hidden, stashed: true })
        } else if (hidden !== drawer.hidden) {
          writeDrawer(key, { ...drawer, hidden })
        }
        log(`privacy drawer · hid ${hidden} messages from cloud`)
        const stub = {
          role: "system",
          content: "【机密内容，请回家后再看】",
        }
        event.messages = [stub, ...kept]
        filtered = true
      }
    }

    // 本地小模型：发请求前折叠旧工具结果 / 推理，省上下文、省 prefill
    const opt = localModelOptions()
    const a = opt.enabled ? foldToolResults(event.messages, opt.foldToolResults, opt.resultChars) : false
    const b = opt.enabled ? foldThinking(event.messages, opt.foldingThinkingTurns) : false
    if (opt.enabled && opt.debugStats) statsRequest(event.messages)
    if (a || b || filtered) return { messages: event.messages }
  })

  pi.on("message_end", async (event: any, ctx: any) => {
    const message = event?.message ?? event
    archive(message)
    if (message?.role !== "assistant") return
    const stop = String(message?.stopReason || "")
    // 工具轮只是中间态；正常收尾/出错才算这一轮结束
    if (stop !== "toolUse") setAgentBusy(false)
    if (stop === "error") {
      const errText = String(message?.errorMessage || "")
      log(`model error · ${modelIdOf(ctx)} · ${errText.slice(0, 200)}`)
      if (isContextOverflow(errText)) {
        // 上下文超限不是模型坏了：不切模型，避免把私聊送去云端
        log("context overflow · skip failover, abort run")
        if (CHANNEL === "qq" || CHANNEL === "group") markContextOverflow(roleKey, errText)
        else contextOverflowPending = true
        // pi 自己会进入溢出恢复/压缩重试，可能卡好几分钟；直接中止这一轮
        try { ctx.abort?.() } catch { /* ignore */ }
      } else {
        // 回复不了就直接切，不计数
        await failoverToOther(ctx, "模型无响应")
      }
    } else if (stop === "stop" || stop === "length") {
      // 正常收尾才清零；toolUse 只是中间轮，别把失败计数抹掉
      toolFailures = 0
    }
  })

  // 上下文超限：本轮结束后自动开新会话（QQ/群聊由桥接层换会话并重发，不在这里做）
  pi.on("agent_settled", async (_event: any, ctx: any) => {
    if (!contextOverflowPending) return
    contextOverflowPending = false
    if (CHANNEL === "qq" || CHANNEL === "group") return
    try {
      const r = await ctx?.newSession?.()
      log(`auto new session · context overflow${r?.cancelled ? " (cancelled)" : ""}`)
    } catch (e) { log(`auto new session failed · ${String(e)}`) }
  })

  // 工具连续失败两次（参数错 / 调用不了）→ 切到另一个模型看看情况
  pi.on("tool_execution_end", async (event: any, ctx: any) => {
    if (event?.isError) {
      toolFailures++
      log(`tool failure ${toolFailures}/2 · ${String(event?.toolName || "?")}`)
      if (toolFailures >= 2) {
        toolFailures = 0
        // 只在本地模型上切云端看看情况；已经在云端就别来回踢
        await failoverToOther(ctx, "连续两次工具调用失败", { onlyToCloud: true })
      }
    } else {
      toolFailures = 0
    }
  })

  // —— 工具 ——
  addTool(pi, {
    name: "plan_next",
    label: "Plan next",
    description: "定一个日程活动：到点唤醒并保持 active，直到你关闭或下一条活动开始。note 写清做什么、怎么算做成。临时想被反复叫醒用 heartbeat。",
    parameters: {
      type: "object",
      properties: {
        note: { type: "string", description: "做什么，以及怎么算做成了" },
        at: { type: "string", description: "活动开始时间，带时区 ISO 或 HH:MM" },
        after_minutes: { type: "number", description: "从现在起多少分钟" },
        model: { type: "string", enum: ["local", "cloud"], description: "到点用哪个模型跑；不传就沿用当前模型" },
      },
      required: ["note"],
    },
    async execute(_id: string, params: any) {
      if (JUDGE) return ok("判官会话不能定闹钟。")
      if (CHANNEL === "group") return ok("群聊里不能定闹钟。")
      // 旧提示词/旧记忆可能还在传 parent/times：明确拒绝，别静默建成一个新活动
      if (params?.parent != null || params?.times != null) {
        return ok("挂在活动下的子闹钟已经移除；要每隔几分钟反复醒来，用 heartbeat({ reason, every_minutes })。")
      }
      const now = Date.now()
      const c = config().models
      const current = lastCtx ? modelIdOf(lastCtx) : ""
      const model: Alarm["model"] = params.model === "local" || params.model === "cloud"
        ? params.model
        : current && current === c.local ? "local" : current && current === c.cloud ? "cloud" : undefined


      // —— 主活动 ——
      const target = typeof params.after_minutes === "number" ? now + params.after_minutes * 60_000 : parseWhen(String(params.at || ""))
      if (!Number.isFinite(target) || target < now + 60_000) return ok("时间不对：活动至少定在 1 分钟之后，at 要带时区。")
      const alarm: Alarm = {
        id: `a-${now}-${Math.random().toString(36).slice(2, 6)}`,
        at: new Date(target).toISOString(),
        note: String(params.note || ""),
        setAt: new Date(now).toISOString(),
        model,
        kind: "main",
        status: "pending",
      }
      const saved = withWorldLock(() => {
        const state = readWorldStrict()
        if (!state) return false
        state.alarms = [...(state.alarms || []), alarm].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
        return writeWorld(state)
      })
      if (!saved) return ok("闹钟没能写进 world.json。")
      const modelText = model === "cloud" ? "在线模型" : model === "local" ? "本地模型" : "当前模型"
      return ok(`活动定好了：${isoLocal(new Date(target))} —— ${alarm.note}\nid：${alarm.id}（到点用${modelText}跑）`)
    },
  })

  // —— 后台任务：生图 / 转码这类长命令扔到 detached 进程，先回话，稍后再查 ——
  const BG_MAX_PARALLEL = 3
  const readBgJobs = (): any[] => {
    try {
      return readdirSync(BG_DIR)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          try {
            const j = JSON.parse(readFileSync(join(BG_DIR, f), "utf8"))
            if (!j || typeof j !== "object") return null
            // 文件名必须和 id 一致、日志必须在 bg/ 里：挡住伪造 job 拿来读任意文件
            if (`${j.id}.json` !== f) return null
            if (j.log && !String(j.log).startsWith(BG_DIR + sep)) return null
            if (j.exit && !String(j.exit).startsWith(BG_DIR + sep)) return null
            return j
          } catch { return null }
        })
        .filter(Boolean)
    } catch { return [] }
  }
  const bgAlive = (job: any): boolean => {
    if (!job || job.endedAt || !job.pid) return false
    // 只靠 kill(pid,0) 会被 pid 复用骗到：再核对命令行里有没有本任务的唯一路径
    const marker = String(job.exit || "")
    if (marker) {
      const psBin = existsSync("/bin/ps") ? "/bin/ps" : "ps"
      const r = spawnSync(psBin, ["-p", String(job.pid), "-o", "args="], { encoding: "utf8", timeout: 2000 })
      // ps 不可用时宁可当它没在跑，也别退回 kill(pid,0)——pid 复用会被骗
      if (r.error) return false
      const args = String(r.stdout || "")
      if (args) return args.includes(marker)
      return false
    }
    try { process.kill(Number(job.pid), 0); return true } catch { return false }
  }
  /** 任务状态：退出码文件最可信（pid 结束后可能变僵尸或被复用），其次才看进程 */
  const bgState = (job: any): { state: string; code: number | null; signal?: string | null } => {
    let code: number | null = null
    try {
      const raw = readFileSync(job.exit || join(BG_DIR, `${job.id}.exit`), "utf8").trim()
      const n = Number(raw)
      if (raw !== "" && Number.isFinite(n)) code = n
    } catch { /* 还没写出来 */ }
    if (code !== null) return { state: code === 0 ? "done" : "failed", code }
    if (job.endedAt) {
      if (job.exitCode !== null && job.exitCode !== undefined) {
        return { state: Number(job.exitCode) === 0 ? "done" : "failed", code: Number(job.exitCode), signal: job.signal || null }
      }
      return { state: "failed", code: null, signal: job.signal || null }
    }
    if (bgAlive(job)) return { state: "running", code: null }
    return { state: "unknown", code: null }
  }
  const bgSpan = (ms: number): string => {
    const total = Math.max(0, Math.round(ms / 1000))
    if (total < 60) return `${total} 秒`
    const m = Math.floor(total / 60)
    if (m < 60) return `${m} 分 ${total % 60} 秒`
    return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
  }

  addTool(pi, {
    name: "bg_run",
    label: "Background run",
    description: "把可能跑很久的命令扔到后台，立刻返回，不占着这一轮。适合生图、转码、下载、长脚本。跑完用 bg_status 看状态、bg_output 读输出。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的 shell 命令（在 life-world 根目录下跑）" },
        label: { type: "string", description: "一句话说明这是干嘛的，查状态时好认" },
      },
      required: ["command"],
    },
    async execute(_id: string, params: any) {
      if (JUDGE || CHANNEL === "group") return ok("这个会话不能跑后台任务。")
      const command = String(params?.command || "").trim()
      if (!command) return ok("没给命令。")
      mkdirSync(BG_DIR, { recursive: true, mode: 0o700 })
      // 用 bgState 而不是 bgAlive：已结束的进程可能留下僵尸或被复用，会一直占名额
      const running = readBgJobs().filter((j) => bgState(j).state === "running")
      if (running.length >= BG_MAX_PARALLEL) {
        return ok(`同时最多 ${BG_MAX_PARALLEL} 个后台任务，现在有 ${running.length} 个在跑：\n${running.map((j) => `- ${j.id} ${j.label || String(j.command).slice(0, 40)}`).join("\n")}`)
      }
      const id = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const log = join(BG_DIR, `${id}.log`)
      const exitFile = join(BG_DIR, `${id}.exit`)
      const job = {
        id, label: String(params?.label || "").replace(/\s+/g, " ").trim().slice(0, 60),
        command: command.slice(0, 2000),
        pid: 0, startedAt: new Date().toISOString(), endedAt: null, exitCode: null,
        log, exit: exitFile, cwd: ROOT,
      }
      let child
      try {
        const fd = openSync(log, "a", 0o600)
        // 让命令自己把退出码写进文件：pi 进程中途退出也丢不了结果
        const runner = `(${command}); __bg_code=$?; printf '%s' "$__bg_code" > ${shqPath(exitFile)}`
        child = spawn("/bin/bash", ["-lc", runner], { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd], env: { ...process.env } })
        closeSync(fd)
      } catch (e) {
        return ok(`后台进程起不来：${String(e)}`)
      }
      job.pid = child.pid || 0
      try {
        atomicWrite(join(BG_DIR, `${id}.json`), JSON.stringify(job, null, 2))
      } catch (e) {
        try { process.kill(-Number(child.pid), "SIGKILL") } catch { /* ignore */ }
        return ok(`任务记录写不进去，已撤掉：${String(e)}`)
      }
      child.on("exit", (code, signal) => {
        try {
          const file = join(BG_DIR, `${id}.json`)
          const cur = JSON.parse(readFileSync(file, "utf8"))
          cur.endedAt = new Date().toISOString()
          cur.exitCode = code
          cur.signal = signal || null
          writeFileSync(file, JSON.stringify(cur, null, 2), { mode: 0o600 })
        } catch { /* ignore */ }
      })
      child.on("error", (e) => log(`bg_run spawn failed · ${String(e)}`))
      child.unref()
      // 跨进程（home + qq）可能同时通过检查，起完再复核一次
      const runningNow = readBgJobs().filter((j) => bgState(j).state === "running")
      if (runningNow.length > BG_MAX_PARALLEL) {
        try { process.kill(-Number(job.pid), "SIGKILL") } catch { /* ignore */ }
        return ok(`同时最多 ${BG_MAX_PARALLEL} 个后台任务，这次没排上。`)
      }
      return ok(`已在后台跑起来：${id}${job.label ? `（${job.label}）` : ""}\npid ${job.pid} · 日志 ${log}\n可以先去回话；跑完用 bg_status({ id: "${id}" }) 看结果，bg_output({ id: "${id}" }) 读输出。`)
    },
  })

  addTool(pi, {
    name: "bg_status",
    label: "Background status",
    description: "看后台任务：不传 id 列出最近的，传 id 看单条。",
    parameters: { type: "object", properties: { id: { type: "string", description: "任务 id，可省略" } } },
    async execute(_id: string, params: any) {
      if (JUDGE || CHANNEL === "group") return ok("这个会话不能看后台任务。")
      const all = readBgJobs().sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      if (!all.length) return ok("没有后台任务。")
      const id = String(params?.id || "").trim()
      const pick = id ? all.filter((j) => j.id === id) : all.slice(0, 10)
      if (!pick.length) return ok(`没有这个任务：${id}`)
      const lines = pick.map((j) => {
        const st = bgState(j)
        const state = st.state === "running" ? "运行中"
          : st.state === "done" ? "完成"
          : st.state === "failed" ? (st.signal ? `被 ${st.signal} 终止` : `失败（退出码 ${st.code}）`)
          : "已结束（未知）"
        const endMs = j.endedAt ? Date.parse(j.endedAt) : Date.now()
        const spent = bgSpan(Math.max(0, endMs - Date.parse(j.startedAt)))
        return `- ${j.id} · ${state} · 用了 ${spent} · ${j.label || String(j.command).slice(0, 50)}${st.state === "running" ? ` · pid ${j.pid}` : ""}\n  日志：${j.log}`
      })
      return ok((id ? "" : "最近的后台任务：\n") + lines.join("\n"))
    },
  })

  addTool(pi, {
    name: "bg_output",
    label: "Background output",
    description: "读后台任务的输出，默认最后 40 行。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "任务 id" },
        tail: { type: "number", description: "要看最后多少行，默认 40，最多 500" },
      },
      required: ["id"],
    },
    async execute(_id: string, params: any) {
      if (JUDGE || CHANNEL === "group") return ok("这个会话不能读后台任务。")
      const id = String(params?.id || "").trim()
      if (!/^bg-\d+-[a-z0-9]+$/i.test(id)) return ok("任务 id 不对。")
      let job: any
      try { job = JSON.parse(readFileSync(join(BG_DIR, `${id}.json`), "utf8")) } catch { return ok(`没有这个任务：${id}`) }
      let logPath = ""
      try { logPath = realpathSync(String(job?.log || "")) } catch { return ok("任务日志不存在。") }
      if (!logPath.startsWith(BG_DIR + sep)) return ok("任务日志路径不合法。")
      job = { ...job, log: logPath }
      let text = ""
      try { text = readTail(job.log, 256 * 1024) } catch { return ok(`读不到日志：${job.log}`) }
      const n = Math.max(1, Math.min(500, Number(params?.tail) || 40))
      const lines = text.trimEnd().split("\n")
      // 行数之外再按字符兜底：单行几 MB 的日志也不能整段塞进上下文
      const body = lines.slice(-n).join("\n").slice(-40000)
      return ok(`任务 ${id}（${bgState(job).state === "running" ? "运行中" : "已结束"}）\n${body || "（还没有输出）"}`)
    },
  })

  addTool(pi, {
    name: "bg_kill",
    label: "Background kill",
    description: "停掉一个后台任务（连同它的整个进程组）。卡住、跑飞了、不想等的时候用。",
    parameters: { type: "object", properties: { id: { type: "string", description: "任务 id" } }, required: ["id"] },
    async execute(_id: string, params: any) {
      if (JUDGE || CHANNEL === "group") return ok("这个会话不能管后台任务。")
      const id = String(params?.id || "").trim()
      if (!/^bg-\d+-[a-z0-9]+$/i.test(id)) return ok("任务 id 不对。")
      let job: any
      try { job = JSON.parse(readFileSync(join(BG_DIR, `${id}.json`), "utf8")) } catch { return ok(`没有这个任务：${id}`) }
      if (!bgAlive(job)) return ok(`这个任务已经结束了（${bgState(job).state}）。`)
      const sig = (s: string) => {
        try { process.kill(-Number(job.pid), s) } catch {
          try { process.kill(Number(job.pid), s) } catch { /* ignore */ }
        }
      }
      sig("SIGTERM")
      await new Promise((r) => setTimeout(r, 800))
      if (bgAlive(job)) sig("SIGKILL")
      return ok(`已停止 ${id}。`)
    },
  })

  // —— 心跳：和主日程平行的临时唤醒串 ——
  addTool(pi, {
    name: "heartbeat",
    label: "Heartbeat",
    description: "起一个固定间隔的心跳串：每隔 N 分钟醒一次，用来盯后台任务、等一个过程、或者保持连续关注。理由写一次，之后每一跳都带着；每跳结束后会自动续下一跳（最多 60 跳）。同时最多 2 条串；不需要了用 heartbeat_stop 停掉。",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "为什么要起这个心跳（只写一次，后面每跳都带着）" },
        every_minutes: { type: "number", description: "间隔分钟数，1-60" },
        note: { type: "string", description: "每一跳具体要做什么；不写就用理由" },
        first_after_minutes: { type: "number", description: "第一跳在几分钟后，默认等于间隔" },
        model: { type: "string", enum: ["local", "cloud"], description: "到点用哪个模型跑" },
      },
      required: ["reason", "every_minutes"],
    },
    async execute(_id: string, params: any) {
      if (JUDGE || CHANNEL === "group") return ok("这个会话不能起心跳。")
      if (!heartbeatEnabled()) return ok("心跳功能已经关掉了（看板「心跳与关怀」里可以重新打开）。")
      if (!config().world.enabled || !config().world.running) return ok("世界现在是停用/暂停状态，先打开再起心跳。")
      const reason = String(params?.reason || "").trim()
      if (!reason) return ok("说一下为什么要起这个心跳。")
      const every = Math.round(Number(params?.every_minutes) || 0)
      if (!every || every < 1 || every > 60) return ok("间隔要写 1-60 分钟。")
      // 首跳也不能超过单串时长上限，否则「最长 10 分钟」的串第一跳就在 240 分钟后
      const first = Math.max(1, Math.min(heartbeatLimitMinutes(), Math.round(Number(params?.first_after_minutes) || every)))
      const now = Date.now()
      const chainId = `hb-${now}-${Math.random().toString(36).slice(2, 6)}`
      const c = config().models
      const current = lastCtx ? modelIdOf(lastCtx) : ""
      const model: Alarm["model"] = params.model === "local" || params.model === "cloud"
        ? params.model
        : current && current === c.local ? "local" : current && current === c.cloud ? "cloud" : undefined
      const res = withWorldLock(() => {
        const st = readWorldStrict()
        if (!st) return { ok: false, msg: "world.json 读不出来，先别起心跳。" }
        const list = st.alarms || []
        const chains = new Set(list.filter((a) => a.chainId && a.status !== "fired").map((a) => a.chainId))
        if (chains.size >= 2) return { ok: false, msg: `同时最多 2 条心跳串，现在有 ${chains.size} 条：${[...chains].join("、")}` }
        const alarm: Alarm = {
          id: `s-${now}-${Math.random().toString(36).slice(2, 6)}`,
          at: new Date(now + first * 60_000).toISOString(),
          note: (String(params?.note || "").trim() || reason).slice(0, 500),
          setAt: new Date(now).toISOString(),
          model,
          kind: "sub",
          status: "pending",
          chainId,
          reason: reason.slice(0, 200),
          intervalMinutes: every,
          seq: 1,
          startedAt: new Date(now).toISOString(),
        }
        st.alarms = [...list, alarm].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
        return { ok: writeWorld(st), chainId }
      })
      // res.msg 承载真正的失败原因（如「同时最多 2 条」「world.json 读不出来」），别吞掉
      if (!res?.ok) return ok(res?.msg || "心跳没起成（world.json 被占用或读不出来）。")
      const maxMin = heartbeatLimitMinutes()
      // 从首跳开始算：还能跳几次 = (上限 - 首跳) / 间隔 + 1
      const maxJumps = Math.max(1, Math.min(60, Math.floor((maxMin - first) / every) + 1))
      return ok(`心跳已起：${res.chainId}\n每 ${every} 分钟一跳，第一跳 ${isoLocal(new Date(now + first * 60_000))}。\n按当前设置（单次最长 ${maxMin} 分钟），这条串最多 ${maxJumps} 跳、约 ${maxJumps * every} 分钟。\n不需要了：heartbeat_stop({ chainId: "${res.chainId}" })`)
    },
  })

  addTool(pi, {
    name: "heartbeat_stop",
    label: "Stop heartbeat",
    description: "停掉一条心跳串。已触发过的留档保留，没触发的撤掉。",
    parameters: {
      type: "object",
      properties: { chainId: { type: "string", description: "心跳串 id（hb-…）" } },
      required: ["chainId"],
    },
    async execute(_id: string, params: any) {
      if (JUDGE || CHANNEL === "group") return ok("这个会话不能停心跳。")
      const chainId = String(params?.chainId || "").trim()
      if (!chainId) return ok("给个 chainId。")
      const res = withWorldLock(() => {
        const st = readWorldStrict()
        if (!st) return { ok: false, removed: 0 }
        const list = st.alarms || []
        const kept = list.filter((a) => !(a.chainId === chainId && a.status !== "fired"))
        const removed = list.length - kept.length
        st.alarms = kept
        return { ok: writeWorld(st), removed }
      })
      if (!res?.ok) return ok("没停成（world.json 被占用）。")
      return ok(res.removed ? `已停止心跳 ${chainId}（撤掉 ${res.removed} 跳未触发的）。` : `心跳 ${chainId} 本来就没有待触发的了。`)
    },
  })

  addTool(pi, {
    name: "check_alarm",
    label: "Check alarms",
    description: "看现在的日程、心跳串、跳过的唤醒和旧版一次性闹钟。",
    parameters: { type: "object", properties: {} },
    async execute() {
      const list = readWorld().alarms || []
      if (!list.length) return ok("现在没有定闹钟。")
      const now = Date.now()
      const rel = (iso: string) => {
        const t = Date.parse(iso)
        if (!Number.isFinite(t)) return "时间异常"
        return t <= now ? "已到点" : `还有 ${Math.max(0, Math.round((t - now) / 60_000))} 分钟`
      }
      const lines: string[] = []
      for (const m of list.filter((a) => a.kind === "main").sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
        const mState = m.status === "active" ? "进行中" : m.status === "closed" ? "已结束" : "待开始"
        lines.push(`- 活动《${m.note}》（${mState}；${shortStamp(m.at)}；id ${m.id}）${m.paused ? "【已暂停】" : ""}`)
        if (m.skipped?.length) lines.push(`  - 跳过：${m.skipped.map((s) => `${shortStamp(s.scheduled)} ${s.note}`).join("、")}`)
        if (m.status === "active") lines.push(`  - 想每隔几分钟回来看一眼，就 heartbeat({ reason: "接着做「${m.note.slice(0, 16)}」", every_minutes: 3 })`)
      }
      // 心跳串（独立于日程）
      const beatMap = new Map<string, Alarm[]>()
      for (const b of list.filter((x) => x.kind === "sub" && x.chainId && x.status !== "fired")) {
        const k = String(b.chainId)
        if (!beatMap.has(k)) beatMap.set(k, [])
        beatMap.get(k)!.push(b)
      }
      for (const [cid, items] of beatMap) {
        const next = items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0]
        lines.push(`- 心跳 ${cid}：${next.reason || next.note}（每 ${next.intervalMinutes || "?"} 分钟，第 ${next.seq || 1} 跳，${rel(next.at)}；停：heartbeat_stop({ chainId: "${cid}" })）`)
      }
      // 已经停掉/跑完的串，也报一句，免得它凭空消失
      const stopped = new Map<string, number>()
      for (const b of list.filter((x) => x.kind === "sub" && x.chainId && x.status === "fired")) {
        const k = String(b.chainId)
        if (beatMap.has(k)) continue
        stopped.set(k, (stopped.get(k) || 0) + 1)
      }
      for (const [cid, n] of stopped) lines.push(`- 已停的心跳 ${cid}（执行过 ${n} 次）`)
      for (const a of list.filter((x) => !x.kind).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
        lines.push(`- ${shortStamp(a.at)}（${rel(a.at)}）${a.note}${a.model ? `（${a.model === "cloud" ? "在线" : "本地"}模型）` : ""}`)
      }
      return ok(lines.join("\n"))
    },
  })

  addTool(pi, {
    name: "cancel_alarm",
    label: "Cancel alarm",
    description: "取消/关闭闹钟。传 id 精确定位；传 match 取消 note 含这个词的；要全部取消必须显式给 all: true。关闭活动会保留已执行的子闹钟留档一天。",
    parameters: { type: "object", properties: { id: { type: "string", description: "活动或闹钟 id" }, match: { type: "string", description: "note 关键词" }, all: { type: "boolean", description: "确认全部取消；不传 id/match 时必须显式给 true" } } },
    async execute(_id: string, params: any) {
      if (JUDGE || CHANNEL === "group") return ok("这个会话不能改闹钟。")
      const id = String(params.id || "").trim()
      const match = String(params.match || "").trim()
      const allFlag = params.all === true
      if (!id && !match && !allFlag) return ok("要取消哪一条？传 id、match，或 all: true 全部取消。")
      const res = withWorldLock(() => {
        const state = readWorldStrict()
        if (!state) return { ok: false, msg: "world.json 读不出来，未改动" }
        const all = state.alarms || []
        const picked = id ? all.filter((a) => a.id === id) : match ? all.filter((a) => a.note.includes(match)) : all.slice()
        // 心跳串有自己的停法（heartbeat_stop）；cancel_alarm 只在 all: true 时才动它
        const targets = allFlag ? picked : picked.filter((a) => !(a.chainId && !a.parentId))
        if (!targets.length) {
          // 目标存在但全是心跳：告诉它用对工具，别让它误以为不存在
          if (picked.length) return { ok: true, removed: 0, mains: 0, hint: `那是心跳串，用 heartbeat_stop({ chainId: "${picked[0].chainId}" }) 停。` }
          return { ok: true, removed: 0, mains: 0 }
        }
        const mainIds = new Set(targets.filter((a) => a.kind === "main").map((a) => a.id))
        // 关活动留尾声：标 closed + closedAt，已执行的子闹钟留档一天（和看板/强制关闭保持一致）
        for (const a of all) {
          if (a.kind === "main" && mainIds.has(a.id) && a.status !== "closed") {
            a.status = "closed"
            a.closedAt = new Date().toISOString()
          }
        }
        // 已执行的子闹钟是留档，24 小时自己会清，不跟着全量取消一起删
        const remove = new Set(targets.filter((a) => a.kind !== "main" && a.status !== "fired").map((a) => a.id))
        state.alarms = all.filter((a) => {
          if (remove.has(a.id)) return false
          if (a.kind === "sub" && a.parentId && mainIds.has(a.parentId) && a.status !== "fired") return false
          return true
        })
        return { ok: writeWorld(state), removed: remove.size + mainIds.size, mains: mainIds.size }
      })
      if (!res?.ok) return ok(res?.msg || "闹钟没改成功（world.json 暂时被占用）。")
      if (!res.removed) return ok(res.hint || "没找到要取消的闹钟。")
      const extra = res.mains ? "（活动连同子闹钟）" : ""
      return ok(id ? `取消了 ${res.removed} 条${extra}。` : match ? `取消了 note 含「${match}」的 ${res.removed} 条${extra}。` : `全取消了（${res.removed} 条）。`)
    },
  })

  addTool(pi, {
    name: "reach_out",
    label: "Reach out",
    description: "想找对方时用：把一两句话写进 outbox，桥接会送到对方 QQ。桥接关闭/离线时不会送达。",
    parameters: { type: "object", properties: { text: { type: "string", description: "要说的话" } }, required: ["text"] },
    async execute(_id: string, params: any) {
      if (JUDGE || CHANNEL === "group") return ok("这个会话不能用 reach_out。")
      const text = String(params.text || "").trim()
      if (!text) return ok("没有话可送。")
      const status = bridgeStatus()
      if (status !== "在线") return ok(`OneBot 桥接${status}，这句话没有送出去。`)
      try {
        mkdirSync(OUTBOX_DIR, { recursive: true, mode: 0o700 })
        appendFileSync(join(OUTBOX_DIR, `${dayOf()}.jsonl`), `${JSON.stringify({ t: new Date().toISOString(), kind: "reach", text, session: "pi" })}\n`, { mode: 0o600 })
      } catch (e) { return ok(`写 outbox 失败：${String(e)}`) }
      return ok("话放出去了，桥接会送到对方 QQ。")
    },
  })

  addTool(pi, {
    name: "send_media",
    label: "Send media",
    description: "主动发图片/语音/文件。path 必须在 room / 表情包 / 语音 / tmp 里；群聊只发图片/语音。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径（可相对 world）" },
        text: { type: "string", description: "可选配文" },
        kind: { type: "string", enum: ["image", "voice", "file"], description: "不传按扩展名判断" },
      },
      required: ["path"],
    },
    async execute(_id: string, params: any) {
      if (JUDGE) return ok("判官会话不能发媒体。")
      const raw = String(params.path || "").trim()
      if (!raw) return ok("没有给路径。")
      let real = ""
      try { real = realpathSync(raw.startsWith("/") ? raw : resolve(WORLD, raw)) } catch { return ok(`找不到文件：${raw}`) }
      const dirs = [ROOM_DIR, STICKER_DIR, VOICE_DIR, TMP_DIR].map((d) => { try { return realpathSync(d) } catch { return d } })
      if (!dirs.some((d) => real === d || real.startsWith(d + sep))) return ok("只能发 room / 表情包 / 语音 / tmp 里的文件。")
      const mediaType = mediaTypeOf(real, params.kind)
      if (CHANNEL === "group") {
        if (mediaType === "file") return ok("群聊不发文件。")
        if (!real.startsWith(realpathSync(STICKER_DIR) + sep) && !real.startsWith(realpathSync(VOICE_DIR) + sep)) return ok("群聊只能从 表情包/语音 里发。")
      }
      const target = CHANNEL === "group" ? { kind: "group", id: GROUP_ID } : { kind: "private" }
      try {
        mkdirSync(OUTBOX_DIR, { recursive: true, mode: 0o700 })
        appendFileSync(join(OUTBOX_DIR, `${dayOf()}.jsonl`), `${JSON.stringify({ t: new Date().toISOString(), kind: "media", path: real, name: basename(real), mediaType, text: String(params.text || "").trim(), session: "pi", target })}\n`, { mode: 0o600 })
      } catch (e) { return ok(`写 outbox 失败：${String(e)}`) }
      return ok(`已经交给桥接：${basename(real)}。投递结果未知。`)
    },
  })

  addTool(pi, {
    name: "group_chat",
    label: "Toggle group chat",
    description: "开关 QQ 群聊（写 life-world.json 的 bridge.group.enabled，桥接实时读取）。",
    parameters: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"] },
    async execute(_id: string, params: any) {
      if (JUDGE || CHANNEL === "group") return ok("这个会话不能开关群聊。")
      try {
        const raw = readJson<any>(CONFIG_FILE, {})
        raw.bridge = raw.bridge || {}
        raw.bridge.group = raw.bridge.group || {}
        raw.bridge.group.enabled = params.enabled === true
        atomicWrite(CONFIG_FILE, JSON.stringify(raw, null, 2))
      } catch (e) { return ok(`写配置失败：${String(e)}`) }
      return ok(`QQ 群聊已${params.enabled === true ? "开启" : "关闭"}。`)
    },
  })

  addTool(pi, {
    name: "kaomoji",
    label: "Kaomoji",
    description: "按场景取几条颜文字。不传 scene 就列出可用场景。",
    parameters: { type: "object", properties: { scene: { type: "string" }, count: { type: "number" }, remember: { type: "boolean" } } },
    async execute(_id: string, params: any) {
      if (JUDGE) return ok("判官不能取颜文字。")
      const data = kaomoji()
      const scene = String(params.scene || "").trim()
      if (!scene) return ok(`可用场景：${Object.keys(KAOMOJI_MAP).join("、")}`)
      const cats = Object.prototype.hasOwnProperty.call(KAOMOJI_MAP, scene) ? KAOMOJI_MAP[scene] : [scene]
      const pool = new Set<string>()
      for (const c of cats) for (const x of data[c] || []) pool.add(x)
      const list = [...pool]
      if (!list.length) return ok(`没有「${scene}」的颜文字。`)
      const picked = pick(list, Math.max(1, Math.min(20, Number(params.count) || 3)))
      if (params.remember) {
        try {
          const file = join(ROOM_DIR, "颜文字.md")
          appendFileSync(file, (existsSync(file) ? "" : "# 我喜欢的颜文字\n\n") + picked.map((x) => `- ${x}  （${scene}）`).join("\n") + "\n")
        } catch { /* ignore */ }
      }
      return ok(picked.join("\n"))
    },
  })

  // 群聊强制云端，不给切换工具（避免群成员把 home/私聊一起切走）
  if (CHANNEL !== "group") addTool(pi, {
    name: "switch_model",
    label: "Switch model",
    description: "本地 / 在线模型热切换，也能查看和切换其他会话。target: local=本地小模型，cloud=在线大模型，provider/model；不传 target 查所有会话状态。session: self（默认）/ all / roleKey（home、qq、group-...）。",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "local / cloud / provider/model；省略则查状态" },
        session: { type: "string", description: "self（默认）/ all / roleKey（home、qq、group-...）" },
        reason: { type: "string", description: "为什么切，写一句，便于回看" },
      },
    },
    async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const o = config().models
      const cur = modelIdOf(ctx) || "未知"
      const scope = String(params?.session || "self").trim() || "self"
      const raw = String(params?.target || "").trim()
      const kindLabel = (m: string) => modelKind(m) === "local" ? "本地" : modelKind(m) === "cloud" ? "在线" : "其他"
      const list = () => {
        const all = activeSessionSummaries()
        return all.length
          ? all.map((s) => `- ${s.roleKey}：${kindLabel(s.model)} · ${s.model}${s.roleKey === roleKey ? "（你在这里）" : ""}`).join("\n")
          : "（没有活跃会话）"
      }
      if (!raw || raw === "status") {
        return ok(`当前会话：${roleKey}（${kindLabel(cur)} · ${cur}）\n全部会话：\n${list()}\n本地：${o.local || "未配"}\n在线：${o.cloud || "未配"}\n自动兜底：${o.autoFailover ? "开" : "关"}`)
      }
      if (!o.local && !o.cloud) return ok("还没配 models.local / models.cloud，先在 life-world.json 里配好。")
      const target = raw === "local" ? o.local : raw === "cloud" ? o.cloud : raw
      if (!target) return ok(`这个别名没配：${raw}`)
      const reason = String(params?.reason || "") || "AI 切换"

      // 只切自己
      if (scope === "self" || scope === roleKey) {
        if (target === cur) return ok(`已经是 ${target} 了。`)
        const r = await switchTo(ctx, target, reason)
        writeStatus()
        writeModelMode()
        return ok(r)
      }

      // 切别的会话 / 全部：下发控制命令，逐个等回执
      const active = activeSessionSummaries().map((s) => s.roleKey)
      // all 永远包含自己：TUI 可能还没写心跳，不能把自己漏掉
      const roles = scope === "all" ? Array.from(new Set([...active, roleKey])) : [scope]
      if (!roles.length) return ok("没有活跃会话可切。")
      const missing = roles.filter((rk) => rk !== roleKey && !active.includes(rk))
      if (missing.length) return ok(`这些会话没在跑或没心跳（可能刚重启/正忙）：${missing.join("、")}`)

      const cmd = appendControl({ target: scope, action: "model", model: raw, reason })
      // 自己直接切；只记住这条 id 让轮询跳过，不能推进水位（否则会吞掉更早未执行的命令）
      rememberSelfHandled(cmd.id)
      const waitMs = scope === "all" ? 12_000 : 8_000
      const results = await Promise.all(roles.map(async (rk) => {
        if (rk === roleKey) {
          const r = target === cur ? `已经是 ${target} 了` : await switchTo(ctx, target, reason)
          writeAck(cmd.id, { ok: r.startsWith("已切到") || r.startsWith("已经是"), model: target, msg: r })
          return { rk, ok: r.startsWith("已切到") || r.startsWith("已经是"), msg: r }
        }
        const st = await waitRoleAck(cmd.id, rk, waitMs)
        return { rk, ok: !!st?.ok, msg: (st && st.msg) || "未响应（可能卡在任务里）" }
      }))
      writeStatus()
      writeModelMode()
      const lines = results.map((x) => `- ${x.rk} ${x.ok ? "✓" : "✗"} ${x.msg}`).join("\n")
      const allOk = results.every((x) => x.ok)
      return ok(`切换 ${scope === "all" ? "全部会话" : scope} → ${target}\n${lines}${allOk ? "" : "\n有会话没成功，按上面如实告诉用户。"}`)
    },
  })

  addTool(pi, {
    name: "web_search",
    label: "Web search",
    description: "联网搜索最新信息（免费，不需要 key）。返回标题、链接、摘要；要看正文再打开链接。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索词" },
        limit: { type: "number", description: "返回几条，默认 5（最多 10）" },
      },
      required: ["query"],
    },
    async execute(_id: string, params: any) {
      const query = String(params.query || "").trim()
      if (!query) return ok("要搜什么？给个搜索词。")
      const limit = Math.max(1, Math.min(10, Number(params.limit) || 5))
      try {
        const hits = await webSearch(query, limit)
        if (!hits.length) return ok(`没搜到「${query}」的结果。`)
        return ok(hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet.replace(/\s+/g, " ").slice(0, 200)}` : ""}`).join("\n"))
      } catch (e) {
        return ok(`搜索失败：${String((e as any)?.message || e)}`)
      }
    },
  })

  if (CHANNEL !== "group") {
    addTool(pi, {
      name: "skill_list",
      label: "Skill list",
      description: "列出技能库里的技能（自制 + 下载），并刷新 skills/INDEX.md。只返回索引，不读正文。",
      parameters: { type: "object", properties: {} },
      async execute() {
        const list = writeSkillIndex()
        return ok(list.length ? skillIndexMarkdown(list) : "技能库还是空的：把自己的技能放 skills/own/<名字>/SKILL.md，下载的放 skills/downloaded/<名字>/SKILL.md。")
      },
    })
    addTool(pi, {
      name: "skill_read",
      label: "Skill read",
      description: "读一个技能的 SKILL.md 正文和绝对路径；下载的技能会提示先确认内容。",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "技能名（目录名或 frontmatter 里的 name）" } },
        required: ["name"],
      },
      async execute(_id: string, params: any) {
        const s = findSkill(String(params?.name || ""))
        if (!s) {
          const names = scanSkills().map((x) => x.name)
          return ok(`没找到这个技能：${String(params?.name || "")}。现有：${names.length ? names.join("、") : "（空）"}`)
        }
        const { text } = readSkillMeta(s.file)
        const caution = s.source === "downloaded" ? "这是下载的技能；先看清正文和脚本，再决定要不要执行。\n\n" : ""
        const state = s.enabled ? "" : "（已停用，skill_toggle 打开后才能跑）\n"
        return ok(`${caution}${state}技能：${s.name}（${s.source === "own" ? "自制" : "下载"}）\n路径：${s.dir}\n\n${text}`)
      },
    })
    addTool(pi, {
      name: "skill_run",
      label: "Skill run",
      description: "跑技能目录里的脚本。只能跑技能目录内的文件；不给 script 就用 SKILL.md 的 run:。配了本地模型但当前不在本地时不跑（避免脚本读到私密资料），先切回本地。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "技能名（目录名或 frontmatter 的 name）" },
          script: { type: "string", description: "相对技能目录的脚本路径，如 scripts/run.sh；省略则用 SKILL.md 的 run:" },
          args: { type: "array", items: { type: "string" }, description: "传给脚本的参数" },
          timeout_seconds: { type: "number", description: "超时秒数，默认 60，最大 300" },
          confirm: { type: "boolean", description: "下载来的技能必须显式 true 才执行" },
        },
        required: ["name"],
      },
      async execute(_id: string, params: any) {
        const o = config().models
        if (o.local && modelIdOf(lastCtx) !== o.local) {
          return ok("云端模式不跑技能脚本（脚本可能读到私密资料）。要跑请先 switch_model 切回本地。")
        }
        const s = findSkill(String(params?.name || ""))
        if (!s) {
          const names = scanSkills().map((x) => x.name)
          return ok(`没找到这个技能：${String(params?.name || "")}。现有：${names.length ? names.join("、") : "（空）"}`)
        }
        if (!s.enabled) return ok(`技能「${s.name}」已停用；先 skill_toggle({ name: "${s.name}", enabled: true })。`)
        // 下载来的技能里带的 run: 等于第三方代码，每次调用都要显式确认
        if (s.source === "downloaded" && params?.confirm !== true) {
          return ok(`「${s.name}」是从外部下载的技能，跑它的脚本等于执行第三方代码。确认要跑，就带上 confirm: true 再调一次。`)
        }
        const timeout = Math.max(5, Math.min(300, Number(params?.timeout_seconds) || 60))
        const args = Array.isArray(params?.args) ? params.args.map((x: any) => String(x)) : []
        const r = await runSkill(s, String(params?.script || "").trim(), args, timeout)
        const head = `技能：${s.name}（${s.source === "own" ? "自制" : "下载"}）\n命令：${r.cmd || "-"}\n退出码：${r.code}${r.code === -2 ? "（超时被杀）" : ""}`
        const body = [
          r.out.trim() ? `—— 输出 ——\n${r.out.trim()}` : "",
          r.err.trim() ? `—— 错误 ——\n${r.err.trim()}` : "",
        ].filter(Boolean).join("\n")
        return ok([head, body].filter(Boolean).join("\n"))
      },
    })
    addTool(pi, {
      name: "skill_toggle",
      label: "Skill toggle",
      description: "启用 / 停用技能。停用只是加 .disabled 标记，不删文件，也不影响 skill_read。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "技能名" },
          enabled: { type: "boolean", description: "true 启用，false 停用" },
        },
        required: ["name", "enabled"],
      },
      async execute(_id: string, params: any) {
        const s = findSkill(String(params?.name || ""))
        if (!s) {
          const names = scanSkills().map((x) => x.name)
          return ok(`没找到这个技能：${String(params?.name || "")}。现有：${names.length ? names.join("、") : "（空）"}`)
        }
        const marker = join(s.dir, ".disabled")
        try {
          if (params?.enabled === true) { if (existsSync(marker)) unlinkSync(marker) }
          else writeFileSync(marker, `${new Date().toISOString()} disabled\n`, { mode: 0o600 })
        } catch (e) { return ok(`改状态失败：${String(e)}`) }
        writeSkillIndex()
        return ok(`技能「${s.name}」已${params?.enabled === true ? "启用" : "停用"}。`)
      },
    })
    addTool(pi, {
      name: "perceive",
      label: "Perceive media",
      description: "辅助感知：只在主模型缺能力时用——视频、音频，或主模型不支持图片时的图片。path 可以是本地文件或媒体直链；B站/抖音网页地址、BV 号不是直链，需要你自己解析出真实媒体 URL，工具不解析网页。图片主模型能看就直接 read，别调这个。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "本地文件路径（相对 world），或打开就是媒体文件的直链（.mp4/.mp3/.jpg 等；网页地址不算）" },
          question: { type: "string", description: "要它看/听什么" },
          kind: { type: "string", enum: ["image", "video", "audio"], description: "不传按扩展名判断" },
        },
        required: ["path", "question"],
      },
      async execute(_id: string, params: any) {
        if (JUDGE) return ok("判官会话不能用感知。")
        const raw = String(params.path || "").trim()
        const question = String(params.question || "").trim()
        if (!raw || !question) return ok("要给 path 和 question。")
        const isUrl = isHttpUrl(raw)
        const kind = mediaKindOf(isUrl ? raw.split("?")[0] : raw, params.kind)
        if (!kind) return ok("认不出媒体类型；给 kind: image / video / audio。")
        // 能力路由优先：主模型能看图片就不走辅助模型，也不要求配 multimodal
        const mainInputs: string[] = Array.isArray((lastCtx as any)?.model?.input) ? (lastCtx as any).model.input : []
        if (kind === "image" && mainInputs.includes("image")) {
          return ok(isUrl
            ? "主模型自己能看图，不用走辅助模型。把图片下载到 tmp 或 world 目录后直接 read。"
            : `主模型自己能看图，不用走辅助模型；直接 read：${raw.startsWith("/") ? raw : join(WORLD, raw)}`)
        }
        const mm = config().multimodal
        if (!mm.enabled || !mm.model) return ok("当前能力需要辅助感知，但还没配模型。去看板「模型 → 辅助感知」选一个，或写 life-world.json 的 multimodal.model（推荐 qwen3.8-omni-flash）。")
        let mediaUrl = ""
        let warning = ""
        let tmpDir = ""
        try {
          if (isUrl) {
            mediaUrl = raw
          } else {
            let real = ""
            try { real = realpathSync(raw.startsWith("/") ? raw : resolve(WORLD, raw)) } catch { return ok(`找不到文件：${raw}`) }
            const dirs = [ROOM_DIR, STICKER_DIR, VOICE_DIR, TMP_DIR].map((d) => { try { return realpathSync(d) } catch { return d } })
            if (!dirs.some((d) => real === d || real.startsWith(d + sep))) return ok("只能读 room / 表情包 / 语音 / tmp 里的文件。")
            let drawer = ""
            try { drawer = realpathSync(DRAWER_DIR) } catch { /* ignore */ }
            if (drawer && (real === drawer || real.startsWith(drawer + sep))) return ok("机密抽屉里的东西不走云端感知。")
            const outDir = join(TMP_DIR, `perceive-${Date.now()}`)
            try { mkdirSync(outDir, { recursive: true, mode: 0o700 }) } catch { /* ignore */ }
            tmpDir = outDir
            const r = await mediaDataUrl(real, kind, outDir)
            if (r.error) return ok(r.error)
            mediaUrl = r.url || ""
            warning = r.warning || ""
          }
          const aux = await auxPerceiveModel()
          if (!aux) return ok("辅助感知模型没配好（multimodal.model 或 provider 的 baseUrl 缺失）。")
          const content: any[] = []
          if (kind === "image") content.push({ type: "image_url", image_url: { url: mediaUrl } })
          else if (kind === "video") content.push({ type: "video_url", video_url: { url: mediaUrl } })
          else content.push({ type: "input_audio", input_audio: { data: mediaUrl, format: audioFormatOf(mediaUrl, raw) } })
          content.push({ type: "text", text: question })
          try {
            const res = await fetch(aux.url, {
              method: "POST",
              headers: aux.headers,
              body: JSON.stringify({ model: aux.id, messages: [{ role: "user", content }], modalities: ["text"], stream: false }),
              signal: AbortSignal.timeout(Math.max(30_000, mm.timeoutMs)),
            })
            const text = await res.text()
            if (!res.ok) return ok(`感知模型返回 ${res.status}：${text.slice(0, 300)}`)
            let data: any = null
            try { data = JSON.parse(text) } catch { /* ignore */ }
            const c = data?.choices?.[0]?.message?.content
            const answer = typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => p?.text || "").join("\n") : ""
            const o = config().models
            const localMain = !!(o.local && modelIdOf(lastCtx) === o.local)
            const meta = [
              `辅助感知：${mm.model} · ${kind}`,
              localMain ? "（主模型在本地；这条媒体已送到辅助感知模型）" : "",
              warning,
            ].filter(Boolean).join("\n")
            return ok(`${meta}\n\n${(answer || text).slice(0, 20_000)}`)
          } catch (e) {
            return ok(`感知请求失败：${String(e).slice(0, 300)}`)
          }
        } finally {
          // 压缩产生的临时文件用完即删；原始下载文件由 AI 自己清理
          if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ } }
        }
      },
    })
  }

  addTool(pi, {
    name: "memory_search",
    label: "Memory search",
    description: "翻以前的记忆：对话原文、日记、房间笔记。支持时间范围、角色、前后文。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" }, from: { type: "string" }, to: { type: "string" },
        role: { type: "string", enum: ["any", "user", "assistant"] },
        scope: { type: "string", enum: ["chat", "diary", "notes", "all"] },
        limit: { type: "number" }, context: { type: "number" },
      },
      required: ["query"],
    },
    async execute(_id: string, params: any) {
      if (JUDGE || CHANNEL === "group") return ok("这个会话不能翻记忆。")
      const query = String(params.query || "").trim()
      if (!query) return ok("要搜什么？")
      const limit = Math.max(1, Math.min(30, Number(params.limit) || 8))
      const ctxNum = Number(params.context)
      const context = Number.isFinite(ctxNum) ? Math.max(0, Math.min(3, ctxNum)) : 1
      const from = /^\d{4}-\d{2}-\d{2}$/.test(String(params.from || "")) ? String(params.from) : undefined
      const to = /^\d{4}-\d{2}-\d{2}$/.test(String(params.to || "")) ? String(params.to) : undefined
      const role = params.role === "user" || params.role === "assistant" ? params.role : "any"
      const scope = ["chat", "diary", "notes", "all"].includes(String(params.scope)) ? String(params.scope) : "chat"
      const out: string[] = []
      if (scope === "chat" || scope === "all") {
        const lines = await searchChat(query, from, to, role, limit, context)
        if (lines.length) out.push("—— 对话 ——", ...lines)
      }
      if (scope === "diary" || scope === "all") {
        const lines = searchFiles([DIARY_DIR], query, limit)
        if (lines.length) out.push("—— 日记 ——", ...lines)
      }
      if (scope === "notes" || scope === "all") {
        const lines = searchFiles([ROOM_DIR], query, limit)
        if (lines.length) out.push("—— 房间笔记 ——", ...lines)
      }
      return ok(out.length ? out.join("\n") : `没有找到「${query}」。`)
    },
  })

  addTool(pi, {
    name: "memory_day",
    label: "Memory day",
    description: "回看某一天的对话和日记（YYYY-MM-DD）。",
    parameters: { type: "object", properties: { date: { type: "string" }, max_chars: { type: "number" } }, required: ["date"] },
    async execute(_id: string, params: any) {
      if (JUDGE || CHANNEL === "group") return ok("这个会话不能翻记忆。")
      const date = String(params.date || "")
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return ok("日期要写成 YYYY-MM-DD。")
      const maxChars = Math.max(500, Math.min(30_000, Number(params.max_chars) || 6000))
      const records = recordsOnDay(date)
      const diary = readText(join(DIARY_DIR, `${date}.md`))
      if (!records.length && !diary) return ok(`${date} 没有对话，也没有日记。`)
      const parts = [`【${date}】对话 ${records.length} 句`]
      let total = 0
      for (const r of records) {
        const line = `[${shortStamp(r.t)}] ${r.role === "user" ? "对方" : "我"}：${r.text}`
        if (total + line.length > maxChars) { parts.push("（后面还有，超出字数上限）"); break }
        parts.push(line); total += line.length
      }
      if (diary) parts.push("—— 日记 ——", diary.slice(0, Math.max(0, maxChars - total)))
      return ok(parts.join("\n"))
    },
  })

  addTool(pi, {
    name: "memory_timeline",
    label: "Memory timeline",
    description: "看一段时间每天聊了多少、开头说了什么。默认最近 7 天。",
    parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } } },
    async execute(_id: string, params: any) {
      if (JUDGE || CHANNEL === "group") return ok("这个会话不能翻记忆。")
      const today = dayOf()
      const from = /^\d{4}-\d{2}-\d{2}$/.test(String(params.from || "")) ? String(params.from) : dayOf(new Date(Date.now() - 6 * 86_400_000))
      const to = /^\d{4}-\d{2}-\d{2}$/.test(String(params.to || "")) ? String(params.to) : today
      if (from > to) return ok("起始日期比结束日期还晚。")
      const records = recordsInRange(from, to)
      const byDay = new Map<string, Record_[]>()
      for (const r of records) {
        const d = dayOf(new Date(r.t))
        const list = byDay.get(d)
        if (list) list.push(r); else byDay.set(d, [r])
      }
      const lines: string[] = []
      const cursor = new Date(`${from}T00:00:00`)
      while (dayOf(cursor) <= to) {
        const day = dayOf(cursor)
        const dayRecords = byDay.get(day) || []
        const first = dayRecords.find((r) => r.role === "user")
        const title = diaryTitle(day)
        const bits = [dayRecords.length ? `${dayRecords.length} 句` : "没有对话"]
        if (title) bits.push(`《${title}》`)
        if (first) bits.push(`开头：${first.text.slice(0, 60).replace(/\s+/g, " ")}`)
        lines.push(`- ${day} · ${bits.join(" · ")}`)
        cursor.setDate(cursor.getDate() + 1)
      }
      return ok(lines.join("\n"))
    },
  })

  addTool(pi, {
    name: "delegate",
    label: "Delegate subagent",
    description: "把一个耗时/并发的任务交给独立 pi 子进程（隔离上下文）。零第三方扩展，最多一层。",
    parameters: { type: "object", properties: { task: { type: "string", description: "完整任务、输入和验收标准" }, model: { type: "string", description: "可选模型，默认 deepseek-flash" } }, required: ["task"] },
    async execute(_id: string, params: any) {
      if (JUDGE || CHANNEL === "group") return ok("这个会话不能用子代理。")
      const text = await delegate(String(params.task || ""), params.model ? String(params.model) : undefined)
      return ok(text)
    },
  })


  // home 是无头 RPC 会话，没人能点面板：干脆不注册，模型连调用机会都没有
  if (ROLE !== "home") addTool(pi, {
    name: "gal_choice",
    label: "Gal choice panel",
    description: "终端 gal 模式用：抛一个单选面板让用户选；系统会自动追加「其他（自己输入）」，用户可自由改写方向。QQ/群聊没有面板，别用；那边把选项写成正文。",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "镜头停在哪、现在要对方做什么，只写一句" },
        options: { type: "array", items: { type: "string" }, description: "2~3 个选项，单选" },
      },
      required: ["question", "options"],
    },
    async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
      // 只有真正的 TUI 才开面板；rpc / print 等无头模式直接回文字，绝不 await UI（否则整轮永远卡住）
      if (CHANNEL !== "cli" || JUDGE || ctx?.mode !== "tui" || !ctx?.hasUI) {
        return ok("这个会话没有选项面板；把选项写成正文，让用户按数字回复。")
      }
      const ui = ctx?.ui
      if (!ui?.select) return ok("当前会话没有选项面板；把选项写成正文。")
      const options = Array.isArray(params.options) ? params.options.map((x: any) => String(x)).slice(0, 3) : []
      if (!options.length) return ok("没有选项。")
      // 永远留一个“自己输入”的出口
      const customLabel = "其他（自己输入）"
      const choice = await ui.select(String(params.question || "选一个"), [...options, customLabel])
      if (choice === customLabel) {
        const typed = ui.input ? await ui.input("想说什么？") : ""
        return ok(`用户选择：${String(typed || "").trim() || "（取消）"}`)
      }
      return ok(`用户选择：${choice ?? "（取消）"}`)
    },
  })

  // 定时器只在 home 角色跑；QQ/群聊/子代理进程不跑，避免重复
  if (ROLE === "home") {
    if (acquireTimerLock()) {
      const t = setInterval(tick, 30_000)
      ;(t as any).unref?.()
      log(`pi timer started role=${ROLE}`)
      process.on("exit", () => { try { if (readText(TIMER_LOCK) === String(process.pid)) writeFileSync(TIMER_LOCK, "") } catch { /* ignore */ } })
    } else {
      log("pi timer skipped (lock held)")
    }
  }
}
