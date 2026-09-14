// AI 内容批量生成脚本（DeepSeek）
// 用法: pnpm --filter scripts tsx content-generator.ts [count] [difficulty] [theme]

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1'

interface GeneratedArticle {
  content: string
  translation: string
  difficulty: number
  dLen: number
  dVocab: number
  dSyntax: number
  wordCount: number
  sourceType: string
  author: string | null
}

async function generateArticles(
  count: number = 5,
  targetDifficulty: number = 2.0,
  theme: string = '励志名言'
): Promise<GeneratedArticle[]> {
  if (!DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY 未配置')
  }

  const prompt = `你是一个专业的英语教育内容创作者。请生成 ${count} 篇英文短句，要求如下：

主题：${theme}
难度系数目标：${targetDifficulty}/5.0
词数范围：5-50 词
格式：每篇包含英文原文、中文翻译、作者（如果是名言）

请以 JSON 数组格式返回，每篇包含字段：
- content: 英文原文
- translation: 中文翻译
- author: 作者名（如果是名言），否则为 null
- wordCount: 词数

只返回 JSON 数组，不要其他内容。`

  const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是一个专业的英语教育内容创作者。只返回 JSON，不要其他内容。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.8,
      max_tokens: 4000,
    }),
  })

  if (!response.ok) {
    throw new Error(`DeepSeek API error: ${response.status}`)
  }

  const data = await response.json()
  const content = data.choices?.[0]?.message?.content || '[]'

  try {
    const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    const articles = JSON.parse(jsonStr)

    // 计算难度系数
    return articles.map((a: any) => {
      const wordCount = a.content.split(/\s+/).length
      const dLen = wordCount <= 50 ? 0 : Math.min(2.0, (wordCount - 50) / 160)
      const dVocab = 0.3 // 默认值，实际应通过词汇分析
      const dSyntax = 0.3 // 默认值
      const difficulty = Math.min(5.0, 1.0 + dLen + dVocab + dSyntax)

      return {
        content: a.content,
        translation: a.translation,
        difficulty: Math.round(difficulty * 10) / 10,
        dLen: Math.round(dLen * 10) / 10,
        dVocab: Math.round(dVocab * 10) / 10,
        dSyntax: Math.round(dSyntax * 10) / 10,
        wordCount,
        sourceType: 'ai_generated',
        author: a.author || null,
      }
    })
  } catch (err) {
    console.error('Failed to parse DeepSeek response:', content)
    throw err
  }
}

// 主函数
async function main() {
  const args = process.argv.slice(2)
  const count = parseInt(args[0]) || 5
  const difficulty = parseFloat(args[1]) || 2.0
  const theme = args[2] || '励志名言'

  console.log(`生成 ${count} 篇文章，主题: ${theme}，难度: ${difficulty}`)

  try {
    const articles = await generateArticles(count, difficulty, theme)
    console.log(JSON.stringify(articles, null, 2))
    console.log(`\n生成完成，共 ${articles.length} 篇`)
  } catch (err: any) {
    console.error('生成失败:', err.message)
    process.exit(1)
  }
}

main()