import { eq, and, desc, gte } from 'drizzle-orm'
import { db } from '../db'
import { readings, users, articles, userArticleStatus } from '../db/schema'

// 计算 CEFR 等级
export function getCEFRLevel(proficiencyScore: number): string {
  if (proficiencyScore < 40) return 'A1'
  if (proficiencyScore < 55) return 'A2'
  if (proficiencyScore < 70) return 'B1'
  if (proficiencyScore < 85) return 'B2'
  if (proficiencyScore < 95) return 'C1'
  return 'C2'
}

// 计算经验称号
export function getHonorTitle(totalExperience: number): string {
  if (totalExperience >= 20000) return '大师之声'
  if (totalExperience >= 10000) return '语言艺术家'
  if (totalExperience >= 5000) return '声韵使者'
  if (totalExperience >= 2000) return '口语大师'
  if (totalExperience >= 500) return '声音骑士'
  return '朗读者'
}

// 计算能力分 P（最近 20 篇有效朗读的难度加权平均）
export async function calculateProficiency(userId: number): Promise<number> {
  const recentReadings = await db
    .select({
      q: readings.qualityScore,
      d: articles.difficulty,
    })
    .from(readings)
    .innerJoin(articles, eq(readings.articleId, articles.id))
    .where(
      and(
        eq(readings.userId, userId),
        eq(readings.isBest, true),
        gte(readings.qualityScore, '60'),
      )
    )
    .orderBy(desc(readings.createdAt))
    .limit(20)

  let sumQD = 0
  let sumD = 0

  for (const r of recentReadings) {
    const q = parseFloat(String(r.q))
    const d = parseFloat(String(r.d))
    sumQD += q * d
    sumD += d
  }

  if (sumD === 0) return 0
  return Math.round(sumQD / sumD)
}

// 处理单次朗读评分后的所有积分更新
export async function processScoring(
  userId: number,
  articleId: number,
  qualityScore: number,
  articleDifficulty: number,
  isPaid: boolean,
  errorDetail: any,
  aiSuggestions: any,
  audioDuration: number,
) {
  // 1. 获取用户当前状态
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!user) throw new Error('用户不存在')

  // 2. 检查是否同一篇文章已有经验分记录
  const [existingReading] = await db
    .select({ id: readings.id })
    .from(readings)
    .where(
      and(
        eq(readings.userId, userId),
        eq(readings.articleId, articleId),
        gte(readings.qualityScore, '30'),
      )
    )
    .limit(1)

  const isFirstValid = !existingReading

  // 3. 计算经验分 E
  let experienceGained = 0
  if (isFirstValid && qualityScore >= 30) {
    experienceGained = Math.round(articleDifficulty * 100)
  }

  // 4. 更新用户文章状态
  const [existingStatus] = await db
    .select()
    .from(userArticleStatus)
    .where(
      and(
        eq(userArticleStatus.userId, userId),
        eq(userArticleStatus.articleId, articleId),
      )
    )
    .limit(1)

  const isConquered = qualityScore >= 70
  const isPerfect = qualityScore >= 90
  const prevBestScore = existingStatus ? parseFloat(String(existingStatus.bestScore)) : 0
  const isNewBest = qualityScore > prevBestScore

  if (existingStatus) {
    await db
      .update(userArticleStatus)
      .set({
        bestScore: isNewBest ? String(qualityScore) : existingStatus.bestScore,
        isConquered: isConquered || existingStatus.isConquered,
        isPerfect: isPerfect || existingStatus.isPerfect,
        attempts: existingStatus.attempts + 1,
        bestReadAt: isNewBest ? new Date() : existingStatus.bestReadAt,
      })
      .where(eq(userArticleStatus.id, existingStatus.id))
  } else {
    await db.insert(userArticleStatus).values({
      userId,
      articleId,
      bestScore: String(qualityScore),
      isConquered,
      isPerfect,
      isUnlocked: isPaid,
      attempts: 1,
      bestReadAt: new Date(),
    })
  }

  // 5. 生成 reading_id（使用时间戳+随机数模拟 bigint）
  const readingId = Date.now() * 1000 + Math.floor(Math.random() * 1000)

  // 6. 插入朗读记录
  const proficiencyBefore = parseFloat(String(user.proficiencyScore))

  await db.insert(readings).values({
    id: readingId,
    userId,
    articleId,
    qualityScore: String(qualityScore),
    experienceGained,
    proficiencyBefore: String(proficiencyBefore),
    proficiencyAfter: String(proficiencyBefore), // 暂存旧值，待计算后更新
    isPaid,
    isBest: isNewBest,
    errorDetail: errorDetail || null,
    aiSuggestions: aiSuggestions || null,
    audioDuration,
  })

  // 7. 更新能力分 P（仅 Q >= 60）
  let newProficiency = proficiencyBefore
  if (qualityScore >= 60) {
    // 如果同篇有旧的最佳记录，先标记 is_best = false
    if (isNewBest) {
      await db
        .update(readings)
        .set({ isBest: false })
        .where(
          and(
            eq(readings.userId, userId),
            eq(readings.articleId, articleId),
            gte(readings.qualityScore, '60'),
          )
        )
      // 重置当前记录为最佳
      await db
        .update(readings)
        .set({ isBest: true })
        .where(eq(readings.id, readingId))
    }

    newProficiency = await calculateProficiency(userId)
  }

  // 8. 更新用户表
  const newTotalExperience = user.totalExperience + experienceGained
  const newHonorTitle = getHonorTitle(newTotalExperience)

  // 更新连胜
  const today = new Date()
  const todayStr = today.toISOString().split('T')[0]

  // dailyResetDate 在 postgres.js 中 date 类型返回为字符串 YYYY-MM-DD
  const lastResetStr = typeof user.dailyResetDate === 'string'
    ? user.dailyResetDate
    : new Date(user.dailyResetDate as any).toISOString().split('T')[0]

  let newStreakDays = user.streakDays

  if (user.lastReadAt) {
    const lastReadDate = new Date(user.lastReadAt).toISOString().split('T')[0]
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayStr = yesterday.toISOString().split('T')[0]

    if (lastReadDate === todayStr) {
      // 今天已读过，streak 不变
    } else if (lastReadDate === yesterdayStr) {
      newStreakDays = user.streakDays + 1
    } else {
      newStreakDays = 1 // 断签
    }
  } else {
    newStreakDays = 1
  }

  // 如果日期已重置，dailySubmissionsLeft 已在路由层更新，这里用传入的 currentLimit
  // 否则用 user.dailySubmissionsLeft
  const newDailySubmissionsLeft = lastResetStr !== todayStr
    ? (user.subscriptionEnd && new Date(user.subscriptionEnd) > new Date() ? 500 : 5) - 1
    : user.dailySubmissionsLeft - 1

  await db
    .update(users)
    .set({
      proficiencyScore: String(newProficiency),
      totalExperience: newTotalExperience,
      honorTitle: newHonorTitle,
      streakDays: newStreakDays,
      lastReadAt: new Date(),
      dailySubmissionsLeft: newDailySubmissionsLeft,
      dailyResetDate: todayStr,
    })
    .where(eq(users.id, userId))

  // 更新 reading 记录的 proficiencyAfter
  await db
    .update(readings)
    .set({ proficiencyAfter: String(newProficiency) })
    .where(eq(readings.id, readingId))

  const cefr = getCEFRLevel(newProficiency)

  return {
    readingId,
    qualityScore,
    experienceGained,
    proficiencyBefore,
    proficiencyAfter: newProficiency,
    cefr,
    totalExperience: newTotalExperience,
    honorTitle: newHonorTitle,
    streakDays: newStreakDays,
    isConquered,
    isPerfect,
    isFirstValid,
  }
}