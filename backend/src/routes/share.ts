import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import jwt from 'jsonwebtoken'
import { db } from '../db'
import { readings, articles, users } from '../db/schema'

// 简单的内存存储分享数据（MVP 阶段）
// 生产环境应使用数据库表
const shareStore = new Map<string, any>()

export const shareRoutes = new Hono()

// 创建分享链接（需要登录）
shareRoutes.post('/', async (c) => {
  // 手动验证 JWT
  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: '未登录' }, 401)
  }

  let userId: number
  try {
    const payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET!) as { userId: number }
    userId = payload.userId
  } catch {
    return c.json({ error: 'token 无效或已过期' }, 401)
  }

  const body = await c.req.json()
  const { readingId } = body

  if (!readingId) {
    return c.json({ error: '缺少朗读记录 ID' }, 400)
  }

  // 获取朗读记录
  const [reading] = await db
    .select({
      id: readings.id,
      qualityScore: readings.qualityScore,
      experienceGained: readings.experienceGained,
      proficiencyBefore: readings.proficiencyBefore,
      proficiencyAfter: readings.proficiencyAfter,
      createdAt: readings.createdAt,
      articleContent: articles.content,
      articleTranslation: articles.translation,
      articleAuthor: articles.author,
      articleDifficulty: articles.difficulty,
    })
    .from(readings)
    .innerJoin(articles, eq(readings.articleId, articles.id))
    .where(eq(readings.id, readingId))
    .limit(1)

  if (!reading) {
    return c.json({ error: '朗读记录不存在' }, 404)
  }

  // 获取用户信息
  const [user] = await db
    .select({
      honorTitle: users.honorTitle,
      proficiencyScore: users.proficiencyScore,
      totalExperience: users.totalExperience,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const shareId = `share_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  shareStore.set(shareId, {
    ...reading,
    userHonorTitle: user?.honorTitle || '朗读者',
    userProficiencyScore: user?.proficiencyScore || '0',
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 天过期
  })

  const shareUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/share/${shareId}`

  return c.json({
    shareId,
    shareUrl,
    qualityScore: reading.qualityScore,
  })
})

// 获取分享内容（公开，无需登录）
shareRoutes.get('/:id', async (c) => {
  const shareId = c.req.param('id')

  const data = shareStore.get(shareId)
  if (!data) {
    return c.json({ error: '分享不存在或已过期' }, 404)
  }

  if (data.expiresAt < Date.now()) {
    shareStore.delete(shareId)
    return c.json({ error: '分享已过期' }, 404)
  }

  return c.json({
    qualityScore: data.qualityScore,
    experienceGained: data.experienceGained,
    proficiencyBefore: data.proficiencyBefore,
    proficiencyAfter: data.proficiencyAfter,
    createdAt: data.createdAt,
    articleContent: data.articleContent,
    articleTranslation: data.articleTranslation,
    articleAuthor: data.articleAuthor,
    articleDifficulty: data.articleDifficulty,
    userHonorTitle: data.userHonorTitle,
    userProficiencyScore: data.userProficiencyScore,
  })
})