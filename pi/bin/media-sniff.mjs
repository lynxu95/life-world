/**
 * 媒体文件头识别 + SILK 兜底转换。
 *
 * 背景：OneBot 的 `get_record(out_format="mp3")` 在不少实现上会把同一条记录
 * 原样返回 SILK（文件头 `#!SILK_V3`，前面有时还带一个 0x02）。桥接如果照着
 * `.mp3` 落盘，下游 ffmpeg 解不了 SILK，听起来只有一声「滋」。
 *
 * 这里只看文件头，按真实格式给扩展名；SILK 再用外部解码器转成 wav。
 * ffmpeg 本身不支持 SILK，解码器有两种：
 *   - pip 版：`pip install pilk`（Linux/macOS 上是 sdist，要编译器；输出 PCM）
 *   - C 版：kn007/silk-v3-decoder 的 `silk_v3_decoder`（输出 PCM）
 * 都没有就原样保留 .silk，并在消息里告诉会话「这条听不了」。
 */
import { spawnSync } from "node:child_process"
import { existsSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const ROOT = process.env.LIFE_WORLD_ROOT || join(homedir(), ".local/share/life-world")

/** 按文件头猜音频扩展名；认不出返回 "" */
export function sniffAudioExt(buf) {
  if (!buf || buf.length < 4) return ""
  const head = Buffer.from(buf.subarray(0, 32))
  const txt = head.toString("latin1")
  if (txt.includes("#!SILK")) return ".silk"                       // #!SILK_V3（可能前面还有 0x02）
  if (txt.startsWith("#!AMR")) return ".amr"
  if (txt.startsWith("RIFF") && txt.slice(8, 12) === "WAVE") return ".wav"
  if (txt.startsWith("OggS")) return ".ogg"
  if (txt.startsWith("ID3")) return ".mp3"
  // 不做裸 MPEG 帧同步判断：UTF-16 的 FF FE / FF FF 也能凑出合法的帧头，
  // 没有 ID3 的 mp3 就沿用 OneBot 给的原扩展名，够用了。
  if (txt.slice(4, 8) === "ftyp") return ".m4a"
  return ""
}

/** 按优先级给几个 python：显式指定的 → 插件自己的 venv → 系统 python3 */
export function pythonCandidates() {
  const list = []
  if (process.env.LIFE_WORLD_PYTHON) list.push(process.env.LIFE_WORLD_PYTHON)
  const venv = join(ROOT, "venv", "bin", "python")
  if (existsSync(venv)) list.push(venv)
  list.push("python3")
  return [...new Set(list)]
}

/** 解码器探测结果缓存：同一次桥接进程里不重复起 python */
let decoderCache
/**
 * 找本机能解 SILK 的东西。
 * 返回 "pilk:<python>" 表示用 pip 的 pilk；返回路径表示 C 解码器；没有返回 ""。
 * 装上 pilk 最简单的办法：往插件自己的 venv 里装
 * （`<ROOT>/venv/bin/python -m pip install pilk`），这里会自动优先用它。
 */
export function findSilkDecoder() {
  if (decoderCache !== undefined) return decoderCache
  for (const py of pythonCandidates()) {
    try {
      const r = spawnSync(py, ["-c", "import pilk"], { encoding: "utf8", timeout: 3000 })
      if (r.status === 0) { decoderCache = `pilk:${py}`; return decoderCache }
    } catch { /* 没有 pilk 就继续找 C 版 */ }
  }
  for (const name of ["silk_v3_decoder", "silk-decoder"]) {
    try {
      const r = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8", timeout: 3000 })
      const p = String(r.stdout || "").trim()
      if (r.status === 0 && p) { decoderCache = p; return decoderCache }
    } catch { /* 试下一个 */ }
  }
  decoderCache = ""
  return decoderCache
}

/**
 * SILK → wav：先出 24k 单声道 PCM，再让 ffmpeg 包成 wav。
 * 任何一步失败都返 ""（并清掉半截产物），调用方保留原始 .silk 文件。
 */
export function convertSilkToWav(silkPath, wavPath) {
  const dec = findSilkDecoder()
  if (!dec) return ""
  const pcm = `${wavPath}.pcm`
  const cleanup = () => {
    for (const f of [pcm, wavPath]) { try { unlinkSync(f) } catch { /* 本来就没有 */ } }
  }
  try {
    let ok = false
    if (dec.startsWith("pilk:")) {
      const py = dec.slice(5)
      const r = spawnSync(py, ["-c", "import pilk,sys; pilk.decode(sys.argv[1], sys.argv[2], pcm_rate=24000)", silkPath, pcm], { encoding: "utf8", timeout: 30000 })
      ok = r.status === 0
    } else {
      const r = spawnSync(dec, [silkPath, pcm], { encoding: "utf8", timeout: 30000 })
      ok = r.status === 0
    }
    if (!ok) { cleanup(); return "" }
    const f = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", pcm, wavPath], { encoding: "utf8", timeout: 30000 })
    if (f.status !== 0 || !existsSync(wavPath)) { cleanup(); return "" }
    return wavPath
  } catch {
    cleanup()
    return ""
  } finally {
    try { unlinkSync(pcm) } catch { /* ignore */ }
  }
}
