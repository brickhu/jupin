import { max, isNotNull, and, count, countDistinct, eq } from 'drizzle-orm'
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
/**
 * ⭐⭐ **分配"这一句上的第几次"**（= 列表里的序号）—— **只在"有结论"时调用**。
 *
 * ⚠️⚠️ 为什么不在受理时分配（用户 2026-09 报的"第 4 次跳到第 6 次"的根因）：
 *    受理时分配的话，"没触达"（音频读不出来 / 网络断）那一行最终要被清掉，
 *    而它**占过的号会变成永久空洞**。把分配点挪到"有结论"这一刻，并保证
 *    **占过号的行永不删** ⇒ 序号里不可能有空洞。
 *
 * ⚠️ 算法就是"已占号的行数 + 1"：因为占号的行只增不减、且永不删，
 *    这个数天然连续（1、2、3…）。
 * ⚠️ 并发提交可能撞 `uniqueIndex(user, article, seq)` ⇒ 撞了就重算（下面那个循环），
 *    这与原来 `nextSeq` 靠唯一键兜底的思路一致，只是现在多了一步重试。
 */
export async function nextDisplaySeq(userId: number, articleId: string): Promise<number> {
  /**
   * ⚠️⚠️ **用 `MAX(seq) + 1`，不是 `COUNT(*) + 1`**（2026-09 实测踩到）：
   *    "数有几行就给第几号"在**有历史数据**时必然撞号 ——
   *    库里已经有 `seq=6` 的行时，数出 6 行就会再给一个 6 ⇒
   *    `Duplicate entry … for key submissions_user_article_seq_idx`。
   *    ⚠️ 当时那个异常还**逃逸出去把整个进程带走**（容器重启）。
   *
   * ⚠️ 并发下仍可能撞（两个请求同时读到同一个 max）⇒ 调用方**必须重试**，
   *    见下面的 `withDisplaySeq`。
   */
  const [row] = await db
    .select({ max: max(submissions.seq) })
    .from(submissions)
    .where(and(eq(submissions.userId, userId), eq(submissions.articleId, articleId)))
  return Number(row?.max ?? 0) + 1
}

/**
 * ⭐ **带重试地分配序号并执行一次写入**（并发撞号时重算）。
 *
 * ⚠️ 为什么需要它：`MAX(seq)+1` 在并发下会撞 `uniqueIndex(user, article, seq)`。
 *    这里撞了就重算（最多 5 次），而不是让异常逃逸 ——
 *    那个异常**会把整个 Node 进程带走**（实测：容器重启、所有进行中的打分一起丢）。
 *
 * @param write 拿到序号后要执行的写入；返回 `true` 表示写成功（不再重试）
 */
export async function withDisplaySeq(
  userId: number,
  articleId: string,
  write: (seq: number) => Promise<boolean>,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const seq = await nextDisplaySeq(userId, articleId)
    try {
      return await write(seq)
    } catch (err) {
      const dup = (err as { code?: string }).code === 'ER_DUP_ENTRY'
      if (!dup || attempt === 5) throw err
      console.warn('[submission] 序号撞号，重算（第 ' + attempt + ' 次）：' + userId + '/' + articleId)
    }
  }
  return false
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
