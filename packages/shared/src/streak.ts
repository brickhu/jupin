import { daysBetween } from './day'

/**
 * Streak（连续朗读天数）—— **纯函数，零 IO**。
 *
 * 产品定义（做减法后的三条核心之一）：
 *   · 每天读一句 → streak +1
 *   · 每连续满 7 天 → 得 1 个 Freeze（冻结卡）
 *   · 断档时**自动**消耗 Freeze 补上断掉的天数；不够补就归 1
 *   · streakBest 只增不减 —— 它是徽章的唯一依据，
 *     断档后徽章不该被收回（收回只会让人弃用，不会让人回来）
 *
 * ⚠️⚠️ 为什么整段逻辑必须是纯函数：
 *    这是「用户资产」，写错一次就是永久的数据损坏 —— 而它又是最容易写错的
 *    （跨天、跨月、跨年、补签、时钟回拨）。纯函数才能把边界逐个单测掉。
 */

/** 每连续多少天得 1 个 Freeze */
export const FREEZE_EVERY_DAYS = 7

export interface StreakState {
  /** 当前连续天数 */
  streakDays: number
  /** 历史最长连续天数（只增不减） */
  streakBest: number
  /** 最后一次计入 streak 的自然日 'YYYY-MM-DD'；从未读过为 null */
  lastReadDate: string | null
  /** 手上的冻结卡数量 */
  freezeCount: number
}

export interface ReadOutcome extends StreakState {
  /** 这次读有没有被计入（false = 今天已经读过了，重复读不叠加） */
  counted: boolean
  /** streak 的变化量（+1 / 归 1 后的实际差值 / 0） */
  delta: number
  /** 这次消耗掉几张 Freeze */
  freezeUsed: number
  /** 这次新得了几张 Freeze */
  freezeEarned: number
}

export function newStreakState(): StreakState {
  return { streakDays: 0, streakBest: 0, lastReadDate: null, freezeCount: 0 }
}

/** 满 7 的倍数就发一张 —— 用整除差算，避免「每 7 天」被写成「逢 7 发一次」的重复发 */
function freezeEarnedBetween(before: number, after: number): number {
  return Math.max(
    0,
    Math.floor(after / FREEZE_EVERY_DAYS) - Math.floor(before / FREEZE_EVERY_DAYS),
  )
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
    freezeUsed: 0,
    freezeEarned: 0,
  }

  // ① 今天已经读过 —— 同一天读十遍也只算一次。
  //    这是 streak 的全部意义所在：它奖励的是「回来」，不是「量」。
  if (state.lastReadDate === today) return unchanged

  // ② lastReadDate 落在未来（时钟回拨 / 时区被改）。
  //    不报错、不重置 —— 重置会凭空烧掉用户的 streak，而这台机器的钟不可信。
  //    保持原状，等自然日追上来的那天再继续。
  if (state.lastReadDate && daysBetween(state.lastReadDate, today) <= 0) return unchanged

  let streakDays: number
  let freezeCount = state.freezeCount
  let freezeUsed = 0

  if (!state.lastReadDate) {
    // ③ 第一次读
    streakDays = 1
  } else {
    const gap = daysBetween(state.lastReadDate, today)
    if (gap === 1) {
      // ④ 昨天读过 —— 正常续上
      streakDays = state.streakDays + 1
    } else {
      // ⑤ 断档了。中间漏了 missed 天。
      const missed = gap - 1
      if (freezeCount >= missed) {
        // 用 Freeze 全额补上，streak 不断 —— 今天这一读同样 +1
        freezeCount -= missed
        freezeUsed = missed
        streakDays = state.streakDays + 1
      } else {
        // 补不齐就归 1。
        // ⚠️ 不「部分补」：只补得起一半的话，streak 数字会变得没法解释
        //    （用户看到 30 天变 16 天，只会觉得是 bug）。要么续上，要么重来。
        streakDays = 1
      }
    }
  }

  const freezeEarned = freezeEarnedBetween(state.streakDays, streakDays)
  freezeCount += freezeEarned

  return {
    streakDays,
    streakBest: Math.max(state.streakBest, streakDays),
    lastReadDate: today,
    freezeCount,
    counted: true,
    delta: streakDays - state.streakDays,
    freezeUsed,
    freezeEarned,
  }
}
