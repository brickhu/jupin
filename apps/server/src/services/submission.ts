import { and, count, countDistinct, eq, lt, lte, or } from 'drizzle-orm'
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
 * ⭐⭐ **这一把是"这句上的第几次"** —— **现算，不存列**（2026-09 改）。
 *
 * ⚠️ 原来它是 `submissions.seq`（受理/出结论时 `MAX+1` 写进去）。为了维护那个字段，
 *    养了一整套机制：分配器、撞号重试、`uniqueIndex(user, article, seq)`、重编号脚本 ——
 *    而它**只是一个显示用的位置**：列表本来就一次把这句上所有的行全查出来了，
 *    数一下下标就有；存下来等于把"派生值"变成第二个真相。
 *    ⚠️ 而且那个分配器**真的把进程搞崩过**：并发撞唯一键、异常逃逸、Node 直接退出。
 *
 * ⚠️ 口径：**只数"有结论的"行**（`scored` / 引擎判无效），按时间从旧到新编号，旧的为 1。
 *    "检测中"的行不算 —— 数了会让列表出现空洞（这正是用户报过的「第 4 次跳到第 6 次」）。
 * ⚠️ 同一毫秒内的并列按 `id` 兜底排序，保证同一个行每次问到的号一致。
 */
export async function attemptNoOf(
  userId: number,
  articleId: string,
  createdAt: Date,
  id: string,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(submissions)
    .where(
      and(
        eq(submissions.userId, userId),
        eq(submissions.articleId, articleId),
        // 有结论的（"检测中"不算 —— 它还没定，数进来会给列表开洞）
        or(eq(submissions.status, 'scored'), eq(submissions.status, 'failed')),
        // 排在它前面的（含它自己；同一毫秒按 id 兜底）
        or(
          lt(submissions.createdAt, createdAt),
          and(eq(submissions.createdAt, createdAt), lte(submissions.id, id)),
        ),
      ),
    )
  return Number(row?.n ?? 0)
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
