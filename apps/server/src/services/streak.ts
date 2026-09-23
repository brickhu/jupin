import { eq } from 'drizzle-orm'
import { applyRead, today, type StreakState, type StreakView } from '@jushuo/shared'
import { db } from '../db'
import { users } from '../db/schema'
import type { User } from './user'
import { unfreezeStatus, type UnfreezeStatus } from './unfreeze'

/**
 * Streak 的**读写边界** —— 规则本身全在 `@jushuo/shared/streak.ts` 的纯函数里，
 * 这里只做「查库 → 调用纯函数 → 写回」。
 *
 * ⚠️ 刻意不在这里做任何日期计算：一旦路由/服务里出现 `new Date()` 或 `+86400000`，
 *    跨天、跨月、跨年、时钟回拨这些边界就再也单测不到了。
 *
 * ⚠️⚠️ 这个文件里**没有解冻卡** —— 断档不再自动消耗卡，
 *    发卡是奖励系统的事、用卡是用户主动补签（见 ./unfreeze.ts）。
 *    合并进来只会让"谁在动用户的资产"变得说不清。
 */

function stateOf(user: User): StreakState {
  return {
    streakDays: user.streakDays,
    streakBest: user.streakBest,
    lastReadDate: user.lastReadDate,
  }
}

/** 把库里的状态组装成客户端要的展示视图 */
export function streakView(
  state: StreakState,
  date: string = today(),
  unfreeze: UnfreezeStatus = { count: 0, pending: 0, expiresOn: null },
): StreakView {
  return {
    streakDays: state.streakDays,
    streakBest: state.streakBest,
    // ⭐ 「今天读没读」由**服务端的日期**判定，不信客户端时钟。
    //    手机时间可以随便改；让本地判断只会出现「本地显示已打卡、服务端不认」。
    readToday: state.lastReadDate === date,
    // ⚠️ 卡的三样都由调用方查出来后传进来（现算，见 ./unfreeze.ts）
    unfreezeCards: unfreeze.count,
    unfreezePending: unfreeze.pending,
    unfreezeExpiresOn: unfreeze.expiresOn,
  }
}

/** 直接读库并组装视图（用于 /me、/schedules 这类只读场景） */
export async function readStreakView(userId: number, date: string = today()): Promise<StreakView> {
  const [row, unfreeze] = await Promise.all([
    db.select().from(users).where(eq(users.id, userId)).limit(1),
    unfreezeStatus(userId),
  ])
  /**
   * ⚠️⚠️ 兜底条件必须看 **row[0]**，不能看 row —— 查不到时拿到的是**空数组**，
   *    而空数组是真值，写 `row ? ...` 这条兜底永远不会生效（会直接崩）。
   *    公开页面把它踩出来了：匿名（userId 0）时确实没有这一行。
   * ⚠️ 匿名不是错误：**userId 0 = 匿名**，所有「我的」数据一律为零值。
   */
  const state: StreakState = row[0]
    ? stateOf(row[0] as User)
    : { streakDays: 0, streakBest: 0, lastReadDate: null }
  return streakView(state, date, unfreeze)
}

export interface ReadResult {
  /** 写回后的最新状态（可直接组装视图） */
  state: StreakState
  counted: boolean
  delta: number
}

/**
 * 记录「某一天读了一句」并落库。
 *
 * ⚠️ @param date 由调用方传**用户实际提交那一刻**所在的那一天
 *    （见 services/scoring.ts：用的是 submissions.created_at，不是打分完成的时刻，
 *    也不是首页那张列表上的 challenge_date）。
 *
 * ⚠️ **幂等**：同一天调多少次都只算一次（纯函数里已挡住）。
 *
 * ⚠️ 只在这条路径上计入 —— 打卡必须**绑定在真实产出上**（一段被评测过的录音）。
 */
export async function recordRead(userId: number, date: string = today()): Promise<ReadResult> {
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!row) throw new Error(`用户不存在: ${userId}`)

  const before = stateOf(row)
  const outcome = applyRead(before, date)

  // 没被计入（今天已经读过）就不写库 —— 省一次 UPDATE
  if (!outcome.counted) {
    return { state: before, counted: false, delta: 0 }
  }

  const state: StreakState = {
    streakDays: outcome.streakDays,
    streakBest: outcome.streakBest,
    lastReadDate: outcome.lastReadDate,
  }
  await db
    .update(users)
    .set({
      streakDays: state.streakDays,
      streakBest: state.streakBest,
      lastReadDate: state.lastReadDate,
    })
    .where(eq(users.id, userId))

  return { state, counted: true, delta: outcome.delta }
}
