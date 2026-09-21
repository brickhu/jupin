import { and, count, eq, gte, lt } from 'drizzle-orm'
import { addDays, dayStartUtc, today as dayOf } from '@jushuo/shared'

import { db } from '../db'
import { submissions } from '../db/schema'

/** 提交记录的 DB 操作。纯标识/路径规则在 ./audio-key.ts。 */

/**
 * ⭐ 挑战门禁要用的数：**今天已经挑战成功几次**（与句子无关）。
 *
 * ⚠️ 只数 **status='scored'** 的：与榜单的「我读过几次」同一口径
 *    （见 services/leaderboard.ts 的 myAttempts）。
 *    把「音频读不出来 / 引擎判无效」也算进额度的话，
 *    用户会看到「今天的次数用完了」却一次有效的分都没拿到 —— 没法解释。
 *
 * ⚠️⚠️ 窗口是**北京时间切出来的自然日**，不是 UTC 日：
 *    库里 created_at 存的是 UTC 墙上时间，直接按 UTC 日统计的话，
 *    北京时间早上 8 点前提交的那一次会被算到"昨天"——
 *    表现是"早上读了一次，下午还能再读一次"。见 day.ts 的 dayStartUtc。
 *
 * ⚠️ 按**提交时间**统计，而不是按「这次挑战算哪天」（scheduledFor）：
 *    后者是客户端传上来的，用户重读历史挑战时会带着旧日期 ——
 *    那等于"只要我填昨天的日期，今天就还能再读"。额度必须钉在真实动作上。
 */
export async function dailyChallengeUsage(
  userId: number,
  now: Date = new Date(),
): Promise<{ usedToday: number }> {
  const day = dayOf(now)
  const [row] = await db
    .select({ n: count() })
    .from(submissions)
    .where(
      and(
        eq(submissions.userId, userId),
        eq(submissions.status, 'scored'),
        gte(submissions.createdAt, dayStartUtc(day)),
        lt(submissions.createdAt, dayStartUtc(addDays(day, 1))),
      ),
    )
  return { usedToday: Number(row?.n ?? 0) }
}

/**
 * 取该用户在该文章的下一个序列号（从 1 开始）。
 * ⚠️ 并发提交可能撞号，由 uniqueIndex(userId, articleId, seq) 兜底。
 */
export async function nextSeq(userId: number, articleId: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(submissions)
    .where(and(eq(submissions.userId, userId), eq(submissions.articleId, articleId)))
  return Number(row?.n ?? 0) + 1
}
