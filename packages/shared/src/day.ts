/**
 * 「一天」的定义 —— **只有这一处**。
 *
 * ⚠️⚠️ Streak（连续天数）的全部正确性都押在「今天算哪一天」上，
 *    而它有三个天真的写法各自都是错的：
 *
 *      ① 用 `new Date().toISOString().slice(0,10)` —— 那是 **UTC 日**。
 *         北京时间 8/21 早上 7 点，UTC 还是 8/20。用户连着两天早上打卡，
 *         第二次会被算成「同一天」，streak 纹丝不动 —— 而且不报错。
 *      ② 用容器/手机的本地时区 —— 服务端跑在 UTC 容器里，客户端跑在用户手机上，
 *         两边算出不同的「今天」，客户端显示 +1、服务端记 0。
 *      ③ 用「距上次打卡 24 小时」—— 那用户每天晚一小时读，第 25 天就断了。
 *
 *   所以：**按固定偏移（北京时间）切自然日，前后端共用这一份实现**。
 *
 * ⚠️ 为什么用固定偏移而不是真正的时区库：
 *    目标用户只有中国大陆，没有夏令时，UTC+8 是恒定偏移。
 *    引入 tz 库会让小程序包体和端侧负担都变大，换不来任何正确性。
 */

/** 应用时区相对 UTC 的偏移（分钟）。+480 = 北京时间 UTC+8 */
export const APP_TZ_OFFSET_MINUTES = 8 * 60

const MS_PER_DAY = 86_400_000

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

/** 某个 UTC 时刻，落在应用时区的哪一天 —— 'YYYY-MM-DD' */
export function dayKey(at: Date, offsetMinutes: number = APP_TZ_OFFSET_MINUTES): string {
  const shifted = new Date(at.getTime() + offsetMinutes * 60_000)
  return (
    shifted.getUTCFullYear() +
    '-' +
    pad2(shifted.getUTCMonth() + 1) +
    '-' +
    pad2(shifted.getUTCDate())
  )
}

/** 当前时刻所在的自然日 */
export function today(now: Date = new Date()): string {
  return dayKey(now)
}

/**
 * 'YYYY-MM-DD' → 该日的**序号**（1970-01-01 = 0）。
 * ⚠️ 用 UTC 解析：字符串本身已经是我们切好的自然日，再叠加本地时区就会偏移一天。
 */
export function dayNumber(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return Math.floor(Date.UTC(y, m - 1, d) / MS_PER_DAY)
}

/** 序号 → 'YYYY-MM-DD' */
export function dayFromNumber(n: number): string {
  const at = new Date(n * MS_PER_DAY)
  return at.getUTCFullYear() + '-' + pad2(at.getUTCMonth() + 1) + '-' + pad2(at.getUTCDate())
}

/** b - a，单位「天」。同日为 0，昨天为 1，明天为 -1 */
export function daysBetween(a: string, b: string): number {
  return dayNumber(b) - dayNumber(a)
}

/** day 加减 n 天 */
export function addDays(day: string, n: number): string {
  return dayFromNumber(dayNumber(day) + n)
}

/**
 * 校验 'YYYY-MM-DD' —— 用于挡掉库里可能存在的脏数据。
 * ⚠️ 往返一次序号而不是只查正则：'2026-02-30' 格式完全合法，
 *    但 Date.UTC 会把它规范化成 3 月 2 日，往返就对不上。
 */
export function isValidDay(day: string | null | undefined): day is string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  return dayFromNumber(dayNumber(day)) === day
}
