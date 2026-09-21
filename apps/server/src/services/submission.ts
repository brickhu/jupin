import { and, count, eq, max } from 'drizzle-orm'
import { db } from '../db'
import { submissions } from '../db/schema'

/** 提交记录的 DB 操作。纯标识/路径规则在 ./audio-key.ts。 */

/**
 * 取该用户在该文章的下一个序列号（从 1 开始）。
 * ⚠️ 并发提交可能撞号，由 uniqueIndex(userId, articleId, seq) 兜底。
 */
/**
 * ⭐ 挑战门禁要用的两个数。
 *
 * ⚠️ attempts 只数 **status='scored'** 的：与榜单的「我读过几次」同一口径
 *    （见 services/leaderboard.ts 的 myAttempts）。
 *    把「音频读不出来 / 引擎判无效」也算进额度的话，
 *    用户会看到「这句的免费次数用完了」却一次有效的分都没拿到 —— 没法解释。
 *
 * ⚠️ lastSubmitAt 则相反，**任何状态都算**：它是"你刚刚已经提交过一次"的证据，
 *    而防刷机要拦的正是「反复提交」这个动作本身。
 */
export async function challengeUsage(
  userId: number,
  articleId: number,
): Promise<{ attempts: number; lastSubmitAt: Date | null }> {
  const [scored, last] = await Promise.all([
    db
      .select({ n: count() })
      .from(submissions)
      .where(
        and(
          eq(submissions.userId, userId),
          eq(submissions.articleId, articleId),
          eq(submissions.status, 'scored'),
        ),
      ),
    db
      .select({ t: max(submissions.createdAt) })
      .from(submissions)
      .where(eq(submissions.userId, userId)),
  ])
  const t = last[0]?.t
  return { attempts: Number(scored[0]?.n ?? 0), lastSubmitAt: t ? new Date(t) : null }
}

export async function nextSeq(userId: number, articleId: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(submissions)
    .where(and(eq(submissions.userId, userId), eq(submissions.articleId, articleId)))
  return Number(row?.n ?? 0) + 1
}
