import { asc, count, desc, eq, inArray, max, min, sql } from 'drizzle-orm'
import type { ArticleParticipationRow, ArticleStats } from '@jushuo/shared'

import { db } from '../db'
import { participations, users } from '../db/schema'

/**
 * ⭐⭐ **参与资源**（`/api/participations/*`）。
 *
 * 用户 2026-09 定：原来那条"大而全"的 `/api/arenas/{articleId}` 拆掉 ——
 *    句子数据走 `/api/articles/{id}`、**参与者/榜单走这一条**、
 *    我的参与走 `/api/user/participation/{articleId}`、收藏走 `/api/user/is-favorite`。
 *
 * 同一条查询两种用法（`sort`）：
 *   · `sort=score`（榜单）：按最高分倒序 —— 名次就是顺序（rank 由窗口函数给）；
 *   · `sort=time`（参与者）：按最新参与时间倒序 —— "最近谁来过"。
 *
 * ⚠️⚠️ `rank` **与 sort 无关**，永远是按最高分算的全局名次：
 *    按时间排的时候，"这个人是第几名"依然是有用的信息。
 *    它的全序必须与 services/leaderboard.ts 的 `getRank` **完全一致**
 *    （最高分 DESC → 谁先达到 ASC → uid ASC），否则列表里的名次和"我的名次"对不上。
 *
 * ⚠️ 分页用 offset/limit（不是游标）：一行 = 一个用户，量级是几十到几百，
 *    而且 `total` 在同一屏里本来就要显示（"共 N 人参与"）—— offset 够用且更好懂。
 */
export type ParticipationSort = 'time' | 'score'

export interface ArticleParticipationsResult {
  items: ArticleParticipationRow[]
  total: number
}

export async function listArticleParticipations(
  articleId: string,
  opts: { sort: ParticipationSort; limit: number; offset: number },
): Promise<ArticleParticipationsResult> {
  /**
   * ⚠️ 窗口函数直接写在 SELECT 里：MySQL 先算它、再排序分页，
   *    所以 offset 到第 3 页时，第 3 页上的名次依然是**全局**名次（不是页内序号）。
   */
  const rankExpr = sql<number>`RANK() OVER (ORDER BY ${participations.bestScore} DESC, ${participations.reachedAt} ASC, ${participations.userId} ASC)`

  const orderBy =
    opts.sort === 'score'
      ? // 与 rank 的窗口全序保持一致（否则"排序"和"名次"会打架）
        [desc(participations.bestScore), asc(participations.reachedAt), asc(participations.userId)]
      : // 时间序：最近来过的在前；同一毫秒时用 uid 兜底，保证分页不重不漏
        [desc(participations.lastAt), asc(participations.userId)]

  const [rows, totals] = await Promise.all([
    db
      .select({
        rank: rankExpr,
        userId: participations.userId,
        nickname: users.nickname,
        avatarUrl: users.avatarUrl,
        attempts: participations.attempts,
        bestScore: participations.bestScore,
        lastAt: participations.lastAt,
      })
      .from(participations)
      .leftJoin(users, eq(users.id, participations.userId))
      .where(eq(participations.articleId, articleId))
      .orderBy(...orderBy)
      .limit(opts.limit)
      .offset(opts.offset),
    db
      .select({ n: count() })
      .from(participations)
      .where(eq(participations.articleId, articleId)),
  ])

  const items: ArticleParticipationRow[] = rows.map((r) => ({
    // ⚠️ 窗口函数回来的是 BIGINT（mysql2 可能给 number 也可能给 string）——统一成数字
    rank: Number(r.rank),
    userId: r.userId,
    // ⚠️ 与榜单同一条兜底：没起名字的人显示成「挑战者」，不在服务端编昵称
    nickname: r.nickname ?? '挑战者',
    avatarUrl: r.avatarUrl ?? null,
    attempts: Number(r.attempts ?? 0),
    // ⚠️ DECIMAL 读回来是字符串，出去一律 Number（同 participations 其它接口的口径）
    bestScore: Number(r.bestScore),
    lastAt: r.lastAt instanceof Date ? r.lastAt.toISOString() : String(r.lastAt),
  }))

  return { items, total: Number(totals[0]?.n ?? 0) }
}

/**
 * ⭐⭐ **批量参与统计**（`GET /api/participations/stats?ids=a,b,c`）。
 *
 * 用户 2026-09 定的结构（L1 解耦）：统计**不挂在 article / ArticleCard / ArticleDetail 上** ——
 *    它是 `participations` 的聚合派生值，每次现算；句子内容才是可缓存的那一份。
 *    列表页要显示"N 人参与"时，拿这一屏的 id 调**一次**这个接口（一条 GROUP BY），
 *    而不是给每张卡单开统计接口。
 *
 * ⚠️ 与句子生命周期无关：`articleId` 只是 key，句子行不在了（下架 / 内容换版）
 *    有参与记录就照样统计得出来。
 * ⚠️ 返回值**按请求的 ids 零值补齐**（`participantCount: 0` / `topScore: null`）：
 *    端侧可以直接按 articleId 取，不必先判"这一项在不在"。
 */
export async function listArticleStats(articleIds: string[]): Promise<ArticleStats[]> {
  const ids = [...new Set(articleIds.filter((id) => !!id))]
  if (ids.length === 0) return []

  const rows = await db
    .select({
      articleId: participations.articleId,
      // 一人一句一行 ⇒ 参与人数就是行数
      participants: count(),
      top: max(participations.bestScore),
      // ⚠️ 与 max 同一条 SQL、同一个过滤条件 —— 两次数的话它们可能落在不同快照上
      low: min(participations.bestScore),
    })
    .from(participations)
    .where(inArray(participations.articleId, ids))
    .groupBy(participations.articleId)

  const byId = new Map(rows.map((r) => [r.articleId, r]))
  return ids.map((articleId) => {
    const r = byId.get(articleId)
    return {
      articleId,
      participantCount: Number(r?.participants ?? 0),
      // ⚠️ 没人参与时是 null，**不是 0**（0 会被读成"有人拿了 0 分"）
      topScore: r?.top === null || r?.top === undefined ? null : Number(r.top),
      lowestScore: r?.low === null || r?.low === undefined ? null : Number(r.low),
    }
  })
}
