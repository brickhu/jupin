import { addDays, daysBetween } from './day'
import type { StreakState } from './streak'

/**
 * ⭐ **补签** —— 断档之后花能量把缺口填上。规格：prd §7.8。
 *
 * ⚠️⚠️ 它取代了原来的「解冻卡」（2026-10 整体作废）：道具补签要多一套
 *    「发卡 → 待领取 → 有效期 → 先到期先用」的机器，而它要做的事就是**花能量**。
 *
 * ## 为什么是能量、不是饼干
 *
 * 🍪 是**资源**（吃的东西），能量是**行动力**。补签是一个**动作**：
 *    · 吃饼干补能量 —— 资源换资源 ✅
 *    · 花力气补签   —— 资源换动作 ✅
 *    · 饼干直接补签 —— 资源直接变动作 ❌（说不通）
 *    所以饼干帮补签的方式是**间接的**：先吃成能量，再用能量补签。
 */

/**
 * ⭐ 补一天要几点能量。
 *
 * ⚠️⚠️ **必须大于「读一句」的 2 点**，这是这个数字唯一的存在理由：
 *    过失的成本要 > 正常消耗的成本，否则"断一天再补"就比"天天读"划算，纪律作废。
 *    改它之前先看 `ENERGY_PER_CHALLENGE`。
 */
export const ENERGY_PER_MAKEUP_DAY = 3

/**
 * ⭐ 最多能补几天。
 *
 * ⚠️ 它是**天数上限**，不是价格上限（prd §7.8 里论证过）：
 *    价格封顶（比如最多收 6 点）会让"断 10 天也能补"，连战当场通胀；
 *    天数上限则让"断太久"只能重来 —— 而重来没那么痛，因为 `streakBest` 不受影响。
 *
 * ⚠️ 3 天是**最常见的断档长度**（出差 / 生病 / 忙一阵）—— 这个数覆盖的是真实场景。
 */
export const MAX_MAKEUP_DAYS = 3

/**
 * ⭐ **补 `gapDays` 天要花多少能量** —— 等差：3 / 6 / 9。
 *
 * ⚠️ 是**等差不是成倍**：成倍（3 → 6 → 12）会让断 3 天变成 12 点，
 *    而每天保底只有 3 点 ⇒ 那是"断得久就别想补了"。
 *    等差既保住"过失 > 正常"，又让 3 天这个上限**够得着**。
 *
 * @param gapDays 缺口天数（中间空着几天）。0 或负数 = 没断档 ⇒ 0
 */
export function makeupCostOf(gapDays: number): number {
  if (!Number.isFinite(gapDays) || gapDays <= 0) return 0
  return ENERGY_PER_MAKEUP_DAY * Math.min(Math.floor(gapDays), MAX_MAKEUP_DAYS)
}

/** 补不了的原因 —— 端侧据此说一句**能行动**的话，而不是"补签失败" */
export type MakeupBlockReason =
  /** 今天已经读过了：缺口要在今天读**之前**补（读完之后今天就不是缺口了，但昨天补不回来了） */
  | 'already-read-today'
  /** 没断档（昨天读过 / 从没读过）—— 不需要补 */
  | 'no-gap'
  /** 断太久，超过上限 —— 只能重来 */
  | 'too-long'

export interface MakeupEligibility {
  /** 能不能补 */
  ok: boolean
  /** 缺口几天（0 = 没断档） */
  gapDays: number
  /** 要花多少能量（ok=false 时也会给，用于把"要多少"摆给用户看） */
  cost: number
  /** ok=false 时说明为什么 */
  reason?: MakeupBlockReason
  /**
   * ⭐ 补完之后 `lastReadDate` 应该被推到哪一天（= 昨天）。
   *
   * ⚠️ 只推到最后读的那天的**次日**、而不是"今天"：
   *    补签只是把缺口**填上**，**它本身不增加天数** ——
   *    用户当天还得真读一句才会 +1（见 prd §7.8）。
   * ⚠️ 也正因为它不写今天，`applyRead` 才会把今天算成"续上"（gap === 1）。
   */
  newLastReadDate?: string
}

/**
 * ⭐⭐ **现在能不能补签、要花多少** —— 纯函数，给定 streak 状态与"今天"。
 *
 * ~~~
 * gap = daysBetween(lastReadDate, today) − 1       ← 中间空着的天数
 *   gap ≤ 0            → no-gap（昨天读过 / 从没读过）
 *   gap > MAX          → too-long
 *   lastReadDate=今天  → already-read-today
 * ~~~
 *
 * ⚠️⚠️ **判据是"今天还没读"**，不是"昨天没读"：
 *    补签必须在**今天读之前**做。今天读过之后再补，昨天那格就永远补不回来了
 *    （`applyRead` 已经把 lastReadDate 写成今天了）。
 *    这不是限制，是逻辑必然 —— 也正因为如此，界面要**催他先补再读**。
 *
 * @param today 'YYYY-MM-DD'，**必须**来自 day.ts 的 today()
 */
export function makeupEligibilityOf(state: StreakState, today: string): MakeupEligibility {
  const nope = (reason: MakeupBlockReason, gapDays = 0): MakeupEligibility => ({
    ok: false,
    gapDays,
    cost: makeupCostOf(gapDays),
    reason,
  })

  // ① 从没读过 —— 没有连战可救
  if (state.lastReadDate === null) return nope('no-gap')

  // ② 今天已经读过 —— 缺口没得补了（见函数头那段）
  if (state.lastReadDate === today) return nope('already-read-today')

  // ③ lastReadDate 落在未来（时钟回拨）—— 当成"没断档"，不给他花冤枉钱
  const elapsed = daysBetween(state.lastReadDate, today)
  if (elapsed <= 0) return nope('no-gap')

  const gapDays = elapsed - 1

  // ④ 昨天读过 ⇒ 没缺口（天天来的人不需要这个功能）
  if (gapDays <= 0) return nope('no-gap')

  // ⑤ 断太久 ⇒ 重来。⚠️ 这里**不报错**，端侧要把它说成"新的开始"而不是失败
  if (gapDays > MAX_MAKEUP_DAYS) return nope('too-long', gapDays)

  return {
    ok: true,
    gapDays,
    cost: makeupCostOf(gapDays),
    newLastReadDate: addDays(today, -1),
  }
}

/**
 * ⭐ 补签那天的**总开销** —— 补签本身 + 当天还要读的那一句。
 *
 * ⚠️ 为什么要有这个函数：用户看到"补签 3 点"会以为花 3 点就够了，
 *    而当天他还得读一句（再 2 点）。总账要摆在明处，否则他会以为界面在骗他。
 * ⚠️ 而"当天必须读"**不是额外要求、是逻辑必然**：今天不读，今天本身就是新缺口
 *    （见 makeupEligibilityOf 的说明）。
 */
export function makeupTotalCostOf(gapDays: number, energyPerChallenge: number): number {
  return makeupCostOf(gapDays) + energyPerChallenge
}
