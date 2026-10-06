import { and, eq, gte, lt } from 'drizzle-orm'
import { addDays, dayFromNumber, dayKey, dayNumber, dayStartUtc, today as dayOf } from '@jushuo/shared'
import type { MakeupState } from '@jushuo/shared'

import { db } from '../db'
import { submissions } from '../db/schema'
import { readStreakView } from './streak'

/**
 * ⭐ 「连战记录」—— 一个月的日历：哪天读了（连战）。
 *
 * ⚠️⚠️ 这一页的数据**全部是现算的**，不落额外的表：
 *    连战日 = 那天有 status='scored' 的提交（按**北京时间**切天，见 day.ts）。
 *    ⇒ 存一份"日历表"就是第二份真相，必然和 submissions 漂移。
 *
 * ⚠️ 这里原来还有第二种格子「**解冻日**」（被解冻卡补上的那几天，从卡的
 *    used_at / used_for_gap 反推）。2026-10 解冻卡整体作废，那种格子随之消失 ——
 *    补签在新的口径里是**花能量**，但它同样只是把 lastReadDate 往前推，
 *    而"补了哪几天"照样能从 lastReadDate 与提交记录推出来（见 prd §7.8）。
 *
 * ⚠️ 连战日按**提交那一刻**算（created_at），不是按"这次挑战算哪天"——
 *    与 streak 本身同一条口径（见 services/scoring.ts 那段说明）。
 */

export interface StreakRecordDay {
  date: string
  /** ⚠️ 只剩 read 一种 —— 「unfreeze」那种格子随解冻卡一起作废（2026-10） */
  kind: 'read'
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
  /** ⭐ 补签的当前状态 —— 与 StreakView.makeup 同一份口径（这一页是补签的唯一入口） */
  makeup: MakeupState
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

  const days: StreakRecordDay[] = []
  for (let i = 0; i < daysInMonth; i++) {
    const date = addDays(firstDay, i)
    if (readDays.has(date)) days.push({ date, kind: 'read' })
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
    makeup: streak.makeup,
  }
}
