import { and, eq, isNull } from 'drizzle-orm'
import { dayKey } from '@jushuo/shared'

import { db } from '../db'
import { submissions, users } from '../db/schema'
import type { CookieAward } from '@jushuo/shared'

import { arenaSnapshot, computeCookies, difficultyOf, grantCookies, highestInSentence } from './cookies'
import { evaluateRewards, type GrantedReward } from './rewards'
import { recordRead } from './streak'

/**
 * ⭐⭐ **打分成功之后的唯一结算入口**。
 * 规格：docs/design/growth-and-energy.md 与 docs/design/reward-system.md。
 *
 * ~~~
 * ① streak（只算天数，不碰卡）
 * ② 三个成长指标 + 快照落库
 * ③ 奖励规则求值 → 全部走 grantReward(...)
 * ~~~
 *
 * ⚠️⚠️ **只有这一条路径结算**。轮询、幂等重放、任务接管**都不结算** ——
 *    打分是异步的、结果由轮询取回，这条路上「再来一次」的机会太多，
 *    每多一个入口就多一次重复发奖的机会。
 *
 * ⚠️ 调用点必须在「分数**已经落库**、且这条 run 确实是写入者」之后
 *    （services/scoring.ts 里那个 affectedRows === 1 的分支）。
 *
 * ⚠️ 幂等靠 submissions.cookies_earned IS NULL 这个守卫：
 *    饼干的累加不像发奖那样有唯一键兜底（流水上的唯一键是第二道保险），
 *    重复加一次**不会报错**，
 *    只会让用户的数字凭空变大 —— 这种错最难发现。
 */

export interface SettleResult {
  streakDays: number
  streakBest: number
  /** 这次读有没有被计入（false = 今天已经读过，只发饼干不加天数） */
  streakCounted: boolean
  streakDelta: number
  /** ⭐ 这一把赚到的饼干（含攻克线 —— 端侧靠它显示「还差 X 分」） */
  cookies: CookieAward
  rewards: GrantedReward[]
}

/**
 * ⭐ **进程内的原子认领**：同一条提交在同一进程里只会被结算一次。
 *
 * ⚠️ 为什么需要它（2026-09 加兜底清扫之后）：判据是"先读 cookies_earned 再写"，
 *    两个并发调用会**都读到 null**、都往下走 —— 而饼干是**累加**的，
 *    重复加一次不会报错，只会让用户的数字凭空变大（这种错最难发现）。
 *    以前只有唯一调用点（scoring 里那条 affectedRows===1 的分支），
 *    现在多了"惰性补跑"（services/sweep.ts）⇒ 并发窗口变成真实存在的。
 *
 * ⚠️ 边界说清楚：它是**进程内**的。多副本同时补跑同一条仍然可能双结算；
 *    本项目 dev/prod 的副本数都是 1（MinReplicas 未调高，见 AGENT.md）。
 *    真要多副本，这里必须换成数据库层的原子认领
 *    （例如加一列 `settled_at` 并用 `UPDATE ... WHERE settled_at IS NULL` 抢占）。
 */
const inFlight = new Set<string>()

/**
 * @returns 结算结果；null = 这条提交不该结算（没分数 / 已经结算过 / 正在被结算）
 */
export async function settle(userId: number, submissionId: string): Promise<SettleResult | null> {
  if (inFlight.has(submissionId)) return null
  inFlight.add(submissionId)
  try {
    return await settleInner(userId, submissionId)
  } finally {
    inFlight.delete(submissionId)
  }
}

async function settleInner(userId: number, submissionId: string): Promise<SettleResult | null> {
  const [row] = await db.select().from(submissions).where(eq(submissions.id, submissionId)).limit(1)
  if (!row || row.status !== 'scored' || row.score === null) return null
  // ⚠️ 已经结算过（cookies_earned 有值）→ 直接退出。
  //    合法的 0 也会写 0，所以判据是 null 而不是 falsy。
  if (row.cookiesEarned !== null) return null

  const score = Number(row.score)

  // ⚠️ streak 的「读之前」必须在 recordRead 之前取 —— 它对坚持不懈的跨档判定是必需的
  const [before] = await db
    .select({ streakDays: users.streakDays })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  const streakBefore = before?.streakDays ?? 0

  // ---- ① streak：只算天数（⚠️ 解冻卡已作废；断档改成花能量补签，见 prd §7.8）----
  const read = await recordRead(userId, dayKey(row.createdAt))

  // ---- ② 饼干：两样历史都**排除本次提交**（难度是句子的属性，不必排除）----
  const [bestSentence, snapshot, difficulty] = await Promise.all([
    highestInSentence(userId, row.articleId, submissionId),
    arenaSnapshot(row.articleId, submissionId),
    difficultyOf(row.articleId),
  ])
  /**
   * ⚠️ 与它取代的三维成长值最大的不同：**连续天数不再参与**。
   *    「坚持不懈」与连战本来就是同一个数（已删），连战的回报走补签那条线。
   */
  const cookies = computeCookies({ score, difficulty, highestInSentence: bestSentence, snapshot })

  // ---- ③ 奖励：规则求值（全部走 grantReward）----
  const rewards = await evaluateRewards({
    userId,
    submissionId,
    score,
    streakBefore,
    streakAfter: read.state.streakDays,
    // 提交前的全场最高分（榜单最高分，排除本次）—— 首读时是 0，规则里会跟 75 取大
    sentenceTop: snapshot.length > 0 ? Math.max(...snapshot) : 0,
  })

  // ---- ④ 落库（一次性，带守卫）----
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(submissions)
      .set({
        cookiesEarned: cookies.earned,
        cookieMeta: JSON.stringify(cookies.meta),
        streakDelta: JSON.stringify({
          streakDays: read.state.streakDays,
          streakBest: read.state.streakBest,
          counted: read.counted,
          delta: read.delta,
        }),
      })
      // ⚠️ 守卫：只有「还没结算过」的那一次能写进去（见文件头）
      .where(and(eq(submissions.id, submissionId), isNull(submissions.cookiesEarned)))

    const affected = (updated as unknown as [{ affectedRows?: number }])[0]?.affectedRows
    if (Number(affected ?? 0) !== 1) return

    /**
     * ⭐ 饼干的累加：加余额 + 记流水。
     *
     * ⚠️⚠️ 幂等**完全靠上面那个 `IS NULL` 守卫**（affectedRows 不为 1 时已经 return）——
     *    所以这里不再自己判一次：两道判断分开写，迟早会不一致。
     * ⚠️ 用 `users.cookies + n` 而不是"读出来再加"：读改写要 `FOR UPDATE`，
     *    而这里已经在一人一行的事务里，交给数据库自增更简单也更准。
     */
    await grantCookies(tx, { userId, submissionId, earned: cookies.earned })
  })

  return {
    streakDays: read.state.streakDays,
    streakBest: read.state.streakBest,
    streakCounted: read.counted,
    streakDelta: read.delta,
    cookies: {
      earned: cookies.earned,
      passLine: cookies.passLine,
      base: cookies.base,
      rankFactor: cookies.rankFactor,
    },
    rewards,
  }
}
