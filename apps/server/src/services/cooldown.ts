import { FREE_COOLDOWN_MS, MAX_INVALID_PER_DAY } from '@jushuo/shared'

/**
 * ⭐ 24 小时滚动冷却。
 *
 * ⚠️ 必须是「上次提交 + 24h」，**不能是自然日重置**。
 *    自然日重置的漏洞：用户 23:59 提交、00:01 再提交，间隔只有 2 分钟。
 */

export function nextFreeAtFrom(now: Date = new Date()): Date {
  return new Date(now.getTime() + FREE_COOLDOWN_MS)
}

export function canSubmitFree(
  nextFreeAt: Date,
  subscriptionEnd: Date | null,
  now: Date = new Date(),
): { allowed: boolean; reason?: 'COOLDOWN'; nextFreeAt: Date } {
  // 会员不受冷却限制
  if (subscriptionEnd && subscriptionEnd > now) {
    return { allowed: true, nextFreeAt }
  }
  if (nextFreeAt > now) {
    return { allowed: false, reason: 'COOLDOWN', nextFreeAt }
  }
  return { allowed: true, nextFreeAt }
}

/** 无效提交：不起冷却，但计数；连续超过上限则当天暂停 */
export function trackInvalid(
  invalidCount: number,
  invalidDate: string | null,
  today: string,
): { count: number; blocked: boolean } {
  const count = invalidDate === today ? invalidCount + 1 : 1
  return { count, blocked: count >= MAX_INVALID_PER_DAY }
}
