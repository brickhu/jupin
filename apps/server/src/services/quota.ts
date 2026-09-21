import { FREE_DAILY_CHALLENGES, MAX_INVALID_PER_DAY, MEMBER_DAILY_CHALLENGES } from '@jushuo/shared'

/**
 * ⭐ 挑战门禁 —— **只有一条规则：今天还剩几次**。
 *
 *   免费 FREE_DAILY_CHALLENGES 次 / 付费 MEMBER_DAILY_CHALLENGES 次，**与句子无关**。
 *
 * ⚠️⚠️ 它取代了之前那套「每句额度 + 2 分钟间隔」。换掉的理由是**用户讲不清**：
 *    · 每句额度 —— 每换一句就换一个数，"这句还能读几次"要一句句记；
 *      而"每天 1 次"一句话就能说完，而且**明天会回来**，是可预期的。
 *    · 2 分钟间隔 —— 用户撞上它的时候往往在读第 2 次（正想练），
 *      得到的却是一句"太频繁了"，而他从头到尾没做错任何事。
 *      它的防刷价值在有每日上限之后也基本没了：一天最多 50 次，
 *      脚本也就只能刷 50 次 —— 上限本身已经封住了。
 *
 * ⚠️ 付费那 50 次是**硬上限**，不是"无限"：脚本刷分同样要拦。
 *
 * ⚠️ 纯函数（不碰 IO、不在内部取 Date.now）：这类规则最容易写错在边界上，
 *    必须能被单测逐条钉住。
 */

export type GateCode = 'QUOTA_EXHAUSTED'

export interface ChallengeGate {
  allowed: boolean
  code?: GateCode
  /** free = 免费用户今天那几次用完了（付费可以继续）；cap = 付费用户今天也满了 */
  reason?: 'free' | 'cap'
  /** 今天已经**打分成功**的次数（失败的不算 —— 见 services/submission.ts 的口径说明） */
  usedToday: number
  /** 当前身份的每日上限 */
  dailyLimit: number
}

/** 当前身份每天能挑战几次 */
export function dailyLimitOf(isMember: boolean): number {
  return isMember ? MEMBER_DAILY_CHALLENGES : FREE_DAILY_CHALLENGES
}

export function checkChallenge(input: { usedToday: number; isMember: boolean }): ChallengeGate {
  const dailyLimit = dailyLimitOf(input.isMember)

  if (input.usedToday >= dailyLimit) {
    return {
      allowed: false,
      code: 'QUOTA_EXHAUSTED',
      reason: input.isMember ? 'cap' : 'free',
      usedToday: input.usedToday,
      dailyLimit,
    }
  }

  return { allowed: true, usedToday: input.usedToday, dailyLimit }
}

/**
 * 无效提交（音频读不出来 / 引擎判无效）：**不扣额度**，但计数；
 * 当天连续超过上限则当天暂停。
 *
 * ⚠️ 它是这套规则里**唯一的防滥用闸门**了（间隔规则已经下线），所以必须留着：
 *    额度只数"打分成功"的那几次，否则用户读不出来也要扣次数 —— 那没法解释。
 *    但"不扣次数"就意味着垃圾音频可以反复撞接口，这个上限拦的正是那个：
 *    连撞 MAX_INVALID_PER_DAY 次当天就不受理了。
 */
export function trackInvalid(
  invalidCount: number,
  invalidDate: string | null,
  today: string,
): { count: number; blocked: boolean } {
  const count = invalidDate === today ? invalidCount + 1 : 1
  return { count, blocked: count >= MAX_INVALID_PER_DAY }
}
