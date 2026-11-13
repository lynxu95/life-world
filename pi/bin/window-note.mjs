/**
 * 「别的窗口在上一条 QQ 消息之后聊了多少」——纯代码统计，只给条数和时间范围，不给内容。
 * 让 QQ 那边的 AI 知道有这回事，再自己用 memory_search / memory_day 精准调取。
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const dayOf = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`
const hhmm = (x) => { const d = new Date(x); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` }

/**
 * @param {string} worldDir  worlds/default 目录
 * @param {object} [opts]    { maxHours?: number, self?: string }
 * @returns {string}         空串表示没有可提示的
 */
export function otherWindowsNote(worldDir, opts = {}) {
  try {
    const maxHours = Number(opts.maxHours) > 0 ? Number(opts.maxHours) : 24
    const self = String(opts.self || "qq")
    const now = new Date()
    const files = [dayOf(now), dayOf(new Date(now.getTime() - 86_400_000))]
    const oldest = Date.now() - maxHours * 3_600_000
    let lastSelf = 0
    const buckets = new Map()
    for (const day of files) {
      const file = join(worldDir, "conversations", `${day}.jsonl`)
      if (!existsSync(file)) continue
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue
        let r
        try { r = JSON.parse(line) } catch { continue }
        if (!r) continue
        const t = Date.parse(r.t || "")
        if (!Number.isFinite(t) || t < oldest) continue
        if (!String(r.text || "").trim()) continue
        if (r.src === self) { if (t > lastSelf) lastSelf = t; continue }
        const label = r.src === "cli" ? "终端" : r.src === "home" ? "后台" : String(r.src || "").startsWith("group") ? "群聊" : "另一窗口"
        if (!buckets.has(label)) buckets.set(label, [])
        buckets.get(label).push(t)
      }
    }
    const since = lastSelf || Date.now() - 10 * 60_000
    const parts = []
    let total = 0
    for (const [label, ts] of buckets) {
      const hit = ts.filter((t) => t > since).sort((a, b) => a - b)
      if (!hit.length) continue
      total += hit.length
      parts.push(`${label} ${hit.length} 条（${hhmm(hit[0])}–${hhmm(hit[hit.length - 1])}）`)
    }
    if (!total) return ""
    const when = lastSelf ? "上一条 QQ 消息之后" : "最近 10 分钟"
    return `\n（${when}，别的窗口有对话：${parts.join("、")}。想接上就用 memory_search / memory_day 翻，别装没看见。）`
  } catch { return "" }
}
