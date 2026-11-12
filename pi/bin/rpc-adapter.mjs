/**
 * pi --mode rpc 的报文契约，全部集中在这里。
 *
 * 桥接不直接读 `msg.type` / `m.stopReason` 这些内部字段——pi 升级改了协议，
 * 只需要改这一个文件，再跑一次冒烟就能确认。
 *
 * 对应 pi 1.5.0 的 dist/modes/rpc/rpc-types.d.ts。
 */

/** 下行报文类型 */
export const MSG = {
  agentStart: "agent_start",
  agentSettled: "agent_settled",
  messageEnd: "message_end",
  response: "response",
  extensionUIRequest: "extension_ui_request",
}

export const isAgentStart = (m) => m?.type === MSG.agentStart
export const isAgentSettled = (m) => m?.type === MSG.agentSettled
export const isMessageEnd = (m) => m?.type === MSG.messageEnd
export const isResponse = (m) => m?.type === MSG.response
export const isExtensionUIRequest = (m) => m?.type === MSG.extensionUIRequest

/** agent_settled 是否因为被中断而结束 */
export const settledAborted = (m) => m?.aborted === true

/**
 * 取内层 message：兼容两种传法——外层报文 `{type:"message_end", message:{...}}`
 * 或直接传内层 `{role, content, stopReason}`。两种都归一化，避免调用方踩层级。
 */
const messageOf = (x) => {
  if (x && typeof x === "object" && x.message && typeof x.message === "object" && "role" in x.message) return x.message
  return x
}
export const isAssistant = (m) => messageOf(m)?.role === "assistant"
export const stopReason = (m) => messageOf(m)?.stopReason
export const isToolUse = (m) => stopReason(m) === "toolUse"
export const isError = (m) => stopReason(m) === "error"
export const errorMessage = (m) => String(messageOf(m)?.errorMessage || "")

const parts = (m) => {
  const content = messageOf(m)?.content
  if (Array.isArray(content)) return content
  // 老版本/某些消息的 content 是字符串，别把它丢掉
  return typeof content === "string" && content ? [{ type: "text", text: content }] : []
}

/** 取这一条消息里的正文 */
export function textOf(m) {
  return parts(m).filter((p) => p?.type === "text").map((p) => p.text).join("\n").trim()
}

/** 取这一条消息里的工具调用（第一个） */
export function toolCallOf(m) {
  const t = parts(m).find((p) => p?.type === "toolCall")
  return t ? { name: String(t.name || "工具"), args: t.arguments || {} } : null
}

/** response 报文 */
export const responseOk = (m) => m?.success === true
export const responseError = (m) => String(m?.error || "command failed")
export const responseData = (m) => m?.data ?? {}

/** 上下文超限：pi 的错误文案可能变，正则只在这里维护 */
const OVERFLOW_RE = /context window|exceeds the context|too many tokens|maximum context/i
export const isOverflow = (m) => isError(m) && OVERFLOW_RE.test(errorMessage(m))

/** 上行请求构造：id 为空时不写这个键，序列化结果与旧写法完全一致 */
const withId = (id, obj) => (id ? { id, ...obj } : obj)
export const reqPrompt = (id, message, images) => withId(id, {
  type: "prompt",
  message,
  ...(images && images.length ? { images } : {}),
})
export const reqAbort = (id) => withId(id, { type: "abort" })
export const reqAbortBash = (id) => withId(id, { type: "abort_bash" })
export const reqExtensionUIResponse = (id, cancelled = true) => ({ type: "extension_ui_response", id, cancelled })
