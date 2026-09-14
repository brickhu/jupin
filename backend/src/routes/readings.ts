import { Hono } from 'hono'
import { eq, and, desc } from 'drizzle-orm'
import { db } from '../db'
import { readings, articles, users } from '../db/schema'
import { assessPronunciation } from '../services/ise'
import { processScoring } from '../services/scoring'

export const readingsRoutes = new Hono()

// 提交录音评分
readingsRoutes.post('/score', async (c) => {
  const userId = c.get('userId') as number

  const formData = await c.req.formData()
  const audioFile = formData.get('audio') as File
  const articleIdStr = formData.get('articleId') as string

  if (!audioFile || !articleIdStr) {
    return c.json({ error: '缺少音频文件或文章 ID' }, 400)
  }

  const articleId = parseInt(articleIdStr)
  if (isNaN(articleId)) {
    return c.json({ error: '无效的文章 ID' }, 400)
  }

  // 获取用户信息
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (!user) {
    return c.json({ error: '用户不存在' }, 404)
  }

  // 获取文章信息
  const [article] = await db
    .select()
    .from(articles)
    .where(eq(articles.id, articleId))
    .limit(1)

  if (!article) {
    return c.json({ error: '文章不存在' }, 404)
  }

  // 检查每日额度
  const today = new Date().toISOString().split('T')[0]
  const lastResetStr = typeof user.dailyResetDate === 'string'
    ? user.dailyResetDate
    : new Date(user.dailyResetDate as any).toISOString().split('T')[0]

  let currentLimit = user.dailySubmissionsLeft
  if (lastResetStr !== today) {
    const isPro = !!(user.subscriptionEnd && new Date(user.subscriptionEnd) > new Date())
    currentLimit = isPro ? 500 : 5
  }

  if (currentLimit <= 0) {
    return c.json({
      error: '今日额度已用完',
      code: 'QUOTA_EXCEEDED',
      message: '免费用户每日 5 次评分，开通 Pro 享每日 500 次',
    }, 429)
  }

  // 判断是否付费用户
  const isPaid = !!(user.subscriptionEnd && new Date(user.subscriptionEnd) > new Date())

  // 调用讯飞 ISE 评分
  let qualityScore: number
  let errorDetail: any = null
  let aiSuggestions: any = null

  try {
    const audioBuffer = Buffer.from(await audioFile.arrayBuffer())
    const referenceText = article.content

    // 从 WAV 中正确提取 PCM 数据（支持非标准头）
    function extractPcm(wav: Buffer): Buffer {
      let off = 12 // 跳过 RIFF + size + WAVE
      while (off < wav.length - 8) {
        const id = wav.toString('utf8', off, off + 4)
        const sz = wav.readUInt32LE(off + 4)
        if (id === 'data') return wav.subarray(off + 8, off + 8 + sz)
        off += 8 + sz
      }
      return wav // fallback: 直接当作 PCM
    }
    const pcmBuffer = extractPcm(audioBuffer)

    const iseResult = await assessPronunciation({
      text: referenceText,
      audioBuffer: pcmBuffer,
      category: 'read_sentence',
    })

    if (iseResult.rejected) {
      return c.json({ error: '未检测到有效语音，请重新朗读' }, 400)
    }

    // Q = ISE 的 total_score
    qualityScore = Math.round(iseResult.totalScore)

    // 提取错误单词（score < 80 的视为有误）
    errorDetail = iseResult.words
      .filter((w) => w.score < 80)
      .map((w) => ({
        word: w.word,
        accuracyScore: w.score,
        syllables: w.syllables,
      }))

    aiSuggestions = null
  } catch (err: any) {
    console.error('ISE scoring error:', err)
    return c.json({ error: err.message || '评分服务异常' }, 500)
  }

  // 计算积分
  const articleDifficulty = parseFloat(String(article.difficulty))
  const result = await processScoring(
    userId,
    articleId,
    qualityScore,
    articleDifficulty,
    isPaid,
    errorDetail,
    aiSuggestions,
    Math.round((audioFile.size / 16000) * 1000), // 估算时长（ms）
  )

  // 免费用户不返回错误详情和 AI 建议
  if (!isPaid) {
    return c.json({
      ...result,
      errorDetail: null,
      aiSuggestions: null,
      article: {
        content: article.content,
        translation: article.translation,
        author: article.author,
        difficulty: article.difficulty,
      },
    })
  }

  return c.json({
    ...result,
    errorDetail,
    aiSuggestions,
    article: {
      content: article.content,
      translation: article.translation,
      author: article.author,
      difficulty: article.difficulty,
    },
  })
})

// 朗读历史（不变）
readingsRoutes.get('/history', async (c) => {
  const userId = c.get('userId') as number
  const page = parseInt(c.req.query('page') || '1')
  const limit = parseInt(c.req.query('limit') || '10')
  const offset = (page - 1) * limit

  const result = await db
    .select({
      id: readings.id,
      qualityScore: readings.qualityScore,
      experienceGained: readings.experienceGained,
      proficiencyBefore: readings.proficiencyBefore,
      proficiencyAfter: readings.proficiencyAfter,
      isPaid: readings.isPaid,
      createdAt: readings.createdAt,
      articleContent: articles.content,
      articleTranslation: articles.translation,
      articleDifficulty: articles.difficulty,
      articleAuthor: articles.author,
    })
    .from(readings)
    .innerJoin(articles, eq(readings.articleId, articles.id))
    .where(eq(readings.userId, userId))
    .orderBy(desc(readings.createdAt))
    .limit(limit)
    .offset(offset)

  return c.json({ readings: result, page, limit })
})

// 朗读详情（不变）
readingsRoutes.get('/:id/detail', async (c) => {
  const userId = c.get('userId') as number
  const readingId = parseInt(c.req.param('id'))

  if (isNaN(readingId)) {
    return c.json({ error: '无效的记录 ID' }, 400)
  }

  const [reading] = await db
    .select()
    .from(readings)
    .where(and(eq(readings.id, readingId), eq(readings.userId, userId)))
    .limit(1)

  if (!reading) {
    return c.json({ error: '记录不存在' }, 404)
  }

  const [u] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const isPaidUser = !!(u && u.subscriptionEnd && new Date(u.subscriptionEnd) > new Date())

  if (!isPaidUser && !reading.isPaid) {
    return c.json({
      id: reading.id,
      qualityScore: reading.qualityScore,
      experienceGained: reading.experienceGained,
      proficiencyBefore: reading.proficiencyBefore,
      proficiencyAfter: reading.proficiencyAfter,
      createdAt: reading.createdAt,
      message: '开通 Pro 或解锁本篇文章查看详细纠音',
    })
  }

  return c.json({
    id: reading.id,
    qualityScore: reading.qualityScore,
    experienceGained: reading.experienceGained,
    proficiencyBefore: reading.proficiencyBefore,
    proficiencyAfter: reading.proficiencyAfter,
    errorDetail: reading.errorDetail,
    aiSuggestions: reading.aiSuggestions,
    audioDuration: reading.audioDuration,
    createdAt: reading.createdAt,
  })
})