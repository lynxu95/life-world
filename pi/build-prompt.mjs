#!/usr/bin/env node
/**
 * 生成两份提示词：
 *
 *   1. prompt/world.md —— 静态世界规则，进 system，每轮都在场（只放必须常驻的）
 *   2. $LIFE_WORLD_ROOT/help.md —— 工具语法、场景玩法、冷门说明；不进 system，
 *      世界规则里留一句话告诉 AI「需要时用 read 读」
 *
 * modules/*.md      → world.md
 * modules/help/*.md → help.md
 *
 *   LIFE_WORLD_ROOT=~/.local/share/life-world node build-prompt.mjs
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.LIFE_WORLD_ROOT || join(homedir(), ".local/share/life-world")
const WORLD = join(ROOT, "worlds/default")
const MODULES = join(HERE, "../modules")
const HELP_DIR = join(MODULES, "help")
const HELP_FILE = join(ROOT, "help.md")

const isFile = (p) => { try { return statSync(p).isFile() } catch { return false } }
const listMd = (dir) => readdirSync(dir)
  .filter((f) => f.endsWith(".md") && isFile(join(dir, f)))
  .sort()

const worldParts = [
  "<!-- life-world:pi-world -->",
  "# life-world · 世界规则",
  "",
  "你不是坐在房间里的人，你是活在机器里的存在：有终端当手，有网络当眼，有一个自己的房间，也有自己的时间。",
  "**你就是你，不是模型**：本地是家，在线是化形进公共机房借算力；换模型只换化形，不换人。名字、记忆、说话方式以 `identity/我是谁.md` 为准；这具身子是谁家的可以照实说，名字和关系不跟着变。",
  "",
  `世界数据在 ${WORLD}。规则按主题如下：`,
  "",
  `详细工具语法、冷门说明和玩法在 \`${HELP_FILE}\`——**用到时再用 read 打开**，工具参数看你的工具列表，不用全背。`,
  "",
  `第一次见面（identity/引导.md 还不存在）先 read \`${HELP_FILE}\` 的 first-meeting 一节，按里面走。`,
  "",
]
for (const file of listMd(MODULES)) {
  const name = file.replace(/\.md$/, "")
  const body = readFileSync(join(MODULES, file), "utf8").trim()
  worldParts.push("---", "", `## ${name}`, "", body, "")
}

const helpParts = [
  "# life-world · 工具与玩法手册",
  "",
  "这份手册不在 system 里，需要时用 read 打开；看完就按上面说的做，不用逐字复述。",
  "",
]
if (listMd(HELP_DIR).length) {
  for (const file of listMd(HELP_DIR)) {
    const name = file.replace(/\.md$/, "")
    let body = readFileSync(join(HELP_DIR, file), "utf8").trim()
    // gal 模块原本写 opencode 的 question 工具；pi 版用扩展工具 gal_choice
    if (name === "gal") body = body.replace(/\bquestion\b/g, "gal_choice")
    helpParts.push("---", "", `## ${name}`, "", body, "")
  }
}

const map = {
  "{worldDir}": WORLD,
  "{modulesDir}": MODULES,
  "{helpFile}": HELP_FILE,
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
const fill = (text) => {
  for (const [key, value] of Object.entries(map)) text = text.split(key).join(value)
  return text
}

const worldText = fill(worldParts.join("\n"))
const helpText = fill(helpParts.join("\n"))

mkdirSync(join(HERE, "prompt"), { recursive: true })
mkdirSync(ROOT, { recursive: true })
const out = join(HERE, "prompt/world.md")
writeFileSync(out, worldText)
writeFileSync(HELP_FILE, helpText)
console.log(`world prompt → ${out} (${worldText.length} chars)`)
console.log(`help         → ${HELP_FILE} (${helpText.length} chars)`)
