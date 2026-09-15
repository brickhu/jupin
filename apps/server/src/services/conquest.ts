import { and, countDistinct, eq } from 'drizzle-orm'
import { db } from '../db'
import { articles, submissions } from '../db/schema'

/**
 * 征服 —— 在文章拿到 ≥ 85 分即征服，**永久保留、只增不减**。
 *
 * ⚠️ 用**绝对分**判定，不用排名判定。
 *    排名会因「人少」或「对手太强」失真；绝对分是同一把尺子。
 *
 * ⚠️ 征服按「去重的文章」计 —— submissions 里同一文章可能有多条 is_conquered=true，
 *    必须 count(distinct article_id)，否则重录会虚增征服数。
 */

/** 各难度已征服数量（能力边界图） */
export async function getConqueredByDifficulty(
  userId: number,
): Promise<Record<string, number>> {
  const rows = await db
    .select({ difficulty: articles.difficulty, n: countDistinct(submissions.articleId) })
    .from(submissions)
    .innerJoin(articles, eq(articles.id, submissions.articleId))
    .where(and(eq(submissions.userId, userId), eq(submissions.isConquered, true)))
    .groupBy(articles.difficulty)

  const out: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }
  for (const r of rows) out[String(r.difficulty)] = Number(r.n)
  return out
}

export async function getTotalConquered(userId: number): Promise<number> {
  const [row] = await db
    .select({ n: countDistinct(submissions.articleId) })
    .from(submissions)
    .where(and(eq(submissions.userId, userId), eq(submissions.isConquered, true)))
  return Number(row?.n ?? 0)
}
