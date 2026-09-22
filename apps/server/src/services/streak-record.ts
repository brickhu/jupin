import { and, eq, gte, lt } from 'drizzle-orm'
import { addDays, dayFromNumber, dayKey, dayNumber, dayStartUtc, today as dayOf } from '@jushuo/shared'

import { db } from '../db'
import { submissions, unfreezeCards } from '../db/schema'
import { readStreakView } from './streak'

/**
 * ⭐ 「连战记录」—— 一个月的日历：哪天读了（连战）、哪天的缺口是用解冻卡补的。
 *
 * ⚠️⚠️ 这一页的数据**全部是现算的**，不落额外的表：
 *    · 连战日 = 那天有 status='scored' 的提交（按**北京时间**切天，见 day.ts）
 *    · 解冻日 = 被解冻卡补上的那几天 —— 由卡的 used_at 与 used_for_gap **反推**：
 *      补签是把 lastReadDate 从 D−N 推到 D−1（见 ./unfreeze.ts），
 *      所以补的就是「used_at 往前数 N 天」。
 *    ⇒ 存一份"日历表"就是第二份真相，必然和 submissions / unfreeze_cards 漂移。
 *
 * ⚠️ 连战日按**提交那一刻**算（created_at），不是按"这次挑战算哪天"——
 *    与 streak 本身同一条口径（见 services/scoring.ts 那段说明）。
 */

export interface StreakRecordDay {
  date: string
  /** read = 那天读了；unfreeze = 那天的缺口是用解冻卡补上的 */
  kind: 'read' | 'unfreeze'
}

export interface StreakRecordView {
  /** 'YYYY-MM' */
  month: string
  /** 这个月 1 号 'YYYY-MM-DD' */
  firstDay: string
  daysInMonth: number
  /** 1 号是周几（0 = 周日）—— 日历前面的空格用它排，端侧不用再碰日期 */
  weekdayOfFirst: number
  /** 服务端的今天 —— 用来标"今天"那一格，也用来禁用"下一月" */
  today: string
  streakDays: number
  streakBest: number
  days: StreakRecordDay[]
  /** 手上几张（已领取、未用、未过期） */
  unfreezeCards: number
  /** ⭐ 待领取几张 */
  unfreezePending: number
  /** 手上最早到期的日子 */
  unfreezeExpiresOn: string | null
}

/** 校验 'YYYY-MM'，非法返回 null */
export function parseMonth(raw: string | undefined): string | null {
  if (!raw || !/^\d{4}-\d{2}$/.test(raw)) return null
  const month = Number(raw.slice(5, 7))
  return month >= 1 && month <= 12 ? raw : null
}

/** 这个月有多少天 —— 用「下个月 1 号减 1 天」算，闰年自动对 */
export function daysInMonthOf(month: string): number {
  const first = month + '-01'
  // ⚠️ +32 天必定落到下个月（任何月份都是 28–31 天），再取那个月的 1 号 ——
  //    比"记住 30/31、还要判闰年"可靠得多
  const nextMonthFirst = addDays(first, 32).slice(0, 7) + '-01'
  return dayNumber(nextMonthFirst) - dayNumber(first)
}

/** 'YYYY-MM-DD' 是周几（0 = 周日）。⚠️ 1970-01-01 是周四，所以补 4 */
export function weekdayOf(day: string): number {
  return (dayNumber(day) + 4) % 7
}

export async function readStreakRecord(
  userId: number,
  monthInput?: string,
): Promise<StreakRecordView> {
  const today = dayOf()
  const month = parseMonth(monthInput) ?? today.slice(0, 7)
  const firstDay = month + '-01'
  const daysInMonth = daysInMonthOf(month)
  const nextMonthFirst = addDays(firstDay, 32).slice(0, 7) + '-01'

  // ---- 连战日：这个月里"有打分成功的提交"的那些自然日 ----
  const rows = await db
    .select({ createdAt: submissions.createdAt })
    .from(submissions)
    .where(
      and(
        eq(submissions.userId, userId),
        eq(submissions.status, 'scored'),
        // ⚠️ 用 dayStartUtc 圈范围，不是拿日期字符串直接比 ——
        //    库里是 UTC 墙上时间，而"这个月"是北京时间切的，两者整体差 8 小时
        gte(submissions.createdAt, dayStartUtc(firstDay)),
        lt(submissions.createdAt, dayStartUtc(nextMonthFirst)),
      ),
    )

  const readDays = new Set<string>()
  for (const row of rows) readDays.add(dayKey(row.createdAt))

  // ---- 解冻日：从"用过的卡"反推它补了哪几天 ----
  const cards = await db
    .select({ usedAt: unfreezeCards.usedAt, usedForGap: unfreezeCards.usedForGap })
    .from(unfreezeCards)
    .where(eq(unfreezeCards.userId, userId))

  const unfreezeDays = new Set<string>()
  for (const c of cards) {
    if (!c.usedAt || !c.usedForGap) continue
    const usedDay = dayOf(c.usedAt)
    // 补签把 lastReadDate 推到 usedAt 的前一天，所以覆盖的是 usedAt−gap .. usedAt−1
    for (let i = 1; i <= c.usedForGap; i++) unfreezeDays.add(addDays(usedDay, -i))
  }

  const days: StreakRecordDay[] = []
  for (let i = 0; i < daysInMonth; i++) {
    const date = addDays(firstDay, i)
    if (readDays.has(date)) days.push({ date, kind: 'read' })
    else if (unfreezeDays.has(date)) days.push({ date, kind: 'unfreeze' })
  }

  const streak = await readStreakView(userId, today)

  return {
    month,
    firstDay,
    daysInMonth,
    weekdayOfFirst: weekdayOf(firstDay),
    today,
    streakDays: streak.streakDays,
    streakBest: streak.streakBest,
    days,
    unfreezeCards: streak.unfreezeCards,
    unfreezePending: streak.unfreezePending,
    unfreezeExpiresOn: streak.unfreezeExpiresOn,
  }
}
