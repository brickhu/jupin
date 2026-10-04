import { and, count, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import { favorites } from '../db/schema'

/**
 * ⭐ 收藏 —— 用户把**一个句子**收进自己的列表。
 *
 * ⚠️ 与 likes 的分工：likes 赞的是**一次挑战**（submission），收藏收的是
 *    **这句话本身**（article）—— 与谁读得好、读了几次无关。
 * ⚠️ 主键 (user_id, article_id) ⇒ 收藏是**幂等开关**，重复点不会产生第二行。
 */

/** 库句柄 —— 可注入，理由同 services/article-index.ts 的 Database */
type Database = typeof db

/**
 * 收藏 / 取消收藏（**幂等**）。
 *
 * ⚠️ 收藏用 insert ... ignore：重复点不该报错（客户端可能重试、可能两次快速点）。
 * ⚠️ 取消用 delete：没收藏过时删 0 行也是成功 —— 开关的两头都幂等，
 *    客户端才敢乐观更新（先改界面再发请求）。
 */
export async function setFavorite(
  userId: number,
  articleId: string,
  on: boolean,
  database: Database = db,
): Promise<void> {
  if (on) {
    await database.insert(favorites).ignore().values({ userId, articleId })
    return
  }
  await database
    .delete(favorites)
    .where(and(eq(favorites.userId, userId), eq(favorites.articleId, articleId)))
}

/**
 * 我收藏了 articleIds 里的哪几个 —— 竞技场页要用它决定按钮是实心还是空心。
 * ⚠️ 返回值是 Set：调用方按 id 判存在，不关心顺序。
 */
export async function favoriteIdsOf(
  userId: number,
  articleIds: string[],
  database: Database = db,
): Promise<Set<string>> {
  if (articleIds.length === 0) return new Set()
  const rows = await database
    .select({ articleId: favorites.articleId })
    .from(favorites)
    .where(and(eq(favorites.userId, userId), inArray(favorites.articleId, articleIds)))
  return new Set(rows.map((r) => r.articleId))
}

/**
 * ⭐ **这些句子各被多少人收藏** —— `favorites` 的**现算聚合**（一人一句一行 ⇒ 行数就是人数）。
 *
 * ⚠️ 批量（一次 ≤100 个 id）而不是一句一条：调用方是句库列表 / 首页 / 竞技场 ——
 *    它们本来就一次要好几句，逐句查就是 N 次往返。
 *    ⚠️ 与 `listArticleStats`（参与统计）**同形**：一条 `GROUP BY article_id` +
 *      **按请求的 ids 零值补齐**，端侧可以直接按 articleId 取。
 *
 * ⚠️ 它**不是冗余计数列**（对比 `submissions.like_count`：那一列是为了**排序**才存的）。
 *    收藏从来不参与排序，所以现算最省事：永远准、不需要 ±1、也就不需要重建与对账。
 *
 * ⚠️ 与删句子前那道安全检查（`services/article-delete.ts` 里的 `count() where article_id`）
 *    是**同一个判据**，只是这里把它发给客户端。
 *
 * ⚠️⚠️ 这条查询能走索引，靠的是 `favorites.article_id` 上那个**历史遗留索引**
 *    （`favorites_article_id_articles_id_fk`：迁移 0039 建外键时 MySQL 自动建的，
 *    0047 只删了外键约束、**没删索引**）。
 *    实测 `type=ref / key=favorites_article_id_articles_id_fk / Extra="Using index"`。
 *    ⇒ 它**没有登记进 `db/schema.ts`，也不在 drizzle 快照里** —— 谁要清理"没人引用的索引"
 *      之前先看这里：删了它，这条 COUNT 就变成全表扫。
 *
 * ⚠️ 查不到的句子回 **0**（不是 404）：收藏行不挂外键，句子下架后行还在，
 *    而"零人收藏"与"句子不存在"对这个数来说是同一个答案。
 */
export async function favoriteCountsOf(
  articleIds: string[],
  database: Database = db,
): Promise<{ articleId: string; favoriteCount: number }[]> {
  const ids = [...new Set(articleIds.filter((id) => !!id))]
  if (ids.length === 0) return []

  const rows = await database
    .select({ articleId: favorites.articleId, n: count() })
    .from(favorites)
    .where(inArray(favorites.articleId, ids))
    .groupBy(favorites.articleId)

  const byId = new Map(rows.map((r) => [r.articleId, Number(r.n)]))
  return ids.map((articleId) => ({ articleId, favoriteCount: byId.get(articleId) ?? 0 }))
}

export interface FavoriteRef {
  articleId: string
  favoritedAt: Date
}

/** 我的收藏列表（按收藏时间倒序，最近收的在前） */
export async function listFavorites(userId: number, database: Database = db): Promise<FavoriteRef[]> {
  const rows = await database
    .select({ articleId: favorites.articleId, favoritedAt: favorites.createdAt })
    .from(favorites)
    .where(eq(favorites.userId, userId))
    // ⚠️ 排序键与索引 favorites_user_time_idx 同序
    .orderBy(desc(favorites.createdAt), desc(favorites.articleId))
  return rows
}
