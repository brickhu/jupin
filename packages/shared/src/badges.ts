/**
 * 等级徽章 —— 由 streakBest **推导**，不落库。
 *
 * ⚠️ 为什么刻意不建 badges 表：
 *    徽章 = f(历史最长连续天数)，而 streakBest 只增不减 ——
 *    也就是说「用户拥有哪些徽章」是**已经存在的数据的一个纯函数**。
 *    单独存一份就是第二份真相：补签、修数据、迁移时两者必然漂移，
 *    而漂移出来的 bug（「我明明有 100 天徽章，页面上没了」）极难解释。
 *    真到了需要「非 streak 徽章」（比如首次满分）的那天，再建表也不迟。
 *
 * ⚠️ 依据**历史最长**而不是**当前**连续天数：
 *    断档那天徽章被收走，只会让用户觉得白干了并弃用；
 *    留着它，用户回来时看到的是「你曾经到过这里」。
 */

export interface BadgeDef {
  code: string
  /** 达到该徽章所需的**历史最长**连续天数 */
  days: number
  name: string
  emoji: string
  /** 一句话说明 */
  blurb: string
}

/** 阶梯 —— 前密后疏：早期要密集给反馈，后期才拉长 */
export const BADGES: readonly BadgeDef[] = [
  { code: 'seed', days: 1, name: '启程', emoji: '🌱', blurb: '读出了第一句' },
  { code: 'sprout', days: 3, name: '不辍', emoji: '🌿', blurb: '连着三天都来了' },
  { code: 'flame', days: 7, name: '一周', emoji: '🔥', blurb: '满一周，拿到第一张 Freeze' },
  { code: 'spark', days: 14, name: '半月', emoji: '⚡', blurb: '连续两周' },
  { code: 'medal', days: 30, name: '一月', emoji: '🏅', blurb: '连续一个月' },
  { code: 'gem', days: 60, name: '两月', emoji: '💎', blurb: '两个月一天没断' },
  { code: 'crown', days: 100, name: '百日', emoji: '👑', blurb: '连续一百天' },
  { code: 'trophy', days: 365, name: '一年', emoji: '🏆', blurb: '整整一年' },
] as const

/** 已获得的徽章（按天数升序） */
export function badgesFor(streakBest: number): BadgeDef[] {
  return BADGES.filter((b) => streakBest >= b.days)
}

/** 当前最高等级的徽章；还没入门时返回 null */
export function latestBadge(streakBest: number): BadgeDef | null {
  const earned = badgesFor(streakBest)
  return earned.length ? (earned[earned.length - 1] as BadgeDef) : null
}

/** 下一个目标；已到顶返回 null */
export function nextBadge(streakBest: number): BadgeDef | null {
  return BADGES.find((b) => streakBest < b.days) ?? null
}

/** 距下一个徽章还差几天；已到顶返回 0 */
export function daysToNextBadge(streakBest: number): number {
  const next = nextBadge(streakBest)
  return next ? next.days - streakBest : 0
}
