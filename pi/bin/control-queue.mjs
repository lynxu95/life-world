#!/usr/bin/env node
/**
 * 控制队列：lwctl / lwboard 共用
 *
 *   control/commands-YYYY-MM-DD.jsonl   追加写，一行一条命令
 *   control-acks/<id>-<roleKey>.json    目标进程回执
 *
 * 命令字段：{ id, at, target, action, model, reason, op, alarmId }
 * - id 唯一（时间戳 + 随机），不再用 Date.now() 当序号
 * - 按天分文件，消费方扫今天和昨天；超过 60 秒的命令只推水位不执行
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

const pad = (n) => String(n).padStart(2, "0")
export const dayOfLocal = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const safeKey = (s) => String(s || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_")

export function commandsDir(root) { return join(root, "control") }
export function acksDir(root) { return join(root, "control-acks") }
export function commandsFile(root, day = dayOfLocal()) { return join(commandsDir(root), `commands-${day}.jsonl`) }

/** 追加一条命令；返回 {id, at}。并发写靠 O_APPEND + 单行单次 write。 */
export function appendCommand(root, cmd) {
  const at = Date.now()
  const id = `${at.toString(36)}-${randomUUID().slice(0, 8)}`
  mkdirSync(commandsDir(root), { recursive: true, mode: 0o700 })
  const line = JSON.stringify({ id, at, target: "", action: "model", model: "", reason: "", ...cmd }) + "\n"
  appendFileSync(commandsFile(root), line, { mode: 0o600 })
  return { id, at }
}

/** 读最近 days 天的命令，按 (at,id) 升序 */
export function readCommands(root, days = 2) {
  const out = []
  for (let i = 0; i < days; i++) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const file = commandsFile(root, dayOfLocal(d))
    if (!existsSync(file)) continue
    let text = ""
    try { text = readFileSync(file, "utf8") } catch { continue }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        const c = JSON.parse(line)
        if (c && c.id) out.push(c)
      } catch { /* 跳过半行 */ }
    }
  }
  out.sort((a, b) => Number(a.at) - Number(b.at) || String(a.id).localeCompare(String(b.id)))
  return out
}

export function ackFile(root, id, roleKey) { return join(acksDir(root), `${id}-${safeKey(roleKey)}.json`) }
export function readAck(root, id, roleKey) {
  try { return JSON.parse(readFileSync(ackFile(root, id, roleKey), "utf8")) } catch { return null }
}
export function waitAck(root, id, roleKey, timeoutMs = 12_000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      const st = readAck(root, id, roleKey)
      if (st) return resolve(st)
      if (Date.now() > deadline) return resolve(null)
      setTimeout(tick, 300)
    }
    tick()
  })
}

/** 清理 3 天前的命令文件与回执（家会话每天调一次即可） */
export function pruneCommands(root, keepDays = 3) {
  try {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - keepDays)
    const cut = dayOfLocal(cutoff)
    for (const f of readdirSync(commandsDir(root))) {
      const m = f.match(/^commands-(\d{4}-\d{2}-\d{2})\.jsonl$/)
      if (m && m[1] < cut) { try { unlinkSync(join(commandsDir(root), f)) } catch { /* ignore */ } }
    }
    const acut = Date.now() - keepDays * 86_400_000
    for (const f of readdirSync(acksDir(root))) {
      try { if (statSync(join(acksDir(root), f)).mtimeMs < acut) unlinkSync(join(acksDir(root), f)) } catch { /* ignore */ }
    }
  } catch { /* 目录不存在就算了 */ }
}
