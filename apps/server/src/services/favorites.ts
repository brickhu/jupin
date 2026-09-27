import { and, desc, eq, inArray } from 'drizzle-orm'
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
