#!/usr/bin/env node
/**
 * life-world · 天气缓存（Open-Meteo，中文描述）
 *
 * 用法：
 *   node weather.mjs            # 用 life-world.json 里的 care.weatherCity
 *   node weather.mjs 杭州        # 临时查另一个城市（不写配置；只有默认城市才更新缓存）
 *
 * 写 $LIFE_WORLD_ROOT/weather.json，给扩展注入状态行用；网络失败时保留当天旧数据。
 * 测试：LIFE_WORLD_WEATHER_FIXTURE=<{"geocode":…,"forecast":…} 文件>，不发请求。
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const ROOT = process.env.LIFE_WORLD_ROOT || join(homedir(), ".local/share/life-world")
const CONFIG = join(ROOT, "life-world.json")
const OUT = join(ROOT, "weather.json")
const FIXTURE = process.env.LIFE_WORLD_WEATHER_FIXTURE || ""

// WMO 天气代码 → 中文（够用就好，别把每个子类都翻一遍）
const WMO = {
  0: "晴", 1: "大致晴朗", 2: "多云", 3: "阴",
  45: "有雾", 48: "冻雾",
  51: "毛毛雨", 53: "毛毛雨", 55: "毛毛雨",
  56: "冻毛毛雨", 57: "冻毛毛雨",
  61: "小雨", 63: "中雨", 65: "大雨",
  66: "冻雨", 67: "强冻雨",
  71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
  80: "阵雨", 81: "中阵雨", 82: "强阵雨",
  85: "阵雪", 86: "强阵雪",
  95: "雷阵雨", 96: "雷阵雨伴冰雹", 99: "强雷暴伴冰雹",
}
const codeText = (c) => WMO[Number(c)] || (Number.isFinite(Number(c)) ? `天气代码 ${c}` : "")

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")) } catch { return fallback }
}
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, file)
}
function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const cfg = readJson(CONFIG, {})
const argCity = String(process.argv[2] || "").trim()
const cfgCity = String((cfg.care && cfg.care.weatherCity) || "").trim()
const city = argCity || cfgCity
if (!city) {
  console.error("没配城市：先在 life-world.json 写 care.weatherCity，或把城市当参数传进来")
  process.exit(2)
}
const isDefault = !!cfgCity && city === cfgCity

async function geocode(name) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=zh&format=json`
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`geocode http ${res.status}`)
  const d = await res.json()
  const r = d?.results?.[0]
  if (!r) throw new Error(`找不到城市「${name}」`)
  return { lat: r.latitude, lon: r.longitude, name: r.name + (r.admin1 && r.admin1 !== r.name ? `（${r.admin1}）` : "") }
}
async function forecast(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code"
    + "&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1"
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`forecast http ${res.status}`)
  return res.json()
}

let geo, fc
try {
  if (FIXTURE) {
    const f = readJson(FIXTURE, null) || {}
    geo = f.geocode || { lat: 30, lon: 120, name: city }
    fc = f.forecast
    if (!fc) throw new Error("fixture 里没有 forecast")
  } else {
    geo = await geocode(city)
    fc = await forecast(geo.lat, geo.lon)
  }
} catch (e) {
  // 网络失败：当天的旧数据留着用，别把已经拿到的天气抹掉
  const old = readJson(OUT, null)
  if (old && old.ok && old.date === localDay() && old.city === city) {
    console.log(`${city} 天气更新失败（${String(e)}），沿用今天的旧缓存`)
    process.exit(0)
  }
  if (isDefault || !cfgCity) {
    writeAtomic(OUT, JSON.stringify({ city, date: localDay(), at: new Date().toISOString(), ok: false, error: String(e).slice(0, 200) }, null, 2))
  }
  console.error(`${city} 天气更新失败：${String(e)}`)
  process.exit(1)
}

const cur = fc?.current
if (!cur) {
  console.error(`${city} 天气数据不完整，没写缓存`)
  process.exit(1)
}
const daily = fc?.daily || {}
const hi = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[0] : ""
const lo = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[0] : ""
const doc = {
  city: (geo && geo.name) || city,
  date: localDay(),
  at: new Date().toISOString(),
  ok: true,
  desc: codeText(cur.weather_code),
  tempC: cur.temperature_2m != null ? String(Math.round(Number(cur.temperature_2m))) : "",
  feelsC: cur.apparent_temperature != null ? String(Math.round(Number(cur.apparent_temperature))) : "",
  humidity: cur.relative_humidity_2m != null ? String(Math.round(Number(cur.relative_humidity_2m))) : "",
  hi: hi !== "" ? String(Math.round(Number(hi))) : "",
  lo: lo !== "" ? String(Math.round(Number(lo))) : "",
}
// 临时查别的城市时别覆盖默认城市的缓存
if (isDefault || (!argCity && !cfgCity)) writeAtomic(OUT, JSON.stringify(doc, null, 2))
console.log(`${doc.city}：${doc.desc} ${doc.tempC}°C（今天 ${doc.lo}~${doc.hi}°C）`)
