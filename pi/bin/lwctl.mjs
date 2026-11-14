#!/usr/bin/env node
/**
 * lwctl · life-world 会话查看 / 模型热切换（交互式）
 *
 *   lwctl                进入交互菜单
 *   lwctl status         直接打印状态
 *   lwctl set <target> <local|cloud|provider/model> [原因]
 *   lwctl targets
 *   lwctl update [--no-restart] [--project] [--branch <分支>]
 */
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { createHash } from "node:crypto"
import http from "node:http"
import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { spawn, spawnSync } from "node:child_process"
import { backupWorld, backupLog, backupSize } from "./world-backup.mjs"
import { usageStats } from "./usage-stats.mjs"
import { appendCommand, waitAck } from "./control-queue.mjs"

const ROOT = process.env.LIFE_WORLD_ROOT || join(homedir(), ".local/share/life-world")
const STATUS_DIR = join(ROOT, "status")
const CONFIG_FILE = join(ROOT, "life-world.json")

const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, "utf8")) } catch { return fallback } }
const age = (iso) => {
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) return "?"
  if (ms < 15_000) return "刚刚"
  if (ms < 60_000) return `${Math.round(ms / 1000)}s 前`
  return `${Math.round(ms / 60000)}m 前`
}
function sessions() {
  if (!existsSync(STATUS_DIR)) return []
  return readdirSync(STATUS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ file: f, ...readJson(join(STATUS_DIR, f), {}) }))
    .filter((s) => s && s.roleKey && s.model)
    .filter((s) => { try { process.kill(Number(s.pid), 0); return true } catch { return false } })
    .filter((s) => Date.now() - Date.parse(s.updated || 0) < 90_000)
    .sort((a, b) => String(a.roleKey).localeCompare(String(b.roleKey)))
}
const models = () => readJson(CONFIG_FILE, {}).models || {}
const short = (m) => { const s = String(m || "（未就绪）"); return s.length > 46 ? `${s.slice(0, 43)}...` : s }

function render(list) {
  console.log("\n=== life-world 会话 ===")
  if (!list.length) {
    console.log("（没有活跃会话；先起 pi / QQ 桥接 / 家会话）")
    return
  }
  list.forEach((s, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${String(s.roleKey).padEnd(16)} ${short(s.model).padEnd(48)} ${age(s.updated)}`)
  })
}
function describeModel(value) {
  const c = models()
  if (value === "local") return `本地（${c.local || "未配置"}）`
  if (value === "cloud") return `在线（${c.cloud || "未配置"}）`
  return value
}
async function applySwitch(target, value, reason) {
  const c = models()
  const resolved = value === "local" ? c.local : value === "cloud" ? c.cloud : value
  if (!resolved) {
    console.log(`✗ ${value} 没配置（life-world.json 的 models 段）`)
    return false
  }
  const cmd = appendCommand(ROOT, { target, action: "model", model: value, reason: reason || "lwctl 手动切换" })
  process.stdout.write(`  已下发：${target} → ${describeModel(value)} …`)
  if (target === "all") { console.log("\n（全部会话已下发，不等逐个回执）"); return true }
  const st = await waitAck(ROOT, cmd.id, target)
  console.log("")
  if (!st) { console.log("✗ 超时：目标会话没响应（可能没在跑，或 target 写错）"); return false }
  console.log(`${st.ok ? "✓" : "✗"} ${st.msg}`)
  return !!st.ok
}

async function menuSessions(rl) {
  while (true) {
    const list = sessions()
    render(list)
    console.log("  0. 返回    回车. 刷新")
    const a = (await rl.question("选择会话 > ")).trim()
    if (a === "0" || a.toLowerCase() === "q") return
    if (!a) continue
    const idx = Number(a) - 1
    if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) continue
    const target = list[idx].roleKey

    while (true) {
      const c = models()
      console.log(`\n--- ${target}（当前 ${short(list[idx].model)}）---`)
      console.log(`  1. 本地模型  ${c.local || "（未配置）"}`)
      console.log(`  2. 在线模型  ${c.cloud || "（未配置）"}`)
      console.log("  3. 自定义 provider/model")
      console.log("  0. 返回")
      const m = (await rl.question("切到 > ")).trim()
      if (m === "0" || m === "") break
      let value = m === "1" ? "local" : m === "2" ? "cloud" : m === "3" ? (await rl.question("模型（provider/model）> ")).trim() : ""
      if (!value) continue
      const reason = (await rl.question("原因（可空）> ")).trim()
      const ok = await applySwitch(target, value, reason)
      if (ok) { await new Promise((r) => setTimeout(r, 800)); break }
    }
  }
}

async function menuBoard(rl) {
  while (true) {
    const { host, port } = boardSettings()
    const pid = readPid(BOARD_PID)
    const alive = !!pid && pidAlive(pid)
    console.log(`\n=== 看板（${alive ? "运行中" : "未运行"}）===`)
    console.log(`  地址：${boardUrl(host, port)}${pid ? `  PID ${pid}` : ""}`)
    console.log("  1. 启动")
    console.log("  2. 停止")
    console.log("  3. 重启")
    console.log("  4. 状态 / 接口检查")
    console.log("  5. 修改监听地址")
    console.log("  6. 修改监听端口")
    console.log("  7. 同时设置地址和端口")
    console.log("  0. 返回")
    const a = (await rl.question("选择 > ")).trim()
    if (a === "0" || a.toLowerCase() === "q") return
    if (a === "1") await startBoard()
    else if (a === "2") await stopBoard(false)
    else if (a === "3") { await stopBoard(true); await startBoard() }
    else if (a === "4") await boardStatus()
    else if (a === "5" || a === "6" || a === "7") {
      let nextHost, nextPort
      if (a === "5" || a === "7") {
        const v = (await rl.question(`监听地址（当前 ${host}；0.0.0.0 = 局域网）> `)).trim()
        nextHost = validHost(v)
        if (!nextHost) { console.log("✗ 地址不合法"); continue }
      }
      if (a === "6" || a === "7") {
        const v = (await rl.question(`监听端口（当前 ${port}）> `)).trim()
        nextPort = validPort(v)
        if (!nextPort) { console.log("✗ 端口不合法（1-65535）"); continue }
      }
      try { writeBoardSettings(nextHost, nextPort) }
      catch (e) { console.log(`✗ 写入配置失败：${String(e)}`); continue }
      const cur = boardSettings()
      console.log(`✓ 已保存：${boardUrl(cur.host, cur.port)}`)
      const running = readPid(BOARD_PID)
      if (running && pidAlive(running)) {
        console.log("  看板运行中，按新设置重启…")
        await stopBoard(true)
        await startBoard()
      } else console.log("  看板未运行；下次启动使用新设置。")
    }
  }
}

async function menuBackup(rl) {
  while (true) {
    console.log("\n=== 快照 ===")
    console.log("  1. 打快照")
    console.log("  2. 看最近快照")
    console.log("  3. 压缩快照仓库（git gc）")
    console.log("  4. 删除快照目录（危险）")
    console.log("  0. 返回")
    const a = (await rl.question("选择 > ")).trim()
    if (a === "0" || a.toLowerCase() === "q") return
    if (a === "1") {
      const priv = (await rl.question("包含机密抽屉？(y/N) > ")).trim().toLowerCase() === "y"
      cmdBackup(priv ? ["--private"] : [])
    } else if (a === "2") {
      cmdBackupLog()
    } else if (a === "3") {
      cmdBackup(["--gc"])
    } else if (a === "4") {
      const sure = (await rl.question("输入 DELETE 确认删除 worlds/backup > ")).trim()
      if (sure === "DELETE") cmdBackup(["--reset"])
      else console.log("已取消。")
    }
  }
}

async function menuLogs(rl) {
  while (true) {
    console.log("\n=== 日志 ===")
    console.log("  1. QQ 桥接")
    console.log("  2. 家会话")
    console.log("  3. 调试")
    console.log("  0. 返回")
    const a = (await rl.question("选择 > ")).trim()
    if (a === "0" || a.toLowerCase() === "q") return
    const which = a === "1" ? "qq" : a === "2" ? "home" : a === "3" ? "debug" : ""
    if (!which) continue
    const n = Number((await rl.question("行数（默认 40）> ")).trim()) || 40
    cmdTail(which, Math.max(1, Math.min(1000, n)))
  }
}

async function menuUsage(rl) {
  const d = Number((await rl.question("最近几天（默认 7）> ")).trim()) || 7
  cmdUsage(Math.max(1, Math.min(365, d)))
}

async function menuRestart(rl) {
  console.log("\n=== 重启常驻窗口 ===")
  console.log("  1. QQ 桥接")
  console.log("  2. 家会话")
  console.log("  3. 两个都重启")
  console.log("  0. 返回")
  const a = (await rl.question("选择 > ")).trim()
  if (a === "1") cmdRestart("qq")
  else if (a === "2") cmdRestart("home")
  else if (a === "3") cmdRestart("all")
}

async function interactive() {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    while (true) {
      const list = sessions()
      const { host, port } = boardSettings()
      const bpid = readPid(BOARD_PID)
      const balive = !!bpid && pidAlive(bpid)
      console.log("\n=== life-world 控制台 ===")
      console.log(`  会话 ${list.length} 个 · 看板 ${balive ? `运行中 ${boardUrl(host, port)}` : "未运行"}`)
      console.log("  1. 会话与模型切换")
      console.log("  2. 看板（启停 / 地址 / 端口 / 状态）")
      console.log("  3. 快照")
      console.log("  4. 日志")
      console.log("  5. 用量")
      console.log("  6. 重启常驻窗口")
      console.log("  7. 检查更新")
      console.log("  0. 退出    回车. 刷新")
      const a = (await rl.question("选择 > ")).trim()
      if (a === "0" || a.toLowerCase() === "q") break
      if (!a) continue
      if (a === "1") await menuSessions(rl)
      else if (a === "2") await menuBoard(rl)
      else if (a === "3") await menuBackup(rl)
      else if (a === "4") await menuLogs(rl)
      else if (a === "5") await menuUsage(rl)
      else if (a === "6") await menuRestart(rl)
      else if (a === "7") { cmdCheckUpdate([]); await rl.question("回车返回 > ") }
      else console.log("无效选项。")
    }
  } finally {
    rl.close()
  }
}

// —— 快照 / 日志 / 重启 ——
function cmdBackup(args) {
  const backupDir = join(ROOT, "worlds/backup")
  if (args.includes("--reset")) {
    rmSync(backupDir, { recursive: true, force: true })
    console.log(`已删除快照目录：${backupDir}（下次 backup 会重新建）`)
    return true
  }
  if (args.includes("--gc")) {
    if (!existsSync(join(backupDir, ".git"))) { console.log("还没有快照。"); return true }
    const r = spawnSync("git", ["gc", "--prune=now"], { cwd: backupDir, encoding: "utf8" })
    console.log(r.status === 0 ? "✓ 已压缩快照仓库" : `✗ git gc 失败：${r.stderr || ""}`)
    return r.status === 0
  }
  const includePrivate = args.includes("--private")
  if (includePrivate) console.log("注意：--private 会把 机密抽屉 写进 git 历史，之后删不掉")
  const r = backupWorld({ includePrivate })
  console.log(r.ok ? `✓ ${r.msg}` : `✗ ${r.msg}`)
  console.log(`  目录：${r.dir}  工作区：${backupSize()}`)
  const log = backupLog(3)
  if (log.length) console.log(`最近快照：\n  ${log.join("\n  ")}`)
  return r.ok
}
function cmdBackupLog() {
  const log = backupLog(10)
  console.log(log.length ? log.join("\n") : "还没有快照；先跑 lwctl backup")
}
// —— 用量统计 ——
const fmt = (n) => {
  const v = Number(n) || 0
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`
  return String(Math.round(v))
}
function cmdUsage(days = 7) {
  const st = usageStats(days)
  if (!st.list.length) { console.log(`最近 ${days} 天没有用量记录。`); return }
  console.log(`最近 ${days} 天用量（模型切换 ${st.switches} 次）\n`)
  console.log("日期        请求   输入     输出     缓存读    云端/本地     费用")
  for (const r of st.list) {
    console.log(`${r.day}  ${String(r.req).padStart(5)}  ${fmt(r.input).padStart(7)}  ${fmt(r.output).padStart(7)}  ${fmt(r.cacheRead).padStart(7)}  ${String(`${r.cloud}/${r.local}`).padStart(11)}  ${r.cost ? "$" + r.cost.toFixed(4) : "-"}`)
  }
  const t = st.total
  console.log(`${"合计".padEnd(10)}  ${String(t.req).padStart(5)}  ${fmt(t.input).padStart(7)}  ${fmt(t.output).padStart(7)}  ${fmt(t.cacheRead).padStart(7)}`)
}
const LOG_FILES = { qq: "qq-bridge.log", home: "home-rpc.log", debug: "debug.log" }
function cmdTail(which, n) {
  const name = LOG_FILES[which] || LOG_FILES.qq
  const file = join(ROOT, name)
  if (!existsSync(file)) { console.error(`没有日志：${file}`); return false }
  const lines = readFileSync(file, "utf8").trimEnd().split("\n")
  console.log(lines.slice(-(n || 30)).join("\n"))
  return true
}
const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`
/** 和扩展里的默认值保持一致：配置只写了一半时，别一边认为有 cloud、一边认为没有 */
const DEFAULT_CLOUD = "deepseek/deepseek-flash"
function cmdRestart(target) {
  const c = models()
  const cloud = String(c.cloud || DEFAULT_CLOUD)
  let model = process.env.LIFE_WORLD_MODEL || c.local || ""
  // 本地保护模式：常驻窗口直接用在线模型启动，别先起来再切。
  // 锁文件存在但读不出来时按「开着」处理（和扩展一样 fail-closed）。
  try {
    if (existsSync(join(ROOT, "local-lock.json"))) {
      let locked = true
      try { locked = JSON.parse(readFileSync(join(ROOT, "local-lock.json"), "utf8")).enabled !== false } catch { /* 坏文件按开着 */ }
      if (locked) model = cloud  // 锁定期间一律在线，连 shell 里导出的本地模型也不认
      else model = process.env.LIFE_WORLD_MODEL || c.local || ""
    }
  } catch { /* 读不了就照旧 */ }
  if (model && !/^[A-Za-z0-9._:/@-]+$/.test(model)) {
    console.error(`模型名不合法，拒绝执行：${model}`)
    return false
  }
  const piBin = process.env.PI_BIN || ""
  const pathPrefix = piBin
    ? `${shq(join(piBin, ".."))}:`
    : `${shq(join(process.env.HOME || "", ".local/bin"))}:${shq(join(process.env.HOME || "", ".pi/agent/bin"))}:`
  const results = []
  const run = (name, script) => {
    // 用当前 node 的绝对路径：tmux 窗口里的 PATH 不一定是调用方的
    const cmd = `cd ${shq(ROOT)} && PATH=${pathPrefix}$PATH TZ=Asia/Shanghai LIFE_WORLD_MODEL=${shq(model)} ${shq(process.execPath)} ${shq(join(ROOT, "bin", script))} 2>&1 | tee -a ${shq(join(ROOT, `${name}.console.log`))}`
    // tmux 的 target 支持前缀匹配：用 =名字 精确匹配，别把 life-world-xxx 当成 life-world
    const has = spawnSync("tmux", ["has-session", "-t", "=life-world"], { encoding: "utf8" })
    let r
    if (has.status !== 0) {
      r = spawnSync("tmux", ["new-session", "-d", "-s", "life-world", "-n", name, cmd], { encoding: "utf8" })
    } else {
      spawnSync("tmux", ["kill-window", "-t", `life-world:${name}`], { encoding: "utf8" })
      r = spawnSync("tmux", ["new-window", "-t", "life-world", "-n", name, cmd], { encoding: "utf8" })
    }
    results.push({ name, ok: r.status === 0, err: String(r.stderr || "").trim() })
  }
  if (target === "qq" || target === "all") run("qq", "pi-qq-bridge.mjs")
  if (target === "home" || target === "all") run("home", "pi-home-rpc.mjs")
  for (const r of results) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : "：" + (r.err || "tmux 执行失败")}`)
  }
  if (!results.length) { console.log("目标只能是 qq / home / all"); return false }
  return results.every((r) => r.ok)
}

// —— 更新插件 ——
function repoPath() {
  try {
    const p = readFileSync(join(ROOT, "repo-path"), "utf8").trim()
    if (p && existsSync(join(p, ".git"))) return p
  } catch { /* ignore */ }
  try {
    const real = realpathSync(join(ROOT, "ext", "life-world.ts"))
    const repo = dirname(dirname(dirname(real)))
    if (existsSync(join(repo, ".git"))) return repo
  } catch { /* ignore */ }
  return ""
}
function fileHash(file) {
  try { return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12) } catch { return "" }
}
function runGit(repo, args) {
  return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" })
}
function readVersion(repo, ref) {
  if (ref) {
    const r = runGit(repo, ["show", `${ref}:VERSION`])
    return r.status === 0 ? String(r.stdout || "").trim() : ""
  }
  try { return readFileSync(join(repo, "VERSION"), "utf8").trim() } catch { return "" }
}
function currentBranch(repo) {
  const cur = String(runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout || "").trim()
  return cur && cur !== "HEAD" ? cur : "pi-agent-adv"
}

// 只检查、不改任何文件：fetch + 比对本地与远端
function cmdCheckUpdate(args = []) {
  const json = args.includes("--json")
  const quiet = args.includes("--quiet")
  const bi = args.indexOf("--branch")
  const branchArg = bi >= 0 ? String(args[bi + 1] || "").trim() : ""
  const fail = (msg) => {
    // 失败也要落盘：看板靠 checked 时间戳判断「这次检查结束了」
    const payload = { ok: false, error: msg, checked: new Date().toISOString() }
    try { writeFileSync(join(ROOT, "update-check.json"), JSON.stringify(payload, null, 2)) } catch { /* ignore */ }
    if (json) console.log(JSON.stringify(payload))
    else if (!quiet) console.error(msg)
    return 2
  }
  const repo = repoPath()
  if (!repo) return fail("找不到仓库路径（$ROOT/repo-path 和 $ROOT/ext 软链都不在）。请重新跑一次 pi/install.sh。")
  const branch = branchArg || currentBranch(repo)
  const target = `origin/${branch}`
  const local = String(runGit(repo, ["rev-parse", "HEAD"]).stdout || "").trim()
  const fetch = runGit(repo, ["fetch", "origin"])
  if (fetch.status !== 0) return fail(`git fetch 失败（网络不通？）：${String(fetch.stderr || "").trim()}`)
  if (runGit(repo, ["rev-parse", "--verify", target]).status !== 0) return fail(`远端没有分支 ${branch}。`)
  const remote = String(runGit(repo, ["rev-parse", target]).stdout || "").trim()

  let behind = 0
  let ahead = 0
  const counts = String(runGit(repo, ["rev-list", "--left-right", "--count", `HEAD...${target}`]).stdout || "").trim()
  if (counts) {
    const [a, b] = counts.split(/\s+/).map(Number)
    ahead = Number.isFinite(a) ? a : 0
    behind = Number.isFinite(b) ? b : 0
  }
  const log = String(runGit(repo, ["log", "--oneline", `HEAD..${target}`]).stdout || "").trim()
  const commits = log ? log.split("\n").filter(Boolean) : []
  const dirty = String(runGit(repo, ["status", "--porcelain", "--untracked-files=no"]).stdout || "").trim()
  const currentVersion = readVersion(repo)
  const latestVersion = readVersion(repo, target) || currentVersion

  const report = {
    ok: true,
    repo,
    branch,
    current: { version: currentVersion, commit: local.slice(0, 7) },
    latest: { version: latestVersion, commit: remote.slice(0, 7) },
    behind,
    ahead,
    commits,
    dirty: dirty ? dirty.split("\n").filter(Boolean) : [],
  }

  // 顺带落一份缓存给看板读；检查失败不影响结果
  try {
    writeFileSync(join(ROOT, "update-check.json"), JSON.stringify({ ...report, checked: new Date().toISOString() }, null, 2))
  } catch { /* ignore */ }

  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return behind > 0 ? 0 : 1
  }
  if (!quiet) {
    const c = `${currentVersion ? "v" + currentVersion + " · " : ""}${report.current.commit}`
    const l = `${latestVersion ? "v" + latestVersion + " · " : ""}${report.latest.commit}`
    console.log(`当前 ${c}（${branch}）`)
    if (behind > 0) {
      console.log(`远端 ${l}`)
      console.log(`\n落后 ${behind} 个提交${ahead > 0 ? `（本地另有 ${ahead} 个未推送提交）` : ""}：`)
      commits.slice(0, 20).forEach((line) => console.log(`  + ${line}`))
      if (commits.length > 20) console.log(`  ……还有 ${commits.length - 20} 条`)
    } else {
      console.log("✓ 已经是最新版本。")
    }
    if (report.dirty.length) {
      console.log("\n⚠ 仓库有未提交改动，更新前先 commit / stash：")
      report.dirty.slice(0, 10).forEach((line) => console.log(`  ${line}`))
    }
    if (behind > 0) {
      console.log(`\n更新：${ROOT}/bin/lwctl update`)
      console.log("（更新只拉代码、重装脚本与提示词；worlds/default、pi-sessions、life-world.json 都不动）")
    }
  }
  return behind > 0 ? 0 : 1
}

function cmdVersion() {
  const repo = repoPath()
  if (!repo) { console.log("life-world（找不到仓库，无法读版本）"); return }
  const v = readVersion(repo)
  const commit = String(runGit(repo, ["rev-parse", "--short", "HEAD"]).stdout || "").trim()
  const branch = currentBranch(repo)
  console.log(`life-world ${v ? "v" + v : "(无 VERSION)"} · ${commit} (${branch})`)
}

function cmdUpdate(args = []) {
  const startedAt = new Date().toISOString()
  const result = { ok: false, from: "", to: "", version: "", msg: "" }
  // 结果落盘：看板用它显示「更新成功 / 失败原因」，看板重启也不丢
  const finish = (ok, msg) => {
    result.ok = ok
    result.msg = msg
    try {
      writeFileSync(join(ROOT, "update-result.json"), JSON.stringify({
        ...result, version: readVersion(repoPath()), at: new Date().toISOString(), startedAt,
      }, null, 2))
    } catch { /* ignore */ }
    return ok
  }
  const noRestart = args.includes("--no-restart")
  // 沿用当初的安装模式：没显式指定时读 $ROOT/install-mode，别把 project 静默改成 global
  let storedMode = ""
  try { storedMode = readFileSync(join(ROOT, "install-mode"), "utf8").trim() } catch { /* ignore */ }
  const project = args.includes("--project") || (!args.includes("--global") && storedMode === "project")
  const bi = args.indexOf("--branch")
  const branchArg = bi >= 0 ? String(args[bi + 1] || "").trim() : ""
  const repo = repoPath()
  if (!repo) { console.error("找不到仓库路径：$ROOT/repo-path 和 $ROOT/ext 软链都不在。"); return finish(false, "找不到仓库路径，先重跑一次 pi/install.sh") }
  if (!existsSync(join(repo, "pi/install.sh"))) { console.error(`当前仓库不是 pi 版（${repo}），先切到 pi-agent-adv 再更新。`); return finish(false, "当前仓库不是 pi 版（缺 pi/install.sh）") }
  // 只看已跟踪文件的改动；未跟踪文件不会因 ff 合并丢失，冲突时 git 会自己拒绝
  const dirty = runGit(repo, ["status", "--porcelain", "--untracked-files=no"])
  if (dirty.status !== 0) { console.error(`git status 失败：${String(dirty.stderr || "").trim()}`); return finish(false, "git status 失败") }
  if (String(dirty.stdout || "").trim()) {
    console.error("仓库有未提交改动，先 commit / stash 再更新：\n" + String(dirty.stdout).trim())
    return finish(false, "仓库有未提交改动，先 commit / stash")
  }
  const cur = String(runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout || "").trim()
  const branch = branchArg || (cur && cur !== "HEAD" ? cur : "pi-agent-adv")
  const old = String(runGit(repo, ["rev-parse", "HEAD"]).stdout || "").trim()
  result.from = old.slice(0, 7)
  const fetch = runGit(repo, ["fetch", "origin"])
  if (fetch.status !== 0) { console.error(`git fetch 失败：${String(fetch.stderr || "").trim()}`); return finish(false, "git fetch 失败（网络不通？）") }
  const target = `origin/${branch}`
  if (runGit(repo, ["rev-parse", "--verify", target]).status !== 0) { console.error(`远端没有 ${target}。`); return finish(false, `远端没有分支 ${branch}`) }
  console.log(`更新 ${branch}：${old.slice(0, 7)} → ${target} …`)
  const merge = runGit(repo, ["merge", "--ff-only", target])
  if (merge.status !== 0) {
    console.error(`快进合并失败（本地和远端分叉了）：\n${String(merge.stderr || merge.stdout || "").trim()}`)
    console.error(`旧 HEAD：${old}`)
    return finish(false, `快进合并失败，本地和远端分叉了（旧 HEAD ${old.slice(0, 7)}）`)
  }
  const neu = String(runGit(repo, ["rev-parse", "HEAD"]).stdout || "").trim()
  result.to = neu.slice(0, 7)
  if (neu === old) console.log("代码已经是最新。")
  const cfg = join(ROOT, "life-world.json")
  const before = fileHash(cfg)
  const mode = project ? "--project" : "--global"
  const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH || ""}` }
  console.log(`重装脚本 / 提示词 / 软链（${mode}，不改世界数据与配置）…`)
  const inst = spawnSync("bash", [join(repo, "pi/install.sh"), mode], { stdio: "inherit", env, cwd: repo })
  if (inst.status !== 0) {
    console.error(`install.sh 失败（exit ${inst.status}）。旧 HEAD：${old}`)
    console.error(`可回滚：git -C ${repo} reset --hard ${old} && ${join(repo, "pi/install.sh")} ${mode}`)
    return finish(false, `install.sh 失败（exit ${inst.status}）；回滚：git -C ${repo} reset --hard ${old.slice(0, 7)}`)
  }
  const after = fileHash(cfg)
  if (before && after && before === after) console.log("✓ 配置未变（life-world.json 哈希一致）")
  else if (before && after) console.warn("⚠ life-world.json 哈希变了，检查 install 是否动了配置")
  else console.log("（没有 life-world.json，未做哈希对比）")
  console.log(`✓ 已更新到 ${neu.slice(0, 7)}；数据在 ${join(ROOT, "worlds/default")}，配置在 ${cfg}，均未改动。`)
  if (noRestart) { console.log("按 --no-restart 跳过重启；下次 pi / qq / home 启动时生效。"); return finish(true, `已更新到 ${neu.slice(0, 7)}（未重启）`) }
  const self = process.argv[1]
  for (const sub of [["board", "restart"], ["restart", "qq"], ["restart", "home"]]) {
    const r = spawnSync(process.execPath, [self, ...sub], { stdio: "inherit", env: process.env })
    if (r.status !== 0) console.warn(`⚠ lwctl ${sub.join(" ")} 失败（exit ${r.status}）`)
  }
  console.log("✓ 常驻会话已重启；当前终端里的 pi TUI 要自己退出重开才会加载新代码。")
  return finish(true, `已更新到 ${neu.slice(0, 7)}，常驻会话已重启`)
}

// —— Web 看板 ——
const BOARD_PID = join(ROOT, "lwboard.pid")
function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}
function readPid(file) {
  try {
    const pid = Number(readFileSync(file, "utf8").trim())
    return Number.isInteger(pid) && pid > 0 ? pid : 0
  } catch { return 0 }
}
function boardSettings() {
  const c = readJson(CONFIG_FILE, {})
  const b = c && typeof c.board === "object" && c.board ? c.board : {}
  const port = Number(process.env.LW_BOARD_PORT || b.port || 8099)
  return {
    host: String(process.env.LW_BOARD_HOST || b.host || "127.0.0.1"),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 8099,
  }
}
function writeBoardSettings(host, port) {
  const c = readJson(CONFIG_FILE, {})
  if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("life-world.json 不是对象，拒绝写入")
  const b = c.board && typeof c.board === "object" ? c.board : {}
  if (host !== undefined) b.host = host
  if (port !== undefined) b.port = port
  c.board = b
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 })
  renameSync(tmp, CONFIG_FILE)
}
function validHost(value) {
  const h = String(value || "").trim()
  if (!h || h.length > 253 || !/^[A-Za-z0-9_.:-]+$/.test(h)) return ""
  return h
}
function validPort(value) {
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 0
}
function probeHost(host) {
  const h = host || boardSettings().host
  return !h || h === "0.0.0.0" || h === "::" ? "127.0.0.1" : h
}
function httpPid(port, host) {
  return new Promise((resolve) => {
    const req = http.get(`http://${probeHost(host)}:${port}/api/overview`, (res) => {
      let raw = ""
      res.on("data", (d) => { raw += d })
      res.on("end", () => {
        try { resolve(JSON.parse(raw).pid || 0) } catch { resolve(0) }
      })
    })
    req.on("error", () => resolve(-1))
    req.setTimeout(2500, () => { req.destroy(); resolve(-1) })
  })
}
function boardUrl(host, port) { return `http://${host}:${port}` }
/** pidfile 可能是陈旧的、PID 也可能被复用：kill 前确认它还是 lwboard */
function pidIsBoard(pid) {
  // PATH 里先找 ps（NixOS 之类没有 /bin/ps），再退回常见绝对路径
  for (const bin of ["ps", "/bin/ps", "/usr/bin/ps"]) {
    try {
      const r = spawnSync(bin, ["-p", String(pid), "-o", "command="], { encoding: "utf8" })
      if (r.error || r.status !== 0) continue
      // 必须是 node 在跑 lwboard.mjs；node 可执行文件常带后缀（node-22、nodejs20 等）
      return /(^|\/)node[-A-Za-z0-9._]*\s.*lwboard\.mjs/.test(String(r.stdout || ""))
    } catch { /* 试下一个 */ }
  }
  return false
}
async function stopBoard(quiet = false) {
  const pid = readPid(BOARD_PID)
  if (!pid || !pidAlive(pid) || !pidIsBoard(pid)) {
    try { unlinkSync(BOARD_PID) } catch { /* ignore */ }
    if (!quiet) console.log("看板没在运行。")
    return false
  }
  try { process.kill(pid, "SIGTERM") } catch { /* ignore */ }
  for (let i = 0; i < 25 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 200))
  if (pidAlive(pid)) { try { process.kill(pid, "SIGKILL") } catch { /* ignore */ } }
  try { unlinkSync(BOARD_PID) } catch { /* ignore */ }
  if (!quiet) console.log(`已停止看板（PID ${pid}）。`)
  return true
}
async function startBoard() {
  const { host, port } = boardSettings()
  // pid 文件可能丢了（手动删除 / 旧版本没写）：端口上如果有旧看板，先按端口找到并停掉，
  // 否则新进程会撞 EADDRINUSE，update 时看起来「重启了」其实还是旧代码
  const stale = readPid(BOARD_PID)
  if (!stale || !pidAlive(stale)) {
    const answer = await httpPid(port, host)
    if (answer > 0 && pidAlive(answer) && pidIsBoard(answer)) {
      console.log(`发现没有 pid 记录的看板（PID ${answer}），先停掉`)
      try { process.kill(answer, "SIGTERM") } catch { /* ignore */ }
      for (let i = 0; i < 25 && pidAlive(answer); i++) await new Promise((r) => setTimeout(r, 200))
      if (pidAlive(answer)) { try { process.kill(answer, "SIGKILL") } catch { /* ignore */ } }
      try { unlinkSync(BOARD_PID) } catch { /* ignore */ }
    }
  }
  const running = readPid(BOARD_PID)
  if (running && pidAlive(running)) {
    const answer = await httpPid(port, host)
    if (answer === running) {
      console.log(`看板已在运行：${boardUrl(host, port)}（PID ${running}）`)
      return true
    }
    await stopBoard(true)
  }
  const child = spawn(process.execPath, [join(ROOT, "bin", "lwboard.mjs")], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, LW_BOARD_HOST: host, LW_BOARD_PORT: String(port) },
  })
  child.on("error", (e) => console.error(`看板进程启动失败：${String(e)}`))
  child.unref()
  writeFileSync(BOARD_PID, String(child.pid))
  let ok = false
  for (let i = 0; i < 25; i++) {
    if (!pidAlive(child.pid)) break
    const answer = await httpPid(port, host)
    if (answer === child.pid) { ok = true; break }
    if (answer !== -1 && answer !== 0) break
    await new Promise((r) => setTimeout(r, 300))
  }
  if (!ok) {
    try { process.kill(child.pid, "SIGTERM") } catch { /* ignore */ }
    try { unlinkSync(BOARD_PID) } catch { /* ignore */ }
    console.error(`看板启动失败（${boardUrl(host, port)} 没响应）；检查端口占用或监听地址是否存在`)
    return false
  }
  console.log(`看板已启动：${boardUrl(host, port)}（PID ${child.pid}）`)
  if (host === "0.0.0.0" || host === "::") console.log("  监听所有网卡，局域网可访问。")
  return true
}
async function boardStatus() {
  const { host, port } = boardSettings()
  const pid = readPid(BOARD_PID)
  const alive = !!pid && pidAlive(pid)
  if (pid && alive && !pidIsBoard(pid)) console.log(`  · PID ${pid} 已被别的进程占用（不是看板），PID 文件是陈旧的`)
  console.log(`看板：${alive ? "运行中" : "未运行"}`)
  console.log(`  地址：${boardUrl(host, port)}`)
  if (pid) console.log(`  PID：${pid}${alive ? "" : "（已失效）"}`)
  if (alive) {
    const answer = await httpPid(port, host)
    if (answer === pid) console.log("  接口：正常（/api/overview 有响应）")
    else console.log(`  接口：异常（${answer === -1 ? "连接失败" : `响应 PID ${answer}`}）`)
  }
  return alive
}
async function cmdBoard(action = "start", arg = []) {
  if (action === "stop" || action === "off") { await stopBoard(false); return }
  if (action === "restart") { await stopBoard(true); await startBoard(); return }
  if (action === "status") { await boardStatus(); return }
  if (action === "host" || action === "port" || action === "set") {
    let host, port
    if (action === "host") {
      host = validHost(arg[0])
      if (!host) { console.error("地址不合法，例如 127.0.0.1 / 0.0.0.0 / 192.0.2.10"); process.exit(1) }
    } else if (action === "port") {
      port = validPort(arg[0])
      if (!port) { console.error("端口不合法，范围 1-65535"); process.exit(1) }
    } else {
      host = validHost(arg[0])
      port = validPort(arg[1])
      if (!host || !port) { console.error("用法：lwctl board set <地址> <端口>"); process.exit(1) }
    }
    try { writeBoardSettings(host, port) }
    catch (e) { console.error(`写入配置失败：${String(e)}`); process.exit(1) }
    const cur = boardSettings()
    console.log(`已保存看板设置：${boardUrl(cur.host, cur.port)}`)
    if (process.env.LW_BOARD_HOST || process.env.LW_BOARD_PORT) {
      console.log("  注意：环境变量 LW_BOARD_HOST / LW_BOARD_PORT 优先级更高，当前仍可能被环境变量覆盖。")
    }
    const pid = readPid(BOARD_PID)
    if (pid && pidAlive(pid)) {
      console.log("  看板正在运行，按新设置重启…")
      await stopBoard(true)
      await startBoard()
    } else {
      console.log("  看板没在运行；下次 lwctl board start 会用新设置。")
    }
    return
  }
  await startBoard()
}

// —— 非交互子命令（脚本用）——
const [cmd, ...arg] = process.argv.slice(2)
if (!cmd && stdin.isTTY) {
  await interactive()
} else if (!cmd) {
  sessions().forEach((s) => console.log(`${s.roleKey}\t${s.model}\t${age(s.updated)}`))
} else if (cmd === "status" || cmd === "ls") {
  const list = sessions()
  if (!list.length) { console.log("没有活跃会话。"); process.exit(0) }
  for (const s of list) console.log(`${String(s.roleKey).padEnd(16)} ${short(s.model).padEnd(48)} ${age(s.updated)}`)
} else if (cmd === "targets") {
  const names = [...new Set(sessions().map((s) => s.roleKey))]
  console.log(names.length ? names.join("\n") : "（暂无）")
  console.log("\n模型值：local / cloud / provider/model")
} else if (cmd === "set" || cmd === "switch") {
  const [target, value, ...rest] = arg
  if (!target || !value) { console.error("用法：lwctl set <target> <local|cloud|provider/model> [原因]"); process.exit(1) }
  const ok = await applySwitch(target, value, rest.join(" "))
  process.exit(ok ? 0 : 2)
} else if (cmd === "backup") {
  process.exit(cmdBackup(arg) ? 0 : 2)
} else if (cmd === "backups" || cmd === "snapshots") {
  cmdBackupLog()
} else if (cmd === "tail" || cmd === "logs") {
  process.exit(cmdTail(arg[0] || "qq", Number(arg[1]) || 30) ? 0 : 1)
} else if (cmd === "usage" || cmd === "stats") {
  cmdUsage(Number(arg[0]) || 7)
} else if (cmd === "board" || cmd === "web") {
  await cmdBoard(arg[0] || "start", arg.slice(1))
} else if (cmd === "restart") {
  process.exit(cmdRestart(arg[0] || "all") ? 0 : 1)
} else if (cmd === "start" || cmd === "stop") {
  // 起/停全部常驻：看板 + tmux 里的 qq / home。交给对应平台的脚本，它自己补 PATH 和 node
  const isWsl = (() => { try { return /microsoft/i.test(readFileSync("/proc/version", "utf8")) } catch { return false } })()
  const plat = process.platform === "darwin" ? "macos"
    : process.platform === "linux" ? (isWsl ? "wsl" : "linux")
    : ""
  if (!plat) {
    console.error(`✗ 不支持的平台：${process.platform}。原生 Windows 请走 WSL`)
    process.exit(1)
  }
  const script = join(ROOT, "bin", `start-${plat}.sh`)
  if (!existsSync(script)) {
    console.error(`✗ 缺少 ${script}；先跑一次 pi/install.sh 把脚本装进 ${ROOT}/bin/`)
    process.exit(1)
  }
  const r = spawnSync("/bin/bash", [script, ...(cmd === "stop" ? ["--stop"] : [])], { stdio: "inherit", env: process.env })
  if (r.error) { console.error(`✗ 启动脚本运行失败：${String(r.error.message || r.error)}`); process.exit(1) }
  process.exit(r.status ?? 1)
} else if (cmd === "update" || cmd === "upgrade") {
  process.exit(cmdUpdate(arg) ? 0 : 1)
} else if (cmd === "check-update" || cmd === "check") {
  process.exit(cmdCheckUpdate(arg))
} else if (cmd === "version" || cmd === "--version" || cmd === "-v") {
  cmdVersion()
} else {
  console.log(`lwctl · life-world 会话工具

  lwctl                              交互菜单（会话/看板/快照/日志/用量/重启）
  lwctl status                       打印会话与模型
  lwctl targets                      列出可切换目标
  lwctl set <target> <model> [原因]  直接切换

  lwctl backup [--private]           打快照到 worlds/backup（git 增量）
  lwctl backups                      看最近快照
  lwctl tail [qq|home|debug] [行数]  看日志
  lwctl restart [qq|home|all]        重启常驻窗口
  lwctl start                        起全部常驻（看板 + tmux 里的 qq / home，按平台挑脚本）
  lwctl stop                         停全部常驻
  lwctl check-update [--json] [--quiet] [--branch <分支>]
                                      只检查有没有新版本，不改任何文件
                                      --json 输出机器可读结果；--quiet 只给退出码（0 有更新 / 1 最新 / 2 出错）
  lwctl update [--no-restart] [--project] [--branch <分支>]
                                      拉代码 + 重装脚本/提示词；数据/配置不动，默认重启
  lwctl version                      打印当前版本与提交
  lwctl usage [天数]                 用量统计（token / 云端本地 / 切换）
  lwctl board [start|stop|restart|status]  Web 看板
  lwctl board set <地址> <端口>      保存监听设置并重启（如 0.0.0.0 8099）
  lwctl board host <地址>            只改监听地址（0.0.0.0 = 局域网可访问）
  lwctl board port <端口>            只改监听端口

  target：qq / home / group:<群号> / cli
  model ：local / cloud / provider/model`)
}
