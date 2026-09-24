/**
 * ⭐ 文本 LLM 客户端 —— OpenAI 兼容端点（本项目的配置指向 DeepSeek）。
 *
 * ⚠️ 环境变量只有三处来源（见 tools/env.mjs 的分层）：
 *    LLM_API_KEY / LLM_BASE_URL / LLM_MODEL —— 本机在 .env.local。
 * ⚠️ 与 fishaudio 一样**只在这一处碰网**，调用方拿到的永远是「已经归一化好的数据」。
 *
 * ⭐ 两种用法：
 *    · chatJson          —— 直接要一段 JSON（无工具）
 *    · chatJsonWithTools —— **带工具**：模型可以中途调 dict_lookup 查词，最后才给 JSON
 *      这是「ECDICT 作 tool」那条路的实现：**词表数据由模型按需索取**，
 *      代码里不预先算分（2026-09 决定的架构）。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** 只在 role='assistant' 且它要调工具时出现 */
  tool_calls?: RawToolCall[]
  /** 只在 role='tool' 时出现：回给模型的是哪一次调用 */
  tool_call_id?: string
}

interface RawToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** 一个可调用的工具：spec 给模型看，run 在本地执行 */
export interface ToolDef {
  spec: {
    type: 'function'
    function: { name: string; description: string; parameters: Record<string, unknown> }
  }
  run: (args: Record<string, unknown>) => Promise<unknown> | unknown
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

/** 一次 POST，拿回助手的 message（tools 为空时就是普通对话） */
async function post(env: LlmEnv, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(env.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(
        'LLM 返回 ' + res.status + '：' + text.slice(0, 300) +
          '（401/403 = key 不对；404 = 模型名不对；429 = 限流）',
      )
    }
    const parsed = JSON.parse(text) as { choices?: { message?: Record<string, unknown> }[] }
    const message = parsed.choices?.[0]?.message
    if (!message) throw new Error('LLM 没有返回 message：' + text.slice(0, 300))
    return message
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把模型的回复收成 JSON。
 *
 * ⚠️ 带工具时**不能用 response_format: json_object**（两者一起用行为不确定），
 *    所以最后一轮的回复可能带 ```json 围栏 —— 这里把围栏剥掉。
 *    见 chatJson 里那条注释：围栏解析失败的表现是「这一句没有译文」，没人会去怀疑是围栏。
 */
function parseJsonContent<T>(content: string): T {
  const t = String(content ?? '').trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t)
  return JSON.parse(fenced ? fenced[1]! : t) as T
}

/**
 * ⭐ **temperature 一律 0** —— 定级是「一次判定、长期固化进正文」的事情，
 *    同一句话必须每次都判出同一个档位。
 *
 * ⚠️ 实测踩过（2026-09）：0.2 时同一条句子重判会在档位边界上翻面
 *    （2.0 正好是初级 / 中级的分界，一个维度抖 1 分就换一档），
 *    而正文里的档位是给用户看的徽章 —— 换个时间跑一遍就变一个档，没人解释得清。
 * ⚠️ 这也是 docs/research 里那句「temperature 设 0–0.2」的**收紧**：
 *    0.2 对「生成译文」无所谓，对「定级」不行。
 */
const TEMPERATURE = 0

/**
 * 让模型回一段 **JSON**（无工具）。
 *
 * ⚠️ 用 response_format=json_object 而不是「在提示词里求它输出 JSON」：
 *    后者偶尔会带 ```json 围栏或前言，解析失败率不低，而失败时的表现是
 *    「这一句没有译文」—— 没人会去怀疑是模型多打了三个反引号。
 */
export async function chatJson<T>(messages: ChatMessage[]): Promise<T> {
  const env = readEnv()
  const message = await post(env, {
    model: env.model,
    messages,
    temperature: TEMPERATURE,
    response_format: { type: 'json_object' },
  })
  const content = message.content
  if (typeof content !== 'string' || !content) throw new Error('LLM 没有返回内容')
  return parseJsonContent<T>(content)
}

/**
 * ⭐ **带工具**的一次对话：模型可以中途调工具，直到它给出最终 JSON。
 *
 * ⚠️ 为什么要有这条路：词表（ECDICT）里那些 tag / collins / oxford / 词频
 *    是**权威数据**，但让代码预先算好再喂给模型，等于把判断权也一起交出去了。
 *    反过来，把词表做成**工具**，模型就能「我不确定这个词先查一下」——
 *    数据可靠时以数据为准，数据本身缺失时它还能用自己的常识兜（实测 ECDICT
 *    对很多屈折形就是不填 tag/词频，硬算必然误判）。
 *
 * @param maxRounds 最多几轮；到了上限就不给工具、强制它出 JSON（防止无限查词）
 */
export async function chatJsonWithTools<T>(
  messages: ChatMessage[],
  toolDefs: ToolDef[],
  maxRounds = 6,
): Promise<T> {
  const env = readEnv()
  const thread: ChatMessage[] = [...messages]
  const tools = toolDefs.map((t) => t.spec)

  for (let round = 0; round < maxRounds; round++) {
    const last = round === maxRounds - 1
    const message = await post(env, {
      model: env.model,
      messages: thread,
      temperature: TEMPERATURE,
      // ⚠️ 最后一轮**不再给工具**，逼它直接给 JSON；否则它可能一直查到轮次用尽
      ...(last ? { response_format: { type: 'json_object' } } : { tools, tool_choice: 'auto' }),
    })

    const calls = (message.tool_calls as RawToolCall[] | undefined) ?? []
    if (calls.length > 0 && !last) {
      thread.push({
        role: 'assistant',
        content: typeof message.content === 'string' ? message.content : '',
        tool_calls: calls,
      })
      for (const c of calls) {
        const def = toolDefs.find((d) => d.spec.function.name === c.function.name)
        let result: unknown
        try {
          const args = JSON.parse(c.function.arguments || '{}') as Record<string, unknown>
          result = def ? await def.run(args) : { error: '没有这个工具：' + c.function.name }
        } catch (err) {
          // ⚠️ 工具失败**不能抛**：把错误回给模型，它自己决定换个词查或直接判
          result = { error: (err as Error).message }
        }
        thread.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) })
      }
      continue
    }

    const content = message.content
    if (typeof content !== 'string' || !content) throw new Error('LLM 没有返回内容')
    return parseJsonContent<T>(content)
  }
  throw new Error('工具调用轮次用尽，模型仍没给出 JSON')
}
