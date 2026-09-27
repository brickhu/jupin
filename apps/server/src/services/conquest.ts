import { and, count, eq } from 'drizzle-orm'
import { db } from '../db'
import { participations } from '../db/schema'

/**
 * 攻克 —— **只要在这条句子上参与过、并且拿到了分数**，就算攻克，**只增不减**。
 *
 * ⚠️⚠️ 它现在就是「我的参与记录条数」：participations 是**一人一场一行**，
 *    而它的写入口径就是 status = 'scored'（见 services/participations.ts）。
 *    所以这里不再需要 count(distinct article_id) —— 行数天然就是去重后的句子数。
 *
 * ⚠️ 曾经用过 submissions.is_conquered 那一列，已删：老数据按已废除的 85 分线
 *    写成了 false，拿它统计会把老记录全漏掉（症状是「明明读过、却显示 0」）。
 *
 * ⚠️ 「按难度分的征服数」随难度一起下线（做减法后的产品只有三条核心：得分 / 排名 / Streak）。
 */
export async function getTotalConquered(userId: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(participations)
    .where(eq(participations.userId, userId))
  return Number(row?.n ?? 0)
}
