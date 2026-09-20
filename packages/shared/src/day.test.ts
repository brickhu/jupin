import { describe, expect, it } from 'vitest'
import { addDays, dayKey, dayNumber, daysBetween, isValidDay, today } from './day'

describe('dayKey —— 按北京时间切自然日', () => {
  it('UTC 深夜仍算作北京时间的前一天之后的那一天', () => {
    // 2026-08-20 16:00 UTC = 2026-08-21 00:00 北京时间
    expect(dayKey(new Date('2026-08-20T16:00:00Z'))).toBe('2026-08-21')
    expect(dayKey(new Date('2026-08-20T15:59:59Z'))).toBe('2026-08-20')
  })

  it('⚠️ 这是本文件存在的全部理由：北京时间早上，UTC 日还是昨天', () => {
    // 用户连着两天早上 7 点打卡，若按 UTC 日会算成同一天，streak 纹丝不动
    const morning1 = new Date('2026-08-20T23:00:00Z') // 北京 8/21 07:00
    const morning2 = new Date('2026-08-21T23:00:00Z') // 北京 8/22 07:00
    expect(dayKey(morning1)).toBe('2026-08-21')
    expect(dayKey(morning2)).toBe('2026-08-22')
    expect(daysBetween(dayKey(morning1), dayKey(morning2))).toBe(1)
    // 而 UTC 日会给出「同一天」的错误结论
    expect(morning1.toISOString().slice(0, 10)).not.toBe(dayKey(morning1))
  })

  it('跨年', () => {
    expect(dayKey(new Date('2025-12-31T16:00:00Z'))).toBe('2026-01-01')
  })

  it('today() 与 dayKey(now) 一致', () => {
    const now = new Date('2026-03-01T02:00:00Z')
    expect(today(now)).toBe(dayKey(now))
  })
})

describe('日号运算', () => {
  it('daysBetween 跨月 / 跨年 / 跨闰日', () => {
    expect(daysBetween('2026-08-21', '2026-08-21')).toBe(0)
    expect(daysBetween('2026-08-21', '2026-08-22')).toBe(1)
    expect(daysBetween('2026-08-31', '2026-09-01')).toBe(1)
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1)
    // 2024 是闰年，2/28 → 3/1 中间隔着 2/29
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2)
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1)
  })

  it('addDays 往返一致', () => {
    expect(addDays('2026-08-21', 1)).toBe('2026-08-22')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01')
    for (const d of ['2025-12-31', '2024-02-29', '2026-06-15']) {
      expect(addDays(addDays(d, 30), -30)).toBe(d)
    }
  })

  it('dayNumber 单调且与 daysBetween 自洽', () => {
    expect(dayNumber('1970-01-01')).toBe(0)
    expect(dayNumber('1970-01-02')).toBe(1)
    for (const [a, b] of [
      ['2026-01-01', '2026-12-31'],
      ['2024-02-28', '2024-03-01'],
    ] as const) {
      expect(dayNumber(b) - dayNumber(a)).toBe(daysBetween(a, b))
    }
  })
})

describe('isValidDay', () => {
  it('挡住格式对但不存在的日期', () => {
    expect(isValidDay('2026-08-21')).toBe(true)
    expect(isValidDay('2024-02-29')).toBe(true)
    // ⚠️ 2026 不是闰年，且 2/30 根本不存在 —— 正则完全拦不住这两个
    expect(isValidDay('2026-02-29')).toBe(false)
    expect(isValidDay('2026-02-30')).toBe(false)
    expect(isValidDay('2026-13-01')).toBe(false)
    expect(isValidDay('2026-8-1')).toBe(false)
    expect(isValidDay('')).toBe(false)
    expect(isValidDay(null)).toBe(false)
    expect(isValidDay(undefined)).toBe(false)
  })
})
