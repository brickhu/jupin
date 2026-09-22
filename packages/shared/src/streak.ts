import { daysBetween } from './day'

/**
 * Streak（连续朗读天数）—— **纯函数，零 IO**。
 *
 * 产品定义（做减法后的三条核心之一）：
 *   · 每天读一句 → streak +1
 *   · 断档 → **归 1**（⚠️ 这里不再自动补天，见下）
 *   · streakBest 只增不减 —— 断档后不没收历史最好成绩
 *
 * ⚠️⚠️ 为什么整段逻辑必须是纯函数：
 *    这是「用户资产」，写错一次就是永久的数据损坏 —— 而它又是最容易写错的
 *    （跨天、跨月、跨年、补签、时钟回拨）。纯函数才能把边界逐个单测掉。
 *
 * ⚠️⚠️ **断档不再自动消耗解冻卡**（这条改过，别再改回去）：
 *    卡是用户的资产，**自动花掉别人的东西**是这类系统最容易招骂的地方 ——
 *    尤其它还是花很久攒的。现在断档就是归 1，
 *    想续上得由用户**主动**用解冻卡补签（见 services/unfreeze.ts）。
 *    ⇒ 所以这个文件里没有 freezeCount 这个输入，也不需要它。
 */

export interface StreakState {
  /** 当前连续天数 */
  streakDays: number
  /** 历史最长连续天数（只增不减） */
  streakBest: number
  /** 最后一次计入 streak 的自然日 'YYYY-MM-DD'；从未读过为 null */
  lastReadDate: string | null
}

export interface ReadOutcome extends StreakState {
  /** 这次读有没有被计入（false = 今天已经读过了，重复读不叠加） */
  counted: boolean
  /** streak 的变化量（+1 / 归 1 后的实际差值 / 0） */
  delta: number
}

export function newStreakState(): StreakState {
  return { streakDays: 0, streakBest: 0, lastReadDate: null }
}

/**
 * 记录「今天读了一句」，返回新的 streak 状态。
 *
 * @param today 自然日 'YYYY-MM-DD'，**必须**来自 day.ts 的 today()，
 *              不要在这里 new Date()，否则服务端（UTC 容器）和客户端会各算各的。
 */
export function applyRead(state: StreakState, today: string): ReadOutcome {
  const unchanged: ReadOutcome = {
    ...state,
    counted: false,
    delta: 0,
  }

  // ① 今天已经读过 —— 同一天读十遍也只算一次。
  //    这是 streak 的全部意义所在：它奖励的是「回来」，不是「量」。
  if (state.lastReadDate === today) return unchanged

  // ② lastReadDate 落在未来（时钟回拨 / 时区被改）。
  //    不报错、不重置 —— 重置会凭空烧掉用户的 streak，而这台机器的钟不可信。
  //    保持原状，等自然日追上来的那天再继续。
  if (state.lastReadDate && daysBetween(state.lastReadDate, today) <= 0) return unchanged

  // ③ 昨天读过 → 续上；否则（含第一次）→ 归 1。
  //    ⚠️ 这里**不看解冻卡** —— 断档就是断档，补签是另一条路（用户主动）。
  const streakDays =
    state.lastReadDate !== null && daysBetween(state.lastReadDate, today) === 1
      ? state.streakDays + 1
      : 1

  return {
    streakDays,
    streakBest: Math.max(state.streakBest, streakDays),
    lastReadDate: today,
    counted: true,
    delta: streakDays - state.streakDays,
  }
}
