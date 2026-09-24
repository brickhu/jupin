import { and, count, countDistinct, eq } from 'drizzle-orm'
import { MAX_INVALID_PER_DAY } from '@jushuo/shared'

import { db } from '../db'
import { submissions } from '../db/schema'

/** 提交记录的 DB 操作。纯标识/路径规则在 ./audio-key.ts。 */

/**
 * ⭐ 首页那张「我的状态卡」上的两个数：挑战过几句、一共挑战了多少回。
 *
 * ⚠️ 口径与榜单完全一致：**只数 status='scored'**。
 *    读不出来的录音（音频坏了 / 引擎判无效）不该记进「我挑战过 N 句」——
 *    用户会说「我明明没读成功，怎么算我一句」。
 *
 * ⚠️ 是**全时段**的累计，不是今天：今天还能不能挑战由**能量**决定
 *    （见 services/energy.ts），这两个数是「我一共走过多少路」。
 */
export async function challengeStats(
  userId: number,
): Promise<{ challengedCount: number; challengedRounds: number }> {
  const [row] = await db
    .select({
      rounds: count(),
      /** ⭐ 去重的是**句子**（articleId），不是日期也不是提交 —— 同一句读 5 次只算一场 */
      sentences: countDistinct(submissions.articleId),
    })
    .from(submissions)
    .where(and(eq(submissions.userId, userId), eq(submissions.status, 'scored')))

  return {
    challengedCount: Number(row?.sentences ?? 0),
    challengedRounds: Number(row?.rounds ?? 0),
  }
}

/**
 * 取该用户在该文章的下一个序列号（从 1 开始）。
 * ⚠️ 并发提交可能撞号，由 uniqueIndex(userId, articleId, seq) 兜底。
 */
export async function nextSeq(userId: number, articleId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(submissions)
    .where(and(eq(submissions.userId, userId), eq(submissions.articleId, articleId)))
  return Number(row?.n ?? 0) + 1
}

/**
 * 无效提交（音频读不出来 / 引擎判无效）：**不扣能量**（见 energy.ts 的锁/结算），
 * 但计数；当天连续超过上限则当天暂停。
 *
 * ⚠️ 它是这套规则里**唯一的防滥用闸门**：
 *    能量只锁"真正要打分的那一次"，失败还会退 ——
 *    所以垃圾音频可以反复撞接口，这个上限拦的正是那个：
 *    连撞 MAX_INVALID_PER_DAY 次当天就不受理了。
 *
 * ⚠️ 纯函数（不碰 IO、不在内部取 Date.now），边界靠单测钉。
 */
export function trackInvalid(
  invalidCount: number,
  invalidDate: string | null,
  today: string,
): { count: number; blocked: boolean } {
  const count = invalidDate === today ? invalidCount + 1 : 1
  return { count, blocked: count >= MAX_INVALID_PER_DAY }
}
