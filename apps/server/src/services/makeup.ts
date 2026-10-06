import type { MakeupBlockReason, StreakView } from '@jushuo/shared'
import { ENERGY_PER_CHALLENGE, makeupEligibilityOf, today as dayOf } from '@jushuo/shared'
import { eq } from 'drizzle-orm'

import { db } from '../db'
import { users } from '../db/schema'
import { ENERGY_REASON, readEnergy, spendEnergy, topUpEnergy } from './energy'
import { shiftLastReadDate, stateOf, streakView } from './streak'
import type { User } from './user'

/**
 * ⭐ **补签** —— 断档之后花能量把缺口填上。规格：prd §7.8 / plan B50。
 *
 * 算法（能不能补、要花几点、补完 lastReadDate 落到哪天）全在
 * `@jushuo/shared/makeup.ts` 的纯函数里，这里只负责**取数、扣能量、落库**。
 *
 * ## 它和「解冻卡」的区别（2026-10 换掉的）
 *
 * 旧版要一整套「发卡 → 待领取 → 有效期 → 先到期先用」的机器，而它做的事
 * 就是"补一天"。现在改成**花能量**：少一个道具概念、少一张表、少两条接口。
 */

/**
 * 补不了的原因 = 连战的（没断档 / 今天读过了 / 断太久）+ 能量的（不够）。
 *
 * ⚠️ 两种原因**必须分开报**：前者要用户"去读一句 / 等下次"，
 *    后者要用户"吃饼干或充值" —— 混成一句"补签失败"等于什么都没说。
 */
export type MakeupFailure = MakeupBlockReason | 'not-enough-energy'

export interface MakeupResult {
  ok: boolean
  /** 缺口几天（0 = 没断档） */
  gapDays: number
  /** 补签本身要花几点能量 */
  cost: number
  /** 当天总共要几点（补签 + 还要读的那一句）—— 端侧把总账摆出来 */
  totalCost: number
  /** 还差几点能量（ok=false 且原因是 not-enough-energy 时才有意义） */
  shortfall: number
  /** 补完（或没补成）之后的连战视图 */
  streak: StreakView
  reason?: MakeupFailure
}

/**
 * ⭐⭐ **补签** —— 校验 → 扣能量 → 把 lastReadDate 推到昨天。**全程一个事务**。
 *
 * ⚠️⚠️ 为什么改 `lastReadDate` 而不是加天数：
 *    补签只是把缺口**填上**。`applyRead` 是按「lastReadDate 与今天的间隔」懒算的，
 *    推到昨天之后，用户今天再读一句就会被算成**续上**（+1），而不是归 1。
 *    ⇒ 补签**本身不增加天数**，这是刻意的（prd §7.8）。
 *
 * ⚠️ 幂等：流水用 `reason='streak_makeup' + refType='day' + refId=今天`，
 *    同一天只会有一笔（`unique(reason, ref_type, ref_id, user_id)` 兜底）。
 *    重复点 = 第二次扣不动，返回 duplicate ⇒ 这里当**失败**报出去，
 *    因为第二次补签对用户来说本来就是"我已经补过了"。
 *
 * @param now 注入时钟（测试用）；生产不传
 */
export async function makeUpStreak(userId: number, now: Date = new Date()): Promise<MakeupResult> {
  const today = dayOf(now)

  /**
   * ⚠️ 先把每日保底补上再判断 —— 否则一个余额 0 的老用户会被判"能量不够"，
   *    而他其实**有**今天的 3 点保底。
   */
  await topUpEnergy(userId, now)

  return db.transaction(async (tx) => {
    // 行锁：与 recordRead 抢同一行时按顺序来，避免"补到一半又被读掉了"
    const [row] = await tx.select().from(users).where(eq(users.id, userId)).for('update').limit(1)

    const fail = async (reason: MakeupFailure, gapDays: number, cost: number): Promise<MakeupResult> => {
      const energy = await readEnergy(userId, now)
      return {
        ok: false,
        gapDays,
        cost,
        totalCost: cost + ENERGY_PER_CHALLENGE,
        shortfall: reason === 'not-enough-energy' ? Math.max(0, cost - energy) : 0,
        streak: row ? streakView(stateOf(row as User), today) : streakView({ streakDays: 0, streakBest: 0, lastReadDate: null }, today),
        reason,
      }
    }

    if (!row) return fail('no-gap', 0, 0)

    const state = stateOf(row as User)
    const eligibility = makeupEligibilityOf(state, today)

    if (!eligibility.ok) {
      return fail(eligibility.reason as MakeupBlockReason, eligibility.gapDays, eligibility.cost)
    }

    const spent = await spendEnergy(tx, {
      userId,
      amount: eligibility.cost,
      reason: ENERGY_REASON.makeup,
      refType: 'day',
      // ⚠️ refId 用**今天**：一天只能补一次。用 gapDays 的话，
      //    今天补 1 天、明天还能给同一个缺口再补一次。
      refId: today,
    })

    /**
     * ⚠️ 'duplicate' 也报 not-enough-energy？不 —— 那是**另一件事**。
     *    它意味着"今天已经补过了"，而 eligibility 本该在补过之后就说不能补了
     *    （lastReadDate 已经推到了昨天 ⇒ gap 变 0 ⇒ no-gap）。
     *    真走到这里说明中间有并发；报 no-gap 比报"能量不够"诚实。
     */
    if (spent === 'duplicate') return fail('no-gap', eligibility.gapDays, eligibility.cost)
    if (spent === 'insufficient') {
      return fail('not-enough-energy', eligibility.gapDays, eligibility.cost)
    }

    /**
     * ⚠️ 走 streak.ts 的 shiftLastReadDate，**不在这里直接写库**：
     *    那一列的语义只有连战模块知道（见那边的说明）。
     *    把 tx 传进去 ⇒ 仍然和扣能量同一个事务。
     */
    await shiftLastReadDate(tx, userId, eligibility.newLastReadDate as string)

    // 用**补完之后**的行重新组装视图（lastReadDate 变了，readToday 还是 false）
    const after = { ...(row as User), lastReadDate: eligibility.newLastReadDate as string }

    return {
      ok: true,
      gapDays: eligibility.gapDays,
      cost: eligibility.cost,
      totalCost: eligibility.cost + ENERGY_PER_CHALLENGE,
      shortfall: 0,
      streak: streakView(stateOf(after), today),
    }
  })
}
