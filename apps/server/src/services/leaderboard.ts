import { and, asc, count, desc, eq, gt, lt, ne, sql } from 'drizzle-orm'
import { db } from '../db'
import { submissions, users } from '../db/schema'

/**
 * 竞技数据查询 —— **从 submissions 派生**（没有物化的榜单表）。
 *
 * ⚠️⚠️ 竞技的单位是**句子**，不是日期。
 *
 *    句子就是竞技场：所有人读同一段文本、比同一个分数，排名天然公平。
 *    日期只是首页那张列表上的一个格子 —— 它指向哪个句子，就进哪个竞技场。
 *    同一句会被排在很多天（池子只有几句、按天轮转），那些天的参与者
 *    **本来就该在同一张榜上**：
 *      · 分天算的话，同一句的参与者被切成好几张榜，每张只剩几个人 ——
 *        名次失去意义（「第 1 名」可能只是那天只有你读了）
 *      · 昨天读过的分数不计入今天，用户会觉得「我之前白读了」
 *
 *    ⇒ 凡是「排名 / 参与人数 / 最高分 / 我的最好成绩」一律按 **articleId** 查。
 *      日期只负责「今天是哪一句」，不参与竞技口径。
 *
 * ⚠️ 唯一的例外是**连续天数（streak）**：它是「每天来读」这件事的度量，
 *    本来就按自然日算，存在 users 表上，与这里无关。
 *
 * 排序：分数降序，同分按「该用户在该句的最早提交时间」升序（先到者优先）。
 * ⚠️ 严格说「先到」应是「先达到该分数」，但那是 correlated 子查询；
 *    这里用「最早提交时间」近似。对榜单语义的影响可忽略，记在这里备查。
 */

export interface RankInfo {
  rank: number
  participantCount: number
  beatenCount: number
  gapToPrev: number | null
}

/** 每个用户在这个竞技场（句子）里的最高分（派生表） */
function bestPerUser(articleId: string) {
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

/** 我在这个竞技场里的最高分 */
export async function getMyBest(articleId: string, userId: number): Promise<number | null> {
  const [row] = await db
    .select({ best: sql<number | null>`MAX(${submissions.score})` })
    .from(submissions)
    .where(
      and(
        eq(submissions.articleId, articleId),
        eq(submissions.userId, userId),
        eq(submissions.status, 'scored'),
      ),
    )
  return row?.best === null || row?.best === undefined ? null : Number(row.best)
}

/**
 * 我在这个竞技场里**除某一条之外**的最好成绩。
 *
 * ⚠️ 为什么需要「排除自己」这一版：
 *    打分是异步的、结果由轮询取回，而 describe() 会被**反复调用**。
 *    用「含自己」的版本，「这次是不是个人最好」就会随轮询次数变化
 *    （第一次算出来是新高、第二次因为已经写进去了就变成持平）——
 *    结果页的「刷新最好成绩」会忽有忽无。
 *    排除自己之后它是**幂等**的：同样的数据永远给同样的答案。
 *
 * @returns null 表示这是我在该竞技场的第一条记录
 */
export async function getBestExcluding(
  articleId: string,
  userId: number,
  excludeSubmissionId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ best: sql<number | null>`MAX(${submissions.score})` })
    .from(submissions)
    .where(
      and(
        eq(submissions.articleId, articleId),
        eq(submissions.userId, userId),
        eq(submissions.status, 'scored'),
        ne(submissions.id, excludeSubmissionId),
      ),
    )
  return row?.best === null || row?.best === undefined ? null : Number(row.best)
}

export async function getRank(articleId: string, userId: number): Promise<RankInfo> {
  const myBest = await getMyBest(articleId, userId)
  if (myBest === null) return { rank: 0, participantCount: 0, beatenCount: 0, gapToPrev: null }

  const [mine] = await db
    .select({ firstAt: sql<Date>`MIN(${submissions.createdAt})` })
    .from(submissions)
    .where(
      and(
        eq(submissions.articleId, articleId),
        eq(submissions.userId, userId),
        eq(submissions.status, 'scored'),
      ),
    )
  const myFirstAt = mine?.firstAt ?? new Date()

  const bests = bestPerUser(articleId)
  const [row] = await db
    .select({
      better: count(sql`CASE WHEN ${bests.best} > ${myBest} THEN 1
        WHEN ${bests.best} = ${myBest} AND ${bests.firstAt} < ${myFirstAt} THEN 1 END`),
      total: count(),
    })
    .from(bests)

  const better = Number(row?.better ?? 0)
  const total = Number(row?.total ?? 0)
  const rank = better + 1

  const [prev] = await db
    .select({ score: bests.best })
    .from(bests)
    .where(gt(bests.best, myBest))
    .orderBy(asc(bests.best))
    .limit(1)

  return {
    rank,
    participantCount: total,
    beatenCount: Math.max(0, total - rank),
    gapToPrev: prev ? Number(prev.score) - myBest : null,
  }
}

export interface LeaderboardRow {
  rank: number
  nickname: string
  score: number
  isMe: boolean
}

/**
 * 完整榜单前 N 名 —— 详情页用。
 * ⚠️ 与 getLeaderboardAround 的区别：那个是「我上下各两条」，结果页用；
 *    这个是**从头往下数**，还没挑战过的人也要能看到前面是谁。
 */
export async function getTopLeaderboard(
  articleId: string,
  userId: number,
  limit = 20,
): Promise<LeaderboardRow[]> {
  const bests = bestPerUser(articleId)
  const rows = await db
    .select({ userId: bests.userId, score: bests.best, nickname: users.nickname })
    .from(bests)
    .leftJoin(users, eq(users.id, bests.userId))
    .orderBy(desc(bests.best), asc(bests.firstAt))
    .limit(limit)

  return rows.map((row, i) => ({
    rank: i + 1,
    nickname: row.userId === userId ? '你' : (row.nickname ?? '挑战者'),
    score: Number(row.score),
    isMe: row.userId === userId,
  }))
}

/** 榜心：我的上下各两条 */
export async function getLeaderboardAround(
  articleId: string,
  userId: number,
  limit = 5,
): Promise<LeaderboardRow[]> {
  const myBest = await getMyBest(articleId, userId)
  if (myBest === null) return []

  const bests = bestPerUser(articleId)

  const above = await db
    .select({ userId: bests.userId, score: bests.best, nickname: users.nickname })
    .from(bests)
    .leftJoin(users, eq(users.id, bests.userId))
    .where(gt(bests.best, myBest))
    .orderBy(asc(bests.best))
    .limit(2)

  const below = await db
    .select({ userId: bests.userId, score: bests.best, nickname: users.nickname })
    .from(bests)
    .leftJoin(users, eq(users.id, bests.userId))
    .where(lt(bests.best, myBest))
    .orderBy(desc(bests.best))
    .limit(2)

  const ordered = [...above.reverse(), { userId, score: myBest, nickname: null }, ...below]
  const { rank } = await getRank(articleId, userId)
  const startRank = Math.max(1, rank - above.length)

  return ordered.slice(0, limit).map((row, i) => ({
    rank: startRank + i,
    nickname: row.userId === userId ? '你' : (row.nickname ?? '挑战者'),
    score: Number(row.score),
    isMe: row.userId === userId,
  }))
}

/**
 * 一次查多个**竞技场（句子）**的汇总统计。
 *
 * ⚠️ 首页要列 7 天，而其中好几天可能指向同一句 ——
 *    所以入参是**去重后的 articleId**，返回按 articleId 索引。逐天查就是 21 次往返。
 */
export interface ArenaStats {
  participantCount: number
  topScore: number | null
  myBest: number | null
  /**
   * 我在这个竞技场打过几次分。
   * ⚠️ 只数 status='scored' 的，与参与人数同一口径：
   *    把「音频读不出来 / 引擎判无效」也算进去的话，用户会看到
   *    「你已挑战 3 次」却只有一条成绩，而其中两次他根本没读成 —— 没法解释。
   */
  myAttempts: number
}

export async function getArenaStatsBatch(
  articleIds: string[],
  userId: number,
): Promise<Map<string, ArenaStats>> {
  const out = new Map<string, ArenaStats>()
  if (articleIds.length === 0) return out
  for (const id of articleIds) out.set(id, { participantCount: 0, topScore: null, myBest: null, myAttempts: 0 })

  const inIds = sql`${submissions.articleId} IN (${sql.join(articleIds.map((i) => sql`${i}`), sql`, `)})`

  const [totals, mine] = await Promise.all([
    db
      .select({
        articleId: submissions.articleId,
        participants: sql<number>`COUNT(DISTINCT ${submissions.userId})`,
        top: sql<number | null>`MAX(${submissions.score})`,
      })
      .from(submissions)
      .where(and(inIds, eq(submissions.status, 'scored')))
      .groupBy(submissions.articleId),
    db
      .select({
        articleId: submissions.articleId,
        best: sql<number | null>`MAX(${submissions.score})`,
        attempts: count(),
      })
      .from(submissions)
      .where(and(inIds, eq(submissions.status, 'scored'), eq(submissions.userId, userId)))
      .groupBy(submissions.articleId),
  ])

  for (const row of totals) {
    out.set(row.articleId, {
      participantCount: Number(row.participants ?? 0),
      topScore: row.top === null ? null : Number(row.top),
      myBest: null,
      myAttempts: 0,
    })
  }
  for (const row of mine) {
    const cur = out.get(row.articleId)
    if (!cur) continue
    cur.myBest = row.best === null ? null : Number(row.best)
    cur.myAttempts = Number(row.attempts ?? 0)
  }
  return out
}
