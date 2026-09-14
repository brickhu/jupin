import { eq, and } from 'drizzle-orm'
import { db } from '../db'
import { pronunciationTips } from '../db/schema'

interface WordError {
  word: string
  errorType: string
  correctPhoneme?: string
  userPhoneme?: string
}

export async function getAISuggestions(wordErrors: WordError[]): Promise<Record<string, string>> {
  const suggestions: Record<string, string> = {}
  const uncached: WordError[] = []

  // 1. 先查缓存
  for (const err of wordErrors) {
    const [cached] = await db
      .select()
      .from(pronunciationTips)
      .where(
        and(
          eq(pronunciationTips.word, err.word),
          eq(pronunciationTips.errorType, err.errorType),
        )
      )
      .limit(1)

    if (cached) {
      suggestions[`${err.word}_${err.errorType}`] = cached.tip

      // 更新命中次数
      await db
        .update(pronunciationTips)
        .set({ hitCount: cached.hitCount + 1 })
        .where(eq(pronunciationTips.id, cached.id))
    } else {
      uncached.push(err)
    }
  }

  // 2. 未缓存的调用 DeepSeek 生成
  if (uncached.length > 0) {
    try {
      const newSuggestions = await generateSuggestions(uncached)

      for (const err of uncached) {
        const key = `${err.word}_${err.errorType}`
        const tip = newSuggestions[key]
        if (tip) {
          suggestions[key] = tip

          // 缓存到数据库
          await db.insert(pronunciationTips).values({
            word: err.word,
            errorType: err.errorType,
            correctPhoneme: err.correctPhoneme || null,
            userPhoneme: err.userPhoneme || null,
            tip,
          })
        }
      }
    } catch (err) {
      console.error('DeepSeek API error:', err)
      // 静默失败，不阻塞评分流程
    }
  }

  return suggestions
}

async function generateSuggestions(wordErrors: WordError[]): Promise<Record<string, string>> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1'

  if (!apiKey) {
    console.warn('DEEPSEEK_API_KEY 未配置，跳过 AI 建议生成')
    return {}
  }

  const errorsText = wordErrors
    .map(
      (e) =>
        `- 单词: "${e.word}"，错误类型: ${e.errorType}${e.correctPhoneme ? `，正确音标: ${e.correctPhoneme}` : ''}${e.userPhoneme ? `，用户发音: ${e.userPhoneme}` : ''}`
    )
    .join('\n')

  const prompt = `你是一位专业的英语发音教练，面向中国学习者。
以下单词读错了：
${errorsText}

请为每个单词给出1-2句简短的中文发音建议（不超过50字），包括：
1. 口型/舌位提示
2. 中国学习者常见错误提醒

语气友好鼓励，避免术语堆砌。
请以 JSON 格式返回，key 为"单词_错误类型"，value 为建议文本。只返回 JSON，不要其他内容。`

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是一个专业的英语发音教练。只返回 JSON，不要其他内容。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 1000,
    }),
  })

  if (!response.ok) {
    throw new Error(`DeepSeek API error: ${response.status}`)
  }

  const data = await response.json()
  const content = data.choices?.[0]?.message?.content || '{}'

  try {
    // 清理可能的 markdown 代码块标记
    const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    return JSON.parse(jsonStr)
  } catch {
    console.error('Failed to parse DeepSeek response:', content)
    return {}
  }
}