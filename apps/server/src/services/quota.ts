import {
  CHALLENGE_INTERVAL_MS,
  FREE_ATTEMPTS_PER_SENTENCE,
  MAX_INVALID_PER_DAY,
  MEMBER_ATTEMPTS_PER_SENTENCE,
} from '@jushuo/shared'

/**
 * ⭐ 挑战门禁 —— **两条独立的规则**，两条都要过。
 *
 *   ① **每句额度**：免费 `FREE_ATTEMPTS_PER_SENTENCE` 次 / 付费 `MEMBER_ATTEMPTS_PER_SENTENCE` 次。
 *      付费那 20 次是**硬上限**，不是"无限" —— 脚本刷分同样要拦。
 *   ② **挑战间隔**：两次提交之间至少 `CHALLENGE_INTERVAL_MS`（防刷机）。
 *
 * ⚠️⚠️ 为什么两条都要，只留一条会漏：
 *    · 只留额度 —— 额度是**按句子**算的，换一句就重置，
 *      「把整个句库连着刷一遍」完全不受限；
 *    · 只留间隔 —— 一句读 20 次只是"慢一点的刷"，额度才是它的上限。
 *
 * ⚠️ 为什么它取代了原来的「24 小时滚动冷却」：
 *    时钟冷却回答的是「你多久没来了」，而用户真正在意的是
 *    「**这句话**我还能再读几次」—— 同一句重读是练，不是刷。
 *    换成按句计数之后，「昨天读过、今天想再读一次」不再被拦。
 *
 * ⚠️ 纯函数（不碰 IO、不在内部取 Date.now）：这类规则最容易写错在边界上，
 *    必须能被单测逐条钉住。
 */

export type GateCode = 'QUOTA_EXHAUSTED' | 'TOO_FREQUENT'

export interface ChallengeGate {
  allowed: boolean
  code?: GateCode
  /** 仅 QUOTA_EXHAUSTED：free = 免费额度用完（付费可以继续），cap = 付费用户的每句硬上限 */
  reason?: 'free' | 'cap'
  /** 这一句已经挑战了几次（含本次之前的历史） */
  attempts: number
  /** 当前身份的上限 */
  limit: number
  /** 仅 TOO_FREQUENT：还要等多少秒 */
  retryAfterSec?: number
}

/** 当前身份每句能挑战几次 */
export function attemptLimitOf(isMember: boolean): number {
  return isMember ? MEMBER_ATTEMPTS_PER_SENTENCE : FREE_ATTEMPTS_PER_SENTENCE
}

export function checkChallenge(input: {
  /** 这一句已经**打分成功**的次数（失败的不算 —— 见 services/submission.ts 的口径说明） */
  attempts: number
  isMember: boolean
  /** 该用户**上一次提交**的时间（任意句子、任意状态），没有则为 null */
  lastSubmitAt: Date | null
  now?: Date
}): ChallengeGate {
  const now = input.now ?? new Date()
  const limit = attemptLimitOf(input.isMember)

  // ① 每句额度
  if (input.attempts >= limit) {
    return {
      allowed: false,
      code: 'QUOTA_EXHAUSTED',
      reason: input.isMember ? 'cap' : 'free',
      attempts: input.attempts,
      limit,
    }
  }

  // ② 挑战间隔
  if (input.lastSubmitAt) {
    const elapsed = now.getTime() - input.lastSubmitAt.getTime()
    if (elapsed < CHALLENGE_INTERVAL_MS) {
      return {
        allowed: false,
        code: 'TOO_FREQUENT',
        attempts: input.attempts,
        limit,
        // ⚠️ 向上取整且至少 1：还剩 0.4 秒时说「0 秒后可再试」等于让他立刻再撞一次
        retryAfterSec: Math.max(1, Math.ceil((CHALLENGE_INTERVAL_MS - elapsed) / 1000)),
      }
    }
  }

  return { allowed: true, attempts: input.attempts, limit }
}

/**
 * 无效提交（音频读不出来 / 引擎判无效）：**不扣额度**，但计数；
 * 当天连续超过上限则当天暂停。
 *
 * ⚠️ 它和上面的额度是两件事：额度记的是「有效挑战」，
 *    这里防的是「拿垃圾音频反复撞接口」——所以**不占用**用户真正想读的那一次。
 */
export function trackInvalid(
  invalidCount: number,
  invalidDate: string | null,
  today: string,
): { count: number; blocked: boolean } {
  const count = invalidDate === today ? invalidCount + 1 : 1
  return { count, blocked: count >= MAX_INVALID_PER_DAY }
}
