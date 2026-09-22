import { and, eq } from 'drizzle-orm'
import { ENERGY_DAILY_FLOOR, ENERGY_PER_CHALLENGE, today as dayOf } from '@jushuo/shared'

import { db, type Executor } from '../db'
import { energyLedger, users } from '../db/schema'

/**
 * ⭐ 能量值 —— 替代「每天 N 次挑战机会」。
 * 规格：docs/design/growth-and-energy.md 第 2 节。
 *
 * ⚠️⚠️ 与旧额度**最大的结构差别**：额度每天重置、能从 submissions 现算；
 *    能量**跨天留存**（昨天剩的点数今天还在，那正是钩子），所以必须落库。
 *
 * ⚠️⚠️ **流水是真相，users.energy 是缓存**。两者一律在**同一个事务里**写 ——
 *    分开写就一定会漂移，而「余额和流水对不上」是最难查的一类问题
 *    （没有任何东西看起来是坏的）。
 *
 * ⚠️ 所有加减都走 **SELECT ... FOR UPDATE → 算 → UPDATE**，不写 SQL 表达式：
 *    行锁在手时读改写是安全的，而写成 energy = energy - 2 这种表达式
 *    反而看不出"到底扣没扣成"（要靠 affectedRows 判断，很容易漏）。
 *
 * ⚠️ 两阶段：**受理时锁 → 接口返回时结算**（这是两个问题，不要混）：
 *    · 锁 —— 防并发提交把同一份能量用两遍
 *    · 结算 —— 成功实扣、失败解锁退回
 */

/** 流水的 reason 取值。奖励规则的 code 也走这个字段 */
export const ENERGY_REASON = {
  dailyTopUp: 'daily_topup',
  hold: 'challenge_hold',
  release: 'challenge_release',
  purchase: 'purchase',
  admin: 'admin',
} as const

/** 读余额（行锁住的版本，供事务内部复用） */
async function lockedEnergy(ex: Executor, userId: number): Promise<number | null> {
  const [row] = await ex
    .select({ energy: users.energy })
    .from(users)
    .where(eq(users.id, userId))
    .for('update')
  return row ? row.energy : null
}

/**
 * ⭐ 每日补足 —— **惰性 + 幂等**，不引入定时任务。
 *
 * ~~~
 * if (energyDate != today) { energy = max(energy, 3); energyDate = today }
 * ~~~
 *
 * ⚠️ 用 **max 而不是「重置为 3」**：充值 / 奖励来的点数不会被每一天抹掉。
 * ⚠️ 幂等靠 energyDate：同一天调多少次都只补一次。
 *
 * @returns 补足之后的余额
 */
export async function topUpEnergy(userId: number, now: Date = new Date()): Promise<number> {
  const day = dayOf(now)

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ energy: users.energy, date: users.energyDate })
      .from(users)
      .where(eq(users.id, userId))
      .for('update')
    if (!row) return 0
    if (row.date === day) return row.energy

    const next = Math.max(row.energy, ENERGY_DAILY_FLOOR)
    await tx.update(users).set({ energy: next, energyDate: day }).where(eq(users.id, userId))

    // 补了多少记多少 —— 没补（本来就 >= 3）就不写流水，免得留一堆 delta=0 的行
    if (next > row.energy) {
      await tx.insert(energyLedger).ignore().values({
        userId,
        delta: next - row.energy,
        reason: ENERGY_REASON.dailyTopUp,
        refType: 'day',
        refId: day,
      })
    }
    return next
  })
}

/** 读余额（先补足再读 —— 所有读余额的地方都必须经过它） */
export async function readEnergy(userId: number, now: Date = new Date()): Promise<number> {
  return topUpEnergy(userId, now)
}

/** 这条提交锁过能量没有（幂等判据） */
async function ledgerRow(
  ex: Executor,
  reason: string,
  userId: number,
  submissionId: string,
): Promise<boolean> {
  const [row] = await ex
    .select({ id: energyLedger.id })
    .from(energyLedger)
    .where(
      and(
        eq(energyLedger.reason, reason),
        eq(energyLedger.refType, 'submission'),
        eq(energyLedger.refId, submissionId),
        eq(energyLedger.userId, userId),
      ),
    )
    .limit(1)
  return !!row
}

/**
 * ⭐ 受理时**锁**住这次挑战要消耗的能量。
 *
 * ⚠️ 幂等：同一条提交重复锁只会生效一次（重试、并发重发都不会多扣）。
 * ⚠️ 余额不够时**整个事务回滚**（流水一行都不留），返回 false 让路由回 429。
 */
export async function holdChallengeEnergy(
  userId: number,
  submissionId: string,
  now: Date = new Date(),
): Promise<boolean> {
  await topUpEnergy(userId, now)

  return db.transaction(async (tx) => {
    // ① 已经锁过这条提交了？（重试 / 并发）—— 幂等命中就当成功
    if (await ledgerRow(tx, ENERGY_REASON.hold, userId, submissionId)) return true

    // ② 余额够不够（行锁住，避免并发把同一份能量用两遍）
    const energy = await lockedEnergy(tx, userId)
    if (energy === null || energy < ENERGY_PER_CHALLENGE) return false

    await tx.update(users).set({ energy: energy - ENERGY_PER_CHALLENGE }).where(eq(users.id, userId))
    await tx.insert(energyLedger).values({
      userId,
      delta: -ENERGY_PER_CHALLENGE,
      reason: ENERGY_REASON.hold,
      refType: 'submission',
      refId: submissionId,
    })
    return true
  })
}

/**
 * ⭐ 结算：打分**失败**时把锁退回。
 *
 * ⚠️ 用户可见的说法是「这次检测没通过，**能量已退回**」——
 *    讯飞那边失败也可能计费，那是我们承担的成本，不转嫁给用户
 *    （读不出来还扣钱，解释不通）。
 * ⚠️ 幂等：没锁过就什么都不做；已经退过也不再退。
 *
 * @returns 是否真的退了一笔
 */
export async function releaseChallengeEnergy(userId: number, submissionId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!(await ledgerRow(tx, ENERGY_REASON.hold, userId, submissionId))) return false
    if (await ledgerRow(tx, ENERGY_REASON.release, userId, submissionId)) return false

    const energy = await lockedEnergy(tx, userId)
    if (energy === null) return false

    await tx.update(users).set({ energy: energy + ENERGY_PER_CHALLENGE }).where(eq(users.id, userId))
    await tx.insert(energyLedger).values({
      userId,
      delta: ENERGY_PER_CHALLENGE,
      reason: ENERGY_REASON.release,
      refType: 'submission',
      refId: submissionId,
    })
    return true
  })
}

/**
 * ⭐ 入账的**事务内实现** —— 供 grantEnergy 与奖励系统共用。
 *
 * ⚠️ 幂等键是 (reason, refType, refId, user)：同一条规则对同一个对象只发一次。
 *    重放、补跑、并发、改配置，全靠它兜底。
 */
export async function addEnergy(
  ex: Executor,
  input: { userId: number; amount: number; reason: string; refType: string; refId: string },
): Promise<boolean> {
  if (!Number.isFinite(input.amount) || input.amount <= 0) return false

  const [dup] = await ex
    .select({ id: energyLedger.id })
    .from(energyLedger)
    .where(
      and(
        eq(energyLedger.reason, input.reason),
        eq(energyLedger.refType, input.refType),
        eq(energyLedger.refId, input.refId),
        eq(energyLedger.userId, input.userId),
      ),
    )
    .limit(1)
  if (dup) return false

  const energy = await lockedEnergy(ex, input.userId)
  if (energy === null) return false

  await ex.update(users).set({ energy: energy + input.amount }).where(eq(users.id, input.userId))
  await ex.insert(energyLedger).values({
    userId: input.userId,
    delta: input.amount,
    reason: input.reason,
    refType: input.refType,
    refId: input.refId,
  })
  return true
}

/**
 * ⭐ 入账（充值 / 行为奖励 / 运营补偿）—— **奖励系统唯一的下发口**。
 *
 * ⚠️ reason 传奖励规则的 code（比如 streak_freeze_7），这样流水能追溯到规则。
 *
 * @returns 是否真的发了（false = 幂等命中 / 已发过 / 金额非正）
 */
export async function grantEnergy(input: {
  userId: number
  amount: number
  reason: string
  refType: string
  refId: string
}): Promise<boolean> {
  return db.transaction((tx) => addEnergy(tx, input))
}
