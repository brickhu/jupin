import { and, countDistinct, eq } from 'drizzle-orm'
import { db } from '../db'
import { submissions } from '../db/schema'

/**
 * 攻克 —— **只要在这条句子上参与过、并且拿到了分数**，就算攻克，**只增不减**。
 *
 * ⚠️⚠️ 判定用 status = 'scored'，**不是**以前的 85 分线（已废除），
 *    也不用 submissions.is_conquered 那一列：
 *      · 口径的真相就是「这一句我拿到分了没有」，而 status 正是它；
 *      · is_conquered 是历史写入的标记 —— 老数据里按 85 线写成了 false，
 *        拿它统计会把老记录全漏掉（症状是「明明读过、却显示 0」）。
 *
 * ⚠️ 攻克按「去重的句子」计 —— submissions 里同一句可能有多条 scored，
 *    必须 count(distinct article_id)，否则重录会虚增攻克数。
 *
 * ⚠️ 这里**只剩总数**了：「按难度分的征服数」随难度一起下线（做减法后的产品
 *    只有三条核心：得分 / 排名 / Streak，难度不在其中）。
 */

export async function getTotalConquered(userId: number): Promise<number> {
  const [row] = await db
    .select({ n: countDistinct(submissions.articleId) })
    .from(submissions)
    .where(and(eq(submissions.userId, userId), eq(submissions.status, 'scored')))
  return Number(row?.n ?? 0)
}
