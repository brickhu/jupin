/**
 * ⭐ 挑战记录的时间显示 —— **精确到分**。
 *
 * 规则（越近说得越细，越远越像日期）：
 *   刚刚 / N 分钟前 / 今天 14:03 / 昨天 14:03 / 09-21 14:03 / 2025-09-21 14:03
 *
 * ⚠️⚠️ 绝对时刻一律按**北京时间（UTC+8）**算，不用设备本地时区。
 *    理由和排期的「今天」是同一条：手机时间可以随便改，
 *    而这里的时刻是**服务端给的**（库里存 UTC）。
 *    用设备时区的话，一个把手机设成 UTC 的用户会看到「昨天 22:03」这种错位。
 * ⚠️ 相对时间（N 分钟前）不需要时区，它只用两个时间戳相减。
 */

/** 北京时间的偏移（分钟）—— 全站只有这一处换算 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 把时刻换算成北京时间的「年月日时分」—— 用 UTC 取值器读，避免再被本地时区影响一次 */
function beijingParts(t: number): { y: number; m: number; d: number; hh: string; mm: string } {
  const d = new Date(t + BEIJING_OFFSET_MS)
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    hh: pad2(d.getUTCHours()),
    mm: pad2(d.getUTCMinutes()),
  }
}

/** 北京时间的「年月日」—— 只用来判断今天 / 昨天 / 是不是今年 */
function beijingDay(t: number): string {
  const p = beijingParts(t)
  return p.y + '-' + pad2(p.m) + '-' + pad2(p.d)
}

/**
 * 挑战记录的时间文案。
 *
 * ⚠️ now 可传：单测要一个固定的「现在」，否则断言只能写成「包含分钟前」这种废话。
 * ⚠️ 拿不到/解析不了的时间返回空串 —— 让调用方**不渲染**那一格，
 *    而不是画一个 Invalid Date 在界面上。
 */
export function agoText(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''

  const diff = now - t
  // ⚠️ 未来时间（设备时钟偏慢）不要显示成「-3 分钟前」—— 当成刚刚
  if (diff < 60_000) return '刚刚'
  if (diff < 60 * 60_000) return Math.floor(diff / 60_000) + ' 分钟前'

  const p = beijingParts(t)
  const clock = p.hh + ':' + p.mm
  const day = beijingDay(t)
  if (day === beijingDay(now)) return '今天 ' + clock
  if (day === beijingDay(now - 24 * 60 * 60_000)) return '昨天 ' + clock
  if (p.y === beijingParts(now).y) return pad2(p.m) + '-' + pad2(p.d) + ' ' + clock
  return p.y + '-' + pad2(p.m) + '-' + pad2(p.d) + ' ' + clock
}