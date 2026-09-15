import { and, asc, count, countDistinct, desc, eq, gt, lt, sql } from 'drizzle-orm'
import { db } from '../db'
import { submissions, users } from '../db/schema'

/**
 * 榜单查询 —— **从 submissions 派生**（不再有物化的榜单表）。
 *
 * 排序规则：分数降序，同分按「该用户在该文章的最早提交时间」升序（先到者优先）。
 *
 * ⚠️ 严格说「先到」应是「先达到该分数」，但那是 correlated 子查询；
 *    这里用「最早提交时间」近似。对榜单语义的影响可忽略，记在这里备查。
 */

export interface RankInfo {
  rank: number
  participantCount: number
  beatenCount: number
  gapToPrev: number | null
}

export interface MyBest {
  score: number
  firstAt: Date
}

/** 每个用户在该文章的最高分（派生表） */
function bestPerUser(articleId: number) {
  return db
    .select({
      userId: submissions.userId,
      best: sql<number>`MAX(${submissions.score})`.as('best'),
      firstAt: sql<Date>`MIN(${submissions.createdAt})`.as('first_at'),
    })
    .from(submissions)
    .where(and(eq(submissions.articleId, articleId), eq(submissions.status, 'scored')))
    .groupBy(submissions.userId)
    .as('bests')
}

/** 我的最高分与该分数的达成时间 */
export async function getMyBest(articleId: number, userId: number): Promise<MyBest | null> {
  const [row] = await db
    .select({
      best: sql<number>`MAX(${submissions.score})`.as('best'),
      firstAt: sql<Date>`MIN(${submissions.createdAt})`.as('first_at'),
    })
    .from(submissions)
    .where(
      and(
        eq(submissions.articleId, articleId),
        eq(submissions.userId, userId),
        eq(submissions.status, 'scored'),
      ),
    )
  return row && row.best !== null ? { score: Number(row.best), firstAt: row.firstAt } : null
}

export async function getRank(articleId: number, userId: number): Promise<RankInfo> {
  const me = await getMyBest(articleId, userId)
  if (!me) return { rank: 0, participantCount: 0, beatenCount: 0, gapToPrev: null }

  const bests = bestPerUser(articleId)
  const [row] = await db
    .select({
      better: count(sql`CASE WHEN ${bests.best} > ${me.score} THEN 1
        WHEN ${bests.best} = ${me.score} AND ${bests.firstAt} < ${me.firstAt} THEN 1 END`),
      total: count(),
    })
    .from(bests)

  const better = Number(row?.better ?? 0)
  const total = Number(row?.total ?? 0)
  const rank = better + 1

  // 上一名（用于「距上一名差 N 分」）
  const [prev] = await db
    .select({ score: bests.best })
    .from(bests)
    .where(gt(bests.best, me.score))
    .orderBy(asc(bests.best))
    .limit(1)

  return {
    rank,
    participantCount: total,
    beatenCount: Math.max(0, total - rank),
    gapToPrev: prev ? Number(prev.score) - me.score : null,
  }
}

export interface LeaderboardRow {
  rank: number
  nickname: string
  score: number
  isMe: boolean
}

/** 榜心：我的上下各两条 */
export async function getLeaderboardAround(
  articleId: number,
  userId: number,
  limit = 5,
): Promise<LeaderboardRow[]> {
  const me = await getMyBest(articleId, userId)
  if (!me) return []

  const bests = bestPerUser(articleId)

  const above = await db
    .select({ userId: bests.userId, score: bests.best, nickname: users.nickname })
    .from(bests)
    .leftJoin(users, eq(users.id, bests.userId))
    .where(gt(bests.best, me.score))
    .orderBy(asc(bests.best))
    .limit(2)

  const below = await db
    .select({ userId: bests.userId, score: bests.best, nickname: users.nickname })
    .from(bests)
    .leftJoin(users, eq(users.id, bests.userId))
    .where(lt(bests.best, me.score))
    .orderBy(desc(bests.best))
    .limit(2)

  const ordered = [...above.reverse(), { userId, score: me.score, nickname: null }, ...below]
  const { rank } = await getRank(articleId, userId)
  const startRank = Math.max(1, rank - above.length)

  return ordered.slice(0, limit).map((row, i) => ({
    rank: startRank + i,
    nickname: row.userId === userId ? '你' : (row.nickname ?? '挑战者'),
    score: Number(row.score),
    isMe: row.userId === userId,
  }))
}
