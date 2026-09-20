import { and, countDistinct, eq } from 'drizzle-orm'
import { db } from '../db'
import { submissions } from '../db/schema'

/**
 * 征服 —— 在一条句子上拿到 ≥ CONQUEST_THRESHOLD 分，**永久保留、只增不减**。
 *
 * ⚠️ 用**绝对分**判定，不用排名判定。
 *    排名会因「人少」或「对手太强」失真；绝对分是同一把尺子。
 *
 * ⚠️ 征服按「去重的句子」计 —— submissions 里同一句可能有多条 is_conquered=true，
 *    必须 count(distinct article_id)，否则重录会虚增征服数。
 *
 * ⚠️ 这里**只剩总数**了：「按难度分的征服数」随难度一起下线（做减法后的产品
 *    只有三条核心：得分 / 排名 / Streak，难度不在其中）。
 */

export async function getTotalConquered(userId: number): Promise<number> {
  const [row] = await db
    .select({ n: countDistinct(submissions.articleId) })
    .from(submissions)
    .where(and(eq(submissions.userId, userId), eq(submissions.isConquered, true)))
  return Number(row?.n ?? 0)
}
