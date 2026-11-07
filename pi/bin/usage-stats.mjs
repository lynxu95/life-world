/** 从 pi-sessions 汇总用量：按天统计 token / 费用 / 云端本地 / 模型切换 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const ROOT = process.env.LIFE_WORLD_ROOT || join(homedir(), ".local/share/life-world")

export function usageStats(days = 7) {
  const dir = join(ROOT, "pi-sessions")
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
        if (entry.type === "model_change") { switches++; continue }
        if (entry.type !== "message") continue
        const m = entry.message || {}
        if (m.role !== "assistant") continue
        const ts = Date.parse(entry.timestamp || "") || Number(m.timestamp) || 0
        if (!ts || ts < since) continue
        const day = new Date(ts).toISOString().slice(0, 10)
        const row = byDay.get(day) || { day, req: 0, input: 0, output: 0, cacheRead: 0, cost: 0, cloud: 0, local: 0 }
        const u = m.usage || {}
        row.req++
        row.input += Number(u.input || 0)
        row.output += Number(u.output || 0)
        row.cacheRead += Number(u.cacheRead || 0)
        row.cost += Number(u.cost?.total ?? u.cost ?? 0)
        const provider = String(m.provider || "")
        if (["deepseek", "anthropic", "openai", "google"].includes(provider)) row.cloud++
        else row.local++
        byDay.set(day, row)
      }
    }
  }
  const list = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
  const total = list.reduce((acc, r) => {
    acc.req += r.req; acc.input += r.input; acc.output += r.output; acc.cacheRead += r.cacheRead; acc.cost += r.cost
    acc.cloud += r.cloud; acc.local += r.local
    return acc
  }, { req: 0, input: 0, output: 0, cacheRead: 0, cost: 0, cloud: 0, local: 0 })
  return { days, list, total, switches }
}
