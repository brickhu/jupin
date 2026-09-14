import { Hono } from 'hono'
import { eq, and, desc, gte } from 'drizzle-orm'
import { db } from '../db'
import { readings, articles, users } from '../db/schema'

export const statsRoutes = new Hono()

// 能力分曲线（近 90 天）
statsRoutes.get('/proficiency-curve', async (c) => {
  const userId = c.get('userId') as number

  // 查询用户，检查是否付费
  const [user] = await db
    .select({ subscriptionEnd: users.subscriptionEnd })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (!user) {
    return c.json({ error: '用户不存在' }, 404)
  }

  const isPaid = !!(user.subscriptionEnd && new Date(user.subscriptionEnd) > new Date())
  if (!isPaid) {
    return c.json({ error: '付费用户专属功能' }, 403)
  }

  const ninetyDaysAgo = new Date()
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)

  const result = await db
    .select({
      proficiencyAfter: readings.proficiencyAfter,
      createdAt: readings.createdAt,
    })
    .from(readings)
    .where(
      and(
        eq(readings.userId, userId),
        gte(readings.createdAt, ninetyDaysAgo),
        gte(readings.qualityScore, '60'),
      )
    )
    .orderBy(readings.createdAt)

  // 按天聚合，取每天最后一条的能力分
  const dailyMap = new Map<string, number>()
  for (const r of result) {
    if (!r.createdAt) continue
    const dateStr = new Date(r.createdAt).toISOString().split('T')[0]
    dailyMap.set(dateStr, parseFloat(String(r.proficiencyAfter || 0)))
  }

  const data = Array.from(dailyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, score]) => ({ date, score }))

  return c.json({ data })
})

// 质量分散点图（近 30 次）
statsRoutes.get('/quality-scatter', async (c) => {
  const userId = c.get('userId') as number

  const [user] = await db
    .select({ subscriptionEnd: users.subscriptionEnd })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (!user) {
    return c.json({ error: '用户不存在' }, 404)
  }

  const isPaid = !!(user.subscriptionEnd && new Date(user.subscriptionEnd) > new Date())
  if (!isPaid) {
    return c.json({ error: '付费用户专属功能' }, 403)
  }

  const result = await db
    .select({
      qualityScore: readings.qualityScore,
      difficulty: articles.difficulty,
      createdAt: readings.createdAt,
    })
    .from(readings)
    .innerJoin(articles, eq(readings.articleId, articles.id))
    .where(eq(readings.userId, userId))
    .orderBy(desc(readings.createdAt))
    .limit(30)

  const data = result.map((r) => ({
    qualityScore: parseFloat(String(r.qualityScore)),
    difficulty: parseFloat(String(r.difficulty)),
    createdAt: r.createdAt,
  }))

  return c.json({ data })
})

// 经验分累计曲线
statsRoutes.get('/experience-curve', async (c) => {
  const userId = c.get('userId') as number

  const [user] = await db
    .select({ subscriptionEnd: users.subscriptionEnd })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (!user) {
    return c.json({ error: '用户不存在' }, 404)
  }

  const isPaid = !!(user.subscriptionEnd && new Date(user.subscriptionEnd) > new Date())
  if (!isPaid) {
    return c.json({ error: '付费用户专属功能' }, 403)
  }

  const result = await db
    .select({
      experienceGained: readings.experienceGained,
      createdAt: readings.createdAt,
    })
    .from(readings)
    .where(
      and(
        eq(readings.userId, userId),
        gte(readings.qualityScore, '30'),
      )
    )
    .orderBy(readings.createdAt)

  let cumulative = 0
  const data = result.map((r) => {
    cumulative += r.experienceGained || 0
    return {
      date: r.createdAt,
      experience: cumulative,
    }
  })

  return c.json({ data })
})