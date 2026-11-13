#!/usr/bin/env node
/**
 * 控制队列：lwctl / lwboard 共用（消费端在 pi 扩展里）
 *
 *   control/commands-YYYY-MM-DD.jsonl   追加写，一行一条命令
 *   control-acks/<id>-<roleKey>.json    目标进程回执
 *
 * 命令字段：{ id, at, target, action, model, reason, op, alarmId, text, wakeHint }
 * - id 唯一（时间戳 + 随机），不再用 Date.now() 当序号
 * - 按天分文件，消费方扫前后一天；超过 60 秒的命令只推水位不执行
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
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
