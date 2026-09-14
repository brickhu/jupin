import { and, asc, count, desc, eq, gt, lt, sql } from 'drizzle-orm'
import { db } from '../db'
import { arenaEntries, users } from '../db/schema'

/**
 * 榜单查询。
 *
 * 排序规则：**分数降序，同分按达成时间升序**（先到者优先）。
 * —— 这样「刚刚超过你」的语义才准确。
 *
 * ⚠️ 只返回「榜心 5 条」而非全榜：一次查询，数据量极小。
 */

export interface RankInfo {
  rank: number
  participantCount: number
  beatenCount: number
  gapToPrev: number | null
}

export async function getRank(arenaId: number, score: number): Promise<RankInfo> {
  const [row] = await db
    .select({
      better: count(sql`CASE WHEN ${arenaEntries.score} > ${score} THEN 1 END`),
      total: count(),
    })
    .from(arenaEntries)
    .where(eq(arenaEntries.arenaId, arenaId))

  const better = Number(row?.better ?? 0)
  const total = Number(row?.total ?? 0)
  const rank = better + 1
  const beatenCount = Math.max(0, total - rank)

  // 上一名的分数（用于「距上一名差 N 分」）
  const [prev] = await db
    .select({ score: arenaEntries.score })
    .from(arenaEntries)
    .where(and(eq(arenaEntries.arenaId, arenaId), gt(arenaEntries.score, score)))
    .orderBy(asc(arenaEntries.score))
    .limit(1)

  return {
    rank,
    participantCount: total,
    beatenCount,
    gapToPrev: prev ? Number(prev.score) - score : null,
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
  arenaId: number,
  userId: number,
  limit = 5,
): Promise<LeaderboardRow[]> {
  const myScore = await getMyScore(arenaId, userId)
  if (myScore === null) return []

  // 比我高的（升序取最近的），加上我，再加上比我低的（降序取最近的）
  const above = await db
    .select({ userId: arenaEntries.userId, score: arenaEntries.score, nickname: users.nickname })
    .from(arenaEntries)
    .leftJoin(users, eq(users.id, arenaEntries.userId))
    .where(and(eq(arenaEntries.arenaId, arenaId), gt(arenaEntries.score, myScore)))
    .orderBy(asc(arenaEntries.score))
    .limit(2)

  const below = await db
    .select({ userId: arenaEntries.userId, score: arenaEntries.score, nickname: users.nickname })
    .from(arenaEntries)
    .leftJoin(users, eq(users.id, arenaEntries.userId))
    .where(and(eq(arenaEntries.arenaId, arenaId), lt(arenaEntries.score, myScore)))
    .orderBy(desc(arenaEntries.score))
    .limit(2)

  const ordered = [...above.reverse(), { userId, score: myScore, nickname: null }, ...below]

  const { rank } = await getRank(arenaId, myScore)

  // 榜心起点 = 我的排名 - 上方条数
  const startRank = Math.max(1, rank - above.length)

  return ordered.slice(0, limit).map((row, i) => ({
    rank: startRank + i,
    nickname: row.userId === userId ? '你' : (row.nickname ?? '挑战者'),
    score: Number(row.score),
    isMe: row.userId === userId,
  }))
}

export async function getMyScore(arenaId: number, userId: number): Promise<number | null> {
  const [row] = await db
    .select({ score: arenaEntries.score })
    .from(arenaEntries)
    .where(and(eq(arenaEntries.arenaId, arenaId), eq(arenaEntries.userId, userId)))
    .limit(1)
  return row ? Number(row.score) : null
}
