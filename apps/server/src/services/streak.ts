import { eq } from 'drizzle-orm'
import {
  applyRead,
  badgesFor,
  daysToNextBadge,
  latestBadge,
  nextBadge,
  today,
  type BadgeDef,
  type StreakState,
  type StreakView,
} from '@jushuo/shared'
import { db } from '../db'
import { users } from '../db/schema'
import type { User } from './user'

/**
 * Streak 的**读写边界** —— 规则本身全在 `@jushuo/shared/streak.ts` 的纯函数里，
 * 这里只做「查库 → 调用纯函数 → 写回」。
 *
 * ⚠️ 刻意不在这里做任何日期计算：一旦路由/服务里出现 `new Date()` 或 `+86400000`，
 *    跨天、跨月、跨年、时钟回拨这些边界就再也单测不到了。
 */

function stateOf(user: User): StreakState {
  return {
    streakDays: user.streakDays,
    streakBest: user.streakBest,
    lastReadDate: user.lastReadDate,
    freezeCount: user.freezeCount,
  }
}

/** 把库里的状态组装成客户端要的展示视图 */
export function streakView(state: StreakState, date: string = today()): StreakView {
  const best = state.streakBest
  return {
    streakDays: state.streakDays,
    streakBest: best,
    // ⭐ 「今天读没读」由**服务端的日期**判定，不信客户端时钟。
    //    手机时间可以随便改；让本地判断只会出现「本地显示已打卡、服务端不认」。
    readToday: state.lastReadDate === date,
    freezeCount: state.freezeCount,
    badge: latestBadge(best),
    nextBadge: nextBadge(best),
    daysToNext: daysToNextBadge(best),
  }
}

/** 直接读库并组装视图（用于 /me、/daily 这类只读场景） */
export async function readStreakView(userId: number, date: string = today()): Promise<StreakView> {
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  // 用户一定存在（鉴权中间件已经保证），这里只是给一个语义明确的兜底
  const state: StreakState = row
    ? stateOf(row)
    : { streakDays: 0, streakBest: 0, lastReadDate: null, freezeCount: 0 }
  return streakView(state, date)
}

export interface ReadResult {
  /** 写回后的最新状态（可直接组装视图） */
  state: StreakState
  counted: boolean
  delta: number
  freezeUsed: number
  freezeEarned: number
  /** 本次新解锁的徽章 —— 结果页要弹「🏅 解锁 一周」 */
  newBadges: BadgeDef[]
}

/**
 * 记录「某一天读了一句」并落库。
 *
 * ⚠️ @param date 由调用方传**用户实际提交那一刻**所在的那一天
 *    （见 services/scoring.ts：用的是 submissions.created_at，不是打分完成的时刻，
 *    也不是首页那张列表上的 challenge_date）。
 *    默认值 today() 只是给「手工补签 / 排查」这类场景的便利，
 *    正式链路必须显式传。
 *
 * ⚠️ **幂等**：同一天调多少次都只算一次（纯函数里已挡住），所以可以放心地
 *    在「提交打分成功」的路径上直接调用，不必先查再调。
 *
 * ⚠️ 只在这条路径上计入 —— 打卡必须**绑定在真实产出上**（一段被评测过的录音）。
 *    单独一个「签到」按钮会让 streak 变成点一下就有，也就不再有任何意义。
 */
export async function recordRead(userId: number, date: string = today()): Promise<ReadResult> {
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!row) throw new Error(`用户不存在: ${userId}`)

  const before = stateOf(row)
  const outcome = applyRead(before, date)

  // 没被计入（今天已经读过）就不写库 —— 省一次 UPDATE，也避免无谓的 updated 语义
  if (!outcome.counted) {
    return {
      state: before,
      counted: false,
      delta: 0,
      freezeUsed: 0,
      freezeEarned: 0,
      newBadges: [],
    }
  }

  const state: StreakState = {
    streakDays: outcome.streakDays,
    streakBest: outcome.streakBest,
    lastReadDate: outcome.lastReadDate,
    freezeCount: outcome.freezeCount,
  }
  await db
    .update(users)
    .set({
      streakDays: state.streakDays,
      streakBest: state.streakBest,
      lastReadDate: state.lastReadDate,
      freezeCount: state.freezeCount,
    })
    .where(eq(users.id, userId))

  // ⭐ 新解锁的徽章 = 现在的 − 之前的。
  //    用「徽章集合的差」而不是「正好等于某一个阈值」：
  //    补签一次可能跨过两个阈值（比如 Freeze 一次性补上 8 天），
  //    写成等号判断就会漏发。
  const ownedBefore = new Set(badgesFor(before.streakBest).map((b) => b.code))
  const newBadges = badgesFor(state.streakBest).filter((b) => !ownedBefore.has(b.code))

  return {
    state,
    counted: true,
    delta: outcome.delta,
    freezeUsed: outcome.freezeUsed,
    freezeEarned: outcome.freezeEarned,
    newBadges,
  }
}
