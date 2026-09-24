/**
 * ⭐ 文本 LLM 客户端 —— OpenAI 兼容端点（本项目的配置指向 DeepSeek）。
 *
 * ⚠️ 环境变量只有三处来源（见 tools/env.mjs 的分层）：
 *    LLM_API_KEY / LLM_BASE_URL / LLM_MODEL —— 本机在 .env.local。
 * ⚠️ 与 fishaudio 一样**只在这一处碰网**，调用方拿到的永远是「已经归一化好的数据」。
 */

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

interface LlmEnv {
  key: string
  baseUrl: string
  model: string
}

function readEnv(): LlmEnv {
  const key = process.env.LLM_API_KEY
  if (!key) throw new Error('缺少 LLM_API_KEY —— 写进 .env.local 后再试')
  /**
   * ⚠️ 两种写法都接受：`https://api.deepseek.com` 与 `https://api.deepseek.com/v1`。
   *    下面统一拼 `/v1/chat/completions` —— 不去掉这个后缀就会变成
   *    `/v1/v1/chat/completions`，报一个 404，而报错信息里完全看不出是配置写重了。
   *    （.env.local.example 里曾经就是这么写的，属于真实踩点。）
   */
  const baseUrl = (process.env.LLM_BASE_URL || 'https://api.deepseek.com')
    .replace(/\/+$/, '')
    .replace(/\/v1$/, '')
  const model = process.env.LLM_MODEL
  if (!model) throw new Error('缺少 LLM_MODEL —— 写进 .env.local 后再试')
  return { key, baseUrl, model }
}

/** 单次调用超时 —— 翻译 / 定级都是短任务，卡住就该报错而不是一直等 */
const TIMEOUT_MS = 60_000

/**
 * 让模型回一段 **JSON**。
 *
 * ⚠️ 用 response_format=json_object 而不是「在提示词里求它输出 JSON」：
 *    后者偶尔会带 ```json 围栏或前言，解析失败率不低，而失败时的表现是
 *    「这一句没有译文」—— 没人会去怀疑是模型多打了三个反引号。
 */
export async function chatJson<T>(messages: ChatMessage[]): Promise<T> {
  const env = readEnv()
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(env.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.model,
        messages,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
      signal: ctl.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(
        'LLM 返回 ' + res.status + '：' + text.slice(0, 300) +
          '（401/403 = key 不对；404 = 模型名不对；429 = 限流）',
      )
    }
    const body = JSON.parse(text) as { choices?: { message?: { content?: string } }[] }
    const content = body.choices?.[0]?.message?.content
    if (!content) throw new Error('LLM 没有返回内容：' + text.slice(0, 300))
    return JSON.parse(content) as T
  } finally {
    clearTimeout(timer)
  }
}
