import { daysBetween, isValidDay, today } from '@jushuo/shared'

/**
 * 可以对历史挑战「再次挑战」，但只限最近这些天 ——
 * 再往前就不给伪造历史的余地了。
 */
export const MAX_BACKFILL_DAYS = 30

/**
 * 校验并归一化客户端声明的挑战日期。
 *
 * ⚠️ 一共三道，缺一不可：
 *    ① 格式与真实性 —— isValidDay 会把 2026-02-30 这种「格式对但不存在」的挡掉
 *    ② 不能是未来
 *    ③ 不能太旧 —— 否则可以伪造任意日期的成绩，把历史榜单刷成自己的
 *
 * @returns 'YYYY-MM-DD'，非法时返回 null
 */
export function resolveScheduleDate(input: string | undefined | null): string | null {
  const now = today()
  // ⚠️ 缺省取今天 —— 老版本客户端不传这个字段，不能因此整个提交失败
  if (!input) return now
  if (!isValidDay(input)) return null
  const back = daysBetween(input, now)
  if (back < 0) return null // 未来
  if (back > MAX_BACKFILL_DAYS) return null // 太旧
  return input
}
