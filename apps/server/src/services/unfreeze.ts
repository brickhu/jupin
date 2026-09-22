import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm'
import { UNFREEZE_VALID_DAYS, daysBetween, today as dayOf } from '@jushuo/shared'

import { db, type Executor } from '../db'
import { unfreezeCards, users } from '../db/schema'

/**
 * ⭐ 解冻卡 —— 连战断档后，用它把漏掉的那几天**解冻**、把连战续上。
 * 规格：docs/design/reward-system.md 第 3、7 节。
 *
 * ⚠️⚠️ 三条与旧实现**根本不同**的地方（都改过，别再改回去）：
 *    ① 名字：叫**解冻卡**，不叫冻结卡
 *    ② 一张卡一行（有有效期，"手上几张"按 expires_at 过滤，计数器表达不了）
 *    ③ **不再自动消耗**：断档就是归 1，用不用卡由**用户主动**决定
 */

const DAY_MS = 86_400_000

export interface UnfreezeStatus {
  /** 手上还有几张（未过期、未使用） */
  count: number
  /** 最早到期的那张的到期日 'YYYY-MM-DD'；没有就是 null */
  expiresOn: string | null
}

/**
 * ⭐ 手上还有几张、最早哪张到期。
 *
 * ⚠️ **现算，不在 users 上存计数器** —— 存了就是第二份真相，必然和卡表漂移。
 * ⚠️ 「过期」不落状态，由 expires_at 与「现在」比较得出（落状态就要定时任务去翻）。
 */
export async function unfreezeStatus(
  userId: number,
  now: Date = new Date(),
  ex: Executor = db,
): Promise<UnfreezeStatus> {
  const rows = await ex
    .select({ expiresAt: unfreezeCards.expiresAt })
    .from(unfreezeCards)
    .where(
      and(eq(unfreezeCards.userId, userId), isNull(unfreezeCards.usedAt), gt(unfreezeCards.expiresAt, now)),
    )
    // ⚠️ 先到期先排在前面 —— 消耗时也用这个顺序（"食品柜"规则）
    .orderBy(asc(unfreezeCards.expiresAt))

  const first = rows[0]
  return { count: rows.length, expiresOn: first ? dayOf(first.expiresAt) : null }
}

/**
 * ⭐ 发一张解冻卡（由奖励系统调用，不要在别处直接发）。
 *
 * ⚠️ 幂等**不在这里**：同一条规则不能重复发，靠的是 reward_grants 的
 *    唯一键（rule_code, ref, user）。所以这个函数会被放在
 *    那个事务**内部**调用，失败一起回滚。
 */
export async function grantUnfreezeCard(
  input: { userId: number; ruleCode: string; now?: Date },
  ex: Executor = db,
): Promise<void> {
  const now = input.now ?? new Date()
  await ex.insert(unfreezeCards).values({
    userId: input.userId,
    grantedAt: now,
    expiresAt: new Date(now.getTime() + UNFREEZE_VALID_DAYS * DAY_MS),
    ruleCode: input.ruleCode,
  })
}

export type UseCardsResult =
  | { ok: true; used: number }
  | { ok: false; reason: 'not-broken' | 'already-read-today' | 'not-enough'; need?: number; have?: number }

/**
 * ⭐ 补签 —— 用卡的**唯一**途径（用户主动点的）。
 *
 * 前提（**方案 a**）：只能在「断档之后、今天还没读」的时候做。
 * 今天一旦读过，连战已经归 1，「断档前的天数」就丢了，事后补不了。
 * 好处是不用多存一个 streakBeforeBreak，规则也最好解释。
 *
 * ⚠️⚠️ **补签本身不增加天数** —— 它只是把缺口填上（lastReadDate 推到昨天），
 *    **用户当天还得读一句才会 +1**。所以：
 *      · 补签成功后 UI 要立刻引导"现在读一句"，别让卡白花
 *      · 文案说「补上之后，今天读一句就接上了」，**不要说「已恢复连战」**（那是假的）
 *      · 如果补了签却没读，明天缺口又出现 1 天，还得再花 1 张
 *
 * ⚠️ 卡不够时**拒绝且一张都不扣**：只补一半的话连战数字变得没法解释
 *    （与"要么续上、要么重来"同一条原则）。
 */
export async function useUnfreezeCards(
  userId: number,
  now: Date = new Date(),
): Promise<UseCardsResult> {
  const today = dayOf(now)

  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ streakDays: users.streakDays, lastReadDate: users.lastReadDate })
      .from(users)
      .where(eq(users.id, userId))
      .for('update')
    if (!user) return { ok: false as const, reason: 'not-broken' as const }

    // ① 今天已经读过 —— 断档前的那串天数已经没了，补不了（方案 a）
    if (user.lastReadDate === today) {
      return { ok: false as const, reason: 'already-read-today' as const }
    }

    // ② 没有断档就没什么可补的
    const gap = user.lastReadDate === null ? 0 : daysBetween(user.lastReadDate, today)
    const missed = gap - 1
    if (missed <= 0) return { ok: false as const, reason: 'not-broken' as const }

    // ③ 手上的卡够不够（先到期先用）
    const cards = await tx
      .select({ id: unfreezeCards.id })
      .from(unfreezeCards)
      .where(
        and(
          eq(unfreezeCards.userId, userId),
          isNull(unfreezeCards.usedAt),
          gt(unfreezeCards.expiresAt, now),
        ),
      )
      .orderBy(asc(unfreezeCards.expiresAt))
      .limit(missed)

    if (cards.length < missed) {
      return { ok: false as const, reason: 'not-enough' as const, need: missed, have: cards.length }
    }

    const usedAt = now
    await tx
      .update(unfreezeCards)
      .set({ usedAt, usedForGap: missed })
      .where(inArray(unfreezeCards.id, cards.map((c) => c.id)))

    // ④ 把缺口填上：lastReadDate 推到「今天 − 1」⇒ 今天再读就是 gap=1、+1
    const yesterday = dayOf(new Date(now.getTime() - DAY_MS))
    await tx.update(users).set({ lastReadDate: yesterday }).where(eq(users.id, userId))

    return { ok: true as const, used: missed }
  })
}
