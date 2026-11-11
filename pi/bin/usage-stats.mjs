/** 从 pi-sessions 汇总用量：按天统计 token / 费用 / 云端本地 / 模型切换 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const ROOT = process.env.LIFE_WORLD_ROOT || join(homedir(), ".local/share/life-world")
const CONFIG_FILE = join(ROOT, "life-world.json")
function refs() {
  try {
    const c = JSON.parse(readFileSync(CONFIG_FILE, "utf8"))
    return { local: String(c?.models?.local || ""), cloud: String(c?.models?.cloud || "") }
  } catch { return { local: "", cloud: "" } }
}
const localDay = (ts) => {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function usageStats(days = 7) {
  const dir = join(ROOT, "pi-sessions")
  const cfg = refs()
  const since = Date.now() - Math.max(1, days) * 86_400_000
  const byDay = new Map()
  let switches = 0
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
      let content = ""
      try { content = readFileSync(join(dir, f), "utf8") } catch { continue }
      for (const line of content.split("\n")) {
        if (!line.trim()) continue
        let entry
        try { entry = JSON.parse(line) } catch { continue }
        if (entry.type === "model_change") {
          const ts = Date.parse(entry.timestamp || "") || 0
          if (ts >= since) switches++
          continue
        }
        if (entry.type !== "message") continue
        const m = entry.message || {}
        if (m.role !== "assistant") continue
        const ts = Date.parse(entry.timestamp || "") || Number(m.timestamp) || 0
        if (!ts || ts < since) continue
        const day = localDay(ts)
        const row = byDay.get(day) || { day, req: 0, input: 0, output: 0, cacheRead: 0, cost: 0, cloud: 0, local: 0, models: {} }
        const u = m.usage || {}
        row.req++
        row.input += Number(u.input || 0)
        row.output += Number(u.output || 0)
        row.cacheRead += Number(u.cacheRead || 0)
        const costRaw = u.cost
        const costNum = typeof costRaw === "number" ? costRaw : Number(costRaw?.total ?? 0)
        row.cost += Number.isFinite(costNum) ? costNum : 0
        const ref = `${m.provider || ""}/${m.model || ""}`
        row.models[ref] = (row.models[ref] || 0) + 1
        if (cfg.cloud && ref === cfg.cloud) row.cloud++
        else if (cfg.local && ref === cfg.local) row.local++
        else if (["deepseek", "anthropic", "openai", "google"].includes(String(m.provider || ""))) row.cloud++
        else row.local++
        byDay.set(day, row)
      }
    }
  }
  const list = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
  const total = list.reduce((acc, r) => {
    acc.req += r.req; acc.input += r.input; acc.output += r.output; acc.cacheRead += r.cacheRead; acc.cost += r.cost
    acc.cloud += r.cloud; acc.local += r.local
    for (const [ref, n] of Object.entries(r.models || {})) acc.models[ref] = (acc.models[ref] || 0) + n
    return acc
  }, { req: 0, input: 0, output: 0, cacheRead: 0, cost: 0, cloud: 0, local: 0, models: {} })
  return { days, list, total, switches }
}
