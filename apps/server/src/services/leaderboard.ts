import { and, asc, count, desc, eq, gt, lt, max, ne, or, sql, type SQL } from 'drizzle-orm'
import { db } from '../db'
import { participations, submissions, users } from '../db/schema'

/**
 * 竞技数据查询 —— **从参与记录（participations）派生**，没有物化的榜单表。
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
 * ⚠️⚠️ **这一层现在读的是 participations（参与记录），不再自己聚合 submissions。**
 *    一个人在一句上可能有 100 次挑战，但**榜上只有一行** —— 那一行由
 *    services/participations.ts 维护（唯一写入方，重算式，可整表重建）。
 *    榜比的是「参与」，而参与拿什么去比由它指向的**最高分挑战**决定。
 *    ⇒ 所以这里所有查询都不再需要 GROUP BY / COUNT(DISTINCT)：一人一行，
 *      参与人数就是这个句子下的行数。
 *
 * ⭐ 排序是一个**三键全序**（少一个键就会出现「列表顺序和名次对不上」）：
 *
 *    ① 分数降序（best_score）
 *    ② **首次达到该分数**的时刻升序（reached_at；先到者优先）
 *    ③ userId 升序（兜底，保证同分同刻也有确定顺序）
 *
 * ⚠️⚠️ 第②键这里**曾经是错的**：它取的是「该用户在该句的**最早提交**时间」，
 *    而「先到」应该指**先达到这个分数**。反例（真实会发生的）：
 *      A  9:00 读 60 分，20:00 才到 80
 *      B 10:00 第一次就读 80
 *    按「最早提交」排，**A 排在 B 前面** —— 可 B 明明先拿到 80。
 *    ⇒ 现在 reached_at 由 participations 在写入时就算对（取"等于最高分"的那些行
 *      里最早的 created_at），榜单这边只管按它排。
 *
 * ⚠️ 第③键是**抄成长榜的做法**（services/growth-rank.ts 的 asc(users.id)）：
 *    MySQL 对「前两个键都相等」的行**不保证顺序**，两次请求可能换位置，
 *    而且列表名次（按 index 数）会和 getRank 算出来的名次不一致。
 *
 * ⭐ 排序键与索引 participations_arena_idx (article_id, best_score, reached_at, user_id)
 *    **逐列同序**，所以「取前 20」和「数我前面有几个」都能走索引。
 */

export interface RankInfo {
  rank: number
  participantCount: number
  beatenCount: number
  gapToPrev: number | null
}

/** 我在这一句上的最好成绩；没参与过为 null */
export async function getMyBest(articleId: string, userId: number): Promise<number | null> {
  const [row] = await db
    .select({ best: participations.bestScore })
    .from(participations)
    .where(and(eq(participations.articleId, articleId), eq(participations.userId, userId)))
    .limit(1)
  return row?.best === undefined || row?.best === null ? null : Number(row.best)
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
 * ⚠️⚠️ 这一条**必须读 submissions，不能读参与记录**：它问的是
 *    「除了**这一次提交**，我别的挑战里最高多少」，而参与记录里只留了最高那一条 ——
 *    最高分恰好是本次时就答不出来。所以它留在这里，与参与记录分工不同。
 *
 * @returns null 表示这是我在该竞技场的第一条记录
 */
export async function getBestExcluding(
  articleId: string,
  userId: number,
  excludeSubmissionId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ best: max(submissions.score) })
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

/** 三键全序里「排在我前面」的那些参与（分数更高，或同分但我到得更晚，或同分同刻但 id 更大） */
function aheadOfMe(myBest: string, myReached: Date, userId: number): SQL {
  // ⚠️ or() 的类型是 SQL | undefined（它允许传空条件）；这里三个条件都不是空的，加 ! 收口
  return or(
    gt(participations.bestScore, myBest),
    and(eq(participations.bestScore, myBest), lt(participations.reachedAt, myReached)),
    and(
      eq(participations.bestScore, myBest),
      eq(participations.reachedAt, myReached),
      lt(participations.userId, userId),
    ),
  )!
}

/** 三键全序里「排在我后面」的那些（与 aheadOfMe 严格互补，所以同分的人不会被跳过） */
function behindMe(myBest: string, myReached: Date, userId: number): SQL {
  return or(
    lt(participations.bestScore, myBest),
    and(eq(participations.bestScore, myBest), gt(participations.reachedAt, myReached)),
    and(
      eq(participations.bestScore, myBest),
      eq(participations.reachedAt, myReached),
      gt(participations.userId, userId),
    ),
  )!
}

export async function getRank(articleId: string, userId: number): Promise<RankInfo> {
  // 一行就够 —— 参与记录里已经写着我的分数和"达到它的时刻"
  const [mine] = await db
    .select({ best: participations.bestScore, reachedAt: participations.reachedAt })
    .from(participations)
    .where(and(eq(participations.articleId, articleId), eq(participations.userId, userId)))
    .limit(1)
  if (!mine) return { rank: 0, participantCount: 0, beatenCount: 0, gapToPrev: null }

  // ⚠️ DECIMAL 读回来是字符串；比较时用 toFixed(1) 归一成 decimal(5,1) 的写法，
  //    免得 '78.5' 与 78.5 在 SQL 里出现意料之外的形态
  const myBest = Number(mine.best).toFixed(1)
  const myReached = mine.reachedAt

  const [row] = await db
    .select({
      // ⭐ 与我用的**同一个全序**：分数更高算前，同分则先到者算前（同刻再比 id）
      better: count(sql`CASE WHEN ${aheadOfMe(myBest, myReached, userId)} THEN 1 END`),
      total: count(),
    })
    .from(participations)
    .where(eq(participations.articleId, articleId))

  const better = Number(row?.better ?? 0)
  const total = Number(row?.total ?? 0)
  const rank = better + 1

  /**
   * ⭐「上一名」= 排在我前面的那一批里**最后一个** —— 用全序**反过来**排取第一条：
   *    (分数升序, 到达时刻降序, id 降序)。
   */
  const [prev] = await db
    .select({ score: participations.bestScore })
    .from(participations)
    .where(and(eq(participations.articleId, articleId), aheadOfMe(myBest, myReached, userId)))
    .orderBy(asc(participations.bestScore), desc(participations.reachedAt), desc(participations.userId))
    .limit(1)

  return {
    rank,
    participantCount: total,
    beatenCount: Math.max(0, total - rank),
    gapToPrev: prev ? Number(prev.score) - Number(myBest) : null,
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
  const rows = await db
    .select({ userId: participations.userId, score: participations.bestScore, nickname: users.nickname })
    .from(participations)
    .leftJoin(users, eq(users.id, participations.userId))
    .where(eq(participations.articleId, articleId))
    // ⚠️ 三个键都要给：只给前两个的话，同分同刻的行顺序由 MySQL 决定，
    //    列表里显示的名次（按 index 数）会和 getRank 算出来的对不上
    .orderBy(
      desc(participations.bestScore),
      asc(participations.reachedAt),
      asc(participations.userId),
    )
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
  const [mine] = await db
    .select({ best: participations.bestScore, reachedAt: participations.reachedAt })
    .from(participations)
    .where(and(eq(participations.articleId, articleId), eq(participations.userId, userId)))
    .limit(1)
  if (!mine) return []

  const myBest = Number(mine.best).toFixed(1)
  const myReached = mine.reachedAt

  /**
   * ⚠️⚠️ 上下两侧必须用**与 getRank 完全相同的全序**（不是只比分数）。
   *    以前只按分数严格大于 / 小于取，于是**和我同分的人一个都不出现**：
   *    榜上明明有 5 个人都是 78，我的"上下各两条"里却一个 78 都没有，
   *    而下面那条被标成"第 10 名"—— 实际我是第 12。
   */
  const above = await db
    .select({ userId: participations.userId, score: participations.bestScore, nickname: users.nickname })
    .from(participations)
    .leftJoin(users, eq(users.id, participations.userId))
    .where(and(eq(participations.articleId, articleId), aheadOfMe(myBest, myReached, userId)))
    // 离我最近的两条 = 全序**反过来**取前两条
    .orderBy(asc(participations.bestScore), desc(participations.reachedAt), desc(participations.userId))
    .limit(2)

  const below = await db
    .select({ userId: participations.userId, score: participations.bestScore, nickname: users.nickname })
    .from(participations)
    .leftJoin(users, eq(users.id, participations.userId))
    .where(and(eq(participations.articleId, articleId), behindMe(myBest, myReached, userId)))
    .orderBy(desc(participations.bestScore), asc(participations.reachedAt), asc(participations.userId))
    .limit(2)

  const ordered = [
    ...above.reverse(),
    { userId, score: mine.best, nickname: null as string | null },
    ...below,
  ]
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

  const inIds = sql`${participations.articleId} IN (${sql.join(articleIds.map((i) => sql`${i}`), sql`, `)})`

  const [totals, mine] = await Promise.all([
    db
      .select({
        articleId: participations.articleId,
        // 一人一行 ⇒ 参与人数就是行数，不再需要 COUNT(DISTINCT user_id)
        participants: count(),
        top: max(participations.bestScore),
      })
      .from(participations)
      .where(inIds)
      .groupBy(participations.articleId),
    db
      .select({
        articleId: participations.articleId,
        best: participations.bestScore,
        attempts: participations.attempts,
      })
      .from(participations)
      .where(and(inIds, eq(participations.userId, userId))),
  ])

  for (const row of totals) {
    out.set(row.articleId, {
      participantCount: Number(row.participants ?? 0),
      topScore: row.top === null || row.top === undefined ? null : Number(row.top),
      myBest: null,
      myAttempts: 0,
    })
  }
  for (const row of mine) {
    const cur = out.get(row.articleId)
    if (!cur) continue
    cur.myBest = Number(row.best)
    cur.myAttempts = Number(row.attempts ?? 0)
  }
  return out
}
