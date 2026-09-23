import { and, eq, isNull } from 'drizzle-orm'
import { dayKey } from '@jushuo/shared'

import { db } from '../db'
import { submissions, users } from '../db/schema'
import { arenaSnapshot, computeGrowth, highestInSentence, highestInUser } from './growth'
import { evaluateRewards, type GrantedReward } from './rewards'
import { recordRead } from './streak'
import { unfreezeStatus } from './unfreeze'

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
 * ⚠️ 幂等靠 submissions.growth_self IS NULL 这个守卫：
 *    成长值的累加不像发奖那样有唯一键兜底，重复加一次**不会报错**，
 *    只会让用户的数字凭空变大 —— 这种错最难发现。
 */

export interface SettleResult {
  streakDays: number
  streakBest: number
  /** 这次读有没有被计入（false = 今天已经读过，只加成长值不加天数） */
  streakCounted: boolean
  streakDelta: number
  growth: { self: number; diligence: number; standout: number }
  rewards: GrantedReward[]
  unfreezeCards: number
}

/**
 * @returns 结算结果；null = 这条提交不该结算（没分数 / 已经结算过）
 */
export async function settle(userId: number, submissionId: string): Promise<SettleResult | null> {
  const [row] = await db.select().from(submissions).where(eq(submissions.id, submissionId)).limit(1)
  if (!row || row.status !== 'scored' || row.score === null) return null
  // ⚠️ 已经结算过（growth_self 有值）→ 直接退出。
  //    合法的 0 也会写 0，所以判据是 null 而不是 falsy。
  if (row.growthSelf !== null) return null

  const score = Number(row.score)

  // ⚠️ streak 的「读之前」必须在 recordRead 之前取 —— 它对坚持不懈的跨档判定是必需的
  const [before] = await db
    .select({ streakDays: users.streakDays, marker: users.unfreezeMarkerStreak })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  const streakBefore = before?.streakDays ?? 0

  // ---- ① streak：只算天数，不碰卡（卡是用户主动用的，见 ./unfreeze.ts）----
  const read = await recordRead(userId, dayKey(row.createdAt))

  // ---- ② 三个成长指标：三样历史都**排除本次提交** ----
  const [bestSentence, bestUser, snapshot] = await Promise.all([
    highestInSentence(userId, row.articleId, submissionId),
    highestInUser(userId, submissionId),
    arenaSnapshot(row.articleId, submissionId),
  ])
  const growth = computeGrowth({
    score,
    highestInSentence: bestSentence,
    highestInUser: bestUser,
    snapshot,
    streakBefore,
    streakAfter: read.state.streakDays,
  })

  // ---- ③ 奖励：规则求值（全部走 grantReward）----
  const rewards = await evaluateRewards({
    userId,
    submissionId,
    score,
    streakBefore,
    streakAfter: read.state.streakDays,
    // 提交前的全场最高分（榜单最高分，排除本次）—— 首读时是 0，规则里会跟 75 取大
    sentenceTop: snapshot.length > 0 ? Math.max(...snapshot) : 0,
    unfreezeMarker: before?.marker ?? 0,
  })

  // ⚠️ 发完奖再看卡数：本次新发的卡要算进结果页显示的「手上还有几张」
  const unfreeze = await unfreezeStatus(userId)

  // ---- ④ 落库（一次性，带守卫）----
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(submissions)
      .set({
        growthSelf: growth.self,
        growthDiligence: growth.diligence,
        growthStandout: growth.standout,
        growthMeta: JSON.stringify(growth.meta),
        streakDelta: JSON.stringify({
          streakDays: read.state.streakDays,
          streakBest: read.state.streakBest,
          counted: read.counted,
          delta: read.delta,
          unfreezeCards: unfreeze.count,
        }),
      })
      // ⚠️ 守卫：只有「还没结算过」的那一次能写进去（见文件头）
      .where(and(eq(submissions.id, submissionId), isNull(submissions.growthSelf)))

    const affected = (updated as unknown as [{ affectedRows?: number }])[0]?.affectedRows
    if (Number(affected ?? 0) !== 1) return

    // 成长值的累加：读改写（同一事务里，行锁住，简单可靠）
    const [u] = await tx
      .select({
        self: users.growthSelf,
        diligence: users.growthDiligence,
        standout: users.growthStandout,
      })
      .from(users)
      .where(eq(users.id, userId))
      .for('update')
    if (!u) return

    await tx
      .update(users)
      .set({
        growthSelf: u.self + growth.self,
        growthDiligence: u.diligence + growth.diligence,
        growthStandout: u.standout + growth.standout,
      })
      .where(eq(users.id, userId))
  })

  return {
    streakDays: read.state.streakDays,
    streakBest: read.state.streakBest,
    streakCounted: read.counted,
    streakDelta: read.delta,
    growth: { self: growth.self, diligence: growth.diligence, standout: growth.standout },
    rewards,
    unfreezeCards: unfreeze.count,
  }
}
