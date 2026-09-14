import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { db } from '../db'
import { users, userArticleStatus } from '../db/schema'
import { eq, and } from 'drizzle-orm'

export const userRoutes = new Hono()

function formatUser(user: any) {
  return {
    id: user.id,
    email: user.email,
    nickname: user.nickname,
    proficiencyScore: user.proficiencyScore,
    totalExperience: user.totalExperience,
    honorTitle: user.honorTitle,
    streakDays: user.streakDays,
    subscriptionEnd: user.subscriptionEnd,
    dailySubmissionsLeft: user.dailySubmissionsLeft,
  }
}

userRoutes.get('/me', async (c) => {
  const userId = c.get('userId') as number
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!user) return c.json({ error: '用户不存在' }, 404)

  return c.json(formatUser(user))
})

const updateProfileSchema = z.object({
  nickname: z.string().min(1, '昵称不能为空').max(32, '昵称最长32个字符').optional(),
})

userRoutes.put('/me', zValidator('json', updateProfileSchema), async (c) => {
  const userId = c.get('userId') as number
  const body = c.req.valid('json')

  const updateData: Record<string, any> = {}
  if (body.nickname !== undefined) updateData.nickname = body.nickname

  if (Object.keys(updateData).length === 0) {
    return c.json({ error: '没有需要更新的字段' }, 400)
  }

  const [updated] = await db.update(users)
    .set(updateData)
    .where(eq(users.id, userId))
    .returning()

  if (!updated) return c.json({ error: '用户不存在' }, 404)

  return c.json(formatUser(updated))
})

userRoutes.get('/proficiency', async (c) => {
  const userId = c.get('userId') as number
  const [user] = await db.select({
    proficiencyScore: users.proficiencyScore,
  }).from(users).where(eq(users.id, userId)).limit(1)

  if (!user) return c.json({ error: '用户不存在' }, 404)

  const p = parseFloat(String(user.proficiencyScore))
  let cefr: string
  if (p < 40) cefr = 'A1'
  else if (p < 55) cefr = 'A2'
  else if (p < 70) cefr = 'B1'
  else if (p < 85) cefr = 'B2'
  else if (p < 95) cefr = 'C1'
  else cefr = 'C2'

  // 攻克统计
  const conquered = await db.select().from(userArticleStatus).where(
    and(eq(userArticleStatus.userId, userId), eq(userArticleStatus.isConquered, true))
  )
  const perfect = conquered.filter(r => r.isPerfect)

  return c.json({
    proficiencyScore: user.proficiencyScore,
    cefr,
    totalConquered: conquered.length,
    totalPerfect: perfect.length,
  })
})

userRoutes.get('/experience', async (c) => {
  const userId = c.get('userId') as number
  const [user] = await db.select({
    totalExperience: users.totalExperience,
    honorTitle: users.honorTitle,
    streakDays: users.streakDays,
  }).from(users).where(eq(users.id, userId)).limit(1)

  if (!user) return c.json({ error: '用户不存在' }, 404)

  return c.json({
    totalExperience: user.totalExperience,
    honorTitle: user.honorTitle,
    streakDays: user.streakDays,
  })
})